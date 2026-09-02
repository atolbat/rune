// Task 112: grid primitive (@rune/prims) — controllable resolution/structure.

import { describe, test, expect } from 'bun:test'
import { grid } from '../src/grid.ts'

describe('Task 112 — grid: sizes and vertices', () => {
  test('1×1 segment — quad: 4 vertices, 6 indices', () => {
    const g = grid({ sizeX: 2, sizeZ: 2 })
    expect(g.vertexCount).toBe(4)
    expect(g.indexCount).toBe(6)
    expect(g.segmentsX).toBe(1)
    expect(g.segmentsZ).toBe(1)
  })

  test('resolution is controllable: 256×256 → 257² vertices (ocean grid)', () => {
    const g = grid({ sizeX: 2000, sizeZ: 2000, segmentsX: 256, segmentsZ: 256 })
    expect(g.vertexCount).toBe(257 * 257)
    expect(g.indexCount).toBe(256 * 256 * 6)
  })

  test('segments are independent per axis', () => {
    const g = grid({ sizeX: 10, sizeZ: 20, segmentsX: 2, segmentsZ: 4 })
    expect(g.vertexCount).toBe(3 * 5)
    expect(g.segmentsX).toBe(2)
    expect(g.segmentsZ).toBe(4)
  })

  test('origin centers the grid', () => {
    const g = grid({ sizeX: 2000, sizeZ: 2000, segmentsX: 2, segmentsZ: 2, origin: [-1000, -1000] })
    // Corners: from (-2000, -2000) to (0, 0)
    expect(g.positions[0]).toBeCloseTo(-2000, 6)
    expect(g.positions[1]).toBeCloseTo(-2000, 6)
    const last = g.vertexCount - 1
    expect(g.positions[last * 2]).toBeCloseTo(0, 6)
    expect(g.positions[last * 2 + 1]).toBeCloseTo(0, 6)
  })

  test('UV [0..1] along both axes', () => {
    const g = grid({ sizeX: 1, sizeZ: 1, segmentsX: 4, segmentsZ: 8 })
    expect(g.uvs[0]).toBe(0)
    expect(g.uvs[1]).toBe(0)
    const last = g.vertexCount - 1
    expect(g.uvs[last * 2]).toBeCloseTo(1, 6)
    expect(g.uvs[last * 2 + 1]).toBeCloseTo(1, 6)
  })

  test('invalid parameters — honest exceptions', () => {
    expect(() => grid({ sizeX: 0, sizeZ: 1 })).toThrow()
    expect(() => grid({ sizeX: 1, sizeZ: 1, segmentsX: 0 })).toThrow()
    expect(() => grid({ sizeX: 1, sizeZ: 1, segmentsX: 1.5 })).toThrow()
  })
})

describe('Task 112 — grid: indices and wireframe', () => {
  test('CCW triangles when viewed from above (like david.li/waves)', () => {
    const g = grid({ sizeX: 2, sizeZ: 2, segmentsX: 1, segmentsZ: 1 })
    // cell: topLeft=0, bottomLeft=2, bottomRight=3, topRight=1
    expect(Array.from(g.indices)).toEqual([0, 2, 3, 3, 1, 0])
  })

  test('edgeIndices — unique edges for wireframe mode', () => {
    const g = grid({ sizeX: 4, sizeZ: 4, segmentsX: 2, segmentsZ: 2 })
    // 9 vertices, 4 cells: 6 horizontal, 6 vertical, 4 diagonal edges
    // (ONE diagonal per cell) → 16 unique edges.
    expect(g.edgeIndices.length).toBe(16 * 2)
    // Each edge — a pair of valid indices
    for (let i = 0; i < g.edgeIndices.length; i += 2) {
      const a = g.edgeIndices[i]!
      const b = g.edgeIndices[i + 1]!
      expect(a).toBeGreaterThanOrEqual(0)
      expect(a).toBeLessThan(g.vertexCount)
      expect(b).toBeGreaterThanOrEqual(0)
      expect(b).toBeLessThan(g.vertexCount)
      expect(a).not.toBe(b)
    }
  })

  test('1×1: quad edges — 4 outer + 1 diagonal', () => {
    const g = grid({ sizeX: 1, sizeZ: 1 })
    expect(g.edgeIndices.length).toBe(5 * 2)
  })
})
