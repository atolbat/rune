/**
 * Seqlock over a SharedArrayBuffer.
 * A single writer; readers are lock-free, tearing is excluded.
 * The slot layout (where the version is, where the value is) is defined by
 * the calling code.
 *
 * The version is read/written via Atomics (SeqCst): the "odd version →
 * value → even version" order is not reordered by weak memory (ARM).
 * The value stays in a DataView — it needs no atomicity, the version
 * covers it. Reads are bounded by an attempt limit: a hung writer (a bug)
 * ends in an error, not an eternal spin.
 */

/** The result of a valid slot read. */
export interface SeqlockRead {
  readonly version: number
  readonly value: number
}

/** Read attempt limit: a live writer closes the slot in nanoseconds;
 *  65 536 retries is milliseconds of spinning — beyond that, a livelock is suspected. */
const MAX_READ_ATTEMPTS = 1 << 16

/** Cache of Int32Array views: the version must go through Atomics. */
const atomicsViews = new WeakMap<DataView, Int32Array>()

/** An Int32Array over the same buffer as the DataView (4-byte alignment). */
function atomicsView(data: DataView): Int32Array {
  let view = atomicsViews.get(data)
  if (view === undefined) {
    if (data.byteOffset % 4 !== 0 || data.byteLength % 4 !== 0) {
      throw new Error('rune: seqlock requires 4-byte buffer alignment')
    }
    view = new Int32Array(data.buffer, data.byteOffset, data.byteLength >> 2)
    atomicsViews.set(data, view)
  }
  return view
}

/** Version index in the Int32Array: the offset must be a multiple of 4. */
function versionIndex(versionAt: number): number {
  if ((versionAt & 3) !== 0) throw new Error('rune: seqlock version must lie on a 4-byte boundary')
  return versionAt >> 2
}

/** Reads the slot with validation: retry on an odd version and on a change during the read. */
export function readSeqlock(data: DataView, versionAt: number, valueAt: number): SeqlockRead {
  const i32 = atomicsView(data)
  const at = versionIndex(versionAt)
  for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt++) {
    const before = Atomics.load(i32, at)
    if ((before & 1) === 0) {
      const value = data.getFloat64(valueAt, true)
      const after = Atomics.load(i32, at)
      if (before === after) return { version: before, value }
    }
  }
  throw new Error('rune: seqlock did not close within the attempt limit — the writer holds the slot (livelock)')
}

/** Value-only read: the hot path (the mirror's .value/peek) — the retry loop
 *  needs no result object, so a stable read allocates nothing (Task 114). */
export function readSeqlockValue(data: DataView, versionAt: number, valueAt: number): number {
  const i32 = atomicsView(data)
  const at = versionIndex(versionAt)
  for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt++) {
    const before = Atomics.load(i32, at)
    if ((before & 1) === 0) {
      const value = data.getFloat64(valueAt, true)
      const after = Atomics.load(i32, at)
      if (before === after) return value
    }
  }
  throw new Error('rune: seqlock did not close within the attempt limit — the writer holds the slot (livelock)')
}

/** Writes the slot: version odd → value → version even. */
export function writeSeqlock(data: DataView, versionAt: number, valueAt: number, value: number): void {
  const i32 = atomicsView(data)
  const at = versionIndex(versionAt)
  const version = Atomics.load(i32, at)
  Atomics.store(i32, at, version + 1) // writer entry: odd
  data.setFloat64(valueAt, value, true)
  Atomics.store(i32, at, version + 2) // exit: even
}

/** Current slot version without reading the value. */
export function seqlockVersion(data: DataView, versionAt: number): number {
  return Atomics.load(atomicsView(data), versionIndex(versionAt))
}
