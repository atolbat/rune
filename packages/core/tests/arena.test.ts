import { describe, expect, it } from 'bun:test'
import { createUniformArena } from '../src/uniforms/arena.ts'

describe('uniform arena (value-compare, C theory)', () => {
  it('writing values marks the slot dirty', () => {
    const arena = createUniformArena(1024)
    const slot = arena.alloc(16)
    arena.write(slot, identity())
    expect(slot.dirty).toBe(true)
    expect(arena.dirtySlots()).toContain(slot)
  })

  it('repeating the same write does not dirty (fround comparison)', () => {
    const arena = createUniformArena(1024)
    const slot = arena.alloc(4)
    arena.write(slot, [1, 2, 3, 4])
    arena.clearDirty()
    expect(arena.write(slot, [1, 2, 3, 4])).toBe(false)
    expect(slot.dirty).toBe(false)
  })

  it('f64→f32 collision is caught: 0.8+0.1 changes f32 bytes', () => {
    const arena = createUniformArena(1024)
    const slot = arena.alloc(1)
    arena.write(slot, [0.9000000000000001]) // f32 == 0.9
    arena.clearDirty()
    // the same f32 representation — not dirty
    expect(arena.write(slot, [0.9])).toBe(false)
    // a different f32 representation — dirty
    expect(arena.write(slot, [0.9000001])).toBe(true)
  })

  it('allocations are sequential and do not overlap', () => {
    const arena = createUniformArena(1024)
    const a = arena.alloc(16)
    const b = arena.alloc(4)
    expect(b.base).toBe(a.base + 16)
    arena.write(a, identity())
    arena.write(b, [9, 9, 9, 9])
    expect(arena.buffer[b.base + 3]).toBe(9)
    expect(arena.buffer[a.base]).toBe(1) // not overwritten
  })

  it('arena overflow — a clear error', () => {
    const arena = createUniformArena(16)
    expect(() => arena.alloc(32)).toThrow('overflowed')
  })
})

function identity(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
}

describe('Task 114: importBytes marks the intersecting rank range', () => {
  it('only the slots overlapping the byte range turn dirty (leading, mid, trailing, gaps)', () => {
    // 8 slots x 16 floats each: ranges [0..16), [16..32), ... [112..128).
    const arena = createUniformArena(256)
    const slots = []
    for (let at = 0; at < 8; at++) slots.push(arena.alloc(16))
    arena.clearDirty()

    // A range strictly inside slot 3 (floats 48..64) — one slot dirty.
    arena.importBytes(48 * 4 + 4, new Uint8Array(8))
    expect(slots.map(s => s.dirty)).toEqual([
      false, false, false, true, false, false, false, false,
    ])
    arena.clearDirty()

    // A range spanning the END of slot 0, all of slot 1, and the START of
    // slot 2 (floats 12..36) — three slots dirty.
    arena.importBytes(12 * 4, new Uint8Array(24 * 4))
    expect(slots.map(s => s.dirty)).toEqual([
      true, true, true, false, false, false, false, false,
    ])
    arena.clearDirty()

    // A range at the very START of slot 6 (floats 96..100; slot 5 ends
    // exclusively at 96) — exactly one slot dirty, neighbors clean.
    arena.importBytes(96 * 4, new Uint8Array(16))
    expect(slots.map(s => s.dirty)).toEqual([
      false, false, false, false, false, false, true, false,
    ])
    arena.clearDirty()

    // A range BEYOND the last slot (floats 128..130, free tail of the arena).
    arena.importBytes(128 * 4, new Uint8Array(8))
    expect(slots.every(s => !s.dirty)).toBe(true)
    // Clean re-import of the same bytes is not needed — dirt is monotone.
  })

  it('a single-slot arena: a range covering the only slot marks it', () => {
    const arena = createUniformArena(16)
    const slot = arena.alloc(16)
    arena.clearDirty()
    arena.importBytes(0, new Uint8Array(64))
    expect(slot.dirty).toBe(true)
  })
})
