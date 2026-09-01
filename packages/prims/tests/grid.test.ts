// Task 112: grid-прима (@rune/prims) — управляемое разрешение/структура.

import { describe, test, expect } from 'bun:test'
import { grid } from '../src/grid.ts'

describe('Task 112 — grid: размеры и вершины', () => {
  test('1×1 сегмент — квад: 4 вершины, 6 индексов', () => {
    const g = grid({ sizeX: 2, sizeZ: 2 })
    expect(g.vertexCount).toBe(4)
    expect(g.indexCount).toBe(6)
    expect(g.segmentsX).toBe(1)
    expect(g.segmentsZ).toBe(1)
  })

  test('разрешение управляется: 256×256 → 257² вершин (сетка океана)', () => {
    const g = grid({ sizeX: 2000, sizeZ: 2000, segmentsX: 256, segmentsZ: 256 })
    expect(g.vertexCount).toBe(257 * 257)
    expect(g.indexCount).toBe(256 * 256 * 6)
  })

  test('сегменты по осям независимы', () => {
    const g = grid({ sizeX: 10, sizeZ: 20, segmentsX: 2, segmentsZ: 4 })
    expect(g.vertexCount).toBe(3 * 5)
    expect(g.segmentsX).toBe(2)
    expect(g.segmentsZ).toBe(4)
  })

  test('origin центрирует сетку', () => {
    const g = grid({ sizeX: 2000, sizeZ: 2000, segmentsX: 2, segmentsZ: 2, origin: [-1000, -1000] })
    // Углы: от (-2000, -2000) до (0, 0)
    expect(g.positions[0]).toBeCloseTo(-2000, 6)
    expect(g.positions[1]).toBeCloseTo(-2000, 6)
    const last = g.vertexCount - 1
    expect(g.positions[last * 2]).toBeCloseTo(0, 6)
    expect(g.positions[last * 2 + 1]).toBeCloseTo(0, 6)
  })

  test('UV [0..1] по обеим осям', () => {
    const g = grid({ sizeX: 1, sizeZ: 1, segmentsX: 4, segmentsZ: 8 })
    expect(g.uvs[0]).toBe(0)
    expect(g.uvs[1]).toBe(0)
    const last = g.vertexCount - 1
    expect(g.uvs[last * 2]).toBeCloseTo(1, 6)
    expect(g.uvs[last * 2 + 1]).toBeCloseTo(1, 6)
  })

  test('ошибочные параметры — честные исключения', () => {
    expect(() => grid({ sizeX: 0, sizeZ: 1 })).toThrow()
    expect(() => grid({ sizeX: 1, sizeZ: 1, segmentsX: 0 })).toThrow()
    expect(() => grid({ sizeX: 1, sizeZ: 1, segmentsX: 1.5 })).toThrow()
  })
})

describe('Task 112 — grid: индексы и wireframe', () => {
  test('треугольники CCW сверху (как david.li/waves)', () => {
    const g = grid({ sizeX: 2, sizeZ: 2, segmentsX: 1, segmentsZ: 1 })
    // ячейка: topLeft=0, bottomLeft=2, bottomRight=3, topRight=1
    expect(Array.from(g.indices)).toEqual([0, 2, 3, 3, 1, 0])
  })

  test('edgeIndices — уникальные рёбра для каркасного режима', () => {
    const g = grid({ sizeX: 4, sizeZ: 4, segmentsX: 2, segmentsZ: 2 })
    // 9 вершин, 4 ячейки: горизонтальных 6, вертикальных 6, диагоналей 4
    // (диагональ — ОДНА на ячейку) → 16 уникальных рёбер.
    expect(g.edgeIndices.length).toBe(16 * 2)
    // Каждое ребро — пара валидных индексов
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

  test('1×1: рёбра квада — 4 внешних + 1 диагональ', () => {
    const g = grid({ sizeX: 1, sizeZ: 1 })
    expect(g.edgeIndices.length).toBe(5 * 2)
  })
})
