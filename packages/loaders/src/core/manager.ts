/**
 * core/manager.ts — LoadManager: a general-purpose loader with "broad settings".
 *
 * What it can do:
 *  - priority queue (numeric Priority + anti-starvation aging);
 *  - concurrency limit by task count AND by bytes in flight (maxInflightBytes);
 *  - progress (content-length/expectedBytes + from the parser), 50 ms throttling;
 *  - cancellation: handle.cancel() / external AbortSignal / group / dispose,
 *    cascading onto child resolveExternal tasks;
 *  - retries (network/5xx/429/timeout) with backoff; an attempt is counted
 *    AFTER the first one (retries=0 → no retries at all);
 *  - groups: enough(N) — "N out of M is enough, the rest in the background"
 *    + demoting the remainder's priority, waitAll/settleAll, aggregated progress;
 *  - resolveExternal: glTF .bin / OBJ .mtl / textures are loaded by child
 *    tasks IN PARALLEL with the parent and the other traffic.
 *
 * Concurrency slot semantics: only the network phase holds a slot (and the
 * byte reservation). Once the stream is downloaded (or the bytes were ready
 * immediately), the slot is released BEFORE parse()/finish() — parse, inside
 * which resolveExternal runs, does not hold the slot and creates no deadlock
 * at concurrency=1. A network-phase retry also recreates the streaming sink
 * (a fresh session).
 */

import type {
  ImageDecode,
  LoadHandle,
  LoadOptions,
  LoadPhase,
  LoadProgress,
  LoadSource,
  NormalizedSource,
  ParseContext,
  Parser,
  ParserRegistry,
  StreamTransform,
  UrlResolver,
} from './types.ts'
import { Priority } from './types.ts'
import { LoadError, abortError, isAbortError } from './errors.ts'
import { resolvePlatformCaps } from './util.ts'
import { normalizeSource, responseTotalBytes } from './source.ts'
import { streamToAsyncIterable, readAllBytes, composeTransforms } from './pipe.ts'
import { bytesParser } from '../formats/config.ts'
import { createParserRegistry, sniffKind } from '../registry.ts'

// ─── public types ──────────────────────────────────────────────────────────

export interface LoadManagerOptions {
  fetchImpl?: typeof fetch
  resolveUrl?: UrlResolver
  /** zlib-inflate for FBX; null forbids it. Default: DecompressionStream. */
  inflate?: ((bytes: Uint8Array) => Promise<Uint8Array>) | null
  /** Image decoder for the builtin image parser. Default: createImageBitmap. */
  decodeImage?: ImageDecode | null
  /** Parallel network tasks. Default 6. */
  concurrency?: number
  /** "In flight" byte budget (reserved by content-length/expected). Default ∞. */
  maxInflightBytes?: number
  /** Default timeoutMs of the fetch phase. Default: none. */
  defaultTimeoutMs?: number
  /** Default retries. Default 0. */
  defaultRetries?: number
  /**
   * Anti-starvation: waiting priority grows by this amount per second.
   * Prefetch(0) catches up with normal(50) in 500 s at 0.1. Default 0.1; 0 — off.
   */
  agingPerSecond?: number
  /** Parser registry by kind. Default — builtin (registry.ts). */
  parsers?: ParserRegistry
  now?: () => number
}

export interface LoadManagerStats {
  queued: number
  active: number
  done: number
  failed: number
  cancelled: number
  /** Reserved bytes of active network phases. */
  inflightBytes: number
  /** Total bytes downloaded over the manager's lifetime. */
  bytesReceived: number
  tasks: number
}

export interface GroupProgress {
  readonly total: number
  readonly done: number
  readonly failed: number
  readonly cancelled: number
  readonly active: number
  readonly queued: number
  readonly receivedBytes: number
  /** Sum of the known totalBytes; null if at least one is unknown. */
  readonly totalBytes: number | null
  /** Byte-weighted fraction (falls back to a count at zero weights). */
  readonly fraction: number
}

export interface EnoughOptions {
  /**
   * Where to demote not-yet-started remainders once the quorum is reached.
   * Default Priority.prefetch; null — do not demote.
   */
  demoteRemainingTo?: number | null
}

export interface SettledResult {
  readonly value?: unknown
  readonly error?: unknown
  readonly cancelled?: boolean
}

export interface LoadGroup {
  readonly name: string
  /** Add a task to the group (the group's defaultPriority if not given). */
  add<S, O = unknown>(source: LoadSource, options?: LoadOptions<S, O>): LoadHandle<S>
  /** Resolves when ≥count assets are ready; the remainder is demoted to the background. */
  enough(count: number, options?: EnoughOptions): Promise<unknown[]>
  /** Everything or an AggregateError with all errors. */
  waitAll(): Promise<unknown[]>
  /** Everything with errors in place (no throw). */
  settleAll(): Promise<SettledResult[]>
  /** Aggregated group progress. */
  readonly progress: GroupProgress
  cancelAll(): void
  /** Change the priority of the group's not-yet-started tasks. */
  setPriority(priority: number): void
  readonly handles: readonly LoadHandle<unknown>[]
}

export interface LoadManager {
  /** Load a single asset. kind/parser/sniff pick the parser. */
  load<T, O = unknown>(source: LoadSource, options?: LoadOptions<T, O>): LoadHandle<T>
  /** Raw bytes by URL (sugar + the path for resolveExternal). */
  loadBytes(url: string, options?: LoadOptions<Uint8Array, void>): LoadHandle<Uint8Array>
  /** A task group: progress, enough(N) quorum, cancellation. */
  group(name?: string, options?: { defaultPriority?: number }): LoadGroup
  /** Register/override a parser by kind. */
  registerParser(kind: string, parser: Parser<any, any>): void
  setConcurrency(n: number): void
  /** Wait for an empty queue and no active tasks. */
  drain(): Promise<void>
  stats(): LoadManagerStats
  /** Remove terminal tasks from stats (after prune, handles only have ready). */
  pruneTerminal(): void
  /** Cancel everything and close the manager. */
  dispose(): void
  readonly disposed: boolean
}

// ─── implementation ──────────────────────────────────────────────────────────────

const PROGRESS_EMIT_INTERVAL_MS = 50
const DEFAULT_RESERVE_BYTES = 2 * 1024 * 1024
const MIN_CONCURRENCY = 1

interface Task {
  readonly id: number
  readonly seq: number
  group: GroupImpl | null
  state: LoadPhase
  priority: number
  readonly source: NormalizedSource
  readonly parser: Parser<any, any>
  readonly parserOptions: unknown
  readonly transforms: StreamTransform[]
  readonly onProgress: ((p: LoadProgress) => void) | undefined
  readonly retries: number
  readonly retryDelayMs: number | ((attempt: number) => number)
  readonly timeoutMs: number | undefined
  readonly expectedBytes: number | null
  controller: AbortController
  readonly externalSignal: AbortSignal | null
  receivedBytes: number
  totalBytes: number | null
  fraction: number | null
  promise: Promise<unknown>
  resolveRaw: (value: any) => void
  rejectRaw: (err: unknown) => void
  settledValue: unknown
  settledError: unknown
  enqueuedAt: number
  attempt: number
  active: boolean
  holdsSlot: boolean
  reservedBytes: number
  timedOut: boolean
  readonly url: string | null
  lastEmitAt: number
  lastEmitPhase: LoadPhase
}

/** Fetch-phase outcome: bytes | already resolved by a streaming parser. */
type FetchOutcome = Uint8Array | { readonly streamed: true }

interface GroupImpl {
  readonly name: string
  readonly tasks: Task[]
  defaultPriority: number
  enoughNotifiers: Set<() => void>
  enoughDemoted: boolean
}

export function createLoadManager(options: LoadManagerOptions = {}): LoadManager {
  const caps = resolvePlatformCaps({
    fetchImpl: options.fetchImpl,
    resolveUrl: options.resolveUrl,
    inflate: options.inflate,
    decodeImage: options.decodeImage,
  })
  const now = options.now ?? (() => Date.now())
  let concurrency = Math.max(MIN_CONCURRENCY, options.concurrency ?? 6)
  const maxInflightBytes = options.maxInflightBytes ?? Number.POSITIVE_INFINITY
  const agingPerSecond = options.agingPerSecond ?? 0.1
  const parsers: Map<string, Parser<any, any>> = new Map(
    options.parsers ??
      createParserRegistry({
        fetchImpl: caps.fetchImpl,
        resolveUrl: caps.resolveUrl,
        inflate: caps.inflate,
        decodeImage: caps.decodeImage,
      }),
  )
  // bytes is always needed (resolveExternal); the user may override it
  if (!parsers.has('bytes')) parsers.set('bytes', bytesParser)

  const tasks = new Map<number, Task>()
  const heap: Task[] = []
  const groups = new Set<GroupImpl>()
  let activeCount = 0
  let inflightBytes = 0
  let nextId = 1
  let nextSeq = 1
  let bytesReceivedTotal = 0
  let disposed = false
  const drainWaiters = new Set<() => void>()

  // ── priority heap ──
  function effPriority(task: Task): number {
    const ageSec = (now() - task.enqueuedAt) / 1000
    return task.priority + agingPerSecond * Math.max(0, ageSec)
  }
  function heapCompare(a: Task, b: Task): number {
    const d = effPriority(b) - effPriority(a)
    return d !== 0 ? d : a.seq - b.seq
  }
  function heapPush(task: Task): void {
    heap.push(task)
    let i = heap.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (heapCompare(heap[parent], heap[i]) <= 0) break
      swap(heap, parent, i)
      i = parent
    }
  }
  function heapPop(): Task | undefined {
    if (heap.length === 0) return undefined
    const top = heap[0]
    const last = heap.pop() as Task
    if (heap.length > 0) {
      heap[0] = last
      let i = 0
      for (;;) {
        const l = i * 2 + 1
        const r = l + 1
        let best = i
        if (l < heap.length && heapCompare(heap[l], heap[best]) < 0) best = l
        if (r < heap.length && heapCompare(heap[r], heap[best]) < 0) best = r
        if (best === i) break
        swap(heap, best, i)
        i = best
      }
    }
    return top
  }
  function rebuildHeap(): void {
    const items = heap.slice()
    heap.length = 0
    for (const t of items) heapPush(t)
  }
  function swap(arr: Task[], a: number, b: number): void {
    const tmp = arr[a]
    arr[a] = arr[b]
    arr[b] = tmp
  }

  // ── byte reservations ──
  function reserveFor(task: Task): void {
    if (task.reservedBytes === 0) {
      task.reservedBytes = task.totalBytes ?? task.expectedBytes ?? DEFAULT_RESERVE_BYTES
      inflightBytes += task.reservedBytes
    }
  }
  function releaseSlot(task: Task): void {
    if (task.reservedBytes > 0) {
      inflightBytes -= task.reservedBytes
      task.reservedBytes = 0
    }
    task.holdsSlot = false
  }
  function updateReservation(task: Task, knownTotal: number): void {
    if (knownTotal > task.reservedBytes) {
      inflightBytes += knownTotal - task.reservedBytes
      task.reservedBytes = knownTotal
    }
  }

  // ── scheduler ──
  function pump(): void {
    if (disposed) return
    const deferred: Task[] = []
    while (activeCount < concurrency && heap.length > 0) {
      const task = heapPop()
      if (task === undefined) break
      if (task.state !== 'queued') continue
      const needsNetwork = task.source.bytes === undefined
      if (needsNetwork) {
        // hypothetical reservation (no acquisition!): a deferred task must not
        // hold bytes, otherwise the budget deadlocks
        const est =
          task.reservedBytes > 0
            ? task.reservedBytes
            : task.totalBytes ?? task.expectedBytes ?? DEFAULT_RESERVE_BYTES
        if (inflightBytes + est > maxInflightBytes) {
          deferred.push(task)
          continue
        }
        reserveFor(task)
      }
      startTask(task)
    }
    for (const t of deferred) heapPush(t)
    checkDrain()
  }

  function enqueue(task: Task): void {
    task.enqueuedAt = now()
    heapPush(task)
    pump()
  }

  function startTask(task: Task): void {
    task.active = true
    activeCount++
    void runTask(task).finally(() => {
      task.active = false
      activeCount--
      releaseSlot(task)
      pump()
    })
  }

  // ── life cycle ──
  async function runTask(task: Task): Promise<void> {
    try {
      let outcome: FetchOutcome
      if (task.source.bytes !== undefined) {
        outcome = task.source.bytes
      } else {
        outcome = await fetchPhase(task)
      }
      if (task.controller.signal.aborted) throw abortError('cancelled')
      if ('streamed' in outcome) return // the sink already resolved the task
      const value = await parsePhase(task, outcome)
      finishTask(task, value, undefined)
    } catch (err) {
      finishTask(task, undefined, err)
    }
  }

  function finishTask(task: Task, value: unknown, error: unknown): void {
    if (task.state === 'done' || task.state === 'cancelled' || task.state === 'failed') return
    if (error !== undefined) {
      const isAbort = isAbortError(error)
      task.state = isAbort ? 'cancelled' : 'failed'
      emitProgress(task, true)
      task.settledError = error
      notifyGroup(task)
      task.rejectRaw(error)
      return
    }
    task.state = 'done'
    task.fraction = 1
    emitProgress(task, true)
    task.settledValue = value
    notifyGroup(task)
    task.resolveRaw(value)
  }

  function notifyGroup(task: Task): void {
    if (task.group === null) return
    for (const notify of task.group.enoughNotifiers) notify()
  }

  /** Network phase: fetch with retries, buffering OR a streaming sink. */
  async function fetchPhase(task: Task): Promise<FetchOutcome> {
    // the source is already a stream (Response/Blob/ReadableStream/AsyncIterable):
    // no fetch needed, reading cannot be repeated — no retries
    if (task.source.stream !== undefined) {
      setPhase(task, task.transforms.length > 0 ? 'transforming' : 'fetching')
      return await consumeStream(task, task.source.stream)
    }
    for (;;) {
      task.timedOut = false
      task.controller = freshController(task.externalSignal)
      const timeoutId =
        task.timeoutMs !== undefined && task.timeoutMs > 0
          ? setTimeout(() => {
              task.timedOut = true
              task.controller.abort(abortError(`fetch timeout ${task.timeoutMs}ms`))
            }, task.timeoutMs)
          : null
      try {
        setPhase(task, task.transforms.length > 0 ? 'transforming' : 'fetching')
        const input: RequestInfo = task.source.fetchRequest ?? (task.source.fetchUrl as string)
        const response: Response = await caps.fetchImpl(input, { signal: task.controller.signal })
        if (!response.ok) {
          if (isRetryableStatus(response.status) && canRetry(task)) {
            await delayRetry(task)
            continue
          }
          throw new LoadError('http', `HTTP ${response.status} ${response.statusText}`, {
            status: response.status,
            url: task.url,
          })
        }
        const knownTotal = responseTotalBytes(response) ?? task.expectedBytes
        if (knownTotal !== null && knownTotal !== task.totalBytes) {
          task.totalBytes = knownTotal
          updateReservation(task, knownTotal)
          emitProgress(task, true)
        }
        const chunks =
          response.body !== null ? streamToAsyncIterable(response.body) : emptyChunks()
        return await consumeStream(task, chunks)
      } catch (err) {
        const aborted = isAbortError(err)
        if (aborted) {
          if (task.timedOut) {
            if (canRetry(task)) {
              await delayRetry(task)
              continue
            }
            throw new LoadError('timeout', `fetch timeout after ${task.timeoutMs}ms`, {
              url: task.url,
            })
          }
          throw err
        }
        // retry only network failures; 4xx/parse — an immediate error
        if (canRetry(task) && isRetryableError(err)) {
          await delayRetry(task)
          continue
        }
        throw err instanceof LoadError
          ? err
          : new LoadError('network', String((err as Error)?.message ?? err), {
              cause: err,
              url: task.url,
            })
      } finally {
        if (timeoutId !== null) clearTimeout(timeoutId)
      }
    }
  }

  /** Consume the stream: readAllBytes for buffer parsers, a sink for streaming ones. */
  async function consumeStream(task: Task, chunks: AsyncIterable<Uint8Array>): Promise<FetchOutcome> {
    const sinkFactory = task.parser.streaming
    if (sinkFactory === undefined) {
      // buffer path: accumulate everything; the slot is held until reading ends
      const bytes = await readAllBytes(chunks, {
        onChunk: received => onChunkReceived(task, received - task.receivedBytes, received),
      })
      releaseSlot(task)
      return bytes
    }
    // streaming path: network → transforms → sink, parsing runs in parallel with the network
    let stream: AsyncIterable<Uint8Array> = chunks
    const transform = composeTransforms(...task.transforms)
    if (transform !== null) stream = transform(stream)
    const sink = sinkFactory(makeContext(task), task.parserOptions)
    for await (const chunk of stream) {
      onChunkReceived(task, chunk.byteLength, undefined)
      const pushResult = sink.push(chunk)
      if (pushResult !== undefined) await pushResult
      if (task.controller.signal.aborted) throw abortError('cancelled')
    }
    releaseSlot(task)
    if (task.controller.signal.aborted) throw abortError('cancelled')
    const result = await sink.finish()
    if (task.controller.signal.aborted) throw abortError('cancelled')
    finishTask(task, result, undefined)
    return { streamed: true }
  }

  /** retries=0 → no retries at all; attempt grows AFTER each try. */
  function canRetry(task: Task): boolean {
    return task.attempt < task.retries
  }

  async function delayRetry(task: Task): Promise<void> {
    task.attempt++
    const delay =
      typeof task.retryDelayMs === 'function' ? task.retryDelayMs(task.attempt) : task.retryDelayMs
    if (delay > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, delay))
      if (task.controller.signal.aborted) throw abortError('cancelled')
    }
  }

  function onChunkReceived(task: Task, deltaBytes: number, absolute?: number): void {
    task.receivedBytes = absolute ?? task.receivedBytes + deltaBytes
    bytesReceivedTotal += deltaBytes
    if (
      task.totalBytes !== null &&
      (task.state === 'fetching' || task.state === 'transforming')
    ) {
      task.fraction = Math.min(1, task.receivedBytes / task.totalBytes)
    }
    emitProgress(task)
  }

  async function parsePhase(task: Task, bytes: Uint8Array): Promise<unknown> {
    setPhase(task, 'parsing')
    const result = task.parser.parse({ bytes, ctx: makeContext(task) }, task.parserOptions)
    const value = result instanceof Promise ? await result : result
    if (task.controller.signal.aborted) throw abortError('cancelled')
    return value
  }

  /** parse does not hold a slot: setPhase('parsing') reserves no bytes. */
  function setPhase(task: Task, phase: LoadPhase): void {
    if (task.state === phase) return
    task.state = phase
    if (phase === 'fetching' || phase === 'transforming') {
      task.holdsSlot = true
      reserveFor(task)
    }
    emitProgress(task, true)
  }

  function freshController(externalSignal: AbortSignal | null): AbortController {
    const controller = new AbortController()
    if (externalSignal !== null) {
      if (externalSignal.aborted) controller.abort(externalSignal.reason)
      else
        externalSignal.addEventListener('abort', () => controller.abort(externalSignal.reason), {
          once: true,
        })
    }
    return controller
  }

  function emitProgress(task: Task, force = false): void {
    if (task.onProgress === undefined) return
    if (!force && task.state === task.lastEmitPhase) {
      if (now() - task.lastEmitAt < PROGRESS_EMIT_INTERVAL_MS) return
    }
    task.lastEmitAt = now()
    task.lastEmitPhase = task.state
    task.onProgress(progressOf(task))
  }

  function progressOf(task: Task): LoadProgress {
    return {
      phase: task.state,
      receivedBytes: task.receivedBytes,
      totalBytes: task.totalBytes,
      fraction: task.state === 'done' ? 1 : task.fraction,
    }
  }

  function makeContext(task: Task): ParseContext {
    return {
      sourceUrl: task.url ?? task.source.url,
      byteLength: task.totalBytes ?? task.source.totalBytes ?? task.source.bytes?.byteLength ?? null,
      signal: task.controller.signal,
      reportProgress(fraction: number) {
        const f = Math.max(0, Math.min(1, fraction))
        if (task.state === 'parsing') task.fraction = f
        else if (task.fraction === null) task.fraction = f
        emitProgress(task)
      },
      resolveExternal(url: string): Promise<Uint8Array> {
        const abs = caps.resolveUrl(task.url ?? task.source.url, url)
        const child = createTask({
          source: normalizeSource(abs),
          parser: bytesParser,
          parserOptions: undefined,
          priority: Math.max(0, task.priority - 1),
          externalSignal: task.controller.signal,
          onProgress: undefined,
          transforms: [],
          retries: 0,
          retryDelayMs: 0,
          timeoutMs: options.defaultTimeoutMs,
          expectedBytes: null,
          group: null,
        })
        enqueue(child)
        return child.promise as Promise<Uint8Array>
      },
      resolveUrl: caps.resolveUrl,
      inflate: caps.inflate,
      taskId: task.id,
    }
  }

  // ── task creation ──
  interface CreateTaskArgs {
    source: NormalizedSource
    parser: Parser<any, any>
    parserOptions: unknown
    priority: number
    externalSignal: AbortSignal | null
    onProgress: ((p: LoadProgress) => void) | undefined
    transforms: StreamTransform[]
    retries: number
    retryDelayMs: number | ((attempt: number) => number)
    timeoutMs: number | undefined
    expectedBytes: number | null
    group: GroupImpl | null
  }

  function createTask(args: CreateTaskArgs): Task {
    const id = nextId++
    let resolveRaw!: (v: any) => void
    let rejectRaw!: (e: unknown) => void
    const promise = new Promise<any>((res, rej) => {
      resolveRaw = res
      rejectRaw = rej
    })
    // nobody is obliged to await every handle — silence unhandledrejection
    promise.catch(() => {})
    const task: Task = {
      id,
      seq: nextSeq++,
      group: args.group,
      state: 'queued',
      priority: args.priority,
      source: args.source,
      parser: args.parser,
      parserOptions: args.parserOptions,
      transforms: args.transforms,
      onProgress: args.onProgress,
      retries: args.retries,
      retryDelayMs: args.retryDelayMs,
      timeoutMs: args.timeoutMs,
      expectedBytes: args.expectedBytes,
      controller: freshController(args.externalSignal),
      externalSignal: args.externalSignal,
      receivedBytes: 0,
      totalBytes: args.source.totalBytes ?? args.expectedBytes,
      fraction: null,
      promise,
      resolveRaw,
      rejectRaw,
      settledValue: undefined,
      settledError: undefined,
      enqueuedAt: now(),
      attempt: 0,
      active: false,
      holdsSlot: false,
      reservedBytes: 0,
      timedOut: false,
      url: args.source.url,
      lastEmitAt: 0,
      lastEmitPhase: 'queued',
    }
    tasks.set(id, task)
    // an external signal may cancel a task while it is still queued
    const external = args.externalSignal
    if (external !== null) {
      if (external.aborted) cancelTask(task, describeAbortReason(external))
      else
        external.addEventListener(
          'abort',
          () => {
            if (!task.active) cancelTask(task, describeAbortReason(external))
            else task.controller.abort(describeAbortReason(external))
          },
          { once: true },
        )
    }
    return task
  }

  function describeAbortReason(signal: AbortSignal): string {
    const reason: unknown = signal.reason
    return typeof reason === 'string' ? reason : 'aborted'
  }

  function cancelTask(task: Task, reason?: string): void {
    if (task.state === 'done' || task.state === 'cancelled' || task.state === 'failed') return
    const err = abortError(reason)
    task.controller.abort(err)
    finishTask(task, undefined, err)
    pump()
  }

  // ── parser selection ──
  function pickParser(normalized: NormalizedSource, opts: LoadOptions<unknown, unknown> | undefined): Parser<any, any> {
    if (opts?.parser !== undefined) return opts.parser
    if (opts?.kind !== undefined) {
      const p = parsers.get(opts.kind)
      if (p === undefined) throw new LoadError('source', `no parser for kind="${opts.kind}"`)
      return p
    }
    const url = normalized.url ?? normalized.fetchUrl
    if (normalized.bytes !== undefined || url !== null) {
      const sniffed = sniffKind(normalized.bytes ?? new Uint8Array(0), url).kind
      if (sniffed !== null) {
        const p = parsers.get(sniffed === 'glb' ? 'gltf' : sniffed)
        if (p !== undefined) return p
      }
    }
    throw new LoadError('source', 'failed to pick a parser: specify kind or parser')
  }

  function createTaskFromOptions<T, O>(
    source: LoadSource,
    opts: LoadOptions<T, O> | undefined,
    group: GroupImpl | null,
  ): Task {
    let normalized: NormalizedSource
    let parser: Parser<any, any>
    try {
      normalized = normalizeSource(source)
      parser = pickParser(normalized, opts as LoadOptions<unknown, unknown> | undefined)
    } catch (err) {
      // synchronous source/parser selection errors → an asynchronous task error
      normalized = { url: null, totalBytes: 0, fetchUrl: null, fetchRequest: null, bytes: new Uint8Array(0) }
      parser = makeFailingParser(err as Error)
    }
    const task = createTask({
      source: normalized,
      parser,
      parserOptions: opts?.parserOptions,
      priority: opts?.priority ?? Priority.normal,
      externalSignal: opts?.signal ?? null,
      onProgress: opts?.onProgress,
      transforms: opts?.transforms ?? [],
      retries: opts?.retries ?? options.defaultRetries ?? 0,
      retryDelayMs: opts?.retryDelayMs ?? 0,
      timeoutMs: opts?.timeoutMs ?? options.defaultTimeoutMs,
      expectedBytes: opts?.expectedBytes ?? null,
      group,
    })
    if (group !== null) group.tasks.push(task)
    return task
  }

  function makeFailingParser(err: Error): Parser<never, unknown> {
    return {
      kind: '__error__',
      parse(): never {
        throw err
      },
    }
  }

  // ── drain / stats ──
  function checkDrain(): void {
    if (drainWaiters.size === 0) return
    // cancelled tasks may remain in the heap — count by actual states
    if (countStates().queued > 0 || activeCount > 0) return
    const waiters = [...drainWaiters]
    drainWaiters.clear()
    for (const w of waiters) w()
  }

  function countStates(): { queued: number; active: number; done: number; failed: number; cancelled: number } {
    let queued = 0, active = 0, done = 0, failed = 0, cancelled = 0
    for (const t of tasks.values()) {
      switch (t.state) {
        case 'queued': queued++; break
        case 'fetching':
        case 'transforming':
        case 'parsing': active++; break
        case 'done': done++; break
        case 'failed': failed++; break
        case 'cancelled': cancelled++; break
      }
    }
    return { queued, active, done, failed, cancelled }
  }

  // ── groups ──
  function makeGroup(name: string, defaultPriority: number): LoadGroup {
    const impl: GroupImpl = {
      name,
      tasks: [],
      defaultPriority,
      enoughNotifiers: new Set(),
      enoughDemoted: false,
    }
    groups.add(impl)

    function groupProgress(): GroupProgress {
      let done = 0, failed = 0, cancelled = 0, active = 0, queued = 0
      let receivedBytes = 0
      let totalBytes: number | null = 0
      let weightSum = 0
      let valueSum = 0
      for (const t of impl.tasks) {
        switch (t.state) {
          case 'done': done++; break
          case 'failed': failed++; break
          case 'cancelled': cancelled++; break
          case 'fetching':
          case 'transforming':
          case 'parsing': active++; break
          case 'queued': queued++; break
        }
        receivedBytes += t.receivedBytes
        if (t.totalBytes === null) totalBytes = null
        else if (totalBytes !== null) totalBytes += t.totalBytes
        const w = t.totalBytes ?? t.receivedBytes ?? 1
        weightSum += w
        valueSum += (t.state === 'done' ? 1 : t.fraction ?? 0) * w
      }
      return {
        total: impl.tasks.length,
        done, failed, cancelled, active, queued,
        receivedBytes,
        totalBytes,
        fraction: weightSum > 0 ? valueSum / weightSum : 0,
      }
    }

    return {
      name,
      add<S, O>(source: LoadSource, opts?: LoadOptions<S, O>): LoadHandle<S> {
        const priority = opts?.priority ?? impl.defaultPriority
        const task = createTaskFromOptions(source, { ...opts, priority }, impl)
        enqueue(task)
        return makeHandle<S>(task)
      },
      enough(count: number, enoughOpts?: EnoughOptions): Promise<unknown[]> {
        const demoteTo =
          enoughOpts?.demoteRemainingTo === null
            ? null
            : (enoughOpts?.demoteRemainingTo ?? Priority.prefetch)
        return new Promise<unknown[]>((resolve, reject) => {
          const notify = () => {
            const doneTasks = impl.tasks.filter(t => t.state === 'done')
            if (doneTasks.length >= count) {
              impl.enoughNotifiers.delete(notify)
              if (demoteTo !== null && !impl.enoughDemoted) {
                impl.enoughDemoted = true
                for (const t of impl.tasks) {
                  if (t.state === 'queued' && t.priority > demoteTo) t.priority = demoteTo
                }
                rebuildHeap()
              }
              resolve(doneTasks.slice(0, count).map(t => t.settledValue))
              return
            }
            const settled = impl.tasks.filter(
              t => t.state === 'done' || t.state === 'failed' || t.state === 'cancelled',
            )
            if (settled.length === impl.tasks.length) {
              impl.enoughNotifiers.delete(notify)
              reject(
                new AggregateError(
                  impl.tasks.filter(t => t.state !== 'done').map(t => t.settledError),
                  `enough(${count}): quorum unreachable (done ${doneTasks.length} of ${impl.tasks.length})`,
                ),
              )
            }
          }
          impl.enoughNotifiers.add(notify)
          notify()
        })
      },
      async waitAll(): Promise<unknown[]> {
        const values: unknown[] = []
        const errors: unknown[] = []
        await Promise.all(
          impl.tasks.map(async t => {
            try {
              values.push(await t.promise)
            } catch (err) {
              errors.push(err)
            }
          }),
        )
        if (errors.length > 0) {
          throw new AggregateError(errors, `group "${name}": ${errors.length} of ${impl.tasks.length} failed`)
        }
        return values
      },
      async settleAll(): Promise<SettledResult[]> {
        return Promise.all(
          impl.tasks.map(async t => {
            try {
              return { value: await t.promise }
            } catch (err) {
              return { error: err, cancelled: isAbortError(err) }
            }
          }),
        )
      },
      cancelAll(): void {
        for (const t of impl.tasks) cancelTask(t, `group "${name}" cancelled`)
      },
      setPriority(priority: number): void {
        for (const t of impl.tasks) {
          if (t.state === 'queued') t.priority = priority
        }
        rebuildHeap()
      },
      get progress(): GroupProgress {
        return groupProgress()
      },
      get handles(): readonly LoadHandle<unknown>[] {
        return impl.tasks.map(t => makeHandle<unknown>(t))
      },
    }
  }

  function makeHandle<T>(task: Task): LoadHandle<T> {
    return {
      id: task.id,
      get url() { return task.url },
      get state() { return task.state },
      get progress() { return progressOf(task) },
      get ready() { return task.promise as Promise<T> },
      cancel(reason?: string) {
        cancelTask(task, reason)
      },
    }
  }

  // ── public API ──
  const manager: LoadManager = {
    load<T, O>(source: LoadSource, opts?: LoadOptions<T, O>): LoadHandle<T> {
      if (disposed) throw new LoadError('source', 'manager disposed')
      const task = createTaskFromOptions(source, opts, null)
      enqueue(task)
      return makeHandle<T>(task)
    },
    loadBytes(url: string, opts?: LoadOptions<Uint8Array, void>): LoadHandle<Uint8Array> {
      return manager.load<Uint8Array, void>(url, { ...opts, kind: 'bytes' })
    },
    group(name?: string, opts?: { defaultPriority?: number }): LoadGroup {
      return makeGroup(name ?? `group-${groups.size + 1}`, opts?.defaultPriority ?? Priority.normal)
    },
    registerParser(kind: string, parser: Parser<any, any>): void {
      parsers.set(kind, parser)
    },
    setConcurrency(n: number): void {
      concurrency = Math.max(MIN_CONCURRENCY, Math.floor(n))
      pump()
    },
    drain(): Promise<void> {
      if (countStates().queued === 0 && activeCount === 0) return Promise.resolve()
      return new Promise<void>(resolve => {
        drainWaiters.add(resolve)
        checkDrain()
      })
    },
    stats(): LoadManagerStats {
      const c = countStates()
      return {
        ...c,
        inflightBytes,
        bytesReceived: bytesReceivedTotal,
        tasks: tasks.size,
      }
    },
    pruneTerminal(): void {
      for (const [id, t] of tasks) {
        if (t.state === 'done' || t.state === 'failed' || t.state === 'cancelled') {
          tasks.delete(id)
        }
      }
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const t of tasks.values()) {
        if (t.state !== 'done' && t.state !== 'failed' && t.state !== 'cancelled') {
          cancelTask(t, 'manager disposed')
        }
      }
      tasks.clear()
      heap.length = 0
      groups.clear()
      checkDrain()
    },
    get disposed() { return disposed },
  }
  return manager
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429
}

/** Which errors are worth retrying at the catch level: fetch network failures. */
function isRetryableError(err: unknown): boolean {
  if (err instanceof TypeError) return true
  if (err instanceof LoadError) return err.code === 'network'
  return false
}

function emptyChunks(): AsyncIterable<Uint8Array> {
  async function *gen(): AsyncGenerator<Uint8Array> {}
  return gen()
}
