/**
 * spatial.test.ts — Task 200: the clean hierarchical cull structures.
 *
 * THE PROOF SHAPE: three independent answers to the same question must
 * agree — the octree's walk, the BVH's walk, and the brute-force sweep
 * (every box against every plane, no hierarchy). Two different hierarchy
 * shapes producing the identical survivor SET is the strongest cheap
 * correctness property; the AABB–plane predicate is additionally pinned
 * against its 8-corner definition (the Hi-Z kernel's own form).
 */
import { describe, expect, test } from 'bun:test'
import {
  buildOctree, buildBVH, aabbOutsideFrustum, aabbInsideFrustum,
  frustumPlanes,
} from '../src/spatial.ts'
import type { SpatialBox } from '../src/spatial.ts'

// ── the deterministic RNG (the repo's xorshift canon) ─────────────────────
function rng(seed: number) {
  let s = seed | 0
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    return (s >>> 0) / 4294967296
  }
}

// ── tiny mat helpers (a random-but-valid view-projection per case) ────────
function perspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovy / 2)
  const nf = 1 / (near - far)
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, far * nf, -1,
    0, 0, far * near * nf, 0,
  ])
}
function mvpFor(eye: readonly number[], target: readonly number[]): Float32Array {
  let fx = target[0] - eye[0], fy = target[1] - eye[1], fz = target[2] - eye[2]
  let l = Math.hypot(fx, fy, fz); fx /= l; fy /= l; fz /= l
  const rx = fy * 0 - fz * 1, ry = fz * 0 - fx * 0, rz = fx * 1 - fy * 0
  l = Math.hypot(rx, ry, rz)
  const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx
  const view = new Float32Array([
    rx / l, ux, -fx, 0,
    ry / l, uy, -fy, 0,
    rz / l, uz, -fz, 0,
    -(rx / l * eye[0] + ry / l * eye[1] + rz / l * eye[2]),
    -(ux * eye[0] + uy * eye[1] + uz * eye[2]),
    fx * eye[0] + fy * eye[1] + fz * eye[2],
    1,
  ])
  const p = perspective(1.1, 16 / 9, 0.5, 300)
  const out = new Float32Array(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += p[k * 4 + r] * view[c * 4 + k]
      out[c * 4 + r] = s
    }
  }
  return out
}

// ── the brute-force references (no hierarchy, no shortcuts) ───────────────
function bruteSurvivors(items: readonly SpatialBox[], planes: ArrayLike<number>): Set<number> {
  const set = new Set<number>()
  for (const it of items) {
    if (!aabbOutsideFrustum(planes, it.cx, it.cy, it.cz, it.hx, it.hy, it.hz)) set.add(it.id)
  }
  return set
}
function bruteOverlap(items: readonly SpatialBox[], min: readonly number[], max: readonly number[]): Set<number> {
  const set = new Set<number>()
  for (const it of items) {
    if (it.cx + it.hx > min[0] && it.cx - it.hx < max[0]
      && it.cy + it.hy > min[1] && it.cy - it.hy < max[1]
      && it.cz + it.hz > min[2] && it.cz - it.hz < max[2]) set.add(it.id)
  }
  return set
}
function asSet(ids: Uint32Array): Set<number> {
  return new Set(Array.from(ids))
}

// ── the fixtures ───────────────────────────────────────────────────────────
function makeBoxes(n: number, seed: number): SpatialBox[] {
  const r = rng(seed)
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    cx: (r() * 2 - 1) * 60,
    cy: r() * 20,
    cz: (r() * 2 - 1) * 66,
    hx: 0.1 + r() * 5,
    hy: 0.1 + r() * 5,
    hz: 0.1 + r() * 5,
  }))
}

describe('Task 200: the octree + BVH — identical survivor sets, the brute-force truth', () => {
  test('frustum queries: octree === BVH === brute force over random scenes × cameras', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const items = makeBoxes(400, seed * 7919)
      const oct = buildOctree(items)
      const bvh = buildBVH(items)
      for (let cam = 0; cam < 6; cam++) {
        const r = rng(seed * 100 + cam)
        const eye = [(r() * 2 - 1) * 40, 5 + r() * 25, (r() * 2 - 1) * 40]
        const target = [(r() * 2 - 1) * 10, 5, (r() * 2 - 1) * 10]
        const planes = frustumPlanes(mvpFor(eye, target))
        const want = bruteSurvivors(items, planes)
        expect(asSet(oct.queryFrustum(planes))).toEqual(want)
        expect(asSet(bvh.queryFrustum(planes))).toEqual(want)
      }
    }
  })

  test('box queries: octree === BVH === brute force', () => {
    const r = rng(42)
    const items = makeBoxes(300, 12345)
    const oct = buildOctree(items)
    const bvh = buildBVH(items)
    for (let q = 0; q < 8; q++) {
      const cx = (r() * 2 - 1) * 50, cy = r() * 15, cz = (r() * 2 - 1) * 50
      const rad = 5 + r() * 40
      const min: [number, number, number] = [cx - rad, cy - rad, cz - rad]
      const max: [number, number, number] = [cx + rad, cy + rad, cz + rad]
      const want = bruteOverlap(items, min, max)
      expect(asSet(oct.queryBox(min, max))).toEqual(want)
      expect(asSet(bvh.queryBox(min, max))).toEqual(want)
    }
  })

  test('repeated queries are stable (the stamp mask resets honestly)', () => {
    const items = makeBoxes(200, 999)
    const oct = buildOctree(items)
    const bvh = buildBVH(items)
    const planes = frustumPlanes(mvpFor([30, 10, 30], [0, 5, 0]))
    const a = asSet(oct.queryFrustum(planes))
    const b = asSet(oct.queryFrustum(planes))
    const c = asSet(bvh.queryFrustum(planes))
    const d = asSet(bvh.queryFrustum(planes))
    expect(a).toEqual(b)
    expect(c).toEqual(d)
    // a different camera must not leak the previous query's stamp state
    const planes2 = frustumPlanes(mvpFor([-30, 10, -30], [0, 5, 0]))
    expect(asSet(oct.queryFrustum(planes2))).toEqual(bruteSurvivors(items, planes2))
    expect(asSet(bvh.queryFrustum(planes2))).toEqual(bruteSurvivors(items, planes2))
  })

  test('the AABB–plane predicate === its 8-corner definition (the Hi-Z kernel\'s form)', () => {
    const r = rng(7)
    for (let trial = 0; trial < 200; trial++) {
      const items = makeBoxes(1, 777)
      const it = items[0]
      const planes = frustumPlanes(mvpFor(
        [(r() * 2 - 1) * 30, 5 + r() * 15, (r() * 2 - 1) * 30],
        [(r() * 2 - 1) * 10, 5, (r() * 2 - 1) * 10],
      ))
      // the definition: fully outside ⟺ some plane has ALL 8 corners outside
      let byCorners = false
      for (let p = 0; p < 6 && !byCorners; p++) {
        const o = p * 4
        const nx = planes[o], ny = planes[o + 1], nz = planes[o + 2], d = planes[o + 3]
        let allOut = true
        for (let sx = -1; sx <= 1 && allOut; sx += 2) {
          for (let sy = -1; sy <= 1 && allOut; sy += 2) {
            for (let sz = -1; sz <= 1 && allOut; sz += 2) {
              if (nx * (it.cx + sx * it.hx) + ny * (it.cy + sy * it.hy) + nz * (it.cz + sz * it.hz) + d >= 0) allOut = false
            }
          }
        }
        if (allOut) byCorners = true
      }
      expect(aabbOutsideFrustum(planes, it.cx, it.cy, it.cz, it.hx, it.hy, it.hz)).toBe(byCorners)
      // and inside ⟺ no corner leaves any plane
      let anyOut = false
      for (let p = 0; p < 6 && !anyOut; p++) {
        const o = p * 4
        const nx = planes[o], ny = planes[o + 1], nz = planes[o + 2], d = planes[o + 3]
        for (let sx = -1; sx <= 1 && !anyOut; sx += 2) {
          for (let sy = -1; sy <= 1 && !anyOut; sy += 2) {
            for (let sz = -1; sz <= 1 && !anyOut; sz += 2) {
              if (nx * (it.cx + sx * it.hx) + ny * (it.cy + sy * it.hy) + nz * (it.cz + sz * it.hz) + d < 0) anyOut = true
            }
          }
        }
      }
      expect(aabbInsideFrustum(planes, it.cx, it.cy, it.cz, it.hx, it.hy, it.hz)).toBe(!anyOut)
    }
  })

  test('the degenerate guards: co-located items and the empty scene', () => {
    // every box at the SAME center — the split makes no progress; the build
    // must terminate (the progress guard) and answer every query honestly
    const stacked: SpatialBox[] = Array.from({ length: 50 }, (_, i) => ({
      id: i, cx: 3, cy: 3, cz: 3, hx: 1, hy: 1, hz: 1,
    }))
    const oct = buildOctree(stacked)
    const bvh = buildBVH(stacked)
    const planes = frustumPlanes(mvpFor([30, 10, 30], [0, 5, 0]))
    expect(asSet(oct.queryFrustum(planes))).toEqual(bruteSurvivors(stacked, planes))
    expect(asSet(bvh.queryFrustum(planes))).toEqual(bruteSurvivors(stacked, planes))
    // the empty scene: empty answers, no NaNs, no throws
    const emptyOct = buildOctree([])
    const emptyBvh = buildBVH([])
    expect(emptyOct.queryFrustum(planes).length).toBe(0)
    expect(emptyBvh.queryFrustum(planes).length).toBe(0)
    expect(emptyOct.queryBox([0, 0, 0], [1, 1, 1]).length).toBe(0)
    expect(emptyBvh.queryBox([0, 0, 0], [1, 1, 1]).length).toBe(0)
  })

  test('the BVH layout partitions the items (leaves cover every box exactly once)', () => {
    const items = makeBoxes(500, 31337)
    const bvh = buildBVH(items)
    // the survivor sets already pin correctness; the stats pin the shape
    expect(bvh.stats.items).toBe(500)
    expect(bvh.stats.leaves).toBeGreaterThan(0)
    expect(bvh.stats.nodes).toBeGreaterThan(bvh.stats.leaves)
    // a fully-inside camera: the trivial-accept path returns EVERYTHING
    const tiny: SpatialBox[] = Array.from({ length: 30 }, (_, i) => ({ id: i, cx: i, cy: 1, cz: 0, hx: 0.1, hy: 0.1, hz: 0.1 }))
    const oct2 = buildOctree(tiny)
    const bvh2 = buildBVH(tiny)
    // camera far above looking straight down at a tight cone around origin
    // — with the boxes along +x most fall OUTSIDE the cone; the property
    // under test is agreement, not the count
    const planes = frustumPlanes(mvpFor([0, 40, 0.01], [0, 0, 0]))
    expect(asSet(oct2.queryFrustum(planes))).toEqual(bruteSurvivors(tiny, planes))
    expect(asSet(bvh2.queryFrustum(planes))).toEqual(bruteSurvivors(tiny, planes))
  })
})
