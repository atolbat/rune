/**
 * scheduler.ts — download scheduler: priorities, quotas, cancellation.
 *
 * Answers the question "what to download NOW":
 *   - maxConcurrent — how many bodies download in parallel;
 *   - maxBytesInFlight — quota for "how much may be loading" at once:
 *     a job does not start while (in flight + weight of the new one) > quota. Weight is
 *     Content-Length (or weightBytes), refined as facts arrive;
 *   - priority: lower = earlier; a priority change reorders the queue;
 *   - paused — "take a break" without cancelling (resume continues where it left off).
 *
 * The scheduler knows nothing about formats or the network: Job is an interface with weight()/start().
 */

export interface SchedulerJob {
  readonly id: number
  priority: number
  /** Insertion order — stable FIFO within a single priority. */
  readonly seq: number
  /** Expected weight in bytes (for the quota). May be refined. */
  weight(): number
  /** Start: resolve = end of work (success or error), reject = error. */
  start(signal: AbortSignal): Promise<void>
  /** Called on cancellation BEFORE start (start will not be called). */
  onCancelledBeforeStart?(reason?: string): void
}

export interface SchedulerOptions {
  /** Parallel downloads. Default 3. */
  readonly maxConcurrent?: number
  /** Quota for bytes "in flight" (weights of running jobs). Default 64 MB. */
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

/** Cancellation of a job that has not started yet (queued). */
export class JobCancelled extends Error {
  constructor(reason?: string) {
    super(reason ?? 'job cancelled before start')
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

  /** Submit a job; starts immediately if there is a slot and quota. */
  submit(job: SchedulerJob): void {
    this.queue.push(job)
    this.sortQueue()
    this.pump()
  }

  /** Change priority; true if it had an effect (queued job). */
  setPriority(job: SchedulerJob, priority: number): boolean {
    if (job.priority === priority) return false
    job.priority = priority
    const inQueue = this.queue.includes(job)
    if (inQueue) this.sortQueue()
    this.pump()
    return inQueue
  }

  /** Cancel: queued — dropped (start will not be called); running — abort. */
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
      run.controller.abort(new DOMException(reason ?? 'loading cancelled', 'AbortError'))
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

  /** Dynamic quota change (e.g., from network hints). */
  setBytesQuota(bytes: number): void {
    this.maxBytesInFlight = Math.max(1, bytes)
    this.pump()
  }

  /** Weight of a running job refined (Content-Length arrived / bytes grow). */
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

  /** "queue is empty" callback — for tests and idle indication. */
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
    // Stable sort (Array.prototype.sort is stable per the specification).
    this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq)
  }

  private pump(): void {
    if (this.paused) return
    while (this.running.size < this.maxConcurrent && this.queue.length > 0) {
      const job = this.queue[0]
      if (job === undefined) break
      const weight = Math.max(1, job.weight())
      if (this.running.size > 0 && this.bytesInFlight + weight > this.maxBytesInFlight) {
        // Quota: the queue head does not fit — start NOTHING below it
        // (priority order matters more than parallelism: lower priorities
        // must not "starve" higher ones by starting past the blocked head).
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

/** id factory for external wrappers. */
export function nextSchedulerJobId(): number {
  return nextJobId++
}

/** Reset the id counter — ONLY for tests (isolation). */
export function resetSchedulerJobIdsForTests(): void {
  nextJobId = 1
}
