import { test, expect } from 'bun:test'
import { createLoadManager } from '../src/core/manager.ts'
import { Priority } from '../src/core/types.ts'
import { LoadError } from '../src/core/errors.ts'
import { fakeFetch, createFetchLog, makeCountingStreamParser } from './helpers.ts'

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const bytes = (len: number, fill = 0x61): Uint8Array => new Uint8Array(len).fill(fill)

function okRoute(body: Uint8Array | string = 'hello', delayMs = 0) {
  return { body, delayMs }
}

// ─── приоритеты ──────────────────────────────────────────────────────────────

test('приоритеты: high выезжает раньше low при занятом слоте', async () => {
  const log = createFetchLog()
  const manager = createLoadManager({
    fetchImpl: fakeFetch(
      {
        'http://t/a': okRoute(bytes(10), 1),
        'http://t/b': okRoute(bytes(10), 2),
        'http://t/c': okRoute(bytes(10), 3),
      },
      log,
    ),
    concurrency: 1,
  })
  // a стартует сразу (слот один), b и c — в очередь
  manager.load('http://t/a', { kind: 'bytes' })
  manager.load('http://t/c', { kind: 'bytes', priority: Priority.low })
  manager.load('http://t/b', { kind: 'bytes', priority: Priority.high })
  await manager.drain()
  expect(log.starts).toEqual(['http://t/a', 'http://t/b', 'http://t/c'])
  manager.dispose()
})

test('критический приоритет обходит normal', async () => {
  const log = createFetchLog()
  const routes: Record<string, { body: Uint8Array }> = {}
  for (const name of ['n1', 'n2', 'n3', 'n4', 'crit']) {
    routes[`http://t/${name}`] = { body: bytes(4) }
  }
  const manager = createLoadManager({ fetchImpl: fakeFetch(routes, log), concurrency: 1 })
  manager.load('http://t/n1', { kind: 'bytes' })
  for (const n of ['n2', 'n3', 'n4']) manager.load(`http://t/${n}`, { kind: 'bytes' })
  manager.load('http://t/crit', { kind: 'bytes', priority: Priority.critical })
  await manager.drain()
  expect(log.starts[1]).toBe('http://t/crit') // после n1 (который уже стартовал)
  manager.dispose()
})

// ─── параллелизм ─────────────────────────────────────────────────────────────

test('concurrency: не больше N одновременных', async () => {
  const log = createFetchLog()
  const routes: Record<string, ReturnType<typeof okRoute>> = {}
  for (let i = 0; i < 6; i++) routes[`http://t/${i}`] = okRoute(bytes(100), 25)
  const manager = createLoadManager({ fetchImpl: fakeFetch(routes, log), concurrency: 2 })
  const handles = Array.from({ length: 6 }, (_, i) => manager.load(`http://t/${i}`, { kind: 'bytes' }))
  await Promise.all(handles.map(h => h.ready))
  expect(log.maxActive).toBeLessThanOrEqual(2)
  expect(log.maxActive).toBeGreaterThanOrEqual(2) // реально параллелили
  manager.dispose()
})

test('байтовый бюджет: задача ждёт освобождения резерва', async () => {
  const log = createFetchLog()
  const routes: Record<string, ReturnType<typeof okRoute>> = {
    'http://t/a': okRoute(bytes(100), 30),
    'http://t/b': okRoute(bytes(100), 10),
    'http://t/c': okRoute(bytes(100), 10),
  }
  const manager = createLoadManager({
    fetchImpl: fakeFetch(routes, log),
    concurrency: 8,
    maxInflightBytes: 150,
  })
  manager.load('http://t/a', { kind: 'bytes', expectedBytes: 100 })
  manager.load('http://t/b', { kind: 'bytes', expectedBytes: 100 })
  manager.load('http://t/c', { kind: 'bytes', expectedBytes: 100 })
  await manager.drain()
  // резерв a (100) + b (100) > 150 → c ждал конца a или b
  expect(log.starts.indexOf('http://t/c')).toBeGreaterThan(log.starts.indexOf('http://t/a'))
  const stats = manager.stats()
  expect(stats.inflightBytes).toBe(0)
  manager.dispose()
})

// ─── отмена ──────────────────────────────────────────────────────────────────

test('cancel в очереди: fetch не вызывается, ready реджектится', async () => {
  const log = createFetchLog()
  const manager = createLoadManager({
    fetchImpl: fakeFetch({
      'http://t/slow': okRoute(bytes(10), 60),
      'http://t/never': okRoute(bytes(10)),
    }, log),
    concurrency: 1,
  })
  const slow = manager.load('http://t/slow', { kind: 'bytes' })
  const queued = manager.load('http://t/never', { kind: 'bytes' })
  queued.cancel('не нужен')
  await expect(queued.ready).rejects.toThrow('не нужен')
  expect(log.calls).not.toContain('http://t/never')
  await slow.ready
  expect(manager.stats().cancelled).toBe(1)
  manager.dispose()
})

test('cancel во время fetch: сигнал доходит до fetchImpl', async () => {
  const manager = createLoadManager({
    fetchImpl: fakeFetch({ 'http://t/slow': okRoute(bytes(10), 150) }),
    concurrency: 1,
  })
  const h = manager.load('http://t/slow', { kind: 'bytes' })
  await sleep(20)
  h.cancel()
  await expect(h.ready).rejects.toThrow()
  expect(manager.stats().cancelled).toBe(1)
  manager.dispose()
})

test('внешний AbortSignal: отмена до старта и во время', async () => {
  const controller = new AbortController()
  const manager = createLoadManager({
    fetchImpl: fakeFetch({ 'http://t/x': okRoute(bytes(10), 80) }),
    concurrency: 2,
  })
  controller.abort('external')
  const h1 = manager.load('http://t/x', { kind: 'bytes', signal: controller.signal })
  await expect(h1.ready).rejects.toThrow('external')
  const controller2 = new AbortController()
  const h2 = manager.load('http://t/x', { kind: 'bytes', signal: controller2.signal })
  await sleep(10)
  controller2.abort()
  await expect(h2.ready).rejects.toThrow()
  manager.dispose()
})

test('dispose: всё отменяется, менеджер закрыт', async () => {
  const manager = createLoadManager({
    fetchImpl: fakeFetch({ 'http://t/s': okRoute(bytes(10), 120) }),
    concurrency: 4,
  })
  const h1 = manager.load('http://t/s', { kind: 'bytes' })
  const h2 = manager.load('http://t/s', { kind: 'bytes' })
  manager.dispose()
  expect(manager.disposed).toBe(true)
  await expect(h1.ready).rejects.toThrow()
  await expect(h2.ready).rejects.toThrow()
  expect(() => manager.load('http://t/s')).toThrow()
})

// ─── прогресс ────────────────────────────────────────────────────────────────

test('прогресс: receivedBytes/totalBytes/fraction по чанкам', async () => {
  const body = bytes(300)
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(body.subarray(0, 100))
      setTimeout(() => {
        c.enqueue(body.subarray(100, 200))
        setTimeout(() => {
          c.enqueue(body.subarray(200))
          c.close()
        }, 10)
      }, 10)
    },
  })
  const response = new Response(stream, { status: 200, headers: { 'content-length': '300' } })
  const manager = createLoadManager({ fetchImpl: fakeFetch({}), concurrency: 2 })
  const h = manager.load(response, { kind: 'bytes' })
  const events: number[] = []
  await h.ready.then(async v => {
    void v
    void events
    return undefined
  })
  // отдельный прогон с onProgress (тот же роутинг через Response)
  const body200 = bytes(200)
  const stream2 = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(body200.subarray(0, 100))
      setTimeout(() => {
        c.enqueue(body200.subarray(100))
        c.close()
      }, 10)
    },
  })
  const response2 = new Response(stream2, { status: 200, headers: { 'content-length': '200' } })
  const progress: { phase: string; received: number; total: number | null; fraction: number | null }[] = []
  const h2 = manager.load(response2, {
    kind: 'bytes',
    onProgress: p => progress.push({ phase: p.phase, received: p.receivedBytes, total: p.totalBytes, fraction: p.fraction }),
  })
  await h2.ready
  const last = progress[progress.length - 1]
  expect(last.phase).toBe('done')
  expect(last.total).toBe(200)
  expect(last.received).toBe(200)
  expect(last.fraction).toBe(1)
  //received растёт монотонно
  for (let i = 1; i < progress.length; i++) {
    expect(progress[i].received).toBeGreaterThanOrEqual(progress[i - 1].received)
  }
  manager.dispose()
})

// ─── ретраи и таймауты ───────────────────────────────────────────────────────

test('ретрай на 500 → успех', async () => {
  const log = createFetchLog()
  const manager = createLoadManager({
    fetchImpl: fakeFetch({ 'http://t/flaky': { body: 'data', failFirst: 2 } }, log),
    concurrency: 1,
  })
  const v = await manager.load('http://t/flaky', { kind: 'bytes', retries: 2, retryDelayMs: 1 }).ready
  expect(new TextDecoder().decode(v as Uint8Array)).toBe('data')
  expect(log.calls.filter(u => u === 'http://t/flaky').length).toBe(3)
  manager.dispose()
})

test('ретраи кончились → LoadError http', async () => {
  const manager = createLoadManager({
    fetchImpl: fakeFetch({ 'http://t/dead': { body: '', failFirst: 100 } }),
    concurrency: 1,
  })
  let code = ''
  try {
    await manager.load('http://t/dead', { kind: 'bytes', retries: 1, retryDelayMs: 1 }).ready
  } catch (err) {
    code = (err as LoadError).code
  }
  expect(code).toBe('http')
  manager.dispose()
})

test('таймаут фазы fetch → LoadError timeout', async () => {
  const manager = createLoadManager({
    fetchImpl: fakeFetch({ 'http://t/slow': okRoute(bytes(10), 300) }),
    concurrency: 1,
  })
  let code = ''
  try {
    await manager.load('http://t/slow', { kind: 'bytes', timeoutMs: 40 }).ready
  } catch (err) {
    code = (err as LoadError).code
  }
  expect(code).toBe('timeout')
  manager.dispose()
})

test('404 не ретраится', async () => {
  const log = createFetchLog()
  const manager = createLoadManager({
    fetchImpl: fakeFetch({ 'http://t/404': { status: 404, body: '' } }, log),
    concurrency: 1,
  })
  await expect(manager.load('http://t/404', { kind: 'bytes', retries: 5 }).ready).rejects.toThrow()
  expect(log.calls.length).toBe(1)
  manager.dispose()
})

// ─── resolveExternal ─────────────────────────────────────────────────────────

test('resolveExternal: дочерняя загрузка через менеджер', async () => {
  const log = createFetchLog()
  const manager = createLoadManager({
    fetchImpl: fakeFetch(
      {
        'http://t/model.gltf': okRoute('{"x":1}'),
        'http://t/data.bin': okRoute(bytes(16, 7)),
      },
      log,
    ),
    concurrency: 4,
  })
  const externalParser = {
    kind: '__external__',
    parse: async (input: import('../src/core/types.ts').ParseInput): Promise<Uint8Array> => {
      return input.ctx.resolveExternal('data.bin')
    },
  }
  const v = await manager.load('http://t/model.gltf', { parser: externalParser }).ready
  expect((v as Uint8Array).length).toBe(16)
  expect(log.calls).toContain('http://t/data.bin')
  manager.dispose()
})

test('resolveExternal: отмена родителя каскадом отменяет ребёнка', async () => {
  const log = createFetchLog()
  const manager = createLoadManager({
    fetchImpl: fakeFetch(
      {
        'http://t/parent': okRoute('p'),
        'http://t/child-slow': okRoute(bytes(8), 150),
      },
      log,
    ),
    concurrency: 4,
  })
  const externalParser = {
    kind: '__external__',
    parse: async (input: import('../src/core/types.ts').ParseInput): Promise<Uint8Array> => {
      return input.ctx.resolveExternal('child-slow')
    },
  }
  const parent = manager.load('http://t/parent', { kind: 'bytes', parser: externalParser })
  await sleep(30) // parse уже ждёт ребёнка
  parent.cancel()
  await expect(parent.ready).rejects.toThrow()
  await sleep(30)
  expect(manager.stats().cancelled).toBeGreaterThanOrEqual(2)
  manager.dispose()
})

// ─── группы ──────────────────────────────────────────────────────────────────

test('group.enough(2): кворум + демоут остатка', async () => {
  const log = createFetchLog()
  const routes: Record<string, ReturnType<typeof okRoute>> = {}
  for (let i = 0; i < 4; i++) routes[`http://t/g${i}`] = okRoute(bytes(10, 0x30 + i), 20)
  routes['http://t/important'] = okRoute(bytes(10), 5)
  const manager = createLoadManager({
    fetchImpl: fakeFetch(routes, log),
    concurrency: 1,
    agingPerSecond: 0, // чистый порядок приоритетов
  })
  const group = manager.group('level')
  for (let i = 0; i < 4; i++) group.add(`http://t/g${i}`, { kind: 'bytes' })
  const enough = await group.enough(2)
  expect(enough.length).toBe(2)
  // после кворума: демоутнутые (prefetch) уступают новому normal
  const late = manager.load('http://t/important', { kind: 'bytes' })
  await late.ready
  await group.waitAll()
  // important (normal) поехал раньше демоутнутых g2/g3 (prefetch)
  const idxLate = log.starts.indexOf('http://t/important')
  const idxG2 = log.starts.indexOf('http://t/g2')
  const idxG3 = log.starts.indexOf('http://t/g3')
  expect(idxLate).toBeGreaterThan(-1)
  expect(idxG2).toBeGreaterThan(idxLate)
  expect(idxG3).toBeGreaterThan(idxLate)
  expect(group.progress.done).toBe(4)
  manager.dispose()
})

test('group.progress: байт-взвешенная доля', async () => {
  const body100 = bytes(100)
  const body300 = bytes(300)
  const stream300 = new ReadableStream<Uint8Array>({
    async start(c) {
      await sleep(60) // первый чанк — после замера прогресса
      c.enqueue(body300.subarray(0, 150))
      await sleep(20)
      c.enqueue(body300.subarray(150))
      c.close()
    },
  })
  const manager = createLoadManager({
    fetchImpl: fakeFetch({
      'http://t/small': { body: body100 },
    }),
    concurrency: 1,
  })
  const group = manager.group()
  group.add('http://t/small', { kind: 'bytes', expectedBytes: 100 })
  const h2 = group.add(new Response(stream300, { status: 200, headers: { 'content-length': '300' } }), { kind: 'bytes' })
  // small (100) первым — потом большой
  await sleep(5)
  const afterSmall = group.progress
  expect(afterSmall.done).toBe(1)
  expect(afterSmall.totalBytes).toBe(400)
  expect(afterSmall.fraction).toBeCloseTo(0.25, 1)
  await h2.ready
  expect(group.progress.fraction).toBe(1)
  manager.dispose()
})

test('group: ошибка → waitAll реджектится AggregateError, settleAll — нет', async () => {
  const manager = createLoadManager({
    fetchImpl: fakeFetch({
      'http://t/good': okRoute('ok'),
      'http://t/bad': { status: 500, body: '' },
    }),
    concurrency: 4,
  })
  const group = manager.group('mixed')
  group.add('http://t/good', { kind: 'bytes' })
  group.add('http://t/bad', { kind: 'bytes' })
  await expect(group.waitAll()).rejects.toThrow('упало 1')
  const settled = await group.settleAll()
  expect(settled.filter(s => s.value !== undefined).length).toBe(1)
  expect(settled.filter(s => s.error !== undefined).length).toBe(1)
  manager.dispose()
})

// ─── стриминговые парсеры через менеджер ─────────────────────────────────────

test('стриминговый парсер: parse() не зовётся, sink получает чанки', async () => {
  const { parser } = makeCountingStreamParser()
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array([1, 2, 3]))
      c.enqueue(new Uint8Array([4, 5]))
      c.close()
    },
  })
  const manager = createLoadManager({ fetchImpl: fakeFetch({}), concurrency: 1 })
  const h = manager.load(new Response(stream, { status: 200 }), { parser })
  const result = (await h.ready) as { pushes: number; bytes: number; parsed: boolean }
  expect(result.parsed).toBe(false) // через sink, не через parse
  expect(result.pushes).toBe(2)
  expect(result.bytes).toBe(5)
  manager.dispose()
})

// ─── sniffing и источники ────────────────────────────────────────────────────

test('sniffing: PNG-магика без kind → image-парсер', async () => {
  let decoded = ''
  const manager = createLoadManager({
    fetchImpl: fakeFetch({ 'http://t/pic.png': okRoute(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2])) }),
    decodeImage: async () => {
      decoded = 'yes'
      return { width: 2, height: 3 }
    },
    concurrency: 1,
  })
  const img = await manager.load('http://t/pic.png').ready
  expect((img as { width: number }).width).toBe(2)
  expect(decoded).toBe('yes')
  manager.dispose()
})

test('источники: Uint8Array и AsyncIterable без fetch', async () => {
  const manager = createLoadManager({ fetchImpl: fakeFetch({}), concurrency: 2 })
  const data = new TextEncoder().encode('raw-bytes')
  const v1 = await manager.load(data, { kind: 'bytes' }).ready
  expect(v1).toBe(data)
  async function* gen(): AsyncGenerator<Uint8Array> {
    yield new TextEncoder().encode('str')
    yield new Uint8Array([33])
  }
  const v2 = await manager.load(gen(), { kind: 'bytes' }).ready
  expect((v2 as Uint8Array).length).toBe(4)
  manager.dispose()
})

// ─── stats/prune ─────────────────────────────────────────────────────────────

test('stats + pruneTerminal', async () => {
  const manager = createLoadManager({
    fetchImpl: fakeFetch({ 'http://t/a': okRoute('x') }),
    concurrency: 1,
  })
  await manager.load('http://t/a', { kind: 'bytes' }).ready
  const before = manager.stats()
  expect(before.done).toBe(1)
  expect(before.tasks).toBe(1)
  manager.pruneTerminal()
  const after = manager.stats()
  expect(after.done).toBe(0)
  expect(after.tasks).toBe(0)
  manager.dispose()
})

test('drain резолвится после всех задач', async () => {
  const manager = createLoadManager({
    fetchImpl: fakeFetch({
      'http://t/1': okRoute('a', 15),
      'http://t/2': okRoute('b', 15),
    }),
    concurrency: 4,
  })
  manager.load('http://t/1', { kind: 'bytes' })
  manager.load('http://t/2', { kind: 'bytes' })
  await manager.drain()
  expect(manager.stats().done).toBe(2)
  manager.dispose()
})
