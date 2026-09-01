import { test, expect } from 'bun:test'
import { gzipSync, deflateSync } from 'node:zlib'
import {
  readAllBytes,
  composeTransforms,
  chunkerTransform,
  gunzipTransform,
  bytesToAsyncIterable,
  streamToAsyncIterable,
  concatBytes,
} from '../src/core/pipe.ts'
import { defaultInflate } from '../src/core/util.ts'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const dec = (b: Uint8Array): string => new TextDecoder().decode(b)

async function* threeChunks(): AsyncGenerator<Uint8Array> {
  yield enc('abc')
  yield enc('de')
  yield enc('fgh')
}

test('readAllBytes — конкатенация чанков', async () => {
  const bytes = await readAllBytes(threeChunks())
  expect(dec(bytes)).toBe('abcdefgh')
})

test('readAllBytes — прогресс по чанкам', async () => {
  const seen: number[] = []
  await readAllBytes(threeChunks(), { onChunk: received => seen.push(received) })
  expect(seen).toEqual([3, 5, 8])
})

test('composeTransforms — последовательное применение', async () => {
  function plusOne(chunks: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
    return (async function* () {
      for await (const c of chunks) yield new Uint8Array(Array.from(c, b => b + 1))
    })()
  }
  const composed = composeTransforms(
    plusOne as import('../src/core/types.ts').StreamTransform,
    plusOne as import('../src/core/types.ts').StreamTransform,
  )
  expect(composed).not.toBeNull()
  const out = await readAllBytes(composed!(threeChunks()))
  expect(dec(out)).toBe('cdefghij') // каждый байт +2
})

test('chunkerTransform — нарезка фиксированными кусками', async () => {
  const src = bytesToAsyncIterable(enc('abcdefghij'), 7) // [7, 3]
  const out: number[] = []
  for await (const chunk of chunkerTransform(3)(src)) out.push(chunk.length)
  expect(out).toEqual([3, 3, 3, 1])
})

test('chunkerTransform — остаток выдаётся целиком', async () => {
  const src = bytesToAsyncIterable(enc('abcde'), 5)
  const collected: Uint8Array[] = []
  for await (const chunk of chunkerTransform(4)(src)) collected.push(chunk)
  expect(collected.map(c => dec(c))).toEqual(['abcd', 'e'])
})

test('gunzipTransform — распаковка gzip-чанков', async () => {
  const data = enc('hello loaders, hello loaders, hello loaders')
  const gzipped = gzipSync(data)
  // кормим сжатые байты кусками по 8
  const src = bytesToAsyncIterable(new Uint8Array(gzipped), 8)
  const out = await readAllBytes(gunzipTransform()(src))
  expect(dec(out)).toBe(dec(data))
})

test('defaultInflate — zlib-wrap (deflateSync)', async () => {
  if (defaultInflate === null) return // платформа без DecompressionStream — пропускаем
  const data = enc('fbx zlib array payload')
  const deflated = deflateSync(data)
  const out = await defaultInflate(new Uint8Array(deflated))
  expect(dec(out)).toBe('fbx zlib array payload')
})

test('streamToAsyncIterable — reader-цикл', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc('aa'))
      c.enqueue(enc('bb'))
      c.close()
    },
  })
  const out = await readAllBytes(streamToAsyncIterable(stream))
  expect(dec(out)).toBe('aabb')
})

test('concatBytes — простая конкатенация', () => {
  expect(dec(concatBytes(enc('ab'), enc('cd')))).toBe('abcd')
})
