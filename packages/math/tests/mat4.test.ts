import { describe, expect, it } from 'bun:test'
import { mat4Create, mat4Multiply, mat4Perspective, mat4RotationX, mat4RotationY, mat4Translation } from '../src/index.ts'

const near = (a: Float32Array, b: readonly number[]) =>
  a.length === b.length && [...a].every((v, i) => Math.abs(v - b[i]) < 1e-6)

describe('mat4', () => {
  it('единичная матрица создаётся корректно', () => {
    expect(near(mat4Create(), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])).toBe(true)
  })

  it('умножение на единичную не меняет матрицу', () => {
    const a = mat4Translation(new Float32Array(16), 1, 2, 3)
    const id = mat4Create()
    const out = new Float32Array(16)
    mat4Multiply(out, id, a)
    expect(near(out, [...a])).toBe(true)
  })

  it('перспектива: diag = [f/aspect, f], z-строка стандартна', () => {
    const out = mat4Perspective(new Float32Array(16), Math.PI / 2, 2, 0.1, 100)
    const f = 1 / Math.tan(Math.PI / 4)
    expect(out[0]).toBeCloseTo(f / 2, 6)
    expect(out[5]).toBeCloseTo(f, 6)
    expect(out[11]).toBe(-1)
    expect(out[10]).toBeCloseTo((0.1 + 100) / (0.1 - 100), 6)
  })

  it('поворот Y на 90° переводит +X в -Z (column-major)', () => {
    const r = mat4RotationY(new Float32Array(16), Math.PI / 2)
    expect(r[0]).toBeCloseTo(0, 6)
    expect(r[2]).toBeCloseTo(-1, 6)
    expect(r[8]).toBeCloseTo(1, 6)
  })

  it('трансляция занимает 12–14 элементы', () => {
    const t = mat4Translation(new Float32Array(16), 5, 6, 7)
    expect(t[12]).toBe(5)
    expect(t[13]).toBe(6)
    expect(t[14]).toBe(7)
  })

  it('REGRESSION (баг «гиперкуба»): out === a даёт результат отдельного out', () => {
    const a = mat4RotationY(new Float32Array(16), 0.9) // станет и приёмником
    const b = mat4RotationX(new Float32Array(16), 0.5)
    const reference = new Float32Array(16)
    mat4Multiply(reference, a, b)

    mat4Multiply(a, a, b) // out === a: демо делало именно так

    expect([...a]).toEqual([...reference])
  })

  it('REGRESSION: out === b даёт результат отдельного out', () => {
    const a = mat4RotationY(new Float32Array(16), 0.9)
    const b = mat4RotationX(new Float32Array(16), 0.5) // станет и приёмником
    const reference = new Float32Array(16)
    mat4Multiply(reference, a, b)

    mat4Multiply(b, a, b) // out === b

    expect([...b]).toEqual([...reference])
  })
})
