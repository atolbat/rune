import { describe, expect, it } from 'bun:test'
import { readSeqlock, writeSeqlock, seqlockVersion } from '../src/transport/seqlock.ts'

function slot(): DataView {
  return new DataView(new SharedArrayBuffer(16))
}

describe('seqlock', () => {
  it('запись затем чтение: значение и чётная версия', () => {
    const view = slot()
    writeSeqlock(view, 0, 8, 42.5)
    const read = readSeqlock(view, 0, 8)
    expect(read.value).toBe(42.5)
    expect(read.version % 2).toBe(0)
    expect(seqlockVersion(view, 0)).toBe(2)
  })

  it('последовательные записи: версия монотонно растёт', () => {
    const view = slot()
    writeSeqlock(view, 0, 8, 1)
    writeSeqlock(view, 0, 8, 2)
    writeSeqlock(view, 0, 8, 3)
    expect(seqlockVersion(view, 0)).toBe(6)
    expect(readSeqlock(view, 0, 8).value).toBe(3)
  })

  it('открытый писатель (нечётная версия) — ошибка после лимита попыток, не вечный спин', () => {
    const view = slot()
    view.setUint32(0, 1, true) // писатель «завис» между входом и выходом
    expect(() => readSeqlock(view, 0, 8)).toThrow(/livelock/)
  })

  it('невыровненная версия — явная ошибка контракта', () => {
    const view = slot()
    expect(() => readSeqlock(view, 2, 8)).toThrow(/границе/)
    expect(() => writeSeqlock(view, 2, 8, 1)).toThrow(/границе/)
  })
})
