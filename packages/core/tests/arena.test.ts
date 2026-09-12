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

describe('Task 179 — THE NaN GUARD (a stable NaN lane stops re-dirtying)', () => {
  it('write: a NaN lane writes once, then stays stable — number→NaN and NaN→number still change', () => {
    const arena = createUniformArena(1024)
    const slot = arena.alloc(4)
    // number → NaN: a change (the NaN reaches the GPU exactly once)
    expect(arena.write(slot, [1, 2, 3, 4])).toBe(true)
    arena.clearDirty()
    expect(arena.write(slot, [NaN, 2, 3, 4])).toBe(true)
    expect(arena.buffer[slot.base]).toBeNaN()
    arena.clearDirty() // the transition's own dirtying is LEGITIMATE — drain it
    // NaN → NaN: STABLE (the pre-179 compare re-dirtied every frame — the
    // silent per-frame re-upload leak)
    expect(arena.write(slot, [NaN, 2, 3, 4])).toBe(false)
    expect(slot.dirty).toBe(false)
    // NaN → number: a change again
    expect(arena.write(slot, [0.5, 2, 3, 4])).toBe(true)
    expect(arena.buffer[slot.base]).toBe(0.5)
  })

  it('write: a NaN SCALAR writes once, then stays stable', () => {
    const arena = createUniformArena(1024)
    const slot = arena.alloc(1)
    expect(arena.write(slot, 3)).toBe(true)
    arena.clearDirty()
    expect(arena.write(slot, NaN)).toBe(true)
    arena.clearDirty() // the transition dirtied — drain before the stability probe
    expect(arena.write(slot, NaN)).toBe(false)
    expect(slot.dirty).toBe(false)
    expect(arena.write(slot, 4)).toBe(true)
  })

  it('writeFloat: a stable NaN no longer re-dirties the owning slot', () => {
    const arena = createUniformArena(1024)
    const slot = arena.alloc(4)
    arena.write(slot, [0, 0, 0, 0])
    arena.clearDirty()
    const bytes = { offset: slot.base * 4, size: 4 }
    arena.writeFloat(bytes, NaN)
    expect(slot.dirty).toBe(true)
    arena.clearDirty()
    arena.writeFloat(bytes, NaN) // the same NaN — stable
    expect(slot.dirty).toBe(false)
    arena.writeFloat(bytes, 1)
    expect(slot.dirty).toBe(true)
  })

  it('writeVec4: a NaN LANE (not the whole vec) stays stable while the healthy lanes keep comparing', () => {
    const arena = createUniformArena(1024)
    const slot = arena.alloc(4)
    arena.writeVec4(slot, 1, 2, 3, 4)
    arena.clearDirty()
    arena.writeVec4(slot, NaN, 2, 3, 4) // lane 0 flips to NaN
    expect(slot.dirty).toBe(true)
    arena.clearDirty()
    arena.writeVec4(slot, NaN, 2, 3, 4) // all-NaN lane stable, rest equal
    expect(slot.dirty).toBe(false)
    arena.writeVec4(slot, NaN, 2, 3, 5) // lane 3 changed — dirty
    expect(slot.dirty).toBe(true)
    expect(arena.buffer[slot.base]).toBeNaN()
    expect(arena.buffer[slot.base + 3]).toBe(5)
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

// Task 146 — dirtyRanges took the O(dirty) list walk (the Task-144 clearDirty
// sibling) with two guarded fallbacks (dense lists, disordered marks) onto the
// exact pre-Task-146 full-slot walk. The pins below hold ALL THREE paths to
// one answer: the same scenario replayed through each path must return the
// same merged ranges, the stale members (external clears) must be excluded,
// and the returned array must stay the reused object.
describe('uniform arena dirtyRanges (Task 146: the O(dirty) list walk)', () => {
  /** Reference: the V0 semantics (walk every slot, merge ascending). */
  function referenceRanges(arena: ReturnType<typeof createUniformArena>, slots: Array<{ base: number; size: number; dirty: boolean }>): Array<{ from: number; to: number }> {
    const merged: Array<{ from: number; to: number }> = []
    for (const slot of slots) {
      if (!slot.dirty) continue
      const from = slot.base * 4
      const to = (slot.base + slot.size) * 4
      const last = merged[merged.length - 1]
      if (last !== undefined && from <= last.to) {
        if (to > last.to) last.to = to
      } else merged.push({ from, to })
    }
    return merged.map(r => ({ ...r }))
  }

  it('the sparse-list path, the dense fallback, and the disorder fallback agree', () => {
    // 10 slots; mark 3 (ascending) — the SPARSE path.
    const arena = createUniformArena(256)
    const slots: Array<{ base: number; size: number; dirty: boolean }> = []
    for (let i = 0; i < 10; i++) slots.push(arena.alloc(4) as unknown as { base: number; size: number; dirty: boolean })
    arena.clearDirty()
    arena.write(slots[1] as never, [5, 0, 0, 0])
    arena.write(slots[2] as never, [6, 0, 0, 0])
    arena.write(slots[7] as never, [7, 0, 0, 0])
    const sparse = arena.dirtyRanges().map(r => ({ ...r }))
    expect(sparse).toEqual(referenceRanges(arena, slots))
    // (1,2) merge into one range; 7 stands alone — 2 ranges total.
    expect(sparse.length).toBe(2)
    expect(sparse[0].from).toBe(slots[1].base * 4)
    expect(sparse[0].to).toBe((slots[2].base + slots[2].size) * 4)

    // The DISORDER path: clear, re-mark the same slots OUT of alloc order —
    // the walk fallback must give the same ranges.
    arena.clearDirty()
    // NOTE: fresh values — the value-compare semantics do not re-mark a
    // slot whose bytes already hold the written value.
    arena.write(slots[7] as never, [80, 0, 0, 0])
    arena.write(slots[1] as never, [50, 0, 0, 0])
    arena.write(slots[2] as never, [60, 0, 0, 0])
    const disordered = arena.dirtyRanges().map(r => ({ ...r }))
    expect(disordered).toEqual(sparse)

    // The DENSE path: mark every slot (list ≥ 90% of slots) — the full-slot
    // walk must give the one merged range covering everything.
    arena.clearDirty()
    for (const slot of slots) arena.write(slot as never, [9, 0, 0, 0])
    const dense = arena.dirtyRanges().map(r => ({ ...r }))
    expect(dense).toEqual(referenceRanges(arena, slots))
    expect(dense.length).toBe(1)
    expect(dense[0].from).toBe(slots[0].base * 4)
    expect(dense[0].to).toBe((slots[9].base + slots[9].size) * 4)
  })

  it('stale members (the executor external clear) are filtered, duplicates merge', () => {
    const arena = createUniformArena(256)
    const slots: Array<{ base: number; size: number; dirty: boolean }> = []
    for (let i = 0; i < 20; i++) slots.push(arena.alloc(4) as unknown as { base: number; size: number; dirty: boolean })
    arena.clearDirty()
    arena.write(slots[3] as never, [1, 0, 0, 0])
    arena.write(slots[4] as never, [2, 0, 0, 0])
    arena.write(slots[12] as never, [3, 0, 0, 0])
    // the executor's per-field upload clear — an EXTERNAL dirty=false while
    // the entry stays on the internal list
    slots[12].dirty = false
    // a duplicate mark: clear-then-remark pushes the slot a second time
    // (a NEW value — the old bytes already hold 1, value-compare would pass)
    slots[3].dirty = false
    arena.write(slots[3] as never, [11, 0, 0, 0])
    const ranges = arena.dirtyRanges()
    expect(ranges).toEqual(referenceRanges(arena, slots))
    expect(ranges.length).toBe(1) // slots 3+4 merged; 12 externally clean
    expect(ranges[0].from).toBe(slots[3].base * 4)
    expect(ranges[0].to).toBe((slots[4].base + slots[4].size) * 4)
  })

  it('the returned array is the reused object (the documented contract)', () => {
    const arena = createUniformArena(128)
    const slot = arena.alloc(4)
    arena.clearDirty()
    arena.write(slot, [2, 0, 0, 0])
    const first = arena.dirtyRanges()
    const second = arena.dirtyRanges()
    expect(second).toBe(first)
    arena.clearDirty()
    const third = arena.dirtyRanges()
    expect(third).toBe(first)
    expect(third.length).toBe(0)
  })

  it('empty-list and full-bounds corners', () => {
    const arena = createUniformArena(64)
    expect(arena.dirtyRanges()).toEqual([])
    const slot = arena.alloc(16)
    // born-dirty: the single live member IS the whole answer
    const ranges = arena.dirtyRanges()
    expect(ranges.length).toBe(1)
    expect(ranges[0].from).toBe(0)
    expect(ranges[0].to).toBe(64)
    expect(slot.dirty).toBe(true)
  })
})

// ────────────────── Task 185: the nested (array-of-arrays) contract ──────────────────

describe('Task 185 — THE NESTED CONTRACT (rows flatten row-major, NaN lanes stay stable)', () => {
  it('array-of-rows flattens exactly (the u_bones: [[x,y,z,w], …] shape — pre-185 every lane was NaN)', () => {
    const arena = createUniformArena(1024)
    const slot = arena.alloc(8)
    // THE TRAP: pre-185, numbers[at] ?? 0 handed the ROW OBJECT to the
    // Float32Array store — ToNumber([x,y,z,w]) = NaN — all 8 lanes NaN.
    expect(arena.write(slot, [[1, 2, 3, 4], [5, 6, 7, 8]])).toBe(true)
    expect(Array.from(arena.buffer.subarray(slot.base, slot.base + 8))).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('typed-array rows flatten too (Float32Array/Uint32Array rows)', () => {
    const arena = createUniformArena(1024)
    const slot = arena.alloc(6)
    const rows: unknown[] = [new Float32Array([0.5, 1.5]), new Uint32Array([7, 8, 9])]
    expect(arena.write(slot, rows as never as ArrayLike<number>)).toBe(true)
    expect(Array.from(arena.buffer.subarray(slot.base, slot.base + 6))).toEqual([0.5, 1.5, 7, 8, 9, 0])
  })

  it('a SHORT row set zero-pads the slot tail; rows past the slot size are ignored (the flat loop rules)', () => {
    const arena = createUniformArena(1024)
    const slot = arena.alloc(4)
    // rows fill the lanes SEQUENTIALLY: [10,20] then [30,40,50…] — the 50+
    // never lands (lane 4 ≥ slot.size)
    expect(arena.write(slot, [[10, 20], [30, 40, 50, 60, 70]])).toBe(true)
    expect(Array.from(arena.buffer.subarray(slot.base, slot.base + 4))).toEqual([10, 20, 30, 40])
    // rows ran out before the lanes did — the TAIL zero-pads (a flat [1,2]
    // into a 4-lane slot writes [1,2,0,0]; a [[1,2]] must not leave the tail
    // STALE — the pre-fix draft did, caught by this very test)
    expect(arena.write(slot, [[1, 2]])).toBe(true)
    expect(Array.from(arena.buffer.subarray(slot.base, slot.base + 4))).toEqual([1, 2, 0, 0])
  })

  it('a NON-ROW element is ONE lane with the flat-path semantics (null → 0, object → NaN)', () => {
    const arena = createUniformArena(1024)
    const slot = arena.alloc(6)
    // a bare number row = a 1-lane row; null row = one 0 lane (the ?? 0
    // convention); an object row = NaN exactly as the flat store coerced it.
    const rows: unknown[] = [[0.25], null, [9, 9], { odd: true }, [8, 8]]
    expect(arena.write(slot, rows as never as ArrayLike<number>)).toBe(true)
    expect(arena.buffer[slot.base + 0]).toBe(0.25) // [0.25] — a 1-lane row
    expect(arena.buffer[slot.base + 1]).toBe(0)    // null — one zero lane
    expect(arena.buffer[slot.base + 2]).toBe(9)    // [9, 9]
    expect(arena.buffer[slot.base + 3]).toBe(9)
    expect(arena.buffer[slot.base + 4]).toBeNaN()  // the object row — ToNumber
    expect(arena.buffer[slot.base + 5]).toBe(8)    // [8, 8]'s first lane
  })

  it('unchanged nested values are NOT dirty (the compare works per lane); a change re-dirties', () => {
    const arena = createUniformArena(1024)
    const slot = arena.alloc(4)
    arena.write(slot, [[1, 2, 3, 4]])
    arena.clearDirty()
    // same rows — nothing changes, the slot is NOT re-marked (the pre-179
    // NaN-soup re-dirty leak is dead AND the flatten compares correctly)
    expect(arena.write(slot, [[1, 2, 3, 4]])).toBe(false)
    expect(slot.dirty).toBe(false)
    expect(arena.write(slot, [[1, 2, 9, 4]])).toBe(true)
    expect(slot.dirty).toBe(true)
  })

  it('NaN lanes inside rows keep the Task-179 stability (NaN→NaN writes once)', () => {
    const arena = createUniformArena(1024)
    const slot = arena.alloc(4)
    expect(arena.write(slot, [[NaN, 2, 3, 4]])).toBe(true)
    arena.clearDirty()
    expect(arena.write(slot, [[NaN, 2, 3, 4]])).toBe(false)
    expect(slot.dirty).toBe(false)
    expect(arena.buffer[slot.base]).toBeNaN() // the NaN reached the buffer once
    // NaN → number still changes
    expect(arena.write(slot, [[0.5, 2, 3, 4]])).toBe(true)
    expect(arena.buffer[slot.base]).toBe(0.5)
  })

  it('mixed rows-of-numbers (a flat number[] with a leading number) take the FLAT path', () => {
    const arena = createUniformArena(1024)
    const slot = arena.alloc(3)
    // first element is a NUMBER — the flat loop runs; the object lane still
    // coerces NaN (the pre-185 semantics preserved for non-nested shapes)
    expect(arena.write(slot, [1, 2, 3])).toBe(true)
    expect(Array.from(arena.buffer.subarray(slot.base, slot.base + 3))).toEqual([1, 2, 3])
  })

  it('scalar and empty values are untouched (the nested branch never fires)', () => {
    const arena = createUniformArena(1024)
    const slot = arena.alloc(4)
    expect(arena.write(slot, 7)).toBe(true)
    expect(arena.buffer[slot.base]).toBe(7)
    expect(arena.write(slot, [])).toBe(true) // all-zero lanes (?? 0)
    expect(Array.from(arena.buffer.subarray(slot.base, slot.base + 4))).toEqual([0, 0, 0, 0])
  })
})
