/**
 * core/pipe.ts — chunk pipes: an AsyncIterable wrapper over ReadableStream,
 * accumulation into a buffer with progress, transform composition, gzip.
 *
 * The key idea is "download and parse in parallel": fetch yields a stream,
 * transforms map the chunks, a streaming parser eats them as they come. The
 * manager builds the chain and does NOT wait for a full buffer when the
 * parser supports streaming.
 */

import type { StreamTransform } from './types.ts'
import { GrowableBytes } from './util.ts'

/** ReadableStream → AsyncIterable (a reader loop, without the async-iterator API). */
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
  /** Total size if known — for the progress fraction. */
  totalBytes?: number | null
  /** Called on every chunk (the manager throttles itself). */
  onChunk?: (receivedBytes: number, chunk: Uint8Array) => void
  /** Initial capacity (a hint from expectedBytes). */
  initialCapacity?: number
}

/** Consume the whole stream into a single Uint8Array with a progress callback. */
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

/** Merge several transforms into one (order: data flows left to right). */
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

/** gzip chunks → decompressed chunks (DecompressionStream). */
export function gunzipTransform(): StreamTransform {
  const transform = (chunks: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> => {
    // Wrap the chunks in a single stream, run them through DecompressionStream,
    // emit chunks again. The Response-based implementation is reliable in Bun too.
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

/** Split the input into fixed-size chunks (for tests/slicing). */
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

/** Concatenation of two byte arrays. */
export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

/** AsyncIterable from static bytes (for tests and direct pipes). */
export function bytesToAsyncIterable(bytes: Uint8Array, chunkSize = 1 << 16): AsyncIterable<Uint8Array> {
  async function *gen(): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < bytes.length; i += chunkSize) {
      yield bytes.subarray(i, Math.min(i + chunkSize, bytes.length))
    }
  }
  return gen()
}
