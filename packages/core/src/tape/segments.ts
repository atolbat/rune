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
}

export function createSegmentStore(_capacity: number): SegmentStore {
  const segments = new Map<number, Segment>()
  let hits = 0
  let misses = 0

  function fetch(commandId: number): Segment | undefined {
    const found = segments.get(commandId)
    if (found !== undefined) hits++
    else misses++
    return found
  }

  function store(commandId: number, rows: Int32Array, count: number): void {
    segments.set(commandId, { rows, count, writtenAt: 0 })
  }

  function invalidate(commandId: number): void {
    segments.delete(commandId)
  }

  return { fetch, store, invalidate, get hits() { return hits }, get misses() { return misses } }
}
