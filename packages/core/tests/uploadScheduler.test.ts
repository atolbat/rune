import { describe, expect, it } from 'bun:test'
import { createUploadScheduler } from '../src/streaming/uploadScheduler.ts'

describe('uploadScheduler (AIMD-окно)', () => {
  it('окно ограничивает байты кадра: 10 задач по 100КБ в окне 256КБ → 3', () => {
    const scheduler = createUploadScheduler({ initialBytes: 256 * 1024, minBytes: 256 * 1024 })
    let ran = 0
    for (let at = 0; at < 10; at++) {
      scheduler.push({ bytes: 100 * 1024, priority: 1, run: () => { ran++ } })
    }
    scheduler.drain()
    // 2 в окне + 1 выбывающая закрывает кадр = 3 (урок M6: continue не ограничивал)
    expect(ran).toBe(3)
    expect(scheduler.pending).toBe(7)
  })

  it('приоритеты: превью (p+1) обгоняет чанки (p)', () => {
    const scheduler = createUploadScheduler({ initialBytes: 1024, minBytes: 1024 })
    const order: string[] = []
    scheduler.push({ bytes: 1, priority: 1, run: () => order.push('chunk') })
    scheduler.push({ bytes: 1, priority: 2, run: () => order.push('preview') })
    scheduler.push({ bytes: 1, priority: 1, run: () => order.push('chunk2') })
    scheduler.drain()
    expect(order[0]).toBe('preview')
  })

  it('полный слив растит окно (additive increase)', () => {
    const scheduler = createUploadScheduler({ initialBytes: 256, minBytes: 256 })
    scheduler.push({ bytes: 100, priority: 1, run: () => {} })
    scheduler.drain()
    expect(scheduler.window).toBeGreaterThan(256)
  })

  it('дальше кадров — хвост доезжает', () => {
    const scheduler = createUploadScheduler({ initialBytes: 256 * 1024, minBytes: 64 * 1024 })
    let ran = 0
    for (let at = 0; at < 10; at++) {
      scheduler.push({ bytes: 100 * 1024, priority: 1, run: () => { ran++ } })
    }
    scheduler.drain()
    scheduler.drain()
    scheduler.drain()
    scheduler.drain()
    expect(ran).toBe(10)
    expect(scheduler.pending).toBe(0)
  })
})

describe('burst (теория N: мгновенная текстура)', () => {
  it('поднимает окно под спрос до бёрст-капа (4 МиБ), не выше', () => {
    const scheduler = createUploadScheduler({ initialBytes: 64 * 1024, minBytes: 64 * 1024 })
    scheduler.burst(2 * 1024 * 1024)
    expect(scheduler.window).toBe(2 * 1024 * 1024)
    scheduler.burst(64 * 1024 * 1024) // спрос 64 МиБ → кап 4 МиБ
    expect(scheduler.window).toBe(4 * 1024 * 1024)
  })

  it('не опускает окно и не выходит за max', () => {
    const scheduler = createUploadScheduler({ initialBytes: 2 * 1024 * 1024, maxBytes: 2 * 1024 * 1024 })
    scheduler.burst(1024) // спрос меньше окна — no-op
    expect(scheduler.window).toBe(2 * 1024 * 1024)
    scheduler.burst(64 * 1024 * 1024) // спрос выше max → max
    expect(scheduler.window).toBe(2 * 1024 * 1024)
  })

  it('кап настраивается: maxBurstBytes выше — окно следует спросу', () => {
    const scheduler = createUploadScheduler({ initialBytes: 64 * 1024, maxBurstBytes: 16 * 1024 * 1024 })
    scheduler.burst(16 * 1024 * 1024)
    expect(scheduler.window).toBe(16 * 1024 * 1024)
  })
})
