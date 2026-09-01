/**
 * source.ts — сетевой источник байт: fetch + прогресс + отмена + ретраи,
 * и StreamAssembler — универсальный накопитель стрима для парсеров.
 *
 * Ключевая идея «загрузка и парсинг параллельно»: fetch-стрим строго
 * последователен, поэтому «полученный префикс» — это watermark
 * (кол-во принятых байт). Парсер может:
 *   await assembler.waitFor(n)          — дождаться n байт;
 *   assembler.rangeReady(off, len)      — проверить готовность диапазона;
 *   assembler.slice(off, len)           — вырезать копию диапазона;
 *   assembler.onRange(cb)               — колбэк продвижения watermark
 * (прогрессивный парсинг: GLB-JSON читается до конца BIN-чанка,
 * имаги декодируются, как только их байтовые диапазоны получены).
 *
 * Буфер — один Uint8Array (Content-Length известен — точного размера,
 * иначе растёт удвоением): никаких конкатенаций строк и Blob'ов.
 */

export interface ByteSourceOptions {
  readonly signal?: AbortSignal
  /** Таймаут на установку соединения (headers), не на тело. Default 30s. */
  readonly connectTimeoutMs?: number
  /** Повторы при сетевых ошибках и 5xx. Default 1 (всего 2 попытки). */
  readonly retries?: number
  /** Подмена fetch — для тестов и «синтетических» источников (data:). */
  readonly fetchImpl?: typeof fetch
  /** Колбэк байтового прогресса (каждый чанк тела). */
  readonly onBytes?: (loaded: number, total: number) => void
}

export interface ByteSource {
  readonly url: string
  readonly contentLength: number | undefined
  readonly assembler: Assembler
  /** Дождаться полного тела. */
  readonly done: Promise<void>
}

/** Открыть источник: fetch (с ретраями) → ассемблер, качающийся в фоне. */
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
      // Соединение установлено: таймаут больше не нужен, но сигнал — жив.
      stopTimeout()
      followAbort(options.signal, controller)
      if (!response.ok || response.body === null) {
        // 5xx — ретраим; 4xx — бессмысленно (клиентская ошибка).
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
  throw lastError ?? new Error(`источник недоступен: ${url}`)
}

// ─── StreamAssembler ───────────────────────────────────────────────────────

// Унификация (реставрация): раньше watermark-накопитель дублировался в двух
// слоях (assembler.ts для корневых парсеров и source.ts для Task-88). Теперь
// ОДИН класс Assembler: приватные поля делали структурную совместимость
// невозможной, поэтому StreamAssembler — каноническое имя для слоя источника.
import { Assembler } from './assembler.ts'
export { Assembler as StreamAssembler } from './assembler.ts'
export type { AssemblerOptions } from './assembler.ts'

/** Имя потока сборки для слоя источника (Task 88) — см. assembler.ts. */

// ─── helpers ───────────────────────────────────────────────────────────────

function connectTimeout(controller: AbortController, ms: number, _external?: AbortSignal): () => void {
  const timer = setTimeout(() => {
    controller.abort(new DOMException('таймаут соединения', 'TimeoutError'))
  }, ms)
  return () => clearTimeout(timer)
}

/** Прокинуть внешний сигнал в контроллер ПОСЛЕ заголовков. */
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
  return signal?.reason instanceof Error ? signal.reason : new DOMException('загрузка отменена', 'AbortError')
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')
}
