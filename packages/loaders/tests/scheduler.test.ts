/**
 * scheduler.test.ts — приоритеты, квоты, отмена, pause/resume.
 */

import { describe, expect, test } from 'bun:test'
import { LoadScheduler, type SchedulerJob } from '../src/scheduler.ts'

function makeJob(seq: number, weight: number, log: number[], slow = false): SchedulerJob {
  return {
    id: 100 + seq,
    priority: 5,
    seq,
    weight: () => weight,
    async start(): Promise<void> {
      log.push(this.id)
      if (slow) await new Promise(resolve => setTimeout(resolve, 5))
    },
  } as SchedulerJob
}

describe('LoadScheduler', () => {
  test('порядок по приоритету: меньше — раньше', async () => {
    const order: number[] = []
    const scheduler = new LoadScheduler({ maxConcurrent: 1 })
    const blocker = makeJob(0, 1024, order, true)
    scheduler.submit(blocker) // занял единственный слот
    const a = makeJob(1, 1024, order)
    const b = makeJob(2, 1024, order)
    const c = makeJob(3, 1024, order)
    a.priority = 7
    b.priority = 2
    c.priority = 4
    scheduler.submit(a)
    scheduler.submit(b)
    scheduler.submit(c)
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(order).toEqual([blocker.id, b.id, c.id, a.id])
  })

  test('квота байт: большой не стартует мимо блокированной головы', async () => {
    const order: number[] = []
    const scheduler = new LoadScheduler({ maxConcurrent: 3, maxBytesInFlight: 10 })
    const big = makeJob(1, 100, order, true)
    scheduler.submit(big) // первый стартует всегда (иначе квота = дедлок)
    await new Promise(resolve => setTimeout(resolve, 2))
    const small = makeJob(2, 1, order, true)
    scheduler.submit(small)
    // Синхронно: big работает (в полёте 100 > квоты 10) — small заблокирован.
    expect(order).toEqual([big.id])
    scheduler.setBytesQuota(200)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(order.length).toBe(2)
  })

  test('отмена queued: start не вызывается, колбэк получает причину', async () => {
    const started: number[] = []
    const scheduler = new LoadScheduler({ maxConcurrent: 1 })
    const blocking = makeJob(1, 1, started, true)
    scheduler.submit(blocking)
    let cancelledReason: string | undefined
    const queued = makeJob(2, 1, started)
    queued.onCancelledBeforeStart = reason => {
      cancelledReason = reason
    }
    scheduler.submit(queued)
    const cancelled = scheduler.cancel(queued, 'не нужен')
    expect(cancelled).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(started).toEqual([blocking.id])
    expect(cancelledReason).toBe('не нужен')
  })

  test('отмена running: abort-сигнал задачи', async () => {
    const scheduler = new LoadScheduler({ maxConcurrent: 1 })
    let aborted = false
    const job: SchedulerJob = {
      id: 555,
      priority: 5,
      seq: 1,
      weight: () => 1,
      start: signal =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true
            reject(new DOMException('cancelled', 'AbortError'))
          })
        }),
    }
    scheduler.submit(job)
    await new Promise(resolve => setTimeout(resolve, 2))
    expect(scheduler.cancel(job)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 2))
    expect(aborted).toBe(true)
    expect(scheduler.stats().running).toBe(0)
  })

  test('updateWeight уточняет квоту in-flight', async () => {
    const scheduler = new LoadScheduler({ maxConcurrent: 3, maxBytesInFlight: 100 })
    const order: number[] = []
    let weight = 5
    const dynamic: SchedulerJob = {
      id: 1,
      priority: 5,
      seq: 1,
      weight: () => weight,
      start: async () => {
        order.push(1)
        weight = 90
        scheduler.updateWeight(dynamic)
        await new Promise(resolve => setTimeout(resolve, 10))
      },
    }
    scheduler.submit(dynamic)
    await new Promise(resolve => setTimeout(resolve, 2))
    // Вес вырос до 90 → следующий (11) упрётся: 90+11 > 100.
    const other = makeJob(2, 11, order, true)
    scheduler.submit(other)
    await new Promise(resolve => setTimeout(resolve, 2))
    expect(scheduler.stats().running).toBe(1)
    expect(scheduler.stats().bytesInFlight).toBe(90)
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(order).toEqual([1, 102])
  })

  test('pause/resume', async () => {
    const scheduler = new LoadScheduler({ maxConcurrent: 2 })
    const order: number[] = []
    scheduler.pause()
    scheduler.submit(makeJob(1, 1, order))
    scheduler.submit(makeJob(2, 1, order))
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(order).toEqual([])
    scheduler.resume()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(order.length).toBe(2)
    expect(scheduler.isPaused).toBe(false)
  })
})
