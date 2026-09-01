import { describe, expect, it } from 'bun:test'
import { createTransientPool } from '../src/pool/transientPool.ts'

/** Transient-пул (идея №2): кадровые скретч-массивы без GC-давления. */
describe('createTransientPool', () => {
  it('внутри кадра выдачи различны: коллизий скретша нет', () => {
    const pool = createTransientPool(2)
    const a = pool.f32(16)
    const b = pool.f32(16)
    expect(a).not.toBe(b)
    expect(pool.stats().created).toBe(2)
  })

  it('через depth кадров буфер переиспользуется (тот же объект)', () => {
    const pool = createTransientPool(2)
    const a = pool.f32(16)
    pool.beginFrame() // кадр 1: a ещё занят
    const early = pool.f32(16)
    expect(early).not.toBe(a) // слишком рано — новый буфер
    pool.beginFrame() // кадр 2: a прожил depth кадров
    const reused = pool.f32(16)
    expect(reused).toBe(a) // тот же объект, ноль новых аллокаций
    expect(pool.stats().created).toBe(2)
  })

  it('типы и длины изолированы по бинам', () => {
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

  it('счётчики честные: pooled + leased = created', () => {
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
    pool.f32(16) // вытесняет оба в free и берёт один
    const after = pool.stats()
    expect(after.pooled).toBe(1)
    expect(after.leased).toBe(1)
    expect(after.created).toBe(2)
  })

  it('байты считаются по типу: f64 в два раза тяжелее f32', () => {
    const pool = createTransientPool(1)
    pool.f32(100)
    pool.f64(100)
    expect(pool.stats().bytes).toBe(100 * 4 + 100 * 8)
  })

  it('память стабильна: сотни кадров не растят created', () => {
    const pool = createTransientPool(2)
    for (let frame = 0; frame < 200; frame++) {
      pool.beginFrame()
      pool.f32(16)
      pool.f32(1024)
    }
    const stats = pool.stats()
    expect(stats.created).toBe(4) // 2 длины × depth кадров
    expect(stats.frames).toBe(200)
  })
})
