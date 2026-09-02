/**
 * Inter-thread transports T0–T3 (dossier §7.2, M5).
 *
 *   T0 memory    one thread — regular signals, synchronous.
 *   T1 sab+async SAB + Atomics.waitAsync — seqlock + futex for rare waits.
 *   T2 sab       SAB without waitAsync (old Safari) — seqlock + epochs;
 *                MessageChannel wake-up is the shell's concern, not the core's.
 *   T3 msg       no cross-origin isolation — signal deltas are batched into
 *                one message per frame; feed — ping-pong transferable.
 *
 * Degradation invariant (dossier, Contract 3): share / shared / feed are
 * written once — only the propagation latency changes, not the semantics.
 *
 * Ownership model: HOST — the writer side (slot owner: the shell for
 * app.size/visibility, the game worker for scene data); CLIENT — the
 * reader side (render world, GPU owner). One slot — one writer (seqlock);
 * feeds — workers write into a shared ring, the reader takes the counter
 * at the frame boundary (epoch).
 */

import type { ReadableSignal, Unsubscribe } from '../signal/types.ts'
import { signal } from '../signal/signal.ts'
import type { SignalCell } from '../signal/signal.ts'
import { createSharedRegistry, attachSharedRegistry, nameHash } from './sharedRegistry.ts'
import type { SharedMirror } from './sharedRegistry.ts'
import { createFeed, feedStride } from '../feed/feed.ts'
import type { Feed, FeedLayout, FeedPolicy, FeedWriter } from '../feed/feed.ts'

/** Transport mode (T0–T3 dossier, Table 4). */
export type TransportMode = 'memory' | 'sab+async' | 'sab' | 'msg'

/** Environment probes for detectTransport (injection in tests). */
export interface TransportProbe {
  readonly sharedArrayBuffer?: boolean
  readonly waitAsync?: boolean
}

/** Picks a transport by environment: SAB+waitAsync → T1, SAB → T2, otherwise T3.
 *  T0 ('memory') — an explicit single-world choice; auto-detect never returns it. */
export function detectTransport(probe?: TransportProbe): TransportMode {
  const hasSab = probe?.sharedArrayBuffer ?? typeof SharedArrayBuffer !== 'undefined'
  if (!hasSab) return 'msg'
  const hasWaitAsync = probe?.waitAsync
    ?? (typeof Atomics !== 'undefined' && typeof (Atomics as { waitAsync?: unknown }).waitAsync === 'function')
  return hasWaitAsync ? 'sab+async' : 'sab'
}

/** Is SAB available in this world? (T1/T2 versus T3.) */
export function hasSharedArrayBuffer(): boolean {
  return typeof SharedArrayBuffer !== 'undefined'
}

// ────────────────────────── T3: frame message ──────────────────────────

/** A feed chunk in a frame message: bytes of records [from, from+count).
 *  bytes — transferable (ping-pong: the reader returns it via recycle). */
export interface TransportFeedChunk {
  readonly feedId: number
  readonly from: number
  readonly count: number
  readonly bytes: ArrayBuffer
}

/** One message per frame (T3): signal deltas + feed chunks. */
export interface TransportFrameMessage {
  readonly kind: 'rune.transport.frame'
  readonly deltas: ReadonlyArray<readonly [hash: number, value: number]>
  readonly chunks: ReadonlyArray<TransportFeedChunk>
}

// ───────────────────── Reader-side feed ─────────────────────

/** Reader-side feed: a snapshot of published records for the GPU.
 *  T1/T2 — a stable view over the SAB (the counter is atomic);
 *  T3 — a mirror filled by apply() from ping-pong chunks;
 *  T0 — a view over a regular buffer.
 *  layout (M5): an optional record schema — for the feed renderer's
 *  dual-bind attribute(field); filled in by all transports. */
export interface TransportFeedView {
  readonly feedId: number
  readonly stride: number
  readonly capacity: number
  /** Record schema (name → format) — for the feed's attribute(). */
  readonly layout?: FeedLayout
  /** Number of published records (a snapshot at call time). */
  count(): number
  /** Bytes of records [0, count): stable identity (the GPU cache keys on it). */
  bytes(): Float32Array
  /** T3: return ping-pong buffers to the owner after uploading to the GPU. */
  recycle(): void
}

// ────────────────────────── Host (writer) ──────────────────────────

export interface TransportHost {
  readonly mode: TransportMode
  /** Bind a source signal to a slot (owner-writer). */
  share(source: ReadableSignal<number>, name: string): Unsubscribe
  /** Direct write into a slot (smoothed sources, tests). */
  write(name: string, value: number): void
  /** Create a feed: SAB in T1/T2, local in T0, ping-pong in T3. */
  createFeed(options: { layout: FeedLayout; capacity: number; policy?: FeedPolicy }): Feed
  /** T3: batch of deltas and chunks since the last flush (one message per frame).
   *  Non-T3 → null: propagation is sampling, not messages. */
  flush(): TransportFrameMessage | null
  /** T3: accept a ping-pong buffer returned by the reader. */
  reclaim(chunk: TransportFeedChunk): void
  /** Descriptor for another world: SAB modes transfer buffers,
   *  T3 — schema only (messages travel over the user's postMessage). */
  describe(): TransportDescriptor
}

export interface TransportDescriptor {
  readonly mode: TransportMode
  readonly names: readonly string[]
  /** T1/T2: the signal registry SAB. */
  readonly signals?: ArrayBufferLike
  /** Owner feeds: T1/T2 — with buffers; T3 — metadata only. */
  readonly feeds?: ReadonlyArray<TransportFeedMeta>
}

/** Feed metadata for another world. */
export interface TransportFeedMeta {
  readonly id: number
  readonly layout: FeedLayout
  readonly capacity: number
  readonly buffer?: ArrayBufferLike
}

// ────────────────────────── Client (reader) ──────────────────────────

export interface TransportClient {
  readonly mode: TransportMode
  /** Slot mirror signal: reads are always fresh, notifications — sampleAll. */
  shared(name: string): ReadableSignal<number>
  /** Frame boundary: notify subscribers of changed slots; their count. */
  sampleAll(): number
  /** T3: apply a frame message (deltas + chunks). */
  apply(message: TransportFrameMessage): void
  /** T3: buffers ready to be returned to the writer (after view's recycle).
   *  Cross-thread: the user posts them back and calls host.reclaim. Non-T3 → []. */
  takeRecycled(): ReadonlyArray<TransportFeedChunk>
  /** Reader feed by id (null — not created/attached). */
  feed(feedId: number): TransportFeedView | null
  /** Attach a feed (T3 mirror; SAB — from descriptor). Creates the view itself. */
  attachFeed(feedId: number, layout: FeedLayout, capacity: number): TransportFeedView
  /** T1: a rare wait for a slot change (futex over the version word).
   *  Non-T1 → false. true — the version changed (the wakeup happened). */
  waitForChange(name: string, timeoutMs?: number): Promise<boolean>
}

/** A host+client bundle in one world (T0, same-thread scenarios, tests). */
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
    // T0: cells are shared — shared() returns the source itself (synchronously).
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
    flush: () => null, // sampling, not messages
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

/** Host on the writer side (for a cross-thread bundle without a pair). */
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

/** Client from a descriptor passed into the reader world
 *  (SAB is serialized by structured clone under cross-origin isolation). */
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

/** T0: writing into a cell — a direct signal (synchronous, no messages). */
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
    apply: () => { /* SAB: sampling in sampleAll, nothing to apply */ },
    takeRecycled: () => [], // SAB: buffers are shared
    feed: id => views.get(id) ?? sabViewFromMeta(feedMeta, id, views),
    attachFeed: (id, layout, capacity) => {
      const known = views.get(id)
      if (known !== undefined) return known
      const meta = feedMeta.get(id)
      if (meta === undefined || meta.buffer === undefined) {
        throw new Error(`rune: SAB feed ${id} is not described in the descriptor — pass buffer`)
      }
      const view = sabFeedView(id, meta.buffer, layout, capacity)
      views.set(id, view)
      return view
    },
    waitForChange: (name, timeoutMs) => waitSlotChange(mirror, signals as SharedArrayBuffer, names, name, timeoutMs),
  }
}

/** Lazy SAB view: host.createFeed after pair creation — the client takes it by id. */
function sabViewFromMeta(feedMeta: Map<number, TransportFeedMeta>, id: number, views: Map<number, TransportFeedView>): TransportFeedView | null {
  const meta = feedMeta.get(id)
  if (meta === undefined || meta.buffer === undefined) return null
  const view = sabFeedView(id, meta.buffer, meta.layout, meta.capacity)
  views.set(id, view)
  return view
}

/** Stable view over the feed's SAB ring (HEADER 64 bytes — as in feed.ts). */
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
    recycle: () => { /* the buffer is shared — nothing to return */ },
  }
}

/** T1: futex wait for a slot change — Atomics.waitAsync over the seqlock's
 *  version word (any version change is a wakeup; the stable value is picked
 *  up by readSeqlock with retries in mirror.signal()).
 *  LE-compatible: browser platforms are little-endian, the registry writes LE. */
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
  const expected = i32[index] // current version (even = at rest)
  const res = Atomics.waitAsync(i32, index, expected, timeoutMs)
  if (res.async) await res.value
  return probe.version !== before
}

/** Index of the seqlock version Int32 word (slot layout: 32 + i*16 + 4). */
function versionWordIndex(names: readonly string[], name: string): number {
  const at = names.indexOf(name)
  if (at < 0) throw new Error(`rune: signal "${name}" is not registered`)
  return (32 + at * 16 + 4) >> 2
}

// ────────────────────────── T3: msg ──────────────────────────

interface MsgSlot {
  value: number
  hash: number
  dirty: boolean
}

/** T3 ping-pong feed core: buffers travel writer → reader → writer. */
interface MsgFeedCore {
  readonly layout: FeedLayout
  readonly capacity: number
  readonly stride: number
  /** Pool of buffers returned by the reader. */
  pool: ArrayBuffer[]
  /** Current write buffer (leaves as a chunk on flush). */
  current: ArrayBuffer
  /** f32/u8 views of `current` — refreshed on the flush swap, so a field
 *  write NEVER allocates a view (Task 114). */
  f32: Float32Array
  u8: Uint8Array
  /** Records written into current. */
  written: number
  /** Logical offset of current's first record. */
  base: number
  /** Total records shipped out as chunks. */
  shipped: number
  /** Logical published (after publish()). */
  published: number
}

/** T3 feed mirror on the reader side (stride/capacity are its own). */
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
  /** Reader mirrors (same-thread pair / attachTransport by metadata). */
  mirrors: Map<number, MsgMirror>
  /** Chunks returned by the reader (pending → pool on flush). */
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
  // Task 114 — hash index: a delta applies through ONE Map lookup instead
  // of re-hashing every registered name per delta (D×N string hashes/frame).
  // A bucket holds every cell whose name hashes to the key — the old scan
  // set ALL of them on a match, collisions included; the bucket keeps that.
  const hashIndex = new Map<number, SignalCell<number>[]>()
  for (const name of state.names) {
    const cell = signal(0)
    cells.set(name, cell)
    versions.set(name, 0)
    const hash = nameHash(name)
    const bucket = hashIndex.get(hash)
    if (bucket === undefined) hashIndex.set(hash, [cell])
    else bucket.push(cell)
  }
  const views = new Map<number, TransportFeedView>()
  for (const [id, entry] of state.mirrors) views.set(id, mirrorFeedView(state, id, entry))
  return {
    mode: 'msg',
    shared: name => {
      const cell = cells.get(name)
      if (cell === undefined) throw new Error(`rune: signal "${name}" is not registered`)
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
        const targets = hashIndex.get(hash)
        if (targets === undefined) continue
        for (const cell of targets) cell.value = value
      }
      for (const chunk of message.chunks) {
        const entry = state.mirrors.get(chunk.feedId)
        if (entry === undefined) continue
        applyChunkBytes(entry, chunk)
        entry.count = Math.max(entry.count, chunk.from + chunk.count)
        entry.pending.push(chunk)
      }
    },
    feed: id => views.get(id) ?? mirrorFromCore(state, id, views),
    takeRecycled: () => {
      // Ping-pong return: view's recycle() puts applied chunks here.
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
    waitForChange: () => Promise.resolve(false), // T3: latency is up to 1 frame, nothing to wait with
  }
}

/** Lazy mirror of a same-thread pair: host.createFeed → the client takes a view by id. */
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
  // Ping-pong: first return the reader's buffers to the pool.
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
    // The buffer swapped — refresh the writer's views (Task 114: the views
    // live on the core, not per write).
    core.f32 = new Float32Array(core.current)
    core.u8 = new Uint8Array(core.current)
    core.base += core.written
    core.shipped += core.written
    core.written = 0
  }
  if (deltas.length === 0 && chunks.length === 0) return null
  return { kind: 'rune.transport.frame', deltas, chunks }
}

/** T3 writer feed facade: append-only (push/publish), view — within the current window. */
function msgFeedFacade(state: MsgState, feedOptions: { layout: FeedLayout; capacity: number; policy?: FeedPolicy }, forcedId?: number): Feed {
  const id = forcedId ?? state.nextFeedId
  if (forcedId === undefined) state.nextFeedId++
  else state.nextFeedId = Math.max(state.nextFeedId, forcedId + 1)
  const stride = feedStride(feedOptions.layout)
  const current = new ArrayBuffer(feedOptions.capacity * stride)
  const core: MsgFeedCore = {
    layout: feedOptions.layout,
    capacity: feedOptions.capacity,
    stride,
    pool: [],
    current,
    f32: new Float32Array(current),
    u8: new Uint8Array(current),
    written: 0,
    base: 0,
    shipped: 0,
    published: 0,
  }
  state.feeds.set(id, core)
  // Task 114 — ONE writer per feed, re-aimed by view()/push() (the same
  // contract as feed.ts): `wFrom` is mutable closure state, the entry object
  // is stable for the feed's lifetime (only its buffer swaps on flush), so
  // every set* is a direct scalar write — no boxed [x,y,z,w] array, no fresh
  // Float32Array/Uint8Array view, no Map lookup for the core (previously
  // PER FIELD WRITE: 2 allocations + a feeds.get(id) round-trip).
  let wFrom = 0
  const writer: FeedWriter = {
    setFloat: (name, index, value) => {
      const c = core
      const at = msgFieldAt(c, name, wFrom + index)
      c.f32[at >> 2] = value
    },
    setVec2: (name, index, x, y) => {
      const c = core
      const at = msgFieldAt(c, name, wFrom + index)
      const f = at >> 2
      c.f32[f] = x
      c.f32[f + 1] = y
    },
    setVec3: (name, index, x, y, z) => {
      const c = core
      const at = msgFieldAt(c, name, wFrom + index)
      const f = at >> 2
      c.f32[f] = x
      c.f32[f + 1] = y
      c.f32[f + 2] = z
    },
    setVec4: (name, index, x, y, z, w) => {
      const c = core
      const at = msgFieldAt(c, name, wFrom + index)
      const f = at >> 2
      c.f32[f] = x
      c.f32[f + 1] = y
      c.f32[f + 2] = z
      c.f32[f + 3] = w
    },
    setVec4Bytes: (name, index, r, g, b, a) => {
      const c = core
      const at = msgFieldAt(c, name, wFrom + index)
      c.u8[at] = r
      c.u8[at + 1] = g
      c.u8[at + 2] = b
      c.u8[at + 3] = a
    },
  }
  return {
    get buffer() { return core.current },
    get capacity() { return core.capacity },
    get stride() { return stride },
    view: (from, count) => {
      const local = from - core.base
      if (local < 0 || from + count > core.base + core.capacity) {
        throw new Error(`rune: T3 feed is append-only — view(${from},${count}) is outside the window [${core.base}, ${core.base + core.capacity})`)
      }
      // The write window expands to cover it (parity with the SAB view).
      if (local + count > core.written) core.written = local + count
      wFrom = from
      return writer
    },
    push: count => {
      const from = core.base + core.written
      // Task 75: the logical window boundary — base+written never goes past
      // capacity (the reader's mirror is physically capacity*stride bytes).
      // Previously only the written window was checked — the logical index
      // grew past the mirror's boundary, the reader's count exceeded capacity
      // → writeBuffer larger than the buffer. Now drop-new is conservative
      // by LOGICAL index.
      if (core.base + core.written + count > core.capacity) {
        wFrom = from
        return writer
      }
      core.written += count
      wFrom = from
      return writer
    },
    publish: () => {
      core.published = core.base + core.written
    },
    publishedCount: () => core.published,
  }
}

/** Byte offset of a field inside the core's current buffer, with the window
 *  check (the only shared validation of a T3 field write). */
function msgFieldAt(c: MsgFeedCore, name: string, logicalIndex: number): number {
  const fieldAt = byteOffsets(c.layout).get(name)
  if (fieldAt === undefined) throw new Error(`rune: feed field "${name}" is not declared`)
  const local = logicalIndex - c.base
  if (local < 0 || local >= c.capacity) {
    throw new Error(`rune: T3 feed is append-only — index ${logicalIndex} is outside the window [${c.base}, ${c.base + c.capacity})`)
  }
  return local * c.stride + fieldAt
}

/** Copies a delivered chunk's bytes into a mirror — ONE memcpy (set) instead
 *  of the per-element triple loop. Bounds are clamped defensively: in-tree
 *  the Task 75 window invariant guarantees a full fit, out-of-tree a hostile
 *  chunk silently truncates (the old loop's OOB semantics were NaN garbage). */
function applyChunkBytes(entry: MsgMirror, chunk: TransportFeedChunk): void {
  const src = new Float32Array(chunk.bytes)
  const strideF = entry.stride / 4
  const dstAt = chunk.from * strideF
  const fitF = Math.min(chunk.count * strideF, src.length, Math.max(0, entry.mirror.length - dstAt))
  if (fitF > 0) entry.mirror.set(src.subarray(0, fitF), dstAt)
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

/** T3 mirror view: count moves via apply, recycle returns the buffers. */
function mirrorFeedView(state: MsgState, feedId: number, entry: MsgMirror): TransportFeedView {
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

// ───────────────────── Standalone T3 feed (without a transport) ─────────────────────

/** T3 ping-pong feed writer (worker): push/publish, ship() takes the chunks. */
export interface MsgFeedWriterHandle {
  readonly feed: Feed
  /** Take the not-yet-shipped records as one array of chunks (transferable). */
  ship(): TransportFeedChunk[]
  /** Return the reader's buffers to the pool (after its recycle message). */
  reclaim(chunks: ReadonlyArray<TransportFeedChunk>): void
}

/** T3 ping-pong feed reader (render world): mirror + count. */
export interface MsgFeedReaderHandle {
  readonly view: TransportFeedView
  /** Apply a message's chunks (order — as in ship/flush). */
  apply(chunks: ReadonlyArray<TransportFeedChunk>): void
  /** Chunks ready to be returned to the writer (after upload to the GPU). */
  takeRecycled(): TransportFeedChunk[]
}

/** Creates a ping-pong feed writer in the worker world (T3, standalone). */
export function createMsgFeedWriter(feedId: number, options: { layout: FeedLayout; capacity: number; policy?: FeedPolicy }): MsgFeedWriterHandle {
  const state = createMsgState([])
  const facade = msgFeedFacade(state, options, feedId)
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

/** Creates a ping-pong feed reader in the render world (T3, standalone). */
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
        applyChunkBytes(entry, chunk)
        // Task 75: the mirror's count cannot exceed capacity (records past
        // the mirror's physical limit are ignored by TypedArray semantics,
        // the counter must follow).
        entry.count = Math.min(Math.max(entry.count, chunk.from + chunk.count), options.capacity)
        entry.pending.push(chunk)
      }
    },
    takeRecycled: () => {
      // Drain of the return queue: recycle() puts applied chunks here.
      const out = [...state.recycled]
      state.recycled.length = 0
      return out
    },
  }
}

// ────────────────────────── Shared utilities ──────────────────────────

function signalClient(mode: TransportMode, cells: Map<string, SignalCell<number>>): TransportClient {
  return {
    mode,
    shared: name => {
      const cell = cells.get(name)
      if (cell === undefined) throw new Error(`rune: signal "${name}" is not registered`)
      return cell
    },
    sampleAll: () => 0, // T0: notifications flow through the signal graph synchronously
    apply: () => {},
    takeRecycled: () => [],
    feed: () => null,
    attachFeed: () => {
      throw new Error('rune: T0 feeds are not registered by the transport — the channel is shared')
    },
    waitForChange: () => Promise.resolve(false),
  }
}

function requireCell(cells: Map<string, SignalCell<number>>, name: string): SignalCell<number> {
  const cell = cells.get(name)
  if (cell === undefined) throw new Error(`rune: signal "${name}" is not registered`)
  return cell
}

function requireName(names: readonly string[], name: string): void {
  if (!names.includes(name)) throw new Error(`rune: signal "${name}" is not registered`)
}

function requireMsgSlot(state: MsgState, name: string): MsgSlot {
  const slot = state.slots.get(name)
  if (slot === undefined) throw new Error(`rune: signal "${name}" is not registered`)
  return slot
}
