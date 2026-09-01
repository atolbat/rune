import { describe, expect, it } from 'bun:test'
import { chunkRect, countTiles, tileForBudget, tileBytes } from '../src/streaming/chunker.ts'

describe('чанкер', () => {
  it('построчная нарезка: крайний тайл обрезается', () => {
    const tiles = chunkRect(1024, 300, 256)
    expect(tiles).toHaveLength(2)
    expect(tiles[0]).toEqual({ x: 0, y: 0, width: 1024, height: 256 })
    expect(tiles[1].height).toBe(44)
  })

  it('countTiles сходится с chunkRect', () => {
    expect(countTiles(0, 2048, 256)).toBe(Math.ceil(2048 / 256))
    expect(countTiles(0, 2050, 256)).toBe(chunkRect(1024, 2050, 256).length)
  })

  it('tileForBudget: потолок 256, минимум 1', () => {
    expect(tileForBudget(1024, 1024 * 1024)).toBe(256) // 1 МБ / 4 КБ-ряд = потолок
    expect(tileForBudget(1024, 100 * 1024)).toBe(25)
    expect(tileForBudget(1024, 100)).toBe(1)
  })

  it('tileBytes: полный ряд — subarray без копии', () => {
    const source = new Uint8Array(1024 * 512 * 4)
    const tile = { x: 0, y: 256, width: 1024, height: 256 }
    const bytes = tileBytes(tile, source, 1024)
    expect(bytes.byteOffset).toBe(256 * 1024 * 4) // вид, не копия
  })

  it('tileBytes: горизонтальный срез — плотная копия', () => {
    const source = new Uint8Array(1024 * 64 * 4)
    const tile = { x: 512, y: 0, width: 512, height: 64 }
    const bytes = tileBytes(tile, source, 1024)
    expect(bytes.byteOffset).toBe(0)
    expect(bytes.length).toBe(512 * 64 * 4)
  })
})
