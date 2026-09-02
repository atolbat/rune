/**
 * core/source.ts — normalization of LoadSource → { bytes | stream | fetchUrl }.
 *
 * The manager does not care where the data comes from: a URL, Request, a
 * ready Response, Blob, ReadableStream, AsyncIterable, or bytes in hand.
 * Here it is all reduced to one form, and the fetch phase is skipped when
 * the bytes are already available.
 */

import type { LoadSource, NormalizedSource } from './types.ts'
import { LoadError } from './errors.ts'
import { streamToAsyncIterable } from './pipe.ts'

/** Coerce any source to NormalizedSource. */
export function normalizeSource(source: LoadSource): NormalizedSource {
  if (typeof source === 'string') {
    if (source.length === 0) throw new LoadError('source', 'empty URL')
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
      // No body (204/304 etc.) — an empty stream, zero bytes at the output.
      return { url, stream: emptyIterable(), totalBytes: total, fetchUrl: null, fetchRequest: null }
    }
    return { url, stream: streamToAsyncIterable(source.body), totalBytes: total, fetchUrl: null, fetchRequest: null }
  }
  if (source instanceof ArrayBuffer) {
    return { url: null, bytes: new Uint8Array(source), totalBytes: source.byteLength, fetchUrl: null, fetchRequest: null }
  }
  if (source instanceof Uint8Array) {
    // We do not copy: the contract is that the source must not be mutated after being handed over.
    return { url: null, bytes: source, totalBytes: source.byteLength, fetchUrl: null, fetchRequest: null }
  }
  // Blob/File: File has a name (for resolveExternal hints), the size is known
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
  throw new LoadError('source', `normalizeSource: unknown source type ${Object.prototype.toString.call(source)}`)
}

/** An empty AsyncIterable (a Response without a body). */
function emptyIterable(): AsyncIterable<Uint8Array> {
  async function *gen(): AsyncGenerator<Uint8Array> {}
  return gen()
}

/** Length from content-length (content-encoding handling is out of scope for v1). */
export function responseTotalBytes(response: Response): number | null {
  const header = response.headers?.get('content-length')
  if (header === null || header === undefined) return null
  const n = Number(header)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** Content-Type from a Response (no throws). */
export function responseMimeType(response: Response): string | null {
  const t = response.headers?.get('content-type')
  if (t === null || t === undefined) return null
  const semi = t.indexOf(';')
  return (semi >= 0 ? t.slice(0, semi) : t).trim().toLowerCase() || null
}
