/**
 * bitonic.ts — the bitonic sort network as pure data (Task 141).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY HERE: the (key, index) bitonic network over a GPU buffer was the
 * private machinery of @rune/particles' render tier (Task 134 — the
 * painter's order for alpha-blended layers on both backends), but the
 * network itself is consumer-agnostic: a compute shader (WGSL) or a
 * transform-feedback pass (GLSL) executes it, the keys may be depths,
 * distances, priorities — anything a "draw far first" or a "process by
 * rank" order needs. This module is the PLAN (the stockham.ts precedent:
 * "a plan as pure data, backends execute it independently"); the WGSL and
 * GLSL twins that EVALUATE the plan stay with their consumers (they bake
 * the record layout — a consumer property).
 *
 * THE NETWORK: a bitonic sort of padN = nextPow2(count) elements runs
 * log₂(padN)·(log₂(padN)+1)/2 compare-exchange passes; pass p carries
 * (k, j) — k = the block being bitonized (2 → padN), j = the compare
 * distance (k/2 → 1). `bitonicPassSequence` walks the CANONICAL sequence;
 * every backend that dispatches the sequence in order sorts identically
 * (the test suite pins the sequence's model against Array.sort).
 *
 * THE PADS: the tail [count, padN) carries (PAD_KEY, SENTINEL) pairs —
 * PAD_KEY (+1e30) sorts after every real key in the ASCENDING network;
 * SENTINEL (2^25, float-exact — f32 holds integers exactly to 2^24, and
 * every real index is below) marks the pair as a pad so the consumer's
 * pack step can recognize it (the particles' records write the ZERO row —
 * a degenerate instance that draws nothing). The same pair marks the
 * FRUSTUM-CULLED slots: the cull and the pad are one mechanism (sort to
 * the END of the draw order).
 *
 * DOM-free by construction — like all of @rune/core.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** The pad/cull key: +1e30 — far above any real key, so the pads AND the
 *  frustum-culled slots sort LAST in the ascending network (behind every
 *  drawn particle, in front of nothing). */
export const BITONIC_PAD_KEY = 1e30

/** The pad/cull INDEX sentinel: 2^25 — a float-exact integer greater than
 *  any realistic index. The consumer's pack step reads it as "not a real
 *  element" (the particles' records write the ZERO row — a degenerate
 *  instance draws nothing). */
export const BITONIC_SENTINEL = 33554432

/**
 * The padded network size: the next power of two ≥ count (the bitonic
 * network's own requirement — the dispatch runs over [0, padN); the tail
 * [count, padN) is sentinel pads). ≥ 1: a single element sorts trivially
 * (zero network passes). Count must be a finite number ≥ 0 — the loud
 * contract (a NaN or a negative count is a caller's bug, not a pad).
 */
export function bitonicPadCount(count: number): number {
  if (!Number.isFinite(count) || count < 0) {
    throw new Error(`rune/core: bitonicPadCount — count must be a finite number ≥ 0 (got ${count})`)
  }
  if (count <= 1) return 1
  return 1 << Math.ceil(Math.log2(count))
}

/**
 * The canonical bitonic (k, j) sequence for a padded network size —
 * k = 2 → padN (the block being bitonized), j = k/2 → 1 (the compare
 * distance): log₂(padN)·(log₂(padN)+1)/2 passes, each ONE dispatch/pass
 * with its (k, j) in the uniforms or the buffer head. Both the WGSL entry
 * and the GLSL pass evaluate the same (k, j) — the test suite pins the
 * sequence's MODEL against Array.sort.
 */
export function bitonicPassSequence(padN: number, run: (k: number, j: number) => void): void {
  for (let k = 2; k <= padN; k <<= 1) {
    for (let j = k >> 1; j > 0; j >>= 1) run(k, j)
  }
}
