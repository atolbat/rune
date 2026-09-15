/**
 * task213.test.ts — THE KIT'S OWN SoA ROUND, pinned.
 *
 * The culling kit's storage went flat (one interleaved f64 row per box,
 * row indices in the leaves/layout/overflow/lane) and its front door
 * grew the RecordView every other brick already spoke. The proof shape
 * here is BIT-IDENTITY: the records-built trees must answer with the
 * EXACT arrays (order included), the exact stats and the exact
 * planeTests counters of their object-built twins — a permutation of
 * the storage may never permute an answer.
 */
import { describe, expect, test } from 'bun:test'
import {
  buildOctree, buildBVH, buildOctreeRecords, buildBVHRecords,
  aabbOutsideFrustum, frustumPlanes,
} from '../src/spatial.ts'
import type { SpatialBox, SpatialIndex } from '../src/spatial.ts'
import { recordView } from '../src/culling.ts'
import type { RecordView } from '../src/culling.ts'

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

// ── the fixtures ──────────────────────────────────────────────────────────
function makeBoxes(n: number, seed: number): SpatialBox[] {
  const r = rng(seed)
  // f32-exact values (Math.fround): the records view is a Float32Array —
  // the object twins must carry THE SAME numbers for bit-identity to mean
  // anything (arbitrary f64s would round differently in the words)
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    cx: Math.fround((r() * 2 - 1) * 60),
    cy: Math.fround(r() * 20),
    cz: Math.fround((r() * 2 - 1) * 66),
    hx: Math.fround(0.1 + r() * 5),
    hy: Math.fround(0.1 + r() * 5),
    hz: Math.fround(0.1 + r() * 5),
  }))
}

/** The same boxes as a POISONED strided record region: the six AABB words
 *  ride at [centerAt, centerAt+3) inside a stride-9 record, everything
 *  else NaN — a builder that reads one word off answers NaN geometry and
 *  every honest gate below fails loudly. */
function makeView(boxes: readonly SpatialBox[], stride = 9, centerAt = 2, base = 5): { words: Float32Array; view: RecordView } {
  const words = new Float32Array(base + boxes.length * stride + 4).fill(NaN)
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]!
    const o = base + i * stride + centerAt
    words[o] = b.cx; words[o + 1] = b.cy; words[o + 2] = b.cz
    words[o + 3] = b.hx; words[o + 4] = b.hy; words[o + 5] = b.hz
  }
  return { words, view: recordView(words, base, boxes.length, stride, { center: centerAt, half: centerAt + 3 }) }
}

function batteryExact(a: SpatialIndex, b: SpatialIndex, label: string, checkCount = true): void {
  // the answers must be the EXACT arrays — the order is part of the
  // contract when the two trees are the same shape (the storage
  // permutation may never permute a walk)
  const r = rng(21355)
  for (let k = 0; k < 12; k++) {
    const eye: readonly number[] = [(r() * 2 - 1) * 90, r() * 25, (r() * 2 - 1) * 90]
    const tgt: readonly number[] = [(r() * 2 - 1) * 30, r() * 12, (r() * 2 - 1) * 30]
    const planes = frustumPlanes(mvpFor(eye, tgt))
    const fa = a.queryFrustum(planes), fb = b.queryFrustum(planes)
    expect(Array.from(fa)).toEqual(Array.from(fb))
    expect(a.planeTests).toBe(b.planeTests)
  }
  for (let k = 0; k < 16; k++) {
    const x = (r() * 2 - 1) * 60, y = r() * 20, z = (r() * 2 - 1) * 66
    expect(Array.from(a.queryPoint(x, y, z))).toEqual(Array.from(b.queryPoint(x, y, z)))
    const cx = (r() * 2 - 1) * 50, cy = r() * 18, cz = (r() * 2 - 1) * 55, rad = 2 + r() * 40
    expect(Array.from(a.querySphere(cx, cy, cz, rad))).toEqual(Array.from(b.querySphere(cx, cy, cz, rad)))
    const min: [number, number, number] = [(r() * 2 - 1) * 40, r() * 10, (r() * 2 - 1) * 44]
    const max: [number, number, number] = [min[0] + 10 + r() * 40, min[1] + 5 + r() * 15, min[2] + 10 + r() * 40]
    expect(Array.from(a.queryBox(min, max))).toEqual(Array.from(b.queryBox(min, max)))
  }
  for (let k = 0; k < 12; k++) {
    const ang = r() * Math.PI * 2
    const ox = Math.cos(ang) * 110, oy = 5 + r() * 25, oz = Math.sin(ang) * 110
    const dx = -Math.cos(ang), dy = -(r() * 0.6 - 0.3), dz = -Math.sin(ang)
    const ha = a.queryRay(ox, oy, oz, dx, dy, dz), hb = b.queryRay(ox, oy, oz, dx, dy, dz)
    expect(ha.map(h => `${h.id}:${h.t}`)).toEqual(hb.map(h => `${h.id}:${h.t}`))
    const fa = a.raycast(ox, oy, oz, dx, dy, dz), fb = b.raycast(ox, oy, oz, dx, dy, dz)
    expect(fa === null ? 'miss' : `${fa.id}:${fa.t}`).toBe(fb === null ? 'miss' : `${fb.id}:${fb.t}`)
  }
  // the shape itself
  expect(a.stats.nodes).toBe(b.stats.nodes)
  expect(a.stats.leaves).toBe(b.stats.leaves)
  expect(a.stats.depth).toBe(b.stats.depth)
  if (checkCount) expect(a.count).toBe(b.count)
  expect(a.live).toBe(b.live)
  expect(a.kind).toBe(b.kind)
  void label
}

describe('Task 213: the kit\'s SoA round — the RecordView front door, bit-identical', () => {
  test('records-built ≡ object-built: the EXACT answer arrays, stats and planeTests (both structures)', () => {
    for (const seed of [21301, 21302, 21303]) {
      const boxes = makeBoxes(600, seed)
      const { view } = makeView(boxes)
      batteryExact(buildOctreeRecords(view), buildOctree(boxes), `octree seed ${seed}`)
      batteryExact(buildBVHRecords(view), buildBVH(boxes), `bvh seed ${seed}`)
    }
  })

  test('the strided read is surgical: base/stride/offsets honored, poisoned neighbors never bleed', () => {
    const boxes = makeBoxes(300, 21310)
    const stride = 13, centerAt = 4, base = 17
    const { view, words } = makeView(boxes, stride, centerAt, base)
    // every word OUTSIDE the six AABB slots stays NaN — the builders never
    // wrote anything but the kit's own columns
    let nanCount = 0
    for (let i = 0; i < words.length; i++) if (Number.isNaN(words[i])) nanCount++
    expect(nanCount).toBe(words.length - 6 * boxes.length)
    // a mid-record query: every answer is a box whose written words contain
    // the point, and OUR box is among them (random boxes may overlap — the
    // surgical claim is about WHICH words were read, not exclusivity)
    const oct = buildOctreeRecords(view)
    const b = boxes[123]!
    const got = Array.from(oct.queryPoint(b.cx, b.cy, b.cz))
    expect(got.includes(123)).toBe(true)
    for (const id of got) {
      const it = boxes[id]!
      expect(Math.abs(b.cx - it.cx) <= it.hx && Math.abs(b.cy - it.cy) <= it.hy && Math.abs(b.cz - it.cz) <= it.hz).toBe(true)
    }
    const edge = Array.from(oct.queryPoint(b.cx + b.hx * 1.1, b.cy, b.cz))
    expect(edge.includes(123)).toBe(false)
  })

  test('f32 words land in the f64 columns exactly (the GPU kernel\'s own numbers)', () => {
    const boxes = makeBoxes(64, 21311)
    const { view } = makeView(boxes)
    const words = view.words
    // pick a record and verify the SURVIVOR verdict flips exactly at the
    // f32-exact plane the words define (an f64 rounding of the f32 value
    // would move the flip by ULPs — the kit must read the words as-is)
    const oct = buildOctreeRecords(view)
    const b = boxes[7]!
    const eye: readonly number[] = [b.cx + 1000, b.cy, b.cz]
    const tgt: readonly number[] = [b.cx, b.cy, b.cz]
    const planes = frustumPlanes(mvpFor(eye, tgt))
    const want = new Set<number>()
    for (let i = 0; i < boxes.length; i++) {
      const it = boxes[i]!
      if (!aabbOutsideFrustum(planes, it.cx, it.cy, it.cz, it.hx, it.hy, it.hz)) want.add(i)
    }
    const got = new Set(Array.from(oct.queryFrustum(planes)))
    expect(got).toEqual(want)
    void words
  })

  test('the scalar twins: insertBox/updateBox ≡ insert/update (answers, live, lane)', () => {
    const boxes = makeBoxes(200, 21312)
    const a = buildOctree(boxes)
    const b = buildBVH(boxes)
    const r = rng(21313)
    const live: SpatialBox[] = boxes.map(o => ({ ...o }))
    for (let step = 0; step < 400; step++) {
      const id = Math.floor(r() * 260)
      const op = r()
      const g = [live[id]?.cx ?? (r() * 2 - 1) * 60, (live[id]?.cy ?? r() * 20) + (r() * 2 - 1) * 6, (live[id]?.cz ?? (r() * 2 - 1) * 66) + (r() * 2 - 1) * 6, 0.1 + r() * 5, 0.1 + r() * 5, 0.1 + r() * 5] as const
      const box: SpatialBox = { id, cx: g[0], cy: g[1], cz: g[2], hx: g[3], hy: g[4], hz: g[5] }
      // the OBJECT lane on the octree, the SCALAR lane on the BVH — the
      // twins must stay interchangeable
      if (op < 0.45) {
        a.update(box)
        b.updateBox(id, g[0], g[1], g[2], g[3], g[4], g[5])
        live[id] = box
      } else if (op < 0.6) {
        a.remove(id)
        b.remove(id)
        delete live[id]
      } else if (op < 0.8) {
        a.insert(box)
        b.insertBox(id, g[0], g[1], g[2], g[3], g[4], g[5])
        live[id] = box
      } else {
        a.rebuild?.()
        b.rebuild?.()
      }
      expect(a.live).toBe(b.live)
      expect(a.live).toBe(Object.keys(live).length)
      if (step % 37 === 0) {
        const eye: readonly number[] = [(r() * 2 - 1) * 90, r() * 25, (r() * 2 - 1) * 90]
        const tgt: readonly number[] = [(r() * 2 - 1) * 30, r() * 12, (r() * 2 - 1) * 30]
        const planes = frustumPlanes(mvpFor(eye, tgt))
        const want = new Set<number>()
        for (const it of Object.values(live)) {
          if (!aabbOutsideFrustum(planes, it.cx, it.cy, it.cz, it.hx, it.hy, it.hz)) want.add(it.id)
        }
        const sa = new Set(Array.from(a.queryFrustum(planes)))
        const sb = new Set(Array.from(b.queryFrustum(planes)))
        expect(sa).toEqual(want)
        expect(sb).toEqual(want)
      }
    }
  })

  test('the leak law through the SCALAR lane: 48 movers × 1200 updateBox grow NOTHING', () => {
    const boxes = makeBoxes(4096, 21314)
    for (const build of [buildOctree, buildBVH]) {
      const { view } = makeView(boxes)
      const idx = build === buildOctree ? buildOctreeRecords(view) : buildBVHRecords(view)
      const bootNodes = idx.stats.nodes
      const bootLeaves = idx.stats.leaves
      const movers = Array.from({ length: 48 }, (_, d) => (d * 83) % boxes.length)
      const r = rng(21315)
      for (let f = 0; f < 1200; f++) {
        for (const id of movers) {
          const b = boxes[id]!
          idx.updateBox(id, b.cx + Math.sin(f * 0.05 + id) * 8, b.cy + Math.cos(f * 0.04 + id) * 4, b.cz + Math.sin(f * 0.06 + id) * 10, b.hx, b.hy, b.hz)
        }
      }
      expect(idx.stats.nodes).toBe(bootNodes)
      expect(idx.stats.leaves).toBe(bootLeaves)
      expect(idx.stats.lane).toBe(48)
      expect(idx.live).toBe(boxes.length)
      // the fold empties the lane, re-arms clean
      idx.rebuild?.()
      expect(idx.stats.lane).toBe(0)
      expect(idx.live).toBe(boxes.length)
      const eye: readonly number[] = [90, 25, 90]
      const tgt: readonly number[] = [0, 6, 0]
      const planes = frustumPlanes(mvpFor(eye, tgt))
      const lastFrame = 1199
      const want = new Set<number>()
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i]!
        const isMover = movers.includes(i)
        const cx = isMover ? b.cx + Math.sin(lastFrame * 0.05 + i) * 8 : b.cx
        const cy = isMover ? b.cy + Math.cos(lastFrame * 0.04 + i) * 4 : b.cy
        const cz = isMover ? b.cz + Math.sin(lastFrame * 0.06 + i) * 10 : b.cz
        if (!aabbOutsideFrustum(planes, cx, cy, cz, b.hx, b.hy, b.hz)) want.add(i)
      }
      expect(new Set(Array.from(idx.queryFrustum(planes)))).toEqual(want)
    }
  })

  test('the fold COMPACTS: removes shrink the tree and the answers stay honest', () => {
    const boxes = makeBoxes(512, 21316)
    const { view } = makeView(boxes)
    const oct = buildOctreeRecords(view)
    const bvh = buildBVHRecords(view)
    const survivors = boxes.filter((_, i) => i % 3 !== 0)
    for (let i = 0; i < boxes.length; i += 3) { oct.remove(i); bvh.remove(i) }
    expect(oct.live).toBe(survivors.length)
    expect(bvh.live).toBe(survivors.length)
    oct.rebuild?.()
    bvh.rebuild?.()
    expect(oct.live).toBe(survivors.length)
    expect(bvh.live).toBe(survivors.length)
    // after the fold the compacted trees are ordinary fresh trees over the
    // live set — a second fold is a no-op shape-wise, and the object twin
    // of the same live set must answer identically (order included: both
    // are fresh builds over the same first-touch order)
    const octLive = buildOctree(survivors)
    batteryExact(oct, octLive, 'octree post-fold', false)
    const bvhLive = buildBVH(survivors)
    batteryExact(bvh, bvhLive, 'bvh post-fold', false)
  })

  test('an empty view builds honest empty structures', () => {
    const { view } = makeView([])
    const oct = buildOctreeRecords(view)
    const bvh = buildBVHRecords(view)
    const planes = frustumPlanes(mvpFor([10, 10, 10], [0, 0, 0]))
    expect(oct.queryFrustum(planes).length).toBe(0)
    expect(bvh.queryFrustum(planes).length).toBe(0)
    expect(oct.raycast(0, 0, 0, 1, 0, 0)).toBeNull()
    expect(bvh.raycast(0, 0, 0, 1, 0, 0)).toBeNull()
    expect(oct.live).toBe(0)
    expect(bvh.live).toBe(0)
    // the empty structure still takes dynamics
    oct.insertBox(3, 1, 2, 3, 0.5, 0.5, 0.5)
    bvh.insertBox(3, 1, 2, 3, 0.5, 0.5, 0.5)
    expect(Array.from(oct.queryPoint(1, 2, 3))).toEqual([3])
    expect(Array.from(bvh.queryPoint(1, 2, 3))).toEqual([3])
  })

  test('the id contract fails loud: fractional, negative and >int32 ids throw at the door', () => {
    const boxes = makeBoxes(8, 21317)
    const oct = buildOctree(boxes)
    const bvh = buildBVH(boxes)
    for (const bad of [1.5, -1, 2 ** 31, NaN]) {
      expect(() => oct.insert({ id: bad, cx: 0, cy: 0, cz: 0, hx: 1, hy: 1, hz: 1 })).toThrow(/non-negative int32/)
      expect(() => bvh.insertBox(bad, 0, 0, 0, 1, 1, 1)).toThrow(/non-negative int32/)
      expect(() => buildOctree([{ id: bad, cx: 0, cy: 0, cz: 0, hx: 1, hy: 1, hz: 1 }])).toThrow(/non-negative int32/)
    }
    // the int32 ceiling itself is fine
    oct.insertBox(2 ** 31 - 1, 0, 0, 0, 1, 1, 1)
    expect(oct.live).toBe(boxes.length + 1)
  })
})
