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
   *  records (zero allocations per frame). */
  cull(cameras: readonly Camera[], opts?: {
    brute?: boolean
    bufferIndex?: number
    masks?: boolean
    out?: readonly MutableCullStats[]
  }): SceneCullResult

  /** Collect instances of all groups for a camera (into buffer bufferIndex). */
  collectInstances(cameraIndex: number, opts?: { bufferIndex?: number }): number
  /** Segment of a group's matrices (a view over the camera's pool). */
  instances(group: number, opts?: { cameraIndex?: number; bufferIndex?: number }): { matrices: Float32Array; count: number }
  /** Task 87 — NO ALLOCATIONS: the group pool count/offset/base as numbers
   *  (the consumer reads views.instPool directly — no objects, no subarray). */
  instanceCountOf(group: number, cameraIndex: number, bufferIndex?: number): number
  instanceOffsetOf(group: number, cameraIndex: number, bufferIndex?: number): number
  instancePoolBase(cameraIndex: number, bufferIndex?: number): number

  /** Iterate a camera's visible slots (bit ∩ node flag). */
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

  function ensurePacked(): void {
    if (layoutDirty) packInternal()
  }

  function packInternal(): void {
    const { parent, firstChild, nextSibling, order, subtreeEnd, nodeFlags, headerI } = views
    const n = views.headerI[H_NODE_COUNT]
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
    // Reverse aggregation: a parent's subtree end = the last child's end.
    for (let r = rank - 1; r >= 0; r--) {
      const slot = order[r]
      const p = parent[slot]
      if (p >= 0 && subtreeEnd[slot] > subtreeEnd[p]) subtreeEnd[p] = subtreeEnd[slot]
    }
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
      const { pos, quat, scale, group, payload, nodeFlags, sphereL, world, sphereW, headerU } = views
      const i3 = slot * 3
      const i4 = slot * 4
      const i16 = slot * 16
      // Initial dirt: the world must be computed at least once (the parent
      // may already have a transform).
      const stamp = ++headerU[H_CLOCK]
      views.localStamp[slot] = stamp
      views.worldStamp[slot] = 0
      // Defaults: identity TRS, identity world.
      pos[i3] = 0; pos[i3 + 1] = 0; pos[i3 + 2] = 0
      quat[i4] = 0; quat[i4 + 1] = 0; quat[i4 + 2] = 0; quat[i4 + 3] = 1
      scale[i3] = 1; scale[i3 + 1] = 1; scale[i3 + 2] = 1
      world.fill(0, i16, i16 + 16)
      world[i16] = world[i16 + 5] = world[i16 + 10] = world[i16 + 15] = 1
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
      views.group[slot] = group
      if (group >= 0) bumpGroupCount(group)
    },

    setPayload(slot, payload) { views.payload[slot] = payload },
    setVisible(slot, visible) {
      if (visible) views.nodeFlags[slot] |= NF_VISIBLE
      else views.nodeFlags[slot] &= ~NF_VISIBLE
      // Task 85: a flag change changes the instance group COMPOSITION — a stamp
      // is mandatory (otherwise the upload skip misses a matrix swap at equal counters).
      const g = views.group[slot]
      if (g >= 0 && g < views.groupMax) views.groupTouch[g] = ++views.headerU[H_CLOCK]
    },

    worldMatrix(slot) { return views.world.subarray(slot * 16, slot * 16 + 16) },

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
      const bufferIndex = opts.bufferIndex ?? 0
      const masks = opts.masks !== false
      const count = Math.min(cameras.length, views.cameraMax)
      for (let k = 0; k < count; k++) {
        const planes = cameras[k]!.planes
        // A camera's planes is exactly 24 floats — a direct set without a subarray
        // view (Task 87: a slice per camera per frame is a hidden allocation)
        if (planes.length === 24) views.planes.set(planes, k * 24)
        else views.planes.set(planes.subarray(0, 24), k * 24)
      }
      views.headerI[H_CAMERA_COUNT] = count
      const out = opts.out
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
      const bufferIndex = opts.bufferIndex ?? 0
      return collectInstancesViews(views, cameraIndex, bufferIndex)
    },

    instances(group, opts = {}) {
      return instanceMatricesView(views, opts.bufferIndex ?? 0, opts.cameraIndex ?? 0, group)
    },

    instanceCountOf(group, cameraIndex, bufferIndex = 0) {
      if (group < 0 || group >= views.groupMax) return 0
      const base = (bufferIndex * views.cameraMax + cameraIndex) * views.groupMax
      return Math.max(0, views.instCounts[base + group])
    },

    instanceOffsetOf(group, cameraIndex, bufferIndex = 0) {
      if (group < 0 || group >= views.groupMax) return 0
      const base = (bufferIndex * views.cameraMax + cameraIndex) * views.groupMax
      return views.instOffsets[base + group]
    },

    instancePoolBase(cameraIndex, bufferIndex = 0) {
      return instancePoolBase(views, bufferIndex, cameraIndex)
    },

    forEachVisible(cameraIndex, cb, opts = {}) {
      ensurePacked()
      const bufferIndex = opts.bufferIndex ?? 0
      const n = views.headerI[H_NODE_COUNT]
      const base = (bufferIndex * views.cameraMax + cameraIndex) * views.bitsWords
      const { bits, order, nodeFlags } = views
      for (let r = 0; r < n; r++) {
        if ((bits[base + (r >>> 5)] & (1 << (r & 31))) === 0) continue
        const slot = order[r]
        if ((nodeFlags[slot] & NF_VISIBLE) === 0) continue
        cb(slot, r)
      }
    },

    isVisibleRank(cameraIndex, rank, opts = {}) {
      const bufferIndex = opts.bufferIndex ?? 0
      const base = (bufferIndex * views.cameraMax + cameraIndex) * views.bitsWords
      return (views.bits[base + (rank >>> 5)] & (1 << (rank & 31))) !== 0
    },

    cameraFromNode(camera, slot) {
      return camera.setViewFromWorld(views.world.subarray(slot * 16, slot * 16 + 16))
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
