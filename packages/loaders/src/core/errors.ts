/**
 * core/errors.ts — таксономия ошибок загрузки.
 *
 * Одна иерархия LoadError с кодом вместо восьми классов-синглтонов:
 * менеджер, парсеры и пользовательский код матчут `err.code`.
 */

export type LoadErrorCode =
  | 'http'        // не-2xx ответ (кроме ретраимых 5xx/429 — их ретраит менеджер)
  | 'network'     // fetch кинул (offline, DNS, aborted connect)
  | 'timeout'     // истёк timeoutMs фазы fetch
  | 'abort'       // отмена пользователем/группой/менеджером
  | 'parse'       // формат не разобрался (битый/усечённый файл)
  | 'unsupported' // формат известен, но фича не поддержана (Draco, ASCII FBX)
  | 'source'      // кривой LoadSource / нет парсера для kind
  | 'budget'      // бюджет байтов/элементов превышен (library)

export class LoadError extends Error {
  readonly code: LoadErrorCode
  /** HTTP-статус, если был ответ. */
  readonly status: number | null
  /** Исходная ошибка (Error/DOMException/...). */
  readonly cause: unknown
  /** URL, если известен. */
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

/** Ошибка разбора формата — с позицией, если парсер её знает. */
export class ParseError extends LoadError {
  /** Байтовое смещение, где сломались (или -1). */
  readonly offset: number

  constructor(message: string, offset = -1, url?: string | null) {
    super('parse', offset >= 0 ? `${message} (at byte ${offset})` : message, { url })
    this.name = 'ParseError'
    this.offset = offset
  }
}

/** Формат распознан, но требует неподдержанной фичи. */
export class UnsupportedError extends LoadError {
  constructor(message: string, url?: string | null) {
    super('unsupported', message, { url })
    this.name = 'UnsupportedError'
  }
}

/** DOMException-подобный AbortError (без DOM-зависимости). */
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

/** Отмена или ошибка — в promise-мир всё реджектится, включая cancel(). */
export function throwIfAborted(signal: AbortSignal, what: string): void {
  if (signal.aborted) {
    const reason = typeof signal.reason === 'string' ? signal.reason : undefined
    throw abortError(`${what}: ${reason ?? 'aborted'}`)
  }
}
