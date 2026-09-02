/**
 * stockham.ts — the GPU Stockham FFT pass plan (2·log₂N ping-pong passes).
 *
 * Why in the library: the FFT pass schedule on ping-pong textures —
 * is the most delicate part of any FFT ocean (Tessendorf/david.li/waves,
 * jbouny/fft-ocean). A wrong "input texture → target texture" pair
 * on ONE pass is invisible in the code and turns the ocean into "flat mush with a
 * seam in the middle" (a real Task 114 incident: in the WebGL2 port with
 * even log₂N — N=256 — the u_input uniform of the first vertical pass
 * landed in a different program and a stale texture was read).
 *
 * The plan is PURE DATA: backends (WebGL2/WebGPU/simulator) execute it
 * independently, and the invariants are pinned by unit tests:
 *  1) length 2·log₂N; the horizontal axis — the first log₂N passes;
 *  2) subtransform sizes 2,4,…,N on each axis (Stockham);
 *  3) CHAIN: every pass reads exactly what the previous one wrote
 *     (plan[i].input === plan[i-1].target, i ≥ 1) — including at the
 *     horizontal→vertical junction;
 *  4) the final pass writes displacement;
 *  5) no pass reads its own target texture.
 *
 * DOM-free by construction — like all of @rune/core.
 */

/** The pass's target texture (names as in david.li/waves). */
export type FftPassTarget = 'pingTransform' | 'pongTransform' | 'displacement'

/** The pass's input texture. */
export type FftPassInput = 'spectrum' | 'pingTransform' | 'pongTransform'

/** One Stockham FFT pass. */
export interface FftPass {
  /** Pass index 0..2·log₂N−1. */
  readonly index: number
  /** Where we write. */
  readonly target: FftPassTarget
  /** What we read. */
  readonly input: FftPassInput
  /** true — horizontal axis (the first log₂N passes). */
  readonly horizontal: boolean
  /** Subtransform size 2^(k+1), k = index mod log₂N. */
  readonly subtransformSize: number
}

/**
 * The Stockham FFT pass plan for a resolution×resolution grid.
 * @param resolution a power of two ≥ 2 (256, 512, 1024, …).
 * @throws Error if resolution is not a power of two or is less than 2.
 */
export function fftPassPlan(resolution: number): readonly FftPass[] {
  if (!Number.isInteger(resolution) || resolution < 2 || (resolution & (resolution - 1)) !== 0) {
    throw new Error(`rune: fftPassPlan — resolution must be a power of two ≥ 2 (got ${resolution})`)
  }
  const iterations = Math.round(Math.log(resolution) / Math.LN2) * 2
  const half = iterations / 2
  const plan: FftPass[] = []
  for (let i = 0; i < iterations; i++) {
    let target: FftPassTarget
    let input: FftPassInput
    if (i === 0) {
      target = 'pingTransform'
      input = 'spectrum'
    } else if (i === iterations - 1) {
      target = 'displacement'
      input = iterations % 2 === 0 ? 'pingTransform' : 'pongTransform'
    } else if (i % 2 === 1) {
      target = 'pongTransform'
      input = 'pingTransform'
    } else {
      target = 'pingTransform'
      input = 'pongTransform'
    }
    plan.push({
      index: i,
      target,
      input,
      horizontal: i < half,
      subtransformSize: Math.pow(2, (i % half) + 1),
    })
  }
  return plan
}
