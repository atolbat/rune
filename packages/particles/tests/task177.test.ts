// Task 177 — THE STAGED PAINTER BAKE (@rune/particles instances.ts): the
// sorted instance layer's frame. The shipped shape walked the painter's
// order through the baker — a RANDOM gather over ~14 SoA streams (each
// 4-byte read its own cache line at 100k); the staged shape runs a
// sequential slot-DESCENDING stage (frustum gate + ramp + record +
// flipped key, survivors only), a survivor-count radix (the digit tier:
// 2×16-bit at 8192+, 3×11-bit below), and one 64-byte-record gather.
// Measured in situ: the sorted 100k layer 12.95 → 7.30 ms/frame; the
// half-culled layer 9.5 → 2.5 (the stage culls BEFORE the sort — the
// radix input shrinks to the survivors).
//
// Pinned here:
//   1. THE PARITY GATE — packInstancesPainter ≡ packInstances with the
//      classic comparator order, BYTES and count, across scenes (plain,
//      exact-tie, culled, zero-size, atlas+jitter, ±0) and counts
//      straddling the digit boundary (8191/8192/8193, and above).
//   2. THE CULL×DIGIT COMBINATION — a barely-narrow frustum that keeps
//      >8192 survivors (the 16-bit branch WITH culling) and a tight one
//      (the 11-bit branch with heavy culling).
//   3. THE PREFIX DISCIPLINE — one shared scratch, the live count decays
//      across the boundary downward: exactly the live prefix bakes, no
//      stale tail.
//   4. THE FACADE LEG — the instance draw's view() stream ≡ the manual
//      classic bake (both digit branches), the soup draw unchanged.
//   5. Determinism — the same state twice, the same bytes.

import { describe, expect, it } from 'bun:test'
import { createParticles, createRamp, packInstances, packInstancesPainter, INSTANCE_STRIDE } from '../src/index.ts'
import { frustumPlanes, RADIX_16BIT_MIN, sortBackToFront } from '@rune/core'
import type { CameraBasis, PainterScratch } from '../src/index.ts'

const RAMP = createRamp([
  { t: 0, size: 0.4, r: 1, g: 0.9, b: 0.7, a: 0 },
  { t: 0.5, size: 1, r: 1, g: 0.95, b: 0.85, a: 1 },
  { t: 1, size: 0.15, r: 0.4, g: 0.6, b: 1, a: 0 },
])

const FWD = [0.26726124, 0.53452248, 0.80178373]

function hashRng(seed: number): () => number {
  let s = seed | 0
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    return ((s >>> 0) % 1000003) / 1000003
  }
}

type Flavor = 'plain' | 'ties' | 'zeros' | 'origin'

/** A full SoA source of `n` particles (the etalon's spread), the flavor
 *  adding the pathological cases. */
function source(n: number, seed: number, flavor: Flavor = 'plain') {
  const rnd = hashRng(seed)
  const f: Record<string, Float32Array> = {
    px: new Float32Array(n), py: new Float32Array(n), pz: new Float32Array(n),
    vx: new Float32Array(n), vy: new Float32Array(n), vz: new Float32Array(n),
    age: new Float32Array(n), life: new Float32Array(n), size: new Float32Array(n),
    cr: new Float32Array(n), cg: new Float32Array(n), cb: new Float32Array(n), ca: new Float32Array(n),
    seed: new Float32Array(n),
  }
  for (let i = 0; i < n; i++) {
    f.px[i] = (rnd() * 2 - 1) * 50
    f.py[i] = (rnd() * 2 - 1) * 30
    f.pz[i] = (rnd() * 2 - 1) * 50
    if (flavor === 'origin') { f.px[i] = 0; f.py[i] = 0; f.pz[i] = 0 }
    if (i > 0 && (i & 15) === 0 && flavor === 'ties') { f.px[i] = f.px[i - 1]; f.py[i] = f.py[i - 1]; f.pz[i] = f.pz[i - 1] }
    f.vx[i] = rnd() * 6 - 3; f.vy[i] = rnd() * 6 - 3; f.vz[i] = rnd() * 6 - 3
    f.life[i] = 1.2 + rnd()
    f.age[i] = rnd() * f.life[i]
    f.size[i] = 0.05 + rnd() * 0.07
    if (flavor === 'zeros' && (i % 7) === 3) f.size[i] = 0
    f.cr[i] = rnd(); f.cg[i] = rnd(); f.cb[i] = rnd(); f.ca[i] = 0.5 + rnd() * 0.5
    f.seed[i] = rnd()
  }
  return { count: n, fields: f } as unknown as import('../src/system.ts').ParticleSource & { fields: Record<string, Float32Array> }
}

/** The ortho viewProj of a symmetric box (diagonal — the column-major
 *  layout is unambiguous): the frustum |x| ≤ hx, |y| ≤ hy. */
function orthoVp(hx: number, hy: number): number[] {
  return [1 / hx, 0, 0, 0, 0, 1 / hy, 0, 0, 0, 0, -1 / 2000, 0, 0, 0, 0, 1]
}

function makeScratch(capacity: number): PainterScratch {
  return {
    records: new Float32Array(capacity * INSTANCE_STRIDE),
    k: new Uint32Array(capacity), kAlt: new Uint32Array(capacity), iAlt: new Int32Array(capacity),
    perm: new Int32Array(capacity),
  }
}

/** The classic oracle: sort ALL slots by the comparator, hand packInstances
 *  the order (+ the same frustum) — the shipped pre-177 shape. */
function classicBake(
  sys: import('../src/system.ts').ParticleSource,
  out: Float32Array,
  opts: { frustum?: Float32Array | null; tiles?: readonly [number, number]; frameJitter?: number },
): number {
  const n = sys.count
  const indices = new Int32Array(n)
  const keys = new Float32Array(n)
  sortBackToFront(sys.fields.px, sys.fields.py, sys.fields.pz, n, FWD, indices, keys)
  return packInstances(sys, out, {
    ramp: RAMP, order: indices, frustum: opts.frustum ?? null,
    tiles: opts.tiles, frameJitter: opts.frameJitter,
  })
}

function assertPainterParity(
  sys: import('../src/system.ts').ParticleSource & { fields: Record<string, Float32Array> },
  scratch: PainterScratch,
  opts: { frustum?: Float32Array | null; tiles?: readonly [number, number]; frameJitter?: number },
  label: string,
): number {
  const n = sys.count
  const cap = scratch.records.length / INSTANCE_STRIDE
  const expected = new Float32Array(cap * INSTANCE_STRIDE)
  const got = new Float32Array(cap * INSTANCE_STRIDE)
  const want = classicBake(sys, expected, opts)
  const have = packInstancesPainter(sys, got, {
    ramp: RAMP, frustum: opts.frustum ?? null, tiles: opts.tiles, frameJitter: opts.frameJitter,
  }, FWD, scratch)
  if (have !== want) throw new Error(`${label}: count divergence — staged ${have} vs classic ${want}`)
  for (let i = 0; i < want * INSTANCE_STRIDE; i++) {
    if (got[i] !== expected[i]) {
      throw new Error(`${label}: float ${i} diverged (staged ${got[i]} vs classic ${expected[i]})`)
    }
  }
  return want
}

describe('Task 177 — THE STAGED PAINTER BAKE', () => {
  it('THE PARITY GATE — staged ≡ classic order-walk, bytes and count, across scenes and the digit boundary', () => {
    for (const flavor of ['plain', 'ties', 'zeros', 'origin'] as Flavor[]) {
      for (const n of [1, 2, 3, 100, 513, 4096, 8191, 8192, 8193, 9000]) {
        const sys = source(n, 991, flavor)
        assertPainterParity(sys, makeScratch(n + 8), {}, `flavor=${flavor} n=${n}`)
      }
    }
  })

  it('THE ATLAS SEAM — tiles + frameJitter ride the staged path identically', () => {
    for (const n of [100, 8192, 9000]) {
      const sys = source(n, 4242, 'plain')
      assertPainterParity(sys, makeScratch(n + 8), { tiles: [4, 4], frameJitter: 1 }, `atlas n=${n}`)
    }
  })

  it('THE CULL×DIGIT COMBINATION — the 16-bit branch WITH culling (a barely-narrow window) and the 11-bit branch (a tight one)', () => {
    // the spread is |x| ≤ 50, |y| ≤ 30: the ±48/±29 window culls ~7%
    // (>8192 survivors at n=9000 → the 16-bit staged branch with the
    // frustum live); the ±12/±9 window keeps ~7% (the 11-bit branch,
    // heavy culling — the radix input shrinks to the survivors).
    const n = 9000
    const wide = frustumPlanes(orthoVp(48, 29))
    const tight = frustumPlanes(orthoVp(12, 9))
    const sys = source(n, 7, 'plain')
    const survivorsWide = assertPainterParity(sys, makeScratch(n + 8), { frustum: wide }, 'cull-wide n=9000')
    const survivorsTight = assertPainterParity(sys, makeScratch(n + 8), { frustum: tight }, 'cull-tight n=9000')
    expect(survivorsWide).toBeGreaterThan(RADIX_16BIT_MIN) // the 16-bit branch, culled
    expect(survivorsTight).toBeLessThan(3000) // the 11-bit branch, heavily culled
    expect(survivorsTight).toBeLessThan(survivorsWide)
  })

  it('THE PREFIX DISCIPLINE — one shared scratch, the live count decays across the boundary downward', () => {
    // The facade reuses one capacity-sized scratch while particles die;
    // the staged path must bake exactly the live prefix — a stale tail
    // in records/perm/k would leak into the stream exactly here.
    const cap = 9008
    const sys = source(cap, 5, 'plain')
    const scratch = makeScratch(cap)
    // the decay crosses the digit boundary in both directions, ends at 0
    const seq = [8300, 8192, 8191, 6600, 4900, 8193, 3200, 1500, 0]
    let want = -1
    const live = sys as { count: number }
    for (const count of seq) {
      live.count = count
      want = assertPainterParity(sys, scratch, {}, `prefix count=${count}`)
    }
    expect(want).toBe(0)
  })

  it('THE FACADE LEG, instance — view() ≡ the manual classic bake, both digit branches', () => {
    // Small: the 11-bit staged branch. Large: the 16-bit staged branch —
    // both through the real facade wiring (the shared sort ping-pong as
    // the painter's scratch, sortIndices as perm).
    const BASIS: CameraBasis = { right: [1, 0, 0], up: [0, 1, 0], forward: FWD }
    for (const n of [500, 8300]) {
      const facade = createParticles({
        capacity: n + 32, ramp: RAMP,
        render: { kind: 'billboard', draw: 'instance', sort: true },
      })
      facade.burst(n, {
        shape: { kind: 'point', origin: [0, 0, 0] }, velocity: { mode: 'fixed', dir: [0, 1, 0] },
        speed: [0, 0], life: [30, 30], size: [1, 1], color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 11,
      })
      const rnd = hashRng(31)
      for (let i = 0; i < n; i++) {
        facade.fields.px[i] = (rnd() * 2 - 1) * 50
        facade.fields.py[i] = (rnd() * 2 - 1) * 30
        facade.fields.pz[i] = (rnd() * 2 - 1) * 50
      }
      const view = facade.view(BASIS)
      expect(view.instanceCount).toBe(n)

      const sys = { count: n, fields: facade.fields }
      const expected = new Float32Array((n + 32) * INSTANCE_STRIDE)
      const packed = classicBake(sys, expected, {})
      expect(packed).toBe(n)
      for (let i = 0; i < n * INSTANCE_STRIDE; i++) {
        if (view.vertices[i] !== expected[i]) {
          throw new Error(`facade instance parity (n=${n}): float ${i} diverged (${view.vertices[i]} vs ${expected[i]})`)
        }
      }
    }
  })

  it('THE FACADE LEG, soup — unchanged: the classic order walk (the core digit tier through the facade)', () => {
    const n = 8300
    const BASIS: CameraBasis = { right: [1, 0, 0], up: [0, 1, 0], forward: FWD }
    const facade = createParticles({
      capacity: n + 32, ramp: RAMP,
      render: { kind: 'billboard', draw: 'soup', sort: true },
    })
    facade.burst(n, {
      shape: { kind: 'point', origin: [0, 0, 0] }, velocity: { mode: 'fixed', dir: [0, 1, 0] },
      speed: [0, 0], life: [30, 30], size: [1, 1], color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 11,
    })
    const rnd = hashRng(31)
    for (let i = 0; i < n; i++) {
      facade.fields.px[i] = (rnd() * 2 - 1) * 50
      facade.fields.py[i] = (rnd() * 2 - 1) * 30
      facade.fields.pz[i] = (rnd() * 2 - 1) * 50
    }
    const view = facade.view(BASIS)
    // The soup path bakes 6 verts × 9 floats per particle — the count is
    // the parity surface here (the byte parity of the soup order is
    // task132/task176's pin; this pin guards the facade's large-count
    // soup route through the NEW core digit branch).
    expect(view.vertexCount).toBe(n * 6)
    expect(view.instanceCount).toBe(0)
    // The first quad's CENTER is the painter's FIRST particle — the max
    // dot(FWD, p): corner offsets cancel pairwise in the quad plane, so
    // (vert0 + vert2) / 2 projected on FWD equals the record's key.
    const SOUP_STRIDE = 9
    const c0x = (view.vertices[0] + view.vertices[2 * SOUP_STRIDE + 0]) / 2
    const c0y = (view.vertices[1] + view.vertices[2 * SOUP_STRIDE + 1]) / 2
    const c0z = (view.vertices[2] + view.vertices[2 * SOUP_STRIDE + 2]) / 2
    let maxKey = -Infinity
    for (let i = 0; i < n; i++) {
      const k = FWD[0] * facade.fields.px[i] + FWD[1] * facade.fields.py[i] + FWD[2] * facade.fields.pz[i]
      if (k > maxKey) maxKey = k
    }
    expect(FWD[0] * c0x + FWD[1] * c0y + FWD[2] * c0z).toBeCloseTo(maxKey, 3)
  })

  it('determinism — the same state twice, the same bytes (the reused scratch cannot drift)', () => {
    const n = 8300
    const sys = source(n, 991, 'plain')
    const scratch = makeScratch(n + 8)
    const a = new Float32Array((n + 8) * INSTANCE_STRIDE)
    const b = new Float32Array((n + 8) * INSTANCE_STRIDE)
    packInstancesPainter(sys, a, { ramp: RAMP }, FWD, scratch)
    packInstancesPainter(sys, b, { ramp: RAMP }, FWD, scratch)
    for (let i = 0; i < n * INSTANCE_STRIDE; i++) {
      if (a[i] !== b[i]) throw new Error(`determinism: float ${i} diverged`)
    }
  })
})
