/**
 * Image loader — декодирование в ImageBitmap по содержимому.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * КОНТРАКТ:
 *
 *   parseImage(assembler, options) → ImageAsset
 *
 *   ВХОД:   Assembler над телом изображения (PNG/JPEG/WebP/GIF/AVIF/BMP/ICO).
 *   ВЫХОД:  ImageAsset — { kind: 'image', bitmap, width, height, byteLength }.
 *
 * MIME определяется ПО БАЙТАМ (sniffImageMime), а не по заголовку HTTP
 * или расширению: серверы ошибаются, а расширение теряется при
 * data:/blob-URL. Для каждого формата — короткая префикс-подпись;
 * AVIF детектируется через ftyp-бокс (avif/avis/mif1) и даже по
 * 2-байтовому ISO-префиксу «:\)» (старый кодек).
 *
 * Декод — нативный createImageBitmap(Blob) с premultiplyAlpha:'none'
 * (рендеру нужны чистые альфа-каналы; premultiply — задача GPU-конвейя).
 * В окружениях без createImageBitmap (старые Node) — инъекция
 * options.createBitmap. Лоадер не знает про GPU: ImageBitmap —
 * «декодированные пиксели + opaque handle».
 */

import type { Assembler } from './assembler.ts'
import type { GltfPhase } from './gltf.ts'

export type OnImagePhase = (phase: GltfPhase) => void

/** Кастомный декодер (окружения без глобального createImageBitmap). */
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

/** Декодированное изображение. */
export interface ImageAsset {
  readonly kind: 'image'
  readonly bitmap: ImageBitmap
  readonly width: number
  readonly height: number
  readonly byteLength: number
}

/** Браузерный дефолт: Blob + createImageBitmap без premultiply. */
export const defaultCreateBitmap: CreateBitmap | undefined =
  typeof createImageBitmap === 'function'
    ? (bytes, mimeType, options) =>
        createImageBitmap(
          new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType }),
          options ?? { premultiplyAlpha: 'none' },
        )
    : undefined

/** Парсинг/декод изображения из завершённого тела ответа. */
export async function parseImage(assembler: Assembler, options: ImageParseOptions = {}): Promise<ImageAsset> {
  const onPhase = options.onPhase ?? (() => {})
  await assembler.completion
  onPhase({ stage: 'decode', ratio: 0.9, detail: `${assembler.watermark} байт` })
  const bytes = assembler.fullView()
  const createBitmap = options.createBitmap ?? defaultCreateBitmap
  if (createBitmap === undefined)
    throw new Error('createImageBitmap недоступен в этой среде (нужен браузер или инъекция)')
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
 * Определение типа изображения по магическим байтам.
 * 'application/octet-stream' — неизвестная подпись (caller решает сам).
 */
export function sniffImageMime(bytes: Uint8Array): string {
  if (bytes.length >= 12) {
    // JPEG: FF D8 FF
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
    // PNG: 89 50 4E 47
    if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return 'image/png'
    // RIFF/WEBP: 'RIFF' .... 'WEBP'
    if (bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70) return 'image/webp'
    // WEBP-бокс: .... 'WEBP'
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
    // ftyp 'mif1' — AVIF-контейнер без явного бренда
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
    // «:)» — древний AV1/AVIF-префикс
    if (bytes[0] === 58 && bytes[1] === 41) return 'image/avif'
    if (bytes[0] === 70 && bytes[1] === 76 && bytes[2] === 73 && bytes[3] === 70) return 'image/flif'
  }
  return 'application/octet-stream'
}


/** Алиас Task 88: короткое имя сниффера MIME по magic-байтам. */
export const sniffMime = sniffImageMime
