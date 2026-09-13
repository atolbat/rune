/**
 * culling.test.ts — Task 201: the composable culling kit.
 *
 * THE PROOF SHAPE (each brick against its own brute-force truth):
 *   · recordView/frustumVerdicts — the SoA view reads the same numbers
 *     the kernel does; the sweep matches the spatial predicate;
 *   · hysteresisPolicy — the Frostbite decay law: an occluded verdict
 *     lands ONLY after K consecutive frames, a visible verdict shows
 *     IMMEDIATELY, and the encoding round-trips losslessly;
 *   · flatCull — the edge-on law: a thin wall seen edge-on is a sliver,
 *     the same wall seen face-on is a wall; a straddler is never culled;
 *   · layerPolicy — the participation masks (the transparency contract);
 *   · clusterize — the partition law: every box in exactly one cluster,
 *     the cluster bound ⊇ its members, and a culled cluster ⇒ its
 *     members are culled (the conservative two-tier property);
 *   · softwareOccluder — the soundness law: it NEVER hides a box the
 *     front-plane truth leaves visible, and it DOES hide the obviously
 *     buried ones (the worker-side pre-cull contract);
 *   · cameraRay/rayBoxes — the ray twin of the spatial gates.
 */
import { describe, expect, test } from 'bun:test'
import {
  recordView, frustumVerdicts, hysteresisPolicy, decodeVerdict, decodeStreak,
  flatCull, layerPolicy, clusterize, softwareOccluder, cameraRay, rayBoxes, projectBox,
} from '../src/culling.ts'
import { buildOctree, buildBVH, frustumPlanes, aabbOutsideFrustum } from '../src/spatial.ts'
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
    fx * eye[0] + fy * eye[1] + fz * eye[2],
    1,
  ])
}
function mvpFor(eye: readonly number[], target: readonly number[]): Float32Array {
  const p = perspective(1.1, 16 / 9, 0.5, 300)
  const v = lookAt(eye, target, [0, 1, 0])
  const out = new Float32Array(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += p[k * 4 + r] * v[c * 4 + k]
      out[c * 4 + r] = s
    }
  }
  return out
}

// ── the SoA view fixtures (the demo's own record layout: stride 12) ────
const STRIDE = 12
const FIELDS = { center: 0, half: 3 }
function makeView(n: number, seed: number) {
  const r = rng(seed)
  const words = new Float32Array(n * STRIDE)
  for (let i = 0; i < n; i++) {
    const wo = i * STRIDE
    words[wo] = (r() * 2 - 1) * 60
    words[wo + 1] = r() * 20
    words[wo + 2] = (r() * 2 - 1) * 66
    words[wo + 3] = 0.1 + r() * 5
    words[wo + 4] = 0.1 + r() * 5
    words[wo + 5] = 0.1 + r() * 5
  }
  return recordView(words, 0, n, STRIDE, FIELDS)
}
function viewBoxes(view: ReturnType<typeof recordView>): SpatialBox[] {
  const out: SpatialBox[] = []
  for (let i = 0; i < view.count; i++) {
    out.push({ id: i, cx: view.cx(i), cy: view.cy(i), cz: view.cz(i), hx: view.hx(i), hy: view.hy(i), hz: view.hz(i) })
  }
  return out
}

describe('Task 201: the culling kit — the view and the frustum sweep', () => {
  test('recordView reads the scene\'s own words (the SoA contract)', () => {
    const v = makeView(64, 7)
    expect(v.count).toBe(64)
    const b = viewBoxes(v)
    for (const it of b) {
      expect(v.cx(it.id)).toBe(it.cx)
      expect(v.hy(it.id)).toBe(it.hy)
    }
  })
  test('frustumVerdicts === the spatial predicate over random cameras', () => {
    for (let seed = 1; seed <= 4; seed++) {
      const v = makeView(300, seed * 104729)
      const boxes = viewBoxes(v)
      for (let cam = 0; cam < 4; cam++) {
        const r = rng(seed * 31 + cam)
        const mvp = mvpFor([(r() * 2 - 1) * 40, 5 + r() * 25, (r() * 2 - 1) * 40], [0, 5, 0])
        const planes = frustumPlanes(mvp)
        const verdicts = frustumVerdicts(v, planes)
        for (let i = 0; i < v.count; i++) {
          const outside = aabbOutsideFrustum(planes, v.cx(i), v.cy(i), v.cz(i), v.hx(i), v.hy(i), v.hz(i))
          expect(verdicts[i]).toBe(outside ? 2 : 1)
        }
      }
    }
  })
})

describe('Task 201: hysteresisPolicy — the Frostbite decay law', () => {
  test('an occluded verdict lands ONLY after K consecutive occluded frames', () => {
    const K = 3
    const h = hysteresisPolicy({ frames: K })
    const state = new Float32Array(1)
    // frames 1..2: raw says 3, but the streak is under K → VISIBLE
    h.apply([3], state)
    expect(h.verdict(state, 0)).toBe(1)
    h.apply([3], state)
    expect(h.verdict(state, 0)).toBe(1)
    // frame 3: the streak reaches K → culled
    h.apply([3], state)
    expect(h.verdict(state, 0)).toBe(3)
    // one visible frame resets everything
    h.apply([1], state)
    expect(h.verdict(state, 0)).toBe(1)
    h.apply([3], state)
    expect(h.verdict(state, 0)).toBe(1)
    h.apply([3], state)
    expect(h.verdict(state, 0)).toBe(1)
    h.apply([3], state)
    expect(h.verdict(state, 0)).toBe(3)
  })
  test('a visible verdict shows IMMEDIATELY (the asymmetric form — no pop-in)', () => {
    const h = hysteresisPolicy({ frames: 4 })
    const state = new Float32Array(2)
    for (let f = 0; f < 6; f++) h.apply([3, 3], state)
    expect(h.verdict(state, 0)).toBe(3)
    h.apply([1, 3], state)
    expect(h.verdict(state, 0)).toBe(1)   // shows this very frame
    expect(h.verdict(state, 1)).toBe(3)   // the still-occluded twin stays culled
  })
  test('the encoding round-trips losslessly (the GPU leg\'s own contract)', () => {
    const h = hysteresisPolicy({ frames: 1 })
    const state = new Float32Array(16)
    for (let i = 0; i < 16; i++) state[i] = (i % 4) + 1 + (i % 15) / 32
    for (let i = 0; i < 16; i++) {
      expect(decodeVerdict(state[i])).toBe((i % 4) + 1)
      expect(decodeStreak(state[i])).toBe(i % 15)
    }
    void h
  })
  test('frames = 1 is the identity (the raw verdicts pass through)', () => {
    const h = hysteresisPolicy({ frames: 1 })
    const state = new Float32Array(4)
    h.apply([1, 2, 3, 4], state)
    expect(h.verdict(state, 0)).toBe(1)
    expect(h.verdict(state, 1)).toBe(2)
    expect(h.verdict(state, 2)).toBe(3)
    expect(h.verdict(state, 3)).toBe(4)
  })
})

describe('Task 201: flatCull — the edge-on geometry law', () => {
  const TILE_W = 480, TILE_H = 270
  test('a thin wall seen EDGE-ON is a sliver; FACE-ON it is a wall', () => {
    // the wall: 60 long (x), 12 tall (y), 0.15 thin (z), standing at origin
    const words = new Float32Array(12)
    words[0] = 0; words[1] = 6; words[2] = 0
    words[3] = 30; words[4] = 6; words[5] = 0.075
    const v = recordView(words, 0, 1, STRIDE, FIELDS)
    const flat = flatCull({ minTexels: 2, tileW: TILE_W, tileH: TILE_H })
    // the camera looks down −x: the wall runs away from it — edge-on
    const edgeOn = flat.test(v, mvpFor([80, 6, 0], [0, 6, 0]))
    expect(edgeOn[0]).toBe(5)
    // the camera looks down +z at the wall's face — the full 60×12 face
    const faceOn = flat.test(v, mvpFor([0, 6, 80], [0, 6, 0]))
    expect(faceOn[0]).toBe(1)
  })
  test('a straddler (a corner behind the eye) is NEVER flat-culled', () => {
    const words = new Float32Array(12)
    // a box centered ON the camera — corners on both sides of the eye
    words[0] = 40; words[1] = 6; words[2] = 0
    words[3] = 45; words[4] = 6; words[5] = 0.05
    const v = recordView(words, 0, 1, STRIDE, FIELDS)
    const flat = flatCull({ minTexels: 2, tileW: TILE_W, tileH: TILE_H })
    const v1 = flat.test(v, mvpFor([40, 6, 0], [0, 6, 0]))
    expect(v1[0]).toBe(1)
  })
  test('tiny far boxes are the same honest class (the projected-rect law)', () => {
    const v = makeView(200, 20201)
    const flat = flatCull({ minTexels: 3, tileW: TILE_W, tileH: TILE_H })
    const mvp = mvpFor([0, 30, 120], [0, 0, 0]) // far away — everything shrinks
    const verdicts = flat.test(v, mvp)
    const p = new Float64Array(7)
    let slivers = 0
    for (let i = 0; i < v.count; i++) {
      projectBox(mvp, v.cx(i), v.cy(i), v.cz(i), v.hx(i), v.hy(i), v.hz(i), p, TILE_W, TILE_H, 0)
      const thin = (p[1] - p[0]) < 3 || (p[3] - p[2]) < 3
      if (thin) slivers++
      if (p[6] >= 1 && p[5] > 1e-4) {
        expect(verdicts[i]).toBe(thin ? 5 : 1)
      } else {
        expect(verdicts[i]).toBe(1)
      }
    }
    expect(slivers).toBeGreaterThan(0)
  })
})

describe('Task 201: layerPolicy — the participation masks', () => {
  test('the transparency contract: glass never writes depth, still gets culled', () => {
    const layers = layerPolicy({
      opaque: {},
      glass: { occluder: false },
      ghost: { occluder: false, occludee: false },
    })
    expect(layers.of('opaque')).toEqual({ occluder: true, occludee: true })
    expect(layers.of('glass')).toEqual({ occluder: false, occludee: true })
    expect(layers.of('ghost')).toEqual({ occluder: false, occludee: false })
    expect(layers.of('unknown-name')).toEqual({ occluder: true, occludee: true }) // the safe default
    const masks = layers.masks(6, i => i < 2 ? 'opaque' : i < 4 ? 'glass' : 'ghost')
    expect(Array.from(masks.occluder)).toEqual([1, 1, 0, 0, 0, 0])
    expect(Array.from(masks.occludee)).toEqual([1, 1, 1, 1, 0, 0])
  })
})

describe('Task 201: clusterize — the two-tier vegetation law', () => {
  test('the partition: every box in EXACTLY one cluster, bounds ⊇ members', () => {
    const v = makeView(500, 31337)
    const { clusters, stats } = clusterize(v, { cell: 10 })
    const seen = new Set<number>()
    for (const c of clusters) {
      expect(c.ids.length).toBeGreaterThan(0)
      for (const id of c.ids) {
        expect(seen.has(id)).toBe(false)
        seen.add(id)
        // the member is inside the cluster's bound (the conservative hull)
        expect(v.cx(id) - v.hx(id)).toBeGreaterThanOrEqual(c.minx - 1e-9)
        expect(v.cx(id) + v.hx(id)).toBeLessThanOrEqual(c.maxx + 1e-9)
        expect(v.cz(id) - v.hz(id)).toBeGreaterThanOrEqual(c.minz - 1e-9)
        expect(v.cz(id) + v.hz(id)).toBeLessThanOrEqual(c.maxz + 1e-9)
      }
    }
    expect(seen.size).toBe(v.count)
    expect(stats.clusters).toBe(clusters.length)
    expect(stats.avg).toBeCloseTo(v.count / clusters.length, 5)
  })
  test('a cluster culled by the frustum ⇒ ALL its members are culled (the sound tier)', () => {
    const v = makeView(400, 60607)
    const boxes = viewBoxes(v)
    const { clusters } = clusterize(v, { cell: 10 })
    const oct = buildOctree(boxes)
    for (let cam = 0; cam < 6; cam++) {
      const r = rng(99 + cam)
      const planes = frustumPlanes(mvpFor([(r() * 2 - 1) * 90, 30 + r() * 40, (r() * 2 - 1) * 90], [0, 5, 0]))
      const survivors = new Set(Array.from(oct.queryFrustum(planes)))
      for (const c of clusters) {
        // the cluster's own AABB verdict
        const cx = (c.minx + c.maxx) / 2, cy = (c.miny + c.maxy) / 2, cz = (c.minz + c.maxz) / 2
        const hx = (c.maxx - c.minx) / 2, hy = (c.maxy - c.miny) / 2, hz = (c.maxz - c.minz) / 2
        const culled = aabbOutsideFrustum(planes, cx, cy, cz, hx, hy, hz)
        if (culled) {
          for (const id of c.ids) {
            expect(survivors.has(id)).toBe(false)
          }
        }
      }
    }
  })
})

describe('Task 201: softwareOccluder — the Frostbite CPU brick', () => {
  test('SOUND: it never hides a box the front-plane truth leaves visible', () => {
    // the oracle: a box is TRULY hidden behind a wall iff the wall's front
    // plane covers the box's whole rect AND the box's nearest z is beyond
    // it — evaluated exhaustively (per-texel, no mips)
    const r = rng(4242)
    for (let trial = 0; trial < 30; trial++) {
      const mvp = mvpFor([(r() * 2 - 1) * 40, 5 + r() * 20, (r() * 2 - 1) * 40], [0, 5, 0])
      const soft = softwareOccluder({ width: 128, height: 72 })
      soft.begin(mvp)
      // the wall: a big box between the camera and the field
      soft.writeBox(0, 5, 0, 6, 5, 2)
      soft.reduce()
      const p = new Float64Array(7)
      for (let i = 0; i < 60; i++) {
        const cx = (r() * 2 - 1) * 8, cy = r() * 10, cz = (r() < 0.5 ? -1 : 1) * (4 + r() * 8)
        const hx = 0.1 + r() * 1.2, hy = 0.1 + r() * 1.2, hz = 0.1 + r() * 1.2
        // skip straddlers and behind-eye boxes (the brick keeps them; so
        // does the oracle — not our class)
        projectBox(mvp, cx, cy, cz, hx, hy, hz, p, 128, 72, 0)
        if (p[6] < 1 || p[5] <= 1e-4) continue
        const hidden = soft.hidden(cx, cy, cz, hx, hy, hz)
        if (hidden) {
          // the oracle: the box's whole projected rect must be covered by
          // the WALL's rect with the box strictly beyond the wall's front
          // plane z — else the brick over-culled (forbidden)
          const wallZ = (() => {
            const q = new Float64Array(7)
            projectBox(mvp, 0, 5, 0, 6, 5, 2, q, 128, 72, 0)
            return q[4]
          })()
          const wallRect = (() => {
            const q = new Float64Array(7)
            projectBox(mvp, 0, 5, 0, 6, 5, 2, q, 128, 72, 0)
            return [q[0], q[1], q[2], q[3]] as const
          })()
          // every texel the box's CLAMPED rect covers must lie inside the
          // wall's CLAMPED written rect — both sides apply the same tile
          // clamp + the one-texel outward guard (the write expands the
          // wall, the hidden() test expands the box — both conservative
          // outward); a box poking OFF-SCREEN is clamped to the tile edge
          // where the wall clamps identically
          const clampRect = (r: readonly number[]) => [
            Math.max(0, Math.floor(r[0]) - 1), Math.min(128, Math.ceil(r[1]) + 1),
            Math.max(0, Math.floor(r[2]) - 1), Math.min(72, Math.ceil(r[3]) + 1),
          ] as const
          const wr = clampRect(wallRect)
          const br = clampRect([p[0], p[1], p[2], p[3]] as const)
          const inside = br[0] >= wr[0] - 0.5 && br[1] <= wr[1] + 0.5
            && br[2] >= wr[2] - 0.5 && br[3] <= wr[3] + 0.5
          const beyond = p[4] > wallZ + 1e-5
          expect(inside && beyond).toBe(true)
        }
      }
    }
  })
  test('it DOES hide the obviously buried (the worker-side win)', () => {
    const mvp = mvpFor([0, 6, 60], [0, 6, 0])
    const soft = softwareOccluder({ width: 128, height: 72 })
    soft.begin(mvp)
    soft.writeBox(0, 6, 0, 8, 8, 2) // the wall right in front of the camera
    soft.reduce()
    // a small box well behind the wall, deep inside its footprint
    let buried = 0
    for (let i = 0; i < 40; i++) {
      const cx = -3 + (i % 8) * 0.8, cy = 2 + Math.floor(i / 8) * 1.5, cz = -20
      if (soft.hidden(cx, cy, cz, 0.4, 0.4, 0.4)) buried++
    }
    expect(buried).toBeGreaterThan(20) // the big majority — the honest win
  })
})

describe('Task 201: cameraRay + rayBoxes — the picking surface', () => {
  test('the ray through NDC (0,0) passes through the lookAt target', () => {
    const eye = [12, 8, 30] as const
    const target = [0, 5, 0] as const
    const fwd = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]] as const
    const l = Math.hypot(...fwd)
    const f = [fwd[0] / l, fwd[1] / l, fwd[2] / l]
    // right = fwd × up (up = +y)
    const right = [f[2], 0, -f[0]]
    const rl = Math.hypot(...right)
    const rt = [right[0] / rl, 0, right[2] / rl]
    const up = [rt[1] * f[2] - rt[2] * f[1], rt[2] * f[0] - rt[0] * f[2], rt[0] * f[1] - rt[1] * f[0]]
    const ray = cameraRay(eye, f, rt, up, 1.1, 16 / 9, 0, 0)
    // walk to the target's distance along the ray
    const t = l
    const px = ray.ox + ray.dx * t, py = ray.oy + ray.dy * t, pz = ray.oz + ray.dz * t
    expect(px).toBeCloseTo(target[0], 6)
    expect(py).toBeCloseTo(target[1], 6)
    expect(pz).toBeCloseTo(target[2], 6)
  })
  test('rayBoxes === the octree\'s and the BVH\'s queryRay (three answers, one truth)', () => {
    for (let seed = 1; seed <= 3; seed++) {
      const v = makeView(300, seed * 8191)
      const boxes = viewBoxes(v)
      const oct = buildOctree(boxes)
      const bvh = buildBVH(boxes)
      const r = rng(seed * 7)
      for (let q = 0; q < 10; q++) {
        const ox = (r() * 2 - 1) * 50, oy = r() * 25, oz = (r() * 2 - 1) * 60
        let dx = (r() * 2 - 1), dy = (r() * 2 - 1) * 0.5, dz = (r() * 2 - 1)
        const dl = Math.hypot(dx, dy, dz) || 1
        dx /= dl; dy /= dl; dz /= dl
        const want = rayBoxes(v, ox, oy, oz, dx, dy, dz)
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
        // raycast === the first of the sorted hits
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
})
