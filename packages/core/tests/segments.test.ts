import { describe, expect, it } from 'bun:test'
import { OpCode, createTapeWriter, createSegmentStore } from '../src/index.ts'

/** Packs the writer columns into dense rows — the caller-side contract
 *  (the same packRows that liveCommand does: the cache stores ready rows). */
function packRows(writer: ReturnType<typeof createTapeWriter>): Int32Array {
  const columns = writer.columns
  const count = writer.count
  const rows = new Int32Array(count * 5)
  for (let at = 0; at < count; at++) {
    const base = at * 5
    rows[base] = columns.op[at]
    rows[base + 1] = columns.a[at]
    rows[base + 2] = columns.b[at]
    rows[base + 3] = columns.c[at]
    rows[base + 4] = columns.d[at]
  }
  return rows
}

describe('segment store', () => {
  it('fetch returns the stored segment; hits/misses are counted', () => {
    const store = createSegmentStore(4)
    const writer = createTapeWriter(8)
    writer.emit(OpCode.Draw, 1, 2, 3, 0)
    writer.emit(OpCode.Draw, 4, 5, 6, 1)

    store.store(7, packRows(writer), writer.count)
    const segment = store.fetch(7)

    expect(segment?.count).toBe(2)
    expect(segment?.rows[0]).toBe(OpCode.Draw)
    expect(segment?.rows[5 + 1]).toBe(4) // second row, column a
    expect(segment?.rows[5 + 4]).toBe(1) // second row, column d
    expect(store.hits).toBe(1)
    expect(store.misses).toBe(0)

    store.fetch(999)
    expect(store.misses).toBe(1)
  })

  it('stored rows are independent of further writer writes', () => {
    const store = createSegmentStore(4)
    const writer = createTapeWriter(8)
    writer.emit(OpCode.Draw, 1, 0, 0, 0)
    const rows = packRows(writer)
    store.store(0, rows, writer.count)

    // The writer was overwritten — the dense copy of the segment did not change.
    writer.reset()
    writer.emit(OpCode.EndPass, 9, 9, 9, 9)
    expect(store.fetch(0)?.rows[1]).toBe(1)
  })

  it('invalidate removes the segment: the next fetch — a miss', () => {
    const store = createSegmentStore(2)
    const writer = createTapeWriter(4)
    writer.emit(OpCode.Draw, 1, 0, 0, 0)
    store.store(3, packRows(writer), 1)
    expect(store.fetch(3)).toBeDefined()

    store.invalidate(3)
    expect(store.fetch(3)).toBeUndefined()
  })

  it('a rewrite under the same commandId replaces the segment', () => {
    const store = createSegmentStore(2)
    const writer = createTapeWriter(4)
    writer.emit(OpCode.Draw, 1, 0, 0, 0)
    store.store(5, packRows(writer), 1)

    writer.reset()
    writer.emit(OpCode.Draw, 2, 0, 0, 0)
    writer.emit(OpCode.Draw, 3, 0, 0, 0)
    store.store(5, packRows(writer), 2)

    const segment = store.fetch(5)
    expect(segment?.count).toBe(2)
    expect(segment?.rows[1]).toBe(2)
  })

  it('cache replay: emitPacked returns rows into the tape without recompute', () => {
    const store = createSegmentStore(2)
    const writer = createTapeWriter(4)
    writer.emit(OpCode.Draw, 1, 0, 36, 1)
    const rows = packRows(writer)
    store.store(11, rows, 1)

    const frame = createTapeWriter(8)
    const cached = store.fetch(11)
    expect(cached).toBeDefined()
    frame.emitPacked(cached!.rows, cached!.count)

    expect(frame.count).toBe(1)
    expect(frame.columns.op[0]).toBe(OpCode.Draw)
    expect(frame.columns.c[0]).toBe(36)
    expect(frame.columns.d[0]).toBe(1)
  })

  it('writtenAt grows with every store — age diagnostics is honest', () => {
    const store = createSegmentStore(4)
    const writer = createTapeWriter(4)
    writer.emit(OpCode.Draw, 1, 0, 0, 0)
    store.store(1, packRows(writer), 1)
    writer.reset()
    writer.emit(OpCode.Draw, 2, 0, 0, 0)
    store.store(2, packRows(writer), 1)
    expect(store.fetch(1)!.writtenAt).toBeLessThan(store.fetch(2)!.writtenAt)
  })
})

describe('eviction by capacity (LRU)', () => {
  it('above capacity the least recently used segment is evicted', () => {
    const store = createSegmentStore(2)
    const writer = createTapeWriter(4)
    writer.emit(OpCode.Draw, 1, 0, 0, 0)
    store.store(1, packRows(writer), 1)
    writer.reset()
    writer.emit(OpCode.Draw, 2, 0, 0, 0)
    store.store(2, packRows(writer), 1)
    writer.reset()
    writer.emit(OpCode.Draw, 3, 0, 0, 0)
    store.store(3, packRows(writer), 1) // id 1 evicted — the oldest

    expect(store.fetch(1)).toBeUndefined()
    expect(store.fetch(2)?.rows[1]).toBe(2)
    expect(store.fetch(3)?.rows[1]).toBe(3)
    expect(store.evictions).toBe(1)
  })

  it('fetch refreshes the position: a read segment survives eviction', () => {
    const store = createSegmentStore(2)
    const writer = createTapeWriter(4)
    writer.emit(OpCode.Draw, 1, 0, 0, 0)
    store.store(1, packRows(writer), 1)
    writer.reset()
    writer.emit(OpCode.Draw, 2, 0, 0, 0)
    store.store(2, packRows(writer), 1)
    store.fetch(1) // LRU refresh: id 1 is now "fresher" than id 2
    writer.reset()
    writer.emit(OpCode.Draw, 3, 0, 0, 0)
    store.store(3, packRows(writer), 1) // id 2 evicted

    expect(store.fetch(2)).toBeUndefined()
    expect(store.fetch(1)).toBeDefined()
  })

  it('capacity < 1 — eviction disabled (no limit)', () => {
    const store = createSegmentStore(0)
    const writer = createTapeWriter(4)
    for (let id = 1; id <= 5; id++) {
      writer.reset()
      writer.emit(OpCode.Draw, id, 0, 0, 0)
      store.store(id, packRows(writer), 1)
    }
    expect(store.evictions).toBe(0)
    expect(store.fetch(3)).toBeDefined()
  })
})
