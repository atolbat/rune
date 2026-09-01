import { describe, expect, it } from 'bun:test'
import { signal, derive } from '../src/index.ts'

describe('derive', () => {
  it('вычисляет один раз и кэширует до инвалидации', () => {
    const base = signal(2)
    let computations = 0
    const doubled = derive(() => {
      computations++
      return base.value * 2
    })

    expect(doubled.value).toBe(4)
    expect(doubled.value).toBe(4)
    expect(computations).toBe(1)

    base.value = 5
    expect(doubled.value).toBe(10)
    expect(computations).toBe(2)
  })

  it('без подписчиков не пересчитывает eagerly', () => {
    const base = signal(1)
    let computations = 0
    derive(() => {
      computations++
      return base.value + 1
    })

    base.value = 2
    base.value = 3
    expect(computations).toBe(1) // только конструктор
  })

  it('строит цепочки производных', () => {
    const a = signal(1)
    const b = derive(() => a.value + 1)
    const c = derive(() => b.value * 10)

    expect(c.value).toBe(20)
    a.value = 2
    expect(c.value).toBe(30)
  })

  it('подписчик производного получает свежее значение', () => {
    const base = signal(1)
    const doubled = derive(() => base.value * 2)
    const observed: number[] = []
    doubled.subscribe(value => observed.push(value))

    base.value = 4
    expect(observed).toEqual([8])
  })

  it('версия растёт при каждом реальном пересчёте', () => {
    const base = signal(1)
    const derived = derive(() => base.value + 1)
    const initial = derived.version
    base.value = 2
    expect(derived.value).toBe(3)
    expect(derived.version).toBeGreaterThan(initial)
  })

  it('регрессия сумм-версий: убывание версии внутреннего не «гасит» внешнего', () => {
    // Сумма версий зависимостей могла ВОЗВРАЩАТЬСЯ при смене набора
    // зависимостей (b ушёл, useB вырос) — внешний derive видел «чисто»
    // и отдавал протухшее значение. Поэлементное сравнение этого не позволяет.
    const a = signal(1)
    const b = signal(100)
    const c = signal(1000)
    const useB = signal(true)
    const inner = derive(() => a.value + (useB.value ? b.value : 0))
    const outer = derive(() => inner.value + c.value)
    expect(outer.value).toBe(1101) // 1 + 100 + 1000

    b.value = 200
    expect(outer.value).toBe(1201) // 1 + 200 + 1000

    useB.value = false // inner теряет b: его старая версия-сумма возвращалась к прежней
    expect(inner.value).toBe(1)
    expect(outer.value).toBe(1001) // протухший ответ старого кода: 1201
  })

  it('version — монотонная ревизия: не убывает при смене набора зависимостей', () => {
    const a = signal(1)
    const b = signal(100)
    const useB = signal(true)
    const inner = derive(() => (useB.value ? a.value + b.value : a.value))
    const v1 = inner.version
    b.value = 200
    const v2 = inner.version
    useB.value = false // b покидает зависимости — ревизия всё равно растёт
    const v3 = inner.version
    expect(v2).toBeGreaterThan(v1)
    expect(v3).toBeGreaterThan(v2)
  })
})
