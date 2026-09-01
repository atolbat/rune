// Task 112: half-float кодек (@rune/core halfFloat.ts) и pingPong.
//
// Эталонные значения binary16 (IEEE 754-2008):
//  1.0=0x3C00, 0.5=0x3800, -2.0=0xC000, 2^-24 (денормал)=0x0001,
//  +inf=0x7C00, NaN=0x7E00 (тихий), 65504 (max)=0x7BFF.

import { describe, test, expect } from 'bun:test'
import {
  floatToHalfBits,
  halfBitsToFloat,
  float32ToHalf16,
  half16ToFloat32,
} from '../src/halfFloat.ts'
import { createPingPong } from '../src/pingPong.ts'

describe('Task 112 — halfFloat: эталонные биты', () => {
  test('канонические значения', () => {
    expect(floatToHalfBits(1.0)).toBe(0x3c00)
    expect(floatToHalfBits(0.5)).toBe(0x3800)
    expect(floatToHalfBits(-2.0)).toBe(0xc000)
    expect(floatToHalfBits(0.0)).toBe(0x0000)
    expect(floatToHalfBits(-0.0)).toBe(0x8000)
    expect(floatToHalfBits(65504)).toBe(0x7bff) // max half
    expect(floatToHalfBits(Infinity)).toBe(0x7c00)
    expect(floatToHalfBits(-Infinity)).toBe(0xfc00)
  })

  test('денормалы и переполнение', () => {
    expect(floatToHalfBits(2 ** -24)).toBe(0x0001) // наименьший денормал half
    expect(floatToHalfBits(2 ** -25)).toBe(0x0000) // ниже — ноль
    expect(floatToHalfBits(65520)).toBe(0x7c00) // чуть выше max → inf
    expect(Number.isNaN(halfBitsToFloat(0x7e00))).toBe(true)
  })

  test('round-trip: точные half-значения без потерь', () => {
    for (const v of [0, 1, -1, 0.5, 0.25, 2, 100.5, -4096, 65504, 2 ** -14]) {
      expect(halfBitsToFloat(floatToHalfBits(v))).toBe(v)
    }
  })

  test('массовые конвертеры сохраняют длину и порядок', () => {
    const f32 = new Float32Array([1, -2, 0.5, 0, 65504])
    const bits = float32ToHalf16(f32)
    expect(bits).toBeInstanceOf(Uint16Array)
    expect(bits.length).toBe(f32.length)
    const back = half16ToFloat32(bits)
    expect(Array.from(back)).toEqual(Array.from(f32))
  })

  test('NaN проходит как NaN (биты сохраняются)', () => {
    const nanBits = floatToHalfBits(NaN)
    expect(Number.isNaN(halfBitsToFloat(nanBits))).toBe(true)
  })
})

describe('Task 112 — pingPong: паттерн двойного буфера', () => {
  test('current/previous и swap', () => {
    const pp = createPingPong('A', 'B')
    expect(pp.current).toBe('A')
    expect(pp.previous).toBe('B')
    expect(pp.swap()).toBe('B')
    expect(pp.current).toBe('B')
    expect(pp.previous).toBe('A')
    expect(pp.swap()).toBe('A')
  })

  test('parity чередуется 0/1', () => {
    const pp = createPingPong(1, 2)
    expect(pp.parity).toBe(0)
    pp.swap()
    expect(pp.parity).toBe(1)
    pp.swap()
    expect(pp.parity).toBe(0)
  })

  test('работает с разнотипными парами (текстуры/буферы)', () => {
    const pp = createPingPong({ tex: 'ping' }, { tex: 'pong' })
    expect(pp.current.tex).toBe('ping')
    pp.swap()
    expect(pp.current.tex).toBe('pong')
    expect(pp.previous.tex).toBe('ping')
  })
})
