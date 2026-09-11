import { test, expect, describe, it } from 'bun:test'
import { createSpawner, hash01, type SpawnerDesc, type SpawnRecord } from '../src/index.ts'

/**
 * Task 173 — THE HYPOT RETIREMENT (the emission hot path): every
 * per-particle normalize in the CPU walks (the spawner's radial and
 * tangential, the trail ribbon's cap/dir/side, the stretched billboard's
 * velocity/side) now computes Math.sqrt(x*x + y*y + z*z) — the SAME
 * semantics the GPU twins normalize with (the WGSL emit kernel's and the
 * GLSL TF twin's length()/sqrt(dot)). The CPU was the lone Math.hypot
 * hold-out: hypot's overflow-safe path costs ~3× the op (measured on the
 * spawner closure: 95 → 81 ns/spawn; the trail bake frame: 9.0 →
 * 4.8 ms at 8k ribbons — the bake was hypot-DOMINATED).
 *
 * These pins hold the semantics at the BIT level: the emitted velocity
 * must be (p − o) normalized by Math.sqrt(dot) and scaled by the S_SPD
 * hash draw (salt 2 — the same draw the GPU kernel bakes in). A
 * regression back to Math.hypot changes the divisor's last ulp and
 * breaks these pins — the f32-parity suite would NOT catch it (one f64
 * ulp almost never crosses an f32 rounding boundary).
 */

const RADIAL_SPHERE: SpawnerDesc = {
  shape: { kind: 'sphere', origin: [1, 2, 3], radius: [0.05, 0.5] },
  velocity: { mode: 'radial' },
  speed: [2.5, 5.5],
  life: [1.2, 2.2],
  size: [0.05, 0.12],
  color: [[1, 1, 1, 1], [0.7, 0.85, 1, 0.8]],
  seed: 991,
}

const TANGENTIAL_DOME: SpawnerDesc = {
  shape: { kind: 'hemisphere', origin: [0, 0, 0], axis: [0, 1, 0], radius: [1, 4] },
  velocity: { mode: 'tangential' },
  speed: [1, 2],
  life: [2, 6],
  size: [0.2, 0.5],
  color: [[0.2, 1, 0.3, 1], [1, 1, 0, 0.2]],
  seed: 1234,
}

const newRecord = (): SpawnRecord => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size: 1, r: 1, g: 1, b: 1, a: 1, seed: 0, tx: NaN, ty: NaN, tz: NaN })

describe('Task 173 — the sqrt(dot) normalize contract (bit-exact)', () => {
  it('radial: v = (p − o)/sqrt(dot(p − o)) · (smin + (smax − smin)·hash01(seed, i, 2)) — bit-exact', () => {
    const spawner = createSpawner(RADIAL_SPHERE)
    const out = newRecord()
    const ox = (RADIAL_SPHERE.shape as { origin: readonly number[] }).origin[0], oy = (RADIAL_SPHERE.shape as { origin: readonly number[] }).origin[1], oz = (RADIAL_SPHERE.shape as { origin: readonly number[] }).origin[2]
    const [smin, smax] = RADIAL_SPHERE.speed as [number, number]
    const seed = RADIAL_SPHERE.seed ?? 1
    for (let i = 0; i < 500; i++) {
      spawner(i, out)
      const dx = out.x - ox, dy = out.y - oy, dz = out.z - oz
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz)
      expect(l).toBeGreaterThan(1e-12) // the scatter fallback never fires here
      const spd = smin + (smax - smin) * hash01(seed, i, 2) // S_SPD
      expect(out.vx).toBe((dx / l) * spd)
      expect(out.vy).toBe((dy / l) * spd)
      expect(out.vz).toBe((dz / l) * spd)
    }
  })

  it('tangential: v = cross(axis, radial)/sqrt(dot) · spd — bit-exact (a unit axis: [0,1,0])', () => {
    const spawner = createSpawner(TANGENTIAL_DOME)
    const out = newRecord()
    const [smin, smax] = TANGENTIAL_DOME.speed as [number, number]
    const seed = TANGENTIAL_DOME.seed ?? 1
    let pinned = 0
    for (let i = 0; i < 500; i++) {
      spawner(i, out)
      // axis [0,1,0] is unit at creation (hypot(0,1,0) = 1 exactly — the
      // SETUP normalize is untouched by Task 173). The cross product is
      // replicated COMPONENT-WISE from the same constants: the sign of
      // ZERO is IEEE-visible through toBe (0·rx − 0·rz is −0 when rx < 0
      // — a literal dy = 0 would pin the wrong zero).
      const rx = out.x, ry = out.y, rz = out.z
      const ax = 0, ay = 1, az = 0
      const dx = ay * rz - az * ry
      const dy = az * rx - ax * rz
      const dz = ax * ry - ay * rx
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (l <= 1e-12) continue // the axis fallback (a pole birth) — rare
      const spd = smin + (smax - smin) * hash01(seed, i, 2) // S_SPD
      expect(out.vx).toBe((dx / l) * spd)
      expect(out.vy).toBe((dy / l) * spd)
      expect(out.vz).toBe((dz / l) * spd)
      pinned++
    }
    expect(pinned).toBeGreaterThan(400) // the fallback never dominates
  })
})

test('the emitted velocity is radial (the semantic backstop, tolerance-level)', () => {
  const spawner = createSpawner(RADIAL_SPHERE)
  const out = newRecord()
  const ox = (RADIAL_SPHERE.shape as { origin: readonly number[] }).origin[0], oy = (RADIAL_SPHERE.shape as { origin: readonly number[] }).origin[1], oz = (RADIAL_SPHERE.shape as { origin: readonly number[] }).origin[2]
  for (let i = 0; i < 200; i++) {
    spawner(i, out)
    // v · (p − o) === |v||p − o| — the angle is 0 up to fp noise
    const dot = out.vx * (out.x - ox) + out.vy * (out.y - oy) + out.vz * (out.z - oz)
    const vmag = Math.sqrt(out.vx * out.vx + out.vy * out.vy + out.vz * out.vz)
    const dmag = Math.sqrt((out.x - ox) ** 2 + (out.y - oy) ** 2 + (out.z - oz) ** 2)
    expect(Math.abs(dot - vmag * dmag)).toBeLessThanOrEqual(1e-9 * vmag * dmag)
  }
})
