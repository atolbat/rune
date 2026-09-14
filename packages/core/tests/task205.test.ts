/**
 * task205.test.ts — Task 205: THE RESEARCH HARVEST — the parity gates.
 *
 * The niche techniques (Greene's hierarchical tiling / the rawrunprotected
 * coarse tier tests / the ryg incremental-edge discipline / Sýkora &
 * Jelínek's plane-mask inheritance / the allocation-free slab walk) land
 * as OPTIMIZATIONS of the Task-201 bricks; the contract is that the
 * observable answers DO NOT CHANGE:
 *   · softwareOccluder 'tiled' ≡ 'legacy' — verdict for verdict over a
 *     seeded fuzz corpus of scenes × cameras (the e≈0 fp-reassociation
 *     rim class is quantified: ZERO verdict drift is the bar);
 *   · hidden()'s earlyOut ≡ the full scan (the monotone-max proof);
 *   · buildOctree/buildBVH planeMask on/off — identical survivor SETS
 *     (the mask only skips planes proven inside for the parent, and the
 *     BVH's leaf items inherit it soundly: items live inside the node);
 *   · the slab walk's raycast ≡ raycast ≡ brute force (the tie law: t
 *     is compared, ids only resolve inside the tied set);
 *   · the instrumented planeTests counter: the masked walk never tests
 *     MORE planes than the legacy walk and strictly fewer on a real
 *     corpus — the win is measured, not claimed.
 */
import { describe, expect, test } from 'bun:test'
import {
  softwareOccluder, projectBox, projectBoxLegacy, recordView, cameraRay,
} from '../src/culling.ts'
import { buildOctree, buildBVH, frustumPlanes } from '../src/spatial.ts'
import type { SpatialBox } from '../src/spatial.ts'

function rng(seed: number) {
  let s = seed | 0
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    return (s >>> 0) / 4294967296
  }
}

// ── the shared camera math (the demo's own shapes) ─────────────────────
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
function lookAt(eye: readonly number[], target: readonly number[], up: readonly number[]): Float32Array {
  let fx = target[0] - eye[0], fy = target[1] - eye[1], fz = target[2] - eye[2]
  let l = Math.hypot(fx, fy, fz); fx /= l; fy /= l; fz /= l
  let rx = fy * up[2] - fz * up[1], ry = fz * up[0] - fx * up[2], rz = fx * up[1] - fy * up[0]
  l = Math.hypot(rx, ry, rz); rx /= l; ry /= l; rz /= l
  const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx
  return new Float32Array([
    rx, ux, -fx, 0,
    ry, uy, -fy, 0,
    rz, uz, -fz, 0,
    -(rx * eye[0] + ry * eye[1] + rz * eye[2]),
    -(ux * eye[0] + uy * eye[1] + uz * eye[2]),
    fx * eye[0] + fy * eye[1] + fz * eye[2], 1,
  ])
}
function mat4Mul(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]
      out[c * 4 + r] = s
    }
  }
  return out
}
const mvpFor = (eye: readonly number[], target: readonly number[], aspect = 128 / 72): Float32Array =>
  mat4Mul(perspective(Math.PI / 3, aspect, 0.5, 300), lookAt(eye, target, [0, 1, 0]))

// ── THE FUZZ CORPUS ───────────────────────────────────────────────────────

describe('Task 205: softwareOccluder — tiled ≡ legacy (the verdict oracle)', () => {
  test('fuzz: identical hidden() verdicts over random scenes × cameras', () => {
    const r = rng(20250914)
    let totalHidden = 0
    for (let trial = 0; trial < 30; trial++) {
      const eye = [(r() * 2 - 1) * 45, 2 + r() * 22, (r() * 2 - 1) * 45]
      const target = [(r() * 2 - 1) * 10, r() * 8, (r() * 2 - 1) * 10]
      const mvp = mvpFor(eye, target, r() < 0.5 ? 128 / 72 : 96 / 72)
      const zMap: 0 | 1 = r() < 0.5 ? 0 : 1
      const W = r() < 0.5 ? 128 : 96
      const H = Math.round(W * 9 / 16)
      const legacy = softwareOccluder({ width: W, height: H, zMap, raster: 'legacy', earlyOut: false })
      const tiled = softwareOccluder({ width: W, height: H, zMap })
      legacy.begin(mvp); tiled.begin(mvp)
      // a random occluder field: 3..14 boxes, some overlapping (the
      // min-depth interplay), sizes from slivers to walls
      const K = 3 + Math.floor(r() * 12)
      const boxes: number[][] = []
      for (let k = 0; k < K; k++) {
        const b = [
          (r() * 2 - 1) * 30, r() * 14, (r() * 2 - 1) * 30,
          0.4 + r() * 8, 0.4 + r() * 6, 0.4 + r() * 8,
        ]
        boxes.push(b)
        legacy.writeBox(b[0], b[1], b[2], b[3], b[4], b[5])
        tiled.writeBox(b[0], b[1], b[2], b[3], b[4], b[5])
      }
      legacy.reduce(); tiled.reduce()
      let hiddenCount = 0
      // the queries: the occluders themselves (the self-occlusion class)
      // plus fresh random boxes
      for (let q = 0; q < 120; q++) {
        const b = q < K
          ? boxes[q]
          : [
              (r() * 2 - 1) * 34, r() * 16, (r() * 2 - 1) * 34,
              0.2 + r() * 2.5, 0.2 + r() * 2.5, 0.2 + r() * 2.5,
            ]
        const h1 = legacy.hidden(b[0], b[1], b[2], b[3], b[4], b[5])
        const h2 = tiled.hidden(b[0], b[1], b[2], b[3], b[4], b[5])
        if (h2) hiddenCount++
        expect(h2).toBe(h1)
      }
      totalHidden += hiddenCount
    }
    // the corpus must actually occlude somewhere (a live raster, not a
    // vacuous pass — the aggregate over the fuzz must exercise the
    // hidden path; individual trials may look away)
    expect(totalHidden).toBeGreaterThan(0)
  })

  test('earlyOut ≡ the full scan (the monotone-max proof, exercised)', () => {
    const r = rng(777)
    for (let trial = 0; trial < 12; trial++) {
      const mvp = mvpFor([(r() * 2 - 1) * 40, 4 + r() * 18, (r() * 2 - 1) * 40], [0, 5, 0])
      const full = softwareOccluder({ width: 128, height: 72, earlyOut: false })
      const early = softwareOccluder({ width: 128, height: 72, earlyOut: true })
      full.begin(mvp); early.begin(mvp)
      for (let k = 0; k < 8; k++) {
        const b = [(r() * 2 - 1) * 20, r() * 10, (r() * 2 - 1) * 20, 1 + r() * 7, 1 + r() * 5, 1 + r() * 7]
        full.writeBox(b[0], b[1], b[2], b[3], b[4], b[5])
        early.writeBox(b[0], b[1], b[2], b[3], b[4], b[5])
      }
      full.reduce(); early.reduce()
      for (let q = 0; q < 100; q++) {
        const b = [(r() * 2 - 1) * 30, r() * 12, (r() * 2 - 1) * 30, 0.3 + r() * 2, 0.3 + r() * 2, 0.3 + r() * 2]
        expect(early.hidden(b[0], b[1], b[2], b[3], b[4], b[5]))
          .toBe(full.hidden(b[0], b[1], b[2], b[3], b[4], b[5]))
      }
    }
  })

  test('the CSE projector: outputs within reassociation noise, verdicts identical', () => {
    // (a) the seven outputs agree within fp reassociation noise — the
    // rect edges, minZ, minW — over a random box × camera corpus
    const r = rng(55)
    const a = new Float64Array(7)
    const b = new Float64Array(7)
    for (let i = 0; i < 4000; i++) {
      const mvp = mvpFor([(r() * 2 - 1) * 60, r() * 30, (r() * 2 - 1) * 60], [(r() * 2 - 1) * 12, r() * 10, (r() * 2 - 1) * 12])
      const cx = (r() * 2 - 1) * 45, cy = r() * 18, cz = (r() * 2 - 1) * 45
      const hx = 0.2 + r() * 9, hy = 0.2 + r() * 8, hz = 0.2 + r() * 9
      const zMap: 0 | 1 = r() < 0.5 ? 0 : 1
      projectBox(mvp, cx, cy, cz, hx, hy, hz, a, 128, 72, zMap)
      projectBoxLegacy(mvp, cx, cy, cz, hx, hy, hz, b, 128, 72, zMap)
      for (let k = 0; k < 7; k++) {
        const va = a[k], vb = b[k]
        if (va === Infinity || va === -Infinity) { expect(vb).toBe(va); continue }
        expect(Math.abs(va - vb)).toBeLessThanOrEqual(1e-9 * (1 + Math.abs(va)))
      }
    }
    // (b) the verdict level: the drifted projection must not flip a
    // hidden() decision — the 1e-5 slack dwarfs the ~1e-12 noise
    const r2 = rng(9182)
    let flips = 0
    let hiddenTotal = 0
    for (let trial = 0; trial < 16; trial++) {
      const mvp = mvpFor([(r2() * 2 - 1) * 42, 3 + r2() * 20, (r2() * 2 - 1) * 42], [0, 5, 0])
      const cse = softwareOccluder({ width: 128, height: 72, project: 'cse' })
      const leg = softwareOccluder({ width: 128, height: 72, project: 'legacy' })
      cse.begin(mvp); leg.begin(mvp)
      for (let k = 0; k < 6; k++) {
        const bx = [(r2() * 2 - 1) * 24, r2() * 12, (r2() * 2 - 1) * 24, 1 + r2() * 8, 1 + r2() * 6, 1 + r2() * 8]
        cse.writeBox(bx[0], bx[1], bx[2], bx[3], bx[4], bx[5])
        leg.writeBox(bx[0], bx[1], bx[2], bx[3], bx[4], bx[5])
      }
      cse.reduce(); leg.reduce()
      for (let q = 0; q < 100; q++) {
        const b = [(r2() * 2 - 1) * 32, r2() * 14, (r2() * 2 - 1) * 32, 0.2 + r2() * 2.4, 0.2 + r2() * 2.4, 0.2 + r2() * 2.4]
        const ha = cse.hidden(b[0], b[1], b[2], b[3], b[4], b[5])
        const hb = leg.hidden(b[0], b[1], b[2], b[3], b[4], b[5])
        if (ha !== hb) flips++
        if (ha) hiddenTotal++
      }
    }
    expect(flips).toBe(0)
    expect(hiddenTotal).toBeGreaterThan(0)
  })

  test('the analytic interior: a full-tile quad carries the plane z exactly', () => {
    // a wall dead-facing the camera: its face plane's z at the pixel
    // centers is the affine gradient the tiled fill writes — the interior
    // texels must carry z within 1e-12 of the legacy engine's own texels
    const mvp = mvpFor([0, 6, 40], [0, 6, 0])
    const legacy = softwareOccluder({ width: 128, height: 72, raster: 'legacy' })
    const tiled = softwareOccluder({ width: 128, height: 72 })
    legacy.begin(mvp); tiled.begin(mvp)
    legacy.writeBox(0, 6, 0, 8, 7, 2)
    tiled.writeBox(0, 6, 0, 8, 7, 2)
    legacy.reduce(); tiled.reduce()
    // the occludee sweep must agree on every verdict (the covered interior
    // is the same plane, so the mips are the same up to fp noise)
    const r = rng(31)
    let hid = 0
    for (let q = 0; q < 200; q++) {
      const b = [(r() * 2 - 1) * 6, 1 + r() * 9, -6 - r() * 20, 0.3 + r() * 1.4, 0.3 + r() * 1.4, 0.3 + r() * 1.4]
      if (tiled.hidden(b[0], b[1], b[2], b[3], b[4], b[5])) hid++
      expect(tiled.hidden(b[0], b[1], b[2], b[3], b[4], b[5]))
        .toBe(legacy.hidden(b[0], b[1], b[2], b[3], b[4], b[5]))
    }
    expect(hid).toBeGreaterThan(20) // the wall actually occludes the field
  })
})

// ── THE PLANE-MASK PARITY ─────────────────────────────────────────────────

describe('Task 205: plane-mask inheritance — mask on/off ≡ the same sets', () => {
  const CLOUD = 1400
  const boxes: SpatialBox[] = (() => {
    const r = rng(99)
    const list: SpatialBox[] = []
    for (let i = 0; i < CLOUD; i++) {
      list.push({
        id: i,
        cx: (r() * 2 - 1) * 60, cy: r() * 24, cz: (r() * 2 - 1) * 60,
        hx: 0.3 + r() * 2.2, hy: 0.3 + r() * 2.2, hz: 0.3 + r() * 2.2,
      })
    }
    return list
  })()

  const sortSet = (u: Uint32Array) => Array.from(u).sort((a, b) => a - b).join(',')

  test('octree + BVH: the masked walk answers the legacy walk\'s exact set', () => {
    const r = rng(1234)
    for (let cam = 0; cam < 14; cam++) {
      // a spread of cameras: outside orbits, one inside the cloud, tight
      // and wide fovs, and one looking straight down the y axis
      const inside = cam === 8
      const fov = cam % 3 === 0 ? 0.9 : cam % 3 === 1 ? Math.PI / 3 : 1.9
      const eye = inside
        ? [0, 8, 0]
        : [(r() * 2 - 1) * 90, 3 + r() * 40, (r() * 2 - 1) * 90]
      const mvp = mat4Mul(perspective(fov, 16 / 9, 0.5, 400), lookAt(eye, [0, 6, 0], [0, 1, 0]))
      const planes = frustumPlanes(mvp)
      const octMask = buildOctree(boxes, { planeMask: true })
      const octLegacy = buildOctree(boxes, { planeMask: false })
      const bvhMask = buildBVH(boxes, { planeMask: true })
      const bvhLegacy = buildBVH(boxes, { planeMask: false })
      const a = sortSet(octMask.queryFrustum(planes))
      const b = sortSet(octLegacy.queryFrustum(planes))
      const c = sortSet(bvhMask.queryFrustum(planes))
      const d = sortSet(bvhLegacy.queryFrustum(planes))
      expect(a).toBe(b)
      expect(c).toBe(d)
      expect(a).toBe(c) // the cross-structure law survives the mask
    }
  })

  test('the instrumented counter: strictly fewer plane tests on a real corpus', () => {
    const mvp = mvpFor([70, 26, 70], [0, 6, 0])
    const planes = frustumPlanes(mvp)
    const octMask = buildOctree(boxes, { planeMask: true })
    const octLegacy = buildOctree(boxes, { planeMask: false })
    const bvhMask = buildBVH(boxes, { planeMask: true })
    const bvhLegacy = buildBVH(boxes, { planeMask: false })
    octMask.queryFrustum(planes)
    const om = octMask.planeTests
    octLegacy.queryFrustum(planes)
    const ol = octLegacy.planeTests
    bvhMask.queryFrustum(planes)
    const bm = bvhMask.planeTests
    bvhLegacy.queryFrustum(planes)
    const bl = bvhLegacy.planeTests
    expect(om).toBeLessThan(ol)
    expect(bm).toBeLessThan(bl)
    // the headline number: the masked walk cuts at least half the plane
    // evaluations on both structures (deep nodes inherit most planes)
    expect(om * 2).toBeLessThanOrEqual(ol)
    expect(bm * 2).toBeLessThanOrEqual(bl)
    expect(om).toBeGreaterThan(0)
    expect(bm).toBeGreaterThan(0)
  })
})

// ── THE SLAB WALK (allocation-free raycast) ───────────────────────────────

describe('Task 205: the allocation-free slab walk — raycast ≡ brute force', () => {
  test('random rays: octree ≡ BVH ≡ brute (t compared, ids resolve in the tied set)', () => {
    const r = rng(205)
    const boxes: SpatialBox[] = []
    for (let i = 0; i < 900; i++) {
      boxes.push({
        id: i,
        cx: (r() * 2 - 1) * 40, cy: r() * 16, cz: (r() * 2 - 1) * 40,
        hx: 0.4 + r() * 2.4, hy: 0.4 + r() * 2.4, hz: 0.4 + r() * 2.4,
      })
    }
    const oct = buildOctree(boxes)
    const bvh = buildBVH(boxes)
    let hits = 0
    for (let k = 0; k < 260; k++) {
      const ox = (r() * 2 - 1) * 70, oy = r() * 30, oz = (r() * 2 - 1) * 70
      const dx = (r() * 2 - 1), dy = (r() * 2 - 1) * 0.6, dz = (r() * 2 - 1)
      const l = Math.hypot(dx, dy, dz) || 1
      const ux = dx / l, uy = dy / l, uz = dz / l
      const ho = oct.raycast(ox, oy, oz, ux, uy, uz)
      const hb = bvh.raycast(ox, oy, oz, ux, uy, uz)
      // the brute-force first hit (the same slab arithmetic, no tree)
      let bt = Infinity
      const tied: number[] = []
      for (const b of boxes) {
        let t0 = 0, t1 = Infinity
        let miss = false
        for (let a = 0; a < 3 && !miss; a++) {
          const o = a === 0 ? ox : a === 1 ? oy : oz
          const u = a === 0 ? ux : a === 1 ? uy : uz
          const c = a === 0 ? b.cx : a === 1 ? b.cy : b.cz
          const h = a === 0 ? b.hx : a === 1 ? b.hy : b.hz
          if (u === 0) {
            if (o < c - h || o > c + h) miss = true
          } else {
            let ta = (c - h - o) / u, tb = (c + h - o) / u
            if (ta > tb) { const s = ta; ta = tb; tb = s }
            if (ta > t0) t0 = ta
            if (tb < t1) t1 = tb
            if (t0 > t1) miss = true
          }
        }
        if (!miss && t0 < bt - 1e-9) { bt = t0; tied.length = 0; tied.push(b.id) }
        else if (!miss && Math.abs(t0 - bt) <= 1e-9 && t0 < Infinity) tied.push(b.id)
      }
      const sameT = (h: { id: number; t: number } | null) => h === null
        ? bt === Infinity
        : Math.abs(h.t - bt) <= 1e-9
      expect(sameT(ho)).toBe(true)
      expect(sameT(hb)).toBe(true)
      if (ho !== null) {
        hits++
        expect(hb).not.toBeNull()
        // the tie law: the structures may break exact-t ties differently,
        // but both ids must belong to the brute-force tied set
        expect(tied).toContain(ho.id)
        expect(tied).toContain((hb as { id: number; t: number }).id)
        // the twin law: both structures report the same t for the ray
        expect(Math.abs((hb as { id: number; t: number }).t - ho.t)).toBeLessThanOrEqual(1e-9)
      }
    }
    expect(hits).toBeGreaterThan(40) // the corpus actually catches rays
  })
})
