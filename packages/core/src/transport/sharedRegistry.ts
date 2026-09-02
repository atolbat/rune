import type { ReadableSignal, Subscriber, Unsubscribe } from '../signal/types.ts'
import { readSeqlock, readSeqlockValue, writeSeqlock, seqlockVersion } from './seqlock.ts'

const VERSION_OFFSET = 4
const VALUE_OFFSET = 8

/** Registry slot: nameHash + seqlock. */
const SLOT_BYTES = 16

/** Magic header of the shared signal registry. */
export const SHARED_MAGIC = 0x52554e53 // 'RUNS'

/** Owner-side registry: writes, readers sample. */
export interface SharedRegistry {
  readonly buffer: SharedArrayBuffer
  /** Binds a signal to a slot; writes leak into the SAB (owner-writer). */
  bind(signal: ReadableSignal<number>, name: string): Unsubscribe
  /** Writes the value directly (smoothed sources, tests). */
  write(name: string, value: number): void
}

/** Mirror of the registry in another world: seqlock reads, epoch notifications. */
export interface SharedMirror {
  /** Signal representation of a slot (reads are always fresh). */
  signal(name: string): ReadableSignal<number>
  /** Epoch: notifies subscribers of changed slots; the return value is their count. */
  sampleAll(): number
  readonly transport: 'sab'
}

/** Name hash — the slot key (FNV-1a, stable across both worlds). */
export function nameHash(name: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Schema hash: a layout mismatch is caught at attach time. */
export function schemaHash(names: readonly string[]): number {
  return nameHash(names.join('\u0000'))
}

/** Creates a registry on the owner side (T1/T2: SAB is available). */
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

/** Attaches to the registry from any world (reader). */
export function attachSharedRegistry(buffer: SharedArrayBuffer, names: readonly string[]): SharedMirror {
  const view = new DataView(buffer)
  checkSchema(view, names)
  const slots = indexSlots(view, names)
  const watchers = new Map<number, Subscriber<number>[]>()
  // Task 114 — the FROZEN sampling plan: names are fixed at attach, so the
  // per-epoch loop does zero string hashing and zero Map lookups (the old
  // path re-hashed every name and resolved its slot on every sampleAll).
  const plan: Array<{ offset: number; versionAt: number }> = []
  const seen: number[] = []
  for (const name of names) {
    const offset = requireSlot(slots, name)
    const versionAt = offset + VERSION_OFFSET
    plan.push({ offset, versionAt })
    seen.push(seqlockVersion(view, versionAt))
  }
  return {
    transport: 'sab',
    signal: name => mirrorSignal(view, slots, watchers, name),
    sampleAll: () => {
      let changed = 0
      for (let at = 0; at < plan.length; at++) {
        const slot = plan[at]
        const version = seqlockVersion(view, slot.versionAt)
        if (version === seen[at]) continue
        seen[at] = version
        changed++
        fireWatchers(view, slot.offset, watchers.get(slot.offset))
      }
      return changed
    },
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
  if (view.getUint32(0, true) !== SHARED_MAGIC) throw new Error('rune: corrupted signal registry')
  if (view.getUint32(4, true) !== schemaHash(names)) {
    throw new Error('rune: shared signal schema version mismatch — update both worlds')
  }
}

/** Writes slot nameHashes into a newly created registry. */
function putSlots(view: DataView, names: readonly string[]): void {
  names.forEach((name, i) => {
    view.setUint32(HEADER_BYTES + i * SLOT_BYTES, nameHash(name), true)
  })
}

/** nameHash → slot offset. */
function indexSlots(view: DataView, names: readonly string[]): Map<number, number> {
  const slots = new Map<number, number>()
  const count = view.getUint32(8, true)
  for (let i = 0; i < count; i++) {
    slots.set(view.getUint32(HEADER_BYTES + i * SLOT_BYTES, true), HEADER_BYTES + i * SLOT_BYTES)
  }
  for (const name of names) {
    if (!slots.has(nameHash(name))) throw new Error(`rune: signal "${name}" is not registered`)
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
    peek: () => readSeqlockValue(view, offset + VERSION_OFFSET, offset + VALUE_OFFSET),
    subscribe: subscriber => subscribeListener(listeners, subscriber),
    get value() { return readSeqlockValue(view, offset + VERSION_OFFSET, offset + VALUE_OFFSET) },
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
  if (offset === undefined) throw new Error(`rune: signal "${name}" is not registered`)
  return offset
}

function fireWatchers(view: DataView, offset: number, listeners: Subscriber<number>[] | undefined): void {
  if (listeners === undefined || listeners.length === 0) return
  const { value } = readSeqlock(view, offset + VERSION_OFFSET, offset + VALUE_OFFSET)
  for (const subscriber of [...listeners]) subscriber(value)
}