// Live-команда: сегмент + dirty по зависимостям + every(n) амортизация.

import type { SegmentStore } from '../tape/segments.ts'
import type { TapeWriter } from '../tape/writer.ts'
import type { ReadableSignal } from '../signal/types.ts'

export interface LiveCommand {
  /** Идентификатор (индекс в реестре рендерера). */
  readonly id: number
  /** Темпоральная амортизация: эмит раз в n кадров (bloom/SSAO через кадр). */
  every(n: number): LiveCommand
  /** Тик кадра: фаза и активность. Вызывается сборщиком кадра. */
  tickFrame(): void
  /** Эмитится ли команда в текущем кадре. */
  readonly active: boolean
  /** Зависимости изменились с последней записи. */
  readonly dirty: boolean
  /** Записать в ленту (свежую или кэш-реплей). force=true — перезаписать
   *  сегмент заново (полный путь без кэша — бенчмарк «полной перезаписи»). */
  emit(writer: TapeWriter, force?: boolean): boolean
  /** Принудительная инвалидация кэша. */
  invalidate(): void
}

export interface LiveCommandOptions {
  readonly id?: number
  readonly deps?: readonly ReadableSignal[]
}

let nextLiveId = 1

export function createLiveCommand(
  segments: SegmentStore,
  record: (writer: TapeWriter) => void,
  deps: readonly ReadableSignal[] = [],
): LiveCommand {
  const id = nextLiveId++
  const versions = deps.map(() => -1)
  const scratch = createScratchWriter()
  let frameStride = 1
  let framePhase = 0
  let frameCounter = 0
  let active = true
  let dirty = true

  function every(n: number): LiveCommand {
    if (n < 1) throw new Error('rune: every(n) требует n >= 1')
    frameStride = n
    framePhase = frameCounter % n
    return command
  }

  function tickFrame(): void {
    frameCounter++
    active = frameCounter % frameStride === framePhase
    dirty = depsChanged()
  }

  function depsChanged(): boolean {
    for (let at = 0; at < deps.length; at++) {
      if (deps[at].version !== versions[at]) {
        versions[at] = deps[at].version
        dirty = true
      }
    }
    return dirty
  }

  function emit(writer: TapeWriter, force = false): boolean {
    if (!active) return false
    const cached = segments.fetch(id)
    if (!force && !dirty && cached !== undefined) {
      replay(writer, cached.rows, cached.count)
      return true
    }
    scratch.reset()
    record(scratch)
    const count = scratch.count
    const columns = scratch.columns
    const rows = packRows(columns, count)
    segments.store(id, rows, count)
    replay(writer, rows, count)
    dirty = false
    return true
  }

  function invalidate(): void {
    dirty = true
    segments.invalidate(id)
  }

  const command: LiveCommand = {
    id,
    every,
    tickFrame,
    get active() { return active },
    get dirty() { return dirty },
    emit,
    invalidate,
  }
  return command
}

/** Реплей упакованных строк в ленту (bulk — без поштучных emit-вызовов). */
function replay(writer: TapeWriter, rows: Int32Array, count: number): void {
  writer.emitPacked(rows, count)
}

/** Пакование колонок скретч-писателя в плотные строки. */
function packRows(columns: { op: Int32Array; a: Int32Array; b: Int32Array; c: Int32Array; d: Int32Array }, count: number): Int32Array {
  const rows = new Int32Array(count * 5)
  for (let at = 0; at < count; at++) {
    const base = at * 5
    rows[base] = columns.op[at]
    rows[base + 1] = columns.a[at]
    rows[base + 2] = columns.b[at]
    rows[base + 3] = columns.c[at]
    rows[base + 4] = columns.d[at]
  }
  return rows
}

/** Личный писатель команды — копия ленты только при перезаписи. */
function createScratchWriter(): TapeWriter & { columns: { op: Int32Array; a: Int32Array; b: Int32Array; c: Int32Array; d: Int32Array } } {
  const capacity = 64
  const op = new Int32Array(capacity)
  const a = new Int32Array(capacity)
  const b = new Int32Array(capacity)
  const c = new Int32Array(capacity)
  const d = new Int32Array(capacity)
  let count = 0
  return {
    reset: () => { count = 0 },
    emit: (code: number, pa: number, pb: number, pc: number, pd: number): void => {
      if (count >= capacity) return // перерост кэша: команда без сегмента
      op[count] = code
      a[count] = pa
      b[count] = pb
      c[count] = pc
      d[count] = pd
      count++
    },
    get count() { return count },
    get columns() { return { op, a, b, c, d } },
  } as never
}
