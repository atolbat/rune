/**
 * Image loader — decoding into an ImageBitmap by content.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CONTRACT:
 *
 *   parseImage(assembler, options) → ImageAsset
 *
 *   INPUT:  an Assembler over the image body (PNG/JPEG/WebP/GIF/AVIF/BMP/ICO).
 *   OUTPUT: ImageAsset — { kind: 'image', bitmap, width, height, byteLength }.
 *
 * MIME is determined BY BYTES (sniffImageMime), not by the HTTP header
 * or the extension: servers get it wrong, and the extension is lost in
 * data:/blob-URLs. Each format has a short prefix signature;
 * AVIF is detected via the ftyp box (avif/avis/mif1) and even by the
 * 2-byte ISO prefix ":\)" (the old codec).
 *
 * Decoding is native createImageBitmap(Blob) with premultiplyAlpha:'none'
 * (the renderer needs clean alpha channels; premultiply is the GPU pipeline's job).
 * In environments without createImageBitmap (old Node) — an injected
 * options.createBitmap. The loader knows nothing about the GPU: an ImageBitmap is
 * "decoded pixels + an opaque handle".
 */

import type { Assembler } from './assembler.ts'
import type { GltfPhase } from './gltf.ts'

export type OnImagePhase = (phase: GltfPhase) => void

/** Custom decoder (environments without a global createImageBitmap). */
export type CreateBitmap = (
  bytes: Uint8Array,
  mimeType: string,
  options?: ImageBitmapOptions,
) => Promise<ImageBitmap>

export interface ImageParseOptions {
  readonly signal?: AbortSignal
  readonly onPhase?: OnImagePhase
  readonly createBitmap?: CreateBitmap
  readonly imageBitmapOptions?: ImageBitmapOptions
}

/** Decoded image. */
export interface ImageAsset {
  readonly kind: 'image'
  readonly bitmap: ImageBitmap
  readonly width: number
  readonly height: number
  readonly byteLength: number
}

/** Browser default: Blob + createImageBitmap without premultiply. */
export const defaultCreateBitmap: CreateBitmap | undefined =
  typeof createImageBitmap === 'function'
    ? (bytes, mimeType, options) =>
        createImageBitmap(
          new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType }),
          options ?? { premultiplyAlpha: 'none' },
        )
    : undefined

/** Parse/decode an image from the completed response body. */
export async function parseImage(assembler: Assembler, options: ImageParseOptions = {}): Promise<ImageAsset> {
  const onPhase = options.onPhase ?? (() => {})
  await assembler.completion
  onPhase({ stage: 'decode', ratio: 0.9, detail: `${assembler.watermark} bytes` })
  const bytes = assembler.fullView()
  const createBitmap = options.createBitmap ?? defaultCreateBitmap
  if (createBitmap === undefined)
    throw new Error('createImageBitmap is not available in this environment (a browser or injection is needed)')
  const mimeType = sniffImageMime(bytes)
  const bitmap = await createBitmap(bytes, mimeType, options.imageBitmapOptions)
  onPhase({ stage: 'decode', ratio: 1, detail: `${bitmap.width}×${bitmap.height}` })
  return {
    kind: 'image',
    bitmap,
    width: bitmap.width,
    height: bitmap.height,
    byteLength: bytes.byteLength,
  }
}

/**
 * Detect the image type by magic bytes.
 * 'application/octet-stream' — an unknown signature (the caller decides).
 */
export function sniffImageMime(bytes: Uint8Array): string {
  if (bytes.length >= 12) {
    // JPEG: FF D8 FF
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
    // PNG: 89 50 4E 47
    if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return 'image/png'
    // RIFF/WEBP: 'RIFF' .... 'WEBP'
    if (bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70) return 'image/webp'
    // WEBP box: .... 'WEBP'
    if (bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return 'image/webp'
    // GIF: 'GIF'
    if (bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70) return 'image/gif'
    // ISO-BMFF ftyp: 'ftyp' 'avif' | 'avis'
    if (
      bytes[4] === 102 &&
      bytes[5] === 116 &&
      bytes[6] === 121 &&
      bytes[7] === 112 &&
      bytes[8] === 97 &&
      bytes[9] === 118 &&
      bytes[10] === 105 &&
      (bytes[11] === 102 || bytes[11] === 115)
    )
      return 'image/avif'
    // ftyp 'mif1' — an AVIF container without an explicit brand
    if (
      bytes[4] === 102 &&
      bytes[5] === 116 &&
      bytes[6] === 121 &&
      bytes[7] === 112 &&
      bytes[8] === 109 &&
      bytes[9] === 105 &&
      bytes[10] === 102 &&
      bytes[11] === 49
    )
      return 'image/avif'
  }
  if (bytes.length >= 6) {
    // ":)" — the ancient AV1/AVIF prefix
    if (bytes[0] === 58 && bytes[1] === 41) return 'image/avif'
    if (bytes[0] === 70 && bytes[1] === 76 && bytes[2] === 73 && bytes[3] === 70) return 'image/flif'
  }
  return 'application/octet-stream'
}


/** Task 88 alias: short name of the MIME sniffer by magic bytes. */
export const sniffMime = sniffImageMime
