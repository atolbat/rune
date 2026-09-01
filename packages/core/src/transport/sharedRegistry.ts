import type { ReadableSignal, Subscriber, Unsubscribe } from '../signal/types.ts'
import { readSeqlock, writeSeqlock, seqlockVersion } from './seqlock.ts'

const VERSION_OFFSET = 4
const VALUE_OFFSET = 8

/** Слот реестра: nameHash + seqlock. */
const SLOT_BYTES = 16

/** Магический заголовок реестра общих сигналов. */
export const SHARED_MAGIC = 0x52554e53 // 'RUNS'

/** Реестр на стороне владельца: пишет, читатели семплируют. */
export interface SharedRegistry {
  readonly buffer: SharedArrayBuffer
  /** Связывает сигнал со слотом; записи утекают в SAB (владелец-писатель). */
  bind(signal: ReadableSignal<number>, name: string): Unsubscribe
  /** Пишет значение напрямую (сглаженные источники, тесты). */
  write(name: string, value: number): void
}

/** Зеркало реестра в другом мире: чтение seqlock, эпоховые уведомления. */
export interface SharedMirror {
  /** Сигнал-представление слота (чтение всегда свежее). */
  signal(name: string): ReadableSignal<number>
  /** Эпоха: уведомляет подписчиков изменившихся слотов; вернувшее — их число. */
  sampleAll(): number
  readonly transport: 'sab'
}

/** Хэш имени — ключ слота (FNV-1a, устойчив в обоих мирах). */
export function nameHash(name: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Схема-хэш: несовпадение layout ловится при привязке. */
export function schemaHash(names: readonly string[]): number {
  return nameHash(names.join('\u0000'))
}

/** Создаёт реестр на стороне владельца (T1/T2: SAB доступен). */
export function createSharedRegistry(names: readonly string[]): SharedRegistry {
  const view = new DataView(new SharedArrayBuffer(headerBytes() + names.length * SLOT_BYTES))
  putHeader(view, names)
  putSlots(view, names)
  const slots = indexSlots(view, names)
  return {
    buffer: view.buffer as SharedArrayBuffer,
    bind: (signal, name) => bindSignal(view, slots, signal, name),
    write: (name, value) => writeSlot(view, slots, name, value),
  }
}

function writeSlot(view: DataView, slots: Map<number, number>, name: string, value: number): void {
  const offset = requireSlot(slots, name)
  writeSeqlock(view, offset + VERSION_OFFSET, offset + VALUE_OFFSET, value)
}

/** Привязывается к реестру из любого мира (читатель). */
export function attachSharedRegistry(buffer: SharedArrayBuffer, names: readonly string[]): SharedMirror {
  const view = new DataView(buffer)
  checkSchema(view, names)
  const slots = indexSlots(view, names)
  const watchers = new Map<number, Subscriber<number>[]>()
  const seen = captureVersions(view, names, slots)
  return {
    transport: 'sab',
    signal: name => mirrorSignal(view, slots, watchers, name),
    sampleAll: () => sampleChanged(view, names, slots, seen, watchers),
  }
}

const HEADER_BYTES = 32 // magic, schemaHash, count, reserved

function headerBytes(): number {
  return HEADER_BYTES
}

function putHeader(view: DataView, names: readonly string[]): void {
  view.setUint32(0, SHARED_MAGIC, true)
  view.setUint32(4, schemaHash(names), true)
  view.setUint32(8, names.length, true)
}

function checkSchema(view: DataView, names: readonly string[]): void {
  if (view.getUint32(0, true) !== SHARED_MAGIC) throw new Error('rune: повреждённый реестр сигналов')
  if (view.getUint32(4, true) !== schemaHash(names)) {
    throw new Error('rune: версия схемы общих сигналов не совпадает — обнови оба мира')
  }
}

/** Записывает nameHash слотов во вновь созданный реестр. */
function putSlots(view: DataView, names: readonly string[]): void {
  names.forEach((name, i) => {
    view.setUint32(HEADER_BYTES + i * SLOT_BYTES, nameHash(name), true)
  })
}

/** nameHash → смещение слота. */
function indexSlots(view: DataView, names: readonly string[]): Map<number, number> {
  const slots = new Map<number, number>()
  const count = view.getUint32(8, true)
  for (let i = 0; i < count; i++) {
    slots.set(view.getUint32(HEADER_BYTES + i * SLOT_BYTES, true), HEADER_BYTES + i * SLOT_BYTES)
  }
  for (const name of names) {
    if (!slots.has(nameHash(name))) throw new Error(`rune: сигнал "${name}" не зарегистрирован`)
  }
  return slots
}

function bindSignal(
  view: DataView,
  slots: Map<number, number>,
  signal: ReadableSignal<number>,
  name: string,
): Unsubscribe {
  const offset = requireSlot(slots, name)
  writeSeqlock(view, offset + VERSION_OFFSET, offset + VALUE_OFFSET, signal.peek())
  return signal.subscribe(value => writeSeqlock(view, offset + VERSION_OFFSET, offset + VALUE_OFFSET, value))
}

function mirrorSignal(
  view: DataView,
  slots: Map<number, number>,
  watchers: Map<number, Subscriber<number>[]>,
  name: string,
): ReadableSignal<number> {
  const offset = requireSlot(slots, name)
  const listeners: Subscriber<number>[] = []
  watchers.set(offset, listeners)
  return {
    peek: () => readSeqlock(view, offset + VERSION_OFFSET, offset + VALUE_OFFSET).value,
    subscribe: subscriber => subscribeListener(listeners, subscriber),
    get value() { return readSeqlock(view, offset + VERSION_OFFSET, offset + VALUE_OFFSET).value },
    get version() { return seqlockVersion(view, offset + VERSION_OFFSET) },
  }
}

function subscribeListener(listeners: Subscriber<number>[], subscriber: Subscriber<number>): Unsubscribe {
  listeners.push(subscriber)
  return () => removeListener(listeners, subscriber)
}

function removeListener(listeners: Subscriber<number>[], subscriber: Subscriber<number>): void {
  const at = listeners.indexOf(subscriber)
  if (at >= 0) listeners.splice(at, 1)
}

function requireSlot(slots: Map<number, number>, name: string): number {
  const offset = slots.get(nameHash(name))
  if (offset === undefined) throw new Error(`rune: сигнал "${name}" не зарегистрирован`)
  return offset
}

function captureVersions(view: DataView, names: readonly string[], slots: Map<number, number>): Map<number, number> {
  const seen = new Map<number, number>()
  for (const name of names) {
    const offset = requireSlot(slots, name)
    seen.set(nameHash(name), seqlockVersion(view, offset + VERSION_OFFSET))
  }
  return seen
}

/** Эпоха: стреляет подписчиками изменившихся слотов; вернувшее — их число. */
function sampleChanged(
  view: DataView,
  names: readonly string[],
  slots: Map<number, number>,
  seen: Map<number, number>,
  watchers: Map<number, Subscriber<number>[]>,
): number {
  let changed = 0
  for (const name of names) {
    const hash = nameHash(name)
    const offset = requireSlot(slots, name)
    const version = seqlockVersion(view, offset + VERSION_OFFSET)
    if (version === seen.get(hash)) continue
    seen.set(hash, version)
    changed++
    fireWatchers(view, offset, watchers.get(offset))
  }
  return changed
}

function fireWatchers(view: DataView, offset: number, listeners: Subscriber<number>[] | undefined): void {
  if (listeners === undefined || listeners.length === 0) return
  const { value } = readSeqlock(view, offset + VERSION_OFFSET, offset + VALUE_OFFSET)
  for (const subscriber of [...listeners]) subscriber(value)
}
