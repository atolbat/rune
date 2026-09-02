import { describe, expect, it } from 'bun:test'
import { createSliceArena, createPipelineCache, structuralKey } from '../src/index.ts'

describe('slice arena', () => {
  it('allocates slices with 256 alignment', () => {
    const arena = createSliceArena(4096)
    const first = arena.allocSlice(48)
    const second = arena.allocSlice(48)
    expect(first.base).toBe(0)
    expect(second.base).toBe(256)
    expect(arena.usedBytes).toBe(304) // 256 + 48: the pointer without padding
  })

  it('slots inside a slice are offset from the base', () => {
    const arena = createSliceArena(4096)
    const slice = arena.allocSlice(256)
    const slot = arena.slotAt(slice, 16, 16)
    expect(slot.offset).toBe(16)
    const slotInSecond = arena.slotAt(arena.allocSlice(256), 16, 16)
    expect(slotInSecond.offset).toBe(272)
  })

  it('a write makes the range dirty; repeating the same write does not', () => {
    const arena = createSliceArena(4096)
    const slice = arena.allocSlice(256)
    const slot = arena.slotAt(slice, 0, 16)
    arena.writeVec4(slot, 1, 2, 3, 4)
    expect(arena.dirtyRanges().length).toBe(1)
    arena.clearDirty()
    arena.writeVec4(slot, 1, 2, 3, 4)
    expect(arena.dirtyRanges().length).toBe(0)
  })

  it('adjacent slices are merged into one upload range', () => {
    const arena = createSliceArena(8192)
    const a = arena.slotAt(arena.allocSlice(256), 0, 16)
    const b = arena.slotAt(arena.allocSlice(256), 0, 16)
    arena.writeVec4(a, 1, 1, 1, 1)
    arena.writeVec4(b, 2, 2, 2, 2)
    const ranges = arena.dirtyRanges()
    expect(ranges.length).toBe(1)          // a 240 gap ≤ granularity → merged
    expect(ranges[0].from).toBe(0)
    expect(ranges[0].to).toBe(272)         // the upload covers only the written bytes
  })

  it('throws on overflow', () => {
    const arena = createSliceArena(256)
    arena.allocSlice(256)
    expect(() => arena.allocSlice(256)).toThrow()
  })
})

describe('pipeline cache', () => {
  it('identical descriptors → one id; different → different', () => {
    const cache = createPipelineCache()
    const base = { depth: { test: 'less' as const, write: true } }
    const first = cache.idOf(base, 1)
    const same = cache.idOf({ depth: { test: 'less', write: true } }, 1)
    const other = cache.idOf({ depth: false }, 1)
    const otherShader = cache.idOf(base, 2)
    expect(first).toBe(same)
    expect(first).not.toBe(other)
    expect(first).not.toBe(otherShader)
    expect(cache.size).toBe(3)
  })

  it('the structural key is stable and distinguishes all fields', () => {
    const a = structuralKey({ depth: { test: 'less' }, blend: false }, 7)
    const b = structuralKey({ depth: { test: 'less' }, blend: false }, 7)
    const c = structuralKey({ depth: { test: 'less' }, blend: { src: 'one' as const, dst: 'zero' as const } }, 7)
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})
