// Сегментный кэш: записанные операции команды живут до её инвалидации.
// Чистый кадр = реплей кэша без повторного вычисления (без математики и
// вызовов юниформ-функций) — сердце производительности live-команд.

export interface Segment {
  /** Операции [op, a, b, c, d] × count. */
  readonly rows: Int32Array
  readonly count: number
  /** Эпоха последней записи — диагностика возраста. */
  writtenAt: number
}

export interface SegmentStore {
  fetch(commandId: number): Segment | undefined
  store(commandId: number, rows: Int32Array, count: number): void
  invalidate(commandId: number): void
  readonly hits: number
  readonly misses: number
  /** Вытеснено сегментов сверх capacity (LRU) — диагностика «кэш мал». */
  readonly evictions: number
}

/** LRU-кэш сегментов: порядок Map = недавность (конец — самый свежий). */
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
    // LRU: свежим становится конец Map — delete+set двигает позицию.
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

  /** Вытеснение сверх capacity (capacity < 1 — без лимита: вытеснение выключено). */
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
