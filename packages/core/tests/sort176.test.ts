// Task 176 — THE RADIX TIER (@rune/core sort.ts): the 100k+ alpha layer's
// painter's order. The classic body was a JS-comparator subarray sort —
// ~1.7M comparator calls at 100k, measured 32 ms/frame raw (the etalon
// set never saw it; the sorted-layer scenario now exists). The radix tier
// is FOUR passes of 8-bit stable LSD over the IEEE bit-flip of the f32
// key, on caller-owned ping-pong scratch (`aux` — the frustumScratch
// precedent); without `aux` the classic comparator tier runs verbatim.
//
// Pinned here:
//   1. THE PARITY GATE — radix vs classic, byte-identical index sequences
//      AND keys, across sizes/seeds/tie-heavy/±0/extreme scenes. The
//      comparator's total order (key DESC, ties → slot DESC) is the exact
//      realizer: −0 canonicalized to +0 (JS compares them equal — the tie
//      survives), the stable LSD's input walk is slot-descending.
//   2. THE CONTRACT — count ≤ 0 → 0; count 1 → keys[0] + indices[0];
//      keys[slot] = the f32 dot (the caller's scratch, slot-indexed).
//   3. THE FALLBACK — aux too small (any of the three) → the classic
//      tier's exact output.
//   4. THE PING-PONG — shared aux across calls of alternating counts: no
//      stale state leaks (every call equals a fresh classic sort).
//   5. Determinism — the same call twice, the same bytes.

import { describe, expect, it } from 'bun:test'
import { sortBackToFront, type SortScratch } from '../src/sort.ts'

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
  fx: number, fy: number, fz: number, label: string,
): void {
  const a = new Int32Array(n + 3), ka = new Float32Array(n + 3) // capacity-sized, like the facade
  const b = new Int32Array(n + 3), kb = new Float32Array(n + 3)
  const rc = classicRef(px, py, pz, n, fx, fy, fz, a, ka)
  const rr = sortBackToFront(px, py, pz, n, [fx, fy, fz], b, kb, makeAux(n + 3))
  expect(rr).toBe(rc)
  for (let i = 0; i < n; i++) {
    if (b[i] !== a[i]) throw new Error(`${label}: index divergence at rank ${i}: classic=${a[i]} radix=${b[i]}`)
    if (kb[i] !== ka[i]) throw new Error(`${label}: key divergence at slot ${i}`)
  }
}

describe('Task 176 — THE RADIX TIER (parity: the exact total order)', () => {
  it('radix ≡ classic across sizes and seeds (indices AND keys, byte-exact)', () => {
    for (const n of [1, 2, 3, 7, 64, 100, 513, 1024, 10000]) {
      for (const seed of [1, 991, 4242]) {
        const { px, py, pz } = scene(n, seed)
        assertParity(px, py, pz, n, F[0], F[1], F[2], `n=${n} seed=${seed}`)
      }
    }
  })

  it('±0 keys stay TIES (−0 canonicalized — JS compares them equal)', () => {
    // forward all-negative, every particle at the origin: every key lands
    // ±0. The comparator ties them ALL → slot-descending; the radix must
    // canonicalize −0 → +0 or the flip would order them STRICTLY (wrong).
    const n = 64
    const px = new Float32Array(n), py = new Float32Array(n), pz = new Float32Array(n)
    assertParity(px, py, pz, n, -0.577, -0.577, -0.577, '±0 scene')
  })

  it('extreme keys: ±Infinity and huge-finite stay ordered like the comparator', () => {
    // keys beyond f32 range round to ±Inf in the keys scratch; the flip's
    // ends must match the comparator's sign behavior exactly.
    const n = 8
    const px = new Float32Array([1e38, -1e38, 3e38, -3e38, 1e-40, -1e-40, 0, 5e37])
    const py = new Float32Array(n), pz = new Float32Array(n)
    assertParity(px, py, pz, n, 1.2, 0.9, 1.5, 'extremes')
  })

  it('count ≤ 0 → 0 (with aux present) — the no-op contract holds', () => {
    const idx = new Int32Array(8), keys = new Float32Array(8)
    expect(sortBackToFront(new Float32Array(8), new Float32Array(8), new Float32Array(8), 0, [0, 0, -1], idx, keys, makeAux(8))).toBe(0)
    expect(sortBackToFront(new Float32Array(8), new Float32Array(8), new Float32Array(8), -3, [0, 0, -1], idx, keys, makeAux(8))).toBe(0)
  })

  it('count 1 — the trivial frame: keys[0] = the dot, indices[0] = 0', () => {
    const px = new Float32Array([2]), py = new Float32Array([3]), pz = new Float32Array([7])
    const idx = new Int32Array(4), keys = new Float32Array(4)
    const n = sortBackToFront(px, py, pz, 1, [0.5, 0.5, -0.707], idx, keys, makeAux(4))
    expect(n).toBe(1)
    expect(idx[0]).toBe(0)
    expect(keys[0]).toBeCloseTo(0.5 * 2 + 0.5 * 3 - 0.707 * 7, 5)
  })

  it('the keys contract on the radix path: keys[slot] = dot(forward, p) (f32)', () => {
    const { px, py, pz } = scene(513, 77)
    const idx = new Int32Array(513), keys = new Float32Array(513)
    sortBackToFront(px, py, pz, 513, F, idx, keys, makeAux(513))
    for (let slot = 0; slot < 513; slot++) {
      expect(keys[slot]).toBeCloseTo(F[0] * px[slot] + F[1] * py[slot] + F[2] * pz[slot], 5)
    }
  })

  it('aux too small (any buffer) → the classic tier output, exact', () => {
    const { px, py, pz } = scene(100, 9)
    const a = new Int32Array(100), ka = new Float32Array(100)
    const rc = classicRef(px, py, pz, 100, F[0], F[1], F[2], a, ka)
    // each of the three buffers undersized in turn
    for (const bad of [
      { k: new Uint32Array(99), kAlt: new Uint32Array(100), iAlt: new Int32Array(100) },
      { k: new Uint32Array(100), kAlt: new Uint32Array(99), iAlt: new Int32Array(100) },
      { k: new Uint32Array(100), kAlt: new Uint32Array(100), iAlt: new Int32Array(99) },
    ]) {
      const b = new Int32Array(100), kb = new Float32Array(100)
      const rr = sortBackToFront(px, py, pz, 100, F, b, kb, bad)
      expect(rr).toBe(rc)
      expect(Array.from(b.subarray(0, 100))).toEqual(Array.from(a.subarray(0, 100)))
      expect(Array.from(kb.subarray(0, 100))).toEqual(Array.from(ka.subarray(0, 100)))
    }
  })

  it('THE PING-PONG — shared aux, alternating counts: no stale state', () => {
    // The facade reuses one aux across frames of differing live counts;
    // a pass that reads a stale tail would corrupt the scatter cursor.
    const scenes = [scene(200, 3), scene(7, 4), scene(200, 3), scene(3, 5), scene(200, 3)]
    const aux = makeAux(200)
    for (const s of scenes) {
      const n = s.px.length
      const a = new Int32Array(n), ka = new Float32Array(n)
      const b = new Int32Array(n), kb = new Float32Array(n)
      classicRef(s.px, s.py, s.pz, n, F[0], F[1], F[2], a, ka)
      sortBackToFront(s.px, s.py, s.pz, n, F, b, kb, aux)
      expect(Array.from(b.subarray(0, n))).toEqual(Array.from(a.subarray(0, n)))
    }
  })

  it('determinism — the same call twice, the same bytes', () => {
    const { px, py, pz } = scene(513, 991)
    const aux = makeAux(513)
    const a = new Int32Array(513), ka = new Float32Array(513)
    const b = new Int32Array(513), kb = new Float32Array(513)
    sortBackToFront(px, py, pz, 513, F, a, ka, aux)
    sortBackToFront(px, py, pz, 513, F, b, kb, aux)
    expect(Array.from(a.subarray(0, 513))).toEqual(Array.from(b.subarray(0, 513)))
    expect(Array.from(ka.subarray(0, 513))).toEqual(Array.from(kb.subarray(0, 513)))
  })
})
