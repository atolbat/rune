import { describe, expect, it } from 'bun:test'
import { signal, createEpoch } from '../src/index.ts'

describe('epoch', () => {
  it('не выпускает уведомления за пределы frame', () => {
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

  it('поднимает индекс на каждой внешней границе', () => {
    const epoch = createEpoch()
    epoch.frame(() => {})
    epoch.frame(() => {})
    expect(epoch.index).toBe(2)
  })

  it('вложенные frame атомарны относительно внешнего', () => {
    const epoch = createEpoch()
    const state = signal(0)
    let notifications = 0
    state.subscribe(() => notifications++)

    epoch.frame(() => {
      epoch.frame(() => {
        state.value = 1
      })
      expect(notifications).toBe(0) // внутренняя граница ещё ничего не выпустила
    })

    expect(notifications).toBe(1)
    expect(epoch.index).toBe(1)
  })
})
