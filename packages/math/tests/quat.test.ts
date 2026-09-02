/** Quaternion tests: product, axis-angle, YXZ Euler angles, slerp. */
import { describe, expect, it } from 'bun:test'
import {
  quatAxisAngle,
  quatFromEulerYXZ,
  quatIdentity,
  quatMultiply,
  quatNormalize,
  quatSlerp,
} from '../src/index.ts'

function approx(a: Float32Array, b: Float32Array, eps = 1e-6): void {
  for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(eps)
}

describe('quat', () => {
  it('identity · q = q', () => {
    const q = new Float32Array([0.1, 0.2, 0.3, 0.9])
    quatNormalize(q, q)
    const i = quatIdentity(new Float32Array(4))
    approx(quatMultiply(new Float32Array(4), i, q), q)
    approx(quatMultiply(new Float32Array(4), q, i), q)
  })

  it('i · j = k (basis quaternions)', () => {
    const i = new Float32Array([1, 0, 0, 0])
    const j = new Float32Array([0, 1, 0, 0])
    const k = quatMultiply(new Float32Array(4), i, j)
    approx(k, new Float32Array([0, 0, 1, 0]))
  })

  it('axis-angle 90° around Y is consistent with the double cover', () => {
    const q = quatAxisAngle(new Float32Array(4), 0, 1, 0, Math.PI / 2)
    expect(q[0]).toBeCloseTo(0, 6)
    expect(q[1]).toBeCloseTo(Math.SQRT1_2, 6)
    expect(q[2]).toBeCloseTo(0, 6)
    expect(q[3]).toBeCloseTo(Math.SQRT1_2, 6)
  })

  it('zero axis → identity without NaN', () => {
    const q = quatAxisAngle(new Float32Array(4), 0, 0, 0, 1.2)
    approx(q, quatIdentity(new Float32Array(4)))
  })

  it('normalizing a zero quaternion → identity', () => {
    const q = quatNormalize(new Float32Array(4), new Float32Array(4))
    approx(q, quatIdentity(new Float32Array(4)))
  })

  it('YXZ Euler angles: pure yaw equals the Y axis-angle', () => {
    const e = quatFromEulerYXZ(new Float32Array(4), 0.7, 0, 0)
    const a = quatAxisAngle(new Float32Array(4), 0, 1, 0, 0.7)
    approx(e, a)
  })

  it('YXZ Euler angles: pure pitch equals the X axis-angle', () => {
    const e = quatFromEulerYXZ(new Float32Array(4), 0, -1.3, 0)
    const a = quatAxisAngle(new Float32Array(4), 1, 0, 0, -1.3)
    approx(e, a)
  })

  it('slerp t=0 and t=1 — the endpoints; the midpoint — unit length', () => {
    const a = quatAxisAngle(new Float32Array(4), 0, 1, 0, 0)
    const b = quatAxisAngle(new Float32Array(4), 0, 1, 0, Math.PI)
    approx(quatSlerp(new Float32Array(4), a, b, 0), a)
    approx(quatSlerp(new Float32Array(4), a, b, 1), b)
    const mid = quatSlerp(new Float32Array(4), a, b, 0.5)
    expect(mid[1]).toBeCloseTo(Math.SQRT1_2, 6)
    expect(mid[3]).toBeCloseTo(Math.SQRT1_2, 6)
  })

  it('slerp picks the shortest arc (q ↔ −q)', () => {
    const a = quatAxisAngle(new Float32Array(4), 0, 1, 0, 0.3)
    const negB = new Float32Array([-a[0], -a[1], -a[2], -a[3]])
    // −a represents the same rotation: slerping to it at t=1 may yield ±a, but
    // the shortest arc should return almost a (not the long way around 2π).
    const r = quatSlerp(new Float32Array(4), a, negB, 1)
    const same = Math.abs(r[0] * a[0] + r[1] * a[1] + r[2] * a[2] + r[3] * a[3])
    expect(same).toBeCloseTo(1, 5)
  })
})
