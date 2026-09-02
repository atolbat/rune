import { describe, expect, it, beforeEach } from 'bun:test'
import {
  webgpuAvailability,
  probeWebgpuScope,
  reportWebgpuMainFact,
  reportWebgpuWorkerFact,
  combineWebgpuScope,
  describeWebgpuScope,
  WEBUGPU_PROBE_SRC,
  WEBUGPU_PROBE_MARKER,
} from '../src/index.ts'
import { _resetWebgpuScopeForTests } from '../src/webgpuScope.ts'

/**
 * Task 78: the WebGPU availability scope — a property/getter BEFORE initialization.
 *
 * Contract:
 *   - webgpuAvailability() — a synchronous snapshot of facts: the main fact instantly,
 *     the worker fact null until determined; NO GPU initialization;
 *   - probeWebgpuScope() — a worker micro-probe (blob-Worker, only
 *     navigator.gpu, NO requestAdapter whatsoever), cache + dedup;
 *   - reportWebgpuWorkerFact/MainFact — injection of external facts;
 *   - the scope = a pure combination of facts, never "guessing".
 *
 * The bun environment: this is NOT the browser's main thread (no document, no
 * navigator.gpu) — exactly the honest "snapshot outside main" case: the main fact
 * only via reportWebgpuMainFact. Blob workers work in bun (verified) — the micro-probe
 * is executed for real.
 */

describe('webgpuScope — a pure combination of facts', () => {
  it('combineWebgpuScope: all four states + null when facts are missing', () => {
    expect(combineWebgpuScope(true, true)).toBe('everywhere')
    expect(combineWebgpuScope(true, false)).toBe('main-only')
    expect(combineWebgpuScope(false, true)).toBe('worker-only')
    expect(combineWebgpuScope(false, false)).toBe('nowhere')
    expect(combineWebgpuScope(null, true)).toBe(null)
    expect(combineWebgpuScope(true, null)).toBe(null)
    expect(combineWebgpuScope(null, null)).toBe(null)
  })
})

describe('webgpuScope — a synchronous snapshot (before initialization)', () => {
  beforeEach(() => _resetWebgpuScopeForTests())

  it('webgpuAvailability(): instant, no GPU work, no exceptions', () => {
    const a = webgpuAvailability()
    expect(typeof a.here).toBe('boolean')
    expect(typeof a.mainThread).toBe('boolean')
    // bun is not the browser main: no document → the main fact is unknown until reported
    expect(a.mainThread).toBe(false)
    expect(a.main).toBe(null)
    expect(a.worker).toBe(null)
    expect(a.scope).toBe(null)
    expect(a.workerProbe).toBe('idle')
  })

  it('snapshot in bun: no navigator.gpu here → here=false (no guessing)', () => {
    expect(webgpuAvailability().here).toBe(false)
  })

  it('fact injection: reportMain + reportWorker → the scope immediately, synchronously', () => {
    reportWebgpuMainFact(true)
    reportWebgpuWorkerFact(false)
    const a = webgpuAvailability()
    expect(a.main).toBe(true)
    expect(a.worker).toBe(false)
    expect(a.scope).toBe('main-only')
    expect(a.workerProbe).toBe('external')
  })

  it('no WebGPU anywhere → nowhere (a machine without WebGPU)', () => {
    reportWebgpuMainFact(false)
    reportWebgpuWorkerFact(false)
    expect(webgpuAvailability().scope).toBe('nowhere')
  })

  it('main without the API + worker with the API → worker-only (a rare but honest configuration)', () => {
    reportWebgpuMainFact(false)
    reportWebgpuWorkerFact(true)
    expect(webgpuAvailability().scope).toBe('worker-only')
  })

  it('a partial fact gives no scope: main only', () => {
    reportWebgpuMainFact(true)
    const a = webgpuAvailability()
    expect(a.scope).toBe(null)
    expect(a.worker).toBe(null)
  })
})

describe('webgpuScope — the worker micro-probe', () => {
  beforeEach(() => _resetWebgpuScopeForTests())

  it('probeWebgpuScope(): a real blob worker, a boolean fact, the cache forever', async () => {
    reportWebgpuMainFact(true)
    const a = await probeWebgpuScope()
    // a bun worker: navigator.gpu is absent → worker=false → main-only
    expect(a.worker).toBe(false)
    expect(a.scope).toBe('main-only')
    expect(a.workerProbe).toBe('done')
    // Cache: a repeated call is synchronous-instant, the same fact
    const again = await probeWebgpuScope()
    expect(again.worker).toBe(false)
    expect(again.scope).toBe('main-only')
    // The cache is also visible in the synchronous snapshot (the property getter)
    expect(webgpuAvailability().scope).toBe('main-only')
  })

  it('parallel calls are deduplicated (one worker, the same verdict)', async () => {
    reportWebgpuMainFact(false)
    const [a, b] = await Promise.all([probeWebgpuScope(), probeWebgpuScope()])
    expect(a.worker).toBe(false)
    expect(b.worker).toBe(false)
    expect(a.scope).toBe('nowhere')
    expect(b.scope).toBe('nowhere')
  })

  it('a probe after an external fact — an instant return without a worker', async () => {
    reportWebgpuMainFact(true)
    reportWebgpuWorkerFact(true)
    const a = await probeWebgpuScope()
    expect(a.scope).toBe('everywhere')
    expect(a.workerProbe).toBe('external')
  })

  it('timeout: a probe with 0ms does not hang, the verdict is honestly "unknown"', async () => {
    reportWebgpuMainFact(true)
    const a = await probeWebgpuScope({ timeoutMs: 0 })
    // 0ms: the timer fires before/instead of the worker's answer — the fact is not invented
    expect(a.main).toBe(true)
    if (a.worker === null) {
      expect(a.scope).toBe(null)
      expect(a.workerProbe === 'timeout' || a.workerProbe === 'done').toBe(true)
    } else {
      expect(a.worker).toBe(false)
    }
  })
})

describe('webgpuScope — honest wording', () => {
  beforeEach(() => _resetWebgpuScopeForTests())

  it('descriptions distinguish threads and do not extrapolate (the Task 77 lesson)', () => {
    reportWebgpuMainFact(true)
    reportWebgpuWorkerFact(false)
    const text = describeWebgpuScope(webgpuAvailability())
    expect(text).toContain('only in the main thread')
    expect(text).toContain('workers are not granted navigator.gpu')

    _resetWebgpuScopeForTests()
    reportWebgpuMainFact(false)
    reportWebgpuWorkerFact(false)
    expect(describeWebgpuScope(webgpuAvailability())).toContain('missing both in the main thread')

    _resetWebgpuScopeForTests()
    reportWebgpuMainFact(true)
    reportWebgpuWorkerFact(true)
    expect(describeWebgpuScope(webgpuAvailability())).toContain('both in the main thread and in workers')
  })

  it('an unknown scope explains WHAT is missing', () => {
    const text = describeWebgpuScope(webgpuAvailability())
    expect(text.includes('unknown')).toBe(true)
  })
})

describe('webgpuScope — the micro-probe source', () => {
  it('contains no GPU initialization (no requestAdapter at all)', () => {
    expect(WEBUGPU_PROBE_SRC).not.toContain('requestAdapter')
    expect(WEBUGPU_PROBE_SRC).toContain(WEBUGPU_PROBE_MARKER)
    expect(WEBUGPU_PROBE_SRC).toContain('navigator.gpu')
  })
})
