// Segment cache: a command's recorded operations live until its invalidation.
// A clean frame = cache replay without recomputation (no math and no
// uniform function calls) — the performance heart of live commands.

export interface Segment {
  /** Operations [op, a, b, c, d] × count. */
  readonly rows: Int32Array
  readonly count: number
  /** Epoch of the last write — age diagnostics. */
  writtenAt: number
  /** Epoch of the last touch (store or fetch) — recency for LRU eviction. */
  touchedAt: number
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

/** LRU segment cache. Recency — O(1) epoch touches (no Map reordering on
 *  fetch: a replay of 1000 segments must not churn ~2000 Map operations per
 *  frame); eviction scans for the minimal epoch — a rare path that only runs
 *  when the store grows over capacity. */
export function createSegmentStore(capacity: number): SegmentStore {
  const segments = new Map<number, Segment>()
  let hits = 0
  let misses = 0
  let evictions = 0
  let epoch = 0

  function fetch(commandId: number): Segment | undefined {
    const found = segments.get(commandId)
    if (found === undefined) {
      misses++
      return undefined
    }
    hits++
    // LRU touch: an epoch write instead of delete+set Map reordering.
    found.touchedAt = ++epoch
    return found
  }

  function store(commandId: number, rows: Int32Array, count: number): void {
    segments.delete(commandId)
    segments.set(commandId, { rows, count, writtenAt: ++epoch, touchedAt: epoch })
    evict()
  }

  function invalidate(commandId: number): void {
    segments.delete(commandId)
  }

  /** Eviction over capacity (capacity < 1 — no limit: eviction is disabled).
 *  The victim is the entry with the minimal touch epoch; a store of an
 *  existing id does not grow the map, so the steady state never scans. */
  function evict(): void {
    if (capacity < 1) return
    while (segments.size > capacity) {
      let victimId: number | undefined
      let victimEpoch = Infinity
      for (const [id, segment] of segments) {
        if (segment.touchedAt < victimEpoch) {
          victimEpoch = segment.touchedAt
          victimId = id
        }
      }
      if (victimId === undefined) break
      segments.delete(victimId)
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
