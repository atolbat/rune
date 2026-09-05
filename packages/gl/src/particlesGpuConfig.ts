/**
 * particlesGpuConfig — THE SHARED TIER CONFIG (Task 133).
 *
 * The WebGPU compute orchestrator (particlesGpu.ts) and the WebGL2
 * transform-feedback orchestrator (particlesGpuGl.ts) both start by
 * reading the SAME facade — the static force set, the wrap box, the
 * atlas tiles — and each packs it into its own uniform layout. Before
 * Task 133 that interpretation existed TWICE (a ~55-line twin with
 * drift risk: a new force would have to be wired in both places with
 * the same activity conditions); this module is the ONE read, both
 * orchestrators pack from it.
 *
 * The values are STATIC (read once at attach — the GPU tier runs the
 * same forces; dynamic retargeting is rejected upstream). The per-frame
 * half (dt, the counts, the wrap center) stays with the orchestrators'
 * step() — it reads the facade handoff, not this config.
 */

import type { Particles } from '@rune/particles'

/** The point attractor, pre-flattened (softening² baked; zeroed when
 *  inactive — the `active` flag decides, the record's shape is uniform). */
export interface GpuTierAttract {
  readonly point: readonly number[]
  readonly strength: number
  readonly softening2: number
}

/** The simplex-noise force (zeroed when inactive). */
export interface GpuTierNoise {
  readonly strength: number
  readonly scale: number
  readonly speed: number
}

/** The speed governor — LimitSpeedOverLife (zeroed when inactive). */
export interface GpuTierLimit {
  readonly limit: number
  readonly dampen: number
}

/** The static tier config — the forces + the wrap box + the atlas tiles,
 *  interpreted once, consumed by both backends' uniform packers. The
 *  optional forces (attract/noise/limit/wrap) are ZERO-FILLED when absent
 *  — the `active` flags carry the presence, the records' shapes stay
 *  uniform (no null-walking at the pack sites). Task 134: the render
 *  half (sort/cull) rides the same one-read config — both orchestrators
 *  gate their sort/cull pipelines on it. */
export interface GpuTierConfig {
  readonly gravity: readonly number[]
  readonly drag: number
  readonly turbulence: number
  readonly attract: GpuTierAttract
  readonly noise: GpuTierNoise
  readonly limit: GpuTierLimit
  /** The wrap box (the facade handoff's own — zeroed without wrap). */
  readonly wrapSize: readonly number[]
  /** The ACTIVITY flags — the exact conditions both orchestrators gated
   *  on (a zero gravity is OFF, a null attractor is OFF, a zero-strength
   *  noise is OFF; the shader walks only what is on). */
  readonly active: {
    readonly gravity: boolean
    readonly drag: boolean
    readonly turbulence: boolean
    readonly attract: boolean
    readonly noise: boolean
    readonly limit: boolean
    readonly wrap: boolean
  }
  /** The atlas tiles (render.tiles ?? [1,1]). */
  readonly tiles: readonly [number, number]
  /** The per-particle random atlas tile (render.frameJitter ?? 0). */
  readonly frameJitter: number
  /** Task 134 — render.sort: the bitonic network runs (the records land
   *  far-to-near — the GPU twin of sortDepthBackToFront). */
  readonly sort: boolean
  /** Task 134 — render.cull: the per-particle frustum gate (the culled
   *  slots pack the zero record — a degenerate instance). */
  readonly cull: boolean
}

/** Reads the facade ONCE into the tier config (call after the handoff
 *  check — the wrap box comes from the handoff). */
export function readGpuTierConfig(facade: Particles): GpuTierConfig {
  const forces = facade.forces
  const gravity = forces.gravity ?? [0, 0, 0]
  const attract = forces.attract ?? null
  const noise = forces.noise ?? null
  const limit = forces.limitSpeed ?? null
  const wrap = facade.gpuHandoff?.wrapSize ?? null
  const render = facade.render as { tiles?: readonly [number, number]; frameJitter?: number; sort?: boolean; cull?: boolean }
  const wrapSize = wrap ?? [0, 0, 0]
  return {
    gravity,
    drag: forces.drag,
    turbulence: forces.turbulence,
    attract: attract === null
      ? { point: [0, 0, 0], strength: 0, softening2: 0 }
      : {
        point: attract.point,
        strength: attract.strength,
        softening2: (attract.softening ?? 0.25) ** 2,
      },
    noise: noise === null
      ? { strength: 0, scale: 0, speed: 0 }
      : { strength: noise.strength, scale: noise.scale, speed: noise.speed },
    limit: limit === null
      ? { limit: 0, dampen: 0 }
      : { limit: limit.limit, dampen: limit.dampen },
    wrapSize,
    active: {
      gravity: gravity[0] !== 0 || gravity[1] !== 0 || gravity[2] !== 0,
      drag: forces.drag > 0,
      turbulence: forces.turbulence !== 0,
      attract: attract !== null,
      noise: noise !== null && noise.strength !== 0,
      limit: limit !== null,
      wrap: wrap !== null && (wrap[0] > 0 || wrap[1] > 0 || wrap[2] > 0),
    },
    tiles: render.tiles ?? [1, 1],
    frameJitter: render.frameJitter ?? 0,
    sort: render.sort === true,
    cull: render.cull === true,
  }
}
