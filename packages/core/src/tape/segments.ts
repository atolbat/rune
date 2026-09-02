// Segment cache: a command's recorded operations live until its invalidation.
// A clean frame = cache replay without recomputation (no math and no
// uniform function calls) — the performance heart of live commands.

export interface Segment {
  /** Operations [op, a, b, c, d] × count. */
  readonly rows: Int32Array
  readonly count: number
  /** Epoch of the last write — age diagnostics. */
  writtenAt: number
}

export interface SegmentStore {
  fetch(commandId: number): Segment | undefined
  store(commandId: number, rows: Int32Array, count: number): void
  invalidate(commandId: number): void
  readonly hits: number
  readonly misses: number
  /** Segments evicted over capacity (LRU) — "cache is small" diagnostics. */
  readonly evictions: number
}

/** LRU segment cache: Map order = recency (the end is the freshest). */
export function createSegmentStore(capacity: number): SegmentStore {
  const segments = new Map<number, Segment>()
  let hits = 0
  let misses = 0
  let evictions = 0
  let writeEpoch = 0

  function fetch(commandId: number): Segment | undefined {
    const found = segments.get(commandId)
    if (found === undefined) {
      misses++
      return undefined
    }
    hits++
    // LRU: the end of the Map becomes the fresh one — delete+set moves the position.
    segments.delete(commandId)
    segments.set(commandId, found)
    return found
  }

  function store(commandId: number, rows: Int32Array, count: number): void {
    segments.delete(commandId)
    segments.set(commandId, { rows, count, writtenAt: ++writeEpoch })
    evict()
  }

  function invalidate(commandId: number): void {
    segments.delete(commandId)
  }

  /** Eviction over capacity (capacity < 1 — no limit: eviction is disabled). */
  function evict(): void {
    if (capacity < 1) return
    while (segments.size > capacity) {
      const oldest = segments.keys().next().value
      if (oldest === undefined) break
      segments.delete(oldest)
      evictions++
    }
  }

  return {
    fetch,
    store,
    invalidate,
    get hits() { return hits },
    get misses() { return misses },
    get evictions() { return evictions },
  }
}
