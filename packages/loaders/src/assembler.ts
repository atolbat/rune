/**
 * Стриминг-инфраструктура загрузки: Assembler + FetchScheduler + fetchStreaming.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * КОНТРАКТ:
 *
 *   fetchStreaming(url, options) → { url, contentLength, assembler, done }
 *
 *   Assembler (k8) — собирает тело ответа в растущий Uint8Array:
 *     .watermark    — сколько байт уже получено (граница доступности)
 *     .isDone       — поток дочитан до конца
 *     .completion   — Promise<void>, резолвится/реджектится с потоком
 *     .waitFor(n)   — подождать n байт от начала
 *     .rangeReady(off, len) / .onRange(cb) / .slice(off, len)
 *     .prefixView(n) / .fullView() — нулевые копии по требованию
 *
 *   FetchScheduler (q7) — приоритетная очередь загрузок с бюджетом байт:
 *     maxConcurrent (default 3), maxBytesInFlight (default 64 МБ),
 *     submit/setPriority/cancel/pause/resume/updateWeight/stats.
 *
 * Зачем: парсеры (GLB/OBJ/FBX) начинают работу ДО полного скачивания —
 * по waitFor(20) читают заголовки, по onRange ждут нужные диапазоны.
 * Отсюда мгновенный первый кадр на больших файлах.
 *
 * Ключевой инвариант zero-copy: когда contentLength известен, буфер
 * аллоцируется точно под файл и НЕ переаллоцируется — выданные через
 * prefixView/fullView срезы остаются валидными до конца жизни Assembler.
 */

/** Чтение потока/байтов прогресса. */
export interface OnBytes {
  (loaded: number, total: number): void
}

/** Опции fetchStreaming. */
export interface FetchStreamingOptions {
  /** Подстановка fetch для тестов/SSRF-политик. По умолчанию globalThis.fetch. */
  readonly fetchImpl?: typeof fetch
  /** Число повторов при 5xx/429 и сетевых сбоях. По умолчанию 1 (одна повторная попытка). */
  readonly retries?: number
  /** Таймаут на установку соединения, мс. По умолчанию 30000. */
  readonly connectTimeoutMs?: number
  /** Внешняя отмена. */
  readonly signal?: AbortSignal
  /** Коллбэк прогресса байтов. */
  readonly onBytes?: OnBytes
}

/** Результат fetchStreaming: стримящееся тело ответа. */
export interface StreamingResponse {
  readonly url: string
  /** Content-Length, если сервер его сообщил. */
  readonly contentLength: number | undefined
  readonly assembler: Assembler
  /** Promise<void> — тело дочитано полностью. */
  readonly done: Promise<void>
}

/** Ошибка отмены из сигнала (сохраняет причину, если она Error). */
export function signalAbortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('загрузка отменена', 'AbortError')
}

/** Приводит произвольную причину к Error/DOMException(AbortError). */
export function toAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  return new DOMException(typeof reason === 'string' ? reason : 'загрузка отменена', 'AbortError')
}

/** AbortError/TimeoutError — отмена, а не сбой источника. */
export function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')
  )
}

// ─── Assembler ───────────────────────────────────────────────────────────────

/** Опции Assembler. */
export interface AssemblerOptions {
  /** Ожидаемый полный размер (Content-Length). Оптимизирует аллокации. */
  readonly total?: number
  /** Внешняя отмена — фейлит assembler и отменяет чтение потока. */
  readonly signal?: AbortSignal
  /** Коллбэк прогресса байтов. */
  readonly onBytes?: OnBytes
}

/**
 * Собирает ReadableStream<Uint8Array> в один буфер с инкрементальной
 * доступностью: watermark растёт по мере прихода чанков, парсеры
 * подписываются на onRange и читают срезы, не дожидаясь конца файла.
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
  /** Ридер захвачен в pump; отмена потока идёт через него (поток залочен). */
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null

  constructor(body: ReadableStream<Uint8Array>, options: AssemblerOptions = {}) {
    this.total = options.total
    this.buffer = new Uint8Array(options.total ?? 1048576)
    this.completion = new Promise<void>((resolve, reject) => {
      this.releaseCompletion = resolve
      this.rejectCompletion = reject
    })
    // Не даём висеть unhandled rejection, если completion никто не ждёт
    this.completion.catch(() => {})

    const signal = options.signal
    if (signal !== undefined && signal.aborted) {
      this.fail(signalAbortError(signal))
      return
    }
    signal?.addEventListener(
      'abort',
      () => {
        // body.cancel() на залоченном потоке бросает TypeError — только
        // через reader: это ещё и рвёт соединение на стороне источника
        this.reader?.cancel().catch(() => {})
        this.fail(signalAbortError(signal))
      },
      { once: true },
    )
    this.pump(body, options.onBytes).catch((err: unknown) => this.fail(err))
  }

  /** Сколько байт доступно для чтения (граница «сплошной» доступности). */
  get watermark(): number {
    return this.received
  }

  /** Поток дочитан (успешно или с ошибкой). */
  get isDone(): boolean {
    return this.finished
  }

  /** Диапазон [offset, offset+length) уже получен целиком. */
  rangeReady(offset: number, length: number): boolean {
    return this.received >= offset + length
  }

  /** Ждёт, пока с начала файла накопится не меньше bytes байт. */
  async waitFor(bytes: number): Promise<void> {
    if (this.received >= bytes || this.finished) return
    await new Promise<void>((resolve, reject) => {
      this.waiters.push({ bytes, resolve, reject })
    })
  }

  /** Подписка на рост watermark; отписка — вызовом возвращенной функции. */
  onRange(listener: (watermark: number) => void): () => void {
    this.rangeListeners.push(listener)
    return () => {
      const idx = this.rangeListeners.indexOf(listener)
      if (idx >= 0) this.rangeListeners.splice(idx, 1)
    }
  }

  /** КОПИЯ диапазона [offset, offset+length) — диапазон обязан быть готов. */
  slice(offset: number, length: number): Uint8Array {
    if (this.received < offset + length)
      throw new Error(`range [${offset}, ${offset + length}) не получен (watermark ${this.received})`)
    return this.buffer.slice(offset, offset + length)
  }

  /** Нулевая копия первых length байт — префикс файла (заголовки). */
  prefixView(length: number): Uint8Array {
    if (this.received < length)
      throw new Error(`prefix ${length} не получен (watermark ${this.received})`)
    return new Uint8Array(this.buffer.buffer, 0, length)
  }

  /** Нулевая копия всего тела; только после завершения потока. */
  fullView(): Uint8Array {
    if (!this.finished) throw new Error('тело ещё не получено полностью')
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

/** Описание задачи для планировщика (реализуется загрузчиком ассетов). */
export interface SchedulerJob {
  readonly id: number
  priority: number
  /** Порядковый номер подачи — стабильность сортировки при равном приоритете. */
  readonly seq: number
  /** Текущий «вес» задачи в байтах (для бюджета bytesInFlight). */
  weight(): number
  onCancelledBeforeStart?(reason?: string): void
  /** Запуск; signal — составной (отмена планировщика). */
  start(signal: AbortSignal): Promise<void>
}

let nextJobId = 1

/** Монотонный id задач планировщика. */
export function allocJobId(): number {
  return nextJobId++
}

/** Статистика планировщика. */
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
 * Приоритетная очередь сетевых задач. Меньше priority — раньше.
 * Вдобавок к числу задач держит бюджет байт в полёте: тяжёлая загрузка
 * не даст «зависнуть» очереди мелких (пока не начатые не считаются).
 * Первая задача стартует всегда — иначе бюджет блокирует сам себя.
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

  /** Смена приоритета; true если задача ещё в очереди (сортировка обновлена). */
  setPriority(job: SchedulerJob, priority: number): boolean {
    if (job.priority === priority) return false
    job.priority = priority
    const inQueue = this.queue.includes(job)
    if (inQueue) this.sortQueue()
    this.pump()
    return inQueue
  }

  /** Отмена: из очереди — коллбеком, запущенной — abort контроллера. */
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
      entry.controller.abort(new DOMException(reason ?? 'загрузка отменена', 'AbortError'))
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

  /** Динамический бюджет байт в полёте. */
  setBytesQuota(maxBytes: number): void {
    this.maxBytesInFlight = Math.max(1, maxBytes)
    this.pump()
  }

  /** Обновление веса бега (content-length стал известен). */
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

  /** Уведомление «очередь и полёт пусты». */
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
      // Бюджет действует начиная со второй задачи: первая всегда стартует
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
 * HTTP-GET со стримингом: коннект-таймаут, повторы (5xx/429/сеть) с
 * экспоненциальным backoff, отмена, прогресс байтов. Возвращает
 * Assembler над телом ответа — парсеры могут стартовать немедленно.
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
      // Отмену пользователя не ретраим — она финальна
      if (isAbortError(error)) throw error
      lastError = error
      if (attempt < retries) {
        await backoffDelay(attempt, options.signal)
        continue
      }
      throw error
    }
  }
  throw lastError ?? new Error(`источник недоступен: ${url}`)
}

/** Коннект-таймаут: снимается первым успешным await fetch. */
function connectTimeoutTimer(
  controller: AbortController,
  ms: number,
  external?: AbortSignal,
): () => void {
  const timer = setTimeout(() => {
    controller.abort(new DOMException('таймаут соединения', 'TimeoutError'))
  }, ms)
  return () => clearTimeout(timer)
}

/** Пробрасывает внешнюю отмену в контроллер запроса. */
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

/** Экспоненциальный backoff: 250мс → 500мс → 1с → 2с → 4с (cap). */
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
 * Распаковка zlib-deflate массивов FBX (compressedLength > 0) через
 * нативный DecompressionStream — без JS-реализации zlib.
 */
export async function inflateDeflate(compressed: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream > 'u')
    throw new Error(
      'DecompressionStream недоступен — бинарный FBX с zlib-сжатием не поддерживается в этой среде',
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
