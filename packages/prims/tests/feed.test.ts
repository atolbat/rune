/**
 * LOD-фид примитива (Task 109): динамическое разрешение по дистанции.
 * Гистерезис по обе стороны порога — орбита с дистанцией около порога
 * не устраивает пилу пересборок.
 */

import { describe, test, expect } from 'bun:test'
import { createPrimitiveFeed } from '../src/index.ts'
import { sphere } from '../src/index.ts'

function makeFeed(levels: readonly number[] = [2, 1, 0.5], thresholds: readonly number[] = [3, 6], hysteresis = 0.15) {
  return createPrimitiveFeed({
    make: k => sphere({ widthSegments: Math.max(3, Math.round(16 * k)), heightSegments: Math.max(2, Math.round(10 * k)) }),
    levels,
    thresholds,
    hysteresis,
  })
}

describe('prims — LOD-фид', () => {
  test('старт: уровень 0, геометрия построена, rebuilds = 1', () => {
    const feed = makeFeed()
    expect(feed.level).toBe(0)
    expect(feed.geometry.vertexCount).toBeGreaterThan(0)
    expect(feed.rebuilds).toBe(1)
  })

  test('смена уровня: дальний порог 3·(1+0.15)=3.45', () => {
    const feed = makeFeed()
    expect(feed.update(3.4)).toBe(false) // в полосе гистерезиса — держим
    expect(feed.level).toBe(0)
    expect(feed.update(3.5)).toBe(true) // за полосой — уровень 1
    expect(feed.level).toBe(1)
    expect(feed.geometry.vertexCount).toBeGreaterThan(0)
    expect(feed.rebuilds).toBe(2)
  })

  test('дребезг вокруг порога: 3.3↔3.6 — пересборок НЕТ (гистерезис)', () => {
    const feed = makeFeed()
    feed.update(3.6) // уровень 1
    expect(feed.level).toBe(1)
    expect(feed.update(3.3)).toBe(false) // 3.3 > 3·0.85=2.55 — держим уровень 1
    expect(feed.update(3.6)).toBe(false)
    expect(feed.update(3.3)).toBe(false)
    expect(feed.rebuilds).toBe(2)
  })

  test('возврат: уровень 2 → 1 при dist < 6·0.85, → 0 при dist < 3·0.85', () => {
    const feed = makeFeed()
    feed.update(7) // уровень 2
    expect(feed.level).toBe(2)
    expect(feed.update(5.5)).toBe(false) // 5.5 > 5.1 — держим
    expect(feed.update(5.0)).toBe(true) // уровень 1
    expect(feed.update(2.4)).toBe(true) // 2.4 < 2.55 — уровень 0
    expect(feed.level).toBe(0)
    expect(feed.rebuilds).toBe(4)
  })

  test('уровень меняет РАЗРЕШЕНИЕ геометрии (вершины разные)', () => {
    const feed = makeFeed()
    const v0 = feed.geometry.vertexCount
    feed.update(10)
    const v2 = feed.geometry.vertexCount
    expect(v2).toBeLessThan(v0)
  })

  test('конфигурация: порогов должно быть levels−1', () => {
    expect(() => makeFeed([2, 1], [3, 6])).toThrow()
    expect(() => makeFeed([], [])).toThrow()
  })

  test('один уровень: update всегда false', () => {
    const feed = makeFeed([1], [], 0.15)
    expect(feed.update(100)).toBe(false)
    expect(feed.rebuilds).toBe(1)
  })
})
