import { test, expect, describe, it } from 'bun:test'
import {
  createParticleSystem,
  createSpawner,
  createRamp,
  sampleRamp,
  createParticles,
  fillBillboards,
  SOUP_STRIDE,
  VERTS_PER_PARTICLE,
  NO_FORCES,
  hash01,
  CONSTANT_RAMP,
} from '../src/index.ts'
import type { SpawnRecord } from '../src/index.ts'

// ─── helpers ────────────────────────────────────────────────────────────────

const NO_BASIS = { right: [1, 0, 0], up: [0, 1, 0] }

/** A manual spawner: every particle identical, fully controlled. */
function fixedSpawner(over: Partial<SpawnRecord>): (index: number, out: SpawnRecord) => void {
  return (index, out) => {
    out.x = 0; out.y = 0; out.z = 0
    out.vx = 0; out.vy = 0; out.vz = 0
    out.life = 1; out.size = 1
    out.r = 1; out.g = 1; out.b = 1; out.a = 1
    out.seed = 0
    Object.assign(out, over)
  }
}

/** The signed shortest angular distance a→b, wrapped to (-π, π]. */
function shortestAngleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d <= -Math.PI) d += Math.PI * 2
  return d
}

/** The disc angle in the spawner's t1/t2 frame: for axis (0,1,0) the frame
 *  is t1 = +X, t2 = −Z (the degenerate-axis fallback), so φ = atan2(−z, x)
 *  — the SAME angle the disc arm math builds from. */
function discAngle(x: number, z: number): number {
  return Math.atan2(-z, x)
}

// ─── the RNG ────────────────────────────────────────────────────────────────

describe('hash01 (the stateless RNG)', () => {
  it('is deterministic and pure (call order never matters)', () => {
    const a = [hash01(7, 0, 1), hash01(7, 1, 1), hash01(7, 2, 1)]
    const b = [hash01(7, 2, 1), hash01(7, 0, 1), hash01(7, 1, 1)] // reversed order
    expect(b[0]).toBe(a[2])
    expect(b[1]).toBe(a[0])
    expect(b[2]).toBe(a[1])
  })

  it('spans [0, 1) with distinct salts and seeds', () => {
    const seen = new Set<number>()
    for (let i = 0; i < 200; i++) {
      const v = hash01(1234, i, 1)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
      seen.add(v)
    }
    expect(seen.size).toBe(200) // no collisions in a small sweep
    expect(hash01(1, 0, 1)).not.toBe(hash01(2, 0, 1))
    expect(hash01(1, 0, 1)).not.toBe(hash01(1, 0, 2))
  })
})

// ─── the store ──────────────────────────────────────────────────────────────

describe('createParticleSystem (the SoA store)', () => {
  it('emits into the SoA fields and grows the count', () => {
    const ps = createParticleSystem(8)
    expect(ps.count).toBe(0)
    const spawned = ps.emit(3, fixedSpawner({ x: 1, vy: 2, life: 5, r: 0.5 }))
    expect(spawned).toBe(3)
    expect(ps.count).toBe(3)
    expect(ps.fields.px[0]).toBe(1)
    expect(ps.fields.vy[0]).toBe(2)
    expect(ps.fields.life[0]).toBe(5)
    expect(ps.fields.age[0]).toBe(0)
    expect(ps.fields.cr[0]).toBe(0.5)
  })

  it('clips emission to the capacity and counts the drops', () => {
    const ps = createParticleSystem(4)
    expect(ps.emit(10, fixedSpawner({}))).toBe(4)
    expect(ps.count).toBe(4)
    expect(ps.dropped).toBe(6)
    // a full store emits nothing more
    expect(ps.emit(2, fixedSpawner({}))).toBe(0)
    expect(ps.dropped).toBe(8)
  })

  it('rejects broken spawn records loudly (the NaN-guard)', () => {
    const ps = createParticleSystem(4)
    expect(() => ps.emit(1, fixedSpawner({ life: 0 }))).toThrow('life <= 0')
    expect(() => ps.emit(1, fixedSpawner({ life: Number.NaN }))).toThrow()
    expect(() => ps.emit(1, fixedSpawner({ size: -1 }))).toThrow('size < 0')
    expect(() => ps.emit(1, fixedSpawner({ vx: Number.NaN }))).toThrow('NaN')
    expect(ps.count).toBe(0) // nothing leaked into the store
  })

  it('validates the capacity', () => {
    expect(() => createParticleSystem(0)).toThrow('capacity')
    expect(() => createParticleSystem(1.5)).toThrow('capacity')
    expect(() => createParticleSystem(2 ** 25)).toThrow('capacity')
  })

  it('integrates gravity exactly (semi-implicit Euler)', () => {
    const ps = createParticleSystem(1)
    ps.emit(1, fixedSpawner({ vy: 1, life: 10 }))
    ps.advance(0.1, { gravity: [0, -10, 0], drag: 0, turbulence: 0 })
    // v = 1 - 10*0.1 = 0; p = 0 + 0*0.1 = 0
    expect(ps.fields.vy[0]).toBe(0)
    expect(ps.fields.py[0]).toBe(0)
    ps.advance(0.1, { gravity: [0, -10, 0], drag: 0, turbulence: 0 })
    // v = -1; p = 0 + (-1)*0.1 (f32 arithmetic)
    expect(ps.fields.vy[0]).toBe(-1)
    expect(ps.fields.py[0]).toBeCloseTo(-0.1, 5)
    expect(ps.fields.age[0]).toBeCloseTo(0.2, 5)
  })

  it('applies the exponential drag (one exp per frame, shared)', () => {
    const ps = createParticleSystem(1)
    ps.emit(1, fixedSpawner({ vx: 10, life: 10 }))
    ps.advance(1, { gravity: [0, 0, 0], drag: 2, turbulence: 0 })
    expect(ps.fields.vx[0]).toBeCloseTo(10 * Math.exp(-2), 5)
  })

  it('compacts the dead by swap-remove — no skips, no double integration', () => {
    const ps = createParticleSystem(4)
    // lives staggered: 0 dies first, 2 dies second
    ps.emit(4, fixedSpawner({ life: 10 }))
    ps.fields.life[0] = 0.1
    ps.fields.life[1] = 10
    ps.fields.life[2] = 0.2
    ps.fields.life[3] = 10
    for (const i of [0, 1, 2, 3]) {
      ps.fields.px[i] = i
      ps.fields.cr[i] = i * 0.25 // f32-exact values
    }
    ps.advance(0.25, NO_FORCES)
    // dead: 0 (life .1) and 2 (life .2 <= .25). Survivors: 1 and 3.
    expect(ps.count).toBe(2)
    expect(ps.retired).toBe(2)
    // the survivor SET is exactly {1, 3} (order may swap)
    const positions = [ps.fields.px[0], ps.fields.px[1]].sort()
    expect(positions).toEqual([1, 3])
    // the surviving data is intact (tint follows the swap)
    const tints = [ps.fields.cr[0], ps.fields.cr[1]].sort()
    expect(tints).toEqual([0.25, 0.75])
    // ages advanced exactly once
    for (const i of [0, 1]) {
      expect(ps.fields.age[i]).toBeCloseTo(0.25, 5)
    }
  })

  it('is deterministic: the same state + dt = the same bits', () => {
    const run = () => {
      const ps = createParticleSystem(64)
      ps.emit(64, fixedSpawner({ vy: 1 }))
      for (let i = 0; i < 64; i++) ps.fields.life[i] = 0.5 + (i % 7) * 0.1
      for (let k = 0; k < 20; k++) ps.advance(1 / 60, { gravity: [0, -9, 0], drag: 0.5, turbulence: 3 })
      return Array.from(ps.fields.py.subarray(0, ps.count))
    }
    expect(run()).toEqual(run())
  })

  it('turbulence diverges the path; zero turbulence stays exact', () => {
    const straight = createParticleSystem(1)
    const wobbly = createParticleSystem(1)
    straight.emit(1, fixedSpawner({ vy: 1, seed: 0.5 }))
    wobbly.emit(1, fixedSpawner({ vy: 1, seed: 0.5 }))
    for (let k = 0; k < 30; k++) {
      straight.advance(1 / 60, { gravity: [0, 0, 0], drag: 0, turbulence: 0 })
      wobbly.advance(1 / 60, { gravity: [0, 0, 0], drag: 0, turbulence: 8 })
    }
    expect(straight.fields.px[0]).toBe(0)
    expect(straight.fields.pz[0]).toBe(0)
    expect(Math.hypot(wobbly.fields.px[0], wobbly.fields.pz[0])).toBeGreaterThan(0.01)
  })

  it('clear() retires everything', () => {
    const ps = createParticleSystem(4)
    ps.emit(4, fixedSpawner({}))
    ps.clear()
    expect(ps.count).toBe(0)
    expect(ps.retired).toBe(4)
  })
})

// ─── the point attractor (Task 119 — three-nebula's Gravity behavior) ───────

describe('the point attractor', () => {
  it('pulls toward the point: accel = strength / (r² + soft²), direction = dir/r', () => {
    const ps = createParticleSystem(1)
    ps.emit(1, fixedSpawner({ x: 1, y: 0, z: 0, life: 10 }))
    // strength 2, softening 0.5: at r=1 → a = 2/(1+0.25) = 1.6 toward origin
    ps.advance(0.1, { gravity: [0, 0, 0], drag: 0, turbulence: 0, attract: { point: [0, 0, 0], strength: 2, softening: 0.5 } })
    expect(ps.fields.vx[0]).toBeCloseTo(-0.16, 5) // a·dt = 1.6·0.1
    expect(ps.fields.vy[0]).toBe(0)
    expect(ps.fields.vz[0]).toBe(0)
    expect(ps.fields.px[0]).toBeCloseTo(1 - 0.016, 5)
  })

  it('a negative strength repels (a repulsor)', () => {
    const ps = createParticleSystem(1)
    ps.emit(1, fixedSpawner({ x: 1, y: 0, z: 0, life: 10 }))
    ps.advance(0.1, { gravity: [0, 0, 0], drag: 0, turbulence: 0, attract: { point: [0, 0, 0], strength: -2, softening: 0.5 } })
    expect(ps.fields.vx[0]).toBeCloseTo(0.16, 5)
  })

  it('softening caps the force at the center — no NaN, no slingshot', () => {
    const ps = createParticleSystem(2)
    ps.emit(2, fixedSpawner({ x: 0.5, life: 10 }))
    ps.fields.px[1] = 1e-9 // effectively AT the point
    ps.advance(0.1, { gravity: [0, 0, 0], drag: 0, turbulence: 0, attract: { point: [0, 0, 0], strength: 5, softening: 0.25 } })
    // the r→0 guard holds the velocity instead of dividing by ~0
    expect(ps.fields.vx[1]).toBe(0)
    expect(Number.isFinite(ps.fields.px[0] + ps.fields.px[1])).toBe(true)
    // |Δv| at any r is bounded by strength·dt/softening²
    expect(Math.abs(ps.fields.vx[0])).toBeLessThanOrEqual((5 * 0.1) / (0.25 * 0.25) + 1e-9)
  })

  it('composes with gravity and drag, deterministically', () => {
    const run = () => {
      const ps = createParticleSystem(8)
      ps.emit(8, fixedSpawner({ x: 2, y: 3, z: 0, vy: 1, life: 100 }))
      for (let k = 0; k < 30; k++) {
        ps.advance(1 / 60, {
          gravity: [0, -1, 0],
          drag: 0.4,
          turbulence: 0.3,
          attract: { point: [0, 0.5, 0], strength: 1.4 },
        })
      }
      return Array.from(ps.fields.px.subarray(0, ps.count))
    }
    expect(run()).toEqual(run())
  })

  it('a tangential launch near v_circ stays on the ring (an orbit, not a collapse)', () => {
    // v_circ at r=2 for strength 1.2, soft 0.25: sqrt(1.2·2/(4+0.0625)) ≈ 0.768
    const ps = createParticleSystem(1)
    ps.emit(1, fixedSpawner({ x: 2, y: 0, z: 0, vz: 0.768, life: 1000 }))
    for (let k = 0; k < 600; k++) {
      ps.advance(1 / 60, { gravity: [0, 0, 0], drag: 0, turbulence: 0, attract: { point: [0, 0, 0], strength: 1.2, softening: 0.25 } })
    }
    // 10 s of free flight: the radius may breathe but must not collapse or escape
    const r = Math.hypot(ps.fields.px[0], ps.fields.py[0], ps.fields.pz[0])
    expect(r).toBeGreaterThan(1)
    expect(r).toBeLessThan(3.2)
    expect(ps.count).toBe(1)
  })

  it('the facade validates the attractor loudly', () => {
    const base = { capacity: 4, rate: 0 }
    expect(() => createParticles({ ...base, forces: { attract: { point: [0, NaN, 0], strength: 1 } } })).toThrow(/attract\.point/)
    expect(() => createParticles({ ...base, forces: { attract: { point: [0, 0], strength: 1 } } })).toThrow(/attract\.point/)
    expect(() => createParticles({ ...base, forces: { attract: { point: [0, 0, 0], strength: Infinity } } })).toThrow(/attract\.strength/)
    expect(() => createParticles({ ...base, forces: { attract: { point: [0, 0, 0], strength: 1, softening: 0 } } })).toThrow(/attract\.softening/)
    // a clean attractor passes through
    expect(() => createParticles({ ...base, forces: { attract: { point: [0, 0, 0], strength: 1 } } })).not.toThrow()
    // and no attract at all — the default
    expect(() => createParticles(base)).not.toThrow()
  })
})

// ─── the spawners ───────────────────────────────────────────────────────────

describe('createSpawner (the shapes)', () => {
  const rec: SpawnRecord = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size: 1, r: 1, g: 1, b: 1, a: 1, seed: 0, tx: NaN, ty: NaN, tz: NaN }

  it('is bit-identical for the same seed; different seeds differ', () => {
    const s = createSpawner({
      shape: { kind: 'sphere', origin: [0, 0, 0], radius: [0.1, 1] },
      velocity: { mode: 'radial' },
      speed: [1, 3], life: [1, 2], size: [0.1, 0.3],
      color: [[1, 1, 0, 1], [0, 0, 1, 0.2]], seed: 42,
    })
    const a: SpawnRecord = { ...rec }
    const b: SpawnRecord = { ...rec }
    s(7, a)
    s(7, b)
    expect(a).toEqual(b)
    const c: SpawnRecord = { ...rec }
    s(7, c)
    const other = createSpawner({
      shape: { kind: 'sphere', origin: [0, 0, 0], radius: [0.1, 1] },
      velocity: { mode: 'radial' },
      speed: [1, 3], life: [1, 2], size: [0.1, 0.3],
      color: [[1, 1, 0, 1], [0, 0, 1, 0.2]], seed: 43,
    })
    const d: SpawnRecord = { ...rec }
    other(7, d)
    expect(d.x).not.toBe(a.x)
  })

  it('sphere: radius range respected, velocity radial with speed in range', () => {
    const s = createSpawner({
      shape: { kind: 'sphere', origin: [1, 2, 3], radius: [0.5, 1.5] },
      velocity: { mode: 'radial' },
      speed: [2, 4], life: [1, 1], size: [1, 1],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 9,
    })
    for (let i = 0; i < 500; i++) {
      s(i, rec)
      const dx = rec.x - 1, dy = rec.y - 2, dz = rec.z - 3
      const r = Math.hypot(dx, dy, dz)
      expect(r).toBeGreaterThanOrEqual(0.4999)
      expect(r).toBeLessThanOrEqual(1.5001)
      const speed = Math.hypot(rec.vx, rec.vy, rec.vz)
      expect(speed).toBeGreaterThanOrEqual(1.9999)
      expect(speed).toBeLessThanOrEqual(4.0001)
      // radial: v ∥ (p - origin)
      const cross = Math.abs(dx * rec.vy - dy * rec.vx) + Math.abs(dy * rec.vz - dz * rec.vy) + Math.abs(dz * rec.vx - dx * rec.vz)
      expect(cross).toBeLessThan(1e-5)
    }
  })

  it('cone: the velocity stays inside the half-angle around the axis; the base disc in the plane', () => {
    const axis = [0, 1, 0]
    const s = createSpawner({
      shape: { kind: 'cone', origin: [0, 0, 0], axis, halfAngle: Math.PI / 8, baseRadius: 1, length: [0, 0] },
      velocity: { mode: 'lobe' },
      speed: [3, 3], life: [1, 1], size: [1, 1],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 5,
    })
    for (let i = 0; i < 500; i++) {
      s(i, rec)
      const speed = Math.hypot(rec.vx, rec.vy, rec.vz)
      const cos = (rec.vx * axis[0] + rec.vy * axis[1] + rec.vz * axis[2]) / speed
      expect(cos).toBeGreaterThanOrEqual(Math.cos(Math.PI / 8) - 1e-6)
      // position on the base disc: y = 0, |xz| <= baseRadius
      expect(Math.abs(rec.y)).toBeLessThan(1e-9)
      expect(Math.hypot(rec.x, rec.z)).toBeLessThanOrEqual(1.0001)
    }
  })

  it('disc + tangential: in-plane positions, velocity ⊥ the radius, ⊥ the axis', () => {
    const axis = [0, 1, 0]
    const s = createSpawner({
      shape: { kind: 'disc', origin: [0, 0, 0], axis, radius: [1, 2] },
      velocity: { mode: 'tangential' },
      speed: [1, 1], life: [1, 1], size: [1, 1],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 3,
    })
    for (let i = 0; i < 200; i++) {
      s(i, rec)
      expect(Math.abs(rec.y)).toBeLessThan(1e-9) // in the plane
      const r = Math.hypot(rec.x, rec.z)
      expect(r).toBeGreaterThanOrEqual(0.9999)
      expect(r).toBeLessThanOrEqual(2.0001)
      // tangential: dot(v, radial) ≈ 0 and dot(v, axis) ≈ 0
      expect(Math.abs(rec.vx * rec.x + rec.vz * rec.z)).toBeLessThan(1e-6)
      expect(Math.abs(rec.vy)).toBeLessThan(1e-9)
    }
  })

  it('line: positions on the segment', () => {
    const s = createSpawner({
      shape: { kind: 'line', from: [-1, 0, 0], to: [1, 0, 0] },
      velocity: { mode: 'axis' },
      speed: [1, 1], life: [1, 1], size: [1, 1],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 11,
    })
    for (let i = 0; i < 100; i++) {
      s(i, rec)
      expect(rec.y).toBe(0)
      expect(rec.z).toBe(0)
      expect(rec.x).toBeGreaterThanOrEqual(-1)
      expect(rec.x).toBeLessThanOrEqual(1)
      expect(rec.vx).toBe(1) // axis = +X at speed 1
    }
  })

  // ── Task 117: the galaxy-maker kit (arms / speedByRadius / colorByRadius) ──

  it('disc arms: zero spread + zero twist — the angle lands on exactly `arms` spokes', () => {
    const s = createSpawner({
      shape: { kind: 'disc', origin: [0, 0, 0], axis: [0, 1, 0], radius: [1, 2], arms: 3, armSpread: 0, twist: 0 },
      velocity: { mode: 'axis' },
      speed: [1, 1], life: [1, 1], size: [1, 1],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 21,
    })
    const spokes = [0, 1, 2].map(k => (k * Math.PI * 2) / 3)
    for (let i = 0; i < 300; i++) {
      s(i, rec)
      const angle = discAngle(rec.x, rec.z)
      const nearest = spokes.map(sp => Math.abs(shortestAngleDelta(angle, sp)))
      expect(Math.min(...nearest)).toBeLessThan(1e-6)
    }
  })

  it('disc arms: the twist winds monotonically with the radius; armSpread bounds the scatter', () => {
    const twist = 1.9
    const spread = 0.25
    const s = createSpawner({
      shape: { kind: 'disc', origin: [0, 0, 0], axis: [0, 1, 0], radius: [1, 2], arms: 2, armSpread: spread, twist },
      velocity: { mode: 'axis' },
      speed: [1, 1], life: [1, 1], size: [1, 1],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 22,
    })
    for (let i = 0; i < 300; i++) {
      s(i, rec)
      const r = Math.hypot(rec.x, rec.z)
      const angle = discAngle(rec.x, rec.z)
      // φ = arm·(τ/arms) + twist·tR + scatter; the arm index is hidden —
      // test the UNION: |angle − (k·τ/arms + twist·tR)| ≤ spread for some k.
      const tR = r - 1 // radius [1, 2] → tR ∈ [0, 1]
      const centers = [0, Math.PI].map(sp => sp + twist * tR)
      const dev = Math.min(...centers.map(c => Math.abs(shortestAngleDelta(angle, c))))
      expect(dev).toBeLessThanOrEqual(spread + 1e-9)
    }
  })

  it('disc arms: arms=1 — a single fanned sector (a comet tail / a barred galaxy)', () => {
    const s = createSpawner({
      shape: { kind: 'disc', origin: [0, 0, 0], axis: [0, 1, 0], radius: [1, 2], arms: 1, armSpread: 0.3, twist: 2.5 },
      velocity: { mode: 'axis' },
      speed: [1, 1], life: [1, 1], size: [1, 1],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 23,
    })
    for (let i = 0; i < 200; i++) {
      s(i, rec)
      const r = Math.hypot(rec.x, rec.z)
      const angle = discAngle(rec.x, rec.z)
      const center = 2.5 * (r - 1) // twist·tR, tR ∈ [0, 1]
      expect(Math.abs(shortestAngleDelta(angle, center))).toBeLessThanOrEqual(0.3 + 1e-9)
    }
  })

  it('disc without arms stays the uniform annulus (the feature is opt-in)', () => {
    // bit-parity with the pre-Task-117 behavior: the SAME descriptor (no arm
    // fields) produces the same values the plain disc always did.
    const s = createSpawner({
      shape: { kind: 'disc', origin: [0, 0, 0], axis: [0, 1, 0], radius: [1, 2] },
      velocity: { mode: 'tangential' },
      speed: [1, 1], life: [1, 1], size: [1, 1],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 3,
    })
    for (let i = 0; i < 100; i++) {
      s(i, rec)
      const r = Math.hypot(rec.x, rec.z)
      expect(r).toBeGreaterThanOrEqual(0.9999)
      expect(r).toBeLessThanOrEqual(2.0001)
    }
  })

  it('speedByRadius: (ref/r)^power — the inner rim outruns the outer (Keplerian shear)', () => {
    const s = createSpawner({
      shape: { kind: 'disc', origin: [0, 0, 0], axis: [0, 1, 0], radius: [1, 4] },
      velocity: { mode: 'tangential' },
      speed: [1, 1], speedByRadius: { ref: 2, power: 1 },
      life: [1, 1], size: [1, 1],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 24,
    })
    let fastest = 0, slowest = Infinity
    for (let i = 0; i < 400; i++) {
      s(i, rec)
      const r = Math.hypot(rec.x, rec.z)
      const speed = Math.hypot(rec.vx, rec.vy, rec.vz)
      // power=1, ref=2: speed·r = 2 exactly
      expect(speed * r).toBeCloseTo(2, 5)
      fastest = Math.max(fastest, speed)
      slowest = Math.min(slowest, speed)
    }
    // r ∈ [1,4] → speed ∈ [0.5, 2]: a 4× shear across the disc
    expect(fastest).toBeGreaterThan(1.9)
    expect(slowest).toBeLessThan(0.6)
  })

  it('colorByRadius: the mix follows the radius — the warm core, the cool rim', () => {
    const s = createSpawner({
      shape: { kind: 'disc', origin: [0, 0, 0], axis: [0, 1, 0], radius: [1, 3] },
      velocity: { mode: 'tangential' },
      speed: [1, 1], colorByRadius: true,
      life: [1, 1], size: [1, 1],
      color: [[1, 0, 0, 1], [0, 0, 1, 1]], seed: 25,
    })
    for (let i = 0; i < 300; i++) {
      s(i, rec)
      const r = Math.hypot(rec.x, rec.z)
      const mix = (r - 1) / 2 // [0, 1] over [1, 3]
      expect(rec.r).toBeCloseTo(1 - mix, 5)
      expect(rec.b).toBeCloseTo(mix, 5)
      // the CORE side is red: closer to r=1 than to r=3 → r > b
      if (r < 2) expect(rec.r).toBeGreaterThan(rec.b)
      else expect(rec.b).toBeGreaterThan(rec.r)
    }
  })

  it('the galaxy kit composes deterministically: same seed = the same galaxy, bit-exact', () => {
    const galaxy = () => createSpawner({
      shape: { kind: 'disc', origin: [0, 0.1, 0], axis: [0, 1, 0], radius: [0.7, 3.1], arms: 3, armSpread: 0.22, twist: 5.2 },
      velocity: { mode: 'tangential' },
      speed: [0.35, 0.55], speedByRadius: { ref: 2, power: 0.9 },
      colorByRadius: true,
      life: [7, 11], size: [0.05, 0.13],
      color: [[1, 0.86, 0.62, 1], [0.45, 0.6, 1, 0.9]], seed: 97,
    })
    const a = galaxy(), b = galaxy()
    for (let i = 0; i < 500; i++) {
      const ra: SpawnRecord = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size: 1, r: 0, g: 0, b: 0, a: 1, seed: 0, tx: NaN, ty: NaN, tz: NaN }
      const rb: SpawnRecord = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size: 1, r: 0, g: 0, b: 0, a: 1, seed: 0, tx: NaN, ty: NaN, tz: NaN }
      a(i, ra); b(i, rb)
      expect(ra.x).toBe(rb.x); expect(ra.y).toBe(rb.y); expect(ra.z).toBe(rb.z)
      expect(ra.vx).toBe(rb.vx); expect(ra.vy).toBe(rb.vy); expect(ra.vz).toBe(rb.vz)
      expect(ra.life).toBe(rb.life); expect(ra.size).toBe(rb.size)
      expect(ra.r).toBe(rb.r); expect(ra.g).toBe(rb.g); expect(ra.b).toBe(rb.b); expect(ra.a).toBe(rb.a)
    }
  })

  it('ranges and colors interpolate within bounds', () => {
    const s = createSpawner({
      shape: { kind: 'point', origin: [0, 0, 0] },
      velocity: { mode: 'fixed', dir: [0, 1, 0] },
      speed: [0.5, 2.5], life: [0.7, 1.3], size: [0.2, 0.8],
      color: [[1, 0, 0, 1], [0, 0, 1, 0]], seed: 77,
    })
    for (let i = 0; i < 300; i++) {
      s(i, rec)
      expect(rec.life).toBeGreaterThanOrEqual(0.7)
      expect(rec.life).toBeLessThanOrEqual(1.3)
      expect(rec.size).toBeGreaterThanOrEqual(0.2)
      expect(rec.size).toBeLessThanOrEqual(0.8)
      expect(rec.r).toBeGreaterThanOrEqual(0)
      expect(rec.b).toBeGreaterThanOrEqual(0)
      expect(rec.r + rec.b).toBeCloseTo(1, 5) // linear endpoints
      expect(rec.seed).toBeGreaterThanOrEqual(0)
      expect(rec.seed).toBeLessThan(1)
    }
  })

  it('rejects broken descriptions with actionable errors', () => {
    const base = {
      velocity: { mode: 'fixed' as const, dir: [0, 1, 0] },
      speed: [1, 1] as [number, number], life: [1, 1] as [number, number], size: [1, 1] as [number, number],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]] as [number[], number[]],
    }
    expect(() => createSpawner({ ...base, shape: { kind: 'point', origin: [0, 0, 0] }, life: [0, 1] })).toThrow('life')
    expect(() => createSpawner({ ...base, shape: { kind: 'point', origin: [0, 0, 0] }, speed: [3, 1] })).toThrow('speed')
    expect(() => createSpawner({
      ...base, shape: { kind: 'cone', origin: [0, 0, 0], axis: [0, 0, 0], halfAngle: 0.3, baseRadius: 0, length: [0, 1] as [number, number] },
    })).toThrow('axis')
    expect(() => createSpawner({
      shape: { kind: 'sphere', origin: [0, 0, 0], radius: [0, 1] as [number, number] },
      velocity: { mode: 'lobe' }, speed: [1, 1] as [number, number], life: [1, 1] as [number, number], size: [1, 1] as [number, number],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]] as [number[], number[]],
    })).toThrow("'lobe' needs the cone")
    expect(() => createSpawner({
      shape: { kind: 'disc', origin: [0, 0, 0], axis: [0, 1, 0], radius: [0, 1] as [number, number] },
      velocity: { mode: 'axis' }, speed: [1, 1] as [number, number], life: [1, 1] as [number, number], size: [1, 1] as [number, number],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]] as [number[], number[]],
    })).not.toThrow()
    // Task 117: the galaxy-kit validations
    const disc = { kind: 'disc' as const, origin: [0, 0, 0], axis: [0, 1, 0], radius: [1, 2] as [number, number] }
    expect(() => createSpawner({ ...base, shape: { ...disc, arms: 2.5 } })).toThrow('arms')
    expect(() => createSpawner({ ...base, shape: { ...disc, arms: 0 } })).toThrow('arms')
    expect(() => createSpawner({ ...base, shape: { ...disc, arms: 3, armSpread: -1 } })).toThrow('armSpread')
    expect(() => createSpawner({ ...base, shape: { ...disc, arms: 3, twist: Number.NaN } })).toThrow('twist')
    expect(() => createSpawner({ ...base, shape: disc, speedByRadius: { ref: 0, power: 1 } })).toThrow('ref')
    expect(() => createSpawner({ ...base, shape: disc, speedByRadius: { ref: 2, power: Number.NaN } })).toThrow('power')
    expect(() => createSpawner({
      ...base, shape: { kind: 'cone', origin: [0, 0, 0], axis: [0, 1, 0], halfAngle: 0.3, baseRadius: 0, length: [0, 1] as [number, number] },
      colorByRadius: true,
    })).toThrow('colorByRadius')
    // the valid galaxy kit does not throw
    expect(() => createSpawner({
      ...base, shape: { ...disc, arms: 3, armSpread: 0.22, twist: 5.2 },
      speedByRadius: { ref: 2, power: 0.9 }, colorByRadius: true,
    })).not.toThrow()
  })
})

// ─── the ramps ──────────────────────────────────────────────────────────────

describe('createRamp / sampleRamp', () => {
  const out = new Float32Array(5)

  it('samples exactly at the control points, lerps between, clamps outside', () => {
    const ramp = createRamp([
      { t: 0, size: 1, r: 1, g: 0, b: 0, a: 1 },
      { t: 0.5, size: 2, r: 0, g: 1, b: 0, a: 0.5 },
      { t: 1, size: 0, r: 0, g: 0, b: 1, a: 0 },
    ])
    sampleRamp(ramp, 0, out)
    expect(Array.from(out)).toEqual([1, 1, 0, 0, 1])
    sampleRamp(ramp, 0.5, out)
    expect(Array.from(out)).toEqual([2, 0, 1, 0, 0.5])
    sampleRamp(ramp, 0.25, out)
    expect(out[0]).toBeCloseTo(1.5, 12)
    expect(out[1]).toBeCloseTo(0.5, 12)
    expect(out[4]).toBeCloseTo(0.75, 12)
    sampleRamp(ramp, -1, out)
    expect(out[0]).toBe(1)
    sampleRamp(ramp, 2, out)
    expect(out[0]).toBe(0)
    expect(out[3]).toBe(1)
  })

  it('a one-point ramp is a constant', () => {
    // f32-exact values (0.25/0.5/0.75/1) — the scratch is a Float32Array
    const ramp = createRamp([{ t: 0, size: 3, r: 0.25, g: 0.5, b: 0.75, a: 1 }])
    sampleRamp(ramp, 0.999, out)
    expect(Array.from(out)).toEqual([3, 0.25, 0.5, 0.75, 1])
  })

  it('validates: non-empty, sorted, t in [0,1], finite', () => {
    expect(() => createRamp([])).toThrow('at least one')
    expect(() => createRamp([{ t: 0.5, size: 1, r: 1, g: 1, b: 1, a: 1 }, { t: 0.4, size: 1, r: 1, g: 1, b: 1, a: 1 }])).toThrow('sorted')
    expect(() => createRamp([{ t: 1.5, size: 1, r: 1, g: 1, b: 1, a: 1 }])).toThrow('[0, 1]')
    expect(() => createRamp([{ t: 0, size: Number.NaN, r: 1, g: 1, b: 1, a: 1 }])).toThrow('finite')
  })

  it('CONSTANT_RAMP is the identity', () => {
    sampleRamp(CONSTANT_RAMP, 0.3, out)
    expect(Array.from(out)).toEqual([1, 1, 1, 1, 1])
  })
})

// ─── the billboard soup ─────────────────────────────────────────────────────

describe('fillBillboards (the GPU view)', () => {
  it('writes 6 verts × 9 floats per particle with the corner/uv/color layout', () => {
    const ps = createParticleSystem(2)
    ps.emit(2, fixedSpawner({ x: 10, size: 2, r: 0.5, g: 1, b: 0.25, a: 0.75, seed: 0 }))
    const soup = new Float32Array(2 * 54)
    const verts = fillBillboards(ps, NO_BASIS, soup, { spin: 0 })
    expect(verts).toBe(12)
    expect(SOUP_STRIDE).toBe(9)
    expect(VERTS_PER_PARTICLE).toBe(6)
    // particle at (10,0,0), size 2 → half = 1 (constant ramp), no rotation
    // (seed 0, spin 0). Corner 0 = (-1,-1): (9, -1, 0), uv (0,0).
    const v0 = 0
    expect(soup[v0 + 0]).toBe(9); expect(soup[v0 + 1]).toBe(-1); expect(soup[v0 + 2]).toBe(0)
    expect(soup[v0 + 3]).toBe(0); expect(soup[v0 + 4]).toBe(0)
    expect(soup[v0 + 5]).toBe(0.5); expect(soup[v0 + 6]).toBe(1); expect(soup[v0 + 7]).toBe(0.25); expect(soup[v0 + 8]).toBe(0.75)
    // corner 1 = (1,-1): uv (1,0)
    expect(soup[9 + 0]).toBe(11); expect(soup[9 + 1]).toBe(-1)
    expect(soup[9 + 3]).toBe(1); expect(soup[9 + 4]).toBe(0)
    // corner 2 = (1,1): uv (1,1)
    expect(soup[18 + 0]).toBe(11); expect(soup[18 + 1]).toBe(1)
    // triangle 2: corners 0, 2, 3 → uv (0,0), (1,1), (0,1)
    expect(soup[27 + 3]).toBe(0); expect(soup[27 + 4]).toBe(0)
    expect(soup[36 + 3]).toBe(1); expect(soup[36 + 4]).toBe(1)
    expect(soup[45 + 3]).toBe(0); expect(soup[45 + 4]).toBe(1)
  })

  it('billboards face the camera: offsets follow right/up, not the world', () => {
    const ps = createParticleSystem(1)
    ps.emit(1, fixedSpawner({ size: 2, seed: 0 }))
    const soup = new Float32Array(54)
    // right = +Z, up = +Y → the quad lives in the ZY plane
    fillBillboards(ps, { right: [0, 0, 1], up: [0, 1, 0] }, soup, { spin: 0 })
    // corner 1 = (+1, -1) → world offset = right·1 + up·(-1) = (0, -1, 1)
    expect(soup[9 + 0]).toBe(0)
    expect(soup[9 + 1]).toBe(-1)
    expect(soup[9 + 2]).toBe(1)
  })

  it('rotates the quad by seed·τ + age·spin', () => {
    const ps = createParticleSystem(1)
    ps.emit(1, fixedSpawner({ size: 2, seed: 0 }))
    // age the particle to 0.25 s; spin = τ → angle = τ/4 → 90°
    ps.fields.age[0] = 0.25
    const soup = new Float32Array(54)
    fillBillboards(ps, NO_BASIS, soup, { spin: 6.283185307179586 })
    // corner 0 was (-1,-1); rotated by 90°: (x', y') = (a·cos−b·sin, a·sin+b·cos)·half = (1, -1)
    expect(soup[0]).toBeCloseTo(1, 5)
    expect(soup[1]).toBeCloseTo(-1, 5)
  })

  it('the ramp scales the size and tints the color; zero size emits nothing', () => {
    const ps = createParticleSystem(2)
    ps.emit(2, fixedSpawner({ size: 1, seed: 0 }))
    ps.fields.age[0] = 0.5 // t = 0.5
    ps.fields.age[1] = 1.0 // t = 1 → size 0
    const soup = new Float32Array(2 * 54)
    const ramp = createRamp([
      { t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 },
      { t: 1, size: 0, r: 1, g: 0.5, b: 0, a: 0.1 },
    ])
    const verts = fillBillboards(ps, NO_BASIS, soup, { ramp, spin: 0 })
    expect(verts).toBe(6) // the t=1 particle is zero-size → skipped
    // t=0.5: size = 0.5 → half = 0.25; color = (1, 0.75, 0.5, 0.55)
    expect(soup[0]).toBe(-0.25)
    expect(soup[5]).toBeCloseTo(1, 5)
    expect(soup[6]).toBeCloseTo(0.75, 5)
    expect(soup[7]).toBeCloseTo(0.5, 5)
    expect(soup[8]).toBeCloseTo(0.55, 5)
  })

  it('is deterministic: the same state writes the same bytes', () => {
    const run = () => {
      const ps = createParticles({ capacity: 128, rate: 300, spawner: SPHERE_DESC })
      for (let k = 0; k < 30; k++) ps.advance(1 / 60)
      const v = ps.billboards(NO_BASIS)
      return Array.from(v.vertices.subarray(0, v.vertexCount * 9))
    }
    expect(run()).toEqual(run())
  })
})

// ─── the facade ─────────────────────────────────────────────────────────────

const SPHERE_DESC = {
  shape: { kind: 'sphere' as const, origin: [0, 0, 0], radius: [0.1, 0.5] as [number, number] },
  velocity: { mode: 'radial' as const },
  speed: [1, 2] as [number, number],
  life: [0.5, 1.5] as [number, number],
  size: [0.05, 0.15] as [number, number],
  color: [[1, 1, 1, 1], [0.5, 0.7, 1, 0.4]] as [number[], number[]],
  seed: 19,
}

describe('createParticles (the facade)', () => {
  it('rate: the fractional accumulator spawns exactly rate·dt per second', () => {
    const ps = createParticles({
      capacity: 4096, rate: 60,
      spawner: { ...SPHERE_DESC, life: [10, 10] }, // nobody dies within the second
      forces: { gravity: [0, 0, 0] },
    })
    for (let k = 0; k < 60; k++) ps.advance(1 / 60)
    // the accumulator floors the per-frame carry — 60 frames of exactly
    // 1.0 particle each, modulo f64 noise: 59 or 60, nothing more.
    const { spawned, retired } = ps.stats()
    expect(retired).toBe(0)
    expect(spawned).toBeGreaterThanOrEqual(59)
    expect(spawned).toBeLessThanOrEqual(60)
    expect(ps.count).toBe(spawned)
  })

  it('burst: one-shot emission, capacity-clipped', () => {
    const ps = createParticles({ capacity: 10, spawner: SPHERE_DESC })
    expect(ps.burst(7)).toBe(7)
    expect(ps.burst(7)).toBe(3)
    expect(ps.count).toBe(10)
    expect(ps.stats().dropped).toBe(4)
  })

  it('advance retires the dead and stays chainable', () => {
    const ps = createParticles({ capacity: 16, spawner: { ...SPHERE_DESC, life: [0.1, 0.1] } })
    ps.burst(16)
    expect(ps.advance(0.2)).toBe(ps)
    expect(ps.count).toBe(0)
    expect(ps.stats().retired).toBe(16)
  })

  it('billboards() returns the SAME reused view (zero per-frame allocations)', () => {
    const ps = createParticles({ capacity: 256, rate: 60, spawner: SPHERE_DESC })
    ps.advance(1 / 60)
    const a = ps.billboards(NO_BASIS)
    const b = ps.billboards(NO_BASIS)
    expect(b).toBe(a) // the scene.cull reused-result pattern
    expect(a.vertices).toBe(b.vertices)
    const countA = a.vertexCount
    ps.advance(1 / 60)
    const c = ps.billboards(NO_BASIS)
    expect(c).toBe(a)
    expect(c.vertexCount).toBeGreaterThan(countA) // grows with the live set
  })

  it('the facade composes: burst → gravity → ramp → soup', () => {
    const ramp = createRamp([
      { t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 },
      { t: 1, size: 0.25, r: 1, g: 1, b: 1, a: 0 },
    ])
    const ps = createParticles({
      capacity: 8, ramp, forces: { gravity: [0, -10, 0], drag: 0.1 },
      spawner: SPHERE_DESC, spin: 2,
    })
    ps.burst(8)
    for (let k = 0; k < 30; k++) ps.advance(1 / 60)
    const view = ps.billboards(NO_BASIS)
    expect(view.vertexCount).toBe(8 * 6)
    // they fell (gravity) — at least one vertex sank below the birth plane
    const ys = view.vertices
    let anyBelow = false
    for (let v = 0; v < view.vertexCount; v++) if (ys[v * 9 + 1] < 0) { anyBelow = true; break }
    expect(anyBelow).toBe(true)
  })

  it('rate()/clear() validate and chain', () => {
    const ps = createParticles({ capacity: 4 })
    expect(() => ps.rate(-1)).toThrow('rate')
    expect(ps.rate(10, SPHERE_DESC)).toBe(ps)
    expect(ps.clear()).toBe(ps)
    expect(ps.count).toBe(0)
  })

  it('capacity validation propagates', () => {
    expect(() => createParticles({ capacity: 0 })).toThrow('capacity')
  })
})
