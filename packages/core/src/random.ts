/**
 * random.ts — the repo-standard deterministic uniform (Task 133: moved
 * from @rune/particles' spawn.ts — the hash IS the abstraction, the
 * spawner is just a consumer).
 *
 * WHY IN CORE: stateless integer-hash randomness is the foundation of
 * every reproducible thing this repo builds — particle spawning (its
 * birthplace), terrain scatter, instancing jitter, test fixtures. The
 * contract: a PURE function of its integer arguments — same inputs, same
 * bits, on every machine, every run, every backend. Pause/resume and
 * re-emission are bit-identical; call order never matters. No RNG state,
 * no Math.random, allocation-free.
 *
 * (A cousin with different mix constants lives in @rune/prims' terrain
 * noise — left alone: its golden geometry is pinned bit-exactly. New
 * code should standardize here.)
 */

/** A deterministic uniform in [0, 1): a Wang-style integer hash of
 *  (seed, index, salt). All inputs are integers. */
export function hash01(seed: number, index: number, salt: number): number {
  let h = (Math.imul(seed | 0, 374761393) + Math.imul(index | 0, 668265263) + Math.imul(salt | 0, 2246822519)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}
