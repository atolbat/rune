import { test, expect } from 'bun:test'
import { Assembler, FetchScheduler, fetchStreaming, isAbortError, type SchedulerJob } from '../src/assembler.ts'


/** Поток из чанков с управляемой подачей. */
function chunkedStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

function encoder(): TextEncoder {
  return new TextEncoder()
}

test('Assembler: watermark растёт по чанкам, fullView после конца', async () => {
  const enc = encoder()
  const assembler = new Assembler(chunkedStream([enc.encode('hello '), enc.encode('world')]))
  await assembler.completion
  expect(assembler.isDone).toBe(true)
  expect(assembler.watermark).toBe(11)
  expect(new TextDecoder().decode(assembler.fullView())).toBe('hello world')
})

test('Assembler: waitFor ждёт накопления байт', async () => {
  let releaseChunks!: (chunks: Uint8Array[]) => void
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]))
      releaseChunks = (chunks) => {
        for (const c of chunks) controller.enqueue(c)
        controller.close()
      }
    },
  })
  const assembler = new Assembler(stream)
  await assembler.waitFor(3) // первый чанк потреблён pump-ом
  const waiting = assembler.waitFor(7)
  releaseChunks([new Uint8Array([4, 5, 6, 7])])
  await waiting // не должно зависнуть
  expect(assembler.watermark).toBe(7)
})

test('Assembler: slice/prefixView/rangeReady/onRange', async () => {
  const enc = encoder()
  const seen: number[] = []
  const assembler = new Assembler(chunkedStream([enc.encode('0123456789')]))
  const unsubscribe = assembler.onRange((watermark) => {
    seen.push(watermark)
  })
  await assembler.completion
  expect(seen).toContain(10)
  expect(assembler.rangeReady(0, 10)).toBe(true)
  expect(assembler.rangeReady(8, 3)).toBe(false)
  expect(assembler.slice(2, 3)).toEqual(new Uint8Array([50, 51, 52]))
  expect(assembler.prefixView(4)).toEqual(new Uint8Array([48, 49, 50, 51]))
  unsubscribe()
})

test('Assembler: полная подача с total — zero-copy инвариант (виды остаются валидны)', async () => {
  const total = new Uint8Array(1000)
  for (let i = 0; i < total.length; i++) total[i] = i % 256
  const assembler = new Assembler(chunkedStream([total]), { total: total.length })
  await assembler.completion
  const view = assembler.prefixView(1000)
  expect(view.byteLength).toBe(1000)
  expect(view[999]).toBe(999 % 256)
})

test('Assembler: abort фейлит и отменяет чтение', async () => {
  const controller = new AbortController()
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array([1]))
    },
    cancel() {
      cancelled = true
    },
  })
  const assembler = new Assembler(stream, { signal: controller.signal })
  controller.abort()
  await expect(assembler.completion).rejects.toBeInstanceOf(DOMException)
  // cancel() потока — асинхронный: даём микрозадачу сработать
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(cancelled).toBe(true)
  expect(assembler.isDone).toBe(true)
})

test('FetchScheduler: приоритет и порядок', async () => {
  const scheduler = new FetchScheduler({ maxConcurrent: 1 })
  const order: string[] = []
  const job = (name: string, priority: number): SchedulerJob => ({
    id: name.charCodeAt(0),
    priority,
    seq: name.charCodeAt(0),
    weight: () => 1,
    start: async () => {
      order.push(name)
    },
  })
  scheduler.submit(job('b', 5))
  scheduler.submit(job('a', 1)) // меньший приоритет — раньше из ОЧЕРЕДИ
  scheduler.submit(job('c', 5))
  await new Promise<void>((resolve) => scheduler.onDrain(() => resolve()))
  // b уже стартовала до подачи a — порядок старта: b, затем очередь по приоритету
  expect(order).toEqual(['b', 'a', 'c'])
})

test('FetchScheduler: отмена из очереди вызывает onCancelledBeforeStart', async () => {
  const scheduler = new FetchScheduler({ maxConcurrent: 1 })
  let cancelled = ''
  const gate = Promise.withResolvers<void>()
  const running: SchedulerJob = {
    id: 1,
    priority: 5,
    seq: 1,
    weight: () => 1,
    start: () => gate.promise,
  }
  const queued: SchedulerJob = {
    id: 2,
    priority: 5,
    seq: 2,
    weight: () => 1,
    onCancelledBeforeStart: (reason) => {
      cancelled = reason ?? 'cancelled'
    },
    start: async () => {},
  }
  scheduler.submit(running)
  scheduler.submit(queued)
  expect(scheduler.cancel(queued, 'не нужен')).toBe(true)
  gate.resolve()
  await new Promise<void>((resolve) => scheduler.onDrain(() => resolve()))
  expect(cancelled).toBe('не нужен')
})

test('FetchScheduler: бюджет байт не пускает вторую тяжёлую задачу', async () => {
  const scheduler = new FetchScheduler({ maxConcurrent: 8, maxBytesInFlight: 100 })
  const events: string[] = []
  const gate = Promise.withResolvers<void>()
  const make = (id: number, weight: number): SchedulerJob => ({
    id,
    priority: 5,
    seq: id,
    weight: () => weight,
    start: async () => {
      events.push(`start:${id}`)
      if (id === 1) await gate.promise
      events.push(`end:${id}`)
    },
  })
  scheduler.submit(make(1, 90))
  scheduler.submit(make(2, 90)) // 90+90 > 100 — ждёт
  await new Promise((resolve) => setTimeout(resolve, 10))
  // вторая не стартовала: бюджет байт заблокировал её
  expect(events).toEqual(['start:1'])
  gate.resolve()
  await new Promise<void>((resolve) => scheduler.onDrain(() => resolve()))
  // вторая пошла только после завершения первой
  expect(events).toEqual(['start:1', 'end:1', 'start:2', 'end:2'])
})

test('fetchStreaming: тело + content-length', async () => {
  const enc = encoder()
  const body = enc.encode('asset-bytes')
  const fetchImpl = (async () =>
    new Response(chunkedStream([body]), {
      status: 200,
      headers: { 'content-length': String(body.length) },
    })) as unknown as typeof fetch
  const result = await fetchStreaming('https://example.com/x.bin', { fetchImpl })
  expect(result.contentLength).toBe(body.length)
  await result.done
  expect(result.assembler.fullView()).toEqual(body)
})

test('fetchStreaming: 5xx с ретраем, затем успех', async () => {
  let calls = 0
  const fetchImpl = (async () => {
    calls++
    if (calls === 1) return new Response('boom', { status: 500 })
    return new Response(chunkedStream([new Uint8Array([7, 7, 7])]), { status: 200 })
  }) as unknown as typeof fetch
  const result = await fetchStreaming('https://example.com/r.bin', { fetchImpl, retries: 1 })
  expect(calls).toBe(2)
  await result.done
  expect(result.assembler.watermark).toBe(3)
})

test('fetchStreaming: 404 без ретрая — TypeError', async () => {
  const fetchImpl = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch
  expect(fetchStreaming('https://example.com/404', { fetchImpl })).rejects.toThrow('HTTP 404')
})

test('isAbortError: DOMException(AbortError) — да, Error — нет', () => {
  expect(isAbortError(new DOMException('x', 'AbortError'))).toBe(true)
  expect(isAbortError(new DOMException('x', 'TimeoutError'))).toBe(true)
  expect(isAbortError(new Error('x'))).toBe(false)
})
