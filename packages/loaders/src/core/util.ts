/**
 * core/util.ts — byte primitives: a fast string-free float parser,
 * a growable buffer, base64, default platform capabilities, sniffing.
 *
 * There is not a single DOM-specific construct here, apart from guarded
 * accesses to globals (DecompressionStream/createImageBitmap) — headless/worker-safe.
 */

import type { ImageBitmapLike, ImageDecode, PlatformCaps, UrlResolver } from './types.ts'
import { UnsupportedError } from './errors.ts'

// ─── growable byte buffer ───────────────────────────────────────────────────

/** Chunk accumulator with amortized growth (no per-chunk concatenations). */
export class GrowableBytes {
  private buf: Uint8Array
  private len = 0
  readonly chunkCount = 0

  constructor(initialCapacity = 1 << 16) {
    this.buf = new Uint8Array(Math.max(16, initialCapacity))
  }

  get length(): number {
    return this.len
  }

  /** Append a chunk. Returns the new size. */
  push(chunk: Uint8Array): number {
    this.ensure(chunk.length)
    this.buf.set(chunk, this.len)
    this.len += chunk.length
    return this.len
  }

  /** View the accumulated data without a copy (truncated to length). */
  view(): Uint8Array {
    return this.buf.subarray(0, this.len)
  }

  /** Take a copy and reset (the buffer is reused). */
  take(): Uint8Array {
    const out = this.buf.slice(0, this.len)
    this.len = 0
    return out
  }

  private ensure(additional: number): void {
    const need = this.len + additional
    if (need <= this.buf.length) return
    let cap = this.buf.length
    while (cap < need) cap = cap < 1024 ? 1024 : cap * 2
    const next = new Uint8Array(cap)
    next.set(this.buf.subarray(0, this.len))
    this.buf = next
  }
}

// ─── fast byte-level float parser ──────────────────────────────────────────

/**
 * Parse a number from ASCII bytes [start, end) without creating a string.
 * Understands: [-+]?digits[.digits][eE[-+]digits] and a leading dot ".5".
 * Returns { value, next } — next = the index of the first unconsumed byte.
 * value = NaN if there is no number (then next = start).
 *
 * Why: OBJ/MTL with 500k vertices — String.fromCharCode + parseFloat
 * allocates millions of strings; this parser is pure arithmetic over bytes.
 */
export function parseFastFloat(bytes: Uint8Array, start: number, end: number): { value: number; next: number } {
  let i = start
  // leading whitespace (usually already eaten by the tokenizer, but safe)
  while (i < end && (bytes[i] === 32 || bytes[i] === 9 || bytes[i] === 13)) i++
  let sign = 1
  if (i < end && (bytes[i] === 45 || bytes[i] === 43)) {
    if (bytes[i] === 45) sign = -1
    i++
  }
  let intPart = 0
  let sawDigit = false
  while (i < end) {
    const c = bytes[i]
    if (c >= 48 && c <= 57) {
      intPart = intPart * 10 + (c - 48)
      sawDigit = true
      i++
    } else break
  }
  let frac = 0
  let fracScale = 1
  let sawFracDigit = false
  if (i < end && bytes[i] === 46) {
    i++
    while (i < end) {
      const c = bytes[i]
      if (c >= 48 && c <= 57) {
        frac = frac * 10 + (c - 48)
        fracScale *= 10
        sawFracDigit = true
        i++
      } else break
    }
  }
  if (!sawDigit && !sawFracDigit) return { value: NaN, next: start }
  let value = sign * (intPart + (sawFracDigit ? frac / fracScale : 0))
  // exponent
  if (i < end && (bytes[i] === 101 || bytes[i] === 69)) {
    let j = i + 1
    let esign = 1
    if (j < end && (bytes[j] === 45 || bytes[j] === 43)) {
      if (bytes[j] === 45) esign = -1
      j++
    }
    let exp = 0
    let sawExpDigit = false
    while (j < end) {
      const c = bytes[j]
      if (c >= 48 && c <= 57) {
        exp = exp * 10 + (c - 48)
        sawExpDigit = true
        j++
      } else break
    }
    if (sawExpDigit) {
      value *= Math.pow(10, esign * Math.min(exp, 308))
      i = j
    }
  }
  return { value, next: i }
}

/** Parse an integer from bytes [start, end) — for f 1/2/3 indices. */
export function parseFastInt(bytes: Uint8Array, start: number, end: number): { value: number; next: number } {
  let i = start
  while (i < end && (bytes[i] === 32 || bytes[i] === 9 || bytes[i] === 13)) i++
  let sign = 1
  if (i < end && (bytes[i] === 45 || bytes[i] === 43)) {
    if (bytes[i] === 45) sign = -1
    i++
  }
  let v = 0
  let saw = false
  while (i < end) {
    const c = bytes[i]
    if (c >= 48 && c <= 57) {
      v = v * 10 + (c - 48)
      saw = true
      i++
    } else break
  }
  return { value: saw ? sign * v : NaN, next: saw ? i : start }
}

// ─── ascii helpers ───────────────────────────────────────────────────────────

/** ASCII string from bytes (for names/keywords — short, an allocation is fine). */
export function asciiFromBytes(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let out = ''
  // chunked String.fromCharCode — avoid stack overflow on long runs
  const CHUNK = 4096
  for (let i = start; i < end; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, end)))
  }
  return out
}

/** Compare bytes with an ASCII constant (no allocations). */
export function bytesEqualAscii(bytes: Uint8Array, start: number, end: number, ascii: string): boolean {
  if (end - start !== ascii.length) return false
  for (let i = 0; i < ascii.length; i++) {
    if (bytes[start + i] !== ascii.charCodeAt(i)) return false
  }
  return true
}

/** Index of byte c starting from from; -1 if absent. */
export function indexOfByte(bytes: Uint8Array, c: number, from = 0, end = bytes.length): number {
  for (let i = from; i < end; i++) if (bytes[i] === c) return i
  return -1
}

// ─── base64 (data: URI in glTF) ───────────────────────────────────────────────

const B64_TABLE = (() => {
  const t = new Int8Array(256).fill(-1)
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  for (let i = 0; i < alphabet.length; i++) t[alphabet.charCodeAt(i)] = i
  return t
})()

/** Decode base64 → bytes. Strict about padding (apart from ignoring whitespace). */
export function base64Decode(text: string): Uint8Array {
  let len = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 32 || c === 9 || c === 10 || c === 13) continue
    len++
  }
  let padding = 0
  if (len % 4 === 0 && text.endsWith('==')) padding = 2
  else if (len % 4 === 0 && text.endsWith('=')) padding = 1
  // NB: '=' inside the text is also skipped below (len already counted it)
  const outLen = (len / 4) * 3 - padding
  const out = new Uint8Array(outLen)
  let o = 0
  let acc = 0
  let bits = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 32 || code === 9 || code === 10 || code === 13) continue
    if (code === 61 /* = */) continue // padding
    const v = B64_TABLE[code]
    if (v < 0) throw new Error(`base64Decode: invalid char ${String.fromCharCode(code)}`)
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      if (o < outLen) out[o++] = (acc >>> bits) & 0xff
    }
  }
  return out
}

// ─── default platform capabilities ─────────────────────────────────────

/** Relative URL resolution without the DOM: new URL(rel, base). */
export const defaultResolveUrl: UrlResolver = (base, rel) => {
  if (base === null) return rel
  try {
    return new URL(rel, base).href
  } catch {
    return rel
  }
}

/** zlib/gzip/deflate via DecompressionStream, if the platform provides it. */
export const defaultInflate: ((bytes: Uint8Array) => Promise<Uint8Array>) | null =
  typeof DecompressionStream === 'function'
    ? async (bytes) => {
        // The zlib format (FBX encoding=1) is 'deflate'; gzip chunks have a
        // separate transform. This one is specifically the zlib wrap.
        const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'))
        return new Uint8Array(await new Response(stream).arrayBuffer())
      }
    : null

/**
 * Image via createImageBitmap — LAZILY: the platform is checked at call time
 * (SSR/hydration may deliver the global after module load). The Blob wrapper
 * avoids copying bytes into a string; the browser picks the decoder by
 * content (mime is a hint).
 */
export const defaultDecodeImage: ImageDecode = (bytes, mimeType, options) => {
  const fn = (globalThis as { createImageBitmap?: typeof createImageBitmap }).createImageBitmap
  if (typeof fn !== 'function') {
    return Promise.reject(
      new UnsupportedError('createImageBitmap unavailable on this platform — pass decodeImage'),
    )
  }
  return fn(
    new Blob([bytes as BlobPart], mimeType ? { type: mimeType } : undefined),
    {
      premultiplyAlpha: options.premultiplyAlpha ?? 'default',
      colorSpaceConversion: options.colorSpaceConversion ?? 'default',
      imageOrientation: options.imageOrientation ?? 'none',
      ...(options.resizeWidth !== undefined ? { resizeWidth: options.resizeWidth } : {}),
      ...(options.resizeHeight !== undefined ? { resizeHeight: options.resizeHeight } : {}),
      ...(options.resizeQuality !== undefined ? { resizeQuality: options.resizeQuality } : {}),
    },
  ).then(bitmap => bitmap as ImageBitmapLike)
}

/** Assemble PlatformCaps from injections + globals. */
export function resolvePlatformCaps(overrides: Partial<PlatformCaps> = {}): PlatformCaps {
  return {
    fetchImpl: overrides.fetchImpl ?? (globalThis.fetch as typeof fetch),
    resolveUrl: overrides.resolveUrl ?? defaultResolveUrl,
    inflate: overrides.inflate !== undefined ? overrides.inflate : defaultInflate,
    decodeImage: overrides.decodeImage !== undefined ? overrides.decodeImage : defaultDecodeImage,
  }
}

// ─── sniffing: magic bytes ──────────────────────────────────────────────

export interface SniffResult {
  /** Format name ('glb' | 'fbx' | 'png' | ...) or null. */
  readonly kind: string | null
  /** mime, if known. */
  readonly mimeType: string | null
}

/** Recognize the format by the first bytes. The URL is for extension hints. */
export function sniffKind(bytes: Uint8Array, url?: string | null): SniffResult {
  if (bytes.length >= 4) {
    const m = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]
    // GLB: ascii "glTF" (u32 LE 0x46546c67)
    if (bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46)
      return { kind: 'glb', mimeType: 'model/gltf-binary' }
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
      return { kind: 'image', mimeType: 'image/png' }
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
      return { kind: 'image', mimeType: 'image/jpeg' }
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
      return { kind: 'image', mimeType: 'image/gif' }
    if (m === 0x52494646 /* RIFF */ && bytes[8] === 0x57 && bytes[9] === 0x45)
      return { kind: 'image', mimeType: 'image/webp' }
    if (bytes[0] === 0x42 && bytes[1] === 0x4d) return { kind: 'image', mimeType: 'image/bmp' }
    if (m === 0x1f8b0800 || m === 0x1f8b0808) return { kind: 'gzip', mimeType: 'application/gzip' }
  }
  if (bytes.length >= 20 && bytesEqualAscii(bytes, 0, 18, 'Kaydara FBX Binary')) {
    return { kind: 'fbx', mimeType: 'application/octet-stream' }
  }
  if (bytes.length >= 10 && (bytesEqualAscii(bytes, 0, 10, '#?RADIANCE') || bytesEqualAscii(bytes, 0, 5, '#?RGBE'))) {
    return { kind: 'hdr', mimeType: 'image/vnd.radiance' }
  }
  // the extension as a weak signal
  if (url !== null && url !== undefined) {
    const ext = extensionOf(url)
    if (ext !== null) {
      switch (ext) {
        case 'obj': return { kind: 'obj', mimeType: null }
        case 'mtl': return { kind: 'mtl', mimeType: null }
        case 'gltf': return { kind: 'gltf', mimeType: 'model/gltf+json' }
        case 'json': return { kind: 'json', mimeType: 'application/json' }
        case 'zml': case 'xml': return { kind: 'zml', mimeType: 'text/xml' }
        case 'txt': case 'text': return { kind: 'text', mimeType: 'text/plain' }
        case 'hdr': return { kind: 'hdr', mimeType: 'image/vnd.radiance' }
        case 'png': return { kind: 'image', mimeType: 'image/png' }
        case 'jpg': case 'jpeg': return { kind: 'image', mimeType: 'image/jpeg' }
        case 'webp': return { kind: 'image', mimeType: 'image/webp' }
        case 'ktx2': return { kind: 'image', mimeType: 'image/ktx2' }
      }
    }
  }
  return { kind: null, mimeType: null }
}

/** File extension from a URL (no dot, lowercase, no query). */
export function extensionOf(url: string): string | null {
  try {
    const clean = url.split('?')[0].split('#')[0]
    const slash = clean.lastIndexOf('/')
    const dot = clean.lastIndexOf('.')
    if (dot <= slash) return null
    return clean.slice(dot + 1).toLowerCase()
  } catch {
    return null
  }
}

/** Extract "raw bytes" from a data: URI; null if it is not a data: URI. */
export function parseDataUri(uri: string): { mimeType: string | null; bytes: Uint8Array } | null {
  if (!uri.startsWith('data:')) return null
  const comma = uri.indexOf(',')
  if (comma < 0) return null
  const meta = uri.slice(5, comma)
  const isBase64 = meta.endsWith(';base64')
  const mimeType = isBase64 ? meta.slice(0, -7) : meta.length > 0 ? meta : null
  const payload = uri.slice(comma + 1)
  if (isBase64) return { mimeType, bytes: base64Decode(payload) }
  const text = decodeURIComponent(payload)
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff
  return { mimeType, bytes }
}

/** Guard: a platform capability must be present, otherwise UnsupportedError. */
export function requireCap<T>(cap: T | null | undefined, what: string): T {
  if (cap === null || cap === undefined) {
    throw new UnsupportedError(`${what} unavailable on this platform/configuration`)
  }
  return cap
}
