/**
 * scene.ts — the scene: a structural layer on top of SceneViews (Task 81).
 *
 * The hierarchy is intrusive child lists (firstChild/nextSibling/prevSibling):
 * insert/remove in O(1), node slots are STABLE (no reordering —
 * traversal order lives in order[], not in data-array positions).
 *
 * pack() — rebuilds order/subtreeEnd in preorder: one stack-based DFS +
 * reverse aggregation of subtree ends. Invariant after pack: a parent
 * always comes before its child, a subtree is a contiguous rank range.
 * Structural edits mark layoutDirty; hot passes (updateWorld /
 * cull / collectInstances) automatically re-pack once per frame.
 *
 * Memory layout — the same as the worker's (layout.ts): a scene in a SAB
 * is available to the worker without copies (T1/T2), a local scene is T0.
 */
import type { Camera } from './camera.ts'
import {
  buildSceneViews,
  createSceneBuffer,
  freeListWord,
  H_CAMERA_COUNT,
  H_CLOCK,
  H_GROUP_COUNT,
  H_LAYOUT_EPOCH,
  H_NODE_COUNT,
  NF_VISIBLE,
  NF_ALIVE,
  tailLayoutOn,
} from './layout.ts'
import type { SceneBufferOptions, SceneViews } from './layout.ts'
import { cullViewsBrute, cullViewsHierarchical } from './culling.ts'
import type { CullStats, MutableCullStats } from './culling.ts'
import { collectInstancesViews, instanceMatricesView, instancePoolBase } from './instances.ts'
import { refitGroupBoundsForcedViews, refitGroupBoundsViews, updateWorldForcedViews, updateWorldViews } from './transforms.ts'

/** Initialization for a new node. */
export interface SceneNodeInit {
  readonly position?: readonly [number, number, number]
  /** Quaternion (x, y, z, w); normalized on write. */
  readonly rotation?: readonly [number, number, number, number]
  readonly scale?: readonly [number, number, number]
  /** Parent (slot) or −1 for root. */
  readonly parent?: number
  /** Instance group (dense id ≥ 0) or −1. */
  readonly group?: number
  /** User slot (command/asset id) or −1. */
  readonly payload?: number
  /** Local bounding sphere (cx, cy, cz, r). */
  readonly sphere?: readonly [number, number, number, number]
  readonly visible?: boolean
}

/** Camera culling result. */
export interface SceneCullResult {
  readonly cameraCount: number
  readonly stats: readonly CullStats[]
  /** Bitset buffer (for isVisibleRank / forEachVisible). */
  readonly bufferIndex: number
}

/** Scene — structural operations + hot passes. */
export interface Scene {
  readonly views: SceneViews
  readonly capacity: number
  readonly count: number
  readonly backing: 'local' | 'shared'
  /** Order is stale after structural edits. */
  readonly layoutDirty: boolean

  /** Create a node; returns a stable slot. */
  create(init?: SceneNodeInit): number
  /** Delete a node (children become roots). Idempotent for dead nodes. */
  dispose(slot: number): void
  /** Change of parent (−1 — make it a root). Cycles — throw. */
  setParent(slot: number, parent: number): void
  /** Parent of the slot (−1 — root/free). */
  parentOf(slot: number): number
  /** Whether the slot is alive. */
  alive(slot: number): boolean
  /** Slot generation (grows on each reuse). */
  generation(slot: number): number

  /** Local TRS (object sugar; for animation use setLocalTR). */
  setLocal(slot: number, init: { position?: readonly [number, number, number]; rotation?: readonly [number, number, number, number]; scale?: readonly [number, number, number] }): void
  /** Hot write of the full TRS without allocations. */
  setLocalTR(
    slot: number,
    px: number, py: number, pz: number,
    qx: number, qy: number, qz: number, qw: number,
    sx: number, sy: number, sz: number,
  ): void
  setSphereLocal(slot: number, cx: number, cy: number, cz: number, r: number): void
  setGroup(slot: number, group: number): void
  setPayload(slot: number, payload: number): void
  setVisible(slot: number, visible: boolean): void

  /** World matrix of a node (a view over world; do not mutate). */
  worldMatrix(slot: number): Float32Array

  /** Rebuild order/subtreeEnd (invoked automatically when needed). */
  pack(): void

  /** Recompute worlds. dirty=false — force ALL nodes (reference/A-B
   *  "before Task 85": without dirty stamps — every node, every frame).
   *  Returns the number of recomputed nodes. */
  updateWorld(force?: boolean): number
  /** Dirty refit of auto-bounds — only changed subtrees (Task 85). */
  refitGroupBounds(): number
  /** Full refit of all auto-bounds — reference/benchmark (always O(n)). */
  refitGroupBoundsForced(): number
  /** H_CLOCK stamp of the last group CONTENT change (world/composition —
   *  all cameras). While it has not grown AND the counters are unchanged — the
   *  group instance buffers are valid, the upload can be skipped (Task 85). */
  groupWorldStamp(group: number): number
  /** Stamp of the last visibility FLIP of a group node FOR camera cameraIndex
   *  (Task 85): one camera's flip does not touch the other camera's buffers. */
  groupFlipStamp(group: number, cameraIndex: number): number

  /** Cull by cameras; writes planes and bitsets into buffer bufferIndex.
   *  masks=false — disable plane-mask inheritance (A/B "before Task 85":
   *  identical result, ~×2.6 more tests). out — reusable stats
   *  records (zero allocations per frame). reuse — a scene-owned result,
   *  zero steady-state allocations (Task 113; see the opts field).
   *  Task 182 — AUTO-PARITY: without an explicit bufferIndex the scene
   *  alternates the double bitset buffer per call (0,1,0,1… — the worker's
   *  epoch&1 rhythm). This is what makes the Task-85 groupFlip diff
   *  meaningful in T0: the default cull+collect loop (the README pattern)
   *  diffs the CURRENT frame against the PREVIOUS one — with the old fixed
   *  default buffer the diff always saw a dead (never-written) buffer and
   *  the flip memo was silently dead (every group "flipped" every frame →
   *  uploads never skipped). The written buffer is reported in the result's
   *  bufferIndex; an explicit bufferIndex disables the alternation for that
   *  call (manual buffer driving). */
  cull(cameras: readonly Camera[], opts?: {
    brute?: boolean
    bufferIndex?: number
    masks?: boolean
    out?: readonly MutableCullStats[]
    /** Task 113 — zero steady-state allocations: return a scene-owned
     *  (reused) result. INVALIDATED by the next reuse call — copy out what
     *  must survive a frame. The default mode returns independent objects
     *  (held results stay valid). `out` (caller-owned records) wins over
     *  `reuse` when both are given. */
    reuse?: boolean
  }): SceneCullResult

  /** Collect instances of all groups for a camera (into buffer bufferIndex).
   *  Task 182 — the default buffer is the one the LAST auto cull wrote
   *  (explicit bufferIndex wins): the internal diff runs against the
   *  previous frame's bitset — the flip memo works in the default T0 loop. */
  collectInstances(cameraIndex: number, opts?: { bufferIndex?: number }): number
  /** Segment of a group's matrices (a view over the camera's pool).
   *  Task 182 — the default buffer tracks the last auto cull (explicit wins). */
  instances(group: number, opts?: { cameraIndex?: number; bufferIndex?: number }): { matrices: Float32Array; count: number }
  /** Task 87 — NO ALLOCATIONS: the group pool count/offset/base as numbers
   *  (the consumer reads views.instPool directly — no objects, no subarray).
   *  Task 182 — the default buffer tracks the last auto cull (explicit wins). */
  instanceCountOf(group: number, cameraIndex: number, bufferIndex?: number): number
  instanceOffsetOf(group: number, cameraIndex: number, bufferIndex?: number): number
  instancePoolBase(cameraIndex: number, bufferIndex?: number): number

  /** Iterate a camera's visible slots (bit ∩ node flag).
   *  Task 182 — the default buffer tracks the last auto cull (explicit wins). */
  forEachVisible(cameraIndex: number, cb: (slot: number, rank: number) => void, opts?: { bufferIndex?: number }): void
  /** Rank visibility (ignoring node flags). */
  isVisibleRank(cameraIndex: number, rank: number, opts?: { bufferIndex?: number }): boolean

  /** Camera on a node: view = world⁻¹. */
  cameraFromNode(camera: Camera, slot: number): Camera
}

/** Scene creation options. */
export type SceneOptions = SceneBufferOptions

/** Create a scene (local or shared with a worker). */
export function createScene(options: SceneOptions = {}): Scene {
  const buffer = createSceneBuffer(options)
  return createSceneFromBuffer(buffer)
}

/** Wrap a ready scene buffer (e.g. a SAB received from a worker). */
export function createSceneFromBuffer(buffer: ArrayBufferLike): Scene {
  const views = buildSceneViews(buffer)
  const freeList = freeListWord(views)
  // Full int view: freeHead/freeCount live beyond H_WORDS.
  const fullWords = new Int32Array(buffer)
  const shared = typeof SharedArrayBuffer !== 'undefined' && buffer instanceof SharedArrayBuffer
  let layoutDirty = true

  // ─── Task 113: cull reuse scratch ─────────────────────────────────
  /** One record pool + one result wrapper, reused per call in the reuse mode.
 * Records are pre-filled to cameraMax once; per cameraCount a VIEW array
 * (records.slice(0, count)) is cached lazily — one allocation per distinct
 * count EVER, zero in steady state (trimming by `length =` would DELETE
 * the records — a JS trap this cache sidesteps).
 * The DEFAULT mode still allocates independent results — callers holding
 * them across frames keep that contract (pinned by zeroAlloc.test). */
  let cullReuseStats: MutableCullStats[] | null = null
  let cullReuseViews: (readonly CullStats[] | undefined)[] | null = null
  let cullReuseResult: { cameraCount: number; stats: readonly CullStats[]; bufferIndex: number } | null = null

  // ─── Task 182: auto-parity of the default buffers ────────────────────
  /** The count of DEFAULT (bufferIndex-less) cull() calls. The k-th auto
   *  cull writes buffer (k-1)&1 — 0,1,0,1… (the worker's epoch&1 rhythm).
   *  Readers without an explicit bufferIndex default to the buffer of the
   *  LATEST auto cull; before the first auto cull everything defaults to 0
   *  (the pre-Task-182 behavior — explicit-buffer flows are untouched).
   *  This is THE fix for the T0 flip memo: the default cull+collect loop
   *  now diffs consecutive frames instead of a dead never-written buffer
   *  (with the fixed default every group "flipped" every frame and the
   *  Task-85 upload skip never fired once in T0). */
  let autoEpoch = 0
  const autoBufferIndex = (): number => (autoEpoch === 0 ? 0 : (autoEpoch - 1) & 1)

  function ensurePacked(): void {
    if (layoutDirty) packInternal()
  }

  function packInternal(): void {
    const { parent, firstChild, nextSibling, order, subtreeEnd, nodeFlags, headerI, group, rankOf, world, worldStamp, gStart, gHidden } = views
    const n = views.headerI[H_NODE_COUNT]
    const groupCount = Math.min(views.headerI[H_GROUP_COUNT], views.groupMax)
    // Slot stack: roots in slot order (pushed in reverse — LIFO).
    let stack = packStack
    if (stack.length < n + 1) {
      stack = packStack = new Int32Array(Math.max(64, (n + 1) * 2))
    }
    let sp = 0
    let rank = 0
    const capacity = views.capacity
    for (let slot = capacity - 1; slot >= 0; slot--) {
      if ((nodeFlags[slot] & NF_ALIVE) !== 0 && parent[slot] < 0) {
        stack[sp++] = slot
      }
    }
    while (sp > 0) {
      const slot = stack[--sp]
      order[rank] = slot
      subtreeEnd[slot] = rank + 1
      rank++
      if (rank > n) break // guard against a broken structure
      // Children: pushed from the list head — they come out in reverse insertion order.
      let c = firstChild[slot]
      while (c >= 0) {
        if (sp >= stack.length) {
          const grown = new Int32Array(stack.length * 2)
          grown.set(stack)
          stack = packStack = grown
        }
        stack[sp++] = c
        c = nextSibling[c]
      }
    }

    // ── Task 192 (N2): the TAIL REPACK — grouped LEAVES into per-group
    // contiguous segments at the END of the rank space. The tree nodes keep
    // their DFS order; a tail member is a grouped LEAF with a dense id (a
    // grouped node WITH children keeps its DFS placement — parent-before-
    // child and subtree contiguity hold for the whole tree region; the
    // dossier's "all grouped nodes to the tail" variant breaks an animated
    // grouped-internal parent (the parent lands AFTER its tree-region
    // children — updateWorld would read its STALE world; found while
    // integrating, leaf-eligibility is the fix). The scatter is a stable
    // counting sort over the DFS order (the member order is preserved).
    let treeN = n
    if (tailLayoutOn()) {
      let order2 = packOrder2
      if (order2.length < n) order2 = packOrder2 = new Int32Array(Math.max(64, n * 2))
      let cursor = packCursor
      if (cursor.length < groupCount + 1) cursor = packCursor = new Int32Array(Math.max(8, (groupCount + 1) * 2))
      cursor.fill(0, 0, groupCount + 1)
      for (let r = 0; r < n; r++) {
        const slot = order[r]
        const g = group[slot]
        if (g >= 0 && g < groupCount && firstChild[slot] < 0) cursor[g]++
      }
      // The prefix STARTS at treeN — the tree region [0, treeN) comes first,
      // the segments follow: gStart[0] = treeN is the tree/tail boundary.
      let tailTotal = 0
      for (let g = 0; g < groupCount; g++) tailTotal += cursor[g]
      treeN = n - tailTotal
      let acc = treeN
      for (let g = 0; g < groupCount; g++) {
        const start = acc
        acc += cursor[g]
        cursor[g] = start
        gStart[g] = start
      }
      gStart[groupCount] = acc
      // gHidden — the hidden tally per segment (the collect's popcount /
      // block-copy paths); rebuilt wholesale here, maintained by setVisible.
      for (let g = 0; g < groupCount; g++) gHidden[g] = 0
      let t = 0
      for (let r = 0; r < n; r++) {
        const slot = order[r]
        const g = group[slot]
        if (g >= 0 && g < groupCount && firstChild[slot] < 0) {
          order2[cursor[g]++] = slot
          if ((nodeFlags[slot] & NF_VISIBLE) === 0) gHidden[g]++
        } else {
          order2[t++] = slot
        }
      }
      order.set(order2.subarray(0, n))
    } else {
      // The kill-switch: the pre-192 layout — everything is a tree node;
      // gStart[0] = n kills the tail sweep in the cull and the segments in
      // the collect (both degenerate to the legacy full walks).
      for (let g = 0; g <= groupCount; g++) gStart[g] = n
      for (let g = 0; g < groupCount; g++) gHidden[g] = 0
    }

    // Reverse aggregation: a parent's subtree end = the last child's end.
    // Task 192: a TAIL member is skipped — a grouped leaf's parent must NOT
    // absorb its rank (the tail is outside every tree range; absorbing it
    // was the deep bug the dossier's tree-fixture probe caught). The
    // per-node subtreeEnd is rewritten first (the ranks moved).
    for (let r = 0; r < n; r++) subtreeEnd[order[r]] = r + 1
    for (let r = n - 1; r >= 0; r--) {
      const slot = order[r]
      const g = group[slot]
      if (treeN < n && g >= 0 && g < groupCount && firstChild[slot] < 0) continue // a TAIL node
      const p = parent[slot]
      if (p >= 0 && subtreeEnd[slot] > subtreeEnd[p]) subtreeEnd[p] = subtreeEnd[slot]
    }

    // ── Task 192 (N1): the WORLD PERMUTATION — the matrices are rank-major,
    // a repack moves the ranks, the rows must travel with their nodes. The
    // permutation goes through a scratch (an in-place swap walk would alias
    // source rows before they are read). Never-computed rows (worldStamp
    // === 0 — fresh or untouched) take the IDENTITY: create() no longer
    // writes worlds (the rank is unknown at create time — pack owns the
    // identity contract now).
    let w2 = packWorld
    if (w2.length < n * 16) w2 = packWorld = new Float32Array(Math.max(1024 * 16, n * 32))
    for (let r = 0; r < n; r++) {
      const slot = order[r]
      const d = r * 16
      if (worldStamp[slot] === 0) {
        for (let k = 0; k < 16; k++) w2[d + k] = 0
        w2[d] = 1
        w2[d + 5] = 1
        w2[d + 10] = 1
        w2[d + 15] = 1
      } else {
        const s = rankOf[slot] * 16
        for (let k = 0; k < 16; k++) w2[d + k] = world[s + k]
      }
    }
    world.set(w2.subarray(0, n * 16))
    for (let r = 0; r < n; r++) rankOf[order[r]] = r

    headerI[H_LAYOUT_EPOCH] = (headerI[H_LAYOUT_EPOCH] + 1) | 0
    layoutDirty = false
  }

  function takeSlot(): number {
    const head = fullWords[freeList]
    if (!(head >= 0)) {
      throw new Error(`scene: no free slots (capacity=${views.capacity})`)
    }
    fullWords[freeList] = views.nextSibling[head]
    fullWords[freeList + 1] -= 1
    return head
  }

  function releaseSlot(slot: number): void {
    views.nextSibling[slot] = fullWords[freeList]
    views.prevSibling[slot] = -1
    fullWords[freeList] = slot
    fullWords[freeList + 1] += 1
  }

  function detach(slot: number): void {
    const { parent, firstChild, nextSibling, prevSibling } = views
    const p = parent[slot]
    if (p < 0) return
    if (firstChild[p] === slot) {
      firstChild[p] = nextSibling[slot]
      if (nextSibling[slot] >= 0) prevSibling[nextSibling[slot]] = -1
    } else {
      const prev = prevSibling[slot]
      const next = nextSibling[slot]
      if (prev >= 0) nextSibling[prev] = next
      if (next >= 0) prevSibling[next] = prev
    }
    parent[slot] = -1
    nextSibling[slot] = -1
    prevSibling[slot] = -1
  }

  function attach(slot: number, parentSlot: number): void {
    const { parent, firstChild, nextSibling, prevSibling } = views
    const old = firstChild[parentSlot]
    nextSibling[slot] = old
    prevSibling[slot] = -1
    if (old >= 0) prevSibling[old] = slot
    firstChild[parentSlot] = slot
    parent[slot] = parentSlot
  }

  const scene: Scene = {
    views,
    get capacity() { return views.capacity },
    get count() { return views.headerI[H_NODE_COUNT] },
    get backing() { return shared ? 'shared' : 'local' },
    get layoutDirty() { return layoutDirty },

    create(init = {}) {
      const slot = takeSlot()
      const { pos, quat, scale, group, payload, nodeFlags, sphereL, sphereW, headerU } = views
      const i3 = slot * 3
      const i4 = slot * 4
      // Initial dirt: the world must be computed at least once (the parent
      // may already have a transform). Task 192: the IDENTITY world is NOT
      // written here — the rank is unknown until pack; pack writes identities
      // for worldStamp === 0 rows (the same "untouched = identity" contract).
      const stamp = ++headerU[H_CLOCK]
      views.localStamp[slot] = stamp
      views.worldStamp[slot] = 0
      // Defaults: identity TRS, identity world.
      pos[i3] = 0; pos[i3 + 1] = 0; pos[i3 + 2] = 0
      quat[i4] = 0; quat[i4 + 1] = 0; quat[i4 + 2] = 0; quat[i4 + 3] = 1
      scale[i3] = 1; scale[i3 + 1] = 1; scale[i3 + 2] = 1
      sphereL[i4] = 0; sphereL[i4 + 1] = 0; sphereL[i4 + 2] = 0; sphereL[i4 + 3] = 0
      sphereW[i4] = 0; sphereW[i4 + 1] = 0; sphereW[i4 + 2] = 0; sphereW[i4 + 3] = 0
      group[slot] = init.group ?? -1
      payload[slot] = init.payload ?? -1
      nodeFlags[slot] = NF_ALIVE | (init.visible === false ? 0 : NF_VISIBLE)
      if (init.sphere !== undefined) {
        sphereL[i4] = init.sphere[0]
        sphereL[i4 + 1] = init.sphere[1]
        sphereL[i4 + 2] = init.sphere[2]
        sphereL[i4 + 3] = init.sphere[3]
      }
      if (init.position !== undefined) {
        pos[i3] = init.position[0]
        pos[i3 + 1] = init.position[1]
        pos[i3 + 2] = init.position[2]
      }
      if (init.rotation !== undefined) {
        const [qx, qy, qz, qw] = init.rotation
        const len = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw)
        if (len > 1e-12) {
          quat[i4] = qx / len; quat[i4 + 1] = qy / len; quat[i4 + 2] = qz / len; quat[i4 + 3] = qw / len
        }
      }
      if (init.scale !== undefined) {
        scale[i3] = init.scale[0]
        scale[i3 + 1] = init.scale[1]
        scale[i3 + 2] = init.scale[2]
      }
      const p = init.parent ?? -1
      if (p >= 0) {
        if (p === slot) throw new Error('scene: node parent is the node itself')
        if ((views.nodeFlags[p] & NF_ALIVE) === 0) throw new Error(`scene: parent ${p} is not alive`)
        // Cycle: the new parent must not be a descendant of slot.
        let a = p
        while (a >= 0) {
          if (a === slot) throw new Error('scene: setParent would create a cycle')
          a = views.parent[a]
        }
        attach(slot, p)
      }
      views.headerI[H_NODE_COUNT] += 1
      if (init.group !== undefined && init.group >= 0) bumpGroupCount(init.group)
      layoutDirty = true
      return slot
    },

    dispose(slot) {
      const { nodeFlags, generation, headerU } = views
      if ((nodeFlags[slot] & NF_ALIVE) === 0) return
      // Children become roots (locals preserved — the world will be recomputed).
      let c = views.firstChild[slot]
      while (c >= 0) {
        const next = views.nextSibling[c]
        detach(c)
        views.localStamp[c] = ++headerU[H_CLOCK]
        c = next
      }
      detach(slot)
      nodeFlags[slot] = 0
      generation[slot] = generation[slot] + 1
      releaseSlot(slot)
      views.headerI[H_NODE_COUNT] -= 1
      layoutDirty = true
    },

    setParent(slot, parentSlot) {
      if ((views.nodeFlags[slot] & NF_ALIVE) === 0) throw new Error(`scene: node ${slot} is not alive`)
      if (parentSlot === slot) throw new Error('scene: node parent is the node itself')
      if (parentSlot >= 0) {
        if ((views.nodeFlags[parentSlot] & NF_ALIVE) === 0) throw new Error(`scene: parent ${parentSlot} is not alive`)
        let a = parentSlot
        while (a >= 0) {
          if (a === slot) throw new Error('scene: setParent would create a cycle')
          a = views.parent[a]
        }
      }
      detach(slot)
      if (parentSlot >= 0) attach(slot, parentSlot)
      // The node's world changes (frame of reference changes) — descendants are
      // invalidated automatically via worldStamp[parent] > worldStamp[child].
      views.localStamp[slot] = ++views.headerU[H_CLOCK]
      layoutDirty = true
    },

    parentOf(slot) { return views.parent[slot] },
    alive(slot) { return (views.nodeFlags[slot] & NF_ALIVE) !== 0 },
    generation(slot) { return views.generation[slot] },

    setLocal(slot, init) {
      const { pos, quat, scale, headerU } = views
      const i3 = slot * 3
      const i4 = slot * 4
      let touched = false
      if (init.position !== undefined) {
        pos[i3] = init.position[0]
        pos[i3 + 1] = init.position[1]
        pos[i3 + 2] = init.position[2]
        touched = true
      }
      if (init.rotation !== undefined) {
        const [qx, qy, qz, qw] = init.rotation
        const len = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw)
        if (len > 1e-12) {
          quat[i4] = qx / len; quat[i4 + 1] = qy / len; quat[i4 + 2] = qz / len; quat[i4 + 3] = qw / len
        }
        touched = true
      }
      if (init.scale !== undefined) {
        scale[i3] = init.scale[0]
        scale[i3 + 1] = init.scale[1]
        scale[i3 + 2] = init.scale[2]
        touched = true
      }
      if (touched) views.localStamp[slot] = ++headerU[H_CLOCK]
    },

    setLocalTR(slot, px, py, pz, qx, qy, qz, qw, sx, sy, sz) {
      const { pos, quat, scale, headerU } = views
      const i3 = slot * 3
      const i4 = slot * 4
      pos[i3] = px; pos[i3 + 1] = py; pos[i3 + 2] = pz
      const len = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw)
      if (len > 1e-12) {
        quat[i4] = qx / len; quat[i4 + 1] = qy / len; quat[i4 + 2] = qz / len; quat[i4 + 3] = qw / len
      } else {
        quat[i4] = 0; quat[i4 + 1] = 0; quat[i4 + 2] = 0; quat[i4 + 3] = 1
      }
      scale[i3] = sx; scale[i3 + 1] = sy; scale[i3 + 2] = sz
      views.localStamp[slot] = ++headerU[H_CLOCK]
    },

    setSphereLocal(slot, cx, cy, cz, r) {
      const i4 = slot * 4
      views.sphereL[i4] = cx
      views.sphereL[i4 + 1] = cy
      views.sphereL[i4 + 2] = cz
      views.sphereL[i4 + 3] = r
      // The world sphere is recomputed in updateWorld — a stamp is mandatory
      // (Task 85: without it a sphere edit was not applied until an unrelated
      // node change; found when moving to the dirty refit).
      views.localStamp[slot] = ++views.headerU[H_CLOCK]
    },

    setGroup(slot, group) {
      const old = views.group[slot]
      views.group[slot] = group
      if (group >= 0) bumpGroupCount(group)
      // Task 192 (N2): the tail segments ARE the group composition — a
      // member moving between groups moves SEGMENTS; without the repack the
      // collect would serve it from the OLD group's segment. The same family
      // as order[] freshness: every structural edit marks layoutDirty.
      layoutDirty = true
      // Task 191: a composition change stamps BOTH groups — the Task-85
      // family (setVisible stamps for exactly this reason). Without it the
      // upload skip (Task 85) AND the pool memo (Task 190) served stale
      // counts after a member moved between groups — a REAL hole found
      // while integrating the group spheres: nothing else in the pipeline
      // observes group[slot] edits.
      const stamp = (views.headerU[H_CLOCK] + 1) >>> 0
      views.headerU[H_CLOCK] = stamp
      if (old >= 0 && old < views.groupMax) views.groupTouch[old] = stamp
      if (group >= 0 && group < views.groupMax) views.groupTouch[group] = stamp
    },

    setPayload(slot, payload) { views.payload[slot] = payload },
    setVisible(slot, visible) {
      const was = (views.nodeFlags[slot] & NF_VISIBLE) !== 0
      if (visible) views.nodeFlags[slot] |= NF_VISIBLE
      else views.nodeFlags[slot] &= ~NF_VISIBLE
      // Task 85: a flag change changes the instance group COMPOSITION — a stamp
      // is mandatory (otherwise the upload skip misses a matrix swap at equal counters).
      const g = views.group[slot]
      if (g >= 0 && g < views.groupMax) {
        // Task 192: the segment's hidden tally (pack rebuilds it wholesale;
        // this keeps it exact between packs — the was!==visible guard keeps
        // repeated no-op calls symmetric).
        if (was !== visible && views.firstChild[slot] < 0) {
          views.gHidden[g] += visible ? -1 : 1
        }
        views.groupTouch[g] = ++views.headerU[H_CLOCK]
      }
    },

    worldMatrix(slot) {
      // Task 192: RANK-MAJOR world — the row lives at the slot's rank; the
      // view is valid until the next pack (a structural edit reshuffles).
      ensurePacked()
      const r16 = views.rankOf[slot] * 16
      return views.world.subarray(r16, r16 + 16)
    },

    pack: packInternal,

    updateWorld(force = false) {
      ensurePacked()
      return force ? updateWorldForcedViews(views) : updateWorldViews(views)
    },

    refitGroupBounds() {
      ensurePacked()
      return refitGroupBoundsViews(views)
    },

    refitGroupBoundsForced() {
      ensurePacked()
      return refitGroupBoundsForcedViews(views)
    },

    groupWorldStamp(group) {
      return group >= 0 && group < views.groupMax ? views.groupTouch[group] : 0
    },

    groupFlipStamp(group, cameraIndex) {
      if (group < 0 || group >= views.groupMax) return 0
      if (cameraIndex < 0 || cameraIndex >= views.cameraMax) return 0
      return views.groupFlip[cameraIndex * views.groupMax + group]
    },

    cull(cameras, opts = {}) {
      ensurePacked()
      // Task 182: no explicit buffer — the auto-parity epoch buffer
      // (alternates per call; see autoBufferIndex). Explicit — as given.
      const bufferIndex = opts.bufferIndex ?? (autoEpoch++ & 1)
      const masks = opts.masks !== false
      const count = Math.min(cameras.length, views.cameraMax)
      for (let k = 0; k < count; k++) {
        const planes = cameras[k].planes
        // A camera's planes is exactly 24 floats — a direct set without a subarray
        // view (Task 87: a slice per camera per frame is a hidden allocation)
        if (planes.length === 24) views.planes.set(planes, k * 24)
        else views.planes.set(planes.subarray(0, 24), k * 24)
      }
      views.headerI[H_CAMERA_COUNT] = count
      const out = opts.out
      if (opts.reuse === true && out === undefined) {
        // Task 113: the scene-owned scratch — zero allocations per call.
        if (cullReuseResult === null) {
          const records: MutableCullStats[] = []
          for (let k = 0; k < views.cameraMax; k++) {
            records.push({ tested: 0, visible: 0, trivialRejects: 0, trivialAccepts: 0, planeTests: 0 })
          }
          cullReuseStats = records
          cullReuseViews = []
          cullReuseResult = { cameraCount: 0, stats: records, bufferIndex: 0 }
        }
        for (let k = 0; k < count; k++) {
          const rec = cullReuseStats![k]
          if (opts.brute === true) cullViewsBrute(views, k, bufferIndex, rec)
          else cullViewsHierarchical(views, k, bufferIndex, rec, masks)
        }
        const viewsByCount = cullReuseViews!
        let statsView = count < viewsByCount.length ? viewsByCount[count] : undefined
        if (statsView === undefined) {
          statsView = cullReuseStats!.slice(0, count)
          viewsByCount[count] = statsView
        }
        const reused = cullReuseResult
        reused.cameraCount = count
        reused.stats = statsView
        reused.bufferIndex = bufferIndex
        return reused
      }
      const stats: CullStats[] = []
      for (let k = 0; k < count; k++) {
        const reuse = out !== undefined && k < out.length ? out[k] : undefined
        stats.push(opts.brute === true
          ? cullViewsBrute(views, k, bufferIndex, reuse)
          : cullViewsHierarchical(views, k, bufferIndex, reuse, masks))
      }
      return { cameraCount: count, stats, bufferIndex }
    },

    collectInstances(cameraIndex, opts = {}) {
      ensurePacked()
      const bufferIndex = opts.bufferIndex ?? autoBufferIndex()
      return collectInstancesViews(views, cameraIndex, bufferIndex)
    },

    instances(group, opts = {}) {
      return instanceMatricesView(views, opts.bufferIndex ?? autoBufferIndex(), opts.cameraIndex ?? 0, group)
    },

    instanceCountOf(group, cameraIndex, bufferIndex) {
      if (group < 0 || group >= views.groupMax) return 0
      const base = ((bufferIndex ?? autoBufferIndex()) * views.cameraMax + cameraIndex) * views.groupMax
      return Math.max(0, views.instCounts[base + group])
    },

    instanceOffsetOf(group, cameraIndex, bufferIndex) {
      if (group < 0 || group >= views.groupMax) return 0
      const base = ((bufferIndex ?? autoBufferIndex()) * views.cameraMax + cameraIndex) * views.groupMax
      return views.instOffsets[base + group]
    },

    instancePoolBase(cameraIndex, bufferIndex) {
      return instancePoolBase(views, bufferIndex ?? autoBufferIndex(), cameraIndex)
    },

    forEachVisible(cameraIndex, cb, opts = {}) {
      ensurePacked()
      const base = (opts.bufferIndex ?? autoBufferIndex()) * views.cameraMax * views.bitsWords
        + cameraIndex * views.bitsWords
      const n = views.headerI[H_NODE_COUNT]
      const { bits, order, nodeFlags } = views
      // Task 182 — strength reduction of the rank loop: the word is loaded
      // once per 32 ranks (not per rank) and the bit mask rolls left. The
      // iteration order and the callbacks are identical to the per-rank
      // form; (1 << 31) << 1 wraps to exactly 0 — that is the reload signal
      // (pinned by task182 tests against the per-bit reference).
      let word = bits[base]
      let mask = 1
      let w = 0
      for (let r = 0; r < n; r++) {
        if ((word & mask) !== 0) {
          const slot = order[r]
          if ((nodeFlags[slot] & NF_VISIBLE) !== 0) cb(slot, r)
        }
        mask <<= 1
        if (mask === 0) {
          mask = 1
          w++
          // The next word is loaded only if a live rank actually lives in it
          // (n a multiple of 32 would otherwise read one word past the
          // camera's region — harmless, but undefined poisons the var's type).
          if (r + 1 < n) word = bits[base + w]
        }
      }
    },

    isVisibleRank(cameraIndex, rank, opts = {}) {
      const base = (opts.bufferIndex ?? autoBufferIndex()) * views.cameraMax * views.bitsWords
        + cameraIndex * views.bitsWords
      return (views.bits[base + (rank >>> 5)] & (1 << (rank & 31))) !== 0
    },

    cameraFromNode(camera, slot) {
      ensurePacked()
      const r16 = views.rankOf[slot] * 16
      return camera.setViewFromWorld(views.world.subarray(r16, r16 + 16))
    },
  }

  function bumpGroupCount(group: number): void {
    const current = views.headerI[H_GROUP_COUNT]
    if (group >= current) {
      if (group >= views.groupMax) {
        throw new Error(`scene: group ${group} is out of groupMax=${views.groupMax}`)
      }
      views.headerI[H_GROUP_COUNT] = group + 1
    }
  }

  return scene
}

/** Scratch stack for pack(). */
let packStack = new Int32Array(1024)
/** Task 192: pack scratch — the tail scatter destination (the new order). */
let packOrder2 = new Int32Array(1024)
/** Task 192: pack scratch — the per-group segment cursors. */
let packCursor = new Int32Array(128)
/** Task 192: pack scratch — the world permutation buffer (old rank → new). */
let packWorld = new Float32Array(1024 * 16)
