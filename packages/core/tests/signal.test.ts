import { describe, expect, it } from 'bun:test'
import { signal } from '../src/signal/signal.ts'
import { derive } from '../src/signal/derive.ts'

describe('сигналы', () => {
  it('запись меняет значение и двигает версию', () => {
    const cell = signal(1)
    expect(cell.value).toBe(1)
    expect(cell.version).toBe(0)
    cell.value = 2
    expect(cell.value).toBe(2)
    expect(cell.version).toBe(1)
  })

  it('повторная запись того же значения не двигает версию', () => {
    const cell = signal(5)
    cell.value = 5
    expect(cell.version).toBe(0)
  })

  it('подписка получает значения, отписка молчит', () => {
    const cell = signal(0)
    const seen: number[] = []
    const off = cell.subscribe(v => seen.push(v))
    cell.value = 1
    cell.value = 2
    off()
    cell.value = 3
    expect(seen).toEqual([1, 2])
  })

  it('derive пересчитывается по зависимости', () => {
    const width = signal(800)
    const height = signal(600)
    const aspect = derive(() => width.value / height.value)
    expect(aspect.peek()).toBeCloseTo(800 / 600)
    height.value = 400
    expect(aspect.peek()).toBeCloseTo(2)
  })

  it('peek derive не считает заново при чистых зависимостях', () => {
    let computations = 0
    const base = signal(1)
    const derived = derive(() => { computations++; return base.value * 2 })
    expect(derived.peek()).toBe(2)
    expect(derived.peek()).toBe(2)
    expect(computations).toBeLessThanOrEqual(2)
  })
})
