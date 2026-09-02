/** Deferred work: inside a batch it accumulates, outside it runs immediately. */
type Job = () => void

let depth = 0
let pending: Job[] = []

/** Groups writes: subscribers are notified once, on exit. */
export function batch<T>(run: () => T): T {
  enterBatch()
  try {
    return run()
  } finally {
    exitBatch()
  }
}

function enterBatch(): void {
  depth++
}

function exitBatch(): void {
  depth--
  if (depth === 0) {
    // The flush keeps the batch context (depth=1): work scheduled by the
    // notifications themselves (effect rerun, derive revalidate) accumulates
    // into the next flush turn instead of running immediately. Otherwise
    // "one rerun per batch" breaks: the first rerun resets deduplication
    // before the second write arrives (report from effect.test: runs=3
    // instead of 2).
    depth++
    try {
      flushPending()
    } finally {
      depth--
    }
  }
}

function flushPending(): void {
  // Cascade: a callback may schedule new work — spin until drained.
  while (pending.length > 0) {
    const jobs = pending
    pending = []
    for (const job of jobs) job()
  }
}

/** Schedules work: immediately outside a batch, to the end of the queue inside. */
export function schedule(job: Job): void {
  if (depth === 0) job()
  else pending.push(job)
}
