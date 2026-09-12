/**
 * layout.ts — the single scene memory layout (Task 81, @rune/scene).
 *
 * One buffer — one contract: the scene lives EITHER in a local ArrayBuffer
 * (T0, one thread) OR in a SharedArrayBuffer (T1/T2, the worker updates
 * transforms/visibility in parallel with main). The dossier's transport
 * invariant (§7.2): only the latency changes, not the semantics — the hot
 * loops (updateWorld / cull / collectInstances) work with the same
 * views and do NOT know which thread they run in.
 *
 * The layout is data-oriented SoA (flecs-style hierarchies, NullGraph'2026):
 * everything is flat typed arrays by node slot; not a single JS object
 * per node in hot paths.
 *
 * The visibility bitsets and the instance-matrix pool are DOUBLE-BUFFERED
 * (epoch & 1): the worker writes into the buffer of epoch k, main reads
 * the buffer of the previous fresh epoch — tearing is excluded without
 * locks.
 *
 * Task 192 (the N1+N2 contracts, the Task-189 dossier):
 *   • the WORLD matrices are RANK-MAJOR: `world[rank * 16]`, not
 *     `world[slot * 16]`. updateWorld's walk is by rank (the loop counter
 *     is the destination — the write pattern is sequential), the collect
 *     reads matrices sequentially and block-copies whole segments. `rankOf`
 *     (slot → rank) is maintained by pack(); `worldMatrix(slot)` serves
 *     `world[rankOf[slot] * 16 …)` — the view is valid until the next pack.
 *   • the GROUPED LEAVES live in the TAIL of the rank space: after the
 *     tree nodes (the DFS forest), pack() emits per-group CONTIGUOUS
 *     segments — `gStart[g] .. gStart[g+1]`. A group = one contiguous
 *     rank range: the collect scans ONLY the range's words (no order[]/
 *     group[] loads per rank), and a fully-visible group is ONE block copy.
 *     `gStart[0]` is the tree/tail boundary (the hierarchical cull stops
 *     there; the tail is brute-culled — leaves gain nothing from the tree
 *     machinery). The CONTRACT: a tail member is a grouped LEAF (firstChild
 *     < 0) with a dense group id — a grouped node with children keeps its
 *     DFS placement in the tree region and is NOT an instance (the
 *     documented leaf-domain contract; the pre-192 full-scan behavior is
 *     preserved under the setTailLayout(false) kill-switch).
 *   • `gHidden[g]` — the count of the segment's members with NF_VISIBLE
 *     off (rebuilt by pack, maintained by setVisible): zero ⟹ the collect
 *     may skip the per-member nodeFlags test entirely (popcount / block
 *     copy paths).
 */

/** Header word indices (Int32Array/Uint32Array, word 0..H_WORDS-1). */
export const H_MAGIC = 0
export const H_CAPACITY = 1
export const H_NODE_COUNT = 2
export const H_CAMERA_MAX = 3
export const H_CAMERA_COUNT = 4
export const H_INPUT_EPOCH = 5
export const H_OUTPUT_EPOCH = 6
export const H_LAYOUT_EPOCH = 7
export const H_CLOCK = 8
export const H_CMD_FLAGS = 9
export const H_BITS_WORDS = 10
export const H_GROUP_COUNT = 11
export const H_INSTANCE_POOL = 12
export const H_DROPPED_INSTANCES = 13
export const H_STALE_TAKES = 14
export const H_INT_WORDS = 15
export const H_FLOAT_FLOATS = 16
export const H_MAX_INSTANCES = 17
export const H_GROUP_MAX = 18
/** Task 85: the H_LAYOUT_EPOCH seen by the last collectInstances (a visibility diff between epochs is valid only with unchanged ranks). */
export const H_COLLECT_LAYOUT_EPOCH = 19
export const H_WORDS = 20

/** The magic word 'RNS3' (int32 LE; v3 — Task 192: rankOf + gStart + gHidden). */
export const SCENE_MAGIC = 0x3353_4e52

/** Frame command flags (H_CMD_FLAGS) for the worker. */
export const CMD_UPDATE_WORLD = 1
export const CMD_CULL = 2
export const CMD_INSTANCES = 4
export const CMD_REFIT = 8
export const CMD_ALL = CMD_UPDATE_WORLD | CMD_CULL | CMD_INSTANCES | CMD_REFIT
/** Stop the worker (the bridge's dispose()). */
export const CMD_STOP = 1 << 30

/** Node flags (nodeFlags). */
export const NF_VISIBLE = 1
/** The slot is occupied by a live node (0 — a free slot). */
export const NF_ALIVE = 2

/** Scene buffer allocation parameters. */
export interface SceneBufferOptions {
  /** Maximum nodes (slots). Default 1024. */
  readonly capacity?: number
  /** Maximum cameras with visibility bit fields. Default 4. */
  readonly cameraMax?: number
  /** Maximum instance groups (dense ids 0..G-1). Default 64. */
  readonly groupMax?: number
  /** Maximum visible instances per frame (the matrix pool). Default = capacity. */
  readonly maxInstances?: number
  /** SharedArrayBuffer (worker) instead of ArrayBuffer (T0). Default false. */
  readonly shared?: boolean
}

/** All views over a single scene buffer. */
export interface SceneViews {
  readonly buffer: ArrayBufferLike
  /** Signed header words (magic/counters). */
  readonly headerI: Int32Array
  /** Unsigned header words (epochs/stamps). */
  readonly headerU: Uint32Array

  // ─── structure (slot → …) ───────────────────────────────────────────
  readonly parent: Int32Array
  readonly firstChild: Int32Array
  readonly nextSibling: Int32Array
  readonly prevSibling: Int32Array
  /** rank → slot: the depth-first traversal order (a parent always before the children). */
  readonly order: Int32Array
  /** slot → the end of the subtree (rank, exclusive). Task 192: tail
   * members are leaves — a parent's range never absorbs a tail child. */
  readonly subtreeEnd: Int32Array
  /** Task 192: slot → rank (the inverse of order; maintained by pack).
 * Needed wherever a slot must find its RANK-MAJOR world row. */
  readonly rankOf: Int32Array
  readonly group: Int32Array
  readonly payload: Int32Array
  readonly nodeFlags: Int32Array
  readonly generation: Int32Array

  // ─── dirt (u32 stamps of the monotonic H_CLOCK) ─────────────────────────
  readonly localStamp: Uint32Array
  readonly worldStamp: Uint32Array

  // ─── visibility (double-buffered, rank space) ────────────────
  /** 2 × cameraMax × bitsWords words; buffer = epoch & 1. */
  readonly bits: Uint32Array
  /** 2 × cameraMax × groupMax: visible instances of group g (camera × buffer). */
  readonly instCounts: Int32Array
  /** 2 × cameraMax × groupMax: the offset of group g in instPool (camera × buffer). */
  readonly instOffsets: Int32Array

  // ─── Task 192: the tail layout (pack-maintained, shared via the SAB) ───
  /** groupMax + 1: the TAIL segment starts. [gStart[g], gStart[g+1]) is
 * group g's contiguous rank range of grouped leaves; gStart[0] = the
 * tree/tail boundary (the hierarchical cull's stop; the tail brute start). */
  readonly gStart: Int32Array
  /** groupMax: the count of group g's segment members with NF_VISIBLE off
 * (pack rebuilds it; setVisible maintains it). Zero ⟹ the collect's
 * popcount / block-copy paths (no per-member nodeFlags loads). */
  readonly gHidden: Int32Array

  // ─── Task 85: optimization regions ─────────────────────────────
  /** groupMax: the H_CLOCK stamp of the group's last CONTENT change (all
   *  cameras): the world of any node of the group recomputed (updateWorld) or the
   *  composition changed (setVisible). Lives in the SAB: written by the pipeline thread. */
  readonly groupTouch: Int32Array
  /** cameraMax × groupMax: the stamp of the last visibility FLIP of a node
   *  of the group FOR A SPECIFIC camera (Task 85): a drone flip must not
   *  re-upload the minimap's statics — instance buffers differ per camera, and so does the dirt.
   * Index: cameraIndex × groupMax + group. */
  readonly groupFlip: Int32Array
  /** bitsWords (one bit per NODE, not per rank — slot-addressable): "the
   *  node's subtree may have changed its bounds — refit must rebuild". Set in
   *  updateWorld (a node recompute + a walk up the ancestors), cleared by refit.
 *  A purely optimization hint: an extra bit = extra work, an erroneously
   *  CLEARED bit is impossible (only refit itself clears it after processing). */
  readonly dirtyBounds: Uint32Array

  // ─── geometry (slots; the WORLD is rank-major — Task 192) ───────────
  readonly pos: Float32Array
  readonly quat: Float32Array
  readonly scale: Float32Array
  /** The WORLD matrices, RANK-MAJOR: row `r` is order[r]'s world (Task 192
 * / N1: updateWorld writes by the loop counter, the collect reads
 * sequentially). A view taken via worldMatrix(slot) is valid until the
 * next pack. */
  readonly world: Float32Array
  /** The local sphere (cx, cy, cz, r); r ≤ 0 on an internal node — auto. */
  readonly sphereL: Float32Array
  readonly sphereW: Float32Array

  // ─── cameras and instances ──────────────────────────────────────────────
  /** cameraMax × 24: the frustum planes (normalized). */
  readonly planes: Float32Array
  /** 2 × cameraMax × maxInstances × 16: the world matrices of visible
   *  instances (a segment per camera — multi-camera pools do not conflict). */
  readonly instPool: Float32Array

  // ─── derived sizes ────────────────────────────────────────────
  readonly capacity: number
  readonly cameraMax: number
  readonly groupMax: number
  readonly maxInstances: number
  readonly bitsWords: number
}

/** The number of 32-bit bitset words per camera. */
export function sceneBitsWords(capacity: number): number {
  return (capacity + 31) >> 5
}

// ─── Task 192: the tail-layout kill-switch (here — the import leaf: scene,
// culling and instances all read it; instances↔culling would cycle) ────────
//
// false restores the pre-192 layout family bit-for-bit: pack() emits the pure
// DFS forest (gStart[0] = n — the cull's tail sweep and the collect's
// segments degenerate to the legacy full walks; grouped INTERNAL nodes are
// collected again — the leaf-domain contract applies only in the ON mode).
// Toggling does NOT re-derive an already-packed layout: after a flip the
// scene must repack (a structural edit or an explicit scene.pack()) before
// the segment consumers are consistent — tests/probes toggle + rebuild.

/** Task 192 — enable/disable the tail layout (the N2 kill-switch). */
let tailLayoutEnabled = true

/** Task 192 — the kill-switch (see above). */
export function setTailLayout(enabled: boolean): void {
  tailLayoutEnabled = enabled
}

/** Task 192 — the current kill-switch state (read by pack/cull/collects). */
export function tailLayoutOn(): boolean {
  return tailLayoutEnabled
}

/** The free list entry point in the int region (after the 13 slot arrays). */
export function freeListWord(views: Pick<SceneViews, 'capacity'>): number {
  return H_WORDS + views.capacity * 13
}

/** Allocates the scene buffer and initializes the header. */
export function createSceneBuffer(options: SceneBufferOptions = {}): ArrayBufferLike {
  const capacity = Math.max(1, options.capacity ?? 1024)
  const cameraMax = Math.max(1, options.cameraMax ?? 4)
  const groupMax = Math.max(1, options.groupMax ?? 64)
  const maxInstances = Math.max(0, options.maxInstances ?? capacity)
  const bitsWords = sceneBitsWords(capacity)

  const intWords =
    H_WORDS +
    capacity * 13 + // parent, firstChild, nextSibling, prevSibling, order, subtreeEnd, rankOf, group, payload, nodeFlags, generation, localStamp, worldStamp
    2 + // freeHead, freeCount
    2 * cameraMax * bitsWords +
    2 * cameraMax * groupMax * 2 +
    groupMax + // groupTouch (Task 85)
    cameraMax * groupMax + // groupFlip — per-camera flip stamps (Task 85)
    bitsWords + // dirtyBounds (Task 85)
    (groupMax + 1) + // gStart (Task 192)
    groupMax // gHidden (Task 192)
  const floatFloats =
    capacity * (3 + 4 + 3 + 16 + 4 + 4) +
    cameraMax * 24 +
    2 * cameraMax * maxInstances * 16

  const bytes = intWords * 4 + floatFloats * 4
  const buffer = options.shared === true ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes)

  const headerI = new Int32Array(buffer, 0, H_WORDS)
  headerI[H_MAGIC] = SCENE_MAGIC
  headerI[H_CAPACITY] = capacity
  headerI[H_NODE_COUNT] = 0
  headerI[H_CAMERA_MAX] = cameraMax
  headerI[H_CAMERA_COUNT] = 0
  headerI[H_INPUT_EPOCH] = 0
  headerI[H_OUTPUT_EPOCH] = 0
  headerI[H_LAYOUT_EPOCH] = 0
  headerI[H_CLOCK] = 0
  headerI[H_CMD_FLAGS] = CMD_ALL
  headerI[H_BITS_WORDS] = bitsWords
  headerI[H_GROUP_COUNT] = 0
  headerI[H_INSTANCE_POOL] = maxInstances
  headerI[H_DROPPED_INSTANCES] = 0
  headerI[H_STALE_TAKES] = 0
  headerI[H_INT_WORDS] = intWords
  headerI[H_FLOAT_FLOATS] = floatFloats
  headerI[H_MAX_INSTANCES] = maxInstances
  headerI[H_GROUP_MAX] = groupMax

  // Structural arrays: the "empty" values.
  const views = buildSceneViews(buffer)
  views.parent.fill(-1)
  views.firstChild.fill(-1)
  views.nextSibling.fill(-1)
  views.prevSibling.fill(-1)
  views.subtreeEnd.fill(0)
  views.group.fill(-1)
  views.payload.fill(-1)
  views.nodeFlags.fill(0) // all slots are free; create() sets NF_ALIVE
  views.instCounts.fill(0)
  views.instOffsets.fill(0)
  views.groupTouch.fill(0)
  views.groupFlip.fill(0)
  views.dirtyBounds.fill(0)
  views.rankOf.fill(0)
  views.gStart.fill(0) // gStart[0] = 0: an empty scene is all tail, no tree
  views.gHidden.fill(0)

  // The free list: slot i → slot i+1 (via nextSibling), head 0.
  // We write through the FULL int view (headerI is limited to H_WORDS words).
  const full = new Int32Array(buffer)
  const freeList = freeListWord(views)
  full[freeList] = capacity > 0 ? 0 : -1
  full[freeList + 1] = capacity
  for (let i = 0; i < capacity - 1; i++) views.nextSibling[i] = i + 1
  views.nextSibling[capacity - 1] = -1

  // Identity transforms.
  for (let i = 0; i < capacity; i++) {
    views.quat[i * 4 + 3] = 1
    views.scale[i * 3] = 1
    views.scale[i * 3 + 1] = 1
    views.scale[i * 3 + 2] = 1
  }
  return buffer
}

/** Builds all views over an existing buffer (+ magic validation). */
export function buildSceneViews(buffer: ArrayBufferLike): SceneViews {
  if (buffer.byteLength < H_WORDS * 4) {
    throw new Error('scene: the buffer is too small for the header')
  }
  const probe = new Int32Array(buffer, 0, H_WORDS)
  if (probe[H_MAGIC] !== SCENE_MAGIC) {
    throw new Error('scene: the buffer is not a scene (magic mismatch)')
  }
  const capacity = probe[H_CAPACITY]
  const cameraMax = probe[H_CAMERA_MAX]
  const groupMax = probe[H_GROUP_MAX]
  const maxInstances = probe[H_MAX_INSTANCES]
  const bitsWords = probe[H_BITS_WORDS]
  const intWords = probe[H_INT_WORDS]
  const floatFloats = probe[H_FLOAT_FLOATS]
  const expectedBytes = intWords * 4 + floatFloats * 4
  if (buffer.byteLength < expectedBytes) {
    throw new Error(`scene: the buffer is smaller than the layout (${buffer.byteLength} < ${expectedBytes})`)
  }

  const headerI = probe
  const headerU = new Uint32Array(buffer, 0, H_WORDS)

  let w = H_WORDS
  const int = (len: number): Int32Array => {
    const v = new Int32Array(buffer, w * 4, len)
    w += len
    return v
  }
  const uint = (len: number): Uint32Array => {
    const v = new Uint32Array(buffer, w * 4, len)
    w += len
    return v
  }

  const parent = int(capacity)
  const firstChild = int(capacity)
  const nextSibling = int(capacity)
  const prevSibling = int(capacity)
  const order = int(capacity)
  const subtreeEnd = int(capacity)
  const rankOf = int(capacity) // Task 192 — slot → rank
  const group = int(capacity)
  const payload = int(capacity)
  const nodeFlags = int(capacity)
  const generation = int(capacity)
  const localStamp = uint(capacity)
  const worldStamp = uint(capacity)
  int(2) // freeHead, freeCount — beyond H_WORDS (freeListWord)

  const bits = uint(2 * cameraMax * bitsWords)
  const instCounts = int(2 * cameraMax * groupMax)
  const instOffsets = int(2 * cameraMax * groupMax)
  const groupTouch = int(groupMax)
  const groupFlip = int(cameraMax * groupMax)
  const dirtyBounds = uint(bitsWords)
  const gStart = int(groupMax + 1) // Task 192 — the tail segments
  const gHidden = int(groupMax) // Task 192 — hidden members per segment
  if (w !== intWords) {
    throw new Error(`scene: the int-region layout has drifted (${w} ≠ ${intWords})`)
  }

  let f = intWords
  const floats = (len: number): Float32Array => {
    const v = new Float32Array(buffer, f * 4, len)
    f += len
    return v
  }
  const pos = floats(capacity * 3)
  const quat = floats(capacity * 4)
  const scale = floats(capacity * 3)
  const world = floats(capacity * 16)
  const sphereL = floats(capacity * 4)
  const sphereW = floats(capacity * 4)
  const planes = floats(cameraMax * 24)
  const instPool = floats(2 * cameraMax * Math.max(maxInstances, 0) * 16)
  if (f !== intWords + floatFloats) {
    throw new Error(`scene: the float-region layout has drifted (${f} ≠ ${intWords + floatFloats})`)
  }

  return {
    buffer,
    headerI,
    headerU,
    parent, firstChild, nextSibling, prevSibling,
    order, subtreeEnd, rankOf, group, payload, nodeFlags, generation,
    localStamp, worldStamp,
    bits, instCounts, instOffsets, groupTouch, groupFlip, dirtyBounds,
    gStart, gHidden,
    pos, quat, scale, world, sphereL, sphereW,
    planes, instPool,
    capacity, cameraMax, groupMax, maxInstances, bitsWords,
  }
}
