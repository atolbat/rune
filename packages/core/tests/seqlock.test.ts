import { describe, expect, it } from 'bun:test'
import { readSeqlock, writeSeqlock, seqlockVersion } from '../src/transport/seqlock.ts'

function slot(): DataView {
  return new DataView(new SharedArrayBuffer(16))
}

describe('seqlock', () => {
  it('write then read: the value and an even version', () => {
    const view = slot()
    writeSeqlock(view, 0, 8, 42.5)
    const read = readSeqlock(view, 0, 8)
    expect(read.value).toBe(42.5)
    expect(read.version % 2).toBe(0)
    expect(seqlockVersion(view, 0)).toBe(2)
  })

  it('sequential writes: the version grows monotonically', () => {
    const view = slot()
    writeSeqlock(view, 0, 8, 1)
    writeSeqlock(view, 0, 8, 2)
    writeSeqlock(view, 0, 8, 3)
    expect(seqlockVersion(view, 0)).toBe(6)
    expect(readSeqlock(view, 0, 8).value).toBe(3)
  })

  it('an open writer (odd version) — an error after the attempt limit, not an eternal spin', () => {
    const view = slot()
    view.setUint32(0, 1, true) // the writer "hung" between entry and exit
    expect(() => readSeqlock(view, 0, 8)).toThrow(/livelock/)
  })

  it('an unaligned version — an explicit contract error', () => {
    const view = slot()
    expect(() => readSeqlock(view, 2, 8)).toThrow(/boundary/)
    expect(() => writeSeqlock(view, 2, 8, 1)).toThrow(/boundary/)
  })
})
