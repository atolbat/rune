/**
 * source.ts — network source of bytes: fetch + progress + cancel + retries,
 * and StreamAssembler — a universal stream accumulator for parsers.
 *
 * Key idea "download and parse in parallel": the fetch stream is strictly
 * sequential, so the "received prefix" is a watermark
 * (the number of received bytes). A parser can:
 *   await assembler.waitFor(n)          — wait for n bytes;
 *   assembler.rangeReady(off, len)      — check range readiness;
 *   assembler.slice(off, len)           — cut out a copy of a range;
 *   assembler.onRange(cb)               — watermark advance callback
 * (progressive parsing: GLB-JSON is read before the BIN chunk finishes,
 * images are decoded as soon as their byte ranges arrive).
 *
 * The buffer is a single Uint8Array (Content-Length known — exact size,
 * otherwise grows by doubling): no string or Blob concatenations.
 */

export interface ByteSourceOptions {
  readonly signal?: AbortSignal
  /** Timeout for establishing the connection (headers), not the body. Default 30s. */
  readonly connectTimeoutMs?: number
  /** Retries on network errors and 5xx. Default 1 (2 attempts total). */
  readonly retries?: number
  /** fetch override — for tests and "synthetic" sources (data:). */
  readonly fetchImpl?: typeof fetch
  /** Byte progress callback (every body chunk). */
  readonly onBytes?: (loaded: number, total: number) => void
}

export interface ByteSource {
  readonly url: string
  readonly contentLength: number | undefined
  readonly assembler: Assembler
  /** Wait for the complete body. */
  readonly done: Promise<void>
}

/** Open a source: fetch (with retries) → an assembler downloading in the background. */
export async function openByteSource(url: string, options: ByteSourceOptions = {}): Promise<ByteSource> {
  const fetchImpl = options.fetchImpl ?? fetch
  const retries = Math.max(0, options.retries ?? 1)
  const connectTimeoutMs = options.connectTimeoutMs ?? 30_000

  let lastError: unknown = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (options.signal?.aborted) throw abortError(options.signal)
    const controller = new AbortController()
    const stopTimeout = connectTimeout(controller, connectTimeoutMs, options.signal)
    try {
      const response = await fetchImpl(url, { signal: controller.signal })
      // Connection established: the timeout is no longer needed, but the signal is alive.
      stopTimeout()
      followAbort(options.signal, controller)
      if (!response.ok || response.body === null) {
        // 5xx — retry; 4xx — pointless (client error).
        const retryable = response.status >= 500 || response.status === 429
        lastError = new TypeError(`HTTP ${response.status} ${response.statusText} — ${url}`)
        if (retryable && attempt < retries) {
          await backoff(attempt, options.signal)
          continue
        }
        throw lastError
      }
      const contentLengthHeader = response.headers.get('content-length')
      const contentLength = contentLengthHeader !== null ? Number(contentLengthHeader) : undefined
      const assembler = new Assembler(response.body, {
        total: Number.isFinite(contentLength) ? contentLength : undefined,
        signal: options.signal,
        onBytes: options.onBytes,
      })
      return {
        url,
        contentLength: assembler.total,
        assembler,
        done: assembler.completion,
      }
    } catch (error) {
      stopTimeout()
      if (isAbort(error)) throw error
      lastError = error
      if (attempt < retries) {
        await backoff(attempt, options.signal)
        continue
      }
      throw error
    }
  }
  throw lastError ?? new Error(`source unavailable: ${url}`)
}

// ─── StreamAssembler ───────────────────────────────────────────────────────

// Unification (restoration): the watermark accumulator used to be duplicated in two
// layers (assembler.ts for root parsers and source.ts for Task-88). Now
// there is ONE Assembler class: private fields made structural compatibility
// impossible, so StreamAssembler is the canonical name for the source layer.
import { Assembler } from './assembler.ts'
export { Assembler as StreamAssembler } from './assembler.ts'
export type { AssemblerOptions } from './assembler.ts'

/** Name of the assembly stream for the source layer (Task 88) — see assembler.ts. */

// ─── helpers ───────────────────────────────────────────────────────────────

function connectTimeout(controller: AbortController, ms: number, _external?: AbortSignal): () => void {
  const timer = setTimeout(() => {
    controller.abort(new DOMException('connection timeout', 'TimeoutError'))
  }, ms)
  return () => clearTimeout(timer)
}

/** Forward an external signal into the controller AFTER headers. */
function followAbort(external: AbortSignal | undefined, controller: AbortController): void {
  if (external === undefined) return
  if (external.aborted) {
    controller.abort(abortError(external))
    return
  }
  external.addEventListener('abort', () => {
    controller.abort(abortError(external))
  }, { once: true })
}

async function backoff(attempt: number, signal?: AbortSignal): Promise<void> {
  const delay = Math.min(4000, 250 * 2 ** attempt)
  await sleepAbortable(delay, signal)
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal))
  return new Promise<void>((resolve, reject) => {
    const external = signal
    const timer = setTimeout(() => {
      external?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError(external))
    }
    external?.addEventListener('abort', onAbort, { once: true })
  })
}

function abortError(signal: AbortSignal | undefined): unknown {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('loading cancelled', 'AbortError')
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')
}
