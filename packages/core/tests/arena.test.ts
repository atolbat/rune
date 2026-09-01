import { describe, expect, it } from 'bun:test'
import { createUniformArena } from '../src/uniforms/arena.ts'

describe('uniform-арена (value-compare, теория C)', () => {
  it('запись значений помечает слот грязным', () => {
    const arena = createUniformArena(1024)
    const slot = arena.alloc(16)
    arena.write(slot, identity())
    expect(slot.dirty).toBe(true)
    expect(arena.dirtySlots()).toContain(slot)
  })

  it('повтор той же записи не грязнит (fround-сравнение)', () => {
    const arena = createUniformArena(1024)
    const slot = arena.alloc(4)
    arena.write(slot, [1, 2, 3, 4])
    arena.clearDirty()
    expect(arena.write(slot, [1, 2, 3, 4])).toBe(false)
    expect(slot.dirty).toBe(false)
  })

  it('f64→f32 коллизия ловится: 0.8+0.1 меняет байты f32', () => {
    const arena = createUniformArena(1024)
    const slot = arena.alloc(1)
    arena.write(slot, [0.9000000000000001]) // f32 == 0.9
    arena.clearDirty()
    // то же f32-представление — не грязно
    expect(arena.write(slot, [0.9])).toBe(false)
    // другое f32-представление — грязно
    expect(arena.write(slot, [0.9000001])).toBe(true)
  })

  it('выделения последовательны и не пересекаются', () => {
    const arena = createUniformArena(1024)
    const a = arena.alloc(16)
    const b = arena.alloc(4)
    expect(b.base).toBe(a.base + 16)
    arena.write(a, identity())
    arena.write(b, [9, 9, 9, 9])
    expect(arena.buffer[b.base + 3]).toBe(9)
    expect(arena.buffer[a.base]).toBe(1) // не затёрто
  })

  it('переполнение арены — ясная ошибка', () => {
    const arena = createUniformArena(16)
    expect(() => arena.alloc(32)).toThrow('переполнена')
  })
})

function identity(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
}
