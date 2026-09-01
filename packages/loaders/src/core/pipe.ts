/**
 * core/pipe.ts — пайпы чанков: AsyncIterable-обвязка над ReadableStream,
 * накопление в буфер с прогрессом, композиция трансформов, gzip.
 *
 * Ключевая идея «загрузка и парсинг параллельны»: fetch отдаёт поток,
 * трансформы маппят чанки, стриминговый парсер ест их по ходу. Менеджер
 * строит цепочку и НЕ ждёт полного буфера, если парсер умеет в стриминг.
 */

import type { StreamTransform } from './types.ts'
import { GrowableBytes } from './util.ts'

/** ReadableStream → AsyncIterable (reader-цикл, без async-iterator-API). */
export function streamToAsyncIterable(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]() {
      const reader = stream.getReader()
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          const { done, value } = await reader.read()
          if (done) return { done: true, value: undefined }
          return { done: false, value }
        },
        async return(): Promise<IteratorResult<Uint8Array>> {
          await reader.cancel().catch(() => {})
          return { done: true, value: undefined }
        },
      }
    },
  }
}

export interface ReadAllOptions {
  /** Общий размер, если известен — для доли прогресса. */
  totalBytes?: number | null
  /** Вызывается на каждом чанке (менеджер сам троттлит). */
  onChunk?: (receivedBytes: number, chunk: Uint8Array) => void
  /** Стартовая ёмкость (хинт от expectedBytes). */
  initialCapacity?: number
}

/** Выпить поток целиком в один Uint8Array с колбэком прогресса. */
export async function readAllBytes(
  chunks: AsyncIterable<Uint8Array>,
  options: ReadAllOptions = {},
): Promise<Uint8Array> {
  const acc = new GrowableBytes(options.initialCapacity ?? 1 << 16)
  for await (const chunk of chunks) {
    const received = acc.push(chunk)
    options.onChunk?.(received, chunk)
  }
  return acc.take()
}

/** Слить несколько трансформов в один (порядок: данные идут слева направо). */
export function composeTransforms(...transforms: StreamTransform[]): StreamTransform | null {
  const list = transforms.filter(t => t !== null && t !== undefined)
  if (list.length === 0) return null
  if (list.length === 1) return list[0]
  const composed = (chunks: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> => {
    let current = chunks
    for (const t of list) current = t(current)
    return current
  }
  Object.defineProperty(composed, 'name', { value: `compose(${list.map(t => t.name).join('|')})`, configurable: true })
  return composed as StreamTransform
}

/** gzip-чанки → распакованные чанки (DecompressionStream). */
export function gunzipTransform(): StreamTransform {
  const transform = (chunks: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> => {
    // Обернуть чанки в один поток, прогнать через DecompressionStream,
    // снова выдать чанками. Реализация через Response — надёжна и в Bun.
    async function *piped(): AsyncGenerator<Uint8Array> {
      const upstream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for await (const chunk of chunks) controller.enqueue(chunk)
          controller.close()
        },
      })
      const out = upstream.pipeThrough(
        new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
      )
      const reader = out.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value !== undefined) yield value
      }
    }
    return piped()
  }
  Object.defineProperty(transform, 'name', { value: 'gunzip', configurable: true })
  return transform as StreamTransform
}

/** Разбить вход на чанки фиксированного размера (для тестов/нарезки). */
export function chunkerTransform(size: number): StreamTransform {
  const transform = async function *(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
    let pending: Uint8Array | null = null
    for await (const chunk of chunks) {
      let cur: Uint8Array = pending === null ? chunk : concatBytes(pending, chunk)
      pending = null
      while (cur.length >= size) {
        yield cur.subarray(0, size)
        cur = cur.subarray(size)
      }
      if (cur.length > 0) pending = cur
    }
    if (pending !== null) yield pending
  }
  Object.defineProperty(transform, 'name', { value: `chunk(${size})`, configurable: true })
  return transform as unknown as StreamTransform
}

/** Конкатенация двух байтовых массивов. */
export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

/** AsyncIterable из статических байтов (для тестов и прямых пайпов). */
export function bytesToAsyncIterable(bytes: Uint8Array, chunkSize = 1 << 16): AsyncIterable<Uint8Array> {
  async function *gen(): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < bytes.length; i += chunkSize) {
      yield bytes.subarray(i, Math.min(i + chunkSize, bytes.length))
    }
  }
  return gen()
}
