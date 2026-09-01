import { test, expect } from 'bun:test'
import { createAssetCache } from '../src/assetCache.ts'

test('acquire — single load', async () => {
  const cache = createAssetCache<string>({ maxBytes: 1024 })
  const h = cache.acquire('a', async () => 'value-a')
  expect(h.value).toBeUndefined() // ещё не загружен
  const v = await h.ready
  expect(v).toBe('value-a')
  expect(h.value).toBe('value-a')
  h.release()
  expect(cache.size).toBe(1) // остаётся в кэше (TTL ещё не истёк)
})

test('acquire — dedup parallel calls', async () => {
  const cache = createAssetCache<string>({ maxBytes: 1024 })
  let loadCount = 0
  const loader = async () => { loadCount++; return 'v' }
  const h1 = cache.acquire('a', loader)
  const h2 = cache.acquire('a', loader)
  await Promise.all([h1.ready, h2.ready])
  expect(loadCount).toBe(1) // не должно запускать loader дважды
  h1.release()
  h2.release()
})

test('refcount — multiple acquire/release', async () => {
  const cache = createAssetCache<string>({ maxBytes: 1024 })
  const h1 = cache.acquire('a', async () => 'v')
  const h2 = cache.acquire('a', async () => 'v')
  await h1.ready
  const stats1 = cache.stats()
  expect(stats1.refcounted).toBe(1) // один entry, refcount=2
  h1.release() // refcount 2→1, ещё активен
  const stats2 = cache.stats()
  expect(stats2.refcounted).toBe(1)
  expect(stats2.idle).toBe(0)
  h2.release() // refcount 1→0, idle
  const stats3 = cache.stats()
  expect(stats3.refcounted).toBe(0)
  expect(stats3.idle).toBe(1)
})

test('TTL — entry evicted after ttlFrames', async () => {
  const cache = createAssetCache<string>({ maxBytes: 1024, baseTtlFrames: 2 })
  const h = cache.acquire('a', async () => 'v')
  await h.ready
  h.release()
  expect(cache.size).toBe(1)
  cache.tick() // frame 1, idle age = 1
  expect(cache.size).toBe(1) // ещё живёт
  cache.tick() // frame 2, idle age = 2 — evict
  expect(cache.size).toBe(0)
})

test('disposer — called on eviction', async () => {
  let disposed = false
  const cache = createAssetCache<{ dispose: () => void }>(
    { maxBytes: 1024, baseTtlFrames: 1 },
    v => v.dispose(),
  )
  const h = cache.acquire('a', async () => ({ dispose: () => { disposed = true } }))
  await h.ready
  h.release()
  cache.tick() // TTL evict
  expect(disposed).toBe(true)
})

test('flush — disposes all live entries', async () => {
  let disposed = 0
  const cache = createAssetCache<{ dispose: () => void }>(
    { maxBytes: 1024 },
    () => { disposed++ },
  )
  const h1 = cache.acquire('a', async () => ({ dispose: () => {} }))
  const h2 = cache.acquire('b', async () => ({ dispose: () => {} }))
  await Promise.all([h1.ready, h2.ready])
  cache.flush()
  expect(disposed).toBe(2)
  expect(cache.size).toBe(0)
})

test('scope — child cache, bulk release on dispose', async () => {
  const cache = createAssetCache<string>({ maxBytes: 1024, baseTtlFrames: 1000 })
  const level = cache.scope()
  const h1 = level.acquire('grass', async () => 'grass-bmp')
  const h2 = level.acquire('stone', async () => 'stone-bmp')
  await Promise.all([h1.ready, h2.ready])
  // parent cache держит entries
  expect(cache.size).toBe(2)
  level.dispose() // bulk release
  // entries стали idle, но не эвикчены сразу (TTL ещё не истёк)
  // → всё ещё в кэше, но refcount=0
  expect(cache.stats().idle).toBe(2)
})

test('churn window — pauses eviction on thrash', async () => {
  const cache = createAssetCache<string>({
    maxBytes: 1024,
    baseTtlFrames: 1,
    churnWindowMs: 100,
    churnThreshold: 3,
    now: () => 0, // статичное время — churn не затухает
  })
  // 4 быстрых acquire+release — churn должен сработать
  for (let i = 0; i < 4; i++) {
    const h = cache.acquire(`item-${i}`, async () => `v-${i}`)
    await h.ready
    h.release()
  }
  // tick не должен эвиктить — churn pause
  cache.tick()
  expect(cache.size).toBe(4) // все живы
})
