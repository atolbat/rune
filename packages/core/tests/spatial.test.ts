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

// ── Task 201: the grown surface — rays, hit tests, dynamics ────────────────
describe('Task 201: the spatial surface — rays, points, spheres, dynamics', () => {
  test('queryRay/raycast: octree === BVH === the brute-force slab sweep', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const items = makeBoxes(300, seed * 8191)
      const oct = buildOctree(items)
      const bvh = buildBVH(items)
      const r = rng(seed * 7)
      for (let q = 0; q < 12; q++) {
        const ox = (r() * 2 - 1) * 50, oy = r() * 25, oz = (r() * 2 - 1) * 60
        let dx = (r() * 2 - 1), dy = (r() * 2 - 1) * 0.5, dz = (r() * 2 - 1)
        const l = Math.hypot(dx, dy, dz) || 1
        dx /= l; dy /= l; dz /= l
        // the brute-force truth: the slab interval of every box
        const want: { id: number; t: number }[] = []
        for (const it of items) {
          const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz
          let t0 = 0, t1 = Infinity, miss = false
          const axes: [number, number, number, number, number][] = [
            [it.cx - it.hx, it.cx + it.hx, ox, ix, dx],
            [it.cy - it.hy, it.cy + it.hy, oy, iy, dy],
            [it.cz - it.hz, it.cz + it.hz, oz, iz, dz],
          ]
          for (const [lo, hi, o, i, d] of axes) {
            if (d === 0) {
              if (o < lo || o > hi) { miss = true; break }
              continue
            }
            let ta = (lo - o) * i, tb = (hi - o) * i
            if (ta > tb) { const s = ta; ta = tb; tb = s }
            if (ta > t0) t0 = ta
            if (tb < t1) t1 = tb
            if (t0 > t1) { miss = true; break }
          }
          if (!miss) want.push({ id: it.id, t: t0 })
        }
        want.sort((a, b) => a.t - b.t)
        const byOct = oct.queryRay(ox, oy, oz, dx, dy, dz)
        const byBvh = bvh.queryRay(ox, oy, oz, dx, dy, dz)
        expect(byOct.length).toBe(want.length)
        expect(byBvh.length).toBe(want.length)
        for (let h = 0; h < want.length; h++) {
          expect(byOct[h].id).toBe(want[h].id)
          expect(byOct[h].t).toBeCloseTo(want[h].t, 9)
          expect(byBvh[h].id).toBe(want[h].id)
          expect(byBvh[h].t).toBeCloseTo(want[h].t, 9)
        }
        const first = oct.raycast(ox, oy, oz, dx, dy, dz)
        const firstBvh = bvh.raycast(ox, oy, oz, dx, dy, dz)
        if (want.length === 0) {
          expect(first).toBe(null)
          expect(firstBvh).toBe(null)
        } else {
          expect(first?.id).toBe(want[0].id)
          expect(first?.t).toBeCloseTo(want[0].t, 9)
          expect(firstBvh?.id).toBe(want[0].id)
          expect(firstBvh?.t).toBeCloseTo(want[0].t, 9)
        }
      }
    }
  })

  test('queryPoint + querySphere: both structures agree with the brute force', () => {
    const items = makeBoxes(250, 5150)
    const oct = buildOctree(items)
    const bvh = buildBVH(items)
    const r = rng(77)
    for (let q = 0; q < 20; q++) {
      const x = (r() * 2 - 1) * 60, y = r() * 22, z = (r() * 2 - 1) * 66
      const rad = 2 + r() * 25
      const brutePoint = new Set<number>()
      const bruteSphere = new Set<number>()
      for (const it of items) {
        if (Math.abs(x - it.cx) <= it.hx && Math.abs(y - it.cy) <= it.hy && Math.abs(z - it.cz) <= it.hz) {
          brutePoint.add(it.id)
        }
        const dx = Math.max(it.cx - it.hx - x, 0, x - (it.cx + it.hx))
        const dy = Math.max(it.cy - it.hy - y, 0, y - (it.cy + it.hy))
        const dz = Math.max(it.cz - it.hz - z, 0, z - (it.cz + it.hz))
        if (dx * dx + dy * dy + dz * dz <= rad * rad) bruteSphere.add(it.id)
      }
      expect(asSet(oct.queryPoint(x, y, z))).toEqual(brutePoint)
      expect(asSet(bvh.queryPoint(x, y, z))).toEqual(brutePoint)
      expect(asSet(oct.querySphere(x, y, z, rad))).toEqual(bruteSphere)
      expect(asSet(bvh.querySphere(x, y, z, rad))).toEqual(bruteSphere)
    }
  })

  test('the dynamic octree: insert/remove/update keep every query honest', () => {
    const items = makeBoxes(150, 911)
    const oct = buildOctree(items)
    const r = rng(191)
    // remove a third, insert fresh boxes at new spots, move a few
    const removed = new Set<number>()
    for (let k = 0; k < 50; k++) removed.add((r() * 150) | 0)
    for (const id of removed) oct.remove(id)
    const fresh: SpatialBox[] = []
    for (let k = 0; k < 60; k++) {
      fresh.push({
        id: 1000 + k,
        cx: (r() * 2 - 1) * 55, cy: r() * 20, cz: (r() * 2 - 1) * 60,
        hx: 0.5 + r() * 3, hy: 0.5 + r() * 3, hz: 0.5 + r() * 3,
      })
      oct.insert(fresh[k])
    }
    // the live truth
    const live = items.filter(it => !removed.has(it.id)).concat(fresh)
    expect(oct.live).toBe(live.length)
    for (let q = 0; q < 6; q++) {
      const planes = frustumPlanes(mvpFor([(r() * 2 - 1) * 50, 8 + r() * 20, (r() * 2 - 1) * 50], [0, 5, 0]))
      expect(asSet(oct.queryFrustum(planes))).toEqual(bruteSurvivors(live, planes))
    }
    // points and rays over the live set
    const x = (r() * 2 - 1) * 40, y = r() * 18, z = (r() * 2 - 1) * 50
    const brutePoint = new Set<number>()
    for (const it of live) {
      if (Math.abs(x - it.cx) <= it.hx && Math.abs(y - it.cy) <= it.hy && Math.abs(z - it.cz) <= it.hz) brutePoint.add(it.id)
    }
    expect(asSet(oct.queryPoint(x, y, z))).toEqual(brutePoint)
    let dx = (r() * 2 - 1), dy = (r() * 2 - 1) * 0.4, dz = (r() * 2 - 1)
    const l = Math.hypot(dx, dy, dz) || 1
    dx /= l; dy /= l; dz /= l
    const hits = oct.queryRay(x, y, z, dx, dy, dz)
    for (const h of hits) {
      const it = live.find(b => b.id === h.id)
      expect(it).toBeDefined()
    }
    expect(hits.length).toBe(new Set(hits.map(h => h.id)).size) // no duplicates
  })

  test('the BVH overflow + rebuild: inserts answer, rebuild folds them back', () => {
    const items = makeBoxes(120, 6161)
    const bvh = buildBVH(items)
    const r = rng(616)
    const fresh: SpatialBox[] = []
    for (let k = 0; k < 30; k++) {
      fresh.push({
        id: 500 + k,
        cx: (r() * 2 - 1) * 50, cy: r() * 20, cz: (r() * 2 - 1) * 55,
        hx: 0.5 + r() * 2, hy: 0.5 + r() * 2, hz: 0.5 + r() * 2,
      })
      bvh.insert(fresh[k])
    }
    const planes = frustumPlanes(mvpFor([30, 20, 30], [0, 5, 0]))
    const all = items.concat(fresh)
    expect(asSet(bvh.queryFrustum(planes))).toEqual(bruteSurvivors(all, planes))
    bvh.rebuild?.()
    expect(bvh.live).toBe(all.length)
    expect(asSet(bvh.queryFrustum(planes))).toEqual(bruteSurvivors(all, planes))
    // removal tombstones ride both the tree and the overflow
    bvh.remove(500)
    expect(asSet(bvh.queryFrustum(planes))).toEqual(bruteSurvivors(all.filter(it => it.id !== 500), planes))
  })
})

describe('Task 212: the override lane — the dynamic-index leak the field report caught', () => {
  // The report: «Scene edit сразу взвинчивает мс на кадр... Со временем мс
  // увеличивается.» The root cause: update() was remove+insert, and every
  // intermediate object stayed in the octree's leaves FOREVER (3.3M nodes
  // in one second at 48 drones × 60fps — measured, scripts/task212-leak.mjs)
  // while the BVH's overflow grew 48/frame and the fold baked it all in.
  // The lane is the fix: O(1) updates, bounded memory, freshest answers.

  test('the leak law: 48 movers × 1200 updates grow NOTHING (nodes, lane, live)', () => {
    const items = makeBoxes(800, 212)
    const oct = buildOctree(items)
    const bvh = buildBVH(items)
    const octNodes0 = oct.stats.nodes
    const bvhNodes0 = bvh.stats.nodes
    const r = rng(1212)
    const movers = items.slice(0, 48).map(it => ({ ...it }))
    for (let f = 0; f < 1200; f++) {
      for (const m of movers) {
        m.cx += (r() - 0.5) * 0.4
        m.cy = Math.max(0.2, m.cy + (r() - 0.5) * 0.2)
        m.cz += (r() - 0.5) * 0.4
        const box: SpatialBox = { ...m }
        oct.update(box)
        bvh.update(box)
      }
      if (f % 300 === 299) {
        // the lane holds AT MOST one entry per distinct mover id
        expect(oct.stats.lane).toBe(48)
        expect(bvh.stats.lane).toBe(48)
      }
    }
    expect(oct.stats.nodes).toBe(octNodes0) // ZERO tree growth — the leak law
    expect(bvh.stats.nodes).toBe(bvhNodes0)
    expect(oct.live).toBe(800)
    expect(bvh.live).toBe(800)
  })

  test('the lane answers from the FRESHEST bounds (both structures, every query family)', () => {
    const items = makeBoxes(150, 77)
    const oct = buildOctree(items)
    const bvh = buildBVH(items)
    const it = items[7]
    // boot position answers
    expect(asSet(oct.queryPoint(it.cx, it.cy, it.cz)).has(it.id)).toBe(true)
    expect(asSet(bvh.queryPoint(it.cx, it.cy, it.cz)).has(it.id)).toBe(true)
    // teleport far away (OUTSIDE the boot root bounds — the lane cannot
    // lean on the tree's geometry, by construction)
    const nx = it.cx + 400, ny = it.cy + 40, nz = it.cz - 350
    const moved: SpatialBox = { id: it.id, cx: nx, cy: ny, cz: nz, hx: it.hx, hy: it.hy, hz: it.hz }
    oct.update(moved)
    bvh.update(moved)
    // the stale position is gone, the fresh one answers — point, box, sphere, ray, raycast
    expect(asSet(oct.queryPoint(it.cx, it.cy, it.cz)).has(it.id)).toBe(false)
    expect(asSet(bvh.queryPoint(it.cx, it.cy, it.cz)).has(it.id)).toBe(false)
    expect(asSet(oct.queryPoint(nx, ny, nz)).has(it.id)).toBe(true)
    expect(asSet(bvh.queryPoint(nx, ny, nz)).has(it.id)).toBe(true)
    const min: [number, number, number] = [nx - 1, ny - 1, nz - 1]
    const max: [number, number, number] = [nx + 1, ny + 1, nz + 1]
    expect(asSet(oct.queryBox(min, max)).has(it.id)).toBe(true)
    expect(asSet(bvh.queryBox(min, max)).has(it.id)).toBe(true)
    expect(asSet(oct.querySphere(nx, ny, nz, 2)).has(it.id)).toBe(true)
    expect(asSet(bvh.querySphere(nx, ny, nz, 2)).has(it.id)).toBe(true)
    const hitsOct = oct.queryRay(nx - 10, ny, nz, 1, 0, 0)
    const hitsBvh = bvh.queryRay(nx - 10, ny, nz, 1, 0, 0)
    expect(hitsOct.some(h => h.id === it.id)).toBe(true)
    expect(hitsBvh.some(h => h.id === it.id)).toBe(true)
    expect(oct.raycast(nx - 10, ny, nz, 1, 0, 0)?.id).toBe(it.id)
    expect(bvh.raycast(nx - 10, ny, nz, 1, 0, 0)?.id).toBe(it.id)
    // frustum: a camera that sees ONLY the fresh position
    const planes = frustumPlanes(mvpFor([nx + 30, ny + 5, nz], [nx, ny, nz]))
    expect(asSet(oct.queryFrustum(planes)).has(it.id)).toBe(true)
    // and the frustum walk stays honest as a SET against the brute truth
    const truth = bruteSurvivors(items.map(b => b.id === it.id ? moved : b), planes)
    expect(asSet(oct.queryFrustum(planes))).toEqual(truth)
    expect(asSet(bvh.queryFrustum(planes))).toEqual(truth)
  })

  test('remove → re-insert round-trips: ONE answer per id, the live count honest', () => {
    for (const build of [buildOctree, buildBVH]) {
      const items = makeBoxes(90, 5150)
      const idx = build(items)
      const it = items[3]
      const planes = frustumPlanes(mvpFor([30, 25, 30], [0, 5, 0]))
      for (let k = 0; k < 25; k++) {
        idx.remove(it.id)
        expect(idx.live).toBe(89)
        expect(asSet(idx.queryFrustum(planes)).has(it.id)).toBe(false)
        // re-insert AT A NEW SPOT: the stale copy (tree, leaves, overflow —
        // wherever the old object lives) must stay skipped — exactly ONE
        // answer, from the freshest bounds (the BVH's latent duplicate bug)
        const nx = it.cx + (k + 1) * 3, ny = it.cy, nz = it.cz - (k + 1) * 2
        idx.insert({ id: it.id, cx: nx, cy: ny, cz: nz, hx: it.hx, hy: it.hy, hz: it.hz })
        expect(idx.live).toBe(90)
        const got = idx.queryFrustum(planes)
        expect(got.filter(v => v === it.id).length).toBeLessThanOrEqual(1)
        expect(asSet(idx.queryPoint(nx, ny, nz)).has(it.id)).toBe(true)
      }
      // a LIVE re-insert (no remove first) — same law: newest bounds, no
      // second copy anywhere, the live count untouched
      const before = idx.stats.nodes
      idx.insert({ id: items[8].id, cx: items[8].cx + 25, cy: items[8].cy, cz: items[8].cz, hx: 1, hy: 1, hz: 1 })
      expect(idx.live).toBe(90)
      expect(idx.stats.nodes).toBe(before)
      expect(asSet(idx.queryPoint(items[8].cx + 25, items[8].cy, items[8].cz)).has(items[8].id)).toBe(true)
      expect(asSet(idx.queryPoint(items[8].cx, items[8].cy, items[8].cz)).has(items[8].id)).toBe(false)
    }
  })

  test('rebuild() folds the lane: identical answers, empty lane, honest live, clean re-arm', () => {
    const items = makeBoxes(140, 31337)
    for (const build of [buildOctree, buildBVH]) {
      const idx = build(items)
      const planes = frustumPlanes(mvpFor([35, 18, 35], [0, 5, 0]))
      const movers = items.slice(0, 20).map((it, k) => ({ ...it, cx: it.cx + k * 7, cz: it.cz - k * 5 }))
      for (const m of movers) idx.update(m)
      expect(idx.stats.lane).toBe(20)
      const before = bruteSurvivors(items.map(b => movers.find(m => m.id === b.id) ?? b), planes)
      const got = asSet(idx.queryFrustum(planes))
      expect(got).toEqual(before)
      idx.rebuild?.()
      expect(idx.stats.lane).toBe(0)
      expect(idx.live).toBe(140)
      expect(asSet(idx.queryFrustum(planes))).toEqual(before)
      // re-arm: the next update lands in the lane again
      idx.update({ ...movers[0], cx: movers[0].cx + 100 })
      expect(idx.stats.lane).toBe(1)
      expect(asSet(idx.queryFrustum(planes))).toEqual(
        bruteSurvivors(items.map(b => b.id === movers[0].id ? { ...movers[0], cx: movers[0].cx + 100 } : (movers.find(m => m.id === b.id) ?? b)), planes))
    }
  })

  test('the drone cadence vs the brute truth: every frame honest, boot node count at the end', () => {
    const items = makeBoxes(220, 4242)
    const oct = buildOctree(items)
    const bvh = buildBVH(items)
    const octNodes0 = oct.stats.nodes
    const bvhNodes0 = bvh.stats.nodes
    const r = rng(99)
    const drones = items.slice(0, 12).map(it => ({ ...it }))
    const anchors = drones.map(d => ({ ...d, p: r() * 6.28, w: 0.4 + r() }))
    for (let f = 0; f < 240; f++) {
      const t = f / 60
      const current = items.slice()
      for (let d = 0; d < drones.length; d++) {
        const a = anchors[d]
        const box: SpatialBox = {
          id: a.id,
          cx: a.cx + Math.sin(t * a.w + a.p) * 8,
          cy: a.cy,
          cz: a.cz + Math.cos(t * a.w * 0.7 + a.p) * 6,
          hx: a.hx, hy: a.hy, hz: a.hz,
        }
        oct.update(box)
        bvh.update(box)
        current[a.id] = box
      }
      if (f % 40 === 39) {
        const planes = frustumPlanes(mvpFor([(r() * 2 - 1) * 45, 10 + r() * 15, (r() * 2 - 1) * 45], [0, 5, 0]))
        const truth = bruteSurvivors(current, planes)
        expect(asSet(oct.queryFrustum(planes))).toEqual(truth)
        expect(asSet(bvh.queryFrustum(planes))).toEqual(truth)
      }
    }
    expect(oct.stats.nodes).toBe(octNodes0)
    expect(bvh.stats.nodes).toBe(bvhNodes0)
    expect(oct.stats.lane).toBe(12)
    expect(bvh.stats.lane).toBe(12)
    expect(oct.live).toBe(220)
    expect(bvh.live).toBe(220)
  })
})
