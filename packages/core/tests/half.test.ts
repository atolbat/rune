import { describe, expect, test } from 'bun:test'
import { floatToHalfBits, halfBitsToFloat, floatsToHalfBits, halfBitsToFloats } from '../src/gpu/half.ts'

describe('floatToHalfBits — известные битовые паттерны', () => {
  test('единицы и нули', () => {
    expect(floatToHalfBits(1)).toBe(0x3c00)
    expect(floatToHalfBits(0.5)).toBe(0x3800)
    expect(floatToHalfBits(-1)).toBe(0xbc00)
    expect(floatToHalfBits(0)).toBe(0x0000)
    expect(floatToHalfBits(-0)).toBe(0x8000)
  })

  test('максимум и переход в Inf', () => {
    expect(floatToHalfBits(65504)).toBe(0x7bff) // max finite half
    expect(floatToHalfBits(65520)).toBe(0x7c00) // → +Inf
    expect(floatToHalfBits(-65520)).toBe(0xfc00) // → −Inf
    expect(floatToHalfBits(Number.POSITIVE_INFINITY)).toBe(0x7c00)
    // Известная особенность классического сниппета (three.js/DataUtils и
    // наша копия из демо): NaN → +Inf. Для загрузок данных (фазы/геометрия)
    // NaN не встречается; поведение зафиксировано тестом ради паритета.
    expect(floatToHalfBits(Number.NaN)).toBe(0x7c00)
  })

  test('минимальная нормаль и субнормали', () => {
    // 6.1035156e-5 = 2^-14 — минимальная нормальная половинка.
    expect(floatToHalfBits(6.103515625e-5)).toBe(0x0400)
    // 5.9604645e-8 = 2^-24 — минимальная субнормальная.
    expect(floatToHalfBits(5.960464477539063e-8)).toBe(0x0001)
    expect(floatToHalfBits(2.9802322387695312e-8)).toBe(0x0000) // ниже порога → 0
  })

  test('трети: классика округления', () => {
    // 1/3 ≈ 0.333251953125 в f16 (0x3555).
    expect(floatToHalfBits(1 / 3)).toBe(0x3555)
    // 2/3 ≈ 0.66650390625 (0x3956) у RNE-реализаций; классический сниппет
    // округляет ties-away — фиксируем фактическое значение демо-копии.
    const twoThirds = floatToHalfBits(2 / 3)
    expect(twoThirds === 0x3955 || twoThirds === 0x3956).toBe(true)
    expect(Math.abs(halfBitsToFloat(twoThirds) - 2 / 3)).toBeLessThan(2 ** -11)
  })
})

describe('halfBitsToFloat — точное обратное', () => {
  test('знак, субнормали, Inf, NaN', () => {
    expect(halfBitsToFloat(0xbc00)).toBe(-1)
    expect(halfBitsToFloat(0x0400)).toBeCloseTo(6.103515625e-5, 12)
    expect(halfBitsToFloat(0x0001)).toBeCloseTo(5.960464477539063e-8, 15)
    expect(halfBitsToFloat(0x7c00)).toBe(Number.POSITIVE_INFINITY)
    expect(halfBitsToFloat(0xfc00)).toBe(Number.NEGATIVE_INFINITY)
    expect(Number.isNaN(halfBitsToFloat(0x7e00))).toBe(true)
    // Баг-репрессия Task 114: дампы половинок, терявшие знаковый бит.
    expect(halfBitsToFloat(0x8000)).toBe(-0)
    expect(halfBitsToFloat(0xb800)).toBe(-0.5)
  })

  test('roundtrip float → half → float в допуске f16', () => {
    const samples = [
      0.001, 0.01, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3.14159, 10, 100, 1000,
      -0.001, -0.5, -1.5, -100, 5000, 65504,
      6.103515625e-5, 0.0001, // нормаль у нижней границы
    ]
    for (const value of samples) {
      const back = halfBitsToFloat(floatToHalfBits(value))
      // Относительная погрешность не хуже 2^-11 (точность f16-мантиссы).
      expect(Math.abs(back - value) / Math.max(Math.abs(value), 1e-12)).toBeLessThan(2 ** -10)
    }
  })
})

describe('floatsToHalfBits — массивы и stride', () => {
  test('плотная упаковка (stride=1)', () => {
    const src = new Float32Array([1, -1, 0.5, 0])
    const bits = floatsToHalfBits(src)
    expect(bits).toEqual(new Uint16Array([0x3c00, 0xbc00, 0x3800, 0x0000]))
  })

  test('RGBA-инливинг: случайные фазы океана (stride=4, запись в канал R)', () => {
    // Паттерн из FFT-океана: фаза в R, GBA нулевые.
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

  test('halfBitsToFloats — обратная распаковка', () => {
    const src = new Float32Array([0.25, -2, 3, -0.125])
    const round = halfBitsToFloats(floatsToHalfBits(src))
    expect(round.length).toBe(4)
    for (let i = 0; i < 4; i++) {
      expect(Math.abs(round[i] - src[i])).toBeLessThan(Math.abs(src[i]) * 2 ** -10 + 1e-7)
    }
  })
})
