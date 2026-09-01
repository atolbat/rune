/**
 * core/source.ts — нормализация LoadSource → { байты | поток | fetchUrl }.
 *
 * Менеджеру всё равно, откуда данные: URL, Request, готовый Response, Blob,
 * ReadableStream, AsyncIterable или байты в руках. Здесь это приводится к
 * одной форме, а fetch-фаза пропускается, если байты уже есть.
 */

import type { LoadSource, NormalizedSource } from './types.ts'
import { LoadError } from './errors.ts'
import { streamToAsyncIterable } from './pipe.ts'

/** Привести любой источник к NormalizedSource. */
export function normalizeSource(source: LoadSource): NormalizedSource {
  if (typeof source === 'string') {
    if (source.length === 0) throw new LoadError('source', 'пустой URL')
    return { url: source, totalBytes: null, fetchUrl: source, fetchRequest: null }
  }
  if (source instanceof URL) {
    return { url: source.href, totalBytes: null, fetchUrl: source.href, fetchRequest: null }
  }
  if (source instanceof Request) {
    return { url: source.url, totalBytes: null, fetchUrl: null, fetchRequest: source }
  }
  if (source instanceof Response) {
    const url = source.url || null
    const total = responseTotalBytes(source)
    if (source.body === null) {
      // Тела нет (204/304 и т.п.) — пустой поток, ноль байтов на выходе.
      return { url, stream: emptyIterable(), totalBytes: total, fetchUrl: null, fetchRequest: null }
    }
    return { url, stream: streamToAsyncIterable(source.body), totalBytes: total, fetchUrl: null, fetchRequest: null }
  }
  if (source instanceof ArrayBuffer) {
    return { url: null, bytes: new Uint8Array(source), totalBytes: source.byteLength, fetchUrl: null, fetchRequest: null }
  }
  if (source instanceof Uint8Array) {
    // Копию не делаем: контракт — источник нельзя мутировать после передачи.
    return { url: null, bytes: source, totalBytes: source.byteLength, fetchUrl: null, fetchRequest: null }
  }
  // Blob/File: у File есть name (для resolveExternal-подсказок), размер известен
  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    const url = source instanceof File ? (source as File).name : null
    const stream = streamToAsyncIterable(source.stream() as ReadableStream<Uint8Array>)
    return { url, stream, totalBytes: source.size, fetchUrl: null, fetchRequest: null }
  }
  // ReadableStream<Uint8Array>
  if (typeof ReadableStream !== 'undefined' && source instanceof ReadableStream) {
    return { url: null, stream: streamToAsyncIterable(source as ReadableStream<Uint8Array>), totalBytes: null, fetchUrl: null, fetchRequest: null }
  }
  // AsyncIterable<Uint8Array> (duck typing)
  if (typeof (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function') {
    return { url: null, stream: source as AsyncIterable<Uint8Array>, totalBytes: null, fetchUrl: null, fetchRequest: null }
  }
  throw new LoadError('source', `normalizeSource: неизвестный тип источника ${Object.prototype.toString.call(source)}`)
}

/** Пустой AsyncIterable (Response без тела). */
function emptyIterable(): AsyncIterable<Uint8Array> {
  async function *gen(): AsyncGenerator<Uint8Array> {}
  return gen()
}

/** Длина из content-length (учёт content-encoding не входит в задачу v1). */
export function responseTotalBytes(response: Response): number | null {
  const header = response.headers?.get('content-length')
  if (header === null || header === undefined) return null
  const n = Number(header)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** Content-Type из Response (безThrows). */
export function responseMimeType(response: Response): string | null {
  const t = response.headers?.get('content-type')
  if (t === null || t === undefined) return null
  const semi = t.indexOf(';')
  return (semi >= 0 ? t.slice(0, semi) : t).trim().toLowerCase() || null
}
