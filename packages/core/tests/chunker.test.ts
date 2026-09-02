import { describe, expect, it } from 'bun:test'
import { chunkRect, countTiles, tileForBudget, tileBytes } from '../src/streaming/chunker.ts'

describe('chunker', () => {
  it('row-wise slicing: the edge tile is clipped', () => {
    const tiles = chunkRect(1024, 300, 256)
    expect(tiles).toHaveLength(2)
    expect(tiles[0]).toEqual({ x: 0, y: 0, width: 1024, height: 256 })
    expect(tiles[1].height).toBe(44)
  })

  it('countTiles agrees with chunkRect', () => {
    expect(countTiles(0, 2048, 256)).toBe(Math.ceil(2048 / 256))
    expect(countTiles(0, 2050, 256)).toBe(chunkRect(1024, 2050, 256).length)
  })

  it('countTiles: zero height — zero tiles', () => {
    expect(countTiles(1024, 0, 256)).toBe(0)
    expect(countTiles(1024, 0, 256)).toBe(chunkRect(1024, 0, 256).length)
  })

  it('tileH < 1 — an explicit error, not an infinite loop', () => {
    // Regression: chunkRect with tileH=0 would spin in for (y += 0) forever;
    // countTiles checked chunkRect.length (function arity = 3) — nonsense.
    expect(() => chunkRect(1024, 512, 0)).toThrow('tileH >= 1')
    expect(() => countTiles(1024, 512, 0)).toThrow('tileH >= 1')
  })

  it('tileForBudget: ceiling 256, minimum 1', () => {
    expect(tileForBudget(1024, 1024 * 1024)).toBe(256) // 1 MB / 4 KB row = ceiling
    expect(tileForBudget(1024, 100 * 1024)).toBe(25)
    expect(tileForBudget(1024, 100)).toBe(1)
  })

  it('tileBytes: full row — subarray without copying', () => {
    const source = new Uint8Array(1024 * 512 * 4)
    const tile = { x: 0, y: 256, width: 1024, height: 256 }
    const bytes = tileBytes(tile, source, 1024)
    expect(bytes.byteOffset).toBe(256 * 1024 * 4) // a view, not a copy
  })

  it('tileBytes: horizontal slice — a dense copy', () => {
    const source = new Uint8Array(1024 * 64 * 4)
    const tile = { x: 512, y: 0, width: 512, height: 64 }
    const bytes = tileBytes(tile, source, 1024)
    expect(bytes.byteOffset).toBe(0)
    expect(bytes.length).toBe(512 * 64 * 4)
  })
})
