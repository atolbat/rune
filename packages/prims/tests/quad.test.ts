// Invariants of the fullscreen quad: extent, CCW winding (cull 'back'),
// UVs in image coordinates (v=0 is the top). Lesson of the "quarter
// face" incident: primitive geometry must have an extent and orientation test.

import { describe, expect, test } from 'bun:test'
import { quad } from '../src/quad.ts'

describe('quad()', () => {
  test('6 vertices, covers the entire [-1,1]²', () => {
    const g = quad()
    expect(g.vertexCount).toBe(6)
    expect(g.positions.length).toBe(12)
    expect(g.uvs.length).toBe(12)
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (let i = 0; i < g.vertexCount; i++) {
      const x = g.positions[i * 2]
      const y = g.positions[i * 2 + 1]
      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
      minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    }
    // Full extent: not a "quarter" and not a unit square
    expect(minX).toBe(-1)
    expect(maxX).toBe(1)
    expect(minY).toBe(-1)
    expect(maxY).toBe(1)
  })

  test('all four clip-space corners are present', () => {
    const g = quad()
    const corners = new Set<string>()
    for (let i = 0; i < g.vertexCount; i++) {
      corners.add(`${g.positions[i * 2]},${g.positions[i * 2 + 1]}`)
    }
    expect(corners.has('-1,-1')).toBe(true)
    expect(corners.has('1,-1')).toBe(true)
    expect(corners.has('1,1')).toBe(true)
    expect(corners.has('-1,1')).toBe(true)
    expect(corners.size).toBe(4)
  })

  test('CCW winding: the cross product of every triangle is positive', () => {
    const g = quad()
    for (let t = 0; t + 2 < g.vertexCount; t += 3) {
      const ax = g.positions[(t + 1) * 2] - g.positions[t * 2]
      const ay = g.positions[(t + 1) * 2 + 1] - g.positions[t * 2 + 1]
      const bx = g.positions[(t + 2) * 2] - g.positions[t * 2]
      const by = g.positions[(t + 2) * 2 + 1] - g.positions[t * 2 + 1]
      expect(ax * by - ay * bx).toBeGreaterThan(0)
    }
  })

  test('UVs in [0,1]² and consistent with positions: (x+1)/2, (1-y)/2', () => {
    const g = quad()
    for (let i = 0; i < g.vertexCount; i++) {
      const x = g.positions[i * 2]
      const y = g.positions[i * 2 + 1]
      const u = g.uvs[i * 2]
      const v = g.uvs[i * 2 + 1]
      expect(u).toBeCloseTo((x + 1) / 2)
      expect(v).toBeCloseTo((1 - y) / 2)
      expect(u).toBeGreaterThanOrEqual(0)
      expect(u).toBeLessThanOrEqual(1)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })

  test('v=0 is the top corners (image space): y=+1 → v=0, y=-1 → v=1', () => {
    const g = quad()
    for (let i = 0; i < g.vertexCount; i++) {
      const y = g.positions[i * 2 + 1]
      const v = g.uvs[i * 2 + 1]
      if (y === 1) expect(v).toBe(0)
      if (y === -1) expect(v).toBe(1)
    }
  })

  test('triangles cover the quad without holes: the centers of the four quadrants are inside the triangulation', () => {
    const g = quad()
    const tris: Array<[number, number][]> = []
    for (let t = 0; t + 2 < g.vertexCount; t += 3) {
      tris.push([
        [g.positions[t * 2], g.positions[t * 2 + 1]],
        [g.positions[(t + 1) * 2], g.positions[(t + 1) * 2 + 1]],
        [g.positions[(t + 2) * 2], g.positions[(t + 2) * 2 + 1]],
      ])
    }
    for (const [px, py] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] as const) {
      const covered = tris.some(([a, b, c]) =>
        pointInTriangle(px, py, a, b, c))
      expect(covered).toBe(true)
    }
  })
})

function sign(px: number, py: number, a: readonly [number, number], b: readonly [number, number]): number {
  return (px - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (py - b[1])
}

function pointInTriangle(
  px: number, py: number,
  a: readonly [number, number], b: readonly [number, number], c: readonly [number, number],
): boolean {
  const d1 = sign(px, py, a, b)
  const d2 = sign(px, py, b, c)
  const d3 = sign(px, py, c, a)
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}
