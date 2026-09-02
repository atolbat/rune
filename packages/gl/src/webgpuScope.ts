/**
 * webgpuScope — WebGPU availability scope BEFORE any initialization (Task 78).
 *
 * The problem (user report, Task 77): "navigator.gpu is missing" —
 * the RENDER WORKER's verdict was falsely extrapolated to the browser. On Chrome/Android
 * WebGPU exists in the main thread, but workers are not given navigator.gpu. The app
 * needs an answer to "where is WebGPU available" — IMMEDIATELY, before spawning workers, before
 * creating renderers, before requestAdapter.
 *
 * The three states the user wants:
 *   'main-only'  — the WebGPU API exists only in the main thread (Chrome/Android,
 *                  Safari, Firefox: workers are not given navigator.gpu);
 *   'everywhere' — both in the main thread and in workers (Chrome/Edge desktop);
 *   'nowhere'    — nowhere (a browser without WebGPU);
 *   'worker-only'— only in workers (a rare configuration; for completeness).
 *
 * Two API tiers:
 *   1. webgpuAvailability() — a SYNCHRONOUS snapshot of facts: the main fact instantly
 *      ('gpu' in navigator of the current thread), the worker fact — null until
 *      determined. No GPU work, safe at the very start of the page.
 *   2. probeWebgpuScope() — a worker micro-probe: a tiny blob-Worker
 *      checks navigator.gpu and posts the fact (~milliseconds). NO
 *      GPU initialization: no requestAdapter, no canvases, no contexts.
 *      The result is cached forever (the environment does not change within a page's lifetime).
 *
 * The scope is about API PRESENCE (navigator.gpu), not about the adapter: requestAdapter →
 * null is possible even with the API present (GPU/driver blocklist, software rendering).
 * Checking the adapter is a separate story (probeWebGpu() from showOn.ts, after the
 * scope decision): it is asynchronous and can take seconds on SwiftShader.
 *
 * Injecting external facts: reportWebgpuWorkerFact() — when a REAL render
 * worker has reported about itself (e.g., a webgpuEnv message); reportWebgpuMainFact()
 * — when the main-thread fact is known to the calling code (called from a worker/test).
 * Facts, not guesses: the scope never invents facts about the environment.
 */

/** Where the WebGPU API (navigator.gpu) is actually granted. */
export type WebgpuScope = 'nowhere' | 'main-only' | 'worker-only' | 'everywhere'

/** State of the worker micro-probe. */
export type WebgpuWorkerProbeState =
  | 'idle'        // not called yet
  | 'pending'     // worker probe in flight
  | 'done'        // probe finished with a fact
  | 'external'    // the fact was reported by external code (reportWebgpuWorkerFact)
  | 'unsupported' // the worker did not start (no Worker / Blob / CSP)
  | 'timeout'     // the worker did not answer in time

/** Snapshot of WebGPU API facts. Every field is a fact or null ("unknown"). */
export interface WebgpuAvailability {
  /** navigator.gpu in the browser's main thread; null — the fact is unknown
   *  (the snapshot was not taken in main and no fact was reported via reportWebgpuMainFact). */
  readonly main: boolean | null
  /** navigator.gpu in a DedicatedWorker; null — not determined yet. */
  readonly worker: boolean | null
  /** The resulting scope; null — not enough facts (worker or main unknown). */
  readonly scope: WebgpuScope | null
  /** State of the worker micro-probe (honesty diagnostics). */
  readonly workerProbe: WebgpuWorkerProbeState
  /** Was the snapshot taken in the browser's main thread? (document exists only in main.) */
  readonly mainThread: boolean
  /** navigator.gpu in the CALLING thread — an instant fact of this context. */
  readonly here: boolean
}

/** Marker of the micro-probe message (e2e/diagnostics use it to tell the probe apart). */
export const WEBUGPU_PROBE_MARKER = '__runeWebgpuProbe'

/** Source of the micro-probe: only the navigator.gpu fact, NO GPU initialization. */
export const WEBUGPU_PROBE_SRC =
  `self.postMessage({ ${WEBUGPU_PROBE_MARKER}: typeof navigator !== 'undefined' && navigator.gpu !== undefined })`

// ─── Facts (instant, synchronous) ──────────────────────────────────────────────

/** navigator.gpu in the current thread. Instant; consistent with m5-render/demos:
 *  we check the VALUE (gpu !== undefined), not just the property's presence. */
function hasGpuApiHere(): boolean {
  return typeof navigator !== 'undefined' && (navigator as { gpu?: unknown }).gpu !== undefined
}

/** The browser's main thread? document exists only in main (workers have none). */
function isMainThreadLike(): boolean {
  return typeof document !== 'undefined'
}

// ─── Module-level fact cache ─────────────────────────────────────────────────────

const facts = {
  main: null as boolean | null,
  worker: null as boolean | null,
  probe: 'idle' as WebgpuWorkerProbeState,
  pending: null as Promise<WebgpuAvailability> | null,
}

/** Pure combination of facts → scope. null = not enough facts. */
export function combineWebgpuScope(main: boolean | null, worker: boolean | null): WebgpuScope | null {
  if (main === null || worker === null) return null
  if (main && worker) return 'everywhere'
  if (main && !worker) return 'main-only'
  if (!main && worker) return 'worker-only'
  return 'nowhere'
}

/**
 * A synchronous snapshot of facts — the scope property getter. Instant, no side
 * effects, safe before/without any initialization. In the browser's main thread
 * the main fact is known right away; the worker fact appears after probeWebgpuScope()
 * or reportWebgpuWorkerFact().
 */
export function webgpuAvailability(): WebgpuAvailability {
  const here = hasGpuApiHere()
  const mainThread = isMainThreadLike()
  // In main, the main fact is known first-hand; outside main — from the cache (null if never reported).
  const main = mainThread ? here : facts.main
  return {
    main,
    worker: facts.worker,
    scope: combineWebgpuScope(main, facts.worker),
    workerProbe: facts.probe,
    mainThread,
    here,
  }
}

/** Report the MAIN thread's fact (for calls outside main and for tests). */
export function reportWebgpuMainFact(hasApi: boolean): void {
  facts.main = hasApi
}

/**
 * Report the WORKER fact from outside — e.g., when a real render worker
 * has reported about itself with a message. Cached; the next webgpuAvailability()
 * gives the scope immediately without a probe. The last fact wins (all sources are
 * real workers, they should not disagree).
 */
export function reportWebgpuWorkerFact(hasApi: boolean): void {
  facts.worker = hasApi
  facts.probe = 'external'
}

// ─── Worker micro-probe ───────────────────────────────────────────────────────

/**
 * The full scope verdict: a worker micro-probe (blob-Worker ~milliseconds,
 * NO GPU initialization — only navigator.gpu) + the main fact. Idempotent:
 * repeated calls return the cache; parallel ones are deduplicated into a single worker.
 * A failed probe (unsupported/timeout) is not cached forever — a repeated
 * call may succeed.
 */
export function probeWebgpuScope(options: { readonly timeoutMs?: number } = {}): Promise<WebgpuAvailability> {
  if (facts.worker !== null) return Promise.resolve(webgpuAvailability())
  if (facts.pending !== null) return facts.pending
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL?.createObjectURL !== 'function') {
    facts.probe = 'unsupported'
    return Promise.resolve(webgpuAvailability())
  }

  facts.probe = 'pending'
  const promise = new Promise<WebgpuAvailability>((resolve) => {
    let worker: Worker | null = null
    let url: string | null = null
    let settled = false

    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { worker?.terminate() } catch { /* already dead */ }
      if (url !== null) { try { URL.revokeObjectURL(url) } catch { /* best effort */ } }
    }

    const timer = setTimeout(() => {
      facts.probe = 'timeout'
      finish()
      resolve(webgpuAvailability())
    }, options.timeoutMs ?? 3000)

    try {
      url = URL.createObjectURL(new Blob([WEBUGPU_PROBE_SRC], { type: 'text/javascript' }))
      worker = new Worker(url)
    } catch {
      facts.probe = 'unsupported'
      finish()
      resolve(webgpuAvailability())
      return
    }

    worker.onmessage = (event: MessageEvent) => {
      const value = (event.data as Record<string, unknown> | null)?.[WEBUGPU_PROBE_MARKER]
      if (typeof value === 'boolean') {
        facts.worker = value
        facts.probe = 'done'
      } else {
        // The worker answered with the wrong message — no fact obtained, honestly "unsupported".
        facts.probe = 'unsupported'
      }
      finish()
      resolve(webgpuAvailability())
    }
    worker.onerror = () => {
      // A worker error ≠ "no API" (CSP, blob-URL quota…) — we do not invent facts.
      facts.probe = 'unsupported'
      finish()
      resolve(webgpuAvailability())
    }
  })

  facts.pending = promise
  // A successful probe stays a fact forever (worker !== null — early exit above);
  // a failed one frees the slot: the next call will try again.
  void promise.then(() => {
    if (facts.worker === null) facts.pending = null
  })
  return promise
}

// ─── Honest wording ─────────────────────────────────────────────────────

/** A human-readable explanation of the scope/facts — on behalf of the facts, no extrapolation
 *  (the Task 77 lesson: "not granted to the worker" ≠ "absent in the browser"). */
export function describeWebgpuScope(a: WebgpuAvailability): string {
  switch (a.scope) {
    case 'everywhere':
      return 'WebGPU API is granted everywhere: navigator.gpu exists both in the main thread and in workers.'
    case 'main-only':
      return 'WebGPU API only in the main thread: workers are not granted navigator.gpu (Chrome on Android, Safari, Firefox). WebGPU rendering in a worker is impossible — only WebGL2 there.'
    case 'worker-only':
      return 'WebGPU API only in workers: navigator.gpu is missing in the main thread (a rare configuration).'
    case 'nowhere':
      return 'WebGPU API is missing both in the main thread and in workers — there is no WebGPU in this environment.'
  }
  if (a.workerProbe === 'unsupported') {
    return 'WebGPU scope unknown: the worker micro-probe did not start (Worker/Blob unavailable or CSP).'
  }
  if (a.workerProbe === 'timeout') {
    return 'WebGPU scope unknown: the worker micro-probe did not answer in time.'
  }
  if (a.workerProbe === 'pending') {
    return 'WebGPU scope is being determined: the worker micro-probe is in flight (milliseconds, no GPU initialization).'
  }
  if (a.main === null) {
    return `WebGPU scope unknown: the main-thread fact was not reported (the snapshot was taken outside main; the current thread's fact: navigator.gpu ${a.here ? 'present' : 'absent'}).`
  }
  return `WebGPU scope determined partially: main=${a.main ? 'yes' : 'no'}, worker unknown — call probeWebgpuScope().`
}

/** Resets the fact cache. ONLY for tests: production code does not "change its mind" about the environment. */
export function _resetWebgpuScopeForTests(): void {
  facts.main = null
  facts.worker = null
  facts.probe = 'idle'
  facts.pending = null
}
