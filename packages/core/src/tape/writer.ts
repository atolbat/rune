// Tape writer: five SoA columns (op + 4 payload slots), ×2 growth.

export interface WriterColumns {
  readonly op: Int32Array
  readonly a: Int32Array
  readonly b: Int32Array
  readonly c: Int32Array
  readonly d: Int32Array
}

export interface TapeWriter {
  reset(): void
  emit(op: number, a: number, b: number, c: number, d: number): void
  /** Bulk append of dense rows [op,a,b,c,d]×count (segment cache replay). */
  emitPacked(rows: Int32Array, count: number): void
  readonly count: number
  readonly columns: WriterColumns
}

export function createTapeWriter(initialOps: number): TapeWriter {
  let capacity = Math.max(16, initialOps)
  let op: Int32Array = new Int32Array(capacity)
  let a: Int32Array = new Int32Array(capacity)
  let b: Int32Array = new Int32Array(capacity)
  let c: Int32Array = new Int32Array(capacity)
  let d: Int32Array = new Int32Array(capacity)
  let count = 0

  function reset(): void {
    count = 0
  }

  function emit(code: number, pa: number, pb: number, pc: number, pd: number): void {
    if (count === capacity) grow()
    op[count] = code
    a[count] = pa
    b[count] = pb
    c[count] = pc
    d[count] = pd
    count++
  }

  function emitPacked(rows: Int32Array, packed: number): void {
    if (packed === 0) return
    while (count + packed > capacity) grow()
    // Columnar write: sequential writes into each column
    // (better locality than ping-ponging between five arrays).
    const base = count
    for (let at = 0; at < packed; at++) op[base + at] = rows[at * 5]
    for (let at = 0; at < packed; at++) a[base + at] = rows[at * 5 + 1]
    for (let at = 0; at < packed; at++) b[base + at] = rows[at * 5 + 2]
    for (let at = 0; at < packed; at++) c[base + at] = rows[at * 5 + 3]
    for (let at = 0; at < packed; at++) d[base + at] = rows[at * 5 + 4]
    count = base + packed
  }

  function grow(): void {
    capacity *= 2
    op = growColumn(op)
    a = growColumn(a)
    b = growColumn(b)
    c = growColumn(c)
    d = growColumn(d)
  }

  function growColumn(column: Int32Array): Int32Array {
    const next: Int32Array = new Int32Array(capacity)
    next.set(column)
    return next
  }

  return {
    reset,
    emit,
    emitPacked,
    get count() { return count },
    get columns() { return { op, a, b, c, d } },
  }
}
