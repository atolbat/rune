/**
 * core/errors.ts — loading error taxonomy.
 *
 * A single LoadError hierarchy with a code instead of eight singleton classes:
 * the manager, parsers and user code match on `err.code`.
 */

export type LoadErrorCode =
  | 'http'        // non-2xx response (except retryable 5xx/429 — the manager retries those)
  | 'network'     // fetch threw (offline, DNS, aborted connect)
  | 'timeout'     // the fetch phase's timeoutMs expired
  | 'abort'       // cancelled by user/group/manager
  | 'parse'       // the format failed to parse (corrupt/truncated file)
  | 'unsupported' // the format is known but a feature is unsupported (Draco, ASCII FBX)
  | 'source'      // malformed LoadSource / no parser for the kind
  | 'budget'      // byte/element budget exceeded (library)

export class LoadError extends Error {
  readonly code: LoadErrorCode
  /** HTTP status, if there was a response. */
  readonly status: number | null
  /** Original error (Error/DOMException/...). */
  readonly cause: unknown
  /** URL, if known. */
  readonly url: string | null

  constructor(
    code: LoadErrorCode,
    message: string,
    options: { status?: number; cause?: unknown; url?: string | null } = {},
  ) {
    super(message)
    this.name = 'LoadError'
    this.code = code
    this.status = options.status ?? null
    this.cause = options.cause ?? null
    this.url = options.url ?? null
  }
}

/** Format parse error — with a position, if the parser knows it. */
export class ParseError extends LoadError {
  /** Byte offset where it broke (or -1). */
  readonly offset: number

  constructor(message: string, offset = -1, url?: string | null) {
    super('parse', offset >= 0 ? `${message} (at byte ${offset})` : message, { url })
    this.name = 'ParseError'
    this.offset = offset
  }
}

/** The format was recognized but requires an unsupported feature. */
export class UnsupportedError extends LoadError {
  constructor(message: string, url?: string | null) {
    super('unsupported', message, { url })
    this.name = 'UnsupportedError'
  }
}

/** DOMException-like AbortError (without a DOM dependency). */
export function abortError(reason?: string): Error {
  const err = new Error(reason ?? 'The operation was aborted')
  err.name = 'AbortError'
  return err
}

export function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: string }).name === 'AbortError'
  )
}

/** Cancellation or error — everything rejects in the promise world, including cancel(). */
export function throwIfAborted(signal: AbortSignal, what: string): void {
  if (signal.aborted) {
    const reason = typeof signal.reason === 'string' ? signal.reason : undefined
    throw abortError(`${what}: ${reason ?? 'aborted'}`)
  }
}
