// Task 141 — the painter's order (@rune/core sort.ts): the back-to-front
// depth sort over SoA arrays — @rune/particles' Task 132 body, extracted
// for every depth-less alpha-blended renderer (sprites, instanced quads,
// transparent batches).
//
// Pinned here:
//   1. THE ORDER — descending dot(forward, position): the FARTHEST first
//      (the painter's algorithm; a camera at the origin looking down −Z,
//      the particles IN FRONT of it at negative z).
//   2. THE TOTAL ORDER — depth ties break by the slot index (the higher
//      slot first): deterministic, engine-independent, the same bytes on
//      every engine (the parity contract).
//   3. THE CONTRACT — zero allocations (the caller's scratch), count ≤ 0
//      returns 0, the SoA arrays are read [0, count) only.

import { describe, expect, it } from 'bun:test'
import { sortBackToFront } from '../src/sort.ts'

describe('Task 141 — sortBackToFront (the painter\'s order)', () => {
  // A camera at the origin looking down −Z; five particles spread in front
  // of it (depths |z| = 9, 5, 7, 1, 3 — slot order).
  const px = new Float32Array([0, 1, 2, 3, 4])
  const py = new Float32Array([0, 0, 0, 0, 0])
  const pz = new Float32Array([-9, -5, -7, -1, -3])
  const indices = new Int32Array(16)
  const keys = new Float32Array(16)

  it('the FAR particle first (a camera looking down −Z)', () => {
    // forward = (0, 0, −1): key = −z = the view-axis depth. Back to front =
    // the key DESCENDING: depth 9 (slot 0) first, depth 1 (slot 3) last.
    const n = sortBackToFront(px, py, pz, 5, [0, 0, -1], indices, keys)
    expect(n).toBe(5)
    expect(Array.from(indices.subarray(0, 5))).toEqual([0, 2, 1, 4, 3])
  })

  it('an orbiting camera — the axis is whatever forward says', () => {
    // forward = (0.6, 0, −0.8): key = 0.6·x + 0.8·|z|
    // i=0: 7.2  i=1: 4.6  i=2: 6.8  i=3: 2.6  i=4: 4.8 — no ties.
    const n = sortBackToFront(px, py, pz, 5, [0.6, 0, -0.8], indices, keys)
    expect(n).toBe(5)
    expect(Array.from(indices.subarray(0, 5))).toEqual([0, 2, 4, 1, 3])
  })

  it('count 0 (and negative) — nothing to sort, zero returned', () => {
    expect(sortBackToFront(px, py, pz, 0, [0, 0, -1], indices, keys)).toBe(0)
    expect(sortBackToFront(px, py, pz, -3, [0, 0, -1], indices, keys)).toBe(0)
  })

  it('depth ties break by the slot index — the TOTAL order', () => {
    // slots 1 and 3 at the SAME depth (key −2): the HIGHER slot first; the
    // slot-0 key (0) leads; the slot-2 key (−9) trails.
    const tx = new Float32Array([0, 0, 0, 0, 0])
    const ty = new Float32Array([0, 5, 0, 5, 0])
    const tz = new Float32Array([0, 2, 9, 2, 0])
    const n = sortBackToFront(tx, ty, tz, 4, [0, 0, -1], indices, keys)
    expect(n).toBe(4)
    expect(Array.from(indices.subarray(0, 4))).toEqual([0, 3, 1, 2])
  })

  it('deterministic — the same inputs, the same bytes, every run', () => {
    const a = new Int32Array(16)
    const b = new Int32Array(16)
    const ka = new Float32Array(16)
    const kb = new Float32Array(16)
    for (let run = 0; run < 3; run++) {
      sortBackToFront(px, py, pz, 5, [0.3, -0.5, -0.8], a, ka)
      if (run > 0) {
        expect(Array.from(a.subarray(0, 5))).toEqual(Array.from(b.subarray(0, 5)))
        expect(Array.from(ka.subarray(0, 5))).toEqual(Array.from(kb.subarray(0, 5)))
      }
      b.set(a); kb.set(ka)
    }
  })

  it('the keys land in the caller\'s scratch (zero allocations)', () => {
    const n = sortBackToFront(px, py, pz, 5, [0, 0, -1], indices, keys)
    expect(n).toBe(5)
    // key[slot] = dot(forward, p) — the raw view-axis depth (slot 0 is the
    // farthest at 9; slot 3 the nearest at 1).
    expect(keys[indices[0]]).toBeCloseTo(9, 5)
    expect(keys[indices[4]]).toBeCloseTo(1, 5)
  })
})
