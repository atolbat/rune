import { test, expect } from 'bun:test'
import { asciiDecode, align4, isWhitespace, parseDecimal, CHAR, clamp, nowMs } from '../src/bytes.ts'

test('parseDecimal: целые, дробные, экспоненты, знаки', () => {
  const bytes = (text: string) => new TextEncoder().encode(text)
  expect(parseDecimal(bytes('42'), 0, 2)).toBe(42)
  expect(parseDecimal(bytes('-7'), 0, 2)).toBe(-7)
  expect(parseDecimal(bytes('+9'), 0, 2)).toBe(9)
  expect(parseDecimal(bytes('3.5'), 0, 3)).toBe(3.5)
  expect(parseDecimal(bytes('.5'), 0, 2)).toBe(0.5)
  expect(parseDecimal(bytes('-0.25'), 0, 5)).toBe(-0.25)
  expect(parseDecimal(bytes('1e3'), 0, 3)).toBe(1000)
  expect(parseDecimal(bytes('1e-2'), 0, 4)).toBeCloseTo(0.01)
  expect(parseDecimal(bytes('2.5E2'), 0, 5)).toBe(250)
  expect(parseDecimal(bytes('-1.5e-1'), 0, 7)).toBeCloseTo(-0.15)
})

test('parseDecimal: стоп на мусоре и NaN без цифр', () => {
  const bytes = (text: string) => new TextEncoder().encode(text)
  expect(parseDecimal(bytes('v 1.5'), 0, 6)).toBeNaN() // 'v' — не цифра
  expect(parseDecimal(bytes(''), 0, 0)).toBeNaN()
  expect(parseDecimal(bytes('abc'), 0, 3)).toBeNaN()
  expect(parseDecimal(bytes('-'), 0, 1)).toBeNaN()
  // чтение среза внутри буфера: «1.5» со смещением
  const mixed = bytes('x 1.5 y')
  expect(parseDecimal(mixed, 2, 5)).toBe(1.5)
})

test('asciiDecode: корректность и чанковость', () => {
  const text = 'glTF'.repeat(3000) // 12000 байт > чанка 8192
  const bytes = new TextEncoder().encode(text)
  expect(asciiDecode(bytes, 0, bytes.length)).toBe(text)
  expect(asciiDecode(new TextEncoder().encode('Kaydara FBX Binary  '), 0, 20)).toBe('Kaydara FBX Binary  ')
})

test('isWhitespace: SPACE/TAB/CR/LF — да, прочее — нет', () => {
  expect(isWhitespace(CHAR.SPACE)).toBe(true)
  expect(isWhitespace(CHAR.TAB)).toBe(true)
  expect(isWhitespace(CHAR.CR)).toBe(true)
  expect(isWhitespace(CHAR.LF)).toBe(true)
  expect(isWhitespace(48)).toBe(false)
  expect(isWhitespace(0)).toBe(false)
})

test('align4: выравнивание вверх', () => {
  expect(align4(0)).toBe(0)
  expect(align4(4)).toBe(4)
  expect(align4(5)).toBe(8)
  expect(align4(7)).toBe(8)
  expect(align4(8)).toBe(8)
})

test('clamp и nowMs — здравый смысл', () => {
  expect(clamp(5, 0, 3)).toBe(3)
  expect(clamp(-5, 0, 3)).toBe(0)
  expect(clamp(2, 0, 3)).toBe(2)
  const before = nowMs()
  const after = nowMs()
  expect(after).toBeGreaterThanOrEqual(before)
})
