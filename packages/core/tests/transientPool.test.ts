import { describe, expect, it } from 'bun:test'
import { createTransientPool } from '../src/pool/transientPool.ts'

/** Transient pool (idea #2): per-frame scratch arrays without GC pressure. */
describe('createTransientPool', () => {
  it('within a frame allocations differ: no scratch collisions', () => {
    const pool = createTransientPool(2)
    const a = pool.f32(16)
    const b = pool.f32(16)
    expect(a).not.toBe(b)
    expect(pool.stats().created).toBe(2)
  })

  it('after depth frames the buffer is reused (the same object)', () => {
    const pool = createTransientPool(2)
    const a = pool.f32(16)
    pool.beginFrame() // frame 1: a is still busy
    const early = pool.f32(16)
    expect(early).not.toBe(a) // too early — a new buffer
    pool.beginFrame() // frame 2: a has lived through depth frames
    const reused = pool.f32(16)
    expect(reused).toBe(a) // the same object, zero new allocations
    expect(pool.stats().created).toBe(2)
  })

  it('types and lengths are isolated per bin', () => {
    const pool = createTransientPool(1)
    const f32 = pool.f32(16)
    const f64 = pool.f64(16)
    const u8 = pool.u8(64)
    const wide = pool.f32(64)
    expect(f32).toBeInstanceOf(Float32Array)
    expect(f64).toBeInstanceOf(Float64Array)
    expect(u8).toBeInstanceOf(Uint8Array)
    expect(wide.length).toBe(64)
    expect(pool.stats().created).toBe(4)
  })

  it('counters are honest: pooled + leased = created', () => {
    const pool = createTransientPool(2)
    pool.f32(16)
    pool.f32(16)
    pool.beginFrame()
    const stats = pool.stats()
    expect(stats.created).toBe(2)
    expect(stats.leased).toBe(2)
    expect(stats.pooled).toBe(0)
    expect(stats.frames).toBe(1)
    pool.beginFrame()
    pool.f32(16) // evicts both into free and takes one
    const after = pool.stats()
    expect(after.pooled).toBe(1)
    expect(after.leased).toBe(1)
    expect(after.created).toBe(2)
  })

  it('bytes are counted by type: f64 is twice as heavy as f32', () => {
    const pool = createTransientPool(1)
    pool.f32(100)
    pool.f64(100)
    expect(pool.stats().bytes).toBe(100 * 4 + 100 * 8)
  })

  it('memory is stable: hundreds of frames do not grow created', () => {
    const pool = createTransientPool(2)
    for (let frame = 0; frame < 200; frame++) {
      pool.beginFrame()
      pool.f32(16)
      pool.f32(1024)
    }
    const stats = pool.stats()
    expect(stats.created).toBe(4) // 2 lengths × depth frames
    expect(stats.frames).toBe(200)
  })
})
