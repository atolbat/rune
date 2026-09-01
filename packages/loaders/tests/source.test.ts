/**
 * source.test.ts — StreamAssembler (watermark, диапазоны, waitFor),
 * openByteSource с фейковым fetch (стриминг чанками, ретраи).
 */

import { describe, expect, test } from 'bun:test'
import { StreamAssembler, openByteSource } from '../src/source.ts'

function chunkedStream(chunks: Uint8Array[], delays: number[] = []): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (let i = 0; i < chunks.length; i++) {
        if (delays[i] !== undefined) await new Promise(resolve => setTimeout(resolve, delays[i]))
        controller.enqueue(chunks[i])
      }
      controller.close()
    },
  })
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('StreamAssembler', () => {
  test('watermark растёт по чанкам; rangeReady/slice/waitFor', async () => {
    const chunks = [enc('aaaa'), enc('bbbbbb'), enc('cc')]
    const assembler = new StreamAssembler(chunkedStream(chunks, [2, 2, 2]), { total: 12 })
    await assembler.waitFor(4)
    expect(assembler.watermark).toBe(4)
    expect(assembler.rangeReady(0, 4)).toBe(true)
    expect(assembler.rangeReady(4, 6)).toBe(false)
    await assembler.waitFor(10)
    expect(assembler.rangeReady(4, 6)).toBe(true)
    expect(assembler.slice(4, 2)).toEqual(enc('bb'))
    await assembler.completion
    expect(assembler.isDone).toBe(true)
    expect(assembler.fullView()).toEqual(enc('aaaa' + 'bbbbbb' + 'cc'))
  })

  test('неизвестная длина: буфер растёт, fullView в конце', async () => {
    const big = new Uint8Array(3_000_000).fill(7)
    const assembler = new StreamAssembler(chunkedStream([big.subarray(0, 1_000_000), big.subarray(1_000_000)]))
    await assembler.completion
    expect(assembler.watermark).toBe(3_000_000)
    expect(assembler.fullView().length).toBe(3_000_000)
  })

  test('total меньше факта (gzip-трансфер): буфер растёт без клампа', async () => {
    const big = new Uint8Array(300_000).fill(9)
    const assembler = new StreamAssembler(chunkedStream([big.subarray(0, 150_000), big.subarray(150_000)]), {
      total: 100_000, // «сжатая» длина из content-length
    })
    await assembler.completion
    expect(assembler.watermark).toBe(300_000)
    expect(assembler.fullView().length).toBe(300_000)
    expect(assembler.slice(150_000, 150_000).every(b => b === 9)).toBe(true)
  })

  test('onBytes получает прогресс', async () => {
    const seen: [number, number][] = []
    const assembler = new StreamAssembler(chunkedStream([enc('12345'), enc('678')]), {
      total: 8,
      onBytes: (loaded, total) => seen.push([loaded, total]),
    })
    await assembler.completion
    expect(seen).toEqual([[5, 8], [8, 8]])
  })

  test('abort внешним сигналом: waiters падают с AbortError', async () => {
    const controller = new AbortController()
    const stream = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(enc('head'))
        // зависаем: следующий чанк не придёт
      },
    })
    const assembler = new StreamAssembler(stream, { signal: controller.signal, total: 100 })
    const waiter = assembler.waitFor(50)
    setTimeout(() => controller.abort(), 5)
    const waiterError = await waiter.then(() => undefined, (error: unknown) => error)
    expect((waiterError as DOMException).name).toBe('AbortError')
    const completionError = await assembler.completion.then(() => undefined, (error: unknown) => error)
    expect((completionError as DOMException).name).toBe('AbortError')
  })
})

describe('openByteSource', () => {
  const body = enc('0123456789abcdefghij') // 20 байт

  function fakeFetch(delay = 1): typeof fetch {
    return (async () =>
      new Response(chunkedStream([body.subarray(0, 8), body.subarray(8)], [delay, delay]), {
        status: 200,
        headers: { 'content-length': '20' },
      })) as never
  }

  test('content-length из заголовков, стриминг по чанкам', async () => {
    const progress: number[] = []
    const source = await openByteSource('https://x/y.bin', {
      fetchImpl: fakeFetch(),
      onBytes: loaded => progress.push(loaded),
    })
    expect(source.contentLength).toBe(20)
    await source.done
    expect(progress).toEqual([8, 20])
    expect(source.assembler.fullView()).toEqual(body)
  })

  test('HTTP 404 — TypeError без ретраев', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 404 })) as never
    await expect(openByteSource('https://x/404', { fetchImpl })).rejects.toThrow('HTTP 404')
  })

  test('сетевой сбой → ретрай → успех', async () => {
    let calls = 0
    const fetchImpl: typeof fetch = (async () => {
      calls++
      if (calls === 1) throw new TypeError('сеть отвалилась')
      return new Response(chunkedStream([body]))
    }) as never
    const source = await openByteSource('https://x/retry', { fetchImpl, retries: 1 })
    await source.done
    expect(calls).toBe(2)
    expect(source.assembler.fullView()).toEqual(body)
  })

  test('отмена во время тела: promise отклоняется', async () => {
    const controller = new AbortController()
    const fetchImpl: typeof fetch = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
      const stream = new ReadableStream<Uint8Array>({
        async start(c) {
          c.enqueue(body.subarray(0, 4))
          await new Promise(resolve => setTimeout(resolve, 50))
          if (init?.signal?.aborted) {
            c.error(new DOMException('aborted', 'AbortError'))
            return
          }
          c.enqueue(body.subarray(4))
          c.close()
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-length': '20' } })
    }) as never
    const source = await openByteSource('https://x/cancel', { fetchImpl, signal: controller.signal })
    setTimeout(() => controller.abort(new DOMException('отменено', 'AbortError')), 10)
    await expect(source.done).rejects.toThrow()
  })
})
