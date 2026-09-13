/**
 * spatial.ts — the clean hierarchical cull structures (Task 200).
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
 *     touch, queries deduplicate. The classic region query (queryBox)
 *     and a predictable, rebuild-free shape for static data.
 *   · BVH — the binary hierarchy: the split axis follows the node's
 *     LONGEST bound (the SAH-lite heuristic), the split point is the
 *     count median of that axis's centers — balanced, tight bounds,
 *     items REORDERED into the tree's own contiguous layout.
 *
 * Both structures are built ONCE over the same SpatialBox list and answer
 * the same queries; the demo's validation gate runs both and requires
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

/** The shared query surface: both hierarchies answer the same questions. */
export interface SpatialIndex {
  readonly kind: 'octree' | 'bvh'
  readonly count: number
  readonly stats: { readonly nodes: number; readonly leaves: number; readonly depth: number; readonly items: number }
  /** The frustum walk: `planes` is frustumPlanes()'s 24-float layout.
   *  Returns the SURVIVOR ids — every box NOT fully outside any single
   *  plane (traversal order; treat as a set). */
  queryFrustum(planes: ArrayLike<number>): Uint32Array
  /** The axis-aligned overlap query: every box overlapping [min, max]. */
  queryBox(min: readonly [number, number, number], max: readonly [number, number, number]): Uint32Array
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

// ─── THE OCTREE ───────────────────────────────────────────────────────────

interface OctNode {
  readonly b: NodeBounds
  /** the leaf's items (null on an internal node) */
  readonly items: readonly SpatialBox[] | null
  /** the 8 children, index = y*4 + z*2 + x (null when an octant is empty) */
  readonly kids: readonly (OctNode | null)[] | null
}

/** Builds the octree over the boxes. `capacity` (items per leaf before a
 *  split, default 8), `maxDepth` (default 12 — the degenerate-data guard:
 *  co-located items cannot split forever). The split point is the cell's
 *  CENTER; an item joins EVERY child its AABB touches (the conservative
 *  route — a straddling box lives in several leaves); the query walk
 *  deduplicates through a per-query stamp mask. */
export function buildOctree(items: readonly SpatialBox[], options?: { capacity?: number; maxDepth?: number }): SpatialIndex {
  const capacity = Math.max(1, options?.capacity ?? 8)
  const maxDepth = Math.max(1, options?.maxDepth ?? 12)
  let nodes = 0
  let leaves = 0
  let depth = 0

  function buildNode(itemsAt: readonly SpatialBox[], cell: NodeBounds, level: number): OctNode {
    nodes++
    if (level > depth) depth = level
    const degenerate = cell.maxx - cell.minx <= 1e-9 || cell.maxy - cell.miny <= 1e-9 || cell.maxz - cell.minz <= 1e-9
    if (itemsAt.length <= capacity || level >= maxDepth || degenerate) {
      leaves++
      return { b: cell, items: itemsAt, kids: null }
    }
    // the uniform split: eight cells around the center point
    const mx = (cell.minx + cell.maxx) * 0.5
    const my = (cell.miny + cell.maxy) * 0.5
    const mz = (cell.minz + cell.maxz) * 0.5
    const octants: SpatialBox[][] = Array.from({ length: 8 }, () => [])
    for (const it of itemsAt) {
      const lox = it.cx - it.hx, hix = it.cx + it.hx
      const loy = it.cy - it.hy, hiy = it.cy + it.hy
      const loz = it.cz - it.hz, hiz = it.cz + it.hz
      for (let x = 0; x < 2; x++) {
        const xOK = x === 0 ? lox < mx : hix > mx
        if (!xOK) continue
        for (let y = 0; y < 2; y++) {
          const yOK = y === 0 ? loy < my : hiy > my
          if (!yOK) continue
          for (let z = 0; z < 2; z++) {
            const zOK = z === 0 ? loz < mz : hiz > mz
            if (zOK) octants[y * 4 + z * 2 + x].push(it)
          }
        }
      }
    }
    // the progress guard: a split that moved nothing (all items in all
    // octants — co-located centers) must not recurse forever
    let progress = false
    for (const o of octants) {
      if (o.length > 0 && o.length < itemsAt.length) { progress = true; break }
    }
    if (!progress) {
      leaves++
      return { b: cell, items: itemsAt, kids: null }
    }
    const kids = octants.map((o, k) => {
      if (o.length === 0) return null
      // the child's own cell — the octant of this node's cell
      const x = k & 1, z = (k >> 1) & 1, y = k >> 2
      const childCell: NodeBounds = {
        minx: x === 0 ? cell.minx : mx, maxx: x === 0 ? mx : cell.maxx,
        miny: y === 0 ? cell.miny : my, maxy: y === 0 ? my : cell.maxy,
        minz: z === 0 ? cell.minz : mz, maxz: z === 0 ? mz : cell.maxz,
      }
      return buildNode(o, childCell, level + 1)
    })
    return { b: cell, items: null, kids }
  }

  const root = buildNode(items, unionOf(items), 1)

  // ── the query machinery: the stamp mask deduplicates the straddlers ──
  const maxId = items.length === 0 ? 0 : Math.max(...items.map(b => b.id))
  const seen = new Uint8Array(maxId + 1)
  let stamp = 0
  const out: number[] = []

  function beginQuery(): void {
    out.length = 0
    stamp++
    if (stamp >= 255) {
      seen.fill(0)
      stamp = 1
    }
  }

  function walkFrustum(n: OctNode, planes: ArrayLike<number>, fullyInside: boolean): void {
    if (!fullyInside) {
      const cx = (n.b.minx + n.b.maxx) * 0.5
      const cy = (n.b.miny + n.b.maxy) * 0.5
      const cz = (n.b.minz + n.b.maxz) * 0.5
      const hx = (n.b.maxx - n.b.minx) * 0.5
      const hy = (n.b.maxy - n.b.miny) * 0.5
      const hz = (n.b.maxz - n.b.minz) * 0.5
      if (aabbOutsideFrustum(planes, cx, cy, cz, hx, hy, hz)) return
      fullyInside = aabbInsideFrustum(planes, cx, cy, cz, hx, hy, hz)
    }
    if (n.items !== null) {
      if (fullyInside) {
        for (const it of n.items) {
          if (seen[it.id] !== stamp) { seen[it.id] = stamp; out.push(it.id) }
        }
      } else {
        for (const it of n.items) {
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
        if (k !== null) walkFrustum(k, planes, fullyInside)
      }
    }
  }

  function walkBox(n: OctNode, min: readonly number[], max: readonly number[]): void {
    if (!boundsOverlap(n.b, min, max)) return
    if (n.items !== null) {
      for (const it of n.items) {
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

  return {
    kind: 'octree',
    count: items.length,
    stats: { nodes, leaves, depth, items: items.length },
    queryFrustum(planes: ArrayLike<number>): Uint32Array {
      beginQuery()
      walkFrustum(root, planes, false)
      return Uint32Array.from(out)
    },
    queryBox(min, max) {
      beginQuery()
      walkBox(root, min as readonly number[], max as readonly number[])
      return Uint32Array.from(out)
    },
  }
}

// ─── THE BVH ──────────────────────────────────────────────────────────────

interface BvhNode {
  readonly b: NodeBounds
  /** the layout slice [from, to) this node covers — the items array IS
   *  the tree's contiguous memory (leaves are ranges, not lists) */
  readonly from: number
  readonly to: number
  readonly left: BvhNode | null
  readonly right: BvhNode | null
}

/** Builds the BVH over the boxes. The split axis is the node's LONGEST
 *  bound (the SAH-lite shape heuristic), the split point the count median
 *  of that axis's centers (balanced by construction); leaf capacity 8.
 *  The items array is COPIED and REORDERED into the tree's own layout —
 *  the caller's order is never touched, the query answers ride the ids. */
export function buildBVH(items: readonly SpatialBox[], options?: { capacity?: number }): SpatialIndex {
  const capacity = Math.max(1, options?.capacity ?? 8)
  const layout = items.slice() // the tree's contiguous item memory
  let nodes = 0
  let leaves = 0
  let depth = 0

  function centerAlong(b: SpatialBox, axis: number): number {
    return axis === 0 ? b.cx : axis === 1 ? b.cy : b.cz
  }

  function buildNode(from: number, to: number, level: number): BvhNode {
    nodes++
    if (level > depth) depth = level
    const slice = layout.slice(from, to)
    const b = unionOf(slice)
    if (to - from <= capacity) {
      leaves++
      return { b, from, to, left: null, right: null }
    }
    const ex = b.maxx - b.minx, ey = b.maxy - b.miny, ez = b.maxz - b.minz
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2
    // the median split: sort the slice by the axis's centers, write back
    slice.sort((p, q) => centerAlong(p, axis) - centerAlong(q, axis))
    for (let k = 0; k < slice.length; k++) layout[from + k] = slice[k]
    const mid = from + ((to - from) >> 1)
    return { b, from, to, left: buildNode(from, mid, level + 1), right: buildNode(mid, to, level + 1) }
  }

  const root = buildNode(0, layout.length, 1)

  const out: number[] = []

  function walkFrustum(n: BvhNode, planes: ArrayLike<number>, fullyInside: boolean): void {
    if (!fullyInside) {
      const cx = (n.b.minx + n.b.maxx) * 0.5
      const cy = (n.b.miny + n.b.maxy) * 0.5
      const cz = (n.b.minz + n.b.maxz) * 0.5
      const hx = (n.b.maxx - n.b.minx) * 0.5
      const hy = (n.b.maxy - n.b.miny) * 0.5
      const hz = (n.b.maxz - n.b.minz) * 0.5
      if (aabbOutsideFrustum(planes, cx, cy, cz, hx, hy, hz)) return
      fullyInside = aabbInsideFrustum(planes, cx, cy, cz, hx, hy, hz)
    }
    const l = n.left
    const r = n.right
    if (l === null || r === null) {
      for (let i = n.from; i < n.to; i++) {
        const it = layout[i]
        if (fullyInside || !aabbOutsideFrustum(planes, it.cx, it.cy, it.cz, it.hx, it.hy, it.hz)) {
          out.push(it.id)
        }
      }
      return
    }
    walkFrustum(l, planes, fullyInside)
    walkFrustum(r, planes, fullyInside)
  }

  function walkBox(n: BvhNode, min: readonly number[], max: readonly number[]): void {
    if (!boundsOverlap(n.b, min, max)) return
    const l = n.left
    const r = n.right
    if (l === null || r === null) {
      for (let i = n.from; i < n.to; i++) {
        const it = layout[i]
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

  return {
    kind: 'bvh',
    count: layout.length,
    stats: { nodes, leaves, depth, items: layout.length },
    queryFrustum(planes: ArrayLike<number>): Uint32Array {
      out.length = 0
      walkFrustum(root, planes, false)
      return Uint32Array.from(out)
    },
    queryBox(min, max) {
      out.length = 0
      walkBox(root, min as readonly number[], max as readonly number[])
      return Uint32Array.from(out)
    },
  }
}

export { frustumPlanes }
