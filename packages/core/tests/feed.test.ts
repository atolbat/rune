import { describe, expect, it } from 'bun:test'
import { createFeed, attachFeed, feedStride } from '../src/index.ts'

const LAYOUT = { pos: 'float32', speed: 'float32', color: 'unorm8x4' } as const

describe('feed', () => {
  it('stride is computed from the layout', () => {
    expect(feedStride(LAYOUT)).toBe(12)
  })

  it('a worker writes a batch and publishes it with a single atomic counter', () => {
    const feed = createFeed({ layout: LAYOUT, capacity: 1024 })
    const workerSide = attachFeed(feed.buffer, LAYOUT, 1024)

    const batch = workerSide.push(3)
    batch.setFloat('pos', 0, 1.5)
    batch.setFloat('pos', 1, 2.5)
    batch.setFloat('pos', 2, 3.5)
    batch.setFloat('speed', 0, 0.25)
    batch.setVec4Bytes('color', 0, 255, 128, 0, 255)

    expect(workerSide.publishedCount()).toBe(0) // not visible before publish
    workerSide.publish()
    expect(workerSide.publishedCount()).toBe(3)
    expect(feed.publishedCount()).toBe(3) // the owner sees the same number
  })

  it('several batches in a row are published sequentially', () => {
    const feed = createFeed({ layout: LAYOUT, capacity: 64 })
    const w = attachFeed(feed.buffer, LAYOUT, 64)
    w.push(10).setFloat('pos', 0, 0)
    w.publish()
    w.push(5).setFloat('pos', 10, 9)
    w.publish()
    expect(feed.publishedCount()).toBe(15)
  })

  it('writing to an undeclared field is an error', () => {
    const feed = createFeed({ layout: LAYOUT, capacity: 8 })
    const batch = feed.push(1)
    expect(() => batch.setFloat('unknown', 0, 1)).toThrow()
  })

  it('the owner reads the data from the shared buffer', () => {
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

  // ── M5 (Task 73): vector formats + local backing ──

  it('stride of vector fields: float32x2/x3/x4 (dossier §4.3 feed layout)', () => {
    expect(feedStride({ p: 'float32x2' })).toBe(8)
    expect(feedStride({ position: 'float32x3', color: 'float32x3', radius: 'float32' })).toBe(28)
    expect(feedStride({ m: 'float32x4' })).toBe(16)
  })

  it('setVec2/3/4 write components into an interleaved record', () => {
    const layout = { position: 'float32x3', uv: 'float32x2', tint: 'float32x4' } as const
    const feed = createFeed({ layout, capacity: 4 })
    const b = feed.push(2)
    b.setVec3('position', 0, 1, 2, 3)
    b.setVec2('uv', 0, 0.5, 0.25)
    b.setVec4('tint', 1, 9, 8, 7, 6)
    feed.publish()
    const f32 = new Float32Array(feed.buffer, 64)
    // Record 0: [1,2,3, 0.5,0.25, 0,0,0] — stride 9 float.
    expect(f32[0]).toBe(1); expect(f32[2]).toBe(3)
    expect(f32[3]).toBe(0.5); expect(f32[4]).toBe(0.25)
    // Record 1: tint with offset 5.
    expect(f32[9 + 5]).toBe(9); expect(f32[9 + 8]).toBe(6)
  })

  it('local backing — ArrayBuffer instead of a SAB (T0/T3 world)', () => {
    const feed = createFeed({ layout: { value: 'float32' }, capacity: 8, backing: 'local' })
    expect(feed.buffer instanceof ArrayBuffer).toBe(true)
    feed.push(1).setFloat('value', 0, 3.25)
    feed.publish()
    expect(feed.publishedCount()).toBe(1)
    expect(new Float32Array(feed.buffer, 64)[0]).toBe(3.25)
  })
})

describe('Task 114: the reused feed writer', () => {
  it('ONE writer object, re-aimed by push()/view() — identity is stable, writes land in the new window', () => {
    const layout = { value: 'float32' } as const
    const feed = createFeed({ layout, capacity: 8, backing: 'local' })
    const w1 = feed.push(2)
    w1.setFloat('value', 0, 11)
    w1.setFloat('value', 1, 22)
    const w2 = feed.push(2)
    // The contract: the same object, the previous window is re-aimed.
    expect(w2).toBe(w1)
    w2.setFloat('value', 0, 33)
    w2.setFloat('value', 1, 44)
    feed.publish()
    const f32 = new Float32Array(feed.buffer, 64)
    expect(f32[0]).toBe(11)
    expect(f32[1]).toBe(22)
    expect(f32[2]).toBe(33)
    expect(f32[3]).toBe(44)
    // view() re-aims the same writer.
    const w3 = feed.view(1, 1)
    expect(w3).toBe(w1)
    w3.setFloat('value', 0, 99)
    expect(f32[1]).toBe(99)
  })

  it('field offsets are resolved once — a bogus field still throws (validation is not cached away)', () => {
    const feed = createFeed({ layout: { value: 'float32' }, capacity: 4, backing: 'local' })
    const batch = feed.push(1)
    expect(() => batch.setFloat('nope', 0, 1)).toThrow(/not declared/)
  })
})
