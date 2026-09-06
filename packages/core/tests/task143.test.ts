import { describe, expect, it } from 'bun:test'
import { OpCode, createTapeWriter, createSegmentStore, createTransport, createFeed } from '../src/index.ts'

// Task 143 — the bit-identical speed pass's regression pins.

describe('task 143: tape writer columns view', () => {
  it('the columns view is STABLE between accesses (no per-access allocation)', () => {
    const writer = createTapeWriter(8)
    writer.emit(OpCode.Draw, 1, 2, 3, 4)
    const first = writer.columns
    expect(writer.columns).toBe(first) // same object — the cached view
    expect(first.op[0]).toBe(OpCode.Draw)
    expect(first.a[0]).toBe(1)
    expect(first.d[0]).toBe(4)
  })

  it('grow() swaps the view: the new columns reflect the grown arrays, old data survives', () => {
    const writer = createTapeWriter(16) // capacity floor is 16
    for (let i = 0; i < 16; i++) writer.emit(OpCode.Draw, i + 1, 0, 0, 0)
    const before = writer.columns
    writer.emit(OpCode.Draw, 17, 7, 0, 0) // the 17th emit forces grow (32)
    const after = writer.columns
    expect(after).not.toBe(before) // the growth epoch invalidated the cache
    expect(after.op[16]).toBe(OpCode.Draw)
    expect(after.a[16]).toBe(17)
    expect(after.b[16]).toBe(7)
    expect(after.op[0]).toBe(OpCode.Draw) // grown arrays carry the old rows
    expect(after.a[0]).toBe(1)
    expect(after.a[15]).toBe(16)
    expect(writer.count).toBe(17)
  })

  it('reset keeps the view identity (only count moves)', () => {
    const writer = createTapeWriter(4)
    writer.emit(OpCode.Draw, 9, 0, 0, 0)
    const view = writer.columns
    writer.reset()
    expect(writer.columns).toBe(view)
    expect(writer.count).toBe(0)
    writer.emit(OpCode.BindTarget, 4, 1, 0, 0)
    expect(view.op[0]).toBe(OpCode.BindTarget)
  })
})

describe('task 143: segment store (the delete-free store)', () => {
  it('re-store replaces rows and count in place (fetch sees the NEW content)', () => {
    const store = createSegmentStore(2)
    const w1 = createTapeWriter(4)
    w1.emit(OpCode.Draw, 11, 0, 6, 1)
    store.store(5, packOf(w1), w1.count)
    const w2 = createTapeWriter(4)
    w2.emit(OpCode.Draw, 12, 0, 8, 2)
    w2.emit(OpCode.BindTarget, 4, 1, 0, 0)
    store.store(5, packOf(w2), w2.count)
    const segment = store.fetch(5)
    expect(segment?.count).toBe(2)
    expect(segment?.rows[0]).toBe(OpCode.Draw)
    expect(segment?.rows[1]).toBe(12)
    expect(segment?.rows[4]).toBe(2) // first row, column d
    expect(segment?.rows[5]).toBe(OpCode.BindTarget)
    expect(segment?.rows[5 + 1]).toBe(4) // second row, column a
  })

  it('LRU eviction still evicts by TOUCH epoch, not insertion order (delete-free path)', () => {
    const store = createSegmentStore(2)
    const a = createTapeWriter(2); a.emit(OpCode.Draw, 1, 0, 0, 0)
    const b = createTapeWriter(2); b.emit(OpCode.Draw, 2, 0, 0, 0)
    const c = createTapeWriter(2); c.emit(OpCode.Draw, 3, 0, 0, 0)
    store.store(1, packOf(a), 1)
    store.store(2, packOf(b), 1)
    store.fetch(1) // touch: 1 is now the MOST recently used
    store.store(3, packOf(c), 1) // over capacity: 2 (least-recently touched) must go
    expect(store.fetch(1)).toBeDefined()
    expect(store.fetch(2)).toBeUndefined()
    expect(store.fetch(3)).toBeDefined()
    expect(store.evictions).toBe(1)
    expect(store.hits).toBe(3)
    expect(store.misses).toBe(1)
  })
})

function packOf(writer: ReturnType<typeof createTapeWriter>): Int32Array {
  const columns = writer.columns
  const rows = new Int32Array(writer.count * 5)
  for (let at = 0; at < writer.count; at++) {
    const base = at * 5
    rows[base] = columns.op[at]
    rows[base + 1] = columns.a[at]
    rows[base + 2] = columns.b[at]
    rows[base + 3] = columns.c[at]
    rows[base + 4] = columns.d[at]
  }
  return rows
}

describe('task 143: msg-transport writer (inlined field resolution)', () => {
  it('every set* lands its bytes at the exact field offsets of a 3-field layout', () => {
    const LAYOUT = { position: 'float32x3', radius: 'float32', tint: 'float32x4' } as const
    const { host, client } = createTransport({ mode: 'msg', names: [] })
    const feed = host.createFeed({ layout: LAYOUT, capacity: 4 })
    const view = client.attachFeed(1, LAYOUT, 4)
    const batch = feed.push(2)
    batch.setVec3('position', 0, 1, 2, 3)
    batch.setFloat('radius', 0, 0.5)
    batch.setVec4('tint', 0, 0.1, 0.2, 0.3, 0.4)
    batch.setVec3('position', 1, 4, 5, 6)
    batch.setFloat('radius', 1, 0.25)
    batch.setVec4('tint', 1, 0.9, 0.8, 0.7, 0.6)
    feed.publish()
    client.apply(host.flush()!)
    const mirror = new Float32Array(view.bytes())
    const stride = 8 // 3 + 1 + 4 floats
    // record 0
    expect(mirror[0]).toBe(1); expect(mirror[1]).toBe(2); expect(mirror[2]).toBe(3)
    expect(mirror[3]).toBe(0.5)
    expect(mirror[4]).toBeCloseTo(0.1); expect(mirror[5]).toBeCloseTo(0.2)
    expect(mirror[6]).toBeCloseTo(0.3); expect(mirror[7]).toBeCloseTo(0.4)
    // record 1 — the second row starts at the 8-float stride
    expect(mirror[stride + 0]).toBe(4); expect(mirror[stride + 1]).toBe(5); expect(mirror[stride + 2]).toBe(6)
    expect(mirror[stride + 3]).toBe(0.25)
    expect(mirror[stride + 4]).toBeCloseTo(0.9)
    expect(view.count()).toBe(2)
  })

  it('setVec2 and setVec4Bytes land at their offsets (the byte-addressed twin)', () => {
    const LAYOUT = { uv: 'float32x2', rgba: 'unorm8x4' } as const
    const { host, client } = createTransport({ mode: 'msg', names: [] })
    const feed = host.createFeed({ layout: LAYOUT, capacity: 2 })
    const view = client.attachFeed(1, LAYOUT, 2)
    const batch = feed.push(1)
    batch.setVec2('uv', 0, 0.25, 0.75)
    batch.setVec4Bytes('rgba', 0, 12, 34, 56, 78)
    feed.publish()
    client.apply(host.flush()!)
    const mirrorF = new Float32Array(view.bytes())
    const bytes = new Uint8Array(mirrorF.buffer, mirrorF.byteOffset, mirrorF.byteLength)
    expect(bytes[0]).toBe(0); // 0.25 as f32 bits: 0x3E800000 LE → bytes[0]=0
    // rgba (unorm8x4) sits at byte offset 8 — AFTER the 8-byte uv field
    expect(bytes[8]).toBe(12); expect(bytes[9]).toBe(34); expect(bytes[10]).toBe(56); expect(bytes[11]).toBe(78)
    expect(mirrorF[0]).toBe(0.25); expect(mirrorF[1]).toBe(0.75)
    expect(view.count()).toBe(1)
  })

  it('the undeclared-field error fires from EVERY set* closure (inlined resolution keeps the message)', () => {
    const LAYOUT = { position: 'float32x3' } as const
    const { host } = createTransport({ mode: 'msg', names: [] })
    const feed = host.createFeed({ layout: LAYOUT, capacity: 2 })
    const batch = feed.push(1)
    expect(() => batch.setFloat('nope', 0, 1)).toThrow('rune: feed field "nope" is not declared')
    expect(() => batch.setVec2('nope', 0, 1, 2)).toThrow('rune: feed field "nope" is not declared')
    expect(() => batch.setVec3('nope', 0, 1, 2, 3)).toThrow('rune: feed field "nope" is not declared')
    expect(() => batch.setVec4('nope', 0, 1, 2, 3, 4)).toThrow('rune: feed field "nope" is not declared')
    expect(() => batch.setVec4Bytes('nope', 0, 1, 2, 3, 4)).toThrow('rune: feed field "nope" is not declared')
  })

  it('the out-of-window index error carries the exact index and window', () => {
    const LAYOUT = { position: 'float32x3' } as const
    const { host } = createTransport({ mode: 'msg', names: [] })
    const feed = host.createFeed({ layout: LAYOUT, capacity: 4 })
    feed.push(2)
    expect(() => feed.view(3, 8).setFloat('position', 0, 1)).toThrow('outside the window')
  })
})

describe('task 143: local feed writer (inlined requireOffset)', () => {
  it('local feed writes land at exact offsets and keep the undeclared-field error', () => {
    const LAYOUT = { position: 'float32x3', radius: 'float32' } as const
    const feed = createFeed({ layout: LAYOUT, capacity: 8, backing: 'local' })
    const batch = feed.push(2)
    batch.setVec3('position', 0, 1, 2, 3)
    batch.setFloat('radius', 0, 0.5)
    batch.setVec3('position', 1, 4, 5, 6)
    batch.setFloat('radius', 1, 0.25)
    feed.publish()
    expect(feed.publishedCount()).toBe(2)
    const body = new Float32Array(feed.buffer, 64, 16)
    expect(body[0]).toBe(1); expect(body[1]).toBe(2); expect(body[2]).toBe(3); expect(body[3]).toBe(0.5)
    expect(body[4]).toBe(4); expect(body[5]).toBe(5); expect(body[6]).toBe(6); expect(body[7]).toBe(0.25)
    expect(() => feed.push(1)!.setVec4('undeclared', 0, 1, 2, 3, 4)).toThrow('rune: feed field "undeclared" is not declared')
  })
})
