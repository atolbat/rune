// Task 141 — the bitonic sort network's plan (@rune/core gpu/bitonic.ts):
// the (k, j) sequence, the pad/sentinel pair and the padded network size —
// @rune/particles' Task 134 render-tier machinery, extracted as the
// stockham.ts-class "plan as pure data" (two backends — WGSL compute and
// GLSL transform feedback — evaluate the plan; the keys may be depths,
// priorities, anything an ordered walk needs).
//
// Pinned here:
//   1. THE PAD COUNT — nextPow2 with the ≥ 1 floor and the loud rejects
//      (the task134 goldens, including the 160k capacity's 262144).
//   2. THE NETWORK MODEL — a JS twin of the compare-exchange over the
//      sequence the backends dispatch sorts EXACTLY like Array.sort (the
//      semantics of the sequence ARE a sort — the same pins the WGSL/GLSL
//      twins carry on their side).
//   3. THE PAD/SENTINEL PAIR — 1e30 sorts after every real key; 2^25 is
//      float-exact and above every realistic index (f32 holds integers
//      exactly to 2^24).
//   4. THE PASS COUNT — log₂(padN)·(log₂(padN)+1)/2 (the dispatch budget
//      both orchestrators pay).

import { describe, expect, it } from 'bun:test'
import {
  bitonicPadCount, bitonicPassSequence, BITONIC_PAD_KEY, BITONIC_SENTINEL,
} from '../src/gpu/bitonic.ts'

/** A deterministic LCG (reproducible keys). */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

describe('Task 141 — bitonicPadCount', () => {
  it('the next power of two ≥ count, with the ≥ 1 floor', () => {
    expect(bitonicPadCount(0)).toBe(1)
    expect(bitonicPadCount(1)).toBe(1)
    expect(bitonicPadCount(2)).toBe(2)
    expect(bitonicPadCount(3)).toBe(4)
    expect(bitonicPadCount(5)).toBe(8)
    expect(bitonicPadCount(16)).toBe(16)
    expect(bitonicPadCount(17)).toBe(32)
    expect(bitonicPadCount(160_000)).toBe(262_144)
  })
  it('the loud rejects — a NaN or a negative count is a caller bug', () => {
    expect(() => bitonicPadCount(-1)).toThrow('must be a finite number')
    expect(() => bitonicPadCount(Number.NaN)).toThrow('must be a finite number')
    expect(() => bitonicPadCount(Number.POSITIVE_INFINITY)).toThrow('must be a finite number')
  })
})

describe('Task 141 — bitonicPassSequence (the network model)', () => {
  /** THE JS TWIN of the WGSL bitonic entry / the GLSL bitonic pass over the
   *  SAME (k, j) sequence: the low thread of (i, i^j) swaps when the pair
   *  violates the block's direction ((i & k) === 0 → ascending). */
  function bitonicModel<T>(entries: T[], keyOf: (e: T) => number): T[] {
    const N = entries.length
    const a = entries.slice()
    bitonicPassSequence(N, (k, j) => {
      for (let i = 0; i < N; i++) {
        const p = i ^ j
        if (p > i) {
          const asc = (i & k) === 0
          if ((keyOf(a[i]) > keyOf(a[p])) === asc) {
            const t = a[i]; a[i] = a[p]; a[p] = t
          }
        }
      }
    })
    return a
  }

  it('the sequence sorts EXACTLY like Array.sort (ascending, padded to padN)', () => {
    for (const [seed, n] of [[7, 64], [42, 33], [1234, 128]] as const) {
      const rng = lcg(seed)
      // unique keys — ties would be order-ambiguous (the network is not stable)
      const entries = Array.from({ length: n }, (_, i) => i * 100 + Math.floor(rng() * 99))
      const reference = entries.slice().sort((a, b) => a - b)
      // the network runs over the PADDED array (padN = nextPow2(n)); the
      // pads carry PAD_KEY and must trail the real prefix.
      const padN = bitonicPadCount(n)
      const padded = entries.concat(Array.from({ length: padN - n }, () => BITONIC_PAD_KEY))
      const sorted = bitonicModel(padded, (e) => e)
      expect(sorted.slice(0, n)).toEqual(reference)
      for (let i = n; i < padN; i++) expect(sorted[i]).toBe(BITONIC_PAD_KEY)
    }
  })

  it('the pads sort to the END (the draw order keeps the real prefix)', () => {
    const entries = [5, 3, 9, 1, 7, 2, 8, 4]
    const padN = bitonicPadCount(entries.length)
    const padded = entries.concat(Array.from({ length: padN - entries.length }, () => BITONIC_PAD_KEY))
    const sorted = bitonicModel(padded, (e) => e)
    expect(sorted.slice(0, entries.length)).toEqual([1, 2, 3, 4, 5, 7, 8, 9])
    for (let i = entries.length; i < padN; i++) expect(sorted[i]).toBe(BITONIC_PAD_KEY)
  })

  it('the pass count is log₂(padN)·(log₂(padN)+1)/2', () => {
    for (const padN of [1, 2, 4, 8, 64, 256, 262_144]) {
      let passes = 0
      bitonicPassSequence(padN, () => { passes++ })
      const log = Math.log2(padN)
      expect(passes).toBe((log * (log + 1)) / 2)
    }
  })

  it('padN = 1 — zero passes (a single element sorts trivially)', () => {
    let passes = 0
    bitonicPassSequence(1, () => { passes++ })
    expect(passes).toBe(0)
  })
})

describe('Task 141 — the pad/sentinel pair', () => {
  it('PAD_KEY (1e30) sorts after every real key', () => {
    expect(BITONIC_PAD_KEY).toBe(1e30)
    expect(BITONIC_PAD_KEY > 1e9).toBe(true)
  })
  it('SENTINEL (2^25) is float-exact and above every realistic index', () => {
    expect(BITONIC_SENTINEL).toBe(2 ** 25)
    expect(BITONIC_SENTINEL).toBe(33554432)
    // float32 holds integers exactly to 2^24 — the sentinel is above.
    expect(BITONIC_SENTINEL > 2 ** 24).toBe(true)
    // and it survives the f32 round-trip exactly (the pair's .y rides f32).
    const f32 = new Float32Array([BITONIC_SENTINEL])
    expect(f32[0]).toBe(BITONIC_SENTINEL)
    // every realistic index (a 16M-slot capacity) is below it, f32-exact.
    const idx = new Float32Array([16_777_215])
    expect(idx[0]).toBe(16_777_215)
    expect(idx[0] < BITONIC_SENTINEL).toBe(true)
  })
})
