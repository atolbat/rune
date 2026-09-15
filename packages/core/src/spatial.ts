/**
 * spatial.ts — the culling kit's spatial index (Task 200; Task 201 — the
 * grown query surface; Task 205 — the masked frustum walk + the
 * allocation-free slab walk; Task 212 — the override lane; Task 213 — the
 * SoA round).
 *
 * THE QUERY SURFACE (both structures, one vocabulary — the «intuitive
 * syntax» ask made literal):
 *
 *   tree.queryFrustum(planes)          — the cull walk (survivor ids)
 *   tree.queryBox(min, max)            — the region/marquee overlap
 *   tree.querySphere(x, y, z, r)       — the radius query (LOD rings)
 *   tree.queryPoint(x, y, z)           — THE HIT TEST (boxes containing p)
 *   tree.queryRay(ox, oy, oz, dx, dy, dz) — ALL hits, sorted by t
 *   tree.raycast(ox, oy, oz, dx, dy, dz)  — THE FIRST HIT ({id, t} | null)
 *   tree.insert(box) / remove(id) / update(box)   — dynamics
 *   tree.insertBox(id, cx..hz) / updateBox(id, cx..hz) — the scalar twins
 *   tree.rebuild()                     — THE FOLD (both structures)
 *
 * Both structures are built over the same AABB contract and answer the
 * same queries; the demo's validation gate runs both and requires
 * identical survivor SETS — two independent traversals of two different
 * hierarchy shapes agreeing is the strongest cheap proof of «clean».
 *
 * Task 213 — THE SoA ROUND: the kit's INTERNAL storage rides the flat
 * lane the Task-210 H-group measured (an object-array walk of the six
 * AABB fields runs 2.5-8x behind the flat record words on V8; JSC holds
 * near-parity on monomorphic reads — the honest split, and the reason
 * the object front door stays open). ONE Float64Array of interleaved
 * [cx, cy, cz, hx, hy, hz] rows (48 B — one cache line per box; the
 * measured aos_f64 column won JSC and sat within 13% of the parallel
 * split on V8) + ONE Int32Array of ids; every leaf, layout cell and
 * overflow slot holds a ROW INDEX and every predicate reads the six
 * doubles at row*6. The SpatialBox object front door stays as a compat
 * shim (it writes one row); the kit's OWN front door — the strided
 * RecordView every other brick (flatCull, clusterize, the software
 * occluder) already speaks — feeds the builders directly: zero boxing,
 * zero copies, the same numbers the GPU kernel reads.
 *
 * DOM-free, GPU-free — plain Float64 arithmetic. The sandwich against the
 * GPU's fp32 kernel lives at the CALLER with a documented tolerance (the
 * kernel's projection rounds differently near the frustum planes).
 * ══════════════════════════════════════════════════════════════════════════
 */

import { frustumPlanes, FRUSTUM_PLANE_COUNT } from './frustum.ts'
import type { RecordView } from './culling.ts'

/** One indexed AABB — the spatial item contract (id + center + half).
 * Task 213: the object shape is the COMPAT front door; the kit stores the
 * row in its own columns the moment it sees it. */
export interface SpatialBox {
  readonly id: number
  readonly cx: number
  readonly cy: number
  readonly cz: number
  readonly hx: number
  readonly hy: number
  readonly hz: number
}

/** One ray hit: the box's id and the ENTRY distance along the ray (world
 *  units — the direction is assumed normalized, the Frostbite picking
 *  convention; t is the slab interval's low end, so t ≥ 0 always). */
export interface RayHit {
  readonly id: number
  readonly t: number
}

/** The shared query surface: both hierarchies answer the same questions. */
export interface SpatialIndex {
  readonly kind: 'octree' | 'bvh'
  readonly count: number
  /** The LIVE item count (build count + inserts − removes). */
  readonly live: number
  readonly stats: { readonly nodes: number; readonly leaves: number; readonly depth: number; readonly items: number; readonly lane: number }
  /** The frustum walk: `planes` is frustumPlanes()'s 24-float layout.
   *  Returns the SURVIVOR ids — every box NOT fully outside any single
   *  plane (traversal order; treat as a set). */
  queryFrustum(planes: ArrayLike<number>): Uint32Array
  /** The axis-aligned overlap query: every box overlapping [min, max]. */
  queryBox(min: readonly [number, number, number], max: readonly [number, number, number]): Uint32Array
  /** The sphere overlap query: every box whose AABB reaches the sphere. */
  querySphere(cx: number, cy: number, cz: number, radius: number): Uint32Array
  /** THE HIT TEST: every box whose AABB contains the point. */
  queryPoint(x: number, y: number, z: number): Uint32Array
  /** The ray walk: EVERY hit along the ray, sorted by entry t. */
  queryRay(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): RayHit[]
  /** The picking query: the NEAREST hit, or null when the ray misses. */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): RayHit | null
  /** Adds a box (the octree splits a full leaf on the spot; the BVH
   *  appends to a linear overflow list until rebuild() — both honest,
   *  both documented). ANY re-insert of an id the structure already
   *  knows (tombstoned or live) rides the override lane (see update()) —
   *  the tree is never handed a second copy of an id it already owns,
   *  and the live count rides the byId authority either way. */
  insert(box: SpatialBox): void
  /** Task 213 — the scalar twin of insert(): the store-driven edit loop
   *  writes six numbers, zero objects, zero allocations. */
  insertBox(id: number, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): void
  /** Tombstones the id (queries skip it; the tree shape stays). */
  remove(id: number): void
  /** Moves a box — THE OVERRIDE LANE (Task 212): a live id's freshest
   *  bounds land in a small id→row lane the queries read AFTER the tree,
   *  while the tree's own copy is skipped by id — O(1) per update, no
   *  stale growth, no duplicate answers. A dead id rides insert(). */
  update(box: SpatialBox): void
  /** Task 213 — the scalar twin of update(): six numbers straight into
   *  the kit's columns (the demo's drone squad rides this every frame). */
  updateBox(id: number, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): void
  /** THE FOLD: rebuilds the whole tree over the live set's FRESHEST
   *  geometry (the override lane empties back into the tree, the loose
   *  bounds re-tighten, the columns compact). Both structures fold. */
  rebuild?(): void
  /** Task 205 — the instrumented counter: plane evaluations performed by
   *  the LAST queryFrustum (the mask-inheritance win, measured not
   *  claimed — the legacy walk re-arms all six planes at every node). */
  readonly planeTests: number
}

// ─── the shared AABB–plane predicate (the GPU kernel's mirror) ────────────

/** TRUE iff the AABB is fully OUTSIDE at least one plane — the n-vertex
 *  test: the farthest corner along −n still outside means every corner
 *  is. The exact arithmetic shape of the Hi-Z kernel's «all 8 corners
 *  outside the same plane» verdict, on the box instead of 8 points. */
export function aabbOutsideFrustum(
  planes: ArrayLike<number>,
  cx: number, cy: number, cz: number,
  hx: number, hy: number, hz: number,
): boolean {
  for (let i = 0; i < FRUSTUM_PLANE_COUNT; i++) {
    const o = i * 4
    // the negative half-space reach: |n| · h (no per-corner loop)
    const reach = Math.abs(planes[o]) * hx + Math.abs(planes[o + 1]) * hy + Math.abs(planes[o + 2]) * hz
    if (planes[o] * cx + planes[o + 1] * cy + planes[o + 2] * cz + planes[o + 3] < -reach) {
      return true
    }
  }
  return false
}

/** TRUE iff the AABB is fully INSIDE all six planes — the trivial accept:
 *  a whole subtree's worth of items answered with one test. */
export function aabbInsideFrustum(
  planes: ArrayLike<number>,
  cx: number, cy: number, cz: number,
  hx: number, hy: number, hz: number,
): boolean {
  for (let i = 0; i < FRUSTUM_PLANE_COUNT; i++) {
    const o = i * 4
    const reach = Math.abs(planes[o]) * hx + Math.abs(planes[o + 1]) * hy + Math.abs(planes[o + 2]) * hz
    if (planes[o] * cx + planes[o + 1] * cy + planes[o + 2] * cz + planes[o + 3] < reach) {
      return false
    }
  }
  return true
}

// ─── the shared node geometry helpers ─────────────────────────────────────

interface NodeBounds {
  minx: number; miny: number; minz: number
  maxx: number; maxy: number; maxz: number
}

/** The box–box overlap test (touching boxes do NOT overlap — the
 *  query contract, shared by both structures). */
function boundsOverlap(b: NodeBounds, min: readonly number[], max: readonly number[]): boolean {
  return b.minx < max[0] && b.maxx > min[0]
    && b.miny < max[1] && b.maxy > min[1]
    && b.minz < max[2] && b.maxz > min[2]
}

/** The box–sphere overlap: the clamped-center distance (the classic
 *  closest-point form — no sqrt until the final compare). Node cells
 *  only; the ITEM tests inline the same arithmetic on the row's six
 *  doubles (Task 213: the old path allocated a six-field NodeBounds
 *  literal per item — the last per-item allocation in the walks). */
function boxReachesSphere(
  b: NodeBounds,
  cx: number, cy: number, cz: number, radius: number,
): boolean {
  const dx = Math.max(b.minx - cx, 0, cx - b.maxx)
  const dy = Math.max(b.miny - cy, 0, cy - b.maxy)
  const dz = Math.max(b.minz - cz, 0, cz - b.maxz)
  return dx * dx + dy * dy + dz * dz <= radius * radius
}

// ─── Task 205 — THE ALLOCATION-FREE SLAB WALK (the picking path) ──────────

/** clipRay's numeric twin (the ryg discipline: no allocations in the hot
 *  walk — the pre-213 path bought a [t0, t1] tuple per NODE and a
 *  six-field NodeBounds object per LEAF ITEM, all short-lived GC garbage
 *  on the click path; Task 213 moved the OCTREE's queryRay onto this
 *  lane too — the BVH had ridden it since 205). Returns the ENTRY t, or
 *  −1 on a miss; the EXIT t lands in the module scratch `slabExit`. The
 *  arithmetic order is clipRay's own, so every t is bit-identical — the
 *  walks decide identically and the tie law survives. */
let slabExit = 0
function slabEnter(
  ox: number, oy: number, oz: number,
  ix: number, iy: number, iz: number,
  minx: number, miny: number, minz: number,
  maxx: number, maxy: number, maxz: number,
  t0: number, t1: number,
): number {
  let en = t0
  let ex = t1
  if (ix === Infinity || ix === -Infinity) {
    if (ox < minx || ox > maxx) return -1
  } else {
    let ta = (minx - ox) * ix
    let tb = (maxx - ox) * ix
    if (ta > tb) { const s = ta; ta = tb; tb = s }
    if (ta > en) en = ta
    if (tb < ex) ex = tb
    if (en > ex) return -1
  }
  if (iy === Infinity || iy === -Infinity) {
    if (oy < miny || oy > maxy) return -1
  } else {
    let ta = (miny - oy) * iy
    let tb = (maxy - oy) * iy
    if (ta > tb) { const s = ta; ta = tb; tb = s }
    if (ta > en) en = ta
    if (tb < ex) ex = tb
    if (en > ex) return -1
  }
  if (iz === Infinity || iz === -Infinity) {
    if (oz < minz || oz > maxz) return -1
  } else {
    let ta = (minz - oz) * iz
    let tb = (maxz - oz) * iz
    if (ta > tb) { const s = ta; ta = tb; tb = s }
    if (ta > en) en = ta
    if (tb < ex) ex = tb
    if (en > ex) return -1
  }
  slabExit = ex
  return en
}

// ─── Task 205 — THE MASKED FRUSTUM TEST (plane-mask inheritance) ─────────

/** Sýkora & Jelínek 2007 (Efficient View Frustum Culling) — the Cesium
 *  JS line: `mask`'s set bits name the planes the PARENT cell
 *  INTERSECTED. A plane proven fully INSIDE for the parent is proven for
 *  every descendant (cells only shrink), so its bit never comes back —
 *  deep nodes end up testing the one or two planes the camera actually
 *  crosses instead of all six, twice (the old walk ran the outside scan
 *  and the inside scan separately). `full` re-arms all six bits: the
 *  Task-201 baseline walk, the A/B leg and the oracle. Returns
 *  FRUSTUM_PRUNED (fully outside — cut the subtree) or the child mask
 *  (0 = fully inside — the subtree answers with no further plane test). */
const FRUSTUM_PRUNED = -1

// ─── Task 213 — THE KIT'S OWN COLUMNS (the SoA round) ─────────────────────
//
// ONE interleaved Float64Array of [cx, cy, cz, hx, hy, hz] rows + ONE
// Int32Array of ids. Rows are allocated monotonically between folds and
// compacted by rebuild() — the Task-212 bounded-growth law carries over
// verbatim (a remove tombstones the id; the row it leaves behind dies at
// the next fold, exactly the way the tombstoned leaf objects used to).
// The row's geometry is ALWAYS the freshest write (updateBox overwrites
// it in place) — the override lane exists for the tree's stale
// PLACEMENT, never for stale data: there is exactly ONE copy of every
// box's numbers in the kit.

interface KitRows {
  cap: number
  n: number
  /** row * 6: cx, cy, cz, hx, hy, hz (interleaved — one cache line). */
  geo: Float64Array
  ids: Int32Array
}

function kitRows(cap: number): KitRows {
  const c = Math.max(16, cap)
  return { cap: c, n: 0, geo: new Float64Array(c * 6), ids: new Int32Array(c) }
}

/** Grows the columns (plain realloc + set — memcpy class; the row count
 *  is bounded by the distinct-id law and compacted by every fold). */
function growRows(rows: KitRows, need: number): void {
  if (need <= rows.cap) return
  let cap = rows.cap * 2
  while (cap < need) cap *= 2
  const geo = new Float64Array(cap * 6)
  geo.set(rows.geo)
  const ids = new Int32Array(cap)
  ids.set(rows.ids)
  rows.cap = cap
  rows.geo = geo
  rows.ids = ids
}

/** Allocates a row for an id the kit has never held (or a duplicate
 *  input id — the build keeps one row per item, the way the object
 *  leaves kept every copy; the stamp mask dedups the ANSWERS). */
function allocRow(rows: KitRows, id: number): number {
  growRows(rows, rows.n + 1)
  const row = rows.n++
  rows.ids[row] = id
  return row
}

/** The id contract, made loud: the stamp array is indexed by id, and the
 *  id column is int32 — a fractional or oversized id used to corrupt the
 *  stamp silently; now it fails at the door. */
function assertKitId(id: number): void {
  if (!Number.isInteger(id) || id < 0 || id > 0x7fffffff) {
    throw new Error(`spatial kit: box id must be a non-negative int32 (got ${id})`)
  }
}

/** The exact union of the listed rows' AABBs (a node's tight bounds). */
function unionRows(rows: KitRows, list: readonly number[]): NodeBounds {
  const geo = rows.geo
  let minx = Infinity, miny = Infinity, minz = Infinity
  let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity
  for (let i = 0; i < list.length; i++) {
    const o = list[i] * 6
    if (geo[o] - geo[o + 3] < minx) minx = geo[o] - geo[o + 3]
    if (geo[o + 1] - geo[o + 4] < miny) miny = geo[o + 1] - geo[o + 4]
    if (geo[o + 2] - geo[o + 5] < minz) minz = geo[o + 2] - geo[o + 5]
    if (geo[o] + geo[o + 3] > maxx) maxx = geo[o] + geo[o + 3]
    if (geo[o + 1] + geo[o + 4] > maxy) maxy = geo[o + 1] + geo[o + 4]
    if (geo[o + 2] + geo[o + 5] > maxz) maxz = geo[o + 2] + geo[o + 5]
  }
  return { minx, miny, minz, maxx, maxy, maxz }
}

// ─── THE OCTREE ───────────────────────────────────────────────────────────

interface OctNode {
  b: NodeBounds
  /** the leaf's items (null on an internal node) — MUTABLE: insert() pushes.
   *  Task 213: ROW INDICES into the kit's columns, not objects. */
  items: number[] | null
  /** the 8 children, index = y*4 + z*2 + x (null when an octant is empty) */
  kids: (OctNode | null)[] | null
  level: number
}

/** Builds the octree over the boxes. `capacity` (items per leaf before a
 *  split, default 8), `maxDepth` (default 12 — the degenerate-data guard:
 *  co-located items cannot split forever). The split point is the cell's
 *  CENTER; an item joins EVERY child its AABB touches (the conservative
 *  route — a straddling box lives in several leaves); the query walk
 *  deduplicates through a per-query stamp mask.
 *
 *  Task 201 — THE DYNAMIC OCTREE: insert() walks the same center rule and
 *  splits a leaf the moment it crosses the capacity (the split machinery
 *  is shared with the build); remove() tombstones (the tree shape is
 *  never torn down mid-query). Task 212 — THE OVERRIDE LANE: update() on
 *  a live id never touches the tree (the leaves hold the id's row, whose
 *  GEOMETRY is always the freshest write — only the PLACEMENT went
 *  stale); the id lands in a small id→row lane the walks read after the
 *  tree while the tree's own copy is skipped by id — O(1) per update,
 *  zero growth, zero duplicate answers. rebuild() folds the lane back
 *  in (both structures fold). */
export function buildOctree(items: readonly SpatialBox[], options?: { capacity?: number; maxDepth?: number; planeMask?: boolean }): SpatialIndex {
  // the compat front door: one row per input item, the object fields
  // copied into the columns (the object itself is never held)
  const rows = kitRows(items.length)
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    assertKitId(it.id)
    const row = allocRow(rows, it.id)
    const o = row * 6
    rows.geo[o] = it.cx
    rows.geo[o + 1] = it.cy
    rows.geo[o + 2] = it.cz
    rows.geo[o + 3] = it.hx
    rows.geo[o + 4] = it.hy
    rows.geo[o + 5] = it.hz
  }
  return octreeFromRows(rows, items.length, options)
}

/** Task 213 — the kit's OWN front door: the strided RecordView every
 *  other kit brick already speaks (the records region of a store, or any
 *  parallel word layout). The record's id IS its row (0..count−1), the
 *  documented store contract. f32 words land in the f64 columns exactly
 *  (every f32 is an f64) — the same numbers the GPU kernel reads. */
export function buildOctreeRecords(view: RecordView, options?: { capacity?: number; maxDepth?: number; planeMask?: boolean }): SpatialIndex {
  const rows = kitRows(view.count)
  const w = view.words
  const cOff = view.base + view.center
  const hOff = view.base + view.half
  const stride = view.stride
  const geo = rows.geo
  for (let i = 0; i < view.count; i++) {
    const co = cOff + i * stride
    const ho = hOff + i * stride
    rows.ids[i] = i
    const o = i * 6
    geo[o] = w[co]
    geo[o + 1] = w[co + 1]
    geo[o + 2] = w[co + 2]
    geo[o + 3] = w[ho]
    geo[o + 4] = w[ho + 1]
    geo[o + 5] = w[ho + 2]
  }
  rows.n = view.count
  return octreeFromRows(rows, view.count, options)
}

function octreeFromRows(rows: KitRows, count: number, options?: { capacity?: number; maxDepth?: number; planeMask?: boolean }): SpatialIndex {
  const capacity = Math.max(1, options?.capacity ?? 8)
  const maxDepth = Math.max(1, options?.maxDepth ?? 12)
  const planeMask = options?.planeMask ?? true
  let nodes = 0
  let leaves = 0
  let depth = 0

  function cellDegenerate(cell: NodeBounds): boolean {
    return cell.maxx - cell.minx <= 1e-9 || cell.maxy - cell.miny <= 1e-9 || cell.maxz - cell.minz <= 1e-9
  }

  /** The octant test — which of the 8 children an AABB touches (the
   *  build and insert() share the exact same rule). Task 213: the eight
   *  booleans pack into a mask — the old path allocated a fresh
   *  boolean[8] per item per split. */
  function octantMask(row: number, cell: NodeBounds): number {
    const g = rows.geo
    const o = row * 6
    const mx = (cell.minx + cell.maxx) * 0.5
    const my = (cell.miny + cell.maxy) * 0.5
    const mz = (cell.minz + cell.maxz) * 0.5
    const lox = g[o] - g[o + 3], hix = g[o] + g[o + 3]
    const loy = g[o + 1] - g[o + 4], hiy = g[o + 1] + g[o + 4]
    const loz = g[o + 2] - g[o + 5], hiz = g[o + 2] + g[o + 5]
    let mask = 0
    for (let x = 0; x < 2; x++) {
      if (x === 0 ? lox >= mx : hix <= mx) continue
      for (let y = 0; y < 2; y++) {
        if (y === 0 ? loy >= my : hiy <= my) continue
        for (let z = 0; z < 2; z++) {
          if (z === 0 ? loz >= mz : hiz <= mz) continue
          mask |= 1 << (y * 4 + z * 2 + x)
        }
      }
    }
    return mask
  }

  function childCell(cell: NodeBounds, k: number): NodeBounds {
    const mx = (cell.minx + cell.maxx) * 0.5
    const my = (cell.miny + cell.maxy) * 0.5
    const mz = (cell.minz + cell.maxz) * 0.5
    const x = k & 1, z = (k >> 1) & 1, y = k >> 2
    return {
      minx: x === 0 ? cell.minx : mx, maxx: x === 0 ? mx : cell.maxx,
      miny: y === 0 ? cell.miny : my, maxy: y === 0 ? my : cell.maxy,
      minz: z === 0 ? cell.minz : mz, maxz: z === 0 ? mz : cell.maxz,
    }
  }

  function makeLeaf(itemsAt: number[], cell: NodeBounds, level: number): OctNode {
    nodes++
    if (level > depth) depth = level
    leaves++
    return { b: cell, items: itemsAt, kids: null, level }
  }

  function buildNode(itemsAt: number[], cell: NodeBounds, level: number): OctNode {
    if (itemsAt.length <= capacity || level >= maxDepth || cellDegenerate(cell)) {
      return makeLeaf(itemsAt, cell, level)
    }
    return splitOrLeaf(itemsAt, cell, level)
  }

  /** The split: distribute the rows over the octants (an item joins
   *  EVERY child it touches); the PROGRESS GUARD keeps co-located data
   *  from recursing forever (a split that moved nothing makes a leaf). */
  function splitOrLeaf(itemsAt: number[], cell: NodeBounds, level: number): OctNode {
    nodes++
    if (level > depth) depth = level
    const octants: number[][] = Array.from({ length: 8 }, () => [])
    for (let i = 0; i < itemsAt.length; i++) {
      const hit = octantMask(itemsAt[i], cell)
      if (hit === 0) continue
      for (let k = 0; k < 8; k++) if (hit & (1 << k)) octants[k].push(itemsAt[i])
    }
    let progress = false
    for (const o of octants) {
      if (o.length > 0 && o.length < itemsAt.length) { progress = true; break }
    }
    if (!progress) {
      return makeLeaf(itemsAt, cell, level)
    }
    const kids: (OctNode | null)[] = octants.map((o, k) =>
      o.length === 0 ? null : buildNode(o, childCell(cell, k), level + 1))
    return { b: cell, items: null, kids, level }
  }

  /** insert()'s split: an IN-PLACE leaf → internal conversion (the leaf
   *  grew past the capacity; its items redistribute over its own cell). */
  function growLeaf(n: OctNode): void {
    if (n.items === null) return
    const itemsAt = n.items
    if (n.level >= maxDepth || cellDegenerate(n.b)) return // the honest stop: a deep/degenerate leaf may exceed the capacity
    const octants: number[][] = Array.from({ length: 8 }, () => [])
    for (let i = 0; i < itemsAt.length; i++) {
      const hit = octantMask(itemsAt[i], n.b)
      if (hit === 0) continue
      for (let k = 0; k < 8; k++) if (hit & (1 << k)) octants[k].push(itemsAt[i])
    }
    let progress = false
    for (const o of octants) {
      if (o.length > 0 && o.length < itemsAt.length) { progress = true; break }
    }
    if (!progress) return
    // the counters follow the mutation (stats stay honest after inserts)
    leaves--
    const kids: (OctNode | null)[] = octants.map((o, k) =>
      o.length === 0 ? null : buildNode(o, childCell(n.b, k), n.level + 1))
    n.items = null
    n.kids = kids
  }

  // the initial build list: every input row, in order (the object path's
  // items.slice() twin — duplicate ids keep their copies here, the way
  // the object leaves always did)
  const initial: number[] = new Array(count)
  for (let i = 0; i < count; i++) initial[i] = i
  let root = buildNode(initial, unionRows(rows, initial), 1)

  // ── Task 212 — THE OVERRIDE LANE + THE LIVE-SET AUTHORITY ─────────────
  // rowOf holds the FRESHEST row per live id (the kit's columns hold the
  // freshest GEOMETRY — there is only one copy); moved holds the live ids
  // the LANE owns — their tree PLACEMENT is stale by construction, so the
  // walks skip those ids and answer them from the lane after the tree.
  // This is the fix for the field report («scene edit взвинчивает мс,
  // со временем растёт»): update() used to be remove+insert, which left
  // every intermediate object in the leaves FOREVER — 48 drones at 60fps
  // grew this tree 55k → 3.3M nodes in ONE SECOND (measured,
  // scripts/task212-leak.mjs) and the frame with it; rebuild() now folds
  // the lane back in.
  const rowOf = new Map<number, number>()
  for (let i = 0; i < count; i++) rowOf.set(rows.ids[i], i)
  const moved = new Map<number, number>()

  // ── the live-set bookkeeping (the dynamic twin) + the query machinery:
  //    the stamp mask deduplicates the straddlers (`seen` re-grows when an
  //    inserted id outruns the build's maxId) ──
  const removed = new Set<number>()
  let maxId = 0
  for (let i = 0; i < count; i++) if (rows.ids[i] > maxId) maxId = rows.ids[i]
  let seen = new Uint8Array(maxId + 1)
  let stamp = 0
  const out: number[] = []
  const hits: RayHit[] = []

  function beginQuery(): void {
    out.length = 0
    stamp++
    if (stamp >= 255) {
      seen.fill(0)
      stamp = 1
    }
  }

  function ensureCapacity(id: number): void {
    if (id < seen.length) return
    const grown = new Uint8Array(Math.max(seen.length * 2, id + 1))
    grown.set(seen)
    seen = grown
  }

  // ── Task 205 — the instrumented masked walk ──
  let planeTests = 0
  function maskedPlanes(
    planes: ArrayLike<number>,
    cx: number, cy: number, cz: number,
    hx: number, hy: number, hz: number,
    mask: number, full: boolean,
  ): number {
    let m = full ? 0b111111 : mask
    for (let i = 0; i < 6; i++) {
      const bit = 1 << i
      if ((m & bit) === 0) continue
      planeTests++
      const o = i * 4
      const ax = planes[o], ay = planes[o + 1], az = planes[o + 2]
      const reach = Math.abs(ax) * hx + Math.abs(ay) * hy + Math.abs(az) * hz
      const d = ax * cx + ay * cy + az * cz + planes[o + 3]
      if (d < -reach) return FRUSTUM_PRUNED
      if (d >= reach) m &= ~bit
    }
    return m
  }

  function walkFrustum(n: OctNode, planes: ArrayLike<number>, mask: number): void {
    if (mask !== 0) {
      const cx = (n.b.minx + n.b.maxx) * 0.5
      const cy = (n.b.miny + n.b.maxy) * 0.5
      const cz = (n.b.minz + n.b.maxz) * 0.5
      const hx = (n.b.maxx - n.b.minx) * 0.5
      const hy = (n.b.maxy - n.b.miny) * 0.5
      const hz = (n.b.maxz - n.b.minz) * 0.5
      const r = maskedPlanes(planes, cx, cy, cz, hx, hy, hz, mask, !planeMask)
      if (r === FRUSTUM_PRUNED) return
      mask = r
    }
    if (n.items !== null) {
      const g = rows.geo
      const ids = rows.ids
      const items = n.items
      if (mask === 0) {
        for (let i = 0; i < items.length; i++) {
          const row = items[i]
          const id = ids[row]
          if (removed.has(id) || moved.has(id)) continue
          if (seen[id] !== stamp) { seen[id] = stamp; out.push(id) }
        }
      } else {
        for (let i = 0; i < items.length; i++) {
          const row = items[i]
          const id = ids[row]
          if (removed.has(id) || moved.has(id)) continue
          if (seen[id] === stamp) continue
          seen[id] = stamp // (mark either way: one verdict per box per query)
          const o = row * 6
          if (!aabbOutsideFrustum(planes, g[o], g[o + 1], g[o + 2], g[o + 3], g[o + 4], g[o + 5])) out.push(id)
        }
      }
      return
    }
    const kids = n.kids
    if (kids !== null) {
      for (const k of kids) {
        if (k !== null) walkFrustum(k, planes, mask)
      }
    }
  }

  function walkBox(n: OctNode, min: readonly number[], max: readonly number[]): void {
    if (!boundsOverlap(n.b, min, max)) return
    if (n.items !== null) {
      const g = rows.geo
      const ids = rows.ids
      const items = n.items
      for (let i = 0; i < items.length; i++) {
        const row = items[i]
        const id = ids[row]
        if (removed.has(id) || moved.has(id)) continue
        if (seen[id] === stamp) continue
        seen[id] = stamp
        const o = row * 6
        if (g[o] + g[o + 3] > min[0] && g[o] - g[o + 3] < max[0]
          && g[o + 1] + g[o + 4] > min[1] && g[o + 1] - g[o + 4] < max[1]
          && g[o + 2] + g[o + 5] > min[2] && g[o + 2] - g[o + 5] < max[2]) {
          out.push(id)
        }
      }
      return
    }
    const kids = n.kids
    if (kids !== null) {
      for (const k of kids) {
        if (k !== null) walkBox(k, min, max)
      }
    }
  }

  function walkSphere(n: OctNode, cx: number, cy: number, cz: number, radius: number): void {
    if (!boxReachesSphere(n.b, cx, cy, cz, radius)) return
    if (n.items !== null) {
      const g = rows.geo
      const ids = rows.ids
      const items = n.items
      for (let i = 0; i < items.length; i++) {
        const row = items[i]
        const id = ids[row]
        if (removed.has(id) || moved.has(id)) continue
        if (seen[id] === stamp) continue
        seen[id] = stamp
        // Task 213: boxReachesSphere's arithmetic inlined on the row's
        // six doubles — the old path allocated a NodeBounds literal per
        // item (the last per-item allocation in the walks)
        const o = row * 6
        const dx = Math.max(g[o] - g[o + 3] - cx, 0, cx - (g[o] + g[o + 3]))
        const dy = Math.max(g[o + 1] - g[o + 4] - cy, 0, cy - (g[o + 1] + g[o + 4]))
        const dz = Math.max(g[o + 2] - g[o + 5] - cz, 0, cz - (g[o + 2] + g[o + 5]))
        if (dx * dx + dy * dy + dz * dz <= radius * radius) out.push(id)
      }
      return
    }
    const kids = n.kids
    if (kids !== null) {
      for (const k of kids) {
        if (k !== null) walkSphere(k, cx, cy, cz, radius)
      }
    }
  }

  function walkPoint(n: OctNode, x: number, y: number, z: number): void {
    if (x < n.b.minx || x > n.b.maxx || y < n.b.miny || y > n.b.maxy || z < n.b.minz || z > n.b.maxz) return
    if (n.items !== null) {
      const g = rows.geo
      const ids = rows.ids
      const items = n.items
      for (let i = 0; i < items.length; i++) {
        const row = items[i]
        const id = ids[row]
        if (removed.has(id) || moved.has(id)) continue
        if (seen[id] === stamp) continue
        seen[id] = stamp
        const o = row * 6
        if (Math.abs(x - g[o]) <= g[o + 3] && Math.abs(y - g[o + 1]) <= g[o + 4] && Math.abs(z - g[o + 2]) <= g[o + 5]) {
          out.push(id)
        }
      }
      return
    }
    const kids = n.kids
    if (kids !== null) {
      for (const k of kids) {
        if (k !== null) walkPoint(k, x, y, z)
      }
    }
  }

  // the ray walks: the entry-t interval prunes whole subtrees; the stamp
  // mask deduplicates the straddlers (a box in several leaves reports ONE
  // hit — its own slab interval, the same numbers from any leaf).
  // Task 213: the octree's walk rides the NUMERIC slab lane (the BVH's
  // own since Task 205) — the old path bought a [t0, t1] tuple per node.
  function walkRay(n: OctNode, ox: number, oy: number, oz: number, ix: number, iy: number, iz: number, t0: number, t1: number): void {
    const en = slabEnter(ox, oy, oz, ix, iy, iz, n.b.minx, n.b.miny, n.b.minz, n.b.maxx, n.b.maxy, n.b.maxz, t0, t1)
    if (en < 0) return
    const ex = slabExit
    if (n.items !== null) {
      const g = rows.geo
      const ids = rows.ids
      const items = n.items
      for (let i = 0; i < items.length; i++) {
        const row = items[i]
        const id = ids[row]
        if (removed.has(id) || moved.has(id)) continue
        if (seen[id] === stamp) continue
        seen[id] = stamp
        // THE GLOBAL INTERVAL — not the leaf's clip: a straddler box lives
        // in several leaves, and the ray may cross the cell's EMPTY part
        // before reaching the box (the leaf-local test would fail there,
        // but the stamp suppresses the later leaf's TRUE hit — the dedup
        // must carry the box's own interval, the same numbers from any
        // leaf it belongs to).
        const o = row * 6
        const hit = slabEnter(ox, oy, oz, ix, iy, iz, g[o] - g[o + 3], g[o + 1] - g[o + 4], g[o + 2] - g[o + 5], g[o] + g[o + 3], g[o + 1] + g[o + 4], g[o + 2] + g[o + 5], 0, Infinity)
        if (hit >= 0) hits.push({ id, t: hit })
      }
      return
    }
    const kids = n.kids
    if (kids !== null) {
      for (const k of kids) {
        if (k !== null) walkRay(k, ox, oy, oz, ix, iy, iz, en, ex)
      }
    }
  }

  // raycast's walk: the running best t prunes every node whose ENTRY is
  // already beyond it (the octree has no child ordering — the pruning is
  // purely the interval; the BVH twin below adds the near-first order).
  function walkRayFirst(n: OctNode, ox: number, oy: number, oz: number, ix: number, iy: number, iz: number, t0: number, t1: number, best: { t: number; id: number }): void {
    if (t0 > best.t) return
    const en = slabEnter(ox, oy, oz, ix, iy, iz, n.b.minx, n.b.miny, n.b.minz, n.b.maxx, n.b.maxy, n.b.maxz, t0, t1)
    if (en < 0 || en > best.t) return
    const ex = slabExit
    if (n.items !== null) {
      const g = rows.geo
      const ids = rows.ids
      const items = n.items
      for (let i = 0; i < items.length; i++) {
        const row = items[i]
        const id = ids[row]
        if (removed.has(id) || moved.has(id)) continue
        const o = row * 6
        const hit = slabEnter(ox, oy, oz, ix, iy, iz, g[o] - g[o + 3], g[o + 1] - g[o + 4], g[o + 2] - g[o + 5], g[o] + g[o + 3], g[o + 1] + g[o + 4], g[o + 2] + g[o + 5], 0, best.t)
        if (hit >= 0 && hit < best.t) {
          best.t = hit
          best.id = id
        }
      }
      return
    }
    const kids = n.kids
    if (kids !== null) {
      for (const k of kids) {
        if (k !== null) walkRayFirst(k, ox, oy, oz, ix, iy, iz, en, ex, best)
      }
    }
  }

  function insertAt(n: OctNode, row: number): void {
    const g = rows.geo
    const o = row * 6
    // THE PATH REFIT: every node on the descent grows to contain the item.
    // A box beyond the root's original extent still lands honestly — the
    // queries prune by NODE bounds, so the bounds must cover the contents
    // (the classic loose-insert trade: bounds only ever grow; a tight tree
    // is a fresh buildOctree away).
    if (g[o] - g[o + 3] < n.b.minx) n.b.minx = g[o] - g[o + 3]
    if (g[o + 1] - g[o + 4] < n.b.miny) n.b.miny = g[o + 1] - g[o + 4]
    if (g[o + 2] - g[o + 5] < n.b.minz) n.b.minz = g[o + 2] - g[o + 5]
    if (g[o] + g[o + 3] > n.b.maxx) n.b.maxx = g[o] + g[o + 3]
    if (g[o + 1] + g[o + 4] > n.b.maxy) n.b.maxy = g[o + 1] + g[o + 4]
    if (g[o + 2] + g[o + 5] > n.b.maxz) n.b.maxz = g[o + 2] + g[o + 5]
    if (n.items !== null) {
      n.items.push(row)
      if (n.items.length > capacity) growLeaf(n)
      return
    }
    const kids = n.kids
    if (kids === null) return
    const hit = octantMask(row, n.b)
    if (hit === 0) return
    for (let k = 0; k < 8; k++) {
      if (hit & (1 << k)) {
        const kid = kids[k]
        if (kid !== null) insertAt(kid, row)
      }
    }
  }

  // ── Task 212 — the override lane's scans: the freshest rows answer
  // with the walks' own per-item predicates (the stamp mask dedups the id
  // exactly like a straddler's several leaves; the lane is small — the
  // hot minority of movers) ──
  function laneFrustum(planes: ArrayLike<number>): void {
    const g = rows.geo
    for (const row of moved.values()) {
      const id = rows.ids[row]
      if (seen[id] === stamp) continue
      seen[id] = stamp
      const o = row * 6
      if (!aabbOutsideFrustum(planes, g[o], g[o + 1], g[o + 2], g[o + 3], g[o + 4], g[o + 5])) out.push(id)
    }
  }
  function laneBox(min: readonly number[], max: readonly number[]): void {
    const g = rows.geo
    for (const row of moved.values()) {
      const id = rows.ids[row]
      if (seen[id] === stamp) continue
      seen[id] = stamp
      const o = row * 6
      if (g[o] + g[o + 3] > min[0] && g[o] - g[o + 3] < max[0]
        && g[o + 1] + g[o + 4] > min[1] && g[o + 1] - g[o + 4] < max[1]
        && g[o + 2] + g[o + 5] > min[2] && g[o + 2] - g[o + 5] < max[2]) out.push(id)
    }
  }
  function laneSphere(cx: number, cy: number, cz: number, radius: number): void {
    const g = rows.geo
    for (const row of moved.values()) {
      const id = rows.ids[row]
      if (seen[id] === stamp) continue
      seen[id] = stamp
      const o = row * 6
      const dx = Math.max(g[o] - g[o + 3] - cx, 0, cx - (g[o] + g[o + 3]))
      const dy = Math.max(g[o + 1] - g[o + 4] - cy, 0, cy - (g[o + 1] + g[o + 4]))
      const dz = Math.max(g[o + 2] - g[o + 5] - cz, 0, cz - (g[o + 2] + g[o + 5]))
      if (dx * dx + dy * dy + dz * dz <= radius * radius) out.push(id)
    }
  }
  function lanePoint(x: number, y: number, z: number): void {
    const g = rows.geo
    for (const row of moved.values()) {
      const id = rows.ids[row]
      if (seen[id] === stamp) continue
      seen[id] = stamp
      const o = row * 6
      if (Math.abs(x - g[o]) <= g[o + 3] && Math.abs(y - g[o + 1]) <= g[o + 4] && Math.abs(z - g[o + 2]) <= g[o + 5]) out.push(id)
    }
  }
  function laneRay(ox: number, oy: number, oz: number, ix: number, iy: number, iz: number): void {
    const g = rows.geo
    for (const row of moved.values()) {
      const id = rows.ids[row]
      if (seen[id] === stamp) continue
      seen[id] = stamp
      const o = row * 6
      const hit = slabEnter(ox, oy, oz, ix, iy, iz, g[o] - g[o + 3], g[o + 1] - g[o + 4], g[o + 2] - g[o + 5], g[o] + g[o + 3], g[o + 1] + g[o + 4], g[o + 2] + g[o + 5], 0, Infinity)
      if (hit >= 0) hits.push({ id, t: hit })
    }
  }
  function laneRayFirst(ox: number, oy: number, oz: number, ix: number, iy: number, iz: number, best: { t: number; id: number }): void {
    const g = rows.geo
    for (const row of moved.values()) {
      const id = rows.ids[row]
      const o = row * 6
      const hit = slabEnter(ox, oy, oz, ix, iy, iz, g[o] - g[o + 3], g[o + 1] - g[o + 4], g[o + 2] - g[o + 5], g[o] + g[o + 3], g[o + 1] + g[o + 4], g[o + 2] + g[o + 5], 0, best.t)
      if (hit >= 0 && hit < best.t) {
        best.t = hit
        best.id = id
      }
    }
  }

  /** Task 212/213 — THE FOLD: rebuild the whole tree over the live set
   *  (rowOf's ids, deduped — the freshest geometry is already in the
   *  columns), then COMPACT the columns to the live rows: the override
   *  lane empties into the tree, the tombstone rows die, the loose
   *  bounds re-tighten to the live union. The tombstone Set's entries
   *  point at nothing anymore — cleared, it can never grow unbounded
   *  across a long edit session. The BVH's own twin; both fold. */
  function rebuild(): void {
    // the live rows in rowOf's insertion order — strictly increasing
    // (rows are allocated in first-touch order), so the in-place
    // compaction below never clobbers a row it still needs
    const live: number[] = []
    for (const row of rowOf.values()) live.push(row)
    const geo = rows.geo
    const ids = rows.ids
    for (let k = 0; k < live.length; k++) {
      const src = live[k]
      if (src !== k) {
        const so = src * 6, to = k * 6
        for (let f = 0; f < 6; f++) geo[to + f] = geo[so + f]
        ids[k] = ids[src]
      }
      rowOf.set(ids[k], k)
    }
    rows.n = live.length
    removed.clear()
    nodes = 0
    leaves = 0
    depth = 0
    moved.clear()
    const fresh: number[] = new Array(live.length)
    for (let i = 0; i < live.length; i++) fresh[i] = i
    root = buildNode(fresh, unionRows(rows, fresh), 1)
  }

  const index: SpatialIndex = {
    kind: 'octree',
    count,
    get live(): number {
      // Task 212 — rowOf IS the live set (the old manual counter lied on
      // the remove→re-insert round-trip: remove dropped it, the tombstone
      // re-insert left it — one live box undercounted forever)
      return rowOf.size
    },
    stats: {
      get nodes() { return nodes },
      get leaves() { return leaves },
      get depth() { return depth },
      get lane() { return moved.size },
      items: count,
    },
    get planeTests(): number {
      return planeTests
    },
    queryFrustum(planes: ArrayLike<number>): Uint32Array {
      beginQuery()
      planeTests = 0
      walkFrustum(root, planes, 0b111111)
      laneFrustum(planes)
      return Uint32Array.from(out)
    },
    queryBox(min, max) {
      beginQuery()
      walkBox(root, min as readonly number[], max as readonly number[])
      laneBox(min as readonly number[], max as readonly number[])
      return Uint32Array.from(out)
    },
    querySphere(cx, cy, cz, radius) {
      beginQuery()
      walkSphere(root, cx, cy, cz, radius)
      laneSphere(cx, cy, cz, radius)
      return Uint32Array.from(out)
    },
    queryPoint(x, y, z) {
      beginQuery()
      walkPoint(root, x, y, z)
      lanePoint(x, y, z)
      return Uint32Array.from(out)
    },
    queryRay(ox, oy, oz, dx, dy, dz) {
      beginQuery()
      hits.length = 0
      const ix = dx !== 0 ? 1 / dx : Infinity
      const iy = dy !== 0 ? 1 / dy : Infinity
      const iz = dz !== 0 ? 1 / dz : Infinity
      walkRay(root, ox, oy, oz, ix, iy, iz, 0, Infinity)
      laneRay(ox, oy, oz, ix, iy, iz)
      hits.sort((a, b) => a.t - b.t)
      return hits.slice()
    },
    raycast(ox, oy, oz, dx, dy, dz) {
      const ix = dx !== 0 ? 1 / dx : Infinity
      const iy = dy !== 0 ? 1 / dy : Infinity
      const iz = dz !== 0 ? 1 / dz : Infinity
      const best = { t: Infinity, id: -1 }
      walkRayFirst(root, ox, oy, oz, ix, iy, iz, 0, Infinity, best)
      laneRayFirst(ox, oy, oz, ix, iy, iz, best)
      return best.id >= 0 ? { id: best.id, t: best.t } : null
    },
    insert(box: SpatialBox): void {
      this.insertBox(box.id, box.cx, box.cy, box.cz, box.hx, box.hy, box.hz)
    },
    insertBox(id, cx, cy, cz, hx, hy, hz): void {
      assertKitId(id)
      maxId = Math.max(maxId, id)
      ensureCapacity(id)
      let row = rowOf.get(id)
      if (row === undefined) row = allocRow(rows, id)
      const known = removed.delete(id) || rowOf.has(id)
      const o = row * 6
      rows.geo[o] = cx
      rows.geo[o + 1] = cy
      rows.geo[o + 2] = cz
      rows.geo[o + 3] = hx
      rows.geo[o + 4] = hy
      rows.geo[o + 5] = hz
      rowOf.set(id, row)
      if (known) {
        // Task 212 — a re-inserted id (tombstoned OR live) rides THE
        // OVERRIDE LANE: the stale placement in the leaves is skipped by
        // id, the lane answers for the freshest geometry. The old
        // tombstone path dropped a SECOND copy into the leaves (the stamp
        // mask deduped the ANSWERS — the tree still grew); the old live
        // path churned the same way update() used to. The live count
        // rides rowOf: a tombstone's re-insert counts back what its
        // remove dropped, a live re-insert changes nothing
        moved.set(id, row)
        return
      }
      insertAt(root, row)
    },
    remove(id: number): void {
      if (removed.has(id)) return
      removed.add(id)
      rowOf.delete(id)
      moved.delete(id)
    },
    update(box: SpatialBox): void {
      this.updateBox(box.id, box.cx, box.cy, box.cz, box.hx, box.hy, box.hz)
    },
    updateBox(id, cx, cy, cz, hx, hy, hz): void {
      const row = rowOf.get(id)
      if (row !== undefined) {
        // Task 212/213 — the dynamic twin's honest shape: the FRESHEST
        // bounds into the columns + the override lane, O(1), nothing
        // grows (the old remove+insert left every intermediate object in
        // the leaves forever — the leak the field report caught)
        const o = row * 6
        rows.geo[o] = cx
        rows.geo[o + 1] = cy
        rows.geo[o + 2] = cz
        rows.geo[o + 3] = hx
        rows.geo[o + 4] = hy
        rows.geo[o + 5] = hz
        moved.set(id, row)
        return
      }
      this.insertBox(id, cx, cy, cz, hx, hy, hz)
    },
    rebuild,
  }
  return index
}

// ─── THE BVH ──────────────────────────────────────────────────────────────

interface BvhNode {
  readonly b: NodeBounds
  /** the layout slice [from, to) this node covers — the items array IS
   *  the tree's contiguous memory (leaves are ranges, not lists).
   *  Task 213: the layout holds ROW INDICES into the kit's columns. */
  readonly from: number
  readonly to: number
  left: BvhNode | null
  right: BvhNode | null
}

/** Builds the BVH over the boxes. The split axis is the node's LONGEST
 *  bound (the SAH-lite shape heuristic), the split point the count median
 *  of that axis's centers (balanced by construction); leaf capacity 8.
 *  The layout is the kit's own row order — the caller's input is never
 *  touched, the query answers ride the ids.
 *
 *  Task 201 — THE HONEST DYNAMICS: remove() tombstones (the contiguous
 *  layout cannot be spliced cheaply); insert() appends to an OVERFLOW
 *  list the queries scan linearly (the amortized-rebuild pattern — the
 *  fresh minority costs a sweep, the settled majority keeps its
 *  near-log walk); rebuild() folds the overflow back into a fresh tree.
 *  Task 212 — THE OVERRIDE LANE: update() on a live id never touches the
 *  layout (the old remove+insert flooded the overflow with every
 *  intermediate object and the fold baked them all in — the leak behind
 *  the field report); the freshest geometry lands in the columns and a
 *  small id→row lane the queries read after the overflow, and rebuild()
 *  folds the LIVE SET. */
export function buildBVH(items: readonly SpatialBox[], options?: { capacity?: number; planeMask?: boolean }): SpatialIndex {
  // the compat front door: one row per input item (duplicate ids dedup
  // through the live-set authority below — the layout builds over the
  // LAST copy per id, exactly the old byId.values() behavior)
  const rows = kitRows(items.length)
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    assertKitId(it.id)
    const row = allocRow(rows, it.id)
    const o = row * 6
    rows.geo[o] = it.cx
    rows.geo[o + 1] = it.cy
    rows.geo[o + 2] = it.cz
    rows.geo[o + 3] = it.hx
    rows.geo[o + 4] = it.hy
    rows.geo[o + 5] = it.hz
  }
  return bvhFromRows(rows, items.length, options)
}

/** Task 213 — the kit's OWN front door (the octree twin's contract): the
 *  strided RecordView, the record's id IS its row, f32 words land in the
 *  f64 columns exactly. */
export function buildBVHRecords(view: RecordView, options?: { capacity?: number; planeMask?: boolean }): SpatialIndex {
  const rows = kitRows(view.count)
  const w = view.words
  const cOff = view.base + view.center
  const hOff = view.base + view.half
  const stride = view.stride
  const geo = rows.geo
  for (let i = 0; i < view.count; i++) {
    const co = cOff + i * stride
    const ho = hOff + i * stride
    rows.ids[i] = i
    const o = i * 6
    geo[o] = w[co]
    geo[o + 1] = w[co + 1]
    geo[o + 2] = w[co + 2]
    geo[o + 3] = w[ho]
    geo[o + 4] = w[ho + 1]
    geo[o + 5] = w[ho + 2]
  }
  rows.n = view.count
  return bvhFromRows(rows, view.count, options)
}

function bvhFromRows(rows: KitRows, count: number, options?: { capacity?: number; planeMask?: boolean }): SpatialIndex {
  const capacity = Math.max(1, options?.capacity ?? 8)
  const planeMask = options?.planeMask ?? true

  // the mutable build state — rebuild() re-runs the builder over the live set
  let layout: number[] = []
  let overflow: number[] = []
  const removed = new Set<number>()
  // ── Task 212 — THE OVERRIDE LANE + THE LIVE-SET AUTHORITY (the octree
  // twin's comment above): rowOf = the freshest row per live id; moved =
  // the live ids the LANE owns (their layout/overflow PLACEMENT is stale
  // — the walks skip them by id, the lane answers; the GEOMETRY in the
  // columns is always the freshest write). The old update() =
  // remove+insert pushed EVERY intermediate object into the overflow and
  // rebuild() folded them all back in — the layout grew 48 items per
  // frame, forever (measured: bvh.live lied +2880 after one second). The
  // lane is O(1) and bounded; rebuild() folds rowOf.
  const rowOf = new Map<number, number>()
  for (let i = 0; i < count; i++) rowOf.set(rows.ids[i], i)
  const moved = new Map<number, number>()
  let nodes = 0
  let leaves = 0
  let depth = 0
  let root: BvhNode | null = null

  function buildNode(from: number, to: number, level: number): BvhNode {
    nodes++
    if (level > depth) depth = level
    const g = rows.geo
    let minx = Infinity, miny = Infinity, minz = Infinity
    let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity
    for (let i = from; i < to; i++) {
      const o = layout[i] * 6
      if (g[o] - g[o + 3] < minx) minx = g[o] - g[o + 3]
      if (g[o + 1] - g[o + 4] < miny) miny = g[o + 1] - g[o + 4]
      if (g[o + 2] - g[o + 5] < minz) minz = g[o + 2] - g[o + 5]
      if (g[o] + g[o + 3] > maxx) maxx = g[o] + g[o + 3]
      if (g[o + 1] + g[o + 4] > maxy) maxy = g[o + 1] + g[o + 4]
      if (g[o + 2] + g[o + 5] > maxz) maxz = g[o + 2] + g[o + 5]
    }
    const b: NodeBounds = { minx, miny, minz, maxx, maxy, maxz }
    if (to - from <= capacity) {
      leaves++
      return { b, from, to, left: null, right: null }
    }
    const ex = b.maxx - b.minx, ey = b.maxy - b.miny, ez = b.maxz - b.minz
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2
    // the median split: sort the slice by the axis's centers, write back.
    // Task 213: the sort rides ROW INDICES reading the center column —
    // the comparator values are centerAlong()'s own (geo[row*6+axis]),
    // the stable sort keeps the equal-key order, so the permutation is
    // the object path's exactly
    const slice = layout.slice(from, to)
    const geo = rows.geo
    slice.sort((a, b2) => geo[a * 6 + axis] - geo[b2 * 6 + axis])
    for (let k = 0; k < slice.length; k++) layout[from + k] = slice[k]
    const mid = from + ((to - from) >> 1)
    return { b, from, to, left: buildNode(from, mid, level + 1), right: buildNode(mid, to, level + 1) }
  }

  function rebuild(): void {
    // Task 212/213 — THE FOLD over the live set: rowOf holds one row per
    // live id, so the rebuilt layout is deduped and bounded — the old
    // fold concatenated items + the whole overflow, keeping every stale
    // intermediate object an update() ever pushed. The columns compact
    // to the live rows first (the strictly-increasing first-touch order
    // makes the in-place sweep safe), then the fresh layout is the
    // compacted identity. The fresh layout holds ONLY live ids, so the
    // tombstone Set's entries point at nothing — cleared, it can never
    // grow unbounded across a long edit session
    const live: number[] = []
    for (const row of rowOf.values()) live.push(row)
    const geo = rows.geo
    const ids = rows.ids
    for (let k = 0; k < live.length; k++) {
      const src = live[k]
      if (src !== k) {
        const so = src * 6, to = k * 6
        for (let f = 0; f < 6; f++) geo[to + f] = geo[so + f]
        ids[k] = ids[src]
      }
      rowOf.set(ids[k], k)
    }
    rows.n = live.length
    layout = []
    for (let i = 0; i < live.length; i++) layout.push(i)
    overflow = []
    removed.clear()
    moved.clear()
    nodes = 0
    leaves = 0
    depth = 0
    root = layout.length === 0 ? null : buildNode(0, layout.length, 1)
  }

  rebuild()

  const out: number[] = []
  const hits: RayHit[] = []

  // ── Task 205 — the instrumented masked walk (the BVH twin — items live
  // INSIDE the node's tight bounds, so a plane proven inside for the node
  // is proven for every item in it: the leaf test inherits the mask too;
  // the octree's straddlers keep the full six) ──
  let planeTests = 0
  function maskedPlanes(
    planes: ArrayLike<number>,
    cx: number, cy: number, cz: number,
    hx: number, hy: number, hz: number,
    mask: number, full: boolean,
  ): number {
    let m = full ? 0b111111 : mask
    for (let i = 0; i < 6; i++) {
      const bit = 1 << i
      if ((m & bit) === 0) continue
      planeTests++
      const o = i * 4
      const ax = planes[o], ay = planes[o + 1], az = planes[o + 2]
      const reach = Math.abs(ax) * hx + Math.abs(ay) * hy + Math.abs(az) * hz
      const d = ax * cx + ay * cy + az * cz + planes[o + 3]
      if (d < -reach) return FRUSTUM_PRUNED
      if (d >= reach) m &= ~bit
    }
    return m
  }
  /** The item's outside test restricted to the still-intersected planes
   *  (the legacy leg re-arms all six — the A/B counter stays honest). */
  function itemOutsideMasked(
    planes: ArrayLike<number>,
    cx: number, cy: number, cz: number,
    hx: number, hy: number, hz: number,
    mask: number,
  ): boolean {
    const m = planeMask ? mask : 0b111111
    for (let i = 0; i < 6; i++) {
      const bit = 1 << i
      if ((m & bit) === 0) continue
      planeTests++
      const o = i * 4
      const ax = planes[o], ay = planes[o + 1], az = planes[o + 2]
      if (ax * cx + ay * cy + az * cz + planes[o + 3]
        < -(Math.abs(ax) * hx + Math.abs(ay) * hy + Math.abs(az) * hz)) return true
    }
    return false
  }

  function walkFrustum(n: BvhNode, planes: ArrayLike<number>, mask: number): void {
    if (mask !== 0) {
      const cx = (n.b.minx + n.b.maxx) * 0.5
      const cy = (n.b.miny + n.b.maxy) * 0.5
      const cz = (n.b.minz + n.b.maxz) * 0.5
      const hx = (n.b.maxx - n.b.minx) * 0.5
      const hy = (n.b.maxy - n.b.miny) * 0.5
      const hz = (n.b.maxz - n.b.minz) * 0.5
      const r = maskedPlanes(planes, cx, cy, cz, hx, hy, hz, mask, !planeMask)
      if (r === FRUSTUM_PRUNED) return
      mask = r
    }
    const l = n.left
    const r = n.right
    if (l === null || r === null) {
      const g = rows.geo
      const ids = rows.ids
      for (let i = n.from; i < n.to; i++) {
        const row = layout[i]
        const id = ids[row]
        if (removed.has(id) || moved.has(id)) continue
        const o = row * 6
        if (mask === 0 || !itemOutsideMasked(planes, g[o], g[o + 1], g[o + 2], g[o + 3], g[o + 4], g[o + 5], mask)) {
          out.push(id)
        }
      }
      return
    }
    walkFrustum(l, planes, mask)
    walkFrustum(r, planes, mask)
  }

  function walkBox(n: BvhNode, min: readonly number[], max: readonly number[]): void {
    if (!boundsOverlap(n.b, min, max)) return
    const l = n.left
    const r = n.right
    if (l === null || r === null) {
      const g = rows.geo
      const ids = rows.ids
      for (let i = n.from; i < n.to; i++) {
        const row = layout[i]
        const id = ids[row]
        if (removed.has(id) || moved.has(id)) continue
        const o = row * 6
        if (g[o] + g[o + 3] > min[0] && g[o] - g[o + 3] < max[0]
          && g[o + 1] + g[o + 4] > min[1] && g[o + 1] - g[o + 4] < max[1]
          && g[o + 2] + g[o + 5] > min[2] && g[o + 2] - g[o + 5] < max[2]) {
          out.push(id)
        }
      }
      return
    }
    walkBox(l, min, max)
    walkBox(r, min, max)
  }

  function walkSphere(n: BvhNode, cx: number, cy: number, cz: number, radius: number): void {
    if (!boxReachesSphere(n.b, cx, cy, cz, radius)) return
    const l = n.left
    const r = n.right
    if (l === null || r === null) {
      const g = rows.geo
      const ids = rows.ids
      for (let i = n.from; i < n.to; i++) {
        const row = layout[i]
        const id = ids[row]
        if (removed.has(id) || moved.has(id)) continue
        // Task 213: boxReachesSphere's arithmetic inlined on the row —
        // the old path allocated a NodeBounds literal per item
        const o = row * 6
        const dx = Math.max(g[o] - g[o + 3] - cx, 0, cx - (g[o] + g[o + 3]))
        const dy = Math.max(g[o + 1] - g[o + 4] - cy, 0, cy - (g[o + 1] + g[o + 4]))
        const dz = Math.max(g[o + 2] - g[o + 5] - cz, 0, cz - (g[o + 2] + g[o + 5]))
        if (dx * dx + dy * dy + dz * dz <= radius * radius) out.push(id)
      }
      return
    }
    walkSphere(l, cx, cy, cz, radius)
    walkSphere(r, cx, cy, cz, radius)
  }

  function walkPoint(n: BvhNode, x: number, y: number, z: number): void {
    if (x < n.b.minx || x > n.b.maxx || y < n.b.miny || y > n.b.maxy || z < n.b.minz || z > n.b.maxz) return
    const l = n.left
    const r = n.right
    if (l === null || r === null) {
      const g = rows.geo
      const ids = rows.ids
      for (let i = n.from; i < n.to; i++) {
        const row = layout[i]
        const id = ids[row]
        if (removed.has(id) || moved.has(id)) continue
        const o = row * 6
        if (Math.abs(x - g[o]) <= g[o + 3] && Math.abs(y - g[o + 1]) <= g[o + 4] && Math.abs(z - g[o + 2]) <= g[o + 5]) {
          out.push(id)
        }
      }
      return
    }
    walkPoint(l, x, y, z)
    walkPoint(r, x, y, z)
  }

  function walkRay(n: BvhNode, ox: number, oy: number, oz: number, ix: number, iy: number, iz: number, t0: number, t1: number): void {
    const en = slabEnter(ox, oy, oz, ix, iy, iz, n.b.minx, n.b.miny, n.b.minz, n.b.maxx, n.b.maxy, n.b.maxz, t0, t1)
    if (en < 0) return
    const ex = slabExit
    const l = n.left
    const r = n.right
    if (l === null || r === null) {
      const g = rows.geo
      const ids = rows.ids
      for (let i = n.from; i < n.to; i++) {
        const row = layout[i]
        const id = ids[row]
        if (removed.has(id) || moved.has(id)) continue
        const o = row * 6
        const hit = slabEnter(ox, oy, oz, ix, iy, iz, g[o] - g[o + 3], g[o + 1] - g[o + 4], g[o + 2] - g[o + 5], g[o] + g[o + 3], g[o + 1] + g[o + 4], g[o + 2] + g[o + 5], 0, t1)
        if (hit >= 0) hits.push({ id, t: hit })
      }
      return
    }
    // THE ORDERED DESCENT: the near child first — its hits land before the
    // far child's walk can prune anything (raycast()'s best-t twin below).
    // Task 205: the exits are captured before the second slab call (the
    // scratch is module-wide — one writer at a time).
    const cl = slabEnter(ox, oy, oz, ix, iy, iz, l.b.minx, l.b.miny, l.b.minz, l.b.maxx, l.b.maxy, l.b.maxz, en, ex)
    const clEx = cl >= 0 ? slabExit : 0
    const cr = slabEnter(ox, oy, oz, ix, iy, iz, r.b.minx, r.b.miny, r.b.minz, r.b.maxx, r.b.maxy, r.b.maxz, en, ex)
    const crEx = cr >= 0 ? slabExit : 0
    if (cl >= 0 && (cr < 0 || cl <= cr)) {
      walkRay(l, ox, oy, oz, ix, iy, iz, cl, clEx)
      if (cr >= 0) walkRay(r, ox, oy, oz, ix, iy, iz, cr, crEx)
    } else if (cr >= 0) {
      walkRay(r, ox, oy, oz, ix, iy, iz, cr, crEx)
      if (cl >= 0) walkRay(l, ox, oy, oz, ix, iy, iz, cl, clEx)
    }
  }

  function walkRayFirst(n: BvhNode, ox: number, oy: number, oz: number, ix: number, iy: number, iz: number, t0: number, t1: number, best: { t: number; id: number }): void {
    if (t0 > best.t) return
    const en = slabEnter(ox, oy, oz, ix, iy, iz, n.b.minx, n.b.miny, n.b.minz, n.b.maxx, n.b.maxy, n.b.maxz, t0, t1)
    if (en < 0 || en > best.t) return
    const ex = slabExit
    const l = n.left
    const r = n.right
    if (l === null || r === null) {
      const g = rows.geo
      const ids = rows.ids
      for (let i = n.from; i < n.to; i++) {
        const row = layout[i]
        const id = ids[row]
        if (removed.has(id) || moved.has(id)) continue
        const o = row * 6
        const hit = slabEnter(ox, oy, oz, ix, iy, iz, g[o] - g[o + 3], g[o + 1] - g[o + 4], g[o + 2] - g[o + 5], g[o] + g[o + 3], g[o + 1] + g[o + 4], g[o + 2] + g[o + 5], 0, best.t)
        if (hit >= 0 && hit < best.t) {
          best.t = hit
          best.id = id
        }
      }
      return
    }
    // near child first, the far child pruned by whatever the near walk found
    // (the exits captured before the second slab call — the scratch rule)
    const cl = slabEnter(ox, oy, oz, ix, iy, iz, l.b.minx, l.b.miny, l.b.minz, l.b.maxx, l.b.maxy, l.b.maxz, en, ex)
    const clEx = cl >= 0 ? slabExit : 0
    const cr = slabEnter(ox, oy, oz, ix, iy, iz, r.b.minx, r.b.miny, r.b.minz, r.b.maxx, r.b.maxy, r.b.maxz, en, ex)
    const crEx = cr >= 0 ? slabExit : 0
    const nearIsLeft = cl >= 0 && (cr < 0 || cl <= cr)
    const near = nearIsLeft ? l : r
    const far = nearIsLeft ? r : l
    const cn = nearIsLeft ? cl : cr
    const cf = nearIsLeft ? cr : cl
    const cnEx = nearIsLeft ? clEx : crEx
    const cfEx = nearIsLeft ? crEx : clEx
    if (cn >= 0) walkRayFirst(near, ox, oy, oz, ix, iy, iz, cn, cnEx, best)
    if (cf >= 0 && cf < best.t) walkRayFirst(far, ox, oy, oz, ix, iy, iz, cf, cfEx, best)
  }

  const index: SpatialIndex = {
    kind: 'bvh',
    count,
    get live(): number {
      // Task 212 — rowOf IS the live set (the old arithmetic counted the
      // overflow's stale intermediates: 48 drones × 60fps lied +2880/s)
      return rowOf.size
    },
    stats: { get nodes() { return nodes }, get leaves() { return leaves }, get depth() { return depth }, get lane() { return moved.size }, items: count },
    get planeTests(): number {
      return planeTests
    },
    queryFrustum(planes: ArrayLike<number>): Uint32Array {
      out.length = 0
      planeTests = 0
      if (root !== null) walkFrustum(root, planes, 0b111111)
      scanOverflowFrustum(planes)
      scanLaneFrustum(planes)
      return Uint32Array.from(out)
    },
    queryBox(min, max) {
      out.length = 0
      if (root !== null) walkBox(root, min as readonly number[], max as readonly number[])
      const g = rows.geo
      const ids = rows.ids
      for (const row of overflow) {
        const id = ids[row]
        if (removed.has(id) || moved.has(id)) continue
        const o = row * 6
        if (g[o] + g[o + 3] > min[0] && g[o] - g[o + 3] < max[0]
          && g[o + 1] + g[o + 4] > min[1] && g[o + 1] - g[o + 4] < max[1]
          && g[o + 2] + g[o + 5] > min[2] && g[o + 2] - g[o + 5] < max[2]) {
          out.push(id)
        }
      }
      for (const row of moved.values()) {
        const id = rows.ids[row]
        const o = row * 6
        if (g[o] + g[o + 3] > min[0] && g[o] - g[o + 3] < max[0]
          && g[o + 1] + g[o + 4] > min[1] && g[o + 1] - g[o + 4] < max[1]
          && g[o + 2] + g[o + 5] > min[2] && g[o + 2] - g[o + 5] < max[2]) {
          out.push(id)
        }
      }
      return Uint32Array.from(out)
    },
    querySphere(cx, cy, cz, radius) {
      out.length = 0
      if (root !== null) walkSphere(root, cx, cy, cz, radius)
      const g = rows.geo
      const ids = rows.ids
      for (const row of overflow) {
        const id = ids[row]
        if (removed.has(id) || moved.has(id)) continue
        const o = row * 6
        const dx = Math.max(g[o] - g[o + 3] - cx, 0, cx - (g[o] + g[o + 3]))
        const dy = Math.max(g[o + 1] - g[o + 4] - cy, 0, cy - (g[o + 1] + g[o + 4]))
        const dz = Math.max(g[o + 2] - g[o + 5] - cz, 0, cz - (g[o + 2] + g[o + 5]))
        if (dx * dx + dy * dy + dz * dz <= radius * radius) out.push(id)
      }
      for (const row of moved.values()) {
        const id = rows.ids[row]
        const o = row * 6
        const dx = Math.max(g[o] - g[o + 3] - cx, 0, cx - (g[o] + g[o + 3]))
        const dy = Math.max(g[o + 1] - g[o + 4] - cy, 0, cy - (g[o + 1] + g[o + 4]))
        const dz = Math.max(g[o + 2] - g[o + 5] - cz, 0, cz - (g[o + 2] + g[o + 5]))
        if (dx * dx + dy * dy + dz * dz <= radius * radius) out.push(id)
      }
      return Uint32Array.from(out)
    },
    queryPoint(x, y, z) {
      out.length = 0
      if (root !== null) walkPoint(root, x, y, z)
      const g = rows.geo
      const ids = rows.ids
      for (const row of overflow) {
        const id = ids[row]
        if (removed.has(id) || moved.has(id)) continue
        const o = row * 6
        if (Math.abs(x - g[o]) <= g[o + 3] && Math.abs(y - g[o + 1]) <= g[o + 4] && Math.abs(z - g[o + 2]) <= g[o + 5]) {
          out.push(id)
        }
      }
      for (const row of moved.values()) {
        const id = rows.ids[row]
        const o = row * 6
        if (Math.abs(x - g[o]) <= g[o + 3] && Math.abs(y - g[o + 1]) <= g[o + 4] && Math.abs(z - g[o + 2]) <= g[o + 5]) {
          out.push(id)
        }
      }
      return Uint32Array.from(out)
    },
    queryRay(ox, oy, oz, dx, dy, dz) {
      out.length = 0
      hits.length = 0
      const ix = dx !== 0 ? 1 / dx : Infinity
      const iy = dy !== 0 ? 1 / dy : Infinity
      const iz = dz !== 0 ? 1 / dz : Infinity
      if (root !== null) walkRay(root, ox, oy, oz, ix, iy, iz, 0, Infinity)
      const g = rows.geo
      const ids = rows.ids
      for (const row of overflow) {
        const id = ids[row]
        if (removed.has(id) || moved.has(id)) continue
        const o = row * 6
        const hit = slabEnter(ox, oy, oz, ix, iy, iz, g[o] - g[o + 3], g[o + 1] - g[o + 4], g[o + 2] - g[o + 5], g[o] + g[o + 3], g[o + 1] + g[o + 4], g[o + 2] + g[o + 5], 0, Infinity)
        if (hit >= 0) hits.push({ id, t: hit })
      }
      for (const row of moved.values()) {
        const id = rows.ids[row]
        const o = row * 6
        const hit = slabEnter(ox, oy, oz, ix, iy, iz, g[o] - g[o + 3], g[o + 1] - g[o + 4], g[o + 2] - g[o + 5], g[o] + g[o + 3], g[o + 1] + g[o + 4], g[o + 2] + g[o + 5], 0, Infinity)
        if (hit >= 0) hits.push({ id, t: hit })
      }
      hits.sort((a, b) => a.t - b.t)
      return hits.slice()
    },
    raycast(ox, oy, oz, dx, dy, dz) {
      const ix = dx !== 0 ? 1 / dx : Infinity
      const iy = dy !== 0 ? 1 / dy : Infinity
      const iz = dz !== 0 ? 1 / dz : Infinity
      const best = { t: Infinity, id: -1 }
      if (root !== null) walkRayFirst(root, ox, oy, oz, ix, iy, iz, 0, Infinity, best)
      const g = rows.geo
      const ids = rows.ids
      for (const row of overflow) {
        const id = ids[row]
        if (removed.has(id) || moved.has(id)) continue
        const o = row * 6
        const hit = slabEnter(ox, oy, oz, ix, iy, iz, g[o] - g[o + 3], g[o + 1] - g[o + 4], g[o + 2] - g[o + 5], g[o] + g[o + 3], g[o + 1] + g[o + 4], g[o + 2] + g[o + 5], 0, best.t)
        if (hit >= 0 && hit < best.t) {
          best.t = hit
          best.id = id
        }
      }
      for (const row of moved.values()) {
        const id = rows.ids[row]
        const o = row * 6
        const hit = slabEnter(ox, oy, oz, ix, iy, iz, g[o] - g[o + 3], g[o + 1] - g[o + 4], g[o + 2] - g[o + 5], g[o] + g[o + 3], g[o + 1] + g[o + 4], g[o + 2] + g[o + 5], 0, best.t)
        if (hit >= 0 && hit < best.t) {
          best.t = hit
          best.id = id
        }
      }
      return best.id >= 0 ? { id: best.id, t: best.t } : null
    },
    insert(box: SpatialBox): void {
      this.insertBox(box.id, box.cx, box.cy, box.cz, box.hx, box.hy, box.hz)
    },
    insertBox(id, cx, cy, cz, hx, hy, hz): void {
      assertKitId(id)
      let row = rowOf.get(id)
      if (row === undefined) row = allocRow(rows, id)
      const known = removed.delete(id) || rowOf.has(id)
      const o = row * 6
      rows.geo[o] = cx
      rows.geo[o + 1] = cy
      rows.geo[o + 2] = cz
      rows.geo[o + 3] = hx
      rows.geo[o + 4] = hy
      rows.geo[o + 5] = hz
      rowOf.set(id, row)
      if (known) {
        // Task 212 — a re-inserted id (tombstoned OR live) rides THE
        // OVERRIDE LANE: the stale layout/overflow placement is skipped
        // by id, the lane answers for the freshest geometry. The old
        // tombstone path pushed a SECOND copy into the overflow while the
        // tombstone's clearing revived the stale one — DUPLICATE answers
        // (the BVH has no stamp mask; the latent bug the lane kills);
        // the old live path churned the overflow the way update() used
        // to. The live count rides rowOf: a tombstone's re-insert counts
        // back what its remove dropped, a live re-insert changes nothing
        moved.set(id, row)
        return
      }
      overflow.push(row)
    },
    remove(id: number): void {
      removed.add(id)
      rowOf.delete(id)
      moved.delete(id)
    },
    update(box: SpatialBox): void {
      this.updateBox(box.id, box.cx, box.cy, box.cz, box.hx, box.hy, box.hz)
    },
    updateBox(id, cx, cy, cz, hx, hy, hz): void {
      const row = rowOf.get(id)
      if (row !== undefined) {
        // Task 212/213 — the freshest bounds into the columns + the lane,
        // O(1) (the old remove+insert churned the overflow with every
        // intermediate)
        const o = row * 6
        rows.geo[o] = cx
        rows.geo[o + 1] = cy
        rows.geo[o + 2] = cz
        rows.geo[o + 3] = hx
        rows.geo[o + 4] = hy
        rows.geo[o + 5] = hz
        moved.set(id, row)
        return
      }
      this.insertBox(id, cx, cy, cz, hx, hy, hz)
    },
    rebuild,
  }

  function scanLaneFrustum(planes: ArrayLike<number>): void {
    const g = rows.geo
    for (const row of moved.values()) {
      const id = rows.ids[row]
      const o = row * 6
      if (!aabbOutsideFrustum(planes, g[o], g[o + 1], g[o + 2], g[o + 3], g[o + 4], g[o + 5])) out.push(id)
    }
  }
  function scanOverflowFrustum(planes: ArrayLike<number>): void {
    const g = rows.geo
    const ids = rows.ids
    for (const row of overflow) {
      const id = ids[row]
      if (removed.has(id) || moved.has(id)) continue
      const o = row * 6
      if (!aabbOutsideFrustum(planes, g[o], g[o + 1], g[o + 2], g[o + 3], g[o + 4], g[o + 5])) out.push(id)
    }
  }

  return index
}

export { frustumPlanes }


