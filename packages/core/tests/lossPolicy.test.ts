import { describe, test, expect } from 'bun:test'
import { decideRecovery, createLossBudget, classifyDeviceLost } from '../src/journal/lossPolicy.ts'
import type { LossEvent } from '../src/journal/lossPolicy.ts'

const T0 = 1_000_000

function event(kind: LossEvent['kind'], at = T0, backend: LossEvent['backend'] = 'webgl2'): LossEvent {
  return { kind, backend, at }
}

describe('lossPolicy — решение «восстанавливать?»', () => {
  test('context-lost (WebGL2) → recover', () => {
    const d = decideRecovery(event('context-lost'))
    expect(d.recover).toBe(true)
    expect(d.kind).toBe('context-lost')
  })

  test('device-destroyed (WebGPU) → recover (ожидаемая потеря)', () => {
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

  test('shader-compile → НЕ восстанавливать (тот же шейдер убьёт снова)', () => {
    const d = decideRecovery(event('shader-compile'))
    expect(d.recover).toBe(false)
    expect(d.strategy).toBe('abort')
    expect(d.kind).toBe('shader-compile')
    expect(d.message).toContain('шейдер')
  })

  test('loss-storm: 3 потери за 10 с → НЕ восстанавливать; 2 — ещё можно', () => {
    // две потери в истории + третья сейчас = 3 за окно
    const history = [event('context-lost', T0 - 1000), event('context-lost', T0 - 500)]
    const d = decideRecovery(event('context-lost', T0), history)
    expect(d.recover).toBe(false)
    expect(d.strategy).toBe('abort')
    expect(d.kind).toBe('loss-storm')
    // две суммарно — восстановление ещё разрешено
    const ok = decideRecovery(event('context-lost', T0), [event('context-lost', T0 - 500)])
    expect(ok.recover).toBe(true)
    expect(ok.strategy).toBe('full')
  })

  test('старые потери за пределами окна не считаются', () => {
    const history = [event('context-lost', T0 - 60_000), event('context-lost', T0 - 59_000)]
    const d = decideRecovery(event('context-lost', T0), history)
    expect(d.recover).toBe(true)
  })

  test('обычные потери → strategy=full (полный replay)', () => {
    expect(decideRecovery(event('context-lost')).strategy).toBe('full')
    expect(decideRecovery(event('device-unknown', T0, 'webgpu')).strategy).toBe('full')
  })

  test('OOM без истории → soft reset (не фатален)', () => {
    const d = decideRecovery(event('out-of-memory', T0, 'webgpu'))
    expect(d.recover).toBe(true)
    expect(d.strategy).toBe('soft')
  })

  test('шторм поверх OOM всё равно abort (повторный OOM на минимальном множестве)', () => {
    const history = [event('out-of-memory', T0 - 1000), event('out-of-memory', T0 - 500)]
    const d = decideRecovery(event('out-of-memory', T0), history)
    expect(d.recover).toBe(false)
    expect(d.strategy).toBe('abort')
    expect(d.kind).toBe('loss-storm')
  })
})

describe('lossPolicy — LossBudget (скользящее окно шторма)', () => {
  test('note/storm: порог достигается и окно скользит', () => {
    const budget = createLossBudget(10_000, 3)
    budget.note(event('context-lost', T0))
    expect(budget.storm()).toBe(false)
    budget.note(event('context-lost', T0 + 1_000))
    expect(budget.storm()).toBe(false)
    budget.note(event('context-lost', T0 + 2_000))
    expect(budget.storm()).toBe(true)
    // события выпадают из окна → шторм кончился
    budget.note(event('context-lost', T0 + 50_000))
    expect(budget.storm()).toBe(false)
  })

  test('reset(): сброс окна (симуляция кнопкой независимых потерь)', () => {
    const budget = createLossBudget(10_000, 3)
    budget.note(event('context-lost', T0))
    budget.note(event('context-lost', T0 + 500))
    budget.reset()
    expect(budget.storm()).toBe(false)
    budget.note(event('context-lost', T0 + 1_000))
    expect(budget.storm()).toBe(false) // окно чистое после reset
  })
})

describe('lossPolicy — классификация device.lost', () => {
  test("reason='destroyed' → device-destroyed; прочее → device-unknown", () => {
    expect(classifyDeviceLost('destroyed')).toBe('device-destroyed')
    expect(classifyDeviceLost('unknown')).toBe('device-unknown')
    expect(classifyDeviceLost(undefined)).toBe('device-unknown')
  })
})
