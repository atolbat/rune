/**
 * compat.ts — унаследованный простой API (Task «@rune/loaders v0») поверх
 * новой стриминговой машинерии. Сигнатуры сохранены 1:1 (loadImage /
 * loadJSON / loadArrayBuffer), реализация — openByteSource (прогресс,
 * отмена, ретраи). Для нового кода — AssetLibrary.load().
 */

import { openByteSource } from './source.ts'

export interface LegacyLoadOptions {
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

/** Изображение → ImageBitmap (нативный decode). */
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
    throw new Error('createImageBitmap недоступен в этой среде')
  }
  return createImageBitmap(blob)
}

/** JSON-конфиг. */
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
    throw new SyntaxError(`loadJSON: ${url} — невалидный JSON: ${(err as Error).message}`, { cause: err })
  }
}

/** Сырые байты (GLB и пр.). */
export async function loadArrayBuffer(url: string, options: LegacyLoadOptions = {}): Promise<ArrayBuffer> {
  const source = await openByteSource(url, {
    signal: options.signal,
    connectTimeoutMs: options.timeoutMs,
    retries: 0,
  })
  await source.done
  return source.assembler.fullView().slice().buffer
}
