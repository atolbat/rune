import { describe, expect, it } from 'bun:test'
import { signal, createEpoch } from '../src/index.ts'

describe('epoch', () => {
  it('does not emit notifications outside a frame', () => {
    const epoch = createEpoch()
    const state = signal(0)
    let notifications = 0
    state.subscribe(() => notifications++)

    epoch.frame(() => {
      state.value = 1
      expect(notifications).toBe(0)
    })

    expect(notifications).toBe(1)
  })

  it('increments the index on every outer boundary', () => {
    const epoch = createEpoch()
    epoch.frame(() => {})
    epoch.frame(() => {})
    expect(epoch.index).toBe(2)
  })

  it('nested frames are atomic with respect to the outer one', () => {
    const epoch = createEpoch()
    const state = signal(0)
    let notifications = 0
    state.subscribe(() => notifications++)

    epoch.frame(() => {
      epoch.frame(() => {
        state.value = 1
      })
      expect(notifications).toBe(0) // the inner boundary has not emitted anything yet
    })

    expect(notifications).toBe(1)
    expect(epoch.index).toBe(1)
  })
})
