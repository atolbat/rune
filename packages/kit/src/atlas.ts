/**
 * Atlas — унифицированный атлас поверх Texture (Task 62).
 *
 * ДО: атлас был «ручной» практикой вызывающего кода (packer → слоты →
 * uploadSubImage руками) + приложение держало «контент-план» (atlasRedo),
 * чтобы пере-залить тайлы после потери устройства. Журнал v1 хранил только
 * декларации — и после recovery просил «нажми Build atlas снова».
 *
 * ПОСЛЕ: атлас — тонкий слой над Texture. ВСЕ его действия сведены к
 * примитивам Texture:
 *   createAtlas(texture)          → CPU-объект (слотов/упаковки нет в GPU)
 *   atlas.pack(w, h)              → RectPacker + таблица слотов (CPU)
 *   atlas.upload(slot, source)    → texture.uploadSubImage(x, y, source)
 *   atlas.view(slot)              → createTextureView (UV-rect)
 *   atlas.dispose()               → texture.dispose()
 *
 * Т.к. Texture-путь обёрнут resourceSession (опция resources рендерера),
 * каждый upload ЖУРНАЛИРУЕТСЯ как texture.update с ContentRef на источник.
 * После потери устройства restoreResources() возвращает текстуру атласа И
 * все тайлы — atlasRedo-хак больше не нужен. Кросс-бэкенд: один и тот же
 * код работает на WebGL2 и WebGPU (uploadSubImage — унифицированный
 * handle-метод).
 */

import { createRectPacker } from './rectPacker.ts'
import type { RectPacker, RectPackerOptions, RectSlot } from './rectPacker.ts'
import type { TextureView } from './textureView.ts'
import { createTextureView } from './textureView.ts'

/** Минимальный контракт Texture для атласа (реальный Texture из @rune/gl). */
export interface AtlasTexture {
  readonly textureId: number
  readonly width: number
  readonly height: number
  uploadSubImage(x: number, y: number, source: unknown, options?: { flipY?: boolean }): void
  dispose(): void
}

/** Слот атласа — регион + UV-прямоугольник. */
export interface AtlasSlot {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface AtlasOptions {
  /** Опции упаковщика: algorithm ('shelf'|'maxrects'), padding. */
  readonly packer?: RectPackerOptions
}

export interface Atlas {
  /** Текстура-носитель (унифицированный handle — renderer.texture/attachTexture). */
  readonly texture: AtlasTexture
  readonly width: number
  readonly height: number
  /** Запаковать партию прямоугольников. null — не влезло.
   *  Повторные вызовы пакуют в свободное место того же атласа. */
  pack(items: readonly { id: string; w: number; h: number }[]): RectSlot[] | null
  /** Залить источник в слот (texSubImage2DFromSource / copyExternalImageToTexture).
   *  Журналируется как texture.update → переживает потерю устройства. */
  upload(slot: AtlasSlot | string, source: unknown, options?: { flipY?: boolean }): void
  /** UV-регион слота (для шейдеров с u_uvOffset/u_uvScale). */
  view(slot: AtlasSlot | string): TextureView
  /** Слот по id (null — нет такого). */
  slot(id: string): AtlasSlot | null
  /** Все запакованные слоты. */
  slots(): readonly AtlasSlot[]
  /** Освободить атлас: texture.dispose() (сама текстура — первичный ресурс,
   *  dispose пишется в журнал; повторный pack после dispose — throw). */
  dispose(): void
}

/** Создать атлас над текстурой. Текстура передаётся снаружи: у приложения
 *  остаются все возможности renderer.texture (mipLevels, anisotropy). */
export function createAtlas(texture: AtlasTexture, options: AtlasOptions = {}): Atlas {
  const packer: RectPacker = createRectPacker(texture.width, texture.height, options.packer ?? { algorithm: 'shelf' })
  const slotById = new Map<string, AtlasSlot>()
  let disposed = false

  function resolve(slot: AtlasSlot | string): AtlasSlot {
    const s = typeof slot === 'string' ? slotById.get(slot) : slot
    if (s === undefined || s === null) {
      throw new Error(`Atlas: слот «${typeof slot === 'string' ? slot : slot.id}» не запакован в этот атлас`)
    }
    return s
  }

  return {
    texture,
    width: texture.width,
    height: texture.height,
    pack(items) {
      requireAlive()
      const slots = packer.pack(items)
      if (slots === null) return null
      for (const s of slots) slotById.set(s.id, s)
      return slots
    },
    upload(slot, source, uploadOptions) {
      requireAlive()
      const s = resolve(slot)
      texture.uploadSubImage(s.x, s.y, source, uploadOptions)
    },
    view(slot) {
      requireAlive()
      const s = resolve(slot)
      return createTextureView(texture, { origin: { x: s.x, y: s.y }, size: { width: s.w, height: s.h } })
    },
    slot(id) {
      return slotById.get(id) ?? null
    },
    slots() {
      return [...slotById.values()]
    },
    dispose() {
      if (disposed) return
      disposed = true
      texture.dispose()
    },
  }

  function requireAlive(): void {
    if (disposed) throw new Error('Atlas: уже dispose — создайте новый атлас')
  }
}
