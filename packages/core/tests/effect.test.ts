import { describe, expect, it } from 'bun:test'
import { signal, effect, batch } from '../src/index.ts'

describe('effect', () => {
  it('runs immediately and re-runs when a dependency changes', () => {
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

  it('inside a batch re-runs once for all writes', () => {
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
    expect(runs).toBe(2) // the initial run + one batched run
  })

  it('tracks changes in the dependency set', () => {
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
    expect(last).toBe(10) // left is no longer a dependency
  })
})
