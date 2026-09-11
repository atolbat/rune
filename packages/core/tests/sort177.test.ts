// Task 177 — THE DIGIT TIER (@rune/core sort.ts): the pass count is the
// radix's cost driver (each pass = a full sequential read + a
// random-write scatter over the ping-pong), so the digit WIDTH buys
// passes with histogram span. The Task-176 four-pass 8-bit body is
// RETIRED in favor of an auto-selection: 2×16-bit passes at
// RADIX_16BIT_MIN (65536 counters, 256 KiB — the ~0.1 ms fixed fill+scan
// amortizes by ~8k elements) and 3×11-bit passes below (2048 counters,
// 8 KiB L1 span — a ~10 µs fixed cost). Measured (bench/ab-digits):
// 7.2 → 3.9 ms at 100k, 14.6 → 7.9 at 200k.
//
// The digit split is PERF-ONLY: a stable LSD's digit split cannot
// change the total order — every pass is stable and the concatenation
// of stable digit passes sorts by the full word. Pinned here:
//   1. THE BOUNDARY — counts 8191/8192/8193 (and well above) are
//      byte-identical to the classic comparator, indices AND keys.
//   2. BOTH BRANCHES across a size/seed sweep with tie-heavy scenes.
//   3. THE ODD-PATH COPY-OUT — the 3-pass branch lands its payload in
//      iAlt; the caller's `indices` contract is restored exactly (the
//      boundary sweep pins it on the small side, the ping-pong across
//      the boundary pins it under buffer reuse).
//   4. THE PING-PONG ACROSS THE BOUNDARY — one shared aux, alternating
//      counts both below and above RADIX_16BIT_MIN: no stale state.
//   5. THE THRESHOLD CONTRACT — RADIX_16BIT_MIN is exported and equals
//      8192 (the particles staged bake shares it).
//   6. Determinism — the same call twice, the same bytes (both branches).

import { describe, expect, it } from 'bun:test'
import { sortBackToFront, RADIX_16BIT_MIN, type SortScratch } from '../src/sort.ts'

/** The classic tier, verbatim extraction — the parity oracle. */
function classicRef(
  px: Float32Array, py: Float32Array, pz: Float32Array, count: number,
  fx: number, fy: number, fz: number,
  indices: Int32Array, keys: Float32Array,
): number {
  if (count <= 0) return 0
  for (let i = 0; i < count; i++) {
    indices[i] = i
    keys[i] = fx * px[i] + fy * py[i] + fz * pz[i]
  }
  indices.subarray(0, count).sort((a, b) => keys[b] - keys[a] || b - a)
  return count
}

function makeAux(n: number): SortScratch {
  return { k: new Uint32Array(n), kAlt: new Uint32Array(n), iAlt: new Int32Array(n) }
}

function hashRng(seed: number): () => number {
  let s = seed | 0
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    return ((s >>> 0) % 1000003) / 1000003
  }
}

function scene(n: number, seed: number): { px: Float32Array; py: Float32Array; pz: Float32Array } {
  const rnd = hashRng(seed)
  const px = new Float32Array(n), py = new Float32Array(n), pz = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    px[i] = (rnd() * 2 - 1) * 50
    py[i] = (rnd() * 2 - 1) * 30
    pz[i] = (rnd() * 2 - 1) * 50
    if (i > 0 && (i & 15) === 0) { px[i] = px[i - 1]; py[i] = py[i - 1]; pz[i] = pz[i - 1] } // exact-key ties
  }
  return { px, py, pz }
}

const F = [0.26726124, 0.53452248, 0.80178373] // a realistic normalized camera forward

function assertParity(
  px: Float32Array, py: Float32Array, pz: Float32Array, n: number,
  label: string,
): void {
  const a = new Int32Array(n + 3), ka = new Float32Array(n + 3) // capacity-sized, like the facade
  const b = new Int32Array(n + 3), kb = new Float32Array(n + 3)
  const rc = classicRef(px, py, pz, n, F[0], F[1], F[2], a, ka)
  const rr = sortBackToFront(px, py, pz, n, F, b, kb, makeAux(n + 3))
  expect(rr).toBe(rc)
  for (let i = 0; i < n; i++) {
    if (b[i] !== a[i]) throw new Error(`${label}: index divergence at rank ${i}: classic=${a[i]} radix=${b[i]}`)
    if (kb[i] !== ka[i]) throw new Error(`${label}: key divergence at slot ${i}`)
  }
}

describe('Task 177 — THE DIGIT TIER (the pass-count economics)', () => {
  it('THE THRESHOLD CONTRACT — RADIX_16BIT_MIN exported, equals 8192', () => {
    expect(RADIX_16BIT_MIN).toBe(8192)
    expect(typeof RADIX_16BIT_MIN).toBe('number')
  })

  it('THE BOUNDARY — 8191/8192/8193 (and above): byte-identical to the classic comparator', () => {
    // The 11-bit branch ends at 8191; the 16-bit branch starts at 8192.
    // A digit-split bug (a mask hole, a shift overlap, a stability break)
    // diverges on exactly these straddling counts.
    for (const n of [8191, 8192, 8193, 9000, 12000]) {
      for (const seed of [1, 991]) {
        const { px, py, pz } = scene(n, seed)
        assertParity(px, py, pz, n, `boundary n=${n} seed=${seed}`)
      }
    }
  })

  it('BOTH BRANCHES — the sweep (11-bit below, 16-bit above), ties included', () => {
    for (const n of [1, 2, 3, 7, 64, 513, 1024, 4096, 8191, 8192, 10000, 16384]) {
      for (const seed of [1, 4242]) {
        const { px, py, pz } = scene(n, seed)
        assertParity(px, py, pz, n, `sweep n=${n} seed=${seed}`)
      }
    }
  })

  it('THE PING-PONG ACROSS THE BOUNDARY — one shared aux, alternating counts, no stale state', () => {
    // The facade reuses one capacity-sized aux across frames whose live
    // counts cross the digit boundary in both directions; a pass that
    // reads a stale tail (or the odd-path copy-out reading the wrong
    // ping partner) corrupts exactly here.
    const big = scene(8300, 3)
    const small = scene(4111, 4)
    const tiny = scene(97, 5)
    const aux = makeAux(8300)
    const seq = [big, small, big, tiny, big, small] as const
    for (const s of seq) {
      const n = s.px.length
      const a = new Int32Array(n), ka = new Float32Array(n)
      const b = new Int32Array(n), kb = new Float32Array(n)
      classicRef(s.px, s.py, s.pz, n, F[0], F[1], F[2], a, ka)
      sortBackToFront(s.px, s.py, s.pz, n, F, b, kb, aux)
      expect(Array.from(b.subarray(0, n))).toEqual(Array.from(a.subarray(0, n)))
      expect(Array.from(kb.subarray(0, n))).toEqual(Array.from(ka.subarray(0, n)))
    }
  })

  it('determinism — the same call twice, the same bytes (both branches)', () => {
    for (const n of [513, 8192]) {
      const { px, py, pz } = scene(n, 991)
      const aux = makeAux(n)
      const a = new Int32Array(n), ka = new Float32Array(n)
      const b = new Int32Array(n), kb = new Float32Array(n)
      sortBackToFront(px, py, pz, n, F, a, ka, aux)
      sortBackToFront(px, py, pz, n, F, b, kb, aux)
      expect(Array.from(a.subarray(0, n))).toEqual(Array.from(b.subarray(0, n)))
      expect(Array.from(ka.subarray(0, n))).toEqual(Array.from(kb.subarray(0, n)))
    }
  })
})
