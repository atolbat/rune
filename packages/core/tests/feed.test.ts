import { describe, expect, it } from 'bun:test'
import { createFeed, attachFeed, feedStride } from '../src/index.ts'

const LAYOUT = { pos: 'float32', speed: 'float32', color: 'unorm8x4' } as const

describe('feed', () => {
  it('stride считается по layout', () => {
    expect(feedStride(LAYOUT)).toBe(12)
  })

  it('воркер пишет пакет и публикует одним атомарным счётчиком', () => {
    const feed = createFeed({ layout: LAYOUT, capacity: 1024 })
    const workerSide = attachFeed(feed.buffer, LAYOUT, 1024)

    const batch = workerSide.push(3)
    batch.setFloat('pos', 0, 1.5)
    batch.setFloat('pos', 1, 2.5)
    batch.setFloat('pos', 2, 3.5)
    batch.setFloat('speed', 0, 0.25)
    batch.setVec4Bytes('color', 0, 255, 128, 0, 255)

    expect(workerSide.publishedCount()).toBe(0) // до publish не видно
    workerSide.publish()
    expect(workerSide.publishedCount()).toBe(3)
    expect(feed.publishedCount()).toBe(3) // владелец видит то же число
  })

  it('несколько пакетов подряд публикуются последовательно', () => {
    const feed = createFeed({ layout: LAYOUT, capacity: 64 })
    const w = attachFeed(feed.buffer, LAYOUT, 64)
    w.push(10).setFloat('pos', 0, 0)
    w.publish()
    w.push(5).setFloat('pos', 10, 9)
    w.publish()
    expect(feed.publishedCount()).toBe(15)
  })

  it('запись в не объявленное поле — ошибка', () => {
    const feed = createFeed({ layout: LAYOUT, capacity: 8 })
    const batch = feed.push(1)
    expect(() => batch.setFloat('unknown', 0, 1)).toThrow()
  })

  it('данные читаются владельцем из общего буфера', () => {
    const feed = createFeed({ layout: { value: 'float32' }, capacity: 8 })
    const w = attachFeed(feed.buffer, { value: 'float32' }, 8)
    const batch = w.push(2)
    batch.setFloat('value', 0, 11)
    batch.setFloat('value', 1, 22)
    w.publish()

    const records = new Float32Array(feed.buffer, 64)
    expect(records[0]).toBe(11)
    expect(records[1]).toBe(22)
  })

  // ── M5 (Task 73): векторные форматы + local-носитель ──

  it('stride векторных полей: float32x2/x3/x4 (досье §4.3 layout фида)', () => {
    expect(feedStride({ p: 'float32x2' })).toBe(8)
    expect(feedStride({ position: 'float32x3', color: 'float32x3', radius: 'float32' })).toBe(28)
    expect(feedStride({ m: 'float32x4' })).toBe(16)
  })

  it('setVec2/3/4 пишут компоненты в интерливинг-запись', () => {
    const layout = { position: 'float32x3', uv: 'float32x2', tint: 'float32x4' } as const
    const feed = createFeed({ layout, capacity: 4 })
    const b = feed.push(2)
    b.setVec3('position', 0, 1, 2, 3)
    b.setVec2('uv', 0, 0.5, 0.25)
    b.setVec4('tint', 1, 9, 8, 7, 6)
    feed.publish()
    const f32 = new Float32Array(feed.buffer, 64)
    // Запись 0: [1,2,3, 0.5,0.25, 0,0,0] — stride 9 float.
    expect(f32[0]).toBe(1); expect(f32[2]).toBe(3)
    expect(f32[3]).toBe(0.5); expect(f32[4]).toBe(0.25)
    // Запись 1: tint с offset 5.
    expect(f32[9 + 5]).toBe(9); expect(f32[9 + 8]).toBe(6)
  })

  it('backing local — ArrayBuffer вместо SAB (T0/T3-мир)', () => {
    const feed = createFeed({ layout: { value: 'float32' }, capacity: 8, backing: 'local' })
    expect(feed.buffer instanceof ArrayBuffer).toBe(true)
    feed.push(1).setFloat('value', 0, 3.25)
    feed.publish()
    expect(feed.publishedCount()).toBe(1)
    expect(new Float32Array(feed.buffer, 64)[0]).toBe(3.25)
  })
})
