import { describe, expect, test } from 'bun:test'
import { fullscreenTriangle, fullscreenQuad } from '../src/fullscreen.ts'

describe('fullscreen', () => {
  test('triangle: 3 vertices, vertices beyond the clip planes', () => {
    const t = fullscreenTriangle()
    expect(t).toBeInstanceOf(Float32Array)
    expect(t.length).toBe(6)
    expect(Array.from(t)).toEqual([-1, -1, 3, -1, -1, 3])
    // The quad [-1,1]² is fully inside — coverage has a dedicated test below.
  })

  test('quad: 4 vertices triangle-strip — order as in the GPGPU demo', () => {
    const q = fullscreenQuad()
    expect(q).toBeInstanceOf(Float32Array)
    expect(q.length).toBe(8)
    expect(Array.from(q)).toEqual([-1, -1, -1, 1, 1, -1, 1, 1])
  })

  test('triangle covers the entire quad [-1,1]² (cross-product signs)', () => {
    // A rough rasterization check on a 33×33 grid: every point of the quad
    // is covered by the triangle (by cross-product signs).
    const t = fullscreenTriangle()
    const inside = (x: number, y: number): boolean => {
      const ax = t[2] - t[0], ay = t[3] - t[1]
      const bx = t[4] - t[2], by = t[5] - t[3]
      const cx = t[0] - t[4], cy = t[1] - t[5]
      const s1 = ax * (y - t[1]) - ay * (x - t[0])
      const s2 = bx * (y - t[3]) - by * (x - t[2])
      const s3 = cx * (y - t[5]) - cy * (x - t[4])
      const hasNeg = s1 < 0 || s2 < 0 || s3 < 0
      const hasPos = s1 > 0 || s2 > 0 || s3 > 0
      return !(hasNeg && hasPos)
    }
    for (let i = 0; i <= 32; i++) {
      for (let j = 0; j <= 32; j++) {
        const x = -1 + (2 * i) / 32
        const y = -1 + (2 * j) / 32
        expect(inside(x, y)).toBe(true)
      }
    }
  })
})
