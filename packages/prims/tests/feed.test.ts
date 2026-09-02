/**
 * Primitive LOD feed (Task 109): dynamic resolution by distance.
 * Hysteresis on both sides of the threshold — an orbit with distance near
 * the threshold does not cause a rebuild sawtooth.
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

describe('prims — LOD feed', () => {
  test('start: level 0, geometry built, rebuilds = 1', () => {
    const feed = makeFeed()
    expect(feed.level).toBe(0)
    expect(feed.geometry.vertexCount).toBeGreaterThan(0)
    expect(feed.rebuilds).toBe(1)
  })

  test('level change: far threshold 3·(1+0.15)=3.45', () => {
    const feed = makeFeed()
    expect(feed.update(3.4)).toBe(false) // inside the hysteresis band — hold
    expect(feed.level).toBe(0)
    expect(feed.update(3.5)).toBe(true) // outside the band — level 1
    expect(feed.level).toBe(1)
    expect(feed.geometry.vertexCount).toBeGreaterThan(0)
    expect(feed.rebuilds).toBe(2)
  })

  test('chatter around the threshold: 3.3↔3.6 — NO rebuilds (hysteresis)', () => {
    const feed = makeFeed()
    feed.update(3.6) // level 1
    expect(feed.level).toBe(1)
    expect(feed.update(3.3)).toBe(false) // 3.3 > 3·0.85=2.55 — hold level 1
    expect(feed.update(3.6)).toBe(false)
    expect(feed.update(3.3)).toBe(false)
    expect(feed.rebuilds).toBe(2)
  })

  test('return: level 2 → 1 when dist < 6·0.85, → 0 when dist < 3·0.85', () => {
    const feed = makeFeed()
    feed.update(7) // level 2
    expect(feed.level).toBe(2)
    expect(feed.update(5.5)).toBe(false) // 5.5 > 5.1 — hold
    expect(feed.update(5.0)).toBe(true) // level 1
    expect(feed.update(2.4)).toBe(true) // 2.4 < 2.55 — level 0
    expect(feed.level).toBe(0)
    expect(feed.rebuilds).toBe(4)
  })

  test('level changes the geometry RESOLUTION (different vertices)', () => {
    const feed = makeFeed()
    const v0 = feed.geometry.vertexCount
    feed.update(10)
    const v2 = feed.geometry.vertexCount
    expect(v2).toBeLessThan(v0)
  })

  test('configuration: there must be levels−1 thresholds', () => {
    expect(() => makeFeed([2, 1], [3, 6])).toThrow()
    expect(() => makeFeed([], [])).toThrow()
  })

  test('single level: update always false', () => {
    const feed = makeFeed([1], [], 0.15)
    expect(feed.update(100)).toBe(false)
    expect(feed.rebuilds).toBe(1)
  })
})
