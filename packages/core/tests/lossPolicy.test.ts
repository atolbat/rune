import { describe, test, expect } from 'bun:test'
import { decideRecovery, createLossBudget, classifyDeviceLost } from '../src/journal/lossPolicy.ts'
import type { LossEvent } from '../src/journal/lossPolicy.ts'

const T0 = 1_000_000

function event(kind: LossEvent['kind'], at = T0, backend: LossEvent['backend'] = 'webgl2'): LossEvent {
  return { kind, backend, at }
}

describe('lossPolicy — the "recover?" decision', () => {
  test('context-lost (WebGL2) → recover', () => {
    const d = decideRecovery(event('context-lost'))
    expect(d.recover).toBe(true)
    expect(d.kind).toBe('context-lost')
  })

  test('device-destroyed (WebGPU) → recover (an expected loss)', () => {
    expect(decideRecovery(event('device-destroyed', T0, 'webgpu')).recover).toBe(true)
  })

  test('device-unknown (WebGPU) → recover', () => {
    expect(decideRecovery(event('device-unknown', T0, 'webgpu')).recover).toBe(true)
  })

  test("out-of-memory → SOFT RESET (recover + strategy='soft', Task 65)", () => {
    const d = decideRecovery(event('out-of-memory'))
    expect(d.recover).toBe(true)
    expect(d.strategy).toBe('soft')
    expect(d.kind).toBe('out-of-memory')
    expect(d.message).toContain('out-of-memory')
    expect(d.message).toContain('SOFT RESET')
    expect(d.message).toContain('ensureResident')
  })

  test('shader-compile → do NOT recover (the same shader will kill it again)', () => {
    const d = decideRecovery(event('shader-compile'))
    expect(d.recover).toBe(false)
    expect(d.strategy).toBe('abort')
    expect(d.kind).toBe('shader-compile')
    expect(d.message).toContain('shader')
  })

  test('loss-storm: 3 losses in 10 s → do NOT recover; 2 — still allowed', () => {
    // two losses in history + a third now = 3 within the window
    const history = [event('context-lost', T0 - 1000), event('context-lost', T0 - 500)]
    const d = decideRecovery(event('context-lost', T0), history)
    expect(d.recover).toBe(false)
    expect(d.strategy).toBe('abort')
    expect(d.kind).toBe('loss-storm')
    // two in total — recovery is still allowed
    const ok = decideRecovery(event('context-lost', T0), [event('context-lost', T0 - 500)])
    expect(ok.recover).toBe(true)
    expect(ok.strategy).toBe('full')
  })

  test('old losses outside the window are not counted', () => {
    const history = [event('context-lost', T0 - 60_000), event('context-lost', T0 - 59_000)]
    const d = decideRecovery(event('context-lost', T0), history)
    expect(d.recover).toBe(true)
  })

  test('ordinary losses → strategy=full (a full replay)', () => {
    expect(decideRecovery(event('context-lost')).strategy).toBe('full')
    expect(decideRecovery(event('device-unknown', T0, 'webgpu')).strategy).toBe('full')
  })

  test('OOM without history → soft reset (not fatal)', () => {
    const d = decideRecovery(event('out-of-memory', T0, 'webgpu'))
    expect(d.recover).toBe(true)
    expect(d.strategy).toBe('soft')
  })

  test('a storm on top of OOM still aborts (repeated OOM on the minimal set)', () => {
    const history = [event('out-of-memory', T0 - 1000), event('out-of-memory', T0 - 500)]
    const d = decideRecovery(event('out-of-memory', T0), history)
    expect(d.recover).toBe(false)
    expect(d.strategy).toBe('abort')
    expect(d.kind).toBe('loss-storm')
  })
})

describe('lossPolicy — LossBudget (the sliding storm window)', () => {
  test('note/storm: the threshold is reached and the window slides', () => {
    const budget = createLossBudget(10_000, 3)
    budget.note(event('context-lost', T0))
    expect(budget.storm()).toBe(false)
    budget.note(event('context-lost', T0 + 1_000))
    expect(budget.storm()).toBe(false)
    budget.note(event('context-lost', T0 + 2_000))
    expect(budget.storm()).toBe(true)
    // events fall out of the window → the storm is over
    budget.note(event('context-lost', T0 + 50_000))
    expect(budget.storm()).toBe(false)
  })

  test('reset(): window reset (simulating independent losses with a button)', () => {
    const budget = createLossBudget(10_000, 3)
    budget.note(event('context-lost', T0))
    budget.note(event('context-lost', T0 + 500))
    budget.reset()
    expect(budget.storm()).toBe(false)
    budget.note(event('context-lost', T0 + 1_000))
    expect(budget.storm()).toBe(false) // the window is clean after reset
  })
})

describe('lossPolicy — device.lost classification', () => {
  test("reason='destroyed' → device-destroyed; the rest → device-unknown", () => {
    expect(classifyDeviceLost('destroyed')).toBe('device-destroyed')
    expect(classifyDeviceLost('unknown')).toBe('device-unknown')
    expect(classifyDeviceLost(undefined)).toBe('device-unknown')
  })
})
