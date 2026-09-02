/**
 * formats/image.ts — images: bytes → ImageBitmap (a native decoder) and
 * Radiance HDR (.hdr, RGBE) → Float32 pixels (a port of the ssr-common parser).
 *
 * ImageBitmap — "decoded pixels + an opaque handle": WebGPU
 * copyExternalImageToTexture / WebGL2 texImage2D accept it directly.
 * The decoder is injectable: in a browser/worker it is createImageBitmap,
 * in headless tests — a mock. The package does NOT pull in a GPU layer.
 *
 * HDR: 32-bit_rle_rgbe (RLE and flat scanlines), rows are flipped into the
 * GL order (v=0 = the bottom row). Cancellation checkpoints — on every scanline.
 */

import type {
  ImageBitmapLike,
  ImageDecode,
  ImageParserOptions,
  ParseContext,
  ParseInput,
  Parser,
} from '../core/types.ts'
import { ParseError, UnsupportedError, throwIfAborted } from '../core/errors.ts'
import { sniffKind } from '../core/util.ts'

// ─── ImageBitmap ─────────────────────────────────────────────────────────────

export type DecodedImage = ImageBitmapLike

export interface ImageParserFactoryOptions {
  /** The decoder; null → the parser will throw UnsupportedError when used. */
  decodeImage: ImageDecode | null
}

/** An image parser with an injectable native decoder. */
export function createImageParser(options: ImageParserFactoryOptions): Parser<DecodedImage, ImageParserOptions> {
  return {
    kind: 'image',
    extensions: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif'],
    async parse(input: ParseInput, decodeOptions: ImageParserOptions = {}): Promise<DecodedImage> {
      if (options.decodeImage === null) {
        throw new UnsupportedError(
          'image: platform decoder unavailable (no createImageBitmap) — pass decodeImage to the manager',
          input.ctx.sourceUrl,
        )
      }
      const mime = sniffKind(input.bytes, input.ctx.sourceUrl).mimeType
      return options.decodeImage(input.bytes, mime, decodeOptions)
    },
  }
}

// ─── Radiance HDR (RGBE) ─────────────────────────────────────────────────────

export interface HdrImage {
  readonly width: number
  readonly height: number
  /** RGB float, row 0 = the BOTTOM row (GL v=0), row-major. */
  readonly rgb: Float32Array
}

/** Parse a .hdr (Radiance RGBE) from bytes. */
export function parseHdrBytes(bytes: Uint8Array, ctx: ParseContext): HdrImage {
  const url = ctx.sourceUrl
  let pos = 0
  const readLine = (): string => {
    const start = pos
    while (pos < bytes.length && bytes[pos] !== 10) pos++
    const s = String.fromCharCode(...bytes.subarray(start, pos))
    pos++
    return s
  }
  const magic = readLine()
  if (!magic.startsWith('#?RADIANCE') && !magic.startsWith('#?RGBE')) {
    throw new ParseError('HDR: not a Radiance file', 0, url)
  }
  let format = ''
  for (;;) {
    if (pos >= bytes.length) throw new ParseError('HDR: unexpected end of the header', pos, url)
    const line = readLine()
    if (line === '') break
    if (line.startsWith('FORMAT=')) format = line.slice(7).trim()
  }
  if (!format.includes('32-bit_rle_rgbe')) {
    throw new ParseError(`HDR: format ${format} is not supported (32-bit_rle_rgbe required)`, pos, url)
  }
  const resLine = readLine()
  const resParts = resLine.trim().split(/\s+/)
  let width = 0
  let height = 0
  if (resParts.length >= 4 && resParts[0] === '-Y' && resParts[2] === '+X') {
    height = parseInt(resParts[1], 10)
    width = parseInt(resParts[3], 10)
  }
  if (!width || !height) throw new ParseError(`HDR: corrupt resolution line "${resLine}"`, pos, url)

  const out = new Float32Array(width * height * 3)
  for (let y = 0; y < height; y++) {
    throwIfAborted(ctx.signal, 'hdr parse')
    const isNewStyle =
      pos + 4 <= bytes.length &&
      bytes[pos] === 2 &&
      bytes[pos + 1] === 2 &&
      bytes[pos + 2] * 256 + bytes[pos + 3] === width
    if (!isNewStyle) {
      // flat scanline: raw RGBE quadruplets
      for (let x = 0; x < width; x++) {
        if (pos + 4 > bytes.length) throw new ParseError('HDR: truncated flat scanline', pos, url)
        const r = bytes[pos], g = bytes[pos + 1], b = bytes[pos + 2], e = bytes[pos + 3]
        pos += 4
        const scale = e !== 0 ? Math.pow(2, e - 136) : 0
        const o = (y * width + x) * 3
        out[o] = r * scale
        out[o + 1] = g * scale
        out[o + 2] = b * scale
      }
      continue
    }
    pos += 4
    // per-channel RLE decoding
    const ch: Uint8Array[] = [
      new Uint8Array(width), new Uint8Array(width),
      new Uint8Array(width), new Uint8Array(width),
    ]
    let ok = true
    for (let c = 0; c < 4 && ok; c++) {
      let xi = 0
      while (xi < width) {
        if (pos >= bytes.length) { ok = false; break }
        const count = bytes[pos++]
        if (count > 128) {
          const repeat = count - 128
          if (pos >= bytes.length) { ok = false; break }
          const value = bytes[pos++]
          ch[c].fill(value, xi, xi + repeat)
          xi += repeat
        } else {
          const end = Math.min(xi + count, width)
          for (; xi < end; xi++) {
            if (pos >= bytes.length) { ok = false; break }
            ch[c][xi] = bytes[pos++]
          }
        }
      }
    }
    if (!ok) throw new ParseError('HDR: truncated RLE data', pos, url)
    for (let x = 0; x < width; x++) {
      const e = ch[3][x]
      const scale = e !== 0 ? Math.pow(2, e - 136) : 0
      const o = (y * width + x) * 3
      out[o] = ch[0][x] * scale
      out[o + 1] = ch[1][x] * scale
      out[o + 2] = ch[2][x] * scale
    }
  }
  // the file: row 0 = top; GL: v=0 = bottom → flip
  const flipped = new Float32Array(out.length)
  for (let y = 0; y < height; y++) {
    const src = y * width * 3
    const dst = (height - 1 - y) * width * 3
    flipped.set(out.subarray(src, src + width * 3), dst)
  }
  return { width, height, rgb: flipped }
}

/** The HDR parser for the manager. */
export const hdrParser: Parser<HdrImage> = {
  kind: 'hdr',
  extensions: ['.hdr', '.pic'],
  parse(input: ParseInput): HdrImage {
    return parseHdrBytes(input.bytes, input.ctx)
  },
}
