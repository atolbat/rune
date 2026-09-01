/**
 * Межпоточные транспорты T0–T3 (досье §7.2, M5).
 *
 *   T0 memory    один поток — обычные сигналы, синхронно.
 *   T1 sab+async SAB + Atomics.waitAsync — seqlock + futex для редких ожиданий.
 *   T2 sab       SAB без waitAsync (старые Safari) — seqlock + эпохи;
 *                пробуждение MessageChannel — забота оболочки, не ядра.
 *   T3 msg       нет cross-origin-изоляции — дельты сигналов батчатся в одно
 *                сообщение на кадр; feed — ping-pong transferable.
 *
 * Инвариант деградации (досье, Контракт 3): share / shared / feed пишутся
 * один раз — меняется только латентность распространения, не семантика.
 *
 * Модель владения: HOST — сторона-писатель (владелец слотов: шелл для
 * app.size/visibility, игровой воркер для данных сцены); CLIENT —
 * сторона-читатель (рендер-мир, владелец GPU). Один слот — один писатель
 * (seqlock); фид — воркеры пишут в общий ринг, читатель снимает счётчик
 * на границе кадра (эпоха).
 */

import type { ReadableSignal, Unsubscribe } from '../signal/types.ts'
import { signal } from '../signal/signal.ts'
import type { SignalCell } from '../signal/signal.ts'
import { createSharedRegistry, attachSharedRegistry, nameHash } from './sharedRegistry.ts'
import type { SharedRegistry, SharedMirror } from './sharedRegistry.ts'
import { createFeed, feedStride } from '../feed/feed.ts'
import type { Feed, FeedLayout, FeedPolicy, FeedWriter } from '../feed/feed.ts'

/** Режим транспорта (T0–T3 досье, Таблица 4). */
export type TransportMode = 'memory' | 'sab+async' | 'sab' | 'msg'

/** Зонды окружения для detectTransport (инъекция в тестах). */
export interface TransportProbe {
  readonly sharedArrayBuffer?: boolean
  readonly waitAsync?: boolean
}

/** Выбирает транспорт по окружению: SAB+waitAsync → T1, SAB → T2, иначе T3.
 *  T0 ('memory') — явный выбор одного мира; авто-детект его не возвращает. */
export function detectTransport(probe?: TransportProbe): TransportMode {
  const hasSab = probe?.sharedArrayBuffer ?? typeof SharedArrayBuffer !== 'undefined'
  if (!hasSab) return 'msg'
  const hasWaitAsync = probe?.waitAsync
    ?? (typeof Atomics !== 'undefined' && typeof (Atomics as { waitAsync?: unknown }).waitAsync === 'function')
  return hasWaitAsync ? 'sab+async' : 'sab'
}

/** SAB доступен в этом мире? (T1/T2 против T3.) */
export function hasSharedArrayBuffer(): boolean {
  return typeof SharedArrayBuffer !== 'undefined'
}

// ────────────────────────── T3: сообщение кадра ──────────────────────────

/** Чанк фида в сообщении кадра: байты записей [from, from+count).
 *  bytes — transferable (ping-pong: читатель возвращает через recycle). */
export interface TransportFeedChunk {
  readonly feedId: number
  readonly from: number
  readonly count: number
  readonly bytes: ArrayBuffer
}

/** Одно сообщение на кадр (T3): дельты сигналов + чанки фидов. */
export interface TransportFrameMessage {
  readonly kind: 'rune.transport.frame'
  readonly deltas: ReadonlyArray<readonly [hash: number, value: number]>
  readonly chunks: ReadonlyArray<TransportFeedChunk>
}

// ───────────────────── Фид со стороны читателя ─────────────────────

/** Фид со стороны читателя: снапшот опубликованных записей для GPU.
 *  T1/T2 — стабильный view поверх SAB (счётчик атомарный);
 *  T3 — зеркало, наполняемое apply() из ping-pong чанков;
 *  T0 — view поверх обычного буфера.
 *  layout (M5): опциональная схема записи — рендереру фида для
 *  dual-bind attribute(field); заполняется всеми транспортами. */
export interface TransportFeedView {
  readonly feedId: number
  readonly stride: number
  readonly capacity: number
  /** Схема записи (имя → формат) — для attribute() рендерера фида. */
  readonly layout?: FeedLayout
  /** Число опубликованных записей (снимок на момент вызова). */
  count(): number
  /** Байты записей [0, count): стабильная идентичность (GPU-кэш по ней). */
  bytes(): Float32Array
  /** T3: вернуть ping-pong буферы владельцу после загрузки в GPU. */
  recycle(): void
}

// ────────────────────────── Host (писатель) ──────────────────────────

export interface TransportHost {
  readonly mode: TransportMode
  /** Связать сигнал-источник со слотом (владелец-писатель). */
  share(source: ReadableSignal<number>, name: string): Unsubscribe
  /** Прямая запись в слот (сглаженные источники, тесты). */
  write(name: string, value: number): void
  /** Создать фид: SAB в T1/T2, local в T0, ping-pong в T3. */
  createFeed(options: { layout: FeedLayout; capacity: number; policy?: FeedPolicy }): Feed
  /** T3: батч дельт и чанков с прошлого flush (одно сообщение на кадр).
   *  Не-T3 → null: распространение — семплирование, не сообщения. */
  flush(): TransportFrameMessage | null
  /** T3: принять ping-pong буфер, возвращённый читателем. */
  reclaim(chunk: TransportFeedChunk): void
  /** Дескриптор для другого мира: SAB-режимы переносят буферы,
   *  T3 — только схему (сообщения ходят поверх postMessage юзера). */
  describe(): TransportDescriptor
}

export interface TransportDescriptor {
  readonly mode: TransportMode
  readonly names: readonly string[]
  /** T1/T2: SAB реестра сигналов. */
  readonly signals?: ArrayBufferLike
  /** Фиды владельца: T1/T2 — с буферами; T3 — только метаданные. */
  readonly feeds?: ReadonlyArray<TransportFeedMeta>
}

/** Метаданные фида для другого мира. */
export interface TransportFeedMeta {
  readonly id: number
  readonly layout: FeedLayout
  readonly capacity: number
  readonly buffer?: ArrayBufferLike
}

// ────────────────────────── Client (читатель) ──────────────────────────

export interface TransportClient {
  readonly mode: TransportMode
  /** Сигнал-зеркало слота: чтение всегда свежее, уведомления — sampleAll. */
  shared(name: string): ReadableSignal<number>
  /** Граница кадра: уведомить подписчиков изменившихся слотов; их число. */
  sampleAll(): number
  /** T3: применить сообщение кадра (дельты + чанки). */
  apply(message: TransportFrameMessage): void
  /** T3: буферы, готовые к возврату писателю (после recycle у view).
   *  Кросс-поток: юзер постит их обратно и зовёт host.reclaim. Не-T3 → []. */
  takeRecycled(): ReadonlyArray<TransportFeedChunk>
  /** Фид читателя по id (null — не создан/не привязан). */
  feed(feedId: number): TransportFeedView | null
  /** Привязать фид (T3-зеркало; SAB — из descriptor). Сама создаёт view. */
  attachFeed(feedId: number, layout: FeedLayout, capacity: number): TransportFeedView
  /** T1: редкое ожидание изменения слота (futex поверх version-слова).
   *  Не-T1 → false. true — версия изменилась (пробуждение состоялось). */
  waitForChange(name: string, timeoutMs?: number): Promise<boolean>
}

/** Связка host+client в одном мире (T0, same-thread сценарии, тесты). */
export interface TransportPair {
  readonly mode: TransportMode
  readonly host: TransportHost
  readonly client: TransportClient
}

export function createTransport(options?: {
  readonly mode?: TransportMode
  readonly names?: readonly string[]
}): TransportPair {
  const mode = options?.mode ?? 'memory'
  const names = options?.names ?? []
  if (mode === 'memory') {
    // T0: ячейки общие — shared() возвращает сам источник (синхронно).
    const cells = new Map<string, SignalCell<number>>()
    for (const name of names) cells.set(name, signal(0))
    const host = memoryHost(names, cells)
    const client = signalClient('memory', cells)
    return { mode, host, client }
  }
  if (mode === 'msg') {
    const state = createMsgState(names)
    const host = msgHost(state)
    const client = msgClient(state)
    return { mode, host, client }
  }
  const registry = createSharedRegistry(names)
  const feedMeta = new Map<number, TransportFeedMeta>()
  const sabFeeds = new Map<number, Feed>()
  let nextFeedId = 1
  const host: TransportHost = {
    mode,
    share: (source, name) => registry.bind(source, name),
    write: (name, value) => registry.write(name, value),
    createFeed: feedOptions => {
      const feed = createFeed({ ...feedOptions, backing: 'sab' })
      const id = nextFeedId
      nextFeedId++
      sabFeeds.set(id, feed)
      feedMeta.set(id, { id, layout: feedOptions.layout, capacity: feedOptions.capacity, buffer: feed.buffer })
      return feed
    },
    flush: () => null, // семплирование, не сообщения
    reclaim: () => {},
    describe: () => ({
      mode,
      names,
      signals: registry.buffer,
      feeds: [...feedMeta.values()],
    }),
  }
  const client = sabClient(mode, names, registry.buffer, feedMeta)
  return { mode, host, client }
}

/** Host на стороне писателя (для кросс-поточной связки без pair). */
export function createTransportHost(options: {
  readonly mode: TransportMode
  readonly names?: readonly string[]
}): TransportHost {
  const names = options.names ?? []
  if (options.mode === 'memory') {
    const cells = new Map<string, SignalCell<number>>()
    for (const name of names) cells.set(name, signal(0))
    return memoryHost(names, cells)
  }
  if (options.mode === 'msg') return msgHost(createMsgState(names))
  const registry = createSharedRegistry(names)
  const feedMeta = new Map<number, TransportFeedMeta>()
  let nextFeedId = 1
  return {
    mode: options.mode,
    share: (source, name) => registry.bind(source, name),
    write: (name, value) => registry.write(name, value),
    createFeed: feedOptions => {
      const feed = createFeed({ ...feedOptions, backing: 'sab' })
      const id = nextFeedId
      nextFeedId++
      feedMeta.set(id, { id, layout: feedOptions.layout, capacity: feedOptions.capacity, buffer: feed.buffer })
      return feed
    },
    flush: () => null,
    reclaim: () => {},
    describe: () => ({ mode: options.mode, names, signals: registry.buffer, feeds: [...feedMeta.values()] }),
  }
}

/** Client из дескриптора, переданного в мир читателя
 *  (SAB сериализуется structured-clone'ом при cross-origin-изоляции). */
export function attachTransport(descriptor: TransportDescriptor): TransportClient {
  if (descriptor.mode === 'msg') return msgClient(createMsgState(descriptor.names, descriptor.feeds))
  if (descriptor.mode === 'memory') {
    const cells = new Map<string, SignalCell<number>>()
    for (const name of descriptor.names) cells.set(name, signal(0))
    return signalClient('memory', cells)
  }
  const meta = new Map<number, TransportFeedMeta>()
  for (const feed of descriptor.feeds ?? []) meta.set(feed.id, feed)
  return sabClient(descriptor.mode, descriptor.names, descriptor.signals!, meta)
}

// ────────────────────────── T0: memory ──────────────────────────

/** T0: запись в ячейку — прямой сигнал (синхронно, без сообщений). */
function memoryHost(names: readonly string[], cells: Map<string, SignalCell<number>>): TransportHost {
  const feeds = new Map<number, Feed>()
  let nextFeedId = 1
  return {
    mode: 'memory',
    share: (source, name) => {
      const cell = requireCell(cells, name)
      cell.value = source.peek()
      return source.subscribe(value => { cell.value = value })
    },
    write: (name, value) => {
      requireCell(cells, name).value = value
    },
    createFeed: feedOptions => {
      const feed = createFeed({ ...feedOptions, backing: 'local' })
      feeds.set(nextFeedId, feed)
      nextFeedId++
      return feed
    },
    flush: () => null,
    reclaim: () => {},
    describe: () => ({ mode: 'memory', names, feeds: [] }),
  }
}

// ────────────────────────── T1/T2: SAB ──────────────────────────

function sabClient(
  mode: 'sab+async' | 'sab',
  names: readonly string[],
  signals: ArrayBufferLike,
  feedMeta: Map<number, TransportFeedMeta>,
): TransportClient {
  const mirror: SharedMirror = attachSharedRegistry(signals as SharedArrayBuffer, names)
  const views = new Map<number, TransportFeedView>()
  for (const meta of feedMeta.values()) {
    if (meta.buffer !== undefined) views.set(meta.id, sabFeedView(meta.id, meta.buffer, meta.layout, meta.capacity))
  }
  return {
    mode,
    shared: name => mirror.signal(name),
    sampleAll: () => mirror.sampleAll(),
    apply: () => { /* SAB: семплирование в sampleAll, применять нечего */ },
    takeRecycled: () => [], // SAB: буферы общие
    feed: id => views.get(id) ?? sabViewFromMeta(feedMeta, id, views),
    attachFeed: (id, layout, capacity) => {
      const known = views.get(id)
      if (known !== undefined) return known
      const meta = feedMeta.get(id)
      if (meta === undefined || meta.buffer === undefined) {
        throw new Error(`rune: SAB-фид ${id} не описан в дескрипторе — передай buffer`)
      }
      const view = sabFeedView(id, meta.buffer, layout, capacity)
      views.set(id, view)
      return view
    },
    waitForChange: (name, timeoutMs) => waitSlotChange(mirror, signals as SharedArrayBuffer, names, name, timeoutMs),
  }
}

/** Ленивый SAB-view: host.createFeed после создания пары — клиент берёт по id. */
function sabViewFromMeta(feedMeta: Map<number, TransportFeedMeta>, id: number, views: Map<number, TransportFeedView>): TransportFeedView | null {
  const meta = feedMeta.get(id)
  if (meta === undefined || meta.buffer === undefined) return null
  const view = sabFeedView(id, meta.buffer, meta.layout, meta.capacity)
  views.set(id, view)
  return view
}

/** Стабильный view поверх SAB-ринга фида (HEADER 64 байта — как в feed.ts). */
function sabFeedView(feedId: number, buffer: ArrayBufferLike, layout: FeedLayout, capacity: number): TransportFeedView {
  const stride = feedStride(layout)
  const bytes = new Float32Array(buffer, 64, (capacity * stride) / 4)
  const u32 = new Uint32Array(buffer)
  return {
    feedId,
    stride,
    capacity,
    layout,
    count: () => Atomics.load(u32, 1), // published
    bytes: () => bytes,
    recycle: () => { /* буфер общий — возвращать нечего */ },
  }
}

/** T1: futex-ожидание изменения слота — Atomics.waitAsync поверх
 *  version-слова seqlock (любая смена версии — пробуждение; стабильное
 *  значение добирается readSeqlock'ом с повторами в mirror.signal()).
 *  LE-совместимо: браузерные платформы little-endian, реестр пишет LE. */
async function waitSlotChange(
  mirror: SharedMirror,
  sab: SharedArrayBuffer,
  names: readonly string[],
  name: string,
  timeoutMs = 1000,
): Promise<boolean> {
  if (typeof Atomics === 'undefined' || typeof (Atomics as { waitAsync?: unknown }).waitAsync !== 'function') {
    return false
  }
  requireName(names, name)
  const probe = mirror.signal(name)
  const before = probe.version
  const i32 = new Int32Array(sab)
  const index = versionWordIndex(names, name)
  const expected = i32[index] // текущая версия (чётная = покой)
  const res = Atomics.waitAsync(i32, index, expected, timeoutMs)
  if (res.async) await res.value
  return probe.version !== before
}

/** Индекс Int32-слова версии seqlock (раскладка слота: 32 + i*16 + 4). */
function versionWordIndex(names: readonly string[], name: string): number {
  const at = names.indexOf(name)
  if (at < 0) throw new Error(`rune: сигнал "${name}" не зарегистрирован`)
  return (32 + at * 16 + 4) >> 2
}

// ────────────────────────── T3: msg ──────────────────────────

interface MsgSlot {
  value: number
  hash: number
  dirty: boolean
}

/** Ядро ping-pong фида T3: буферы ходят writer → reader → writer. */
interface MsgFeedCore {
  readonly layout: FeedLayout
  readonly capacity: number
  readonly stride: number
  /** Пул возвращённых читателем буферов. */
  pool: ArrayBuffer[]
  /** Текущий буфер записи (уедет чанком на flush). */
  current: ArrayBuffer
  /** Записей записано в current. */
  written: number
  /** Логическое смещение первой записи current. */
  base: number
  /** Всего записей уехало чанками. */
  shipped: number
  /** Логический published (после publish()). */
  published: number
}

/** Зеркало фида T3 на стороне читателя (stride/capacity — свои). */
interface MsgMirror {
  readonly mirror: Float32Array
  readonly stride: number
  readonly capacity: number
  readonly layout?: FeedLayout
  count: number
  pending: TransportFeedChunk[]
}

interface MsgState {
  names: readonly string[]
  slots: Map<string, MsgSlot>
  feeds: Map<number, MsgFeedCore>
  /** Зеркала читателя (same-thread pair / attachTransport по метаданным). */
  mirrors: Map<number, MsgMirror>
  /** Чанки, возвращённые читателем (pending → pool на flush). */
  recycled: TransportFeedChunk[]
  nextFeedId: number
}

function createMsgState(names: readonly string[], feedMetas?: ReadonlyArray<TransportFeedMeta>): MsgState {
  const slots = new Map<string, MsgSlot>()
  for (const name of names) slots.set(name, { value: 0, hash: nameHash(name), dirty: false })
  const state: MsgState = { names, slots, feeds: new Map(), mirrors: new Map(), recycled: [], nextFeedId: 1 }
  for (const meta of feedMetas ?? []) {
    state.mirrors.set(meta.id, {
      mirror: new Float32Array((meta.capacity * feedStride(meta.layout)) / 4),
      stride: feedStride(meta.layout),
      capacity: meta.capacity,
      layout: meta.layout,
      count: 0,
      pending: [],
    })
  }
  return state
}

function msgHost(state: MsgState): TransportHost {
  return {
    mode: 'msg',
    share: (source, name) => {
      const slot = requireMsgSlot(state, name)
      slot.value = source.peek()
      slot.dirty = true
      return source.subscribe(value => {
        slot.value = value
        slot.dirty = true
      })
    },
    write: (name, value) => {
      const slot = requireMsgSlot(state, name)
      slot.value = value
      slot.dirty = true
    },
    createFeed: feedOptions => msgFeedFacade(state, feedOptions),
    flush: () => flushMsg(state),
    reclaim: chunk => {
      state.recycled.push(chunk)
    },
    describe: () => ({
      mode: 'msg',
      names: state.names,
      feeds: [...state.feeds.entries()].map(([id, core]) => ({ id, layout: core.layout, capacity: core.capacity })),
    }),
  }
}

function msgClient(state: MsgState): TransportClient {
  const cells = new Map<string, SignalCell<number>>()
  const versions = new Map<string, number>()
  for (const name of state.names) {
    cells.set(name, signal(0))
    versions.set(name, 0)
  }
  const views = new Map<number, TransportFeedView>()
  for (const [id, entry] of state.mirrors) views.set(id, mirrorFeedView(state, id, entry))
  return {
    mode: 'msg',
    shared: name => {
      const cell = cells.get(name)
      if (cell === undefined) throw new Error(`rune: сигнал "${name}" не зарегистрирован`)
      return cell
    },
    sampleAll: () => {
      let changed = 0
      for (const [name, cell] of cells) {
        const seen = versions.get(name)!
        if (cell.version === seen) continue
        versions.set(name, cell.version)
        changed++
      }
      return changed
    },
    apply: message => {
      if (message?.kind !== 'rune.transport.frame') return
      for (const [hash, value] of message.deltas) {
        for (const name of state.names) {
          if (nameHash(name) !== hash) continue
          cells.get(name)!.value = value
        }
      }
      for (const chunk of message.chunks) {
        const entry = state.mirrors.get(chunk.feedId)
        if (entry === undefined) continue
        const src = new Float32Array(chunk.bytes)
        const strideF = entry.stride / 4
        for (let i = 0; i < chunk.count; i++) {
          const srcAt = i * strideF
          const dstAt = (chunk.from + i) * strideF
          for (let c = 0; c < strideF; c++) entry.mirror[dstAt + c] = src[srcAt + c]
        }
        entry.count = Math.max(entry.count, chunk.from + chunk.count)
        entry.pending.push(chunk)
      }
    },
    feed: id => views.get(id) ?? mirrorFromCore(state, id, views),
    takeRecycled: () => {
      // Ping-pong возврат: recycle() у view складывает сюда применённые чанки.
      const out = [...state.recycled]
      state.recycled.length = 0
      return out
    },
    attachFeed: (id, layout, capacity) => {
      const known = views.get(id)
      if (known !== undefined) return known
      const stride = feedStride(layout)
      const entry: MsgMirror = {
        mirror: new Float32Array((capacity * stride) / 4),
        stride,
        capacity,
        layout,
        count: 0,
        pending: [],
      }
      state.mirrors.set(id, entry)
      const view = mirrorFeedView(state, id, entry)
      views.set(id, view)
      return view
    },
    waitForChange: () => Promise.resolve(false), // T3: латентность — до 1 кадра, ожидать нечем
  }
}

/** Ленивое зеркало same-thread-пары: host.createFeed → клиент берёт view по id. */
function mirrorFromCore(state: MsgState, id: number, views: Map<number, TransportFeedView>): TransportFeedView | null {
  const core = state.feeds.get(id)
  if (core === undefined) return null
  const entry: MsgMirror = {
    mirror: new Float32Array((core.capacity * core.stride) / 4),
    stride: core.stride,
    capacity: core.capacity,
    layout: core.layout,
    count: 0,
    pending: [],
  }
  state.mirrors.set(id, entry)
  const view = mirrorFeedView(state, id, entry)
  views.set(id, view)
  return view
}

function flushMsg(state: MsgState): TransportFrameMessage | null {
  // Ping-pong: сначала вернуть в пул буферы, отданные читателем.
  for (const chunk of state.recycled) {
    const core = state.feeds.get(chunk.feedId)
    core?.pool.push(chunk.bytes)
  }
  state.recycled.length = 0
  const deltas: Array<[number, number]> = []
  for (const slot of state.slots.values()) {
    if (!slot.dirty) continue
    deltas.push([slot.hash, slot.value])
    slot.dirty = false
  }
  const chunks: TransportFeedChunk[] = []
  for (const [id, core] of state.feeds) {
    if (core.written === 0) continue
    chunks.push({ feedId: id, from: core.base, count: core.written, bytes: core.current })
    core.current = core.pool.pop() ?? new ArrayBuffer(core.capacity * core.stride)
    core.base += core.written
    core.shipped += core.written
    core.written = 0
  }
  if (deltas.length === 0 && chunks.length === 0) return null
  return { kind: 'rune.transport.frame', deltas, chunks }
}

/** Feed-фасад писателя T3: append-only (push/publish), view — в окне current. */
function msgFeedFacade(state: MsgState, feedOptions: { layout: FeedLayout; capacity: number; policy?: FeedPolicy }, forcedId?: number): Feed {
  const id = forcedId ?? state.nextFeedId
  if (forcedId === undefined) state.nextFeedId++
  else state.nextFeedId = Math.max(state.nextFeedId, forcedId + 1)
  const stride = feedStride(feedOptions.layout)
  state.feeds.set(id, {
    layout: feedOptions.layout,
    capacity: feedOptions.capacity,
    stride,
    pool: [],
    current: new ArrayBuffer(feedOptions.capacity * stride),
    written: 0,
    base: 0,
    shipped: 0,
    published: 0,
  })
  const core = () => state.feeds.get(id)!
  return {
    get buffer() { return core().current },
    get capacity() { return core().capacity },
    get stride() { return stride },
    view: (from, count) => {
      const c = core()
      const local = from - c.base
      if (local < 0 || from + count > c.base + c.capacity) {
        throw new Error(`rune: T3-фид append-only — view(${from},${count}) вне окна [${c.base}, ${c.base + c.capacity})`)
      }
      // Окно записи расширяется до покрывающего (parity с SAB-view).
      if (local + count > c.written) c.written = local + count
      return msgWriter(core, from, count)
    },
    push: count => {
      const c = core()
      const from = c.base + c.written
      // Task 75: логическая граница окна — base+written не заходит за
      // capacity (зеркало читателя физически capacity*stride байтов).
      // Раньше проверялось только окно written — логический индекс рос
      // за границу зеркала, count читателя превышал capacity → writeBuffer
      // больше буфера. Теперь drop-new консервативен по ЛОГИЧЕСКОМУ индексу.
      if (c.base + c.written + count > c.capacity) return msgWriter(core, from, 0)
      c.written += count
      return msgWriter(core, from, count)
    },
    publish: () => {
      const c = core()
      c.published = c.base + c.written
    },
    publishedCount: () => core().published,
  }
}

function msgWriter(core: () => MsgFeedCore, from: number, count: number): FeedWriter {
  return {
    setFloat: (name, index, value) => writeMsg(core, from + index, name, [value]),
    setVec2: (name, index, x, y) => writeMsg(core, from + index, name, [x, y]),
    setVec3: (name, index, x, y, z) => writeMsg(core, from + index, name, [x, y, z]),
    setVec4: (name, index, x, y, z, w) => writeMsg(core, from + index, name, [x, y, z, w]),
    setVec4Bytes: (name, index, r, g, b, a) => {
      const c = core()
      const offsets = byteOffsets(c.layout)
      const at = (from + index) * c.stride + (offsets.get(name) ?? -1)
      if (at < 0) throw new Error(`rune: поле фида "${name}" не объявлено`)
      const u8 = new Uint8Array(c.current)
      u8[at] = r; u8[at + 1] = g; u8[at + 2] = b; u8[at + 3] = a
    },
  }
}

function writeMsg(core: () => MsgFeedCore, logicalIndex: number, name: string, values: number[]): void {
  const c = core()
  const offsets = byteOffsets(c.layout)
  const fieldAt = offsets.get(name)
  if (fieldAt === undefined) throw new Error(`rune: поле фида "${name}" не объявлено`)
  const local = logicalIndex - c.base
  if (local < 0 || local >= c.capacity) {
    throw new Error(`rune: T3-фид append-only — индекс ${logicalIndex} вне окна [${c.base}, ${c.base + c.capacity})`)
  }
  const f32 = new Float32Array(c.current)
  const at = (local * c.stride + fieldAt) >> 2
  for (let i = 0; i < values.length; i++) f32[at + i] = values[i]
}

const byteOffsetCache = new WeakMap<FeedLayout, Map<string, number>>()

function byteOffsets(layout: FeedLayout): Map<string, number> {
  const cached = byteOffsetCache.get(layout)
  if (cached !== undefined) return cached
  const offsets = new Map<string, number>()
  let offset = 0
  for (const [name, format] of Object.entries(layout)) {
    offsets.set(name, offset)
    offset += format === 'float32x2' ? 8 : format === 'float32x3' ? 12 : format === 'float32x4' ? 16 : 4
  }
  byteOffsetCache.set(layout, offsets)
  return offsets
}

/** View зеркала T3: count двигается apply-ом, recycle возвращает буферы. */
function mirrorFeedView(state: MsgState, feedId: number, entry: MsgMirror): TransportFeedView {
  void state
  void feedId
  return {
    feedId,
    stride: entry.stride,
    capacity: entry.capacity,
    layout: entry.layout,
    count: () => entry.count,
    bytes: () => entry.mirror,
    recycle: () => {
      for (const chunk of entry.pending) state.recycled.push(chunk)
      entry.pending.length = 0
    },
  }
}

// ───────────────────── Standalone T3-фид (без транспорта) ─────────────────────

/** Писатель ping-pong фида T3 (воркер): push/publish, чанки забирает ship(). */
export interface MsgFeedWriterHandle {
  readonly feed: Feed
  /** Забрать неуехавшие записи одним массивом чанков (transferable). */
  ship(): TransportFeedChunk[]
  /** Вернуть буферы читателя в пул (после его recycle-сообщения). */
  reclaim(chunks: ReadonlyArray<TransportFeedChunk>): void
}

/** Читатель ping-pong фида T3 (рендер-мир): зеркало + count. */
export interface MsgFeedReaderHandle {
  readonly view: TransportFeedView
  /** Применить чанки сообщения (порядок — как в ship/flush). */
  apply(chunks: ReadonlyArray<TransportFeedChunk>): void
  /** Чанки, готовые к возврату писателю (после загрузки в GPU). */
  takeRecycled(): TransportFeedChunk[]
}

/** Создаёт писателя ping-pong фида в мире воркера (T3, standalone). */
export function createMsgFeedWriter(feedId: number, options: { layout: FeedLayout; capacity: number; policy?: FeedPolicy }): MsgFeedWriterHandle {
  const state = createMsgState([])
  const facade = msgFeedFacade(state, options, feedId)
  void facade
  return {
    feed: facade,
    ship: () => {
      const message = flushMsg(state)
      return message === null ? [] : [...message.chunks]
    },
    reclaim: chunks => {
      for (const chunk of chunks) state.recycled.push(chunk)
    },
  }
}

/** Создаёт читателя ping-pong фида в мире рендера (T3, standalone). */
export function createMsgFeedReader(feedId: number, options: { layout: FeedLayout; capacity: number }): MsgFeedReaderHandle {
  const stride = feedStride(options.layout)
  const mirror = new Float32Array((options.capacity * stride) / 4)
  const entry: MsgMirror = { mirror, stride, capacity: options.capacity, count: 0, pending: [] }
  const state: MsgState = { names: [], slots: new Map(), feeds: new Map(), mirrors: new Map([[feedId, entry]]), recycled: [], nextFeedId: feedId + 1 }
  const view = mirrorFeedView(state, feedId, entry)
  return {
    view,
    apply: chunks => {
      for (const chunk of chunks) {
        if (chunk.feedId !== feedId) continue
        const src = new Float32Array(chunk.bytes)
        const strideF = stride / 4
        for (let i = 0; i < chunk.count; i++) {
          const srcAt = i * strideF
          const dstAt = (chunk.from + i) * strideF
          for (let c = 0; c < strideF; c++) mirror[dstAt + c] = src[srcAt + c]
        }
        // Task 75: count зеркала не может превышать capacity (записи за
        // физическим пределом зеркала игнорируются TypedArray-семантикой,
        // счётчик обязан следовать).
        entry.count = Math.min(Math.max(entry.count, chunk.from + chunk.count), options.capacity)
        entry.pending.push(chunk)
      }
    },
    takeRecycled: () => {
      // Дрен очереди возврата: recycle() складывает сюда применённые чанки.
      const out = [...state.recycled]
      state.recycled.length = 0
      return out
    },
  }
}

// ────────────────────────── Общие утилиты ──────────────────────────

function signalClient(mode: TransportMode, cells: Map<string, SignalCell<number>>): TransportClient {
  return {
    mode,
    shared: name => {
      const cell = cells.get(name)
      if (cell === undefined) throw new Error(`rune: сигнал "${name}" не зарегистрирован`)
      return cell
    },
    sampleAll: () => 0, // T0: уведомления текут через сигнальный граф синхронно
    apply: () => {},
    takeRecycled: () => [],
    feed: () => null,
    attachFeed: () => {
      throw new Error('rune: T0-фиды не регистрируются транспортом — канал общий')
    },
    waitForChange: () => Promise.resolve(false),
  }
}

function requireCell(cells: Map<string, SignalCell<number>>, name: string): SignalCell<number> {
  const cell = cells.get(name)
  if (cell === undefined) throw new Error(`rune: сигнал "${name}" не зарегистрирован`)
  return cell
}

function requireName(names: readonly string[], name: string): void {
  if (!names.includes(name)) throw new Error(`rune: сигнал "${name}" не зарегистрирован`)
}

function requireMsgSlot(state: MsgState, name: string): MsgSlot {
  const slot = state.slots.get(name)
  if (slot === undefined) throw new Error(`rune: сигнал "${name}" не зарегистрирован`)
  return slot
}
