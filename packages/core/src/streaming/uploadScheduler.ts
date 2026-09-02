/**
 * Streaming scheduler: binary heap by priority (J theory) +
 * an AIMD window of bytes per frame (anti-lag: a large upload is spread
 * over frames without choking rendering). The window grows with demand
 * (+1/8), and in idle it softly decays (×7/8) — additive increase,
 * multiplicative decay.
 *
 * N theory (instant texture): a demand burst — the streamer raises the
 * window to the texture size (up to maxBurstBytes): a texture up to the
 * cap in size loads ENTIRELY into the first idle slot, with no visible
 * frame-by-frame fill-in. Incident lesson: ramping the window from 256 KiB
 * stretched 1024² over ~10 frames — the customer literally watched the
 * texture fill in.
 */

export interface UploadJob {
  /** Task cost in bytes (the window counts bytes). */
  readonly bytes: number
  /** Higher — earlier; the preview overtakes chunks by +1. */
  readonly priority: number
  run(): void
}

export interface UploadSchedulerOptions {
  readonly initialBytes?: number
  readonly minBytes?: number
  readonly maxBytes?: number
  /** Demand burst ceiling in bytes (default 4 MiB). */
  readonly maxBurstBytes?: number
}

export interface UploadScheduler {
  push(job: UploadJob): void
  /** Raise the window for one-off demand (N theory): a small texture
   * must not stream over frames — the user sees the fill-in. */
  burst(bytes: number): void
  /** Execute tasks within the window; a closing task ends the frame. */
  drain(): void
  readonly pending: number
  /** Current window in bytes (diagnostics). */
  readonly window: number
}

export function createUploadScheduler(options: UploadSchedulerOptions = {}): UploadScheduler {
  // Incident recovery constants: initial 2 MiB and max 16 MiB —
  // the old values before the environment reset (it was 256 KiB / 8 MiB).
  const min = options.minBytes ?? 64 * 1024
  const max = options.maxBytes ?? 16 * 1024 * 1024
  const maxBurst = options.maxBurstBytes ?? 4 * 1024 * 1024
  let window = Math.min(max, Math.max(min, options.initialBytes ?? 2 * 1024 * 1024))
  const heap: UploadJob[] = []

  /** N theory: window under demand, no higher than the burst cap and max, no lower than current. */
  function burst(bytes: number): void {
    window = Math.min(max, Math.max(window, Math.min(bytes, maxBurst)))
  }

  function push(job: UploadJob): void {
    heap.push(job)
    siftUp(heap.length - 1)
  }

  function drain(): void {
    let budget = window
    let executed = 0
    let closingJob = false
    while (heap.length > 0) {
      const job = heap[0]
      if (job.bytes <= budget) {
        pop()
        job.run()
        budget -= job.bytes
        executed++
      } else {
        // Doesn't fit into the window remainder: executed as a closing
        // task and CLOSES the frame (lesson M6: continue instead of break
        // did not limit bytes)
        pop()
        job.run()
        executed++
        closingJob = true
        break
      }
    }
    adaptWindow(executed, closingJob)
  }

  /** AIMD: demand moves the window up, idle softly down. */
  function adaptWindow(executed: number, closingJob: boolean): void {
    if (closingJob || (executed > 0 && heap.length === 0)) {
      window = Math.min(max, window + Math.max(1, Math.floor(window / 8)))
    } else if (executed === 0 && heap.length === 0) {
      window = Math.max(min, Math.floor(window * 7 / 8))
    }
  }

  function pop(): void {
    const last = heap.pop()!
    if (heap.length > 0) {
      heap[0] = last
      siftDown(0)
    }
  }

  function siftUp(at: number): void {
    while (at > 0) {
      const parent = (at - 1) >> 1
      if (heap[parent].priority >= heap[at].priority) break
      swap(parent, at)
      at = parent
    }
  }

  function siftDown(at: number): void {
    for (;;) {
      const left = at * 2 + 1
      const right = left + 1
      let best = at
      if (left < heap.length && heap[left].priority > heap[best].priority) best = left
      if (right < heap.length && heap[right].priority > heap[best].priority) best = right
      if (best === at) return
      swap(best, at)
      at = best
    }
  }

  function swap(a: number, b: number): void {
    const tmp = heap[a]
    heap[a] = heap[b]
    heap[b] = tmp
  }

  return {
    push,
    burst,
    drain,
    get pending() { return heap.length },
    get window() { return window },
  }
}
