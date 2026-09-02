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
