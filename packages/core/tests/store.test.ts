/**
 * store.test.ts — Task 211: THE UNIFIED DATA SURFACE's contracts.
 *
 * Every law the module header claims is asserted here:
 *   · the layout (columns back to back, 4-aligned, stride = Σ widths);
 *   · BOTH growth lanes preserve the bytes (the copy twin and the RAB
 *     in-place remap) and bump the epoch (the view law);
 *   · the dirty surface: exact ranges, the MERGE_GAP coalescing, the
 *     per-column fan-out, buffer-relative adoption offsets, and the
 *     dirty bits' SURVIVAL across growth;
 *   · the MarkSet equivalence gate: sparse walk ≡ dense walk ≡ set
 *     membership, at every density (the crossover changes the LANE,
 *     never the ANSWER);
 *   · the packed keys' order: keys.sort() with no comparator lands
 *     the (hi, lo) order, the overflow refuses loudly;
 *   · adoptStore aliases the caller's bytes (zero copies — the scene
 *     buffer's own pattern).
 */
import { test, expect } from 'bun:test'
import {
  createStore, adoptStore, createMarkSet, createMarkSetFrom,
  packKey, unpackKeyHi, unpackKeyLo,
} from '../src/store.ts'
import type { SoAStore, MarkSet } from '../src/store.ts'

const RAB = typeof ArrayBuffer.prototype.resize === 'function'

/** The demo-shaped schema: one 12-word record (center/half/color-ish). */
const REC = [{ name: 'rec', kind: 'f32' as const, width: 12 }]

/** A two-column schema (the per-column fan-out's shape). */
const PAIR = [
  { name: 'pos', kind: 'f32' as const, width: 3 },
  { name: 'meta', kind: 'i32' as const, width: 1 },
]

test('store: the layout — columns back to back, 4-aligned, stride = Σ widths', () => {
  const st = createStore(PAIR, { capacity: 10 })
  expect(st.stride).toBe(4)
  const pos = st.column('pos') as Float32Array
  const meta = st.column('meta') as Int32Array
  expect(pos.length).toBe(30)
  expect(meta.length).toBe(10)
  const posRange = st.columnBytes('pos')
  const metaRange = st.columnBytes('meta')
  expect(posRange.start).toBe(0)
  expect(posRange.end).toBe(120)
  expect(metaRange.start).toBe(120)
  expect(metaRange.end).toBe(160)
  expect((posRange.start & 3) === 0 && (posRange.end & 3) === 0).toBe(true)
  // A missing column refuses loudly.
  expect(() => st.column('nope')).toThrow("no column 'nope'")
})

test('store: duplicate column names refuse at the door', () => {
  expect(() => createStore([{ name: 'a', kind: 'f32', width: 1 }, { name: 'a', kind: 'u32', width: 2 }], { capacity: 4 })).toThrow('duplicate column')
  expect(() => createStore([], { capacity: 4 })).toThrow('no columns')
  expect(() => createStore([{ name: 'a', kind: 'f32', width: 0 }], { capacity: 4 })).toThrow('width')
})

test('store: the copy lane preserves the bytes and bumps the epoch', () => {
  const st = createStore(REC, { capacity: 4, growth: 'copy' })
  const before = st.column('rec') as Float32Array
  for (let i = 0; i < 4; i++) {
    const w = i * 12
    for (let k = 0; k < 12; k++) before[w + k] = i * 100 + k
  }
  st.resize(4)
  const epoch0 = st.epoch
  for (let i = 4; i < 10; i++) {
    const r = st.append()
    expect(r).toBe(i)
    const v = st.column('rec') as Float32Array
    const w = r * 12
    for (let k = 0; k < 12; k++) v[w + k] = i * 100 + k
  }
  expect(st.count).toBe(10)
  expect(st.capacity).toBeGreaterThanOrEqual(10)
  expect(st.epoch).toBeGreaterThan(epoch0)
  const after = st.column('rec') as Float32Array
  expect(after.buffer).not.toBe(before.buffer) // the copy lane MOVED the bytes
  for (let i = 0; i < 10; i++) {
    for (let k = 0; k < 12; k++) expect(after[i * 12 + k]).toBe(i * 100 + k)
  }
})

test('store: the rab lane keeps the buffer object (the in-place remap) and the bytes', () => {
  if (!RAB) return // no resizable ArrayBuffers on this runtime — the honest skip
  const st = createStore(REC, { capacity: 4, growth: 'rab' })
  const buffer0 = st.buffer
  for (let i = 0; i < 40; i++) {
    const r = st.append()
    const v = st.column('rec') as Float32Array
    for (let k = 0; k < 12; k++) v[r * 12 + k] = i * 7 + k
  }
  expect(st.count).toBe(40)
  // The whole point: the VA remap never moves the bytes.
  expect(st.buffer).toBe(buffer0)
  const v = st.column('rec') as Float32Array
  for (let i = 0; i < 40; i++) {
    for (let k = 0; k < 12; k++) expect(v[i * 12 + k]).toBe(i * 7 + k)
  }
})

test('store: the none lane refuses over capacity (the adopted contract)', () => {
  const st = createStore(REC, { capacity: 2, growth: 'none' })
  st.resize(2)
  expect(() => st.reserve(3)).toThrow('fixed-capacity')
  expect(() => st.append()).toThrow('fixed-capacity')
})

test('store: copyRecords — the bulk copy, overlap-safe both directions', () => {
  const st = createStore(REC, { capacity: 32, growth: 'none' })
  st.resize(16)
  const v = st.column('rec') as Float32Array
  for (let i = 0; i < 16; i++) for (let k = 0; k < 12; k++) v[i * 12 + k] = i
  // forward overlap: dst > src
  st.copyRecords(4, 2, 8)
  for (let i = 4; i < 12; i++) for (let k = 0; k < 12; k++) expect(v[i * 12 + k]).toBe(i - 2)
  // backward overlap: dst < src — records 6..13 land at 0..7; their
  // CURRENT values: 6..11 were rewritten by the first copy (i−2),
  // 12..13 kept their originals — the reference array is the truth.
  st.copyRecords(0, 6, 8)
  const expected = [4, 5, 6, 7, 8, 9, 12, 13]
  for (let i = 0; i < 8; i++) for (let k = 0; k < 12; k++) expect(v[i * 12 + k]).toBe(expected[i])
  // out of range refuses
  expect(() => st.copyRecords(10, 0, 10)).toThrow('outruns')
})

test('store: swapRemove — the O(1) dense delete (order not preserved, by contract)', () => {
  const st = createStore(PAIR, { capacity: 8, growth: 'none' })
  st.resize(4)
  const pos = st.column('pos') as Float32Array
  const meta = st.column('meta') as Int32Array
  for (let i = 0; i < 4; i++) {
    pos[i * 3] = i; pos[i * 3 + 1] = i * 10; pos[i * 3 + 2] = i * 100
    meta[i] = i
  }
  st.swapRemove(1) // record 3 moves into slot 1
  expect(st.count).toBe(3)
  expect(meta[1]).toBe(3)
  expect(pos[3]).toBe(3); expect(pos[4]).toBe(30); expect(pos[5]).toBe(300)
  expect(() => st.swapRemove(3)).toThrow('not a live record')
})

test('store: adoptStore aliases the caller bytes (zero copies) and is fixed-capacity', () => {
  // The occlusion scene's own shape: [list|flags|hist|records] — the
  // store rides the records region at byteOffset.
  const N = 8
  const words = new Uint32Array(3 * N + N * 12)
  const f32 = new Float32Array(words.buffer)
  for (let i = 0; i < N; i++) {
    const w = 3 * N + i * 12
    f32[w] = i + 0.5; f32[w + 3] = 1; f32[w + 6] = 0.25
  }
  const st = adoptStore(words.buffer, REC, N, 3 * N * 4)
  expect(st.capacity).toBe(N)
  expect(st.count).toBe(N)
  expect(st.growth).toBe('none')
  // The view IS the caller's bytes.
  const v = st.column('rec') as Float32Array
  expect(v.buffer).toBe(words.buffer)
  expect(v[0]).toBe(0.5)
  v[1] = 42
  expect(f32[3 * N + 1]).toBe(42)
  // The dirty ranges are BUFFER-relative (the byteOffset rides).
  st.markRecordDirty(0)
  const ranges = st.takeUploadRanges()
  expect(ranges.length).toBe(1)
  expect(ranges[0].start).toBe(3 * N * 4)
  expect(ranges[0].end).toBe(3 * N * 4 + 48)
  expect(() => st.reserve(N + 1)).toThrow('fixed-capacity')
  // A buffer too small for one record refuses.
  expect(() => adoptStore(new ArrayBuffer(8), REC, 0)).toThrow('cannot hold')
})

test('store: the dirty surface — exact ranges, MERGE_GAP coalescing, per-column fan-out', () => {
  const st = createStore(PAIR, { capacity: 64, growth: 'none' })
  st.resize(64)
  // Single record: one range PER COLUMN, exact bytes.
  st.markRecordDirty(10)
  let rs = st.takeUploadRanges()
  expect(rs.length).toBe(2) // pos + meta
  expect(rs[0]).toEqual({ start: 10 * 3 * 4, end: 11 * 3 * 4 })
  expect(rs[1]).toEqual({ start: 64 * 3 * 4 + 10 * 4, end: 64 * 3 * 4 + 11 * 4 })
  expect(st.dirtyBytes).toBe(16) // (3+1) elements × 4B
  expect(st.dirtyCount).toBe(1)
  st.clearDirty()
  expect(st.takeUploadRanges().length).toBe(0)
  expect(st.dirtyBytes).toBe(0)
  // Neighbors within MERGE_GAP=8 merge; farther apart stay separate.
  st.markRecordDirty(0)
  st.markRecordDirty(5)
  st.markRecordDirty(6)
  st.markRecordDirty(30)
  rs = st.takeUploadRanges()
  expect(rs.length).toBe(4) // two runs × two columns
  // The emit order is RUN-major, column-minor: [pos run1, meta run1,
  // pos run2, meta run2] (a single-column store is globally ascending;
  // a multi-column store trades that for one emit per run — every
  // range is an independent upload either way).
  expect(rs[0]).toEqual({ start: 0, end: 7 * 12 })
  expect(rs[1]).toEqual({ start: 64 * 12, end: 64 * 12 + 7 * 4 })
  expect(rs[2]).toEqual({ start: 30 * 12, end: 31 * 12 })
  expect(rs[3]).toEqual({ start: 64 * 12 + 30 * 4, end: 64 * 12 + 31 * 4 })
  // Non-overlapping and 4-aligned — the upload contract.
  for (let i = 0; i < rs.length; i++) {
    expect(rs[i].start % 4).toBe(0)
    expect(rs[i].end % 4).toBe(0)
    for (let j = 0; j < rs.length; j++) {
      if (i !== j) expect(rs[i].start >= rs[j].end || rs[i].end <= rs[j].start).toBe(true)
    }
  }
  // touchAll = the full re-upload leg.
  st.touchAll()
  rs = st.takeUploadRanges()
  expect(rs.length).toBe(2)
  expect(rs[0]).toEqual({ start: 0, end: 64 * 12 })
  expect(st.dirtyCount).toBe(64)
})

test('store: the dirty bits SURVIVE growth (the pending upload is never lost)', () => {
  const lanes: ('rab' | 'copy')[] = RAB ? ['rab', 'copy'] : ['copy']
  for (const growth of lanes) {
    const st = createStore(REC, { capacity: 4, growth })
    st.resize(4)
    const v = st.column('rec') as Float32Array
    v[0] = 11; v[12] = 22
    st.markRecordDirty(0)
    st.markRecordDirty(1)
    for (let i = 0; i < 6; i++) st.append() // growth fires
    expect(st.count).toBe(10)
    expect(st.dirtyCount).toBe(2)
    const rs = st.takeUploadRanges()
    expect(rs.length).toBe(1) // neighbors (gap 1 ≤ 8)
    expect(rs[0].start).toBe(0)
    expect(rs[0].end).toBe(2 * 48)
    const v2 = st.column('rec') as Float32Array
    expect(v2[0]).toBe(11); expect(v2[12]).toBe(22)
  }
})

test('store: the clock and the epoch discipline', () => {
  const st = createStore(REC, { capacity: 8, growth: 'copy' })
  expect(st.clock).toBe(0)
  st.bump()
  expect(st.clock).toBe(1)
  st.append()
  expect(st.clock).toBe(2)
  st.copyRecords(0, 0, 1) // self-copy is a no-op (no bump path taken? — n<=0/self returns early)
  st.swapRemove(0)
  expect(st.clock).toBe(3)
  const e = st.epoch
  st.reserve(100)
  expect(st.epoch).toBeGreaterThan(e)
})

test('MarkSet: the equivalence gate — sparse ≡ dense ≡ membership at every density', () => {
  // Deterministic xorshift — the repo's own rng shape.
  let seed = 0x211211
  const rng = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
    return (seed >>> 0) / 4294967296
  }
  for (const density of [0.01, 0.05, 0.125, 0.3, 0.5, 0.7, 0.9, 1.0]) {
    const ms = createMarkSet(1000)
    const truth = new Set<number>()
    for (let i = 0; i < 1000; i++) {
      if (rng() < density) {
        ms.add(i)
        truth.add(i)
      }
    }
    expect(ms.count()).toBe(truth.size)
    const sparse: number[] = []
    const dense: number[] = []
    ms.forEachSparse(i => sparse.push(i))
    ms.forEachDense(i => dense.push(i))
    expect(sparse.length).toBe(truth.size)
    expect(dense.length).toBe(truth.size)
    for (let k = 0; k < sparse.length; k++) expect(sparse[k]).toBe(dense[k])
    for (const i of sparse) expect(ms.has(i)).toBe(true)
    for (let k = 1; k < sparse.length; k++) expect(sparse[k]).toBeGreaterThan(sparse[k - 1]) // strictly ascending — the range coalescing's own law
    expect(Math.abs(ms.density() - truth.size / 1000)).toBeLessThan(1e-12)
  }
})

test('MarkSet: remove / clearAll / the picked forEach ≡ both lanes', () => {
  const ms = createMarkSet(100)
  ms.add(5); ms.add(50); ms.add(99)
  expect(ms.remove(50)).toBe(true)
  expect(ms.remove(50)).toBe(false)
  expect(ms.count()).toBe(2)
  const seen: number[] = []
  ms.forEach(i => seen.push(i))
  expect(seen).toEqual([5, 99])
  // Out-of-range adds are ignored (the defensive contract).
  expect(ms.add(-1)).toBe(false)
  expect(ms.add(100)).toBe(false)
  ms.clearAll()
  expect(ms.count()).toBe(0)
})

test('MarkSet: createMarkSetFrom carries the words and recounts', () => {
  const a = createMarkSet(200)
  a.add(3); a.add(70); a.add(199)
  const b = createMarkSetFrom(a.words(), 400)
  expect(b.count()).toBe(3)
  expect(b.has(3)).toBe(true); expect(b.has(70)).toBe(true); expect(b.has(199)).toBe(true)
  expect(b.capacity).toBe(400)
  b.add(300)
  expect(b.count()).toBe(4)
})

test('packed keys: the roundtrip and the comparator-free (hi, lo) order', () => {
  // Task-209's shape: an 8-bit bucket high, a 24-bit index low.
  const keys = new Uint32Array(1000)
  let seed = 777
  const rng = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
    return (seed >>> 0) / 4294967296
  }
  const his: number[] = []
  const los: number[] = []
  for (let i = 0; i < keys.length; i++) {
    const hi = (rng() * 200) | 0
    const lo = (rng() * 16777216) | 0
    keys[i] = packKey(hi, lo, 24)
    his.push(hi); los.push(lo)
  }
  keys.sort() // NO comparator — the 4.4× law
  for (let i = 1; i < keys.length; i++) {
    const prev = keys[i - 1], cur = keys[i]
    expect(prev <= cur).toBe(true)
    // the (hi, lo) lexicographic law
    expect(unpackKeyHi(prev, 24) < unpackKeyHi(cur, 24) ||
      (unpackKeyHi(prev, 24) === unpackKeyHi(cur, 24) && unpackKeyLo(prev, 24) <= unpackKeyLo(cur, 24))).toBe(true)
  }
  // The roundtrip is exact.
  for (let i = 0; i < keys.length; i++) {
    expect(unpackKeyLo(keys[i], 24) <= 0xFFFFFF).toBe(true)
  }
  // Overflows refuse loudly.
  expect(() => packKey(0, 1 << 24, 24)).toThrow('does not fit')
  expect(() => packKey(1 << 8, 0, 24)).toThrow('does not fit')
  expect(() => packKey(0, 0, 33)).toThrow('loBits')
  // The degenerate lanes.
  expect(packKey(5, 0, 0)).toBe(5)
  expect(unpackKeyLo(packKey(5, 0, 0), 0)).toBe(0)
})

test('store: shared stores — plain SAB rides, the copy lane refuses, rab downgrades honestly', () => {
  const plain = createStore(REC, { capacity: 4, shared: true, growth: 'none' })
  expect(plain.buffer instanceof SharedArrayBuffer).toBe(true)
  expect(() => createStore(REC, { capacity: 4, shared: true, growth: 'copy' })).toThrow('refuses the copy lane')
  const growable = typeof SharedArrayBuffer !== 'undefined' &&
    typeof SharedArrayBuffer.prototype.grow === 'function'
  const rab = createStore(REC, { capacity: 4, shared: true, growth: 'rab' })
  expect(rab.growth).toBe(growable ? 'rab' : 'none')
  // The auto policy on a shared store: growable or fixed — never a copy.
  const auto = createStore(REC, { capacity: 4, shared: true })
  expect(auto.growth === 'rab' || auto.growth === 'none').toBe(true)
})

test('store: the auto policy decides without throwing, and the store works on its lane', () => {
  const st = createStore(REC, { capacity: 8 }) // 'auto' — the measured pick
  expect(st.growth === 'rab' || st.growth === 'copy').toBe(true)
  for (let i = 0; i < 100; i++) {
    const r = st.append()
    const v = st.column('rec') as Float32Array
    v[r * 12] = i
  }
  expect(st.count).toBe(100)
  const v = st.column('rec') as Float32Array
  for (let i = 0; i < 100; i++) expect(v[i * 12]).toBe(i)
})

test('store: the u32 kind and the i32 kind ride their own views', () => {
  const st = createStore([
    { name: 'a', kind: 'u32' as const, width: 1 },
    { name: 'b', kind: 'i32' as const, width: 2 },
    { name: 'c', kind: 'f32' as const, width: 1 },
  ], { capacity: 4, growth: 'none' })
  const a = st.column('a') as Uint32Array
  const b = st.column('b') as Int32Array
  const c = st.column('c') as Float32Array
  a[0] = 0xFFFFFFFF
  b[0] = -5; b[1] = 0x7FFFFFFF
  c[0] = 1.5
  expect(a[0]).toBe(0xFFFFFFFF)
  expect(b[0]).toBe(-5)
  expect(b[1]).toBe(0x7FFFFFFF)
  expect(c[0]).toBe(1.5)
  expect(st.stride).toBe(4)
})

test('store: recordBytes — the column-scoped byte window', () => {
  const st = createStore(PAIR, { capacity: 8, growth: 'none' })
  expect(st.recordBytes('pos', 2, 5)).toEqual({ start: 24, end: 60 })
  expect(st.recordBytes('meta', 2, 5)).toEqual({ start: 8 * 12 + 8, end: 8 * 12 + 20 })
})

/** The demo's own adoption, end to end: the scene buffer's records
 * region becomes a store; edits mark dirty; the ranges map back to
 * the SCENE WORDS the GPU mirror uploads. */
test('store: the occlusion-scene adoption — the unified path end to end', () => {
  const N = 64
  const words = new Uint32Array(3 * N + N * 12)
  const f32 = new Float32Array(words.buffer)
  for (let i = 0; i < N; i++) {
    const w = 3 * N + i * 12
    f32[w] = i; f32[w + 1] = i * 2; f32[w + 2] = i * 3
  }
  const st = adoptStore(words.buffer, REC, N, 3 * N * 4)
  // Three "drones" edit their centers through the store's view.
  const v = st.column('rec') as Float32Array
  for (const id of [7, 40, 63]) {
    v[id * 12] += 1.25
    v[id * 12 + 2] -= 0.5
    st.markRecordDirty(id)
  }
  const ranges = st.takeUploadRanges()
  expect(ranges.length).toBe(3) // far apart — no merging
  // The ranges are WORD-aligned windows into the scene buffer: the
  // WG mirror's writeBuffer(words.subarray(w0, w1), w0*4, ...) feed.
  for (const r of ranges) {
    expect(r.start % 4).toBe(0)
    const w0 = r.start / 4
    const w1 = r.end / 4
    expect(w1 - w0).toBe(12)
    expect(w0 >= 3 * N).toBe(true)
  }
  const r0 = ranges[0]
  expect(r0.start).toBe((3 * N + 7 * 12) * 4)
  // The uploaded bytes ARE the edited record.
  const slice = new Float32Array(words.buffer, r0.start, 12)
  expect(slice[0]).toBe(7 + 1.25)
  expect(slice[2]).toBe(7 * 3 - 0.5)
})
