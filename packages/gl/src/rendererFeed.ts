/**
 * RendererFeed (M5, Task 73): the dual-bind feed on the renderer side.
 *
 * Dossier §4.3: the feed channel is bound in two ways simultaneously — as a
 * vertex attribute stream (interleaved records: field stride/offset) and as a
 * GPU array of structs (storage on WebGPU / UBO std140 on WebGL2 —
 * shader-binding plumbing — M2 renderer.buffer(); here the data is ready).
 *
 * Frame boundary (§7.2): the renderer reads the atomic published counter and
 * uploads the DIRTY RANGE with a single call (GL: bufferSubData;
 * WebGPU: queue.writeBuffer). Count is a signal (u_lightCount).
 *
 * Transport invariant: the channel is the same in T0/T1/T2 (SAB/local ring,
 * .buffer is passed to the worker); in T3 — ping-pong (worker:
 * createMsgFeedWriter, chunks arrive via applyChunks, buffers are returned
 * via takeRecycled).
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

/** Options for creating a renderer feed. */
export interface RendererFeedOptions {
  readonly layout: FeedLayout
  readonly capacity: number
  readonly policy?: FeedPolicy
  /** Transport mode of the channel. Default: SAB detection of the environment
   *  (T1/T2), without SAB — T3 (msg ping-pong). 'memory' — a single world. */
  readonly mode?: TransportMode
}

/** Vertex path: record field binding for the attributes of a spec. */
export interface FeedAttributeBinding {
  readonly data: Float32Array
  readonly size: number
  readonly stride: number
  readonly offset: number
  /** GL: the feed's external GPU buffer (the executor does not create its own). */
  readonly bufferId?: number
  /** Task 75: record sampling step — 'instance' (star quads: one record
   *  = one instance, quad corners are derived from vertex_index in the shader)
   *  | 'vertex' (default — a vertex soup, as in the triangle galaxy). */
  readonly step?: 'vertex' | 'instance'
}

/** Storage path: an array of structs as a single buffer. */
export interface RendererFeedStorage {
  readonly data: Float32Array
  readonly stride: number
  readonly count: ReadableSignal<number>
}

export interface RendererFeed {
  /** Writer's channel (T0/T1/T2): hand .buffer to the worker (attachFeed) or
   *  write yourself. null in T3 — the writer lives in the worker (createMsgFeedWriter). */
  readonly channel: Feed | null
  /** Published record count — a signal (u_lightCount, instances). */
  readonly count: ReadableSignal<number>
  readonly stride: number
  readonly capacity: number
  /** Vertex path: interleaved field binding (attributes of a spec). */
  attribute(field: string, step?: 'vertex' | 'instance'): FeedAttributeBinding
  /** Storage path: an array of structs (std140 plumbing — M2 buffer()). */
  readonly storage: RendererFeedStorage
  /** T3: apply the writer's chunks (delivery — the user's postMessage). */
  applyChunks(chunks: ReadonlyArray<TransportFeedChunk>): void
  /** T3: buffers ready to be returned to the writer (after uploading to the GPU). */
  takeRecycled(): TransportFeedChunk[]
  /** Frame boundary (called by the renderer): dirty range → GPU in one call. */
  sync(): void
  dispose(): void
}

/** FeedId for the T3 reader (the renderer world knows its feed). */
const MSG_FEED_ID = 1

/** A layout field: byte offset + size in components. */
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

/** A view over the core feed (T0/T1/T2): stable bytes + an atomic counter. */
function coreFeedView(feed: Feed, feedId: number): TransportFeedView {
  const u32 = new Uint32Array(feed.buffer)
  const bytes = new Float32Array(feed.buffer, 64, (feed.capacity * feed.stride) / 4)
  return {
    feedId,
    stride: feed.stride,
    capacity: feed.capacity,
    count: () => Atomics.load(u32, 1),
    bytes: () => bytes,
    recycle: () => { /* shared buffer — nothing to return */ },
  }
}

/** The common part of a renderer feed: channel + view + count + dirty tracking. */
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
  // An external (transport-bound) view: has count()/bytes(); the layout
  // is carried by the view itself (all transports fill it in — attribute() works).
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
    // T3: the render world is a ping-pong reader (the writer is createMsgFeedWriter
    // in the worker, the same layout/capacity; chunk delivery — applyChunks).
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

/** WebGL2 renderer feed: a GPU buffer through the facade (createBuffer — a journaled
 *  DeclOp; replay after device-loss restores empty storage, sync
 *  refills the contents). Dirty range — one bufferSubData call. */
export function createRendererFeedGL(gl: GLFacade, options: RendererFeedOptions | TransportFeedView): RendererFeed {
  const core = createFeedCore(options)
  const bufferId = gl.createBuffer(core.view.bytes()) // capacity*stride storage
  let disposed = false

  function sync(): void {
    if (disposed) return
    // Task 75: the transport's count can exceed capacity only when the writer
    // is buggy — the clamp keeps the invariant "we upload no more than the buffer holds".
    const published = Math.min(core.view.count(), core.capacity)
    if (published > core.synced) {
      const strideF = core.stride / 4
      const bytes = core.view.bytes()
      // Dirty range [synced, published) — ONE bufferSubData (§4.3).
      gl.updateBuffer(bufferId, bytes.subarray(core.synced * strideF, published * strideF), core.synced * core.stride)
      core.synced = published
      core.countSignal.value = published
    }
    core.view.recycle() // T3: ping-pong return
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

/** WebGPU renderer feed: a keyed buffer keyed by the stable Float32Array view
 *  (created by syncVertexBuffer), one writeBuffer per frame.
 *  Device-loss: a fresh facade → the keyed cache is empty → the first sync re-creates it. */
export function createRendererFeedGPU(gpu: GPUFacade, options: RendererFeedOptions | TransportFeedView): RendererFeed {
  const core = createFeedCore(options)
  let disposed = false

  function sync(): void {
    if (disposed) return
    // Task 75: clamp to capacity — writeBuffer never exceeds the buffer
    // (protection against a writer violating the count ≤ capacity invariant).
    const published = Math.min(core.view.count(), core.capacity)
    if (published > core.synced) {
      // Dirty range [0, published*stride) — ONE writeBuffer (append-only).
      gpu.syncVertexBuffer(core.view.bytes(), published * core.stride)
      core.synced = published
      core.countSignal.value = published
    }
    core.view.recycle() // T3: ping-pong return
  }

  return {
    get channel() { return core.channel },
    get count() { return core.countSignal },
    get stride() { return core.stride },
    get capacity() { return core.capacity },
    attribute: (field, step) => {
      const info = requireField(core, field)
      // WebGPU: interleaving lives in the pipeline ({size, stride, offset, step});
      // the binding is bindVertexBuffer(slot, data) over the stable view.
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
      // The keyed buffer lives in the facade (disposing the facade cleans everything).
      disposed = true
    },
  }
}

function requireField(core: FeedCore, field: string): FieldInfo {
  const info = core.fields.get(field)
  if (info === undefined) {
    throw new Error(`rune: feed field "${field}" is not declared in the layout`)
  }
  return info
}
