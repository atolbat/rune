/**
 * Streaming loading infrastructure: Assembler + FetchScheduler + fetchStreaming.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CONTRACT:
 *
 *   fetchStreaming(url, options) → { url, contentLength, assembler, done }
 *
 *   Assembler (k8) — assembles the response body into a growing Uint8Array:
 *     .watermark    — how many bytes have been received (availability boundary)
 *     .isDone       — the stream has been read to the end
 *     .completion   — Promise<void>, resolves/rejects along with the stream
 *     .waitFor(n)   — wait for n bytes from the start
 *     .rangeReady(off, len) / .onRange(cb) / .slice(off, len)
 *     .prefixView(n) / .fullView() — zero copies on demand
 *
 *   FetchScheduler (q7) — priority queue of loads with a byte budget:
 *     maxConcurrent (default 3), maxBytesInFlight (default 64 MB),
 *     submit/setPriority/cancel/pause/resume/updateWeight/stats.
 *
 * Why: parsers (GLB/OBJ/FBX) start working BEFORE the download completes —
 * they read headers via waitFor(20) and wait for needed ranges via onRange.
 * Hence an instant first frame on large files.
 *
 * Key zero-copy invariant: when contentLength is known, the buffer
 * is allocated exactly for the file and is NOT reallocated — slices handed
 * out via prefixView/fullView remain valid for the Assembler's lifetime.
 */

/** Reads the stream / progress bytes. */
export interface OnBytes {
  (loaded: number, total: number): void
}

/** fetchStreaming options. */
export interface FetchStreamingOptions {
  /** fetch substitution for tests/SSRF policies. Defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch
  /** Number of retries on 5xx/429 and network failures. Defaults to 1 (one retry). */
  readonly retries?: number
  /** Connect timeout, ms. Defaults to 30000. */
  readonly connectTimeoutMs?: number
  /** External cancellation. */
  readonly signal?: AbortSignal
  /** Byte progress callback. */
  readonly onBytes?: OnBytes
}

/** fetchStreaming result: the streaming response body. */
export interface StreamingResponse {
  readonly url: string
  /** Content-Length, if the server reported it. */
  readonly contentLength: number | undefined
  readonly assembler: Assembler
  /** Promise<void> — the body has been fully read. */
  readonly done: Promise<void>
}

/** Cancellation error from a signal (preserves the reason if it is an Error). */
export function signalAbortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('load cancelled', 'AbortError')
}

/** Coerces an arbitrary reason to Error/DOMException(AbortError). */
export function toAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  return new DOMException(typeof reason === 'string' ? reason : 'load cancelled', 'AbortError')
}

/** AbortError/TimeoutError — cancellation, not a source failure. */
export function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')
  )
}

// ─── Assembler ───────────────────────────────────────────────────────────────

/** Assembler options. */
export interface AssemblerOptions {
  /** Expected total size (Content-Length). Optimizes allocations. */
  readonly total?: number
  /** External cancellation — fails the assembler and cancels stream reading. */
  readonly signal?: AbortSignal
  /** Byte progress callback. */
  readonly onBytes?: OnBytes
}

/**
 * Assembles a ReadableStream<Uint8Array> into a single buffer with
 * incremental availability: the watermark grows as chunks arrive, parsers
 * subscribe to onRange and read slices without waiting for the file to end.
 */
export class Assembler {
  readonly total: number | undefined
  failure: unknown
  private buffer: Uint8Array
  private received = 0
  private finished = false
  private waiters: Array<{ bytes: number; resolve: () => void; reject: (e: unknown) => void }> = []
  private rangeListeners: Array<(watermark: number) => void> = []
  readonly completion: Promise<void>
  private releaseCompletion!: () => void
  private rejectCompletion!: (reason: unknown) => void
  /** The reader is held by pump; stream cancellation goes through it (the stream is locked). */
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null

  constructor(body: ReadableStream<Uint8Array>, options: AssemblerOptions = {}) {
    this.total = options.total
    this.buffer = new Uint8Array(options.total ?? 1048576)
    this.completion = new Promise<void>((resolve, reject) => {
      this.releaseCompletion = resolve
      this.rejectCompletion = reject
    })
    // Do not let an unhandled rejection dangle if nobody awaits completion
    this.completion.catch(() => {})

    const signal = options.signal
    if (signal !== undefined && signal.aborted) {
      this.fail(signalAbortError(signal))
      return
    }
    signal?.addEventListener(
      'abort',
      () => {
        // body.cancel() on a locked stream throws TypeError — only
        // via reader: this also breaks the connection on the source side
        this.reader?.cancel().catch(() => {})
        this.fail(signalAbortError(signal))
      },
      { once: true },
    )
    this.pump(body, options.onBytes).catch((err: unknown) => this.fail(err))
  }

  /** How many bytes are available for reading (the "contiguous" availability boundary). */
  get watermark(): number {
    return this.received
  }

  /** The stream has been read to the end (successfully or with an error). */
  get isDone(): boolean {
    return this.finished
  }

  /** The range [offset, offset+length) has already been received in full. */
  rangeReady(offset: number, length: number): boolean {
    return this.received >= offset + length
  }

  /** Waits until at least bytes bytes have accumulated from the start of the file. */
  async waitFor(bytes: number): Promise<void> {
    if (this.received >= bytes || this.finished) return
    await new Promise<void>((resolve, reject) => {
      this.waiters.push({ bytes, resolve, reject })
    })
  }

  /** Subscribes to watermark growth; unsubscribe by calling the returned function. */
  onRange(listener: (watermark: number) => void): () => void {
    this.rangeListeners.push(listener)
    return () => {
      const idx = this.rangeListeners.indexOf(listener)
      if (idx >= 0) this.rangeListeners.splice(idx, 1)
    }
  }

  /** COPY of the range [offset, offset+length) — the range must be ready. */
  slice(offset: number, length: number): Uint8Array {
    if (this.received < offset + length)
      throw new Error(`range [${offset}, ${offset + length}) not received (watermark ${this.received})`)
    return this.buffer.slice(offset, offset + length)
  }

  /** Zero copy of the first length bytes — the file prefix (headers). */
  prefixView(length: number): Uint8Array {
    if (this.received < length)
      throw new Error(`prefix ${length} not received (watermark ${this.received})`)
    return new Uint8Array(this.buffer.buffer, 0, length)
  }

  /** Zero copy of the whole body; only after the stream has finished. */
  fullView(): Uint8Array {
    if (!this.finished) throw new Error('body not fully received yet')
    return new Uint8Array(this.buffer.buffer, 0, this.received)
  }

  private async pump(body: ReadableStream<Uint8Array>, onBytes?: OnBytes): Promise<void> {
    const reader = body.getReader()
    this.reader = reader
    for (;;) {
      const { done, value } = await reader.read()
      if (value !== undefined && value.byteLength > 0) {
        this.ensureCapacity(this.received + value.byteLength)
        this.buffer.set(value, this.received)
        this.received += value.byteLength
        if (onBytes !== undefined) onBytes(this.received, this.total ?? 0)
        this.drainWaiters()
        for (const listener of [...this.rangeListeners]) listener(this.received)
      }
      if (done) break
    }
    this.finished = true
    this.drainWaiters()
    for (const listener of [...this.rangeListeners]) listener(this.received)
    this.releaseCompletion()
  }

  private ensureCapacity(needed: number): void {
    if (needed <= this.buffer.byteLength) return
    let capacity = Math.max(this.buffer.byteLength, 1048576)
    while (capacity < needed) capacity *= 2
    const grown = new Uint8Array(capacity)
    grown.set(this.buffer.subarray(0, this.received), 0)
    this.buffer = grown
  }

  private drainWaiters(): void {
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const waiter = this.waiters[i]
      if (this.received >= waiter.bytes || this.finished) {
        this.waiters.splice(i, 1)
        waiter.resolve()
      }
    }
  }

  private fail(error: unknown): void {
    if (this.finished) return
    this.finished = true
    this.failure = error
    for (const waiter of [...this.waiters]) waiter.reject(error)
    this.waiters.length = 0
    this.rejectCompletion(error)
  }
}

// ─── FetchScheduler ──────────────────────────────────────────────────────────

/** Task description for the scheduler (implemented by the asset loader). */
export interface SchedulerJob {
  readonly id: number
  priority: number
  /** Submission sequence number — stable sorting at equal priority. */
  readonly seq: number
  /** Current "weight" of the task in bytes (for the bytesInFlight budget). */
  weight(): number
  onCancelledBeforeStart?(reason?: string): void
  /** Start; signal is composite (scheduler cancellation). */
  start(signal: AbortSignal): Promise<void>
}

let nextJobId = 1

/** Monotonic scheduler job id. */
export function allocJobId(): number {
  return nextJobId++
}

/** Scheduler statistics. */
export interface SchedulerStats {
  running: number
  queued: number
  bytesInFlight: number
  maxConcurrent: number
  maxBytesInFlight: number
  started: number
  finished: number
}

/**
 * Priority queue of network jobs. Lower priority — earlier.
 * In addition to the number of jobs, it keeps a bytes-in-flight budget:
 * a heavy load will not let a queue of small ones "hang" (not-yet-started
 * jobs do not count). The first job always starts — otherwise the budget
 * would block itself.
 */
export class FetchScheduler {
  private maxConcurrent: number
  private maxBytesInFlight: number
  private queue: SchedulerJob[] = []
  private running = new Map<number, { job: SchedulerJob; controller: AbortController }>()
  private weights = new Map<number, number>()
  private bytesInFlight = 0
  private paused = false
  private started = 0
  private finished = 0
  private drainListeners = new Set<() => void>()

  constructor(options: { maxConcurrent?: number; maxBytesInFlight?: number } = {}) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 3)
    this.maxBytesInFlight = Math.max(1, options.maxBytesInFlight ?? 67108864)
  }

  submit(job: SchedulerJob): void {
    this.queue.push(job)
    this.sortQueue()
    this.pump()
  }

  /** Priority change; true if the job is still queued (sorting updated). */
  setPriority(job: SchedulerJob, priority: number): boolean {
    if (job.priority === priority) return false
    job.priority = priority
    const inQueue = this.queue.includes(job)
    if (inQueue) this.sortQueue()
    this.pump()
    return inQueue
  }

  /** Cancel: queued — via callback, running — via controller abort. */
  cancel(job: SchedulerJob, reason?: string): boolean {
    const idx = this.queue.indexOf(job)
    if (idx >= 0) {
      this.queue.splice(idx, 1)
      job.onCancelledBeforeStart?.(reason)
      this.notifyDrain()
      return true
    }
    const entry = this.running.get(job.id)
    if (entry !== undefined) {
      entry.controller.abort(new DOMException(reason ?? 'load cancelled', 'AbortError'))
      return true
    }
    return false
  }

  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
    this.pump()
  }

  get isPaused(): boolean {
    return this.paused
  }

  /** Dynamic bytes-in-flight budget. */
  setBytesQuota(maxBytes: number): void {
    this.maxBytesInFlight = Math.max(1, maxBytes)
    this.pump()
  }

  /** Running weight update (content-length became known). */
  updateWeight(job: SchedulerJob): void {
    if (!this.running.has(job.id)) return
    const previous = this.weights.get(job.id)
    const updated = Math.max(1, job.weight())
    if (previous === updated) return
    this.weights.set(job.id, updated)
    this.bytesInFlight += updated - (previous ?? updated)
    if (this.bytesInFlight < 0) this.bytesInFlight = 0
    this.pump()
  }

  setConcurrency(maxConcurrent: number): void {
    this.maxConcurrent = Math.max(1, maxConcurrent)
    this.pump()
  }

  stats(): SchedulerStats {
    return {
      running: this.running.size,
      queued: this.queue.length,
      bytesInFlight: this.bytesInFlight,
      maxConcurrent: this.maxConcurrent,
      maxBytesInFlight: this.maxBytesInFlight,
      started: this.started,
      finished: this.finished,
    }
  }

  /** "queue and flight are empty" notification. */
  onDrain(listener: () => void): () => void {
    this.drainListeners.add(listener)
    return () => this.drainListeners.delete(listener)
  }

  private notifyDrain(): void {
    if (this.queue.length === 0 && this.running.size === 0)
      for (const listener of [...this.drainListeners]) listener()
  }

  private sortQueue(): void {
    this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq)
  }

  private pump(): void {
    if (this.paused) return
    while (this.running.size < this.maxConcurrent && this.queue.length > 0) {
      const job = this.queue[0]
      if (job === undefined) break
      const weight = Math.max(1, job.weight())
      // The budget applies starting from the second job: the first always starts
      if (this.running.size > 0 && this.bytesInFlight + weight > this.maxBytesInFlight) break
      this.queue.shift()
      const controller = new AbortController()
      this.running.set(job.id, { job, controller })
      this.weights.set(job.id, weight)
      this.bytesInFlight += weight
      this.started++
      job.start(controller.signal).then(
        () => this.finish(job.id, undefined),
        (error: unknown) => this.finish(job.id, error),
      )
    }
  }

  private finish(jobId: number, _error: unknown): void {
    const entry = this.running.get(jobId)
    if (entry === undefined) return
    this.running.delete(jobId)
    const weight = this.weights.get(jobId) ?? Math.max(1, entry.job.weight())
    this.weights.delete(jobId)
    this.bytesInFlight -= weight
    if (this.bytesInFlight < 0) this.bytesInFlight = 0
    this.finished++
    this.pump()
    this.notifyDrain()
  }
}

// ─── fetchStreaming ──────────────────────────────────────────────────────────

/**
 * Streaming HTTP GET: connect timeout, retries (5xx/429/network) with
 * exponential backoff, cancellation, byte progress. Returns an
 * Assembler over the response body — parsers can start immediately.
 */
export async function fetchStreaming(
  url: string,
  options: FetchStreamingOptions = {},
): Promise<StreamingResponse> {
  const fetchImpl = options.fetchImpl ?? fetch
  const retries = Math.max(0, options.retries ?? 1)
  const connectTimeoutMs = options.connectTimeoutMs ?? 30000
  let lastError: unknown = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (options.signal?.aborted) throw signalAbortError(options.signal)
    const controller = new AbortController()
    const clearTimer = connectTimeoutTimer(controller, connectTimeoutMs, options.signal)
    try {
      const response = await fetchImpl(url, { signal: controller.signal })
      clearTimer()
      chainAbort(options.signal, controller)
      if (!response.ok || response.body === null) {
        const retryable = response.status >= 500 || response.status === 429
        lastError = new TypeError(`HTTP ${response.status} ${response.statusText} — ${url}`)
        if (retryable && attempt < retries) {
          await backoffDelay(attempt, options.signal)
          continue
        }
        throw lastError
      }
      const contentLengthHeader = response.headers.get('content-length')
      const headerValue = contentLengthHeader !== null ? Number(contentLengthHeader) : undefined
      const assembler = new Assembler(response.body, {
        total: Number.isFinite(headerValue) ? headerValue : undefined,
        signal: options.signal,
        onBytes: options.onBytes,
      })
      return { url, contentLength: assembler.total, assembler, done: assembler.completion }
    } catch (error) {
      clearTimer()
      // User cancellation is not retried — it is final
      if (isAbortError(error)) throw error
      lastError = error
      if (attempt < retries) {
        await backoffDelay(attempt, options.signal)
        continue
      }
      throw error
    }
  }
  throw lastError ?? new Error(`source unavailable: ${url}`)
}

/** Connect timeout: cleared by the first successful await fetch. */
function connectTimeoutTimer(
  controller: AbortController,
  ms: number,
  _external?: AbortSignal,
): () => void {
  const timer = setTimeout(() => {
    controller.abort(new DOMException('connection timeout', 'TimeoutError'))
  }, ms)
  return () => clearTimeout(timer)
}

/** Forwards external cancellation to the request controller. */
function chainAbort(external: AbortSignal | undefined, controller: AbortController): void {
  if (external === undefined) return
  if (external.aborted) {
    controller.abort(signalAbortError(external))
    return
  }
  external.addEventListener(
    'abort',
    () => {
      controller.abort(signalAbortError(external))
    },
    { once: true },
  )
}

/** Exponential backoff: 250ms → 500ms → 1s → 2s → 4s (cap). */
async function backoffDelay(attempt: number, signal?: AbortSignal): Promise<void> {
  const delay = Math.min(4000, 250 * 2 ** attempt)
  await sleepAbortable(delay, signal)
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signalAbortError(signal))
  return new Promise<void>((resolve, reject) => {
    const external = signal
    const timer = setTimeout(() => {
      external?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signalAbortError(external))
    }
    external?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Inflates FBX zlib-deflate arrays (compressedLength > 0) via the
 * native DecompressionStream — without a JS zlib implementation.
 */
export async function inflateDeflate(compressed: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream > 'u')
    throw new Error(
      'DecompressionStream unavailable — binary FBX with zlib compression is not supported in this environment',
    )
  const reader = new Blob([compressed as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'))
    .getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (value !== undefined) {
      chunks.push(value)
      total += value.byteLength
    }
    if (done) break
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}
