import { describe, expect, it } from 'bun:test'
import { createUniformArena, createUniformSet, createTransientPool, signal } from '../src/index.ts'

// Task 144 — the third general pass's regression pins: the uniform-set write
// plan, the arena dirty-list, and the transient pool's two-level bins.

describe('task 144: uniformSet write plan', () => {
  it('write before attach calls NOTHING (the empty-offsets walk preserved)', () => {
    const set = createUniformSet('pre', { a: 'float', b: 'vec4' })
    const seen: number[] = []
    set.write((offset, value) => { seen.push(offset, value) })
    expect(seen).toEqual([])
    // link + write still silent
    set.link({ a: signal(1) })
    set.write((offset, value) => { seen.push(offset, value) })
    expect(seen).toEqual([])
  })

  it('the write sequence is the schema order: scalars + arrays, linked values live', () => {
    const set = createUniformSet('cam', { t: 'float', m: 'mat4' })
    let cursor = 0
    const allocs: string[] = []
    set.attach(type => {
      const size = type === 'mat4' ? 64 : type === 'vec4' ? 16 : 4
      const offset = cursor
      cursor += size
      allocs.push(type)
      return { offset, size }
    })
    expect(allocs).toEqual(['float', 'mat4']) // Object.entries order
    const matrix = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]
    const time = signal(0.5)
    set.link({ t: time, m: signal(matrix) })
    const seen: number[] = []
    set.write((offset, value) => { seen.push(offset, value) })
    // t at 0 (scalar), m at 4 (16 writes, stride 4)
    expect(seen.length).toBe(2 + 32)
    expect(seen[0]).toBe(0)
    expect(seen[1]).toBe(0.5)
    expect(seen[2]).toBe(4)
    expect(seen[3]).toBe(1)
    expect(seen[4]).toBe(8)
    expect(seen[5]).toBe(2)
    // the linked signal is read live on every write
    time.value = 0.75
    const seen2: number[] = []
    set.write((offset, value) => { seen2.push(offset, value) })
    expect(seen2[1]).toBe(0.75)
  })

  it('attach is idempotent: the second attach does not re-allocate', () => {
    const set = createUniformSet('once', { x: 'float' })
    let calls = 0
    const alloc = () => { calls++; return { offset: 0, size: 4 } }
    set.attach(alloc)
    set.attach(alloc)
    expect(calls).toBe(1)
    expect(set.offsets.x).toBe(0)
  })

  it('link merges: a later link overrides an earlier one for the same field', () => {
    const set = createUniformSet('merge', { x: 'float' })
    set.attach(() => ({ offset: 0, size: 4 }))
    set.link({ x: signal(1) })
    set.link({ x: signal(2) })
    const seen: number[] = []
    set.write((offset, value) => { seen.push(offset, value) })
    expect(seen).toEqual([0, 2])
  })
})

describe('task 144: arena dirty list', () => {
  it('a fresh slot is born dirty; clearDirty cleans it', () => {
    const arena = createUniformArena(64)
    const slot = arena.alloc(4)
    expect(slot.dirty).toBe(true)
    arena.clearDirty()
    expect(slot.dirty).toBe(false)
    expect(arena.dirtySlots().length).toBe(0)
    expect(arena.dirtyRanges().length).toBe(0)
  })

  it('clearDirty walks only the marked slots (many slots, one write)', () => {
    const arena = createUniformArena(1 << 12)
    const slots = Array.from({ length: 500 }, () => arena.alloc(4))
    arena.clearDirty()
    const target = slots[317]
    arena.writeFloat(target.base * 4, 42)
    expect(arena.dirtySlots().length).toBe(1)
    expect(arena.dirtySlots()[0]).toBe(target)
    arena.clearDirty()
    expect(arena.dirtySlots().length).toBe(0)
    // every other slot stays clean
    expect(slots.filter(s => s.dirty).length).toBe(0)
  })

  it('an unchanged value write does NOT re-mark after clear (the fround compare)', () => {
    const arena = createUniformArena(64)
    const slot = arena.alloc(4)
    arena.writeFloat(slot.base * 4, 7)
    arena.clearDirty()
    arena.writeFloat(slot.base * 4, 7) // same f32 bits
    expect(slot.dirty).toBe(false)
    arena.writeFloat(slot.base * 4, 8)
    expect(slot.dirty).toBe(true)
  })

  it('importBytes marks the intersecting slots; clearDirty clears them', () => {
    const arena = createUniformArena(256)
    const a = arena.alloc(4) // 4 FLOATS — bytes 0..16
    const b = arena.alloc(4) // bytes 16..32
    const c = arena.alloc(4) // bytes 32..48
    arena.clearDirty()
    // deliver bytes spanning a+b (byte range 0..32 → floats 0..8)
    arena.importBytes(a.base * 4, new Uint8Array(32).fill(1))
    expect(a.dirty).toBe(true)
    expect(b.dirty).toBe(true)
    expect(c.dirty).toBe(false)
    expect(arena.dirtyRanges().length).toBe(1) // a+b adjacent → merged
    arena.clearDirty()
    expect(arena.dirtyRanges().length).toBe(0)
  })

  it('the executor pattern (external slot.dirty = false, then a fresh write) still re-marks', () => {
    const arena = createUniformArena(64)
    const slot = arena.alloc(4)
    arena.clearDirty()
    arena.writeFloat(slot.base * 4, 1)
    expect(slot.dirty).toBe(true)
    slot.dirty = false // the executor's per-field upload clear
    arena.clearDirty() // the list member re-clears as a no-op
    expect(slot.dirty).toBe(false)
    arena.writeFloat(slot.base * 4, 2)
    expect(slot.dirty).toBe(true)
    expect(arena.dirtySlots()[0]).toBe(slot)
  })

  it('writeVec4 marks the owner once for multiple changed lanes', () => {
    const arena = createUniformArena(64)
    const slot = arena.alloc(4)
    arena.clearDirty()
    arena.writeVec4(slot, 1, 2, 3, 4)
    expect(slot.dirty).toBe(true)
    expect(arena.dirtySlots().length).toBe(1)
    // one lane change is enough
    arena.clearDirty()
    arena.writeVec4(slot, 1, 2, 3, 5)
    expect(slot.dirty).toBe(true)
    // no lane change is not
    arena.clearDirty()
    arena.writeVec4(slot, 1, 2, 3, 5)
    expect(slot.dirty).toBe(false)
  })
})

describe('task 144: transient pool two-level bins', () => {
  it('same tag+length reuses after the depth; different tag same length NEVER shares', () => {
    const pool = createTransientPool(2)
    const first = pool.f32(16)
    first[0] = 1
    pool.beginFrame()
    pool.beginFrame()
    const second = pool.f32(16)
    expect(second).toBe(first) // aged out at depth 2 → same buffer
    // a u8[16] is a DIFFERENT bin despite the same length
    const bytes = pool.u8(16)
    expect(bytes.constructor).toBe(Uint8Array)
    expect(bytes).not.toBe(first)
    pool.beginFrame()
    pool.beginFrame()
    const bytes2 = pool.u8(16)
    expect(bytes2).toBe(bytes)
    expect(bytes2).not.toBe(second)
    const i32 = pool.i32(16)
    expect(i32.constructor).toBe(Int32Array)
    expect(pool.f32(16)).not.toBe(bytes)
  })

  it('stats count the same totals the flat-key bins produced', () => {
    const pool = createTransientPool(3)
    for (let frame = 0; frame < 5; frame++) {
      pool.beginFrame()
      pool.f32(16)
      pool.f32(16) // same bin, second lease
      pool.u8(64)
      pool.f64(8)
      pool.u32(4)
      pool.i32(4)
    }
    const s = pool.stats()
    expect(s.frames).toBe(5)
    // depth 3: frames 3 and 4 age out the frames-0/1 leases and REUSE them
    // → only 3 frames' worth of buffers ever exist (the pooling contract)
    expect(s.created).toBe(6 * 3)
    expect(s.leased).toBe(6 * 3)
    expect(s.pooled).toBe(0) // nothing has aged beyond the last alloc's reclaim
    expect(s.bytes).toBe((64 * 2 + 64 + 64 + 16 + 16) * 3)
  })

  it('the depth contract: buffers live exactly depth frames before reuse', () => {
    const pool = createTransientPool(2)
    const a = pool.f32(8)
    pool.beginFrame()
    const b = pool.f32(8)
    expect(b).not.toBe(a) // a is still within its lifetime
    pool.beginFrame()
    const c = pool.f32(8)
    expect(c).not.toBe(b)
    expect(c === a || c === pool.f32(8)).toBe(true) // a aged out — c may be a
    pool.beginFrame()
    const d = pool.f32(8)
    expect(d).not.toBe(c)
  })
})
