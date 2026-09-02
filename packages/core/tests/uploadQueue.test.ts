import { describe, expect, it } from 'bun:test'
import { createUploadQueue } from '../src/index.ts'
import type { UploadJob } from '../src/index.ts'

describe('upload queue (binary heap)', () => {
  it('pop hands out tasks by ascending priority', () => {
    const queue = createUploadQueue()
    queue.push(job(5))
    queue.push(job(1))
    queue.push(job(3))
    queue.push(job(2))
    queue.push(job(4))

    const priorities: number[] = []
    for (let i = 0; i < 5; i++) {
      const job = queue.pop()
      if (job !== null) priorities.push(job.priority)
    }
    expect(priorities).toEqual([1, 2, 3, 4, 5])
  })

  it('size and clear work', () => {
    const queue = createUploadQueue()
    queue.push(job(1))
    queue.push(job(2))
    expect(queue.size).toBe(2)
    queue.clear()
    expect(queue.size).toBe(0)
    expect(queue.pop()).toBeNull()
  })

  it('the heap survives a large shuffled set', () => {
    const queue = createUploadQueue()
    const priorities: number[] = []
    for (let i = 0; i < 1000; i++) priorities.push((i * 7919) % 1000)
    for (const priority of priorities) queue.push(job(priority))

    let previous = -Infinity
    for (let i = 0; i < 1000; i++) {
      const job = queue.pop()
      expect(job).not.toBeNull()
      expect((job as UploadJob).priority).toBeGreaterThanOrEqual(previous)
      previous = (job as UploadJob).priority
    }
  })
})

function job(priority: number): UploadJob {
  return { bytes: 1, priority, run: () => {} }
}
