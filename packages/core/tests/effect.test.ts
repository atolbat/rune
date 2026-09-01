import { describe, expect, it } from 'bun:test'
import { signal, effect, batch } from '../src/index.ts'

describe('effect', () => {
  it('выполняется сразу и перевыполняется при изменении зависимости', () => {
    const step = signal(0)
    let runs = 0
    const stop = effect(() => {
      runs++
      step.value
    })

    expect(runs).toBe(1)
    step.value = 1
    expect(runs).toBe(2)

    stop()
    step.value = 2
    expect(runs).toBe(2)
  })

  it('в batch перевыполняется один раз на все записи', () => {
    const counter = signal(0)
    let runs = 0
    effect(() => {
      runs++
      counter.value
    })

    batch(() => {
      counter.value = 1
      counter.value = 2
    })
    expect(runs).toBe(2) // начальный + один пакетный
  })

  it('следит за сменой набора зависимостей', () => {
    const left = signal(1)
    const right = signal(10)
    const useRight = signal(false)
    let last = 0

    effect(() => {
      last = useRight.value ? right.value : left.value
    })

    expect(last).toBe(1)
    left.value = 2
    expect(last).toBe(2)

    useRight.value = true
    expect(last).toBe(10)

    left.value = 3
    expect(last).toBe(10) // left больше не зависимость
  })
})
