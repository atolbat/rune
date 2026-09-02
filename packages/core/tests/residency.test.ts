import { describe, test, expect } from 'bun:test'
import { estimateTextureBytes, selectLRUEvictions, textureFormatBytesPerPixel } from '../src/journal/residency.ts'

const entry = (id: number, bytes: number, lastUse: number) => ({ id, bytes, lastUse })

describe('estimateTextureBytes — GPU memory estimation', () => {
  test('flat RGBA8: w*h*4', () => {
    expect(estimateTextureBytes(256, 256)).toBe(256 * 256 * 4)
    expect(estimateTextureBytes(512, 256, 1)).toBe(512 * 256 * 4)
  })

  test('mip-chain: ≤ base × 4/3, grows with the number of levels', () => {
    const base = 256 * 256 * 4
    const full = estimateTextureBytes(256, 256, 9)
    expect(full).toBeGreaterThan(base)
    expect(full).toBeLessThanOrEqual(Math.ceil(base * 4 / 3))
    // fewer levels — fewer bytes (monotonicity over levels)
    expect(estimateTextureBytes(256, 256, 2)).toBeLessThan(full)
    expect(estimateTextureBytes(256, 256, 1)).toBe(base)
  })

  test('mipLevels above the physical maximum — clamped', () => {
    // 256×256: the maximum is 9 levels; 99 levels must not yield more than ×4/3
    const base = 256 * 256 * 4
    expect(estimateTextureBytes(256, 256, 99)).toBe(estimateTextureBytes(256, 256, 9))
    expect(estimateTextureBytes(256, 256, 99)).toBeLessThanOrEqual(Math.ceil(base * 4 / 3))
  })
})

describe('Task 67 — HDR formats in GPU memory estimation', () => {
  test('textureFormatBytesPerPixel: 8-bit — 4, half-float — 8, float — 16', () => {
    expect(textureFormatBytesPerPixel()).toBe(4)
    expect(textureFormatBytesPerPixel('rgba8unorm')).toBe(4)
    expect(textureFormatBytesPerPixel('canvas')).toBe(4) // bgra8unorm
    expect(textureFormatBytesPerPixel('rgba16float')).toBe(8)
    expect(textureFormatBytesPerPixel('rgba32float')).toBe(16)
  })

  test('rgba16float: w*h*8 (2× of RGBA8)', () => {
    expect(estimateTextureBytes(100, 100, 1, 'rgba16float')).toBe(100 * 100 * 8)
    expect(estimateTextureBytes(100, 100, 1, 'rgba16float')).toBe(2 * estimateTextureBytes(100, 100))
  })

  test('rgba32f: w*h*16 (4× of RGBA8)', () => {
    expect(estimateTextureBytes(100, 100, 1, 'rgba32float')).toBe(100 * 100 * 16)
    expect(estimateTextureBytes(100, 100, 1, 'rgba32float')).toBe(4 * estimateTextureBytes(100, 100))
  })

  test('HDR mip-chain: base × 4/3 of the FORMAT, not of RGBA8', () => {
    const base16 = 100 * 100 * 8
    const mips = estimateTextureBytes(100, 100, 9, 'rgba16float')
    expect(mips).toBeGreaterThan(base16)
    expect(mips).toBeLessThanOrEqual(Math.ceil(base16 * 4 / 3))
    // the ratio to the RGBA8 chain — ×2 with ceil rounding accuracy (±1 byte):
    // ceil(2x) and 2·ceil(x) can differ by one.
    const rgba8Mips = estimateTextureBytes(100, 100, 9)
    expect(Math.abs(mips - 2 * rgba8Mips)).toBeLessThanOrEqual(1)
    // exact value: 100×100 → the level clamp = 7 (1+log2(100)).
    expect(mips).toBe(Math.ceil(100 * 100 * 8 * (1 - Math.pow(4, -7)) / 0.75))
  })
})

describe('selectLRUEvictions — a pure LRU policy', () => {
  test('within budget — nobody is touched', () => {
    const sel = selectLRUEvictions([entry(1, 100, 5), entry(2, 100, 3)], 200)
    expect(sel.evictIds).toEqual([])
    expect(sel.freedBytes).toBe(0)
    expect(sel.residentBytes).toBe(200)
  })

  test('exactly at budget — no eviction either (the budget is a ceiling)', () => {
    const sel = selectLRUEvictions([entry(1, 100, 5), entry(2, 100, 3)], 200)
    expect(sel.evictIds).toEqual([])
  })

  test('over budget — evicts LRU-first, with the minimum count', () => {
    // lastUse: id3=1 (the oldest), id1=2, id2=3 (the freshest)
    const sel = selectLRUEvictions([entry(1, 100, 2), entry(2, 100, 3), entry(3, 100, 1)], 200)
    // 300 > 200 → evict the minimum: LRU (id3) frees 100 → 200 ≤ 200
    expect(sel.evictIds).toEqual([3])
    expect(sel.freedBytes).toBe(100)
    expect(sel.residentBytes).toBe(200)
  })

  test('budget 0 — pushes out EVERYTHING unpinned in LRU order', () => {
    const sel = selectLRUEvictions([entry(1, 50, 9), entry(2, 30, 7), entry(3, 20, 8)], 0)
    expect(sel.evictIds).toEqual([2, 3, 1]) // by lastUse: 7, 8, 9
    expect(sel.freedBytes).toBe(100)
    expect(sel.residentBytes).toBe(0)
  })

  test('pinned is untouchable, even if it is the oldest', () => {
    // id1 — the scene (pinned), but was used least recently
    const sel = selectLRUEvictions(
      [entry(1, 100, 1), entry(2, 100, 5), entry(3, 100, 6)],
      150,
      new Set([1]),
    )
    // sum 300 > 150; pinned id1 stays; we push out the LRU of the unpinned:
    // id2 (lastUse=5) → 200 > 150 → id3 → 100 ≤ 150
    expect(sel.evictIds).toEqual([2, 3])
    expect(sel.residentBytes).toBe(100) // only the pinned id1
  })

  test('pinned does not fit the budget — evict what we can, the excess stays honestly', () => {
    const sel = selectLRUEvictions(
      [entry(1, 300, 1), entry(2, 100, 5)],
      100,
      new Set([1]),
    )
    // Only id2 can be evicted: 300 → still > 100. Plan: evict id2.
    expect(sel.evictIds).toEqual([2])
    expect(sel.residentBytes).toBe(300) // pinned exceeds the budget — honest
  })

  test('equal lastUse — determinism by id', () => {
    const sel = selectLRUEvictions([entry(7, 10, 5), entry(3, 10, 5), entry(5, 10, 5)], 10)
    expect(sel.evictIds).toEqual([3, 5]) // ids in ascending order
  })

  test('empty list / default empty budget (no pinned)', () => {
    expect(selectLRUEvictions([], 0).evictIds).toEqual([])
    expect(selectLRUEvictions([], 0).residentBytes).toBe(0)
  })

  test('bytes=0 (unknown size) — evicted by LRU, does not move the sum', () => {
    const sel = selectLRUEvictions([entry(1, 0, 1), entry(2, 100, 2)], 50)
    // 100 > 50 → evict: LRU id1 (0 bytes) does not help → id2
    expect(sel.evictIds).toEqual([1, 2])
    expect(sel.freedBytes).toBe(100)
    expect(sel.residentBytes).toBe(0)
  })
})
