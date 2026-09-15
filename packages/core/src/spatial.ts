/**
 * spatial.ts — the clean hierarchical cull structures (Task 200), grown into
 * the SCENE-GRADE spatial surface (Task 201: the user's «октодеревья и bvh
 * должны быть удобными — хиттесты, лучи, интеграция» ask).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY HERE: the Hi-Z demo's GPU kernel tests every record's AABB against
 * the frustum on the GPU — one dispatch, zero CPU cost, the right shape
 * for a static instanced scene. But the moment a scenario needs the SAME
 * question answered CPU-side — which records survive a moving frustum
 * (a worker culling before it ships a draw), which occluders rank by
 * screen area, what a selection marquee touches — it needs a SPATIAL
 * INDEX, not a linear sweep. Two canonical answers, both pure, both here,
 * both driving the SAME predicate as the GPU kernel (the AABB–plane
 * p-vertex/n-vertex test — «an AABB is fully outside a plane iff its
 * n-vertex is» is exactly the kernel's «all 8 corners outside the same
 * plane», evaluated on the box instead of 8 points):
 *
 *   · OCTREE — the uniform spatial subdivision: the split point is the
 *     cell's center, items straddling a split go to EVERY child they
 *     touch, queries deduplicate. THE DYNAMIC TWIN: insert/remove/update
 *     walk the same center rule (a full leaf splits on the spot, the
 *     progress guard keeps co-located data from recursing forever).
 *   · BVH — the binary hierarchy: the split axis follows the node's
 *     LONGEST bound (the SAH-lite heuristic), the split point is the
 *     count median of that axis's centers — balanced, tight bounds,
 *     items REORDERED into the tree's own contiguous layout. THE
 *     RAY-CASTER'S FAVORITE: the ordered descent (near child first,
 *     pruned by the running best t) makes raycast() a near-log walk.
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
 *
 * Both structures are built over the same SpatialBox list and answer the
 * same queries; the demo's validation gate runs both and requires
 * identical survivor SETS — two independent traversals of two different
 * hierarchy shapes agreeing is the strongest cheap proof of «clean».
 *
 * DOM-free, GPU-free — plain Float64 arithmetic. The sandwich against the
 * GPU's fp32 kernel lives at the CALLER with a documented tolerance (the
 * kernel's projection rounds differently near the frustum planes).
 * ══════════════════════════════════════════════════════════════════════════
 */

import { frustumPlanes, FRUSTUM_PLANE_COUNT } from './frustum.ts'

/** One indexed AABB — the spatial item contract (id + center + half). */
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
  /** Tombstones the id (queries skip it; the tree shape stays). */
  remove(id: number): void
  /** Moves a box — THE OVERRIDE LANE (Task 212): a live id's freshest
   *  bounds land in a small id→box map the queries read AFTER the tree,
   *  while the tree's own copy is skipped by id — O(1) per update, no
   *  stale growth, no duplicate answers. A dead id rides insert(). */
  update(box: SpatialBox): void
  /** THE FOLD: rebuilds the whole tree over the live set's FRESHEST
   *  objects (the override lane empties back into the tree, the loose
   *  bounds re-tighten). Both structures fold. */
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

/** The exact union of the items' AABBs (a node's tight bounds). */
function unionOf(items: readonly SpatialBox[]): NodeBounds {
  let minx = Infinity, miny = Infinity, minz = Infinity
  let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity
  for (const b of items) {
    if (b.cx - b.hx < minx) minx = b.cx - b.hx
    if (b.cy - b.hy < miny) miny = b.cy - b.hy
    if (b.cz - b.hz < minz) minz = b.cz - b.hz
    if (b.cx + b.hx > maxx) maxx = b.cx + b.hx
    if (b.cy + b.hy > maxy) maxy = b.cy + b.hy
    if (b.cz + b.hz > maxz) maxz = b.cz + b.hz
  }
  return { minx, miny, minz, maxx, maxy, maxz }
}

/** The box–box overlap test (touching boxes do NOT overlap — the
 *  query contract, shared by both structures). */
function boundsOverlap(b: NodeBounds, min: readonly number[], max: readonly number[]): boolean {
  return b.minx < max[0] && b.maxx > min[0]
    && b.miny < max[1] && b.maxy > min[1]
    && b.minz < max[2] && b.maxz > min[2]
}

/** The box–sphere overlap: the clamped-center distance (the classic
 *  closest-point form — no sqrt until the final compare). */
function boxReachesSphere(
  b: NodeBounds,
  cx: number, cy: number, cz: number, radius: number,
): boolean {
  const dx = Math.max(b.minx - cx, 0, cx - b.maxx)
  const dy = Math.max(b.miny - cy, 0, cy - b.maxy)
  const dz = Math.max(b.minz - cz, 0, cz - b.maxz)
  return dx * dx + dy * dy + dz * dz <= radius * radius
}

// ─── the shared ray machinery (the slab test) ─────────────────────────────

/** Clips the running interval [t0, t1] against the bounds — the slab
 *  form: per axis, (lo−o)·inv .. (hi−o)·inv, swapped when the ray runs
 *  backwards. inv may be ±Infinity (a parallel axis) — that axis only
 *  rejects when the origin is outside the slab (0·Infinity is NaN, so
 *  the parallel axis is SPECIAL-CASED, never multiplied). Returns the
 *  clipped [enter, exit] or null on a miss. */
function clipRay(
  ox: number, oy: number, oz: number,
  ix: number, iy: number, iz: number,
  b: NodeBounds, t0: number, t1: number,
): [number, number] | null {
  // x axis
  if (ix === Infinity || ix === -Infinity) {
    if (ox < b.minx || ox > b.maxx) return null
  } else {
    let ta = (b.minx - ox) * ix
    let tb = (b.maxx - ox) * ix
    if (ta > tb) { const s = ta; ta = tb; tb = s }
    if (ta > t0) t0 = ta
    if (tb < t1) t1 = tb
    if (t0 > t1) return null
  }
  // y axis
  if (iy === Infinity || iy === -Infinity) {
    if (oy < b.miny || oy > b.maxy) return null
  } else {
    let ta = (b.miny - oy) * iy
    let tb = (b.maxy - oy) * iy
    if (ta > tb) { const s = ta; ta = tb; tb = s }
    if (ta > t0) t0 = ta
    if (tb < t1) t1 = tb
    if (t0 > t1) return null
  }
  // z axis
  if (iz === Infinity || iz === -Infinity) {
    if (oz < b.minz || oz > b.maxz) return null
  } else {
    let ta = (b.minz - oz) * iz
    let tb = (b.maxz - oz) * iz
    if (ta > tb) { const s = ta; ta = tb; tb = s }
    if (ta > t0) t0 = ta
    if (tb < t1) t1 = tb
    if (t0 > t1) return null
  }
  return [t0, t1]
}

// ─── Task 205 — THE ALLOCATION-FREE SLAB WALK (the picking path) ──────────

/** clipRay's numeric twin (the ryg discipline: no allocations in the hot
 *  walk — the old path bought a [t0, t1] tuple per NODE and a six-field
 *  NodeBounds object per LEAF ITEM, all short-lived GC garbage on the
 *  click path). Returns the ENTRY t, or −1 on a miss; the EXIT t lands
 *  in the module scratch `slabExit`. The arithmetic order is clipRay's
 *  own, so every t is bit-identical — the walks decide identically and
 *  the tie law survives. */
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

// ─── THE OCTREE ───────────────────────────────────────────────────────────

interface OctNode {
  b: NodeBounds
  /** the leaf's items (null on an internal node) — MUTABLE: insert() pushes */
  items: SpatialBox[] | null
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
 *  a live id never touches the tree (the leaves hold the id's old object,
 *  unreachable for a cheap removal); the FRESHEST box lands in a small
 *  id→box lane the walks read after the tree while the tree's own stale
 *  copy is skipped by id — O(1) per update, zero growth, zero duplicate
 *  answers. rebuild() folds the lane back in (both structures fold). */
export function buildOctree(items: readonly SpatialBox[], options?: { capacity?: number; maxDepth?: number; planeMask?: boolean }): SpatialIndex {
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
   *  build and insert() share the exact same rule). */
  function octantsOf(it: SpatialBox, cell: NodeBounds): boolean[] {
    const mx = (cell.minx + cell.maxx) * 0.5
    const my = (cell.miny + cell.maxy) * 0.5
    const mz = (cell.minz + cell.maxz) * 0.5
    const lox = it.cx - it.hx, hix = it.cx + it.hx
    const loy = it.cy - it.hy, hiy = it.cy + it.hy
    const loz = it.cz - it.hz, hiz = it.cz + it.hz
    const hit: boolean[] = new Array(8).fill(false)
    for (let x = 0; x < 2; x++) {
      if (x === 0 ? lox >= mx : hix <= mx) continue
      for (let y = 0; y < 2; y++) {
        if (y === 0 ? loy >= my : hiy <= my) continue
        for (let z = 0; z < 2; z++) {
          if (z === 0 ? loz >= mz : hiz <= mz) continue
          hit[y * 4 + z * 2 + x] = true
        }
      }
    }
    return hit
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

  function makeLeaf(itemsAt: SpatialBox[], cell: NodeBounds, level: number): OctNode {
    nodes++
    if (level > depth) depth = level
    leaves++
    return { b: cell, items: itemsAt, kids: null, level }
  }

  function buildNode(itemsAt: SpatialBox[], cell: NodeBounds, level: number): OctNode {
    if (itemsAt.length <= capacity || level >= maxDepth || cellDegenerate(cell)) {
      return makeLeaf(itemsAt, cell, level)
    }
    return splitOrLeaf(itemsAt, cell, level)
  }

  /** The split: distribute the items over the octants (an item joins
   *  EVERY child it touches); the PROGRESS GUARD keeps co-located data
   *  from recursing forever (a split that moved nothing makes a leaf). */
  function splitOrLeaf(itemsAt: SpatialBox[], cell: NodeBounds, level: number): OctNode {
    nodes++
    if (level > depth) depth = level
    const octants: SpatialBox[][] = Array.from({ length: 8 }, () => [])
    for (const it of itemsAt) {
      const hit = octantsOf(it, cell)
      for (let k = 0; k < 8; k++) if (hit[k]) octants[k].push(it)
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
    const octants: SpatialBox[][] = Array.from({ length: 8 }, () => [])
    for (const it of itemsAt) {
      const hit = octantsOf(it, n.b)
      for (let k = 0; k < 8; k++) if (hit[k]) octants[k].push(it)
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

  let root = buildNode(items.slice() as SpatialBox[], unionOf(items), 1)

  // ── Task 212 — THE OVERRIDE LANE + THE LIVE-SET AUTHORITY ─────────────
  // byId holds the FRESHEST box per live id; moved holds the live ids the
  // LANE owns — their tree copies are stale by construction (update()
  // cannot find the old object cheaply), so the walks skip those ids and
  // read the lane's geometry instead. This is the fix for the field
  // report («scene edit взвинчивает мс, со временем растёт»): update()
  // used to be remove+insert, which left every intermediate object in the
  // leaves FOREVER — 48 drones at 60fps grew this tree 55k → 3.3M nodes
  // in ONE SECOND (measured, scripts/task212-leak.mjs) and the frame
  // with it; rebuild() now folds the lane back in.
  const byId = new Map<number, SpatialBox>()
  for (const it of items) byId.set(it.id, it)
  const moved = new Map<number, SpatialBox>()

  // ── the live-set bookkeeping (the dynamic twin) + the query machinery:
  //    the stamp mask deduplicates the straddlers (`seen` re-grows when an
  //    inserted id outruns the build's maxId) ──
  const removed = new Set<number>()
  let maxId = items.length === 0 ? 0 : Math.max(...items.map(b => b.id))
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

  function indexed(it: SpatialBox): boolean {
    // the tree's copy answers ONLY for ids the override lane doesn't own
    return !removed.has(it.id) && !moved.has(it.id)
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
      if (mask === 0) {
        for (const it of n.items) {
          if (!indexed(it)) continue
          if (seen[it.id] !== stamp) { seen[it.id] = stamp; out.push(it.id) }
        }
      } else {
        for (const it of n.items) {
          if (!indexed(it)) continue
          if (seen[it.id] === stamp) continue
          seen[it.id] = stamp // (mark either way: one verdict per box per query)
          if (!aabbOutsideFrustum(planes, it.cx, it.cy, it.cz, it.hx, it.hy, it.hz)) out.push(it.id)
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
      for (const it of n.items) {
        if (!indexed(it)) continue
        if (seen[it.id] === stamp) continue
        seen[it.id] = stamp
        if (it.cx + it.hx > min[0] && it.cx - it.hx < max[0]
          && it.cy + it.hy > min[1] && it.cy - it.hy < max[1]
          && it.cz + it.hz > min[2] && it.cz - it.hz < max[2]) {
          out.push(it.id)
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
      for (const it of n.items) {
        if (!indexed(it)) continue
        if (seen[it.id] === stamp) continue
        seen[it.id] = stamp
        const b: NodeBounds = {
          minx: it.cx - it.hx, maxx: it.cx + it.hx,
          miny: it.cy - it.hy, maxy: it.cy + it.hy,
          minz: it.cz - it.hz, maxz: it.cz + it.hz,
        }
        if (boxReachesSphere(b, cx, cy, cz, radius)) out.push(it.id)
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
      for (const it of n.items) {
        if (!indexed(it)) continue
        if (seen[it.id] === stamp) continue
        seen[it.id] = stamp
        if (Math.abs(x - it.cx) <= it.hx && Math.abs(y - it.cy) <= it.hy && Math.abs(z - it.cz) <= it.hz) {
          out.push(it.id)
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
  // hit — its own slab interval, the same numbers from any leaf)
  function walkRay(n: OctNode, ox: number, oy: number, oz: number, ix: number, iy: number, iz: number, t0: number, t1: number): void {
    const clip = clipRay(ox, oy, oz, ix, iy, iz, n.b, t0, t1)
    if (clip === null) return
    if (n.items !== null) {
      for (const it of n.items) {
        if (!indexed(it)) continue
        if (seen[it.id] === stamp) continue
        seen[it.id] = stamp
        // THE GLOBAL INTERVAL — not the leaf's clip: a straddler box lives
        // in several leaves, and the ray may cross the cell's EMPTY part
        // before reaching the box (the leaf-local test would fail there,
        // but the stamp suppresses the later leaf's TRUE hit — the dedup
        // must carry the box's own interval, the same numbers from any
        // leaf it belongs to). Task 205: the slab walk is numeric — no
        // NodeBounds literal, no [t, t] tuple per item.
        const hit = slabEnter(ox, oy, oz, ix, iy, iz, it.cx - it.hx, it.cy - it.hy, it.cz - it.hz, it.cx + it.hx, it.cy + it.hy, it.cz + it.hz, 0, Infinity)
        if (hit >= 0) hits.push({ id: it.id, t: hit })
      }
      return
    }
    const kids = n.kids
    if (kids !== null) {
      for (const k of kids) {
        if (k !== null) walkRay(k, ox, oy, oz, ix, iy, iz, clip[0], clip[1])
      }
    }
  }

  // raycast's walk: the running best t prunes every node whose ENTRY is
  // already beyond it (the octree has no child ordering — the pruning is
  // purely the interval; the BVH twin below adds the near-first order).
  // Task 205: the numeric slab walk — allocation-free on the click path.
  function walkRayFirst(n: OctNode, ox: number, oy: number, oz: number, ix: number, iy: number, iz: number, t0: number, t1: number, best: { t: number; id: number }): void {
    if (t0 > best.t) return
    const en = slabEnter(ox, oy, oz, ix, iy, iz, n.b.minx, n.b.miny, n.b.minz, n.b.maxx, n.b.maxy, n.b.maxz, t0, t1)
    if (en < 0 || en > best.t) return
    const ex = slabExit
    if (n.items !== null) {
      for (const it of n.items) {
        if (!indexed(it)) continue
        const hit = slabEnter(ox, oy, oz, ix, iy, iz, it.cx - it.hx, it.cy - it.hy, it.cz - it.hz, it.cx + it.hx, it.cy + it.hy, it.cz + it.hz, 0, best.t)
        if (hit >= 0 && hit < best.t) {
          best.t = hit
          best.id = it.id
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

  function insertAt(n: OctNode, it: SpatialBox): void {
    // THE PATH REFIT: every node on the descent grows to contain the item.
    // A box beyond the root's original extent still lands honestly — the
    // queries prune by NODE bounds, so the bounds must cover the contents
    // (the classic loose-insert trade: bounds only ever grow; a tight tree
    // is a fresh buildOctree away).
    if (it.cx - it.hx < n.b.minx) n.b.minx = it.cx - it.hx
    if (it.cy - it.hy < n.b.miny) n.b.miny = it.cy - it.hy
    if (it.cz - it.hz < n.b.minz) n.b.minz = it.cz - it.hz
    if (it.cx + it.hx > n.b.maxx) n.b.maxx = it.cx + it.hx
    if (it.cy + it.hy > n.b.maxy) n.b.maxy = it.cy + it.hy
    if (it.cz + it.hz > n.b.maxz) n.b.maxz = it.cz + it.hz
    if (n.items !== null) {
      n.items.push(it)
      if (n.items.length > capacity) growLeaf(n)
      return
    }
    const kids = n.kids
    if (kids === null) return
    const hit = octantsOf(it, n.b)
    for (let k = 0; k < 8; k++) {
      if (hit[k] && kids[k] !== null) insertAt(kids[k] as OctNode, it)
    }
  }

  // ── Task 212 — the override lane's scans: the freshest copies answer
  // with the walks' own per-item predicates (the stamp mask dedups the id
  // exactly like a straddler's several leaves; the lane is small — the
  // hot minority of movers) ──
  function laneFrustum(planes: ArrayLike<number>): void {
    for (const it of moved.values()) {
      if (seen[it.id] === stamp) continue
      seen[it.id] = stamp
      if (!aabbOutsideFrustum(planes, it.cx, it.cy, it.cz, it.hx, it.hy, it.hz)) out.push(it.id)
    }
  }
  function laneBox(min: readonly number[], max: readonly number[]): void {
    for (const it of moved.values()) {
      if (seen[it.id] === stamp) continue
      seen[it.id] = stamp
      if (it.cx + it.hx > min[0] && it.cx - it.hx < max[0]
        && it.cy + it.hy > min[1] && it.cy - it.hy < max[1]
        && it.cz + it.hz > min[2] && it.cz - it.hz < max[2]) out.push(it.id)
    }
  }
  function laneSphere(cx: number, cy: number, cz: number, radius: number): void {
    for (const it of moved.values()) {
      if (seen[it.id] === stamp) continue
      seen[it.id] = stamp
      const dx = Math.max(it.cx - it.hx - cx, 0, cx - (it.cx + it.hx))
      const dy = Math.max(it.cy - it.hy - cy, 0, cy - (it.cy + it.hy))
      const dz = Math.max(it.cz - it.hz - cz, 0, cz - (it.cz + it.hz))
      if (dx * dx + dy * dy + dz * dz <= radius * radius) out.push(it.id)
    }
  }
  function lanePoint(x: number, y: number, z: number): void {
    for (const it of moved.values()) {
      if (seen[it.id] === stamp) continue
      seen[it.id] = stamp
      if (Math.abs(x - it.cx) <= it.hx && Math.abs(y - it.cy) <= it.hy && Math.abs(z - it.cz) <= it.hz) out.push(it.id)
    }
  }
  function laneRay(ox: number, oy: number, oz: number, ix: number, iy: number, iz: number): void {
    for (const it of moved.values()) {
      if (seen[it.id] === stamp) continue
      seen[it.id] = stamp
      const hit = slabEnter(ox, oy, oz, ix, iy, iz, it.cx - it.hx, it.cy - it.hy, it.cz - it.hz, it.cx + it.hx, it.cy + it.hy, it.cz + it.hz, 0, Infinity)
      if (hit >= 0) hits.push({ id: it.id, t: hit })
    }
  }
  function laneRayFirst(ox: number, oy: number, oz: number, ix: number, iy: number, iz: number, best: { t: number; id: number }): void {
    for (const it of moved.values()) {
      const hit = slabEnter(ox, oy, oz, ix, iy, iz, it.cx - it.hx, it.cy - it.hy, it.cz - it.hz, it.cx + it.hx, it.cy + it.hy, it.cz + it.hz, 0, best.t)
      if (hit >= 0 && hit < best.t) {
        best.t = hit
        best.id = it.id
      }
    }
  }

  /** Task 212 — THE FOLD: rebuild the whole tree over the live set (byId's
   * freshest objects, deduped by id — the override lane empties into the
   * tree, the tombstones stay gone, the loose bounds re-tighten to the
   * live union). The BVH's own twin; both structures now fold. */
  function rebuild(): void {
    const liveItems = Array.from(byId.values())
    // the fresh tree holds ONLY byId ids — the old root (with every
    // tombstoned copy) is garbage, so the tombstone Set's entries point
    // at nothing anymore: cleared, it can never grow unbounded across a
    // long edit session (a later remove() of the same id just re-adds it)
    removed.clear()
    nodes = 0
    leaves = 0
    depth = 0
    moved.clear()
    root = buildNode(liveItems, unionOf(liveItems), 1)
  }

  const index: SpatialIndex = {
    kind: 'octree',
    count: items.length,
    get live(): number {
      // Task 212 — byId IS the live set (the old manual counter lied on
      // the remove→re-insert round-trip: remove dropped it, the tombstone
      // re-insert left it — one live box undercounted forever)
      return byId.size
    },
    stats: {
      get nodes() { return nodes },
      get leaves() { return leaves },
      get depth() { return depth },
      get lane() { return moved.size },
      items: items.length,
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
    querySphere(cx: number, cy: number, cz: number, radius: number) {
      beginQuery()
      walkSphere(root, cx, cy, cz, radius)
      laneSphere(cx, cy, cz, radius)
      return Uint32Array.from(out)
    },
    queryPoint(x: number, y: number, z: number) {
      beginQuery()
      walkPoint(root, x, y, z)
      lanePoint(x, y, z)
      return Uint32Array.from(out)
    },
    queryRay(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number) {
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
    raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number) {
      const ix = dx !== 0 ? 1 / dx : Infinity
      const iy = dy !== 0 ? 1 / dy : Infinity
      const iz = dz !== 0 ? 1 / dz : Infinity
      const best = { t: Infinity, id: -1 }
      walkRayFirst(root, ox, oy, oz, ix, iy, iz, 0, Infinity, best)
      laneRayFirst(ox, oy, oz, ix, iy, iz, best)
      return best.id >= 0 ? { id: best.id, t: best.t } : null
    },
    insert(box: SpatialBox): void {
      maxId = Math.max(maxId, box.id)
      ensureCapacity(box.id)
      if (removed.delete(box.id) || byId.has(box.id)) {
        // Task 212 — a re-inserted id (tombstoned OR live) rides THE
        // OVERRIDE LANE: the stale copy in the leaves is skipped by id,
        // the lane answers for the freshest box. The old tombstone path
        // dropped a SECOND copy into the leaves (the stamp mask deduped
        // the ANSWERS — the tree still grew); the old live path churned
        // the same way update() used to. The live count rides byId: a
        // tombstone's re-insert counts back what its remove dropped, a
        // live re-insert changes nothing
        byId.set(box.id, box)
        moved.set(box.id, box)
        return
      }
      byId.set(box.id, box)
      insertAt(root, box)
    },
    remove(id: number): void {
      if (removed.has(id)) return
      removed.add(id)
      byId.delete(id)
      moved.delete(id)
    },
    update(box: SpatialBox): void {
      if (byId.has(box.id)) {
        // Task 212 — the dynamic twin's honest shape: the FRESHEST bounds
        // into the override lane, O(1), nothing grows (the old
        // remove+insert left every intermediate object in the leaves
        // forever — the leak the field report caught)
        byId.set(box.id, box)
        moved.set(box.id, box)
        return
      }
      this.insert(box)
    },
    rebuild,
  }
  return index
}

// ─── THE BVH ──────────────────────────────────────────────────────────────

interface BvhNode {
  readonly b: NodeBounds
  /** the layout slice [from, to) this node covers — the items array IS
   *  the tree's contiguous memory (leaves are ranges, not lists) */
  readonly from: number
  readonly to: number
  left: BvhNode | null
  right: BvhNode | null
}

/** Builds the BVH over the boxes. The split axis is the node's LONGEST
 *  bound (the SAH-lite shape heuristic), the split point the count median
 *  of that axis's centers (balanced by construction); leaf capacity 8.
 *  The items array is COPIED and REORDERED into the tree's own layout —
 *  the caller's order is never touched, the query answers ride the ids.
 *
 *  Task 201 — THE HONEST DYNAMICS: remove() tombstones (the contiguous
 *  layout cannot be spliced cheaply); insert() appends to an OVERFLOW
 *  list the queries scan linearly (the amortized-rebuild pattern — the
 *  fresh minority costs a sweep, the settled majority keeps its
 *  near-log walk); rebuild() folds the overflow back into a fresh tree.
 *  Task 212 — THE OVERRIDE LANE: update() on a live id never touches the
 *  layout (the old remove+insert flooded the overflow with every
 *  intermediate object and the fold baked them all in — the leak behind
 *  the field report); the freshest box lands in a small id→box lane the
 *  queries read after the overflow, and rebuild() folds the LIVE SET. */
export function buildBVH(items: readonly SpatialBox[], options?: { capacity?: number; planeMask?: boolean }): SpatialIndex {
  const capacity = Math.max(1, options?.capacity ?? 8)
  const planeMask = options?.planeMask ?? true
  // the mutable build state — rebuild() re-runs the builder over the live set
  let layout: SpatialBox[] = []
  let overflow: SpatialBox[] = []
  const removed = new Set<number>()
  // ── Task 212 — THE OVERRIDE LANE + THE LIVE-SET AUTHORITY (the octree
  // twin's comment above): byId = the freshest box per live id; moved =
  // the live ids the LANE owns (their layout/overflow copies are stale —
  // the walks skip them by id, the lane answers). The old update() =
  // remove+insert pushed EVERY intermediate object into the overflow and
  // rebuild() folded them all back in — the layout grew 48 items per
  // frame, forever (measured: bvh.live lied +2880 after one second). The
  // lane is O(1) and bounded; rebuild() folds byId.
  const byId = new Map<number, SpatialBox>()
  for (const it of items) byId.set(it.id, it)
  const moved = new Map<number, SpatialBox>()
  let nodes = 0
  let leaves = 0
  let depth = 0
  let root: BvhNode | null = null

  function centerAlong(b: SpatialBox, axis: number): number {
    return axis === 0 ? b.cx : axis === 1 ? b.cy : b.cz
  }

  function buildNode(from: number, to: number, level: number): BvhNode {
    nodes++
    if (level > depth) depth = level
    let minx = Infinity, miny = Infinity, minz = Infinity
    let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity
    for (let i = from; i < to; i++) {
      const b = layout[i]
      if (b.cx - b.hx < minx) minx = b.cx - b.hx
      if (b.cy - b.hy < miny) miny = b.cy - b.hy
      if (b.cz - b.hz < minz) minz = b.cz - b.hz
      if (b.cx + b.hx > maxx) maxx = b.cx + b.hx
      if (b.cy + b.hy > maxy) maxy = b.cy + b.hy
      if (b.cz + b.hz > maxz) maxz = b.cz + b.hz
    }
    const b: NodeBounds = { minx, miny, minz, maxx, maxy, maxz }
    if (to - from <= capacity) {
      leaves++
      return { b, from, to, left: null, right: null }
    }
    const ex = b.maxx - b.minx, ey = b.maxy - b.miny, ez = b.maxz - b.minz
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2
    // the median split: sort the slice by the axis's centers, write back
    const slice = layout.slice(from, to)
    slice.sort((p, q) => centerAlong(p, axis) - centerAlong(q, axis))
    for (let k = 0; k < slice.length; k++) layout[from + k] = slice[k]
    const mid = from + ((to - from) >> 1)
    return { b, from, to, left: buildNode(from, mid, level + 1), right: buildNode(mid, to, level + 1) }
  }

  function rebuild(): void {
    // Task 212 — THE FOLD over the live set's FRESHEST objects: byId holds
    // one box per live id (the lane's and the overflow's newest), so the
    // rebuilt layout is deduped and bounded — the old fold concatenated
    // items + the whole overflow, keeping every stale intermediate object
    // an update() ever pushed. The fresh layout holds ONLY byId ids, so
    // the tombstone Set's entries point at nothing — cleared, it can
    // never grow unbounded across a long edit session
    const liveItems = Array.from(byId.values())
    layout = liveItems
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

  function indexed(it: SpatialBox): boolean {
    // the layout/overflow copy answers ONLY for ids the lane doesn't own
    return !removed.has(it.id) && !moved.has(it.id)
  }

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
      for (let i = n.from; i < n.to; i++) {
        const it = layout[i]
        if (!indexed(it)) continue
        if (mask === 0 || !itemOutsideMasked(planes, it.cx, it.cy, it.cz, it.hx, it.hy, it.hz, mask)) {
          out.push(it.id)
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
      for (let i = n.from; i < n.to; i++) {
        const it = layout[i]
        if (!indexed(it)) continue
        if (it.cx + it.hx > min[0] && it.cx - it.hx < max[0]
          && it.cy + it.hy > min[1] && it.cy - it.hy < max[1]
          && it.cz + it.hz > min[2] && it.cz - it.hz < max[2]) {
          out.push(it.id)
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
      for (let i = n.from; i < n.to; i++) {
        const it = layout[i]
        if (!indexed(it)) continue
        const b: NodeBounds = {
          minx: it.cx - it.hx, maxx: it.cx + it.hx,
          miny: it.cy - it.hy, maxy: it.cy + it.hy,
          minz: it.cz - it.hz, maxz: it.cz + it.hz,
        }
        if (boxReachesSphere(b, cx, cy, cz, radius)) out.push(it.id)
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
      for (let i = n.from; i < n.to; i++) {
        const it = layout[i]
        if (!indexed(it)) continue
        if (Math.abs(x - it.cx) <= it.hx && Math.abs(y - it.cy) <= it.hy && Math.abs(z - it.cz) <= it.hz) {
          out.push(it.id)
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
      for (let i = n.from; i < n.to; i++) {
        const it = layout[i]
        if (!indexed(it)) continue
        const hit = slabEnter(ox, oy, oz, ix, iy, iz, it.cx - it.hx, it.cy - it.hy, it.cz - it.hz, it.cx + it.hx, it.cy + it.hy, it.cz + it.hz, 0, t1)
        if (hit >= 0) hits.push({ id: it.id, t: hit })
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
      for (let i = n.from; i < n.to; i++) {
        const it = layout[i]
        if (!indexed(it)) continue
        const hit = slabEnter(ox, oy, oz, ix, iy, iz, it.cx - it.hx, it.cy - it.hy, it.cz - it.hz, it.cx + it.hx, it.cy + it.hy, it.cz + it.hz, 0, best.t)
        if (hit >= 0 && hit < best.t) {
          best.t = hit
          best.id = it.id
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
    count: items.length,
    get live(): number {
      // Task 212 — byId IS the live set (the old arithmetic counted the
      // overflow's stale intermediates: 48 drones × 60fps lied +2880/s)
      return byId.size
    },
    stats: { get nodes() { return nodes }, get leaves() { return leaves }, get depth() { return depth }, get lane() { return moved.size }, items: items.length },
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
      for (const it of overflow) {
        if (!indexed(it)) continue
        if (it.cx + it.hx > min[0] && it.cx - it.hx < max[0]
          && it.cy + it.hy > min[1] && it.cy - it.hy < max[1]
          && it.cz + it.hz > min[2] && it.cz - it.hz < max[2]) {
          out.push(it.id)
        }
      }
      for (const it of moved.values()) {
        if (it.cx + it.hx > min[0] && it.cx - it.hx < max[0]
          && it.cy + it.hy > min[1] && it.cy - it.hy < max[1]
          && it.cz + it.hz > min[2] && it.cz - it.hz < max[2]) {
          out.push(it.id)
        }
      }
      return Uint32Array.from(out)
    },
    querySphere(cx: number, cy: number, cz: number, radius: number) {
      out.length = 0
      if (root !== null) walkSphere(root, cx, cy, cz, radius)
      for (const it of overflow) {
        if (!indexed(it)) continue
        const b: NodeBounds = {
          minx: it.cx - it.hx, maxx: it.cx + it.hx,
          miny: it.cy - it.hy, maxy: it.cy + it.hy,
          minz: it.cz - it.hz, maxz: it.cz + it.hz,
        }
        if (boxReachesSphere(b, cx, cy, cz, radius)) out.push(it.id)
      }
      for (const it of moved.values()) {
        const dx = Math.max(it.cx - it.hx - cx, 0, cx - (it.cx + it.hx))
        const dy = Math.max(it.cy - it.hy - cy, 0, cy - (it.cy + it.hy))
        const dz = Math.max(it.cz - it.hz - cz, 0, cz - (it.cz + it.hz))
        if (dx * dx + dy * dy + dz * dz <= radius * radius) out.push(it.id)
      }
      return Uint32Array.from(out)
    },
    queryPoint(x: number, y: number, z: number) {
      out.length = 0
      if (root !== null) walkPoint(root, x, y, z)
      for (const it of overflow) {
        if (!indexed(it)) continue
        if (Math.abs(x - it.cx) <= it.hx && Math.abs(y - it.cy) <= it.hy && Math.abs(z - it.cz) <= it.hz) {
          out.push(it.id)
        }
      }
      for (const it of moved.values()) {
        if (Math.abs(x - it.cx) <= it.hx && Math.abs(y - it.cy) <= it.hy && Math.abs(z - it.cz) <= it.hz) {
          out.push(it.id)
        }
      }
      return Uint32Array.from(out)
    },
    queryRay(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number) {
      out.length = 0
      hits.length = 0
      const ix = dx !== 0 ? 1 / dx : Infinity
      const iy = dy !== 0 ? 1 / dy : Infinity
      const iz = dz !== 0 ? 1 / dz : Infinity
      if (root !== null) walkRay(root, ox, oy, oz, ix, iy, iz, 0, Infinity)
      for (const it of overflow) {
        if (!indexed(it)) continue
        const hit = slabEnter(ox, oy, oz, ix, iy, iz, it.cx - it.hx, it.cy - it.hy, it.cz - it.hz, it.cx + it.hx, it.cy + it.hy, it.cz + it.hz, 0, Infinity)
        if (hit >= 0) hits.push({ id: it.id, t: hit })
      }
      for (const it of moved.values()) {
        const hit = slabEnter(ox, oy, oz, ix, iy, iz, it.cx - it.hx, it.cy - it.hy, it.cz - it.hz, it.cx + it.hx, it.cy + it.hy, it.cz + it.hz, 0, Infinity)
        if (hit >= 0) hits.push({ id: it.id, t: hit })
      }
      hits.sort((a, b) => a.t - b.t)
      return hits.slice()
    },
    raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number) {
      const ix = dx !== 0 ? 1 / dx : Infinity
      const iy = dy !== 0 ? 1 / dy : Infinity
      const iz = dz !== 0 ? 1 / dz : Infinity
      const best = { t: Infinity, id: -1 }
      if (root !== null) walkRayFirst(root, ox, oy, oz, ix, iy, iz, 0, Infinity, best)
      for (const it of overflow) {
        if (!indexed(it)) continue
        const hit = slabEnter(ox, oy, oz, ix, iy, iz, it.cx - it.hx, it.cy - it.hy, it.cz - it.hz, it.cx + it.hx, it.cy + it.hy, it.cz + it.hz, 0, best.t)
        if (hit >= 0 && hit < best.t) {
          best.t = hit
          best.id = it.id
        }
      }
      for (const it of moved.values()) {
        const hit = slabEnter(ox, oy, oz, ix, iy, iz, it.cx - it.hx, it.cy - it.hy, it.cz - it.hz, it.cx + it.hx, it.cy + it.hy, it.cz + it.hz, 0, best.t)
        if (hit >= 0 && hit < best.t) {
          best.t = hit
          best.id = it.id
        }
      }
      return best.id >= 0 ? { id: best.id, t: best.t } : null
    },
    insert(box: SpatialBox): void {
      if (removed.delete(box.id) || byId.has(box.id)) {
        // Task 212 — a re-inserted id (tombstoned OR live) rides THE
        // OVERRIDE LANE: the stale layout/overflow copy is skipped by id,
        // the lane answers for the freshest box. The old tombstone path
        // pushed a SECOND copy into the overflow while the tombstone's
        // clearing revived the stale one — DUPLICATE answers (the BVH has
        // no stamp mask; the latent bug the lane kills); the old live path
        // churned the overflow the way update() used to. The live count
        // rides byId: a tombstone's re-insert counts back what its remove
        // dropped, a live re-insert changes nothing
        byId.set(box.id, box)
        moved.set(box.id, box)
        return
      }
      byId.set(box.id, box)
      overflow.push(box)
    },
    remove(id: number): void {
      removed.add(id)
      byId.delete(id)
      moved.delete(id)
    },
    update(box: SpatialBox): void {
      if (byId.has(box.id)) {
        // Task 212 — the freshest bounds into the lane, O(1) (the old
        // remove+insert churned the overflow with every intermediate)
        byId.set(box.id, box)
        moved.set(box.id, box)
        return
      }
      this.insert(box)
    },
    rebuild,
  }

  function scanLaneFrustum(planes: ArrayLike<number>): void {
    for (const it of moved.values()) {
      if (!aabbOutsideFrustum(planes, it.cx, it.cy, it.cz, it.hx, it.hy, it.hz)) out.push(it.id)
    }
  }
  function scanOverflowFrustum(planes: ArrayLike<number>): void {
    for (const it of overflow) {
      if (!indexed(it)) continue
      if (!aabbOutsideFrustum(planes, it.cx, it.cy, it.cz, it.hx, it.hy, it.hz)) out.push(it.id)
    }
  }

  return index
}

export { frustumPlanes }
