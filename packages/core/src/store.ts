/**
 * store.ts — THE UNIFIED DATA SURFACE (Task 211).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY HERE: Task 210 measured the CPU's array laws to the metal (105
 * checksum-gated variants × node V8 / bun JSC / headless Chromium —
 * docs/graphics-research-208.md, «Task 210 — the array round»):
 *
 *   · SoA reads beat object arrays 2–8× on the demo's own shapes;
 *   · a pre-packed bitset word-walk beats the plain-array push 15–22× on
 *     sparse survivor sets (and LOSES above ~10% density — the honest
 *     crossover the scene's collect has measured since Task 85);
 *   · set()/copyWithin() sit at memcpy/memset class — bulk record moves
 *     are ONE call, never per-element loops;
 *   · a resizable ArrayBuffer's growth ladder is a 43× in-place VA
 *     remap on V8 — and a LOSS on JSC, which copies;
 *   · typed sort() without a comparator keeps its crown (a comparator
 *     costs 4.4×); packed u32 keys (bucket<<bits | index) make the
 *     order a pure integer property.
 *
 * Task 211 is those laws APPLIED AS A SYSTEM, not as one-off patches:
 * one schema, one backing buffer, typed views for the CPU hot paths,
 * dirty byte-ranges for the GPU. A scenario declares its columns once
 * and gets the measured shapes for free — the same data feeds the CPU
 * walks (octree builds, software occlusion, picking) and the GPU
 * mirrors (writeBuffer / bufferSubData over the SAME bytes, zero
 * staging copies).
 *
 * THE SCENE BUFFER IS THE OLDEST SIBLING: packages/scene's layout.ts
 * hand-rolls exactly this shape (one (S)AB, SoA views by slot, the
 * H_CLOCK stamp, double bitsets). `adoptStore` is buildSceneViews
 * generalized — the demo's occlusion scene [list|flags|hist|records]
 * buffer becomes a store over its records region WITHOUT moving a
 * byte, and the record edits flow to both GPU backends as dirty
 * ranges. New scenarios start from createStore; old buffers ride
 * adoptStore.
 *
 * THE GPU CONTRACT (both backends, one vocabulary):
 *   · every column starts at a 4-byte-aligned offset (elements are 4
 *     bytes — true by construction, no alignment shims needed);
 *   · `takeUploadRanges()` returns COALESCED buffer-relative byte
 *     ranges, ascending, ready for WebGPU's
 *     `queue.writeBuffer(dst, start, buffer, start, end-start)` (the
 *     5-arg ArrayBuffer form — no subarray views, no copies) and for
 *     WebGL2's `gl.bufferSubData(target, start, new Uint8Array(buffer,
 *     start, end-start))` alike;
 *   · records merge into one range when their ids sit within
 *     MERGE_GAP records of each other (8 by default — a run of
 *     neighbors is one upload; scattered edits stay separate, never
 *     rounding up to pay for clean bytes).
 *
 * THE VIEW LAW (the scene package's precedent, restated): column
 * views are valid until the next `reserve()` that reallocates. The
 * store's `epoch` counter bumps on every realloc — cheap consumers
 * compare it and re-fetch; structural edits go through the store's
 * own ops (append/copyRecords/swapRemove), which always use the
 * CURRENT views. Adopted stores are FIXED-CAPACITY (`growth: 'none'`)
 * — the adopted buffer's layout belongs to its owner; reserve()
 * refuses loudly instead of silently detaching everyone.
 *
 * WHAT THIS IS NOT: not an ECS, not a query planner. It is the
 * DATA layer — columns, growth, bitsets, keys, dirt. The consumers
 * (the spatial kit, the culling kit, the tiers) keep their own
 * arithmetic; this file never touches a plane, a matrix or a shader.
 * ══════════════════════════════════════════════════════════════════════════
 */

// ─── the schema ───────────────────────────────────────────────────────────

/** The element kind of a column (all 4-byte — the alignment law). */
export type StoreKind = 'f32' | 'i32' | 'u32'

/** One SoA column: `width` elements per record (width > 1 = a strided
 * block inside the column — the scene's 12-word records, a 16-float
 * matrix pool). Columns are laid out back to back, in declaration
 * order; the record stride (elements) is the sum of the widths. */
export interface StoreColumn {
  readonly name: string
  readonly kind: StoreKind
  readonly width: number
}

/** A coalesced byte range within the store's backing buffer (both
 * ends 4-aligned by construction — the upload contract). */
export interface UploadRange {
  readonly start: number
  readonly end: number
}

/** The growth policy. 'auto' (the default) MEASURES once per process:
 * the Task-210 RAB law is empirical (V8 remaps in place, JSC copies),
 * so a ~2–5ms ladder probe — RAB resize ×2 steps vs alloc+set twins,
 * measure-many timed — decides, and the verdict is cached. 'rab' /
 * 'copy' force a lane (tests, A/B diagnostics); 'none' is the
 * fixed-capacity contract (adopted stores). A SHARED store grows
 * in place (a growable SAB) or not at all — a reallocated SAB would
 * silently strand every other thread's views, so the copy lane
 * REFUSES shared buffers up front. */
export type GrowthPolicy = 'auto' | 'rab' | 'copy' | 'none'

export interface StoreOptions {
  /** Initial record capacity (default 1024). */
  readonly capacity?: number
  /** Back the store with a SharedArrayBuffer (worker handoff). */
  readonly shared?: boolean
  /** The growth policy (default 'auto' — the measured pick). */
  readonly growth?: GrowthPolicy
}

// ─── the auto policy probe (once per process — measured, not sniffed) ─────

let autoPolicy: 'rab' | 'copy' | null = null

/** The clock — performance.now when it exists (node, bun, browsers,
 * workers), Date.now otherwise. */
function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now()
  return Date.now()
}

/** The ladder probe: grow a small buffer ×2 up to 4MB, both lanes,
 * MEASURE-MANY timed (run the ladder until the clock moves, then
 * divide — the Task-210 Chromium lesson: one fast call can read as
 * zero on a coarsened 100µs clock, and a naive target/dt calibration
 * explodes to its iteration cap). Returns ms per ladder. */
function ladderMs(make: () => void, grow: (bytes: number) => void): number {
  // Warm-up (JIT + allocator): two full ladders before timing.
  for (let w = 0; w < 2; w++) {
    make()
    let bytes = 4096
    for (let s = 0; s < 10; s++) {
      bytes *= 2
      grow(bytes)
    }
  }
  const t0 = nowMs()
  let runs = 0
  for (;;) {
    make()
    let bytes = 4096
    for (let s = 0; s < 10; s++) {
      bytes *= 2
      grow(bytes)
    }
    runs++
    if (nowMs() - t0 >= 1.5 || runs >= 500) break
  }
  return (nowMs() - t0) / Math.max(1, runs)
}

/** True when a growable SharedArrayBuffer works HERE (the feature +
 * the semantics, probed — not assumed from a UA string). */
function growableSab(): boolean {
  try {
    const probe = new SharedArrayBuffer(16, { maxByteLength: 64 })
    probe.grow(32)
    return probe.byteLength === 32
  } catch {
    return false
  }
}

/** Picks the auto lane once per process. Feature gates first (no
 * resize → 'copy'; shared without growable SABs → 'none'); then the
 * measured ladder: RAB must win by a real margin (1.5×) — a tie goes
 * to the copy lane (the universally sound twin, and what JSC's RAB
 * does internally anyway). */
function detectAutoPolicy(shared: boolean): 'rab' | 'copy' | 'none' {
  if (shared) return growableSab() ? 'rab' : 'none'
  if (typeof ArrayBuffer.prototype.resize !== 'function') return 'copy'
  if (autoPolicy !== null) return autoPolicy
  let rab: ArrayBuffer | null = null
  const rabMs = ladderMs(
    () => { rab = new ArrayBuffer(4096, { maxByteLength: 1 << 26 }) },
    bytes => { rab!.resize(bytes) },
  )
  let view: Uint8Array | null = null
  const copyMs = ladderMs(
    () => { view = new Uint8Array(new ArrayBuffer(4096)) },
    bytes => {
      const next = new Uint8Array(new ArrayBuffer(bytes))
      next.set(view!)
      view = next
    },
  )
  autoPolicy = rabMs * 1.5 <= copyMs ? 'rab' : 'copy'
  return autoPolicy
}

// ─── the store ────────────────────────────────────────────────────────────

/** All kinds are 4-byte — the column/record alignment law. */
const KIND_BYTES = 4

/** The RAB ladder's VA ceiling: generous (16× the start, ≥ 64MB, ≤
 * 1GB) so the common growth stays IN PLACE — V8 reserves the range
 * up front and the remap is pointer arithmetic (the 43× law's whole
 * point). A constrained environment that refuses the reservation
 * falls back to the copy lane honestly. */
function rabMaxBytes(bytes: number): number {
  return Math.min(1 << 30, Math.max(1 << 26, bytes * 16))
}

function makeView(buffer: ArrayBufferLike, kind: StoreKind, byteOffset: number, length: number):
  Float32Array | Int32Array | Uint32Array {
  if (kind === 'f32') return new Float32Array(buffer, byteOffset, length)
  if (kind === 'i32') return new Int32Array(buffer, byteOffset, length)
  return new Uint32Array(buffer, byteOffset, length)
}

/** The unified SoA store: schema-driven columns over ONE backing
 * buffer, record ops on the measured fast paths, and the dirty-range
 * surface the GPU mirrors read. See the module header for the laws
 * and the view-revalidate rule. */
export interface SoAStore {
  /** The backing buffer (an ArrayBuffer, a resizable ArrayBuffer or a
   * SharedArrayBuffer — adopt and growth decide; the views ride it). */
  readonly buffer: ArrayBufferLike
  /** The record capacity (elements the buffer can hold). */
  readonly capacity: number
  /** The live record count (append grows it, swapRemove shrinks it). */
  readonly count: number
  /** The resolved growth policy ('auto' is already decided). */
  readonly growth: 'rab' | 'copy' | 'none'
  /** Bumps on every view-invalidating realloc — consumers compare it
   * to know their column views need a re-fetch. */
  readonly epoch: number
  /** The monotonic mutation stamp (the scene's H_CLOCK discipline:
   * structural ops bump it; consumers memo against it). */
  readonly clock: number
  /** Elements per record — the sum of the column widths. */
  readonly stride: number

  /** The column's CURRENT view (re-fetch after a reserve that grew).
   * The view covers the full capacity — [i*width, (i+1)*width) is
   * record i's slice of the column. */
  column(name: string): Float32Array | Int32Array | Uint32Array
  /** The column's byte range within the backing buffer (4-aligned). */
  columnBytes(name: string): UploadRange
  /** The byte range of records [i0, i1) of ONE column (4-aligned). */
  recordBytes(name: string, i0: number, i1: number): UploadRange

  /** Grows the capacity to ≥ n records (a no-op when it already
   * fits). 'none' refuses over capacity; 'copy' reallocates (the
   * epoch bumps — re-fetch views); 'rab' resizes in place on V8 (the
   * 43× law) and rebuilds the views (the bytes never move) — and
   * when the VA ceiling runs out, ONE copy to a bigger ceiling. */
  reserve(n: number): void
  /** Sets the live count (grows the capacity when needed). New records
   * are NOT initialized — zero-fill is the caller's choice (fill()
   * through the views is memset-class). */
  resize(n: number): void
  /** Appends one record slot and returns its index (capacity grows on
   * demand — the ladder). */
  append(): number
  /** Bulk record copy — ONE set() per column (the memcpy-class law;
   * overlap is safe — the spec mandates memmove semantics), never a
   * per-element loop. */
  copyRecords(dst: number, src: number, n: number): void
  /** O(1) dense delete: record `count-1` moves into slot i, the count
   * shrinks. ORDER IS NOT PRESERVED — the dense-set contract (the
   * compaction direction, not the stable-queue direction). */
  swapRemove(i: number): void

  /** Marks one record dirty (all of its columns). */
  markRecordDirty(i: number): void
  /** Marks records [i0, i1) dirty. */
  markRecordsDirty(i0: number, i1: number): void
  /** Marks every record dirty (the full re-upload leg). */
  touchAll(): void
  /** The coalesced, ascending, 4-aligned byte ranges of the dirty
  * records (buffer-relative — feed them straight to the backend's
  * partial upload). Non-destructive: clearDirty() retires the set. */
  takeUploadRanges(): UploadRange[]
  /** Retires the dirty set (call after the upload lands). */
  clearDirty(): void
  /** The dirty records' byte total BEFORE coalescing (the honest
   * diagnostics number — the HUD line). */
  readonly dirtyBytes: number
  /** The number of dirty records. */
  readonly dirtyCount: number

  /** Manual clock bump (the consumer-owned stamp discipline). */
  bump(): void
}

interface StoreInternals {
  readonly columns: readonly StoreColumn[]
  capacity: number
  count: number
  growth: 'rab' | 'copy' | 'none'
  epoch: number
  clock: number
  buffer: ArrayBufferLike
  views: Map<string, Float32Array | Int32Array | Uint32Array>
  offsets: Map<string, number> // byte offset per column
  dirty: MarkSet
  dirtyBytes: number
  shared: boolean
}

function strideOf(columns: readonly StoreColumn[]): number {
  let s = 0
  for (const c of columns) s += c.width
  return s
}

/** (Re)builds every column view over the current buffer + bumps the
 * epoch (the view law's signal). */
function rebuildViews(st: StoreInternals): void {
  st.views = new Map()
  st.offsets = new Map()
  let byte = 0
  for (const c of st.columns) {
    st.offsets.set(c.name, byte)
    st.views.set(c.name, makeView(st.buffer, c.kind, byte, c.width * st.capacity))
    byte += c.width * st.capacity * KIND_BYTES
  }
  st.epoch++
}

/** The rab lane's in-place step; false when the VA ceiling ran out
 * (the caller falls to one copy into a bigger ceiling). */
function tryGrowInPlace(st: StoreInternals, targetBytes: number): boolean {
  if (st.shared) {
    const sab = st.buffer as SharedArrayBuffer
    if (targetBytes > (sab.growable ? sab.maxByteLength : sab.byteLength)) return false
    sab.grow(targetBytes)
    return true
  }
  const ab = st.buffer as ArrayBuffer
  if (!ab.resizable || targetBytes > ab.maxByteLength) return false
  ab.resize(targetBytes)
  return true
}

/** The copy lane: a fresh buffer + ONE set() per column (memcpy
 * class), then the view rebuild. Works for both plain and RAB
 * destinations (the destination's ceiling is `maxBytes | null`). */
function reallocate(st: StoreInternals, nextCapacity: number, maxBytes: number | null): void {
  const bytes = strideOf(st.columns) * nextCapacity * KIND_BYTES
  const next: ArrayBufferLike = st.shared
    ? (maxBytes !== null ? new SharedArrayBuffer(bytes, { maxByteLength: maxBytes }) : new SharedArrayBuffer(bytes))
    : (maxBytes !== null ? new ArrayBuffer(bytes, { maxByteLength: maxBytes }) : new ArrayBuffer(bytes))
  let byte = 0
  for (const c of st.columns) {
    const src = st.views.get(c.name)!
    const len = c.width * st.capacity
    const dst = makeView(next, c.kind, byte, c.width * nextCapacity)
    dst.set(src.subarray(0, len), 0)
    byte += c.width * nextCapacity * KIND_BYTES
  }
  st.buffer = next
  st.capacity = nextCapacity
  rebuildViews(st)
}

function reserveImpl(st: StoreInternals, n: number): void {
  const next = Math.max(n, st.capacity * 2, 16)
  const targetBytes = strideOf(st.columns) * next * KIND_BYTES
  if (st.growth === 'none') {
    throw new Error(`store: the fixed-capacity contract (${st.capacity} records) refuses ${n} — adopt a bigger buffer or declare a growth policy`)
  }
  if (st.growth === 'rab' && tryGrowInPlace(st, targetBytes)) {
    // The bytes never moved — only the views must cover the new
    // capacity, and the dirty set must SPAN it (the pending bits
    // survive: the record ids are stable across growth — the column
    // prefixes are preserved by construction).
    st.capacity = next
    st.dirty = createMarkSetFrom(st.dirty.words(), next)
    rebuildViews(st)
    return
  }
  // The copy lane (or the rab ceiling's one big step).
  const curBytes = strideOf(st.columns) * st.capacity * KIND_BYTES
  reallocate(st, next, st.growth === 'rab' ? Math.max(rabMaxBytes(curBytes), targetBytes) : null)
  st.dirty = createMarkSetFrom(st.dirty.words(), next)
}

function makeStore(st: StoreInternals): SoAStore {
  return {
    get buffer() { return st.buffer },
    get capacity() { return st.capacity },
    get count() { return st.count },
    get growth() { return st.growth },
    get epoch() { return st.epoch },
    get clock() { return st.clock },
    get stride() { return strideOf(st.columns) },
    get dirtyBytes() { return st.dirtyBytes },
    get dirtyCount() { return st.dirty.count() },
    column(name: string) {
      const v = st.views.get(name)
      if (v === undefined) {
        throw new Error(`store: no column '${name}' (declared: ${st.columns.map(c => c.name).join(', ')})`)
      }
      return v
    },
    columnBytes(name: string) {
      const off = st.offsets.get(name)
      if (off === undefined) throw new Error(`store: no column '${name}'`)
      const c = st.columns.find(x => x.name === name)!
      return { start: off, end: off + c.width * st.capacity * KIND_BYTES }
    },
    recordBytes(name: string, i0: number, i1: number) {
      const off = st.offsets.get(name)
      if (off === undefined) throw new Error(`store: no column '${name}'`)
      const c = st.columns.find(x => x.name === name)!
      const hi = Math.max(i0, i1)
      return { start: off + i0 * c.width * KIND_BYTES, end: off + hi * c.width * KIND_BYTES }
    },
    reserve(n: number) {
      if (n > st.capacity) {
        reserveImpl(st, n)
        st.clock++
      }
    },
    resize(n: number) {
      if (n > st.capacity) reserveImpl(st, n)
      if (n !== st.count) st.clock++
      st.count = n
    },
    append() {
      if (st.count >= st.capacity) reserveImpl(st, st.count + 1)
      const i = st.count
      st.count = i + 1
      st.clock++
      return i
    },
    copyRecords(dst: number, src: number, n: number) {
      if (n <= 0 || dst === src) return
      if (dst < 0 || src < 0 || Math.max(dst, src) + n > st.count) {
        throw new Error(`store: copyRecords(dst=${dst}, src=${src}, n=${n}) outruns the live count ${st.count}`)
      }
      for (const c of st.columns) {
        const v = st.views.get(c.name)!
        const w = c.width
        v.set(v.subarray(src * w, (src + n) * w), dst * w)
      }
      st.clock++
    },
    swapRemove(i: number) {
      if (i < 0 || i >= st.count) throw new Error(`store: swapRemove(${i}) — not a live record (${st.count} live)`)
      const last = st.count - 1
      if (i !== last) {
        for (const c of st.columns) {
          const v = st.views.get(c.name)!
          const w = c.width
          v.set(v.subarray(last * w, (last + 1) * w), i * w)
        }
      }
      st.count = last
      st.clock++
    },
    markRecordDirty(i: number) {
      if (i < 0 || i >= st.count) return
      if (st.dirty.add(i)) st.dirtyBytes += strideOf(st.columns) * KIND_BYTES
    },
    markRecordsDirty(i0: number, i1: number) {
      const lo = Math.max(0, i0)
      const hi = Math.min(st.count, i1)
      const per = strideOf(st.columns) * KIND_BYTES
      for (let i = lo; i < hi; i++) {
        if (st.dirty.add(i)) st.dirtyBytes += per
      }
    },
    touchAll() {
      st.dirtyBytes = 0
      st.dirty.clearAll()
      const per = strideOf(st.columns) * KIND_BYTES
      for (let i = 0; i < st.count; i++) {
        if (st.dirty.add(i)) st.dirtyBytes += per
      }
    },
    takeUploadRanges() {
      return takeRangesImpl(st)
    },
    clearDirty() {
      st.dirty.clearAll()
      st.dirtyBytes = 0
    },
    bump() {
      st.clock++
    },
  }
}

/** The dirty→ranges expansion: the ascending record walk (the bitset's
 * own order) merges runs whose gap ≤ MERGE_GAP records, one range per
 * column per run. With one column (the common record-region adoption)
 * a run is ONE contiguous byte range. */
const MERGE_GAP = 8

function takeRangesImpl(st: StoreInternals): UploadRange[] {
  const out: UploadRange[] = []
  if (strideOf(st.columns) === 0 || st.dirty.count() === 0) return out
  const emit = (i0: number, i1: number): void => {
    for (const c of st.columns) {
      const off = st.offsets.get(c.name)!
      out.push({ start: off + i0 * c.width * KIND_BYTES, end: off + i1 * c.width * KIND_BYTES })
    }
  }
  let runStart = -1
  let runEnd = -1
  st.dirty.forEachSparse(i => {
    if (runStart < 0) {
      runStart = i
      runEnd = i + 1
      return
    }
    if (i - runEnd <= MERGE_GAP) {
      runEnd = i + 1
      return
    }
    emit(runStart, runEnd)
    runStart = i
    runEnd = i + 1
  })
  if (runStart >= 0) emit(runStart, runEnd)
  return out
}

function validateColumns(columns: readonly StoreColumn[]): void {
  if (columns.length === 0) throw new Error('store: no columns declared')
  const seen = new Set<string>()
  for (const c of columns) {
    if (c.width < 1) throw new Error(`store: column '${c.name}' — width must be ≥ 1`)
    if (seen.has(c.name)) throw new Error(`store: duplicate column '${c.name}'`)
    seen.add(c.name)
  }
}

/** Creates a store over a FRESH backing buffer. The RAB lane starts
 * with a generous VA ceiling (see rabMaxBytes) so the common growth
 * stays in place; an environment that refuses the reservation falls
 * back to the copy lane HONESTLY (the growth field reports it). */
export function createStore(columns: readonly StoreColumn[], options: StoreOptions = {}): SoAStore {
  validateColumns(columns)
  const shared = options.shared === true
  let growth: 'rab' | 'copy' | 'none'
  if (options.growth === undefined || options.growth === 'auto') {
    growth = detectAutoPolicy(shared)
  } else {
    growth = options.growth
  }
  if (shared && growth === 'copy') {
    throw new Error('store: a shared store refuses the copy lane — a reallocated SAB strands every other thread\'s views (grow in place or stay fixed)')
  }
  if (shared && growth === 'rab' && !growableSab()) {
    // The honest downgrade: no growable SABs HERE means no sound
    // shared growth at all (see the copy-lane refusal above).
    growth = 'none'
  }
  const capacity = Math.max(1, options.capacity ?? 1024)
  const bytes = strideOf(columns) * capacity * KIND_BYTES
  const st: StoreInternals = {
    columns,
    capacity,
    count: 0,
    growth,
    epoch: 0,
    clock: 0,
    buffer: shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes),
    views: new Map(),
    offsets: new Map(),
    dirty: createMarkSet(capacity),
    dirtyBytes: 0,
    shared,
  }
  if (growth === 'rab') {
    // The VA-ceiled start: RAB (plain) or gSAB (shared), with the
    // honest fallback when the reservation is refused.
    const max = rabMaxBytes(bytes)
    try {
      st.buffer = shared
        ? new SharedArrayBuffer(bytes, { maxByteLength: max })
        : new ArrayBuffer(bytes, { maxByteLength: max })
    } catch {
      st.growth = 'copy'
      st.buffer = shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes)
    }
  }
  rebuildViews(st)
  return makeStore(st)
}

/** Adopts an EXISTING buffer as the store's backing — the scene-buffer
 * pattern generalized (zero copies: the views ride the caller's
 * bytes). `byteOffset` places the store's region inside a larger
 * buffer (the occlusion scene's records region behind [list|flags|
 * hist]); `count` is the live record count. The store is
 * FIXED-CAPACITY: reserve() over capacity refuses loudly — the
 * buffer's layout belongs to its owner. */
export function adoptStore(
  buffer: ArrayBufferLike,
  columns: readonly StoreColumn[],
  count: number,
  byteOffset = 0,
): SoAStore {
  validateColumns(columns)
  const stride = strideOf(columns)
  const capacity = ((buffer.byteLength - byteOffset) / (stride * KIND_BYTES)) | 0
  if (capacity < 1 || byteOffset + capacity * stride * KIND_BYTES > buffer.byteLength) {
    throw new Error(`store: the buffer (${buffer.byteLength}B @${byteOffset}) cannot hold one ${stride}-element record`)
  }
  if (count < 0 || count > capacity) {
    throw new Error(`store: count ${count} outruns the adopted capacity ${capacity}`)
  }
  const st: StoreInternals = {
    columns,
    capacity,
    count,
    growth: 'none',
    epoch: 0,
    clock: 0,
    buffer,
    views: new Map(),
    offsets: new Map(),
    dirty: createMarkSet(capacity),
    dirtyBytes: 0,
    shared: typeof SharedArrayBuffer !== 'undefined' && buffer instanceof SharedArrayBuffer,
  }
  let byte = byteOffset
  for (const c of columns) {
    st.offsets.set(c.name, byte)
    st.views.set(c.name, makeView(buffer, c.kind, byte, c.width * capacity))
    byte += c.width * capacity * KIND_BYTES
  }
  st.epoch++
  return makeStore(st)
}

// ─── MarkSet — the bitset companion (both iteration modes) ────────────────

/** The mark set: one bit per index over ONE Uint32Array (the scene's
 * double-bitset shape, standalone). THE CROSSOVER IS REAL and
 * measured twice: the word-walk (ctz extraction) wins 15–22× on
 * sparse sets (Task 210, group E — the survivor-compaction shape),
 * and LOSES on the scene's real 40–70% visibility (Task 85's
 * micro-collect) — `forEach` picks by density with the 12.5%
 * threshold, and both orders are public so a hot consumer can pin
 * its own lane (the scene's collect keeps its rank loop). */
export interface MarkSet {
  readonly capacity: number
  /** Sets bit i. Returns true when the bit was clean (the caller's
   * counters — the store's dirtyBytes discipline). */
  add(i: number): boolean
  /** Clears bit i. Returns true when the bit was set. */
  remove(i: number): boolean
  has(i: number): boolean
  clearAll(): void
  count(): number
  /** The set bits / capacity ratio — the crossover input. */
  density(): number
  /** The sparse walk: ascending, ctz-extracted, zero words skipped
   * whole. THE lane under ~12.5% density. */
  forEachSparse(cb: (i: number) => void): void
  /** The dense walk: ascending rank scan, one bit test per index, no
   * extraction arithmetic. THE lane at high density (the scene's own
   * measurement: 40–70% visibility beats the walk). */
  forEachDense(cb: (i: number) => void): void
  /** Density-picked (the 12.5% crossover — see the interface doc). */
  forEach(cb: (i: number) => void): void
  /** The raw words — composition with bitsBase-style bases (the
   * scene's double bitsets, the flip-diff walks). */
  words(): Uint32Array
}

/** Creates a mark set over `capacity` bits (a fresh Uint32Array). */
export function createMarkSet(capacity: number): MarkSet {
  const cap = Math.max(1, capacity | 0)
  const bits = new Uint32Array((cap + 31) >> 5)
  return makeMarkSet(cap, bits)
}

/** Adopts existing bit WORDS as a mark set (the growth path — the
 * low words carry over verbatim, ids are stable; the live count is
 * recomputed by SWAR popcount, once, at growth time). */
export function createMarkSetFrom(words: Uint32Array, capacity: number): MarkSet {
  const cap = Math.max(1, capacity | 0)
  const need = (cap + 31) >> 5
  const bits = new Uint32Array(need)
  bits.set(words.subarray(0, Math.min(need, words.length)))
  return makeMarkSet(cap, bits)
}

function makeMarkSet(cap: number, bits: Uint32Array): MarkSet {
  let live = 0
  for (let w = 0; w < bits.length; w++) {
    let v = bits[w]
    if (v === 0) continue
    v = v - ((v >>> 1) & 0x55555555)
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
    v = (v + (v >>> 4)) & 0x0f0f0f0f
    live += (v * 0x01010101) >>> 24
  }
  return {
    get capacity() { return cap },
    add(i: number) {
      if (i < 0 || i >= cap) return false
      const w = i >>> 5
      const m = 1 << (i & 31)
      if ((bits[w] & m) !== 0) return false
      bits[w] |= m
      live++
      return true
    },
    remove(i: number) {
      if (i < 0 || i >= cap) return false
      const w = i >>> 5
      const m = 1 << (i & 31)
      if ((bits[w] & m) === 0) return false
      bits[w] &= ~m
      live--
      return true
    },
    has(i: number) {
      if (i < 0 || i >= cap) return false
      return (bits[i >>> 5] & (1 << (i & 31))) !== 0
    },
    clearAll() {
      bits.fill(0)
      live = 0
    },
    count() { return live },
    density() { return live / cap },
    forEachSparse(cb: (i: number) => void) {
      const words = bits.length
      for (let w = 0; w < words; w++) {
        let word = bits[w]
        if (word === 0) continue
        const base = w << 5
        while (word !== 0) {
          const lb = word & -word
          word ^= lb
          const i = base + 31 - Math.clz32(lb)
          if (i < cap) cb(i)
        }
      }
    },
    forEachDense(cb: (i: number) => void) {
      for (let i = 0; i < cap; i++) {
        if ((bits[i >>> 5] & (1 << (i & 31))) !== 0) cb(i)
      }
    },
    forEach(cb: (i: number) => void) {
      if (live * 8 < cap) this.forEachSparse(cb)
      else this.forEachDense(cb)
    },
    words() { return bits },
  }
}

// ─── packed keys — the comparator-free order ──────────────────────────────

/** Packs (hi, lo) into one u32 with `loBits` low bits for lo — the
 * Task-209 verdict-word shape (the NDC-z bucket in the spare bits)
 * and Task-210's group-F sort keys generalized. `keys.sort()` then
 * orders by (hi, lo) with NO comparator (the 4.4× law) — as long as
 * lo < 2^loBits and hi < 2^(32-loBits), which this asserts. */
export function packKey(hi: number, lo: number, loBits: number): number {
  if (!Number.isInteger(loBits) || loBits < 0 || loBits > 32) {
    throw new Error(`store: packKey — loBits must be an integer 0..32, got ${loBits}`)
  }
  if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
    throw new Error(`store: packKey — hi and lo must be integers (${hi}, ${lo})`)
  }
  if (loBits === 0) return hi >>> 0
  const loMask = loBits === 32 ? -1 : (1 << loBits) - 1
  if ((lo & ~loMask) !== 0) throw new Error(`store: packKey — lo ${lo} does not fit ${loBits} bits`)
  if (loBits < 32 && (hi < 0 || hi > (-1 >>> loBits))) {
    throw new Error(`store: packKey — hi ${hi} does not fit ${32 - loBits} bits`)
  }
  return ((hi << loBits) | (lo & loMask)) >>> 0
}

/** The hi half of a packed key (the bucket). */
export function unpackKeyHi(key: number, loBits: number): number {
  return loBits === 0 ? key >>> 0 : key >>> loBits
}

/** The lo half of a packed key (the index). */
export function unpackKeyLo(key: number, loBits: number): number {
  if (loBits === 0) return 0
  return loBits === 32 ? key >>> 0 : key & ((1 << loBits) - 1)
}
