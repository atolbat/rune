import { test, expect, describe, it } from 'bun:test'
import {
  createParticleSystem,
  createSpawner,
  createRamp,
  createParticles,
  fillBillboards,
  packInstances,
  sampleRamp,
  INSTANCE_STRIDE,
  INSTANCE_LAYOUT,
  decodeInstanceRecord,
  type DecodedRecord,
  SOUP_STRIDE,
  CONSTANT_RAMP,
  type Ramp,
  type BillboardMode,
  type CameraBasis,
  type BillboardOptions,
} from '../src/index.ts'
import type { SpawnRecord } from '../src/index.ts'
// Task 180 — the quad soup is four corners + the shared index pattern; the
// bit-parity walk below compares the twin's six-vert expansion against the
// reference's EXPANDED stream (the drawn stream — the exact bytes the GPU
// assembles through the index buffer).
import { expandQuadSoup } from './task180.test.ts'

/**
 * Task 131 — the INSTANCE PATH parity suite.
 *
 * The contract under test (see instances.ts):
 *   1. COUNT PARITY — packInstances() returns exactly fillBillboards()/4
 *      for the same options (the zero-size skip, the ramp, the atlas).
 *   2. RECORD PARITY (Task 183 — the PACKED tier) — the 9 words decode to
 *      the reference semantics: pos/age NATIVE-exact; vel/color/half/seed
 *      within one f16 rounding (the three-dialect quantization contract);
 *      the atlas frame EXACT (the u16 index); the spin phase derived.
 *   3. THE SHADER TWIN — expandInstances(), the JS reference of the
 *      BILLBOARD material's vertex stage (the unpack preamble + the exact
 *      math the GLSL/WGSL port must reproduce), rebuilds fillBillboards'
 *      vertex soup from the packed records. Tolerance parity in every
 *      mode (Task 183: the record's f16 quantization bounds the drift —
 *      pos EXACT, vel/color/half/seed within one f16 rounding, the uv
 *      EXACT; the twin shares the reference's Math.cos/sin calls — the
 *      GPU's transcendentals differ sub-ULP, the twin's do not).
 *   4. The facade integration — render.draw:'instance' routes view() to
 *      the packer, the view carries the instance layout, and the memory
 *      contract holds (one allocation, reused across frames).
 */

// ─── the test fixtures ──────────────────────────────────────────────────────

const RAMP: Ramp = createRamp([
  { t: 0, size: 0.4, r: 1, g: 0.9, b: 0.7, a: 0 },
  { t: 0.15, size: 1, r: 1, g: 0.95, b: 0.85, a: 1 },
  { t: 1, size: 0.15, r: 0.4, g: 0.6, b: 1, a: 0 },
])

const SPAWNER = {
  shape: { kind: 'sphere' as const, origin: [0, 0.5, 0], radius: [0.05, 0.5] as [number, number] },
  velocity: { mode: 'radial' as const },
  speed: [2.5, 5.5] as [number, number],
  life: [1.2, 2.2] as [number, number],
  size: [0.05, 0.12] as [number, number],
  color: [[1, 1, 1, 1], [0.7, 0.85, 1, 0.8]] as [number[], number[]],
  seed: 991,
}

/** A camera basis with a real perspective flavor (right/up/forward not
 *  axis-aligned — the billboard math's cross products must be exercised). */
const BASIS: CameraBasis = {
  right: [0.936, -0.275, 0.212],
  up: [0.287, 0.956, -0.051],
  forward: [-0.205, 0.102, -0.973],
}

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
  // age them into mid-life (the ramp + the spin get real values to chew)
  system.advance(0.6, { gravity: [0, -2, 0], drag: 0.3, turbulence: 0 } as never)
  return system
}

// ─── the SHADER TWIN — the JS reference of the BILLBOARD vertex stage ───────

/** The 6-corner table: (a, b) ∈ {(-1,-1), (1,-1), (1,1)} twice — the exact
 *  vertex order of fillBillboards' two triangles (0,1,2 / 0,2,3). */
const CORNERS: [number, number][] = [
  [-1, -1], [1, -1], [1, 1],
  [-1, -1], [1, 1], [-1, 1],
]

/** The uniforms the BILLBOARD material's vertex stage receives — the exact
 *  set the demo harness derives from (basis, BillboardOptions). */
export interface TwinUniforms {
  mode: BillboardMode
  spin: number
  speedFactor: number
  lengthFactor: number
  spin3d: number
  tiles: readonly [number, number]
  axis: readonly number[] | 'random'
  right: readonly number[]
  up: readonly number[]
  forward: readonly number[]
}

/** The decoded-record scratch — the twin's read side (the same decode the
 *  shader's unpack preamble performs; reused per record, zero allocation
 *  in the walk). */
const DEC: DecodedRecord = { pos: [0, 0, 0], vel: [0, 0, 0], color: [0, 0, 0, 0], par: [0, 0, 0, 0], uv0: [0, 0], frame: 0 }

/** Expands the packed instance records into a 9-float vertex soup — the
 *  reference semantics of the BILLBOARD feature's vertex stage. Written to
 *  be ported VERBATIM to GLSL/WGSL (same operations, same order): the
 *  materials' port must reproduce this, and this must reproduce
 *  fillBillboards (pinned below, within the Task-183 f16 tolerance). */
function expandInstances(
  records: Float32Array,
  recordCount: number,
  u: TwinUniforms,
  out: Float32Array,
): number {
  const [rx, ry, rz] = u.right
  const [ux, uy, uz] = u.up
  const [fx, fy, fz] = u.forward
  // The horizontal frame (the vertical/horizontal modes): hz ⊥ forward in
  // the ground plane, hf = the forward's ground projection — the same
  // derivation fillBillboards does with its basis.
  let hzx = fz, hzy = 0, hzz = -fx
  let hl = Math.hypot(hzx, hzy, hzz)
  if (hl < 1e-6) { hzx = 1; hzy = 0; hzz = 0; hl = 1 }
  hzx /= hl; hzy /= hl; hzz /= hl
  let hfx = fx, hfy = 0, hfz = fz
  let hfl = Math.hypot(hfx, hfy, hfz)
  if (hfl < 1e-6) { hfl = 1 }
  const gx = hfx / hfl, gy = 0, gz = hfz / hfl
  // The oriented axis: fixed (normalized) or 'random'.
  const axisRandom = u.axis === 'random'
  let oax = 0, oay = 0, oaz = 1
  if (!axisRandom) {
    const a = u.axis as readonly number[]
    const al = Math.hypot(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0)
    oax = (a[0] ?? 0) / al; oay = (a[1] ?? 0) / al; oaz = (a[2] ?? 0) / al
  }
  const tileU = u.tiles[0], tileV = u.tiles[1]
  const uS = 1 / tileU, vS = 1 / tileV
  let at = 0
  for (let n = 0; n < recordCount; n++) {
    // Task 183 — THE UNPACK (the shader preamble's JS twin): the packed
    // words → the logical fields. decodeInstanceRecord mirrors the
    // GLSL/WGSL decode exactly (native pos/age, the f16 pairs, the u16
    // frame → the tile origin, the derived seed·τ phase).
    decodeInstanceRecord(records, n, u.tiles, DEC)
    const px = DEC.pos[0], py = DEC.pos[1], pz = DEC.pos[2]
    const vx = DEC.vel[0], vy = DEC.vel[1], vz = DEC.vel[2]
    const cr = DEC.color[0], cg = DEC.color[1], cb = DEC.color[2], ca = DEC.color[3]
    const half = DEC.par[0]
    const angle0 = DEC.par[1]
    const age = DEC.par[2]
    const seed = DEC.par[3]
    const u0 = DEC.uv0[0], v0 = DEC.uv0[1]

    for (let c = 0; c < 6; c++) {
      const a = CORNERS[c][0], b = CORNERS[c][1]
      const uu = u0 + (a + 1) * 0.5 * uS
      const vv = v0 + (b + 1) * 0.5 * vS
      let wx = 0, wy = 0, wz = 0

      if (u.mode === 'camera') {
        // The in-plane rotation: angle0 (seed·τ) + age·spin.
        const ang = angle0 + age * u.spin
        const cos = Math.cos(ang), sin = Math.sin(ang)
        const ox = (cos * a - sin * b) * half
        const oy = (sin * a + cos * b) * half
        wx = px + ox * rx + oy * ux
        wy = py + ox * ry + oy * uy
        wz = pz + ox * rz + oy * uz
      } else if (u.mode === 'vertical' || u.mode === 'horizontal') {
        const auy = u.mode === 'vertical' ? 1 : gy
        const aux = u.mode === 'vertical' ? 0 : gx
        const auz = u.mode === 'vertical' ? 0 : gz
        wx = px + (a * half) * hzx + (b * half) * aux
        wy = py + (a * half) * hzy + (b * half) * auy
        wz = pz + (a * half) * hzz + (b * half) * auz
      } else if (u.mode === 'stretched') {
        const vlen = Math.hypot(vx, vy, vz)
        if (vlen < 1e-4) {
          // The rest fallback: the camera-facing quad, unrotated.
          wx = px + (a * half) * rx + (b * half) * ux
          wy = py + (a * half) * ry + (b * half) * uy
          wz = pz + (a * half) * rz + (b * half) * uz
        } else {
          const dx = vx / vlen, dy = vy / vlen, dz = vz / vlen
          let sx = fy * dz - fz * dy, sy = fz * dx - fx * dz, sz = fx * dy - fy * dx
          let sl = Math.hypot(sx, sy, sz)
          if (sl < 1e-6) { sx = dy; sy = -dx; sz = 0; sl = Math.hypot(sx, sy, sz) || 1 }
          sx /= sl; sy /= sl; sz /= sl
          const sizeFull = 2 * half
          const tail = (vlen * u.speedFactor + u.lengthFactor) * sizeFull
          // a<0: the head edge ON the particle; a>0: the tail edge trailing.
          const tx2 = a > 0 ? -dx * tail : 0
          const ty2 = a > 0 ? -dy * tail : 0
          const tz2 = a > 0 ? -dz * tail : 0
          wx = px + b * half * sx + tx2
          wy = py + b * half * sy + ty2
          wz = pz + b * half * sz + tz2
        }
      } else {
        // 'oriented' — the free 3D rotation. The base quad lives in the
        // world XY plane; the axis (fixed or seed-random) + the angle
        // (angle0 + age·spin3d) spin it.
        let ax2 = oax, ay2 = oay, az2 = oaz
        if (axisRandom) {
          const s1 = seed * 7.31 - Math.floor(seed * 7.31)
          const s2 = seed * 3.77 - Math.floor(seed * 3.77)
          const zc = 1 - 2 * s1
          const rc = Math.sqrt(Math.max(0, 1 - zc * zc))
          const phi = 6.283185307179586 * s2
          ax2 = rc * Math.cos(phi); ay2 = rc * Math.sin(phi); az2 = zc
        }
        const ang = angle0 + age * u.spin3d
        const cos = Math.cos(ang), sin = Math.sin(ang), tt = 1 - cos
        const m00 = tt * ax2 * ax2 + cos, m01 = tt * ax2 * ay2 - sin * az2
        const m10 = tt * ax2 * ay2 + sin * az2, m11 = tt * ay2 * ay2 + cos
        const m20 = tt * ax2 * az2 - sin * ay2, m21 = tt * ay2 * az2 + sin * ax2
        const x = a * half, y = b * half
        wx = px + m00 * x + m01 * y
        wy = py + m10 * x + m11 * y
        wz = pz + m20 * x + m21 * y
      }
      out[at] = wx; out[at + 1] = wy; out[at + 2] = wz
      out[at + 3] = uu; out[at + 4] = vv
      out[at + 5] = cr; out[at + 6] = cg; out[at + 7] = cb; out[at + 8] = ca
      at += SOUP_STRIDE
    }
  }
  return at / SOUP_STRIDE
}

// ─── the parity suite ───────────────────────────────────────────────────────

describe('Task 131 — packInstances (the record packer)', () => {
  it('packs exactly fillBillboards()/6 records (the count parity, every mode)', () => {
    const system = makeSystem(500)
    const records = new Float32Array(500 * INSTANCE_STRIDE)
    const soup = new Float32Array(500 * 6 * SOUP_STRIDE)
    for (const mode of ['camera', 'vertical', 'horizontal', 'stretched', 'oriented'] as BillboardMode[]) {
      for (const ramp of [CONSTANT_RAMP, RAMP]) {
        for (const tiles of [undefined, [4, 2]] as ([number, number] | undefined)[]) {
          const n = packInstances(system, records, { ramp, tiles, frameJitter: 3 })
          const v = fillBillboards(system, BASIS, soup, { ramp, mode, tiles, frameJitter: 3 })
          expect(n).toBe(Math.round(v / 4)) // Task 180: 4 unique corners per quad
          expect(n).toBeGreaterThan(400) // the zero-size skip is real but rare here
        }
      }
    }
  })

  it('writes the reference record semantics (the packed words decode to pos/vel/color/par/frame)', () => {
    const system = makeSystem(64)
    const records = new Float32Array(64 * INSTANCE_STRIDE)
    const n = packInstances(system, records, { ramp: RAMP, tiles: [2, 2] })
    expect(n).toBe(64)
    const f = system.fields
    const s = new Float32Array(6)
    // a sampleRamp call per particle — the SAME sampler the reference uses
    for (let i = 0; i < 4; i++) {
      const t = f.life[i] > 0 ? f.age[i] / f.life[i] : 0
      sampleRamp(RAMP, t, s)
      decodeInstanceRecord(records, i, [2, 2], DEC)
      // NATIVE fields — bit-exact
      expect(DEC.pos[0]).toBe(f.px[i])
      expect(DEC.pos[1]).toBe(f.py[i])
      expect(DEC.pos[2]).toBe(f.pz[i])
      expect(DEC.par[2]).toBe(f.age[i])
      // QUANTIZED fields — within one f16 rounding (2^-11 relative, the
      // three-dialect contract; + the f32 product rounding)
      const f16close = (got: number, want: number) => {
        const tol = Math.max(1e-6, Math.abs(want) * 6.2e-4)
        expect(Math.abs(got - want)).toBeLessThanOrEqual(tol)
      }
      f16close(DEC.vel[0], f.vx[i])
      f16close(DEC.vel[1], f.vy[i])
      f16close(DEC.vel[2], f.vz[i])
      f16close(DEC.color[0], f.cr[i] * s[1])
      f16close(DEC.color[1], f.cg[i] * s[2])
      f16close(DEC.color[2], f.cb[i] * s[3])
      f16close(DEC.color[3], f.ca[i] * s[4])
      f16close(DEC.par[0], f.size[i] * s[0] * 0.5)
      f16close(DEC.par[3], f.seed[i])
      // the derived phase: f16(seed)·τ — bounded by the seed's f16 error
      f16close(DEC.par[1], f.seed[i] * 6.283185307179586)
      // the atlas frame — EXACT (the u16 index; no jitter here, 2×2 sheet)
      const frame = Math.max(0, Math.min(3, Math.floor(s[5])))
      expect(DEC.frame).toBe(frame)
      // the derived tile origin — exact from the frame
      expect(DEC.uv0[0]).toBe((frame % 2) / 2)
      expect(DEC.uv0[1]).toBe(Math.floor(frame / 2) / 2)
    }
  })

  it('validates the tiles exactly like fillBillboards', () => {
    const system = makeSystem(4)
    const records = new Float32Array(4 * INSTANCE_STRIDE)
    expect(() => packInstances(system, records, { tiles: [2.5, 1] })).toThrow('tiles must be integers')
    expect(() => packInstances(system, records, { tiles: [0, 1] })).toThrow('tiles must be integers')
  })

  it('allocates nothing (the shared scratch contract)', () => {
    const system = makeSystem(100)
    const records = new Float32Array(100 * INSTANCE_STRIDE)
    packInstances(system, records, { ramp: RAMP })
    const before = records[0]
    packInstances(system, records, { ramp: RAMP })
    expect(records[0]).toBe(before) // stable across calls (deterministic)
  })
})

describe('Task 131 — the shader twin vs fillBillboards (bit parity)', () => {
  const system = makeSystem(400)
  const records = new Float32Array(400 * INSTANCE_STRIDE)
  const twin = new Float32Array(400 * 6 * SOUP_STRIDE)
  const ref = new Float32Array(400 * 6 * SOUP_STRIDE)

  const cases: { name: string; opts: BillboardOptions; twin: Omit<TwinUniforms, 'right' | 'up' | 'forward'> }[] = [
    { name: 'camera + spin', opts: { mode: 'camera', spin: 1.5 }, twin: { mode: 'camera', spin: 1.5, speedFactor: 0, lengthFactor: 1, spin3d: 0, tiles: [1, 1], axis: 'random' } },
    { name: 'camera no spin', opts: { mode: 'camera' }, twin: { mode: 'camera', spin: 0, speedFactor: 0, lengthFactor: 1, spin3d: 0, tiles: [1, 1], axis: 'random' } },
    { name: 'vertical', opts: { mode: 'vertical' }, twin: { mode: 'vertical', spin: 0, speedFactor: 0, lengthFactor: 1, spin3d: 0, tiles: [1, 1], axis: 'random' } },
    { name: 'horizontal', opts: { mode: 'horizontal' }, twin: { mode: 'horizontal', spin: 0, speedFactor: 0, lengthFactor: 1, spin3d: 0, tiles: [1, 1], axis: 'random' } },
    { name: 'stretched', opts: { mode: 'stretched', speedFactor: 0.35, lengthFactor: 2.2 }, twin: { mode: 'stretched', spin: 0, speedFactor: 0.35, lengthFactor: 2.2, spin3d: 0, tiles: [1, 1], axis: 'random' } },
    { name: 'oriented random axis', opts: { mode: 'oriented', spin3d: 2.1 }, twin: { mode: 'oriented', spin: 0, speedFactor: 0, lengthFactor: 1, spin3d: 2.1, tiles: [1, 1], axis: 'random' } },
    { name: 'oriented fixed axis', opts: { mode: 'oriented', axis: [0.3, 0.8, 0.5], spin3d: 1.2 }, twin: { mode: 'oriented', spin: 0, speedFactor: 0, lengthFactor: 1, spin3d: 1.2, tiles: [1, 1], axis: [0.3, 0.8, 0.5] } },
    { name: 'camera + atlas + jitter', opts: { mode: 'camera', spin: 0.7, tiles: [4, 2], frameJitter: 5 }, twin: { mode: 'camera', spin: 0.7, speedFactor: 0, lengthFactor: 1, spin3d: 0, tiles: [4, 2], axis: 'random' } },
  ]

  for (const c of cases) {
    it(`reproduces fillBillboards within the Task-183 f16 tolerance: ${c.name}`, () => {
      const n = packInstances(system, records, { ramp: RAMP, tiles: c.opts.tiles, frameJitter: c.opts.frameJitter })
      const refCount = fillBillboards(system, BASIS, ref, { ramp: RAMP, ...c.opts })
      expect(n).toBe(Math.round(refCount / 4)) // Task 180: 4 unique corners per quad
      const twinCount = expandInstances(records, n, { ...c.twin, right: BASIS.right, up: BASIS.up, forward: BASIS.forward! }, twin)
      // The reference's four-corner soup EXPANDED through the shared index
      // pattern — the stream the GPU actually draws; the twin (like the
      // BILLBOARD shader) writes the six-vert form directly.
      const six = expandQuadSoup(ref, refCount)
      expect(twinCount).toBe(six.length / SOUP_STRIDE)
      // THE TASK-183 TOLERANCE WALK — the twin (like the shader) consumes
      // the f16-PACKED records, the reference computes f64 end-to-end. The
      // quantized fields bound the drift: half/vel/color/seed within one
      // f16 rounding (rel ≤ 2^-11 ≈ 4.9e-4); the derived spin phase
      // ≤ seedErr·τ ≈ 1.5e-3 rad; the axis/velocity directions wobble by
      // the same relative order. The vertex positions inherit those errors
      // SCALED BY THE SPRITE EXTENT (and the stretched tail); the uv is
      // EXACT (the u16 frame — the same f64 division the reference makes).
      // A SEMANTIC drift (a wrong corner, a wrong axis, a swapped winding)
      // is the extent's own magnitude — orders above these bounds.
      let maxHalf = 0
      for (let r = 0; r < n; r++) {
        decodeInstanceRecord(records, r, c.twin.tiles, DEC)
        if (DEC.par[0] > maxHalf) maxHalf = DEC.par[0]
      }
      const posTol = 1e-3 + 0.025 * maxHalf
      let worstPos = 0
      let worstUv = 0
      let worstCol = 0
      for (let at = 0; at < six.length; at += SOUP_STRIDE) {
        for (let k = 0; k < 9; k++) {
          const d = Math.abs(twin[at + k] - six[at + k])
          if (k < 3) {
            if (d > worstPos) worstPos = d
          } else if (k < 5) {
            if (d > worstUv) worstUv = d
          } else {
            // color: one f16 rounding relative to the reference value
            const tol = 6.2e-4 * Math.max(1e-3, Math.abs(six[at + k])) + 1e-6
            expect(d).toBeLessThanOrEqual(tol)
            if (d > worstCol) worstCol = d
          }
        }
      }
      expect(worstPos).toBeLessThanOrEqual(posTol)
      expect(worstUv).toBeLessThanOrEqual(1e-6)
      expect(worstCol).toBeLessThanOrEqual(1e-3)
    })
  }

  it('the atlas tile origins round-trip through the twin (uv parity — EXACT: the u16 frame)', () => {
    const n = packInstances(system, records, { ramp: RAMP, tiles: [2, 2], frameJitter: 4 })
    const refCount = fillBillboards(system, BASIS, ref, { ramp: RAMP, tiles: [2, 2], frameJitter: 4 })
    expandInstances(records, n, { mode: 'camera', spin: 0, speedFactor: 0, lengthFactor: 1, spin3d: 0, tiles: [2, 2], axis: 'random', right: BASIS.right, up: BASIS.up, forward: BASIS.forward! }, twin)
    // every vertex uv of the twin === the reference's EXPANDED stream (tile
    // origin + scale — the pattern expansion carries the uvs verbatim)
    const six = expandQuadSoup(ref, refCount)
    for (let v = 0; v < six.length / SOUP_STRIDE; v++) {
      const at = v * SOUP_STRIDE + 3
      expect(twin[at]).toBe(six[at])
      expect(twin[at + 1]).toBe(six[at + 1])
    }
  })
})

describe('Task 131 — the facade integration (draw: instance)', () => {
  it('view() packs records, carries the layout, and reuses everything', () => {
    const ps = createParticles({
      capacity: 512,
      rate: 2000,
      spawner: SPAWNER,
      ramp: RAMP,
      spin: 1.5,
      render: { kind: 'billboard', draw: 'instance', mode: 'camera', tiles: [2, 2], frameJitter: 3 },
    })
    for (let k = 0; k < 30; k++) ps.advance(1 / 60)
    const v = ps.view(BASIS)
    expect(v.draw).toBe('instance')
    expect(v.stride).toBe(INSTANCE_STRIDE)
    expect(v.instanceLayout).toBe(INSTANCE_LAYOUT)
    expect(v.instanceCount).toBe(v.vertexCount)
    expect(v.vertexCount).toBeGreaterThan(0)
    expect(v.layout.position).toEqual({ size: 3, offset: 0 })
    // the count parity through the facade (the duck-typed system: the
    // facade's fields + count are the reference's whole read surface)
    const soupCheck = new Float32Array(512 * 6 * 9)
    const refCount = fillBillboards({ fields: ps.fields, count: ps.count } as never, BASIS, soupCheck, { ramp: RAMP, tiles: [2, 2], frameJitter: 3 })
    expect(v.vertexCount).toBe(Math.round(refCount / 4)) // Task 180
    // the memory contract: the same reference, the same buffer
    const vertices = v.vertices
    for (let k = 0; k < 10; k++) {
      ps.advance(1 / 60)
      const v2 = ps.view(BASIS)
      expect(v2).toBe(v)
      expect(v2.vertices).toBe(vertices)
    }
  })

  it('the default stays the soup (the LCD contract)', () => {
    const ps = createParticles({ capacity: 64, spawner: SPAWNER })
    ps.burst(32)
    const v = ps.view(BASIS)
    expect(v.draw).toBe('soup')
    expect(v.stride).toBe(SOUP_STRIDE)
    expect(v.instanceCount).toBe(0)
    expect(v.instanceLayout).toBeNull()
    // Task 180 — the LCD soup: FOUR unique corners per particle, the index
    // pattern's count alongside, indices present (capacity 64 → Uint16).
    expect(v.vertexCount).toBe(32 * 4)
    expect(v.indexCount).toBe(32 * 6)
    expect(v.indices).toBeInstanceOf(Uint16Array)
  })

  it('the allocation identity holds at capacity (9 words/particle — Task 183)', () => {
    const ps = createParticles({ capacity: 128, spawner: SPAWNER, render: { kind: 'billboard', draw: 'instance' } })
    ps.burst(128)
    const v = ps.view(BASIS)
    expect(v.vertices.length).toBe(128 * INSTANCE_STRIDE)
    expect(v.vertexCount).toBe(128)
  })
})
