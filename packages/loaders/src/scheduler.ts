/**
 * scheduler.ts — планировщик загрузок: приоритеты, квоты, отмена.
 *
 * Отвечает на вопрос «что качать СЕЙЧАС»:
 *   - maxConcurrent — сколько тел качается параллельно;
 *   - maxBytesInFlight — квота «сколько надо грузить» одновременно:
 *     задание не стартует, пока (в полёте + вес нового) > квоты. Вес —
 *     Content-Length (или weightBytes), уточняется по факту;
 *   - приоритет: меньше = раньше; смена приоритета переупорядочивает очередь;
 *   - paused — «взять паузу» без отмены (resume продолжает с места).
 *
 * Планировщик не знает про форматы и сеть: Job — интерфей с weight()/start().
 */

export interface SchedulerJob {
  readonly id: number
  priority: number
  /** Порядок вставки — стабильный FIFO внутри одного приоритета. */
  readonly seq: number
  /** Ожидаемый вес в байтах (для квоты). Может уточняться. */
  weight(): number
  /** Запуск: resolve = конец работы (успех или ошибка), reject = ошибка. */
  start(signal: AbortSignal): Promise<void>
  /** Вызывается при отмене ДО старта (start не будет вызван). */
  onCancelledBeforeStart?(reason?: string): void
}

export interface SchedulerOptions {
  /** Параллельных загрузок. Default 3. */
  readonly maxConcurrent?: number
  /** Квота байт «в полёте» (веса running-заданий). Default 64 MB. */
  readonly maxBytesInFlight?: number
}

export interface SchedulerStats {
  readonly running: number
  readonly queued: number
  readonly bytesInFlight: number
  readonly maxConcurrent: number
  readonly maxBytesInFlight: number
  readonly started: number
  readonly finished: number
}

/** Отмена задания, ещё не стартовавшего (queued). */
export class JobCancelled extends Error {
  constructor(reason?: string) {
    super(reason ?? 'задание отменено до старта')
    this.name = 'JobCancelled'
  }
}

let nextJobId = 1

export class LoadScheduler {
  private maxConcurrent: number
  private maxBytesInFlight: number
  private readonly queue: SchedulerJob[] = []
  private readonly running = new Map<number, { job: SchedulerJob; controller: AbortController }>()
  private readonly weights = new Map<number, number>()
  private bytesInFlight = 0
  private paused = false
  private started = 0
  private finished = 0
  private readonly drainListeners = new Set<() => void>()

  constructor(options: SchedulerOptions = {}) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 3)
    this.maxBytesInFlight = Math.max(1, options.maxBytesInFlight ?? 64 * 1024 * 1024)
  }

  /** Поставить задание; стартует сразу, если есть слот и квота. */
  submit(job: SchedulerJob): void {
    this.queue.push(job)
    this.sortQueue()
    this.pump()
  }

  /** Сменить приоритет; true если повлияло (queued-задание). */
  setPriority(job: SchedulerJob, priority: number): boolean {
    if (job.priority === priority) return false
    job.priority = priority
    const inQueue = this.queue.includes(job)
    if (inQueue) this.sortQueue()
    this.pump()
    return inQueue
  }

  /** Отменить: queued — выкидывается (start не будет); running — abort. */
  cancel(job: SchedulerJob, reason?: string): boolean {
    const qi = this.queue.indexOf(job)
    if (qi >= 0) {
      this.queue.splice(qi, 1)
      job.onCancelledBeforeStart?.(reason)
      this.notifyDrain()
      return true
    }
    const run = this.running.get(job.id)
    if (run !== undefined) {
      run.controller.abort(new DOMException(reason ?? 'загрузка отменена', 'AbortError'))
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

  /** Динамическая смена квоты (например, по network hints). */
  setBytesQuota(bytes: number): void {
    this.maxBytesInFlight = Math.max(1, bytes)
    this.pump()
  }

  /** Вес running-задания уточнён (Content-Length пришёл / байты растут). */
  updateWeight(job: SchedulerJob): void {
    if (!this.running.has(job.id)) return
    const old = this.weights.get(job.id)
    const fresh = Math.max(1, job.weight())
    if (old === fresh) return
    this.weights.set(job.id, fresh)
    this.bytesInFlight += fresh - (old ?? fresh)
    if (this.bytesInFlight < 0) this.bytesInFlight = 0
    this.pump()
  }

  setConcurrency(n: number): void {
    this.maxConcurrent = Math.max(1, n)
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

  /** Колбэк «очередь опустела» — для тестов и idle-индикации. */
  onDrain(listener: () => void): () => void {
    this.drainListeners.add(listener)
    return () => this.drainListeners.delete(listener)
  }

  private notifyDrain(): void {
    if (this.queue.length === 0 && this.running.size === 0) {
      for (const l of [...this.drainListeners]) l()
    }
  }

  private sortQueue(): void {
    // Стабильная сортировка (Array.prototype.sort — стабильна по спецификации).
    this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq)
  }

  private pump(): void {
    if (this.paused) return
    while (this.running.size < this.maxConcurrent && this.queue.length > 0) {
      const job = this.queue[0]
      if (job === undefined) break
      const weight = Math.max(1, job.weight())
      if (this.running.size > 0 && this.bytesInFlight + weight > this.maxBytesInFlight) {
        // Квота: голова очереди не лезет — не стартуем НИЧЕГО ниже неё
        // (приоритетный порядок важнее параллельности: младшие приоритеты
        // не должны «объедать» старшие, стартуя мимо блокированной головы).
        break
      }
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
    const run = this.running.get(jobId)
    if (run === undefined) return
    this.running.delete(jobId)
    const weight = this.weights.get(jobId) ?? Math.max(1, run.job.weight())
    this.weights.delete(jobId)
    this.bytesInFlight -= weight
    if (this.bytesInFlight < 0) this.bytesInFlight = 0
    this.finished++
    this.pump()
    this.notifyDrain()
  }
}

/** Фабрика id для внешних обвязок. */
export function nextSchedulerJobId(): number {
  return nextJobId++
}

/** Сброс счётчика id — ТОЛЬКО для тестов (изоляция). */
export function resetSchedulerJobIdsForTests(): void {
  nextJobId = 1
}
