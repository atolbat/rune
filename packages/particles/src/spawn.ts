/**
 * @rune/particles — deterministic spawning: a stateless integer-hash RNG +
 * the shape spawners.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY A STATELESS HASH (not a mulberry32 stream): a stream RNG makes the
 * emission depend on CALL ORDER — the same (seed, particle index) pair
 * would produce different values after a pause/resume or a re-burst.
 * hash01(seed, i, salt) is a pure function of its arguments: same burst,
 * same numbers, every time. Determinism is a package guarantee (the tests
 * pin it bit-exactly).
 * ══════════════════════════════════════════════════════════════════════════
 */

import type { SpawnRecord } from './system.ts'

/** A deterministic uniform in [0, 1): a Wang-style integer hash of
 *  (seed, index, salt). All inputs are integers. */
export function hash01(seed: number, index: number, salt: number): number {
  let h = (Math.imul(seed | 0, 374761393) + Math.imul(index | 0, 668265263) + Math.imul(salt | 0, 2246822519)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** The spawn shape. `axis` vectors are normalized ONCE at spawner
 *  creation (the emit path only reads them).
 *
 *  Task 117 — the disc's SPIRAL ARMS (the galaxy-maker): `arms` angular
 *  sectors, `twist` radians of winding swept from radius[0] to radius[1],
 *  `armSpread` radians of uniform scatter within an arm. Omitted arms →
 *  the uniform annulus (the previous behavior, bit-identical). */
export type SpawnShape =
  | { readonly kind: 'point'; readonly origin: readonly number[] }
  | { readonly kind: 'sphere'; readonly origin: readonly number[]; readonly radius: readonly [number, number] }
  | { readonly kind: 'cone'; readonly origin: readonly number[]; readonly axis: readonly number[]; readonly halfAngle: number; readonly baseRadius: number; readonly length: readonly [number, number] }
  | { readonly kind: 'disc'; readonly origin: readonly number[]; readonly axis: readonly number[]; readonly radius: readonly [number, number]
      /** Arm count (integer ≥ 1). arms=1 = a single fanned sector (a comet
       *  tail / a barred galaxy). Default: no arms — the uniform annulus. */
      readonly arms?: number
      /** Angular scatter within an arm, radians (default 0.35). 0 = razor arms. */
      readonly armSpread?: number
      /** Total winding from the inner to the outer radius, radians (default 0 —
       *  straight radial arms). Negative = the opposite winding direction:
       *  match the sign to the orbit direction so the arms TRAIL (real galaxies). */
      readonly twist?: number }
  | { readonly kind: 'line'; readonly from: readonly number[]; readonly to: readonly number[] }

/** How the spawn velocity is directed.
 *  radial     — away from the shape origin (the sphere burst; any shape);
 *  lobe       — the cone's axis fanned by its halfAngle (cone only);
 *  axis       — along the shape axis (cone / disc / line);
 *  tangential — cross(axis, radial): orbits, galaxies, vortices
 *               (disc / sphere);
 *  fixed      — an explicit vector (any shape). */
export type VelocityMode =
  | { readonly mode: 'radial' }
  | { readonly mode: 'lobe' }
  | { readonly mode: 'axis' }
  | { readonly mode: 'tangential' }
  | { readonly mode: 'fixed'; readonly dir: readonly number[] }

/** The full spawner description: shape + velocity + per-particle ranges.
 *  Ranges are [min, max] — a constant is [v, v]. Colors interpolate
 *  linearly between two rgba endpoints.
 *
 *  Task 117 — the two radial modulators (the galaxy-maker kit):
 *   • speedByRadius — speed scales as (ref/r)^power (Keplerian shear at
 *     power ≈ 0.9: the inner rim visibly outruns the outer — spiral arms
 *     develop real differential rotation instead of a rigid donut);
 *   • colorByRadius — the color mix follows the radius (color[0] at the
 *     core → color[1] at the rim) instead of the per-particle hash —
 *     a warm core with cool arms, no random speckle. */
export interface SpawnerDesc {
  readonly shape: SpawnShape
  readonly velocity: VelocityMode
  /** Speed range, units/second. */
  readonly speed: readonly [number, number]
  /** Radial speed modulation: speed = range · (ref / r)^power, where r is
   *  the spawn distance from the shape origin (the disc/sphere radius).
   *  Omit = flat speed. The ref is the radius where the scale is exactly 1. */
  readonly speedByRadius?: { readonly ref: number; readonly power: number }
  /** The color mix follows r (the sphere/disc radius range) instead of the
   *  per-particle hash: color[0] at radius[0] → color[1] at radius[1].
 *      Requires the sphere or disc shape (they carry the radius range). */
  readonly colorByRadius?: boolean
  /** Lifetime range, seconds (> 0 — validated). */
  readonly life: readonly [number, number]
  /** Billboard size range, world units (>= 0). */
  readonly size: readonly [number, number]
  /** Tint endpoints, rgba. */
  readonly color: readonly [readonly number[], readonly number[]]
  /** The RNG stream seed (0..2^31); different seeds = different bursts. */
  readonly seed?: number
}

/** A spawner: (index, out) fills the reused record. Allocation-free. */
export type Spawner = (index: number, out: SpawnRecord) => void

const TAU = 6.283185307179586
// The salt streams: decorrelated per property (any distinct constants).
const S_DIR = 1, S_SPD = 2, S_LIFE = 3, S_SIZE = 4, S_COL = 5, S_SEED = 6, S_P0 = 7, S_P1 = 8, S_P2 = 9

/** Validates the description and compiles it into a flat spawner closure
 *  (all vectors normalized / precomputed ONCE, here). */
export function createSpawner(desc: SpawnerDesc): Spawner {
  const shape = desc.shape
  const velocity = desc.velocity
  const speed = rangeOf(desc.speed, 'speed')
  const life = rangeOf(desc.life, 'life')
  const size = rangeOf(desc.size, 'size')
  if (life[0] <= 0) throw new Error('rune/particles: spawner life must be > 0 (a zero-life particle is born dead)')
  if (size[0] < 0) throw new Error('rune/particles: spawner size must be >= 0')
  const seed = (desc.seed ?? 1) | 0
  const c0 = desc.color[0], c1 = desc.color[1]

  // ── the shape constants (origin, axis, ranges — all flat scalars) ──────
  const ox = shape.kind === 'line' ? shape.from[0] : shape.origin[0]
  const oy = shape.kind === 'line' ? shape.from[1] : shape.origin[1]
  const oz = shape.kind === 'line' ? shape.from[2] : shape.origin[2]
  let ax = 0, ay = 0, az = 1
  const hasAxis = shape.kind === 'cone' || shape.kind === 'disc' || shape.kind === 'line'
  if (hasAxis) {
    const vx = shape.kind === 'line' ? shape.to[0] - ox : shape.axis[0]
    const vy = shape.kind === 'line' ? shape.to[1] - oy : shape.axis[1]
    const vz = shape.kind === 'line' ? shape.to[2] - oz : shape.axis[2]
    const l = Math.hypot(vx, vy, vz)
    if (l === 0 || !Number.isFinite(l)) throw new Error('rune/particles: the shape axis (or the line endpoints) must be a finite non-zero vector')
    ax = vx / l; ay = vy / l; az = vz / l
  }
  let rMin = 0, rMax = 0
  if (shape.kind === 'sphere' || shape.kind === 'disc') {
    ;[rMin, rMax] = rangeOf(shape.radius, 'radius')
    if (rMin < 0) throw new Error('rune/particles: shape radius must be >= 0')
  }
  let halfAngle = 0, baseRadius = 0, lenMin = 0, lenMax = 0
  if (shape.kind === 'cone') {
    halfAngle = shape.halfAngle
    if (!(halfAngle >= 0 && halfAngle < Math.PI / 2)) throw new Error('rune/particles: cone halfAngle must be in [0, π/2)')
    baseRadius = shape.baseRadius
    if (baseRadius < 0) throw new Error('rune/particles: cone baseRadius must be >= 0')
    ;[lenMin, lenMax] = rangeOf(shape.length, 'length')
  }
  // Task 117: the disc's spiral arms — compiled ONCE into flat scalars.
  let arms = 0, armSpread = 0.35, twist = 0
  if (shape.kind === 'disc' && shape.arms !== undefined) {
    arms = shape.arms
    if (!Number.isInteger(arms) || arms < 1) throw new Error(`rune/particles: disc arms must be an integer >= 1 (got ${arms})`)
    armSpread = shape.armSpread ?? 0.35
    if (!Number.isFinite(armSpread) || armSpread < 0) throw new Error(`rune/particles: disc armSpread must be a finite >= 0 (got ${armSpread})`)
    twist = shape.twist ?? 0
    if (!Number.isFinite(twist)) throw new Error(`rune/particles: disc twist must be finite (got ${twist})`)
  }
  // Task 117: the radial modulators — speed scaling and the radius-driven
  // color mix. colorByRadius needs the radius RANGE → sphere/disc only.
  let speedRef = 0, speedPower = 0
  if (desc.speedByRadius !== undefined) {
    speedRef = desc.speedByRadius.ref
    speedPower = desc.speedByRadius.power
    if (!Number.isFinite(speedRef) || speedRef <= 0) throw new Error(`rune/particles: speedByRadius.ref must be a finite > 0 (got ${speedRef})`)
    if (!Number.isFinite(speedPower)) throw new Error(`rune/particles: speedByRadius.power must be finite (got ${speedPower})`)
  }
  const colorByRadius = desc.colorByRadius === true
  if (colorByRadius && shape.kind !== 'disc' && shape.kind !== 'sphere') {
    throw new Error("rune/particles: colorByRadius needs the sphere or disc shape (the radius range drives the mix)")
  }

  // ── the velocity mode validation (an honest pairing, no silent traps) ──
  let fx = 0, fy = 0, fz = 1
  if (velocity.mode === 'fixed') {
    const l = Math.hypot(velocity.dir[0], velocity.dir[1], velocity.dir[2])
    if (l === 0 || !Number.isFinite(l)) throw new Error('rune/particles: fixed velocity dir must be a finite non-zero vector')
    fx = velocity.dir[0] / l; fy = velocity.dir[1] / l; fz = velocity.dir[2] / l
  } else if (velocity.mode === 'lobe' && shape.kind !== 'cone') {
    throw new Error("rune/particles: velocity mode 'lobe' needs the cone shape (its halfAngle defines the fan)")
  } else if (velocity.mode === 'axis' && !hasAxis) {
    throw new Error("rune/particles: velocity mode 'axis' needs a shape with an axis (cone/disc/line)")
  } else if (velocity.mode === 'tangential' && shape.kind !== 'disc' && shape.kind !== 'sphere') {
    throw new Error("rune/particles: velocity mode 'tangential' needs the disc or sphere shape")
  }

  // The orthonormal frame around the axis: t1, t2 (both ⊥ axis, ⊥ each other).
  // t0 = cross(axis, worldUp) with a fallback when the axis is ±Y.
  let t1x = -az, t1y = 0, t1z = ax
  let tl = Math.hypot(t1x, t1y, t1z)
  if (tl < 1e-6) { t1x = 1; t1y = 0; t1z = 0; tl = 1 }
  t1x /= tl; t1y /= tl; t1z /= tl
  const t2x = ay * t1z - az * t1y, t2y = az * t1x - ax * t1z, t2z = ax * t1y - ay * t1x

  return function spawner(index, out) {
    // Independent streams per decision — position and velocity stay
    // uncorrelated (a correlated burst visibly "columns").
    const u = hash01(seed, index, S_DIR)
    const v = hash01(seed, index, S_DIR + 100)
    let px = ox, py = oy, pz = oz
    let dx = fx, dy = fy, dz = fz

    if (shape.kind === 'sphere') {
      // A uniform direction on the unit sphere: cosθ = 1 − 2u, φ = τv.
      const z = 1 - 2 * u
      const s = Math.sqrt(Math.max(0, 1 - z * z))
      const phi = TAU * v
      dx = s * Math.cos(phi); dy = s * Math.sin(phi); dz = z
      const r = rMin + (rMax - rMin) * hash01(seed, index, S_P0)
      px = ox + dx * r; py = oy + dy * r; pz = oz + dz * r
    } else if (shape.kind === 'cone') {
      // The velocity lobe: the polar angle FAN-COMPRESSED into the cone
      // (cosθ uniform on [cosHalf, 1] — uniform over the solid angle),
      // φ uniform around the axis.
      const cosHalf = Math.cos(halfAngle)
      const z = 1 - (1 - cosHalf) * u
      const s = Math.sqrt(Math.max(0, 1 - z * z))
      const phi = TAU * v
      dx = ax * z + (t1x * Math.cos(phi) + t2x * Math.sin(phi)) * s
      dy = ay * z + (t1y * Math.cos(phi) + t2y * Math.sin(phi)) * s
      dz = az * z + (t1z * Math.cos(phi) + t2z * Math.sin(phi)) * s
      // The position: a disc in the base plane (√ mapping — area-uniform)
      // + a stretch along the axis. Independent salts (S_P0/1/2).
      const rr = baseRadius * Math.sqrt(hash01(seed, index, S_P0))
      const rphi = TAU * hash01(seed, index, S_P1)
      const stretch = lenMin + (lenMax - lenMin) * hash01(seed, index, S_P2)
      const cx = Math.cos(rphi) * rr, cy = Math.sin(rphi) * rr
      px = ox + t1x * cx + t2x * cy + ax * stretch
      py = oy + t1y * cx + t2y * cy + ay * stretch
      pz = oz + t1z * cx + t2z * cy + az * stretch
    } else if (shape.kind === 'disc') {
      // Uniform in the annulus: r² = rMin² + u·(rMax² − rMin²).
      const r2 = rMin * rMin + (rMax * rMax - rMin * rMin) * u
      const rr = Math.sqrt(r2)
      // Task 117: with arms — the angular coordinate is the arm sector + the
      // radial twist + the uniform scatter (independent salts: S_P0 the arm
      // pick, S_P1 the scatter). Without arms — the uniform annulus as before.
      let phi: number
      if (arms > 0) {
        const arm = Math.floor(hash01(seed, index, S_P0) * arms)
        const scatter = (hash01(seed, index, S_P1) - 0.5) * 2 * armSpread
        const tR = (rr - rMin) / Math.max(1e-6, rMax - rMin)
        phi = arm * (TAU / arms) + twist * tR + scatter
      } else {
        phi = TAU * v
      }
      px = ox + (t1x * Math.cos(phi) + t2x * Math.sin(phi)) * rr
      py = oy + (t1y * Math.cos(phi) + t2y * Math.sin(phi)) * rr
      pz = oz + (t1z * Math.cos(phi) + t2z * Math.sin(phi)) * rr
    } else if (shape.kind === 'line') {
      px = ox + (shape.to[0] - ox) * u
      py = oy + (shape.to[1] - oy) * u
      pz = oz + (shape.to[2] - oz) * u
    }

    // The velocity direction by mode.
    if (velocity.mode === 'radial') {
      dx = px - ox; dy = py - oy; dz = pz - oz
      const l = Math.hypot(dx, dy, dz)
      if (l > 1e-12) { dx /= l; dy /= l; dz /= l } else { dx = ax; dy = ay; dz = az }
    } else if (velocity.mode === 'axis') {
      dx = ax; dy = ay; dz = az
    } else if (velocity.mode === 'tangential') {
      // cross(axis, radial) normalized: the orbit direction.
      const rx = px - ox, ry = py - oy, rz = pz - oz
      dx = ay * rz - az * ry; dy = az * rx - ax * rz; dz = ax * ry - ay * rx
      const l = Math.hypot(dx, dy, dz)
      if (l > 1e-12) { dx /= l; dy /= l; dz /= l } else { dx = ax; dy = ay; dz = az }
    }
    // 'lobe' (cone) and 'fixed' keep the dx/dy/dz computed above.

    // Task 117: the radial speed modulation — (ref / r)^power over the spawn
    // distance from the shape origin. r is floored at 0.01 (a point/line
    // spawn at the origin with power > 0 would otherwise explode; the emit
    // validation still rejects non-finite results loudly).
    let spd = speed[0] + (speed[1] - speed[0]) * hash01(seed, index, S_SPD)
    if (speedRef > 0) {
      const rdx = px - ox, rdy = py - oy, rdz = pz - oz
      const rad = Math.sqrt(rdx * rdx + rdy * rdy + rdz * rdz)
      spd *= Math.pow(speedRef / Math.max(rad, 0.01), speedPower)
    }
    // Task 117: the radius-driven color mix (color[0] at the core →
    // color[1] at the rim) — otherwise the per-particle hash.
    let mix = hash01(seed, index, S_COL)
    if (colorByRadius) {
      const rdx = px - ox, rdy = py - oy, rdz = pz - oz
      const rad = Math.sqrt(rdx * rdx + rdy * rdy + rdz * rdz)
      mix = Math.min(1, Math.max(0, (rad - rMin) / Math.max(1e-6, rMax - rMin)))
    }
    out.x = px; out.y = py; out.z = pz
    out.vx = dx * spd; out.vy = dy * spd; out.vz = dz * spd
    out.life = life[0] + (life[1] - life[0]) * hash01(seed, index, S_LIFE)
    out.size = size[0] + (size[1] - size[0]) * hash01(seed, index, S_SIZE)
    out.r = c0[0] + (c1[0] - c0[0]) * mix
    out.g = c0[1] + (c1[1] - c0[1]) * mix
    out.b = c0[2] + (c1[2] - c0[2]) * mix
    out.a = c0[3] + (c1[3] - c0[3]) * mix
    out.seed = hash01(seed, index, S_SEED)
  }
}

/** A [min, max] range with the min <= max + finiteness validation. */
function rangeOf(range: readonly number[], name: string): [number, number] {
  const min = range[0], max = range[1]
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) {
    throw new Error(`rune/particles: spawner ${name} range must be [min <= max], finite (got [${min}, ${max}])`)
  }
  return [min, max]
}
