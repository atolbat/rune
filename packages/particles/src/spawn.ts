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
 *  creation (the emit path only reads them). */
export type SpawnShape =
  | { readonly kind: 'point'; readonly origin: readonly number[] }
  | { readonly kind: 'sphere'; readonly origin: readonly number[]; readonly radius: readonly [number, number] }
  | { readonly kind: 'cone'; readonly origin: readonly number[]; readonly axis: readonly number[]; readonly halfAngle: number; readonly baseRadius: number; readonly length: readonly [number, number] }
  | { readonly kind: 'disc'; readonly origin: readonly number[]; readonly axis: readonly number[]; readonly radius: readonly [number, number] }
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
 *  linearly between two rgba endpoints. */
export interface SpawnerDesc {
  readonly shape: SpawnShape
  readonly velocity: VelocityMode
  /** Speed range, units/second. */
  readonly speed: readonly [number, number]
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
      const phi = TAU * v
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

    const spd = speed[0] + (speed[1] - speed[0]) * hash01(seed, index, S_SPD)
    out.x = px; out.y = py; out.z = pz
    out.vx = dx * spd; out.vy = dy * spd; out.vz = dz * spd
    out.life = life[0] + (life[1] - life[0]) * hash01(seed, index, S_LIFE)
    out.size = size[0] + (size[1] - size[0]) * hash01(seed, index, S_SIZE)
    const mix = hash01(seed, index, S_COL)
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
