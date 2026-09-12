import { test, expect, describe, it } from 'bun:test'
import {
  createParticles,
  createParticleSystem,
  createSpawner,
  createRamp,
  sampleRamp,
  packInstances,
  packInstancesPainter,
  decodeInstanceRecord,
  f32ToF16Bits,
  f16BitsToF32,
  packHalfPair,
  INSTANCE_STRIDE,
  INSTANCE_LAYOUT,
  INSTANCE_FIELDS,
  type DecodedRecord,
  type Ramp,
  gpuSimWgsl,
  gpuSortWgsl,
  gpuSimGlPackGlsl,
} from '../src/index.ts'
import type { SpawnRecord } from '../src/index.ts'

/**
 * Task 183 — THE PACKED RECORD (the f16/u16 tier): 9 words / 36 bytes, down
 * from 16 floats / 64 (−43.75% of the upload, the GPU-tier record stores
 * and the painter staging).
 *
 * The contract under test:
 *   1. THE F16 QUANTIZER — NaN→+0, |v|>65504→±65504 (clamp, never ±∞),
 *      |v|<2^-14→±0 (flush — no subnormal halves ever stored), else RNE.
 *   2. THE THREE-DIALECT BIT CONTRACT — the JS packer, the WGSL pack
 *      kernel (q1 guards + pack2x16float), and the GLSL TF twin
 *      (bbPackHalf) produce IDENTICAL bits. The GLSL body is a pure
 *      function of one float — this suite ports it VERBATIM to JS and
 *      pins the bitwise equality over a battery (the WGSL side guards
 *      then delegates to pack2x16float's RNE — the same arithmetic the
 *      JS packer performs on the guarded domain).
 *   3. THE RECORD LAYOUT — pos/age native-exact; vel/color/half/seed
 *      quantized; the atlas frame EXACT (u16); the derived phase/origin
 *      documented in INSTANCE_FIELDS.
 *   4. THE DOMAIN GUARDS — the u16 frame's sheet cap (u×v ≤ 65536)
 *      rejects loudly; the zero record decodes degenerate (the GPU
 *      tiers' cull sentinel).
 */

// ─── the f16 quantizer ──────────────────────────────────────────────────────

describe('Task 183 — f32ToF16Bits (the quantizer contract)', () => {
  it('the exact representable values round-trip bit-exactly', () => {
    // powers of two, the f16-exact fractions, the max normal, ±0
    const exact = [0, 1, 2, 4, 0.5, 0.25, 1 / 1024, 2 ** -14, 65504, 2048, 1 + 1 / 1024, 1.9990234375, -0, -1, -65504, -(2 ** -14)]
    for (const v of exact) {
      const bits = f32ToF16Bits(v)
      expect(f16BitsToF32(bits)).toBe(v)
    }
    // the canonical bit patterns
    expect(f32ToF16Bits(0)).toBe(0x0000)
    expect(f32ToF16Bits(-0)).toBe(0x8000)
    expect(f32ToF16Bits(1)).toBe(0x3c00)
    expect(f32ToF16Bits(-1)).toBe(0xbc00)
    expect(f32ToF16Bits(2)).toBe(0x4000)
    expect(f32ToF16Bits(65504)).toBe(0x7bff)
    expect(f32ToF16Bits(2 ** -14)).toBe(0x0400) // the smallest normal — NOT flushed
  })

  it('RNE: the ties round to the EVEN mantissa, the in-betweens to the nearer', () => {
    // the exact tie between 1.0 (M=0, even) and 1+2^-10 (M=1, odd) → 1.0
    expect(f32ToF16Bits(1 + 2 ** -11)).toBe(0x3c00)
    // a hair above the tie → M=1
    expect(f32ToF16Bits(1 + 2 ** -11 + 2 ** -20)).toBe(0x3c01)
    // the exact tie between M=1 (odd) and M=2 (even) → M=2
    expect(f32ToF16Bits(1 + 3 * 2 ** -11)).toBe(0x3c02)
    // a hair below → M=1
    expect(f32ToF16Bits(1 + 3 * 2 ** -11 - 2 ** -20)).toBe(0x3c01)
    // the binade top: 1.99951171875 ties 1.9990234375 (M=0x3FF, odd) and
    // 2.0 (M=0, even, E+1) → 2.0 (the mantissa carry)
    expect(f32ToF16Bits(1.99951171875)).toBe(0x4000)
    expect(f32ToF16Bits(1.9990234375)).toBe(0x3fff)
  })

  it('RNE: the top-of-mantissa carry lands on the next power of two', () => {
    // E=19 (the 16–32 binade), M=0x3FF (31.984375) + the exact tie →
    // carries to 2^5 = 32
    expect(f32ToF16Bits(31.984375)).toBe(0x4fff) // M=0x3FF, E=19
    expect(f32ToF16Bits(31.9921875)).toBe(0x5000) // the exact tie → carries to 2^5
  })

  it('the flush: |v| < 2^-14 → ±0 (the sign kept); no subnormal halves stored', () => {
    expect(f32ToF16Bits(2 ** -15)).toBe(0x0000) // subnormal territory — flushed
    expect(f32ToF16Bits(-(2 ** -15))).toBe(0x8000)
    expect(f32ToF16Bits(2 ** -25)).toBe(0x0000)
    expect(f32ToF16Bits(1e-30)).toBe(0x0000)
    // every emitted pattern is a normal or a zero: the exponent field of
    // the stored half is never 0-with-mantissa (the decode-side
    // branch-freedom the three dialects rely on)
    for (let i = 0; i < 2000; i++) {
      const v = (i % 2 ? -1 : 1) * 2 ** (Math.random() * 40 - 30) * (1 + Math.random())
      const bits = f32ToF16Bits(v)
      if (bits & 0x7c00) {
        // a normal: the mantissa is arbitrary — fine
      } else {
        expect(bits & 0x03ff).toBe(0) // zero: the mantissa MUST be empty
      }
    }
  })

  it('the clamp: |v| > 65504 → ±65504, never ±∞; NaN → +0', () => {
    expect(f32ToF16Bits(65520)).toBe(0x7bff) // the IEEE overflow midpoint — clamped
    expect(f32ToF16Bits(1e6)).toBe(0x7bff)
    expect(f32ToF16Bits(Infinity)).toBe(0x7bff)
    expect(f32ToF16Bits(-1e6)).toBe(0xfbff)
    expect(f32ToF16Bits(-Infinity)).toBe(0xfbff)
    expect(f32ToF16Bits(NaN)).toBe(0x0000)
    // the packed words never decode to ±∞ (the f32 view of any clamped
    // pair stays finite — the TF diagnostics' NaN scan relies on it)
    const w = packHalfPair(1e9, -1e9)
    expect(Number.isFinite(f16BitsToF32(w & 0xffff))).toBe(true)
    expect(Number.isFinite(f16BitsToF32(w >>> 16))).toBe(true)
  })

  it('the quantization error bound: |Δ|/|v| ≤ 2^-11 for the normals', () => {
    for (let i = 0; i < 5000; i++) {
      const v = (i % 2 ? -1 : 1) * 2 ** (Math.random() * 30 - 5) * (1 + Math.random())
      if (Math.abs(v) < 2 ** -14 || Math.abs(v) > 65504) continue
      const q = f16BitsToF32(f32ToF16Bits(v))
      expect(Math.abs(q - v) / Math.abs(v)).toBeLessThanOrEqual(2 ** -11 + 1e-12)
    }
  })
})

// ─── the three-dialect bit contract ─────────────────────────────────────────

describe('Task 183 — the three-dialect bit contract (JS ≡ GLSL ≡ WGSL)', () => {
  /** The GLSL TF twin's bbPackHalf, ported VERBATIM from gpuSimGl.ts's
   *  PACK_HALF_GLSL (the same operations, the same constants — the source
   *  is pinned textually below; this port pins the ARITHMETIC). */
  function bbPackHalfPort(v: number): number {
    if (v !== v) return 0
    const x = Math.max(-65504, Math.min(65504, v)) // clamp(v, -65504.0, 65504.0)
    const f = new Float32Array([x])
    const u = new Uint32Array(f.buffer)
    const fu = u[0]
    const s = (fu >>> 16) & 0x8000
    if ((fu & 0x7f800000) <= 0x38000000) return s
    let m = (fu & 0x7fffff) + 0x0fff + (((fu & 0x7fffff) >>> 13) & 1)
    let e = ((fu >>> 23) & 0xff) - 112
    if (m >= 0x800000) { m -= 0x800000; e = e + 1 }
    return (s | (e << 10) | (m >>> 13)) >>> 0
  }

  it("the GLSL body arithmetic === the JS packer, bit-for-bit (the battery)", () => {
    // the battery: edges + the subnormal-boundary band [2^-15, 2^-14) —
    // the flush boundary case the random walk can miss
    const battery: number[] = [0, -0, 1, -1, 0.1, 0.2, 0.3, 65504, -65504, 65520, 1e6, -1e6, Infinity, -Infinity, NaN, 2 ** -14, -(2 ** -14), 2 ** -15, 2 ** -25, 3.48e-5, -3.598e-5, 5.9e-5, 6.05e-5, 1.00048828125, 1.00146484375, 31.984375, 31.9921875, 1.99951171875]
    for (let i = 0; i < 20000; i++) {
      battery.push((i % 2 ? -1 : 1) * 2 ** (Math.random() * 44 - 22) * (1 + Math.random() * 3))
    }
    for (const v of battery) {
      expect(bbPackHalfPort(v)).toBe(f32ToF16Bits(v))
    }
  })

  it('the WGSL pack kernel: the q1 guards + array<u32> records + RSTRIDE 9 (both families)', () => {
    for (const src of [gpuSimWgsl(), gpuSortWgsl()]) {
      // the records binding is the WORD store
      expect(src).toContain('var<storage, read_write> records : array<u32>;')
      expect(src).toContain('const RSTRIDE : u32 = 9u;')
      // the quantizer's domain guards — the q1 shape (NaN != NaN, the
      // clamp, the flush), then pack2x16float's RNE on the guarded domain
      expect(src).toContain('fn q1(v: f32) -> f32 {')
      expect(src).toContain('if (x != x) { return 0.0; }')
      expect(src).toContain('if (x > 65504.0) { x = 65504.0; }')
      expect(src).toContain('if (abs(x) < 6.103515625e-5) { return x * 0.0; }')
      expect(src).toContain('pack2x16float(vec2<f32>(q1(a), q1(b)))')
      // the packed writes: the native rows + the pairs + the u16 frame
      expect(src).toContain('records[o] = bitcast<u32>(state[b]);')
      expect(src).toContain('records[o + 3u] = bitcast<u32>(age);')
      expect(src).toContain('q2(state[b + 3u], state[b + 4u]);')
      expect(src).toContain('q2(seed, 0.0) | (u32(fr) << 16u);')
      // the derived fields are GONE from the pack (the material derives
      // them: the old word 11 seed·τ and the u0/v0 mod-math)
      expect(src).not.toContain('records[o + 10u]')
      expect(src).not.toContain('seed * 6.283185307179586')
    }
  })

  it("the GLSL TF twin: bbPackHalf constants mirror the JS packer (the textual pin)", () => {
    const src = gpuSimGlPackGlsl()
    expect(src).toContain('uint bbPackHalf(float v)')
    // the identical constant set — clamp / flush / RNE bias / the exponent delta
    expect(src).toContain('clamp(v, -65504.0, 65504.0)')
    expect(src).toContain('(f & 0x7f800000u) <= 0x38000000u')
    expect(src).toContain('+ 0x0fffu + (((f & 0x7fffffu) >> 13u) & 1u)')
    expect(src).toContain('e = ((f >> 23u) & 0xffu) - 112u;')
    // the record rows: the native v_r0 + the packed v_r1/v_r8
    expect(src).toContain('out vec4 v_r0;')
    expect(src).toContain('out vec4 v_r1;')
    expect(src).toContain('out float v_r8;')
    expect(src).toContain('v_r0 = vec4(s0.x, s0.y, s0.z, age);')
    expect(src).toContain('bbPack2(seed, 0.0) | (uint(fr) << 16u)')
  })
})

// ─── the record layout + the decode ─────────────────────────────────────────

const RAMP: Ramp = createRamp([
  { t: 0, size: 0.4, r: 1, g: 0.9, b: 0.7, a: 0.2 },
  { t: 0.5, size: 1, r: 1, g: 0.95, b: 0.85, a: 1 },
  { t: 1, size: 0.15, r: 0.4, g: 0.6, b: 1, a: 0.1 },
])

const SPAWNER = {
  shape: { kind: 'sphere' as const, origin: [0, 0, 0], radius: [0.05, 0.5] as [number, number] },
  velocity: { mode: 'radial' as const },
  speed: [2.5, 5.5] as [number, number],
  life: [1.2, 2.2] as [number, number],
  size: [0.05, 0.12] as [number, number],
  color: [[1, 1, 1, 1], [0.7, 0.85, 1, 0.8]] as [number[], number[]],
  seed: 183,
}

const DEC: DecodedRecord = { pos: [0, 0, 0], vel: [0, 0, 0], color: [0, 0, 0, 0], par: [0, 0, 0, 0], uv0: [0, 0], frame: 0 }

function makeSystem(count: number): ReturnType<typeof createParticleSystem> {
  const system = createParticleSystem(count)
  const spawner = createSpawner(SPAWNER)
  const out: SpawnRecord = {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size: 1,
    r: 1, g: 1, b: 1, a: 1, seed: 0, tx: NaN, ty: NaN, tz: NaN,
  }
  for (let i = 0; i < count; i++) {
    spawner(i, out)
    system.emit(1, (index, rec) => { Object.assign(rec, out) })
  }
  system.advance(0.6, { gravity: [0, -2, 0], drag: 0.3, turbulence: 0 } as never)
  return system
}

describe('Task 183 — the packed record (the layout + the decode)', () => {
  it('INSTANCE_STRIDE 9 / 36 bytes; the word-attribute layout (rec0/rec1/rec2)', () => {
    expect(INSTANCE_STRIDE).toBe(9)
    expect(INSTANCE_STRIDE * 4).toBe(36)
    expect(INSTANCE_LAYOUT).toEqual({
      rec0: { size: 4, offset: 0 },
      rec1: { size: 4, offset: 4 },
      rec2: { size: 1, offset: 8 },
    })
    // the logical field map
    expect(INSTANCE_FIELDS.pos).toEqual({ size: 3, offset: 0 })
    expect(INSTANCE_FIELDS.age).toEqual({ size: 1, offset: 3 })
    expect(INSTANCE_FIELDS.velHalf.offset).toBe(4)
    expect(INSTANCE_FIELDS.colorHalf.offset).toBe(6)
    expect(INSTANCE_FIELDS.seedFrame.offset).toBe(8)
  })

  it('pos/age are NATIVE (bit-exact); the quantized fields within one f16 rounding', () => {
    const system = makeSystem(256)
    const records = new Float32Array(256 * INSTANCE_STRIDE)
    const n = packInstances(system, records, { ramp: RAMP, tiles: [4, 2], frameJitter: 3 })
    expect(n).toBe(256)
    const f = system.fields
    for (let i = 0; i < 256; i += 17) {
      decodeInstanceRecord(records, i, [4, 2], DEC)
      expect(DEC.pos[0]).toBe(f.px[i]) // NATIVE — bit-exact
      expect(DEC.pos[1]).toBe(f.py[i])
      expect(DEC.pos[2]).toBe(f.pz[i])
      expect(DEC.par[2]).toBe(f.age[i])
      for (const [got, want] of [
        [DEC.vel[0], f.vx[i]], [DEC.vel[1], f.vy[i]], [DEC.vel[2], f.vz[i]],
        [DEC.par[3], f.seed[i]],
      ] as [number, number][]) {
        expect(Math.abs(got - want)).toBeLessThanOrEqual(Math.max(1e-6, Math.abs(want) * 6.2e-4))
      }
      // the derived phase: f16(seed)·τ — within the seed's own error bound
      expect(Math.abs(DEC.par[1] - f.seed[i] * 6.283185307179586)).toBeLessThanOrEqual(0.002)
    }
  })

  it('the atlas frame rides word 8 EXACTLY (the u16) — the origin derives to the ulp', () => {
    const system = makeSystem(200)
    const records = new Float32Array(200 * INSTANCE_STRIDE)
    const n = packInstances(system, records, { ramp: RAMP, tiles: [4, 2], frameJitter: 5 })
    const f = system.fields
    const s = new Float32Array(6)
    for (let i = 0; i < n; i += 13) {
      const t = f.life[i] > 0 ? f.age[i] / f.life[i] : 0
      sampleRamp(RAMP, t, s)
      let frame = Math.floor(s[5] + f.seed[i] * 5)
      if (!Number.isFinite(frame)) frame = 0
      if (frame < 0) frame = 0
      if (frame > 7) frame = 7
      decodeInstanceRecord(records, i, [4, 2], DEC)
      expect(DEC.frame).toBe(frame) // EXACT — the u16 index
      expect(DEC.uv0[0]).toBe((frame % 4) / 4)
      expect(DEC.uv0[1]).toBe(Math.floor(frame / 4) / 2)
    }
  })

  it('the sheet cap: u×v > 65536 rejects loudly (the u16 frame domain)', () => {
    const system = makeSystem(4)
    const records = new Float32Array(4 * INSTANCE_STRIDE)
    expect(() => packInstances(system, records, { tiles: [257, 256] })).toThrow('u16')
    expect(() => packInstancesPainter(system, records, {}, [0, 0, 1], {
      records: new Float32Array(4 * INSTANCE_STRIDE), k: new Uint32Array(4), kAlt: new Uint32Array(4), iAlt: new Int32Array(4), perm: new Int32Array(4),
    })).not.toThrow() // no tiles — no guard trip
    // the boundary itself passes (65536 frames exactly)
    expect(() => packInstances(system, records, { tiles: [256, 256] })).not.toThrow()
  })

  it("the ZERO record decodes degenerate (the GPU tiers cull sentinel)", () => {
    const zero = new Float32Array(INSTANCE_STRIDE) // all-zero words
    decodeInstanceRecord(zero, 0, [1, 1], DEC)
    expect(DEC.par[0]).toBe(0) // half extent 0 — draws nothing
    expect(DEC.pos[0]).toBe(0)
    expect(DEC.frame).toBe(0)
    expect(DEC.uv0[0]).toBe(0)
  })

  it('the pack survives pathological fields (NaN/overflow clamp to the contract)', () => {
    const system = makeSystem(8)
    const f = system.fields
    // poison: NaN velocity + NaN color + a 1e7 magnitude
    f.vx[0] = NaN; f.cr[1] = NaN; f.vy[2] = 1e7; f.cb[3] = -1e9
    const records = new Float32Array(8 * INSTANCE_STRIDE)
    const n = packInstances(system, records, { ramp: RAMP })
    expect(n).toBe(8)
    decodeInstanceRecord(records, 0, [1, 1], DEC)
    expect(DEC.vel[0]).toBe(0) // NaN → +0
    decodeInstanceRecord(records, 1, [1, 1], DEC)
    expect(DEC.color[0]).toBe(0)
    decodeInstanceRecord(records, 2, [1, 1], DEC)
    expect(DEC.vel[1]).toBe(65504) // the clamp — a finite well-defined value
    decodeInstanceRecord(records, 3, [1, 1], DEC)
    expect(DEC.color[2]).toBe(-65504)
    // every packed word's f32 view stays FINITE (the clamp keeps the pair
    // words' exponents below the NaN range — the TF diagnostics rely on it)
    for (let i = 0; i < 8; i++) {
      for (let k = 4; k < 9; k++) expect(Number.isFinite(records[i * INSTANCE_STRIDE + k])).toBe(true)
    }
  })

  it('the facade packs the 36-byte records (draw: instance end-to-end)', () => {
    const ps = createParticles({
      capacity: 300,
      rate: 4000,
      spawner: SPAWNER,
      ramp: RAMP,
      render: { kind: 'billboard', draw: 'instance', tiles: [2, 2] },
    })
    for (let k = 0; k < 20; k++) ps.advance(1 / 60)
    const v = ps.view({ right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, -1] })
    expect(v.draw).toBe('instance')
    expect(v.stride).toBe(INSTANCE_STRIDE)
    expect(v.vertices.length).toBe(300 * INSTANCE_STRIDE)
    expect(v.instanceLayout!.rec2.offset).toBe(8)
    // the word attributes' binding sizes: 4/4/1 at the word offsets
    expect(v.instanceLayout!.rec0.size).toBe(4)
    expect(v.instanceLayout!.rec1.size).toBe(4)
    expect(v.instanceLayout!.rec2.size).toBe(1)
  })
})
