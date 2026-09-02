/**
 * compat.ts — legacy simple API (Task "@rune/loaders v0") on top of the
 * new streaming machinery. Signatures are preserved 1:1 (loadImage /
 * loadJSON / loadArrayBuffer); the implementation is openByteSource
 * (progress, cancellation, retries). For new code — AssetLibrary.load().
 */

import { openByteSource } from './source.ts'

export interface LegacyLoadOptions {
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

/** Image → ImageBitmap (native decode). */
export async function loadImage(url: string, options: LegacyLoadOptions = {}): Promise<ImageBitmap> {
  const source = await openByteSource(url, {
    signal: options.signal,
    connectTimeoutMs: options.timeoutMs,
    retries: 0,
  })
  await source.done
  const bytes = source.assembler.fullView()
  const blob = new Blob([bytes as BlobPart])
  if (typeof createImageBitmap !== 'function') {
    throw new Error('createImageBitmap unavailable in this environment')
  }
  return createImageBitmap(blob)
}

/** JSON config. */
export async function loadJSON<T = unknown>(url: string, options: LegacyLoadOptions = {}): Promise<T> {
  const source = await openByteSource(url, {
    signal: options.signal,
    connectTimeoutMs: options.timeoutMs,
    retries: 0,
  })
  await source.done
  const text = new TextDecoder('utf-8').decode(source.assembler.fullView())
  try {
    return JSON.parse(text) as T
  } catch (err) {
    throw new SyntaxError(`loadJSON: ${url} — invalid JSON: ${(err as Error).message}`, { cause: err })
  }
}

/** Raw bytes (GLB etc.). */
export async function loadArrayBuffer(url: string, options: LegacyLoadOptions = {}): Promise<ArrayBuffer> {
  const source = await openByteSource(url, {
    signal: options.signal,
    connectTimeoutMs: options.timeoutMs,
    retries: 0,
  })
  await source.done
  return source.assembler.fullView().slice().buffer
}
