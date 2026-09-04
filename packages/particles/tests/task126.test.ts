/**
 * Task 126 — the game-FX emitter family: orient() (the rigid attachment),
 * wrap (the endless volume), attract.killRadius (the sink) and the path
 * spawner (the polyline bolt).
 */

import { describe, expect, it } from 'bun:test'
import { createParticles, createSpawner, createRamp, createGrassField, hash01 } from '../src/index.ts'
import type { SpawnerDesc, SpawnRecord } from '../src/index.ts'

const BASIS = { right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, -1] }

/** A minimal rest spawner: a point at the origin with an explicit velocity. */
const POINT_S: SpawnerDesc = {
  shape: { kind: 'point', origin: [0, 0, 0] },
  velocity: { mode: 'fixed', dir: [0, 0, 1] },
  speed: [1, 1],
  life: [10, 10],
  size: [1, 1],
  color: [[1, 1, 1, 1], [1, 1, 1, 1]],
}

// ─── orient() — the emitter ORIENTATION ─────────────────────────────────────

describe('Task 126: orient() — the rigid attachment', () => {
  it('rotates the spawn POSITION offset and the VELOCITY (a 90° turn of +Z → +X)', () => {
    // the spawner: a cone whose local axis is +Z with a base offset
    const cone: SpawnerDesc = {
      shape: { kind: 'cone', origin: [0, 0, 0.5], axis: [0, 0, 1], halfAngle: 0, baseRadius: 0, length: [0, 0] },
      velocity: { mode: 'axis' },
      speed: [2, 2],
      life: [10, 10],
      size: [1, 1],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]],
      seed: 5,
    }
    const p = createParticles({ capacity: 4, rate: 0, spawner: cone })
    // Ry(+90°): +Z → +X. Column-major 4×4: col0=(1,0,0) col1=(0,1,0) col2=(0,0,1)... no:
    // Ry(θ) maps +Z to (sinθ, 0, cosθ) — θ=90° → +X. Column-major matrix:
    // col0 = (cosθ, 0, −sinθ) = (0, 0, −1); col1 = (0, 1, 0); col2 = (sinθ, 0, cosθ) = (1, 0, 0).
    const ry90 = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]
    p.orient(ry90)
    p.burst(1)
    const f = p.fields
    // the spawn position (0,0,0.5) rotated → (0.5·1, 0, 0) = +X
    expect(f.px[0]).toBeCloseTo(0.5, 12)
    expect(f.py[0]).toBeCloseTo(0, 12)
    expect(f.pz[0]).toBeCloseTo(0, 12)
    // the velocity (0,0,2) rotated → (2, 0, 0)
    expect(f.vx[0]).toBeCloseTo(2, 12)
    expect(f.vy[0]).toBeCloseTo(0, 12)
    expect(f.vz[0]).toBeCloseTo(0, 12)
  })

  it('at() still translates AFTER the rotation (rotate then translate)', () => {
    const p = createParticles({ capacity: 2, rate: 0, spawner: POINT_S })
    const ry90 = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]
    p.orient(ry90).at(10, 0, 0)
    p.burst(1)
    const f = p.fields
    // the point at the (rotated) origin: (0,0,0) → (0,0,0), then + (10,0,0)
    expect(f.px[0]).toBeCloseTo(10, 12)
    expect(f.pz[0]).toBeCloseTo(0, 12)
    // the fixed velocity (0,0,1) → (1, 0, 0)
    expect(f.vx[0]).toBeCloseTo(1, 12)
  })

  it('a 3×3 matrix works; null resets to identity; bad input throws', () => {
    const p = createParticles({ capacity: 4, rate: 0, spawner: POINT_S })
    // column-major 3×3 of Ry(90°): cols (0,0,-1), (0,1,0), (1,0,0)
    p.orient([0, 0, -1, 0, 1, 0, 1, 0, 0])
    p.burst(1)
    expect(p.fields.vx[0]).toBeCloseTo(1, 12)
    p.orient(null)
    p.burst(1)
    expect(p.fields.vx[1]).toBeCloseTo(0, 12)
    expect(p.fields.vz[1]).toBeCloseTo(1, 12)
    expect(() => p.orient([1, 2])).toThrow(/3×3 or 4×4/)
    expect(() => p.orient([1, 2, 3, 4, 5, 6, 7, 8, NaN])).toThrow(/finite/)
  })

  it('identity semantics: no orient() call is byte-identical to orient(null)', () => {
    const a = createParticles({ capacity: 2, rate: 0, spawner: POINT_S })
    const b = createParticles({ capacity: 2, rate: 0, spawner: POINT_S })
    a.orient([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    b.orient(null)
    a.burst(1); b.burst(1)
    expect([...a.fields.px.slice(0, 1)]).toEqual([...b.fields.px.slice(0, 1)])
    expect([...a.fields.vx.slice(0, 1)]).toEqual([...b.fields.vx.slice(0, 1)])
    expect([...a.fields.vz.slice(0, 1)]).toEqual([...b.fields.vz.slice(0, 1)])
  })
})

// ─── wrap — the endless volume ──────────────────────────────────────────────

describe('Task 126: wrap — the endless volume', () => {
  const DRIFT: SpawnerDesc = {
    shape: { kind: 'point', origin: [0, 0, 0] },
    velocity: { mode: 'fixed', dir: [1, 0, 0] },
    speed: [10, 10],
    life: [100, 100],
    size: [1, 1],
    color: [[1, 1, 1, 1], [1, 1, 1, 1]],
  }

  it('positions wrap into the box around the at() origin (teleport by size)', () => {
    const p = createParticles({ capacity: 2, rate: 0, spawner: DRIFT, wrap: { size: [10, 0, 10] } })
    p.burst(1)
    p.advance(0.4) // 4 units → +X; still inside [−5, 5)
    expect(p.fields.px[0]).toBeCloseTo(4, 6)
    p.advance(0.2) // 2 more → 6 → wraps to 6 − 10 = −4 (re-entered through −X)
    expect(p.fields.px[0]).toBeCloseTo(-4, 6)
  })

  it('the wrap CENTER follows at() — the box rides the emitter', () => {
    const p = createParticles({ capacity: 1, rate: 0, spawner: DRIFT, wrap: { size: [10, 0, 10] } })
    p.burst(1)
    p.at(100, 0, 0)
    p.advance(0) // dt 0 is a no-op — move through a real step instead
    p.advance(1 / 60)
    // the particle (world ~0) is now ~100 units from the center → wraps to
    // the NEAREST equivalent point inside [95, 105)
    expect(p.fields.px[0]).toBeGreaterThan(95)
    expect(p.fields.px[0]).toBeLessThan(105)
  })

  it('an axis with size 0 never wraps (the rain falls past it)', () => {
    const p = createParticles({ capacity: 1, rate: 0, spawner: DRIFT, wrap: { size: [10, 0, 10] } })
    p.burst(1)
    // y is disabled: spawn a falling particle via a direct field write
    p.fields.py[0] = -40
    p.advance(1 / 60)
    expect(p.fields.py[0]).toBeCloseTo(-40, 6)
  })

  it('validation: negative or non-finite sizes throw', () => {
    const make = (size: [number, number, number]) =>
      createParticles({ capacity: 1, spawner: POINT_S, wrap: { size } })
    expect(() => make([-1, 0, 0])).toThrow(/wrap\.size/)
    expect(() => make([0, NaN, 0])).toThrow(/wrap\.size/)
    expect(() => make([0, 0, 0])).not.toThrow() // all axes off is legal (a no-op)
  })
})

// ─── attract.killRadius — the sink ──────────────────────────────────────────

describe('Task 126: attract.killRadius — the sink', () => {
  const FALL: SpawnerDesc = {
    shape: { kind: 'point', origin: [0, 6, 0] },
    velocity: { mode: 'fixed', dir: [0, -1, 0] },
    speed: [4, 4],
    life: [100, 100],
    size: [1, 1],
    color: [[1, 1, 1, 1], [1, 1, 1, 1]],
  }

  it('particles entering the sphere are consumed (retired, onRetire fires)', () => {
    const retired: number[] = []
    const p = createParticles({
      capacity: 2, rate: 0, spawner: FALL,
      forces: { attract: { point: [0, 0, 0], strength: 0, softening: 1, killRadius: 0.5 } },
      onRetire: (rec) => retired.push(rec.y),
    })
    p.burst(1)
    // y = 6 falling at 4 u/s: consumed when y < 0.5 → after ~1.4 s
    for (let i = 0; i < 90; i++) p.advance(1 / 60)
    expect(p.count).toBe(0)
    expect(retired.length).toBe(1)
    expect(Math.abs(retired[0])).toBeLessThan(0.5) // died INSIDE the sphere
  })

  it('killRadius 0 (the default) consumes nothing — back-compat', () => {
    const p = createParticles({
      capacity: 2, rate: 0, spawner: FALL,
      forces: { attract: { point: [0, 0, 0], strength: 0, softening: 1 } },
    })
    p.burst(1)
    for (let i = 0; i < 120; i++) p.advance(1 / 60)
    expect(p.count).toBe(1)
    expect(p.fields.py[0]).toBeLessThan(0)
  })

  it('validation: a negative killRadius throws', () => {
    expect(() => createParticles({
      capacity: 1, spawner: POINT_S,
      forces: { attract: { point: [0, 0, 0], strength: 1, softening: 1, killRadius: -1 } },
    })).toThrow(/killRadius/)
  })
})

// ─── path — the polyline spawner ────────────────────────────────────────────

describe('Task 126: path — the polyline spawner', () => {
  /** A jagged 3-segment path: (0,0,0) → (1,0,0) → (1,1,0) → (2,1,0). */
  const JAG_PTS = [0, 0, 0, 1, 0, 0, 1, 1, 0, 2, 1, 0]
  const jag = (over: { mode?: 'random' | 'lattice'; scatter?: number }, points: readonly number[] = JAG_PTS): SpawnerDesc => ({
    shape: { kind: 'path', points, mode: over.mode ?? 'lattice', scatter: over.scatter ?? 0 },
    velocity: { mode: 'axis' },
    speed: [1, 1],
    life: [10, 10],
    size: [1, 1],
    color: [[1, 1, 1, 1], [1, 1, 1, 1]],
    seed: 3,
  })
  const JAG: SpawnerDesc = jag({})

  it('one burst of `segments` covers the WHOLE path exactly', () => {
    const p = createParticles({ capacity: 8, rate: 0, spawner: JAG })
    p.burst(3)
    expect(p.count).toBe(3)
    // Each particle lies ON the polyline; together the burst touches ALL
    // three segments (the lattice maps indices → segments; a cyclic shift
    // of the global stream still covers every segment exactly once).
    const SEGS: Array<[number, number, number, number]> = [[0, 0, 1, 0], [1, 0, 1, 1], [1, 1, 2, 1]]
    const segsSeen = new Set<number>()
    for (let i = 0; i < 3; i++) {
      const x = p.fields.px[i], y = p.fields.py[i], z = p.fields.pz[i]
      expect(Math.abs(z)).toBeLessThan(1e-9)
      let matched = 0
      for (let s = 0; s < 3; s++) {
        const [ax, ay, bx, by] = SEGS[s]
        if (segDist(x, y, ax, ay, bx, by) < 1e-9) { segsSeen.add(s); matched++ }
      }
      expect(matched).toBe(1) // exactly one segment per particle
    }
    expect(segsSeen.size).toBe(3)
  })

  it("'axis' velocity = the LOCAL segment direction (the jag reads as a jag)", () => {
    const p = createParticles({ capacity: 8, rate: 0, spawner: JAG })
    p.burst(3)
    const dirs = new Set<string>()
    for (let i = 0; i < 3; i++) {
      const l = Math.hypot(p.fields.vx[i], p.fields.vy[i], p.fields.vz[i])
      dirs.add(`${(p.fields.vx[i] / l).toFixed(2)},${(p.fields.vy[i] / l).toFixed(2)},${(p.fields.vz[i] / l).toFixed(2)}`)
    }
    expect(dirs.has('1.00,0.00,0.00')).toBe(true) // segment 0: +X
    expect(dirs.has('0.00,1.00,0.00')).toBe(true) // segment 1: +Y
    expect(dirs.size).toBe(2) // segments 1 and 2 are both +X… no: seg1=+Y, seg2=+X
  })

  it("'random' mode: the hash picks the segment (deterministic, in range)", () => {
    const desc: SpawnerDesc = jag({ mode: 'random' })
    const a = createParticles({ capacity: 8, rate: 0, spawner: desc })
    a.burst(6)
    for (let i = 0; i < 6; i++) {
      expect(pFieldsInPath(a.fields, i)).toBe(true)
    }
    const b = createParticles({ capacity: 8, rate: 0, spawner: desc })
    b.burst(6)
    expect([...a.fields.px.slice(0, 6)]).toEqual([...b.fields.px.slice(0, 6)]) // deterministic
  })

  it('scatter jitters sideways (off the polyline, bounded by the radius)', () => {
    const p = createParticles({ capacity: 64, rate: 0, spawner: jag({ scatter: 0.25 }) })
    p.burst(60)
    // the path: seg0 (0,0,0)-(1,0,0); seg1 (1,0,0)-(1,1,0); seg2 (1,1,0)-(2,1,0)
    const SEGS: Array<[number, number, number, number]> = [[0, 0, 1, 0], [1, 0, 1, 1], [1, 1, 2, 1]]
    let off = 0
    for (let i = 0; i < 60; i++) {
      const x = p.fields.px[i], y = p.fields.py[i], z = p.fields.pz[i]
      let best = Infinity
      for (const [ax, ay, bx, by] of SEGS) best = Math.min(best, segDist(x, y, ax, ay, bx, by))
      expect(Math.hypot(best, z)).toBeLessThanOrEqual(0.25 + 1e-9)
      if (best > 1e-6 || Math.abs(z) > 1e-6) off++
    }
    expect(off).toBeGreaterThan(10) // actually scattered, not razor-straight
  })

  it('validation: short/ragged/zero-length paths throw honest errors', () => {
    const mk = (points: number[]) => createParticles({
      capacity: 1, rate: 0,
      spawner: jag({}, points),
    })
    expect(() => mk([0, 0, 0])).toThrow(/>= 2 points/)
    expect(() => mk([0, 0, 0, 1, 0])).toThrow(/flat xyz/)
    expect(() => mk([0, 0, 0, 0, 0, 0])).toThrow(/zero length/)
    expect(() => mk([0, 0, 0, NaN, 0, 0])).toThrow(/finite/)
    expect(() => createParticles({
      capacity: 1, rate: 0,
      spawner: jag({ scatter: -1 }),
    })).toThrow(/scatter/)
  })

  it('orient() composes with the path (a bolt rotated rigidly)', () => {
    const p = createParticles({ capacity: 8, rate: 0, spawner: JAG })
    // Rx(−90°): +Y → +Z. Column-major: col0=(1,0,0), col1=(0,0,−1), col2=(0,1,0)
    p.orient([1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1])
    p.burst(3)
    // segment 0 (+X) stays +X; segment 1 (+Y) becomes ±Z (a rotation about X)
    let sawZ = false
    for (let i = 0; i < 3; i++) {
      const l = Math.hypot(p.fields.vx[i], p.fields.vy[i], p.fields.vz[i])
      if (Math.abs(p.fields.vz[i] / l) > 1 - 1e-9) sawZ = true
    }
    expect(sawZ).toBe(true)
  })
})

/** The distance from (x,y) to the segment (ax,ay)-(bx,by). */
function segDist(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(x - (ax + dx * t), y - (ay + dy * t))
}

function pFieldsInPath(f: { px: Float32Array; py: Float32Array; pz: Float32Array }, i: number): boolean {
  const x = f.px[i], y = f.py[i], z = f.pz[i]
  if (Math.abs(z) > 1e-9) return false
  const on01 = (v: number) => v >= -1e-9 && v <= 1 + 1e-9
  return (on01(x) && Math.abs(y) < 1e-9) || (on01(y) && Math.abs(x - 1) < 1e-9) || (on01(x - 1) && Math.abs(y - 1) < 1e-9)
}

// keep the ramp/hash imports referenced (the file mirrors the package surface)
void createRamp
void hash01
const _unusedBasis = BASIS
void _unusedBasis

// ─── the grass field (the GPU-static vegetation) ────────────────────────────

describe('Task 126: the grass field', () => {
  it('bakes the instance arrays deterministically with in-range values', () => {
    const a = createGrassField({ count: 500, radius: 40, height: [0.3, 0.8], width: [0.05, 0.12], seed: 9 })
    const b = createGrassField({ count: 500, radius: 40, height: [0.3, 0.8], width: [0.05, 0.12], seed: 9 })
    expect([...a.pos]).toEqual([...b.pos])
    expect([...a.par]).toEqual([...b.par])
    expect([...a.tint]).toEqual([...b.tint])
    expect(a.count).toBe(500)
    let maxR = 0, minH = 1e9, maxH = -1e9
    for (let i = 0; i < 500; i++) {
      const r = Math.hypot(a.pos[i * 3], a.pos[i * 3 + 2])
      if (r > maxR) maxR = r
      if (a.pos[i * 3 + 1] !== 0) throw new Error('groundY')
      const h = a.par[i * 4]
      if (h < minH) minH = h
      if (h > maxH) maxH = h
      expect(a.par[i * 4 + 3]).toBeGreaterThanOrEqual(0.05)
      expect(a.par[i * 4 + 3]).toBeLessThanOrEqual(0.12)
      for (const v of [a.tint[i * 4], a.tint[i * 4 + 1], a.tint[i * 4 + 2], a.tint[i * 4 + 3]]) {
        expect(Number.isFinite(v)).toBe(true)
      }
    }
    expect(maxR).toBeLessThanOrEqual(40)
    expect(maxR).toBeGreaterThan(30) // actually spread to the rim
    expect(minH).toBeGreaterThanOrEqual(0.3)
    expect(maxH).toBeLessThanOrEqual(0.8)
  })

  it('different seeds differ; validation throws honest errors', () => {
    const a = createGrassField({ count: 8, radius: 5, height: [0.3, 0.8], seed: 1 })
    const b = createGrassField({ count: 8, radius: 5, height: [0.3, 0.8], seed: 2 })
    expect([...a.pos]).not.toEqual([...b.pos])
    expect(() => createGrassField({ count: 0, radius: 5, height: [0.3, 0.8] })).toThrow(/count/)
    expect(() => createGrassField({ count: 8, radius: -1, height: [0.3, 0.8] })).toThrow(/radius/)
    expect(() => createGrassField({ count: 8, radius: 5, height: [0.8, 0.3] })).toThrow(/height/)
  })

  it('the shader pair carries the uniform contract + the baked fade', () => {
    const f = createGrassField({ count: 4, radius: 30, height: [0.3, 0.8], fade: 27 })
    // the uniform contract lives in the vertex stages (+ the texture in both)
    for (const src of [f.glsl.vertex, f.wgsl]) {
      expect(src).toContain('u_mvp')
      expect(src).toContain('u_camPos')
      expect(src).toContain('u_time')
      expect(src).toContain('u_wind')
    }
    expect(f.glsl.fragment).toContain('u_tex')
    expect(f.wgsl).toContain('texTexture')
    expect(f.wgsl).toContain('@builtin(vertex_index)')
    expect(f.glsl.vertex).toContain('gl_VertexID')
    expect(f.wgsl).toContain('27.00')
    expect(f.glsl.vertex).toContain('27.00')
  })
})
