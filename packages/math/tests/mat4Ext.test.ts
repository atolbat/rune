/**
 * Тесты расширений mat4 (Task 81 / @rune/scene-подготовка):
 * аффинное произведение, орто, lookAt, обращения, TRS-композиция.
 * Эталон — gl-matrix-совместимые значения, вычисленные независимо
 * (произведение матриц через честную развёртку и геометрические инварианты).
 */
import { describe, expect, it } from 'bun:test'
import {
  mat4Identity,
  mat4Invert,
  mat4InvertAffine,
  mat4LookAt,
  mat4Multiply,
  mat4MultiplyAffine,
  mat4Ortho,
  mat4Perspective,
  mat4RotationY,
  mat4Translation,
  mat4FromQuatPosScale,
} from '../src/index.ts'
import { quatAxisAngle } from '../src/index.ts'

/** Честное произведение через локальную копию (медленный эталон). */
function refMultiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16)
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k]
      out[col * 4 + row] = sum
    }
  }
  return out
}

function approx(a: Float32Array, b: Float32Array, eps = 1e-5): void {
  for (let i = 0; i < a.length; i++) {
    expect(Math.abs(a[i] - b[i])).toBeLessThan(eps)
  }
}

describe('mat4MultiplyAffine', () => {
  it('совпадает с общим произведением на TRS-матрицах', () => {
    const a = new Float32Array(16)
    const b = new Float32Array(16)
    const q = new Float32Array(4)
    quatAxisAngle(q, 0.3, 0.7, -0.2, 1.1)
    mat4FromQuatPosScale(a, q[0], q[1], q[2], q[3], 1, -2, 3, 2, 0.5, 1.5)
    mat4FromQuatPosScale(b, 0.2, 0.1, 0.9, 0.3, -4, 5, 0.5, 1, 1, 0.25)
    const fast = new Float32Array(16)
    mat4MultiplyAffine(fast, a, b)
    approx(fast, refMultiply(a, b))
  })

  it('алиасинг out === a безопасен', () => {
    const a = new Float32Array(16)
    const q = new Float32Array(4)
    quatAxisAngle(q, 1, 0, 0, 0.7)
    mat4FromQuatPosScale(a, q[0], q[1], q[2], q[3], 3, 4, 5, 1, 2, 3)
    const copy = new Float32Array(a)
    mat4MultiplyAffine(a, a, copy) // out === a
    approx(a, refMultiply(copy, copy))
  })

  it('единичные матрицы: identity · identity = identity', () => {
    const i = mat4Identity(new Float32Array(16))
    const out = new Float32Array(16)
    mat4MultiplyAffine(out, i, i)
    approx(out, i)
  })
})

describe('mat4Ortho', () => {
  it('углы AABB маппятся в клип-углы ±1', () => {
    const p = mat4Ortho(new Float32Array(16), -2, 6, -1, 3, 0.5, 10)
    // Точка (left, bottom, -near) → (-1, -1, -1); (right, top, -far) → (1, 1, 1).
    const corners: Array<[number, number, number, number, number, number]> = [
      [-2, -1, -0.5, -1, -1, -1],
      [6, 3, -10, 1, 1, 1],
      [2, 1, -5.25, 0, 0, 0], // геометрический центр объёма
    ]
    for (const [x, y, z, ex, ey, ez] of corners) {
      const cx = p[0] * x + p[4] * y + p[8] * z + p[12]
      const cy = p[1] * x + p[5] * y + p[9] * z + p[13]
      const cz = p[2] * x + p[6] * y + p[10] * z + p[14]
      expect(Math.abs(cx - ex)).toBeLessThan(1e-6)
      expect(Math.abs(cy - ey)).toBeLessThan(1e-6)
      expect(Math.abs(cz - ez)).toBeLessThan(1e-6)
    }
  })
})

describe('mat4LookAt', () => {
  it('камера на +Z смотрит на начало координат: view = translate(0,0,-5)', () => {
    const v = mat4LookAt(new Float32Array(16), 0, 0, 5, 0, 0, 0, 0, 1, 0)
    expect(v[12]).toBeCloseTo(0, 5)
    expect(v[13]).toBeCloseTo(0, 5)
    expect(v[14]).toBeCloseTo(-5, 5)
    approx(v, mat4Translation(new Float32Array(16), 0, 0, -5))
  })

  it('точка центра видна по −Z вида: view·center = (0, 0, −dist)', () => {
    const eye = [3, 4, 5]
    const center = [1, 0.5, -2]
    const v = mat4LookAt(new Float32Array(16), eye[0], eye[1], eye[2], center[0], center[1], center[2], 0, 1, 0)
    const cx = v[0] * center[0] + v[4] * center[1] + v[8] * center[2] + v[12]
    const cy = v[1] * center[0] + v[5] * center[1] + v[9] * center[2] + v[13]
    const cz = v[2] * center[0] + v[6] * center[1] + v[10] * center[2] + v[14]
    const dist = Math.sqrt((eye[0] - center[0]) ** 2 + (eye[1] - center[1]) ** 2 + (eye[2] - center[2]) ** 2)
    expect(Math.abs(cx)).toBeLessThan(1e-6)
    expect(Math.abs(cy)).toBeLessThan(1e-6)
    expect(Math.abs(cz + dist)).toBeLessThan(1e-5)
  })

  it('вырожденный up (коллинеарен взгляду) не даёт NaN', () => {
    const v = mat4LookAt(new Float32Array(16), 0, 5, 0, 0, 0, 0, 0, 1, 0)
    for (let i = 0; i < 16; i++) expect(Number.isNaN(v[i])).toBe(false)
  })
})

describe('mat4InvertAffine / mat4Invert', () => {
  it('аффинное обращение: M · M⁻¹ = I', () => {
    const m = new Float32Array(16)
    const q = new Float32Array(4)
    quatAxisAngle(q, 0.5, 0.5, 0.7, 2.1)
    mat4FromQuatPosScale(m, q[0], q[1], q[2], q[3], 7, -3, 2, 2, 3, 0.5)
    const inv = mat4InvertAffine(new Float32Array(16), m)
    const prod = mat4MultiplyAffine(new Float32Array(16), m, inv)
    approx(prod, mat4Identity(new Float32Array(16)), 1e-4)
  })

  it('общее обращение: M · M⁻¹ = I (в т.ч. неаффинная перспективная)', () => {
    const p = mat4Perspective(new Float32Array(16), Math.PI / 3, 16 / 9, 0.1, 100)
    const inv = mat4Invert(new Float32Array(16), p)
    const prod = mat4Multiply(new Float32Array(16), p, inv)
    approx(prod, mat4Identity(new Float32Array(16)), 1e-4)
  })

  it('общее обращение аффинной совпадает с быстрым аффинным', () => {
    const m = new Float32Array(16)
    const q = new Float32Array(4)
    quatAxisAngle(q, 0.1, -0.4, 0.9, 0.33)
    mat4FromQuatPosScale(m, q[0], q[1], q[2], q[3], -1, 2, 0.5, 1.5, 2.5, 0.75)
    approx(
      mat4Invert(new Float32Array(16), m),
      mat4InvertAffine(new Float32Array(16), m),
      1e-5,
    )
  })

  it('вырожденная матрица → identity (не NaN, не throw)', () => {
    const bad = new Float32Array(16) // нулевая
    approx(mat4Invert(new Float32Array(16), bad), mat4Identity(new Float32Array(16)))
  })
})

describe('mat4FromQuatPosScale', () => {
  it('единичный кватернион + единичный масштаб = чистая трансляция', () => {
    const m = mat4FromQuatPosScale(new Float32Array(16), 0, 0, 0, 1, 5, -2, 8, 1, 1, 1)
    approx(m, mat4Translation(new Float32Array(16), 5, -2, 8))
  })

  it('вращение Y на 90° совпадает с mat4RotationY', () => {
    const q = new Float32Array(4)
    quatAxisAngle(q, 0, 1, 0, Math.PI / 2)
    const m = mat4FromQuatPosScale(new Float32Array(16), q[0], q[1], q[2], q[3], 0, 0, 0, 1, 1, 1)
    approx(m, mat4RotationY(new Float32Array(16), Math.PI / 2))
  })

  it('порядок TRS: сначала масштаб, потом вращение, потом трансляция', () => {
    // scale(2) → rotY(90°): точка (1,0,0) → (2,0,0) → (0,0,-2); +t=(1,0,0) → (1,0,-2).
    const m = mat4FromQuatPosScale(new Float32Array(16), 0, Math.SQRT1_2, 0, Math.SQRT1_2, 1, 0, 0, 2, 1, 1)
    const x = m[0] * 1 + m[4] * 0 + m[8] * 0 + m[12]
    const z = m[2] * 1 + m[6] * 0 + m[10] * 0 + m[14]
    expect(x).toBeCloseTo(1, 5)
    expect(z).toBeCloseTo(-2, 5)
  })
})
