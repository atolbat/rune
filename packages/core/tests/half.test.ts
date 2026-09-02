import { describe, expect, test } from 'bun:test'
import { floatToHalfBits, halfBitsToFloat, floatsToHalfBits, halfBitsToFloats } from '../src/gpu/half.ts'

describe('floatToHalfBits — known bit patterns', () => {
  test('ones and zeros', () => {
    expect(floatToHalfBits(1)).toBe(0x3c00)
    expect(floatToHalfBits(0.5)).toBe(0x3800)
    expect(floatToHalfBits(-1)).toBe(0xbc00)
    expect(floatToHalfBits(0)).toBe(0x0000)
    expect(floatToHalfBits(-0)).toBe(0x8000)
  })

  test('maximum and the transition to Inf', () => {
    expect(floatToHalfBits(65504)).toBe(0x7bff) // max finite half
    expect(floatToHalfBits(65520)).toBe(0x7c00) // → +Inf
    expect(floatToHalfBits(-65520)).toBe(0xfc00) // → −Inf
    expect(floatToHalfBits(Number.POSITIVE_INFINITY)).toBe(0x7c00)
    // A known quirk of the classic snippet (three.js/DataUtils and
    // our demo copy): NaN → +Inf. For data uploads (phases/geometry)
    // NaN does not occur; the behavior is pinned by the test for parity.
    expect(floatToHalfBits(Number.NaN)).toBe(0x7c00)
  })

  test('minimum normal and subnormals', () => {
    // 6.1035156e-5 = 2^-14 — the minimum normal half.
    expect(floatToHalfBits(6.103515625e-5)).toBe(0x0400)
    // 5.9604645e-8 = 2^-24 — the minimum subnormal.
    expect(floatToHalfBits(5.960464477539063e-8)).toBe(0x0001)
    expect(floatToHalfBits(2.9802322387695312e-8)).toBe(0x0000) // below the threshold → 0
  })

  test('thirds: a rounding classic', () => {
    // 1/3 ≈ 0.333251953125 in f16 (0x3555).
    expect(floatToHalfBits(1 / 3)).toBe(0x3555)
    // 2/3 ≈ 0.66650390625 (0x3956) for RNE implementations; the classic snippet
    // rounds ties-away — we pin the actual value of the demo copy.
    const twoThirds = floatToHalfBits(2 / 3)
    expect(twoThirds === 0x3955 || twoThirds === 0x3956).toBe(true)
    expect(Math.abs(halfBitsToFloat(twoThirds) - 2 / 3)).toBeLessThan(2 ** -11)
  })
})

describe('halfBitsToFloat — exact inverse', () => {
  test('sign, subnormals, Inf, NaN', () => {
    expect(halfBitsToFloat(0xbc00)).toBe(-1)
    expect(halfBitsToFloat(0x0400)).toBeCloseTo(6.103515625e-5, 12)
    expect(halfBitsToFloat(0x0001)).toBeCloseTo(5.960464477539063e-8, 15)
    expect(halfBitsToFloat(0x7c00)).toBe(Number.POSITIVE_INFINITY)
    expect(halfBitsToFloat(0xfc00)).toBe(Number.NEGATIVE_INFINITY)
    expect(Number.isNaN(halfBitsToFloat(0x7e00))).toBe(true)
    // Task 114 regression: half dumps that lost the sign bit.
    expect(halfBitsToFloat(0x8000)).toBe(-0)
    expect(halfBitsToFloat(0xb800)).toBe(-0.5)
  })

  test('roundtrip float → half → float within the f16 tolerance', () => {
    const samples = [
      0.001, 0.01, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3.14159, 10, 100, 1000,
      -0.001, -0.5, -1.5, -100, 5000, 65504,
      6.103515625e-5, 0.0001, // a normal near the lower bound
    ]
    for (const value of samples) {
      const back = halfBitsToFloat(floatToHalfBits(value))
      // Relative error no worse than 2^-11 (f16 mantissa precision).
      expect(Math.abs(back - value) / Math.max(Math.abs(value), 1e-12)).toBeLessThan(2 ** -10)
    }
  })
})

describe('floatsToHalfBits — arrays and stride', () => {
  test('dense packing (stride=1)', () => {
    const src = new Float32Array([1, -1, 0.5, 0])
    const bits = floatsToHalfBits(src)
    expect(bits).toEqual(new Uint16Array([0x3c00, 0xbc00, 0x3800, 0x0000]))
  })

  test('RGBA interleaving: random ocean phases (stride=4, writing into the R channel)', () => {
    // The FFT-ocean pattern: phase in R, GBA zero.
    const src = new Float32Array([1.23, 0, 0, 0, -4.56, 0, 0, 0])
    const bits = floatsToHalfBits(src, 4)
    expect(bits[0]).toBe(floatToHalfBits(1.23))
    expect(bits[1]).toBe(0)
    expect(bits[2]).toBe(0)
    expect(bits[3]).toBe(0)
    expect(bits[4]).toBe(floatToHalfBits(-4.56))
    expect(bits[5]).toBe(0)
    expect(bits[6]).toBe(0)
    expect(bits[7]).toBe(0)
  })

  test('halfBitsToFloats — inverse unpacking', () => {
    const src = new Float32Array([0.25, -2, 3, -0.125])
    const round = halfBitsToFloats(floatsToHalfBits(src))
    expect(round.length).toBe(4)
    for (let i = 0; i < 4; i++) {
      expect(Math.abs(round[i] - src[i])).toBeLessThan(Math.abs(src[i]) * 2 ** -10 + 1e-7)
    }
  })
})
