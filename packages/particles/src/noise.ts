/**
 * @rune/particles — the deterministic 3D simplex noise field.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Task 133: THE MOVE — simplex3/PERM/GRAD3 were an abstract useful entity
 * wearing a particle costume; they now live in @rune/core (noise.ts — the
 * CPU↔GPU parity tables are a cross-backend contract, not a consumer's
 * property). This module re-exports them (the public API is unchanged —
 * gpuSim.ts/gpuSimGl.ts bake the tables into WGSL/GLSL, system.ts
 * evaluates the field) and keeps the PARTICLES-DOMAIN half: the force
 * field description + its validation.
 * ══════════════════════════════════════════════════════════════════════════
 */

// The foundation half — moved to @rune/core (bit-identical: the WGSL/GLSL
// twins and the golden tests pin the table).
export { simplex3, PERM, GRAD3 } from '@rune/core'

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
