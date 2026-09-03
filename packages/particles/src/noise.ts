/**
 * @rune/particles — the deterministic 3D simplex noise field.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * three.quarks' TurbulenceField pushes particles through a simplex-noise
 * flow; our sine drift (system.ts `turbulence`) is cheap but visibly
 * periodic. This module is the real thing: classic Gustavson-style 3D
 * simplex noise, evaluated per particle at (position·scale + time·drift).
 *
 * DETERMINISM CONTRACT: the permutation table is a FIXED constant table
 * (a hash-shuffle with the seed 0, baked at module load) — the same input
 * gives the same noise on every machine, every run, every backend. No
 * Math.random anywhere. Allocation-free evaluation: the perm/grad tables
 * are module constants, all locals.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** The noise field description (a force-fields member, see system.ts). */
export interface NoiseField {
  /** Field amplitude, units/s² of acceleration. */
  readonly strength: number
  /** Spatial frequency: the noise coordinate = position · scale (bigger =
   *  tighter wisps). */
  readonly scale: number
  /** Temporal frequency: the field advects at time · speed (units of
   *  seconds⁻¹ — the drift). */
  readonly speed: number
}

const F3 = 1 / 3
const G3 = 1 / 6

/** The fixed permutation table (512 entries, wrapped) — the constant that
 *  pins the noise to the same field everywhere. */
const PERM = buildPerm()

function buildPerm(): Uint8Array {
  // A deterministic Fisher-Yates over 0..255 driven by our own integer
  // hash (spawn.ts's cousin, inlined — no import cycle): same table on
  // every load, no RNG state.
  const p = new Uint8Array(256)
  for (let i = 0; i < 256; i++) p[i] = i
  let state = 0x9e3779b9
  for (let i = 255; i > 0; i--) {
    state = Math.imul(state ^ (state >>> 15), 0x85ebca6b) | 0
    state = Math.imul(state ^ (state >>> 13), 0xc2b2ae35) | 0
    const j = (state >>> 24) % (i + 1)
    const t = p[i]
    p[i] = p[j]
    p[j] = t
  }
  const wrapped = new Uint8Array(512)
  for (let i = 0; i < 512; i++) wrapped[i] = p[i & 255]
  return wrapped
}

/** The 12 simplex gradients (ijk on the cube edges). */
const GRAD3 = new Int8Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
])

/** One noise sample in [-1, 1]. Pure, allocation-free, deterministic. */
export function simplex3(x: number, y: number, z: number): number {
  const s = (x + y + z) * F3
  const i = Math.floor(x + s), j = Math.floor(y + s), k = Math.floor(z + s)
  const t = (i + j + k) * G3
  const x0 = x - (i - t), y0 = y - (j - t), z0 = z - (k - t)
  // The simplex containing (x0,y0,z0): the ranking of the three offsets.
  let i1: number, j1: number, k1: number, i2: number, j2: number, k2: number
  if (x0 >= y0) {
    if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0 }
    else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1 }
    else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1 }
  } else {
    if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1 }
    else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1 }
    else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0 }
  }
  const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3
  const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3
  const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3
  const ii = i & 255, jj = j & 255, kk = k & 255
  let n = 0
  let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0
  if (t0 > 0) {
    const g = (PERM[ii + PERM[jj + PERM[kk]]] % 12) * 3
    t0 *= t0
    n += t0 * t0 * (GRAD3[g] * x0 + GRAD3[g + 1] * y0 + GRAD3[g + 2] * z0)
  }
  let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1
  if (t1 > 0) {
    const g = (PERM[ii + i1 + PERM[jj + j1 + PERM[kk + k1]]] % 12) * 3
    t1 *= t1
    n += t1 * t1 * (GRAD3[g] * x1 + GRAD3[g + 1] * y1 + GRAD3[g + 2] * z1)
  }
  let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2
  if (t2 > 0) {
    const g = (PERM[ii + i2 + PERM[jj + j2 + PERM[kk + k2]]] % 12) * 3
    t2 *= t2
    n += t2 * t2 * (GRAD3[g] * x2 + GRAD3[g + 1] * y2 + GRAD3[g + 2] * z2)
  }
  let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3
  if (t3 > 0) {
    const g = (PERM[ii + 1 + PERM[jj + 1 + PERM[kk + 1]]] % 12) * 3
    t3 *= t3
    n += t3 * t3 * (GRAD3[g] * x3 + GRAD3[g + 1] * y3 + GRAD3[g + 2] * z3)
  }
  return 32 * n
}

/** Validation of the field (once, at facade creation — the hot loop
 *  trusts its inputs). */
export function validateNoise(noise: NoiseField): NoiseField {
  if (!Number.isFinite(noise.strength)) {
    throw new Error(`rune/particles: noise.strength must be finite (got ${noise.strength})`)
  }
  if (!Number.isFinite(noise.scale) || noise.scale <= 0) {
    throw new Error(`rune/particles: noise.scale must be a finite > 0 (got ${noise.scale})`)
  }
  if (!Number.isFinite(noise.speed) || noise.speed < 0) {
    throw new Error(`rune/particles: noise.speed must be a finite >= 0 (got ${noise.speed})`)
  }
  return noise
}
