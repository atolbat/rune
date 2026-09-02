import { describe, expect, it } from 'bun:test'
import { createUploadScheduler } from '../src/streaming/uploadScheduler.ts'

describe('uploadScheduler (AIMD window)', () => {
  it('the window limits frame bytes: 10 tasks of 100KB in a 256KB window → 3', () => {
    const scheduler = createUploadScheduler({ initialBytes: 256 * 1024, minBytes: 256 * 1024 })
    let ran = 0
    for (let at = 0; at < 10; at++) {
      scheduler.push({ bytes: 100 * 1024, priority: 1, run: () => { ran++ } })
    }
    scheduler.drain()
    // 2 within the window + 1 dropping out closes the frame = 3 (M6 lesson: continue did not limit)
    expect(ran).toBe(3)
    expect(scheduler.pending).toBe(7)
  })

  it('priorities: preview (p+1) overtakes chunks (p)', () => {
    const scheduler = createUploadScheduler({ initialBytes: 1024, minBytes: 1024 })
    const order: string[] = []
    scheduler.push({ bytes: 1, priority: 1, run: () => order.push('chunk') })
    scheduler.push({ bytes: 1, priority: 2, run: () => order.push('preview') })
    scheduler.push({ bytes: 1, priority: 1, run: () => order.push('chunk2') })
    scheduler.drain()
    expect(order[0]).toBe('preview')
  })

  it('a full drain grows the window (additive increase)', () => {
    const scheduler = createUploadScheduler({ initialBytes: 256, minBytes: 256 })
    scheduler.push({ bytes: 100, priority: 1, run: () => {} })
    scheduler.drain()
    expect(scheduler.window).toBeGreaterThan(256)
  })

  it('more frames — the tail arrives', () => {
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

describe('burst (theory N: an instant texture)', () => {
  it('raises the window to meet demand up to the burst cap (4 MiB), not higher', () => {
    const scheduler = createUploadScheduler({ initialBytes: 64 * 1024, minBytes: 64 * 1024 })
    scheduler.burst(2 * 1024 * 1024)
    expect(scheduler.window).toBe(2 * 1024 * 1024)
    scheduler.burst(64 * 1024 * 1024) // demand 64 MiB → cap 4 MiB
    expect(scheduler.window).toBe(4 * 1024 * 1024)
  })

  it('does not lower the window and does not exceed max', () => {
    const scheduler = createUploadScheduler({ initialBytes: 2 * 1024 * 1024, maxBytes: 2 * 1024 * 1024 })
    scheduler.burst(1024) // demand below the window — a no-op
    expect(scheduler.window).toBe(2 * 1024 * 1024)
    scheduler.burst(64 * 1024 * 1024) // demand above max → max
    expect(scheduler.window).toBe(2 * 1024 * 1024)
  })

  it('the cap is configurable: maxBurstBytes higher — the window follows demand', () => {
    const scheduler = createUploadScheduler({ initialBytes: 64 * 1024, maxBurstBytes: 16 * 1024 * 1024 })
    scheduler.burst(16 * 1024 * 1024)
    expect(scheduler.window).toBe(16 * 1024 * 1024)
  })
})
