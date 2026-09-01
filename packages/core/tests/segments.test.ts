import { describe, expect, it } from 'bun:test'
import { OpCode, createTapeWriter, createSegmentStore } from '../src/index.ts'

/** Пакует колонки писателя в плотные строки — контракт вызывающего
 *  (тот же packRows, что делает liveCommand: кэш хранит готовые строки). */
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
  it('fetch возвращает записанный сегмент; hits/misses считаются', () => {
    const store = createSegmentStore(4)
    const writer = createTapeWriter(8)
    writer.emit(OpCode.Draw, 1, 2, 3, 0)
    writer.emit(OpCode.Draw, 4, 5, 6, 1)

    store.store(7, packRows(writer), writer.count)
    const segment = store.fetch(7)

    expect(segment?.count).toBe(2)
    expect(segment?.rows[0]).toBe(OpCode.Draw)
    expect(segment?.rows[5 + 1]).toBe(4) // вторая строка, колонка a
    expect(segment?.rows[5 + 4]).toBe(1) // вторая строка, колонка d
    expect(store.hits).toBe(1)
    expect(store.misses).toBe(0)

    store.fetch(999)
    expect(store.misses).toBe(1)
  })

  it('записанные строки независимы от дальнейшей записи писателя', () => {
    const store = createSegmentStore(4)
    const writer = createTapeWriter(8)
    writer.emit(OpCode.Draw, 1, 0, 0, 0)
    const rows = packRows(writer)
    store.store(0, rows, writer.count)

    // Писатель перезаписан — плотная копия сегмента не изменилась.
    writer.reset()
    writer.emit(OpCode.EndPass, 9, 9, 9, 9)
    expect(store.fetch(0)?.rows[1]).toBe(1)
  })

  it('invalidate убирает сегмент: следующий fetch — miss', () => {
    const store = createSegmentStore(2)
    const writer = createTapeWriter(4)
    writer.emit(OpCode.Draw, 1, 0, 0, 0)
    store.store(3, packRows(writer), 1)
    expect(store.fetch(3)).toBeDefined()

    store.invalidate(3)
    expect(store.fetch(3)).toBeUndefined()
  })

  it('перезапись по тому же commandId заменяет сегмент', () => {
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

  it('реплей кэша: emitPacked возвращает строки в ленту без пересчёта', () => {
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
})
