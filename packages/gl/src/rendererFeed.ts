/**
 * RendererFeed (M5, Task 73): feed dual-bind на стороне рендерера.
 *
 * Досье §4.3: канал фида биндится двумя способами одновременно — как поток
 * вершинных атрибутов (интерливинг-записи: stride/offset поля) и как
 * GPU-массив структур (storage на WebGPU / UBO std140 на WebGL2 —
 * обвязка шейдер-биндинга — M2 renderer.buffer(), здесь готовые данные).
 *
 * Граница кадра (§7.2): рендерер снимает атомарный счётчик published и
 * загружает ГРЯЗНЫЙ ДИАПАЗОН одним вызовом (GL: bufferSubData;
 * WebGPU: queue.writeBuffer). Count — сигнал (u_lightCount).
 *
 * Транспорт-инвариант: канал один и тот же в T0/T1/T2 (SAB/local ринг,
 * .buffer передаётся воркеру), в T3 — ping-pong (воркер: createMsgFeedWriter,
 * чанки приезжают applyChunks'ом, буферы возвращаются takeRecycled'ом).
 */

import type {
  Feed,
  FeedLayout,
  FeedPolicy,
  ReadableSignal,
  TransportFeedChunk,
  TransportFeedView,
  TransportMode,
} from '@rune/core'
import { createFeed, createMsgFeedReader, detectTransport, feedFieldSize, feedStride, signal } from '@rune/core'
import type { SignalCell } from '@rune/core'
import type { GLFacade } from '@rune/webgl2'
import type { GPUFacade } from '@rune/webgpu'

/** Опции создания фида рендерера. */
export interface RendererFeedOptions {
  readonly layout: FeedLayout
  readonly capacity: number
  readonly policy?: FeedPolicy
  /** Транспорт-режим канала. Default: SAB-детект окружения (T1/T2), без
   *  SAB — T3 (msg ping-pong). 'memory' — одиночный мир. */
  readonly mode?: TransportMode
}

/** Vertex-путь: привязка поля записи для attributes спека. */
export interface FeedAttributeBinding {
  readonly data: Float32Array
  readonly size: number
  readonly stride: number
  readonly offset: number
  /** GL: внешний GPU-буфер фида (executor не создаёт свой). */
  readonly bufferId?: number
  /** Task 75: шаг выборки записи — 'instance' (квады-звёзды: одна запись
   *  = один инстанс, углы квада разворачиваются из vertex_index в шейдере)
   *  | 'vertex' (default — вершинный суп, как в треугольной галактике). */
  readonly step?: 'vertex' | 'instance'
}

/** Storage-путь: массив структур как единый буфер. */
export interface RendererFeedStorage {
  readonly data: Float32Array
  readonly stride: number
  readonly count: ReadableSignal<number>
}

export interface RendererFeed {
  /** Канал писателя (T0/T1/T2): отдай .buffer воркеру (attachFeed) или
   *  пиши сам. null в T3 — писатель живёт в воркере (createMsgFeedWriter). */
  readonly channel: Feed | null
  /** Опубликовано записей — сигнал (u_lightCount, instances). */
  readonly count: ReadableSignal<number>
  readonly stride: number
  readonly capacity: number
  /** Vertex-путь: интерливинг-привязка поля (attributes спека). */
  attribute(field: string, step?: 'vertex' | 'instance'): FeedAttributeBinding
  /** Storage-путь: массив структур (std140-обвязка — M2 buffer()). */
  readonly storage: RendererFeedStorage
  /** T3: применить чанки писателя (доставка — postMessage юзера). */
  applyChunks(chunks: ReadonlyArray<TransportFeedChunk>): void
  /** T3: буферы, готовые к возврату писателю (после загрузки в GPU). */
  takeRecycled(): TransportFeedChunk[]
  /** Граница кадра (вызывает рендерер): грязный диапазон → GPU одним вызовом. */
  sync(): void
  dispose(): void
}

/** FeedId для T3-reader'а (renderer-мир знает свой фид). */
const MSG_FEED_ID = 1

/** Поле layout: байтовое смещение + размер в компонентах. */
interface FieldInfo {
  readonly offset: number
  readonly size: number
}

function fieldInfos(layout: FeedLayout): Map<string, FieldInfo> {
  const infos = new Map<string, FieldInfo>()
  let offset = 0
  for (const [name, format] of Object.entries(layout)) {
    infos.set(name, { offset, size: feedFieldSize(format) })
    offset += format === 'float32x2' ? 8 : format === 'float32x3' ? 12 : format === 'float32x4' ? 16 : 4
  }
  return infos
}

/** View поверх core-фида (T0/T1/T2): стабильные байты + атомарный счётчик. */
function coreFeedView(feed: Feed, feedId: number): TransportFeedView {
  const u32 = new Uint32Array(feed.buffer)
  const bytes = new Float32Array(feed.buffer, 64, (feed.capacity * feed.stride) / 4)
  return {
    feedId,
    stride: feed.stride,
    capacity: feed.capacity,
    count: () => Atomics.load(u32, 1),
    bytes: () => bytes,
    recycle: () => { /* буфер общий — возвращать нечего */ },
  }
}

/** Общая часть фида рендерера: канал + view + count + dirty-трекинг. */
interface FeedCore {
  readonly channel: Feed | null
  readonly view: TransportFeedView
  readonly msgReader: ReturnType<typeof createMsgFeedReader> | null
  readonly layout: FeedLayout | undefined
  readonly stride: number
  readonly capacity: number
  readonly fields: Map<string, FieldInfo>
  readonly countSignal: SignalCell<number>
  synced: number
}

function createFeedCore(options: RendererFeedOptions | TransportFeedView): FeedCore {
  const countSignal = signal(0)
  // Внешний view (транспорт-привязанный): есть count()/bytes(); layout
  // везёт сам view (все транспорты его заполняют — attribute() работает).
  if ('count' in options && typeof options.count === 'function') {
    const view = options as TransportFeedView
    return {
      channel: null,
      view,
      msgReader: null,
      layout: view.layout,
      stride: view.stride,
      capacity: view.capacity,
      fields: view.layout !== undefined ? fieldInfos(view.layout) : new Map(),
      countSignal,
      synced: 0,
    }
  }
  const opts = options as RendererFeedOptions
  const mode = opts.mode ?? detectTransport()
  if (mode === 'msg') {
    // T3: рендер-мир — читатель ping-pong (писатель — createMsgFeedWriter
    // в воркере, тот же layout/capacity; доставка чанков — applyChunks).
    const reader = createMsgFeedReader(MSG_FEED_ID, { layout: opts.layout, capacity: opts.capacity })
    return {
      channel: null,
      view: reader.view,
      msgReader: reader,
      layout: opts.layout,
      stride: feedStride(opts.layout),
      capacity: opts.capacity,
      fields: fieldInfos(opts.layout),
      countSignal,
      synced: 0,
    }
  }
  const feed = createFeed({
    layout: opts.layout,
    capacity: opts.capacity,
    policy: opts.policy,
    backing: mode === 'memory' ? 'local' : 'sab',
  })
  return {
    channel: feed,
    view: coreFeedView(feed, MSG_FEED_ID),
    msgReader: null,
    layout: opts.layout,
    stride: feed.stride,
    capacity: feed.capacity,
    fields: fieldInfos(opts.layout),
    countSignal,
    synced: 0,
  }
}

// ────────────────────────── WebGL2 ──────────────────────────

/** Фид рендерера на WebGL2: GPU-буфер через фасад (createBuffer — журналируемый
 *  DeclOp; replay после device-loss восстанавливает пустое хранилище, sync
 *  перезаливает содержимое). Грязный диапазон — bufferSubData одним вызовом. */
export function createRendererFeedGL(gl: GLFacade, options: RendererFeedOptions | TransportFeedView): RendererFeed {
  const core = createFeedCore(options)
  const bufferId = gl.createBuffer(core.view.bytes()) // хранилище capacity*stride
  let disposed = false

  function sync(): void {
    if (disposed) return
    // Task 75: count транспорта может сообщить больше capacity только при
    // баге писателя — clamp держит инвариант «загружаем не больше буфера».
    const published = Math.min(core.view.count(), core.capacity)
    if (published > core.synced) {
      const strideF = core.stride / 4
      const bytes = core.view.bytes()
      // Грязный диапазон [synced, published) — ОДИН bufferSubData (§4.3).
      gl.updateBuffer(bufferId, bytes.subarray(core.synced * strideF, published * strideF), core.synced * core.stride)
      core.synced = published
      core.countSignal.value = published
    }
    core.view.recycle() // T3: ping-pong возврат
  }

  return {
    get channel() { return core.channel },
    get count() { return core.countSignal },
    get stride() { return core.stride },
    get capacity() { return core.capacity },
    attribute: (field, step) => {
      const info = requireField(core, field)
      return { data: core.view.bytes(), size: info.size, stride: core.stride, offset: info.offset, bufferId, step: step ?? 'vertex' }
    },
    storage: {
      data: core.view.bytes(),
      stride: core.stride,
      count: core.countSignal,
    },
    applyChunks: chunks => { core.msgReader?.apply(chunks) },
    takeRecycled: () => core.msgReader?.takeRecycled() ?? [],
    sync,
    dispose: () => {
      if (disposed) return
      disposed = true
      gl.deleteBuffer(bufferId)
    },
  }
}

// ────────────────────────── WebGPU ──────────────────────────

/** Фид рендерера на WebGPU: keyed-буфер по стабильной Float32Array view
 *  (создаётся syncVertexBuffer'ом), writeBuffer одним вызовом на кадр.
 *  Device-loss: свежий фасад → keyed-кэш пуст → первый sync пересоздаст. */
export function createRendererFeedGPU(gpu: GPUFacade, options: RendererFeedOptions | TransportFeedView): RendererFeed {
  const core = createFeedCore(options)
  let disposed = false

  function sync(): void {
    if (disposed) return
    // Task 75: clamp до capacity — writeBuffer никогда не превышает буфер
    // (страховка от писателя с нарушенным инвариантом count ≤ capacity).
    const published = Math.min(core.view.count(), core.capacity)
    if (published > core.synced) {
      // Грязный диапазон [0, published*stride) — ОДИН writeBuffer (append-only).
      gpu.syncVertexBuffer(core.view.bytes(), published * core.stride)
      core.synced = published
      core.countSignal.value = published
    }
    core.view.recycle() // T3: ping-pong возврат
  }

  return {
    get channel() { return core.channel },
    get count() { return core.countSignal },
    get stride() { return core.stride },
    get capacity() { return core.capacity },
    attribute: (field, step) => {
      const info = requireField(core, field)
      // WebGPU: интерливинг живёт в пайплайне ({size, stride, offset, step});
      // биндинг — bindVertexBuffer(slot, data) по стабильному view.
      return { data: core.view.bytes(), size: info.size, stride: core.stride, offset: info.offset, step: step ?? 'vertex' }
    },
    storage: {
      data: core.view.bytes(),
      stride: core.stride,
      count: core.countSignal,
    },
    applyChunks: chunks => { core.msgReader?.apply(chunks) },
    takeRecycled: () => core.msgReader?.takeRecycled() ?? [],
    sync,
    dispose: () => {
      // Keyed-буфер живёт в фасаде (dispose фасада чистит всё).
      disposed = true
    },
  }
}

function requireField(core: FeedCore, field: string): FieldInfo {
  const info = core.fields.get(field)
  if (info === undefined) {
    throw new Error(`rune: поле фида "${field}" не объявлено в layout`)
  }
  return info
}
