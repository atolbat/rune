/**
 * Atlas — a unified atlas on top of Texture (Task 62).
 *
 * BEFORE: the atlas was a "manual" practice of the calling code (packer → slots →
 * uploadSubImage by hand) + the application kept a "content plan" (atlasRedo)
 * to re-upload tiles after device loss. The v1 journal stored only
 * declarations — and after recovery it asked "press Build atlas again".
 *
 * AFTER: the atlas is a thin layer over Texture. ALL of its actions reduce to
 * Texture primitives:
 *   createAtlas(texture)          → a CPU object (no slots/packing in the GPU)
 *   atlas.pack(w, h)              → RectPacker + a slot table (CPU)
 *   atlas.upload(slot, source)    → texture.uploadSubImage(x, y, source)
 *   atlas.view(slot)              → createTextureView (UV rect)
 *   atlas.dispose()               → texture.dispose()
 *
 * Since the Texture path is wrapped in a resourceSession (the renderer's resources option),
 * every upload IS JOURNALED as texture.update with a ContentRef to the source.
 * After device loss restoreResources() brings back the atlas texture AND
 * all tiles — the atlasRedo hack is no longer needed. Cross-backend: the same
 * code runs on WebGL2 and WebGPU (uploadSubImage is a unified
 * handle method).
 */

import { createRectPacker } from './rectPacker.ts'
import type { RectPacker, RectPackerOptions, RectSlot } from './rectPacker.ts'
import type { TextureView } from './textureView.ts'
import { createTextureView } from './textureView.ts'

/** The minimal Texture contract for the atlas (the real Texture from @rune/gl). */
export interface AtlasTexture {
  readonly textureId: number
  readonly width: number
  readonly height: number
  uploadSubImage(x: number, y: number, source: unknown, options?: { flipY?: boolean }): void
  dispose(): void
}

/** An atlas slot — a region + UV rectangle. */
export interface AtlasSlot {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface AtlasOptions {
  /** Packer options: algorithm ('shelf'|'maxrects'), padding. */
  readonly packer?: RectPackerOptions
}

export interface Atlas {
  /** The carrier texture (a unified handle — renderer.texture/attachTexture). */
  readonly texture: AtlasTexture
  readonly width: number
  readonly height: number
  /** Pack a batch of rectangles. null — they did not fit.
   *  Repeated calls pack into the free space of the same atlas. */
  pack(items: readonly { id: string; w: number; h: number }[]): RectSlot[] | null
  /** Upload a source into a slot (texSubImage2DFromSource / copyExternalImageToTexture).
   *  Journaled as texture.update → survives device loss. */
  upload(slot: AtlasSlot | string, source: unknown, options?: { flipY?: boolean }): void
  /** The UV region of a slot (for shaders with u_uvOffset/u_uvScale). */
  view(slot: AtlasSlot | string): TextureView
  /** A slot by id (null — not found). */
  slot(id: string): AtlasSlot | null
  /** All packed slots. */
  slots(): readonly AtlasSlot[]
  /** Release the atlas: texture.dispose() (the texture itself is the primary resource,
   *  dispose is written to the journal; a pack after dispose — throw). */
  dispose(): void
}

/** Create an atlas over a texture. The texture is passed in from outside: the
 *  application keeps all renderer.texture capabilities (mipLevels, anisotropy). */
export function createAtlas(texture: AtlasTexture, options: AtlasOptions = {}): Atlas {
  const packer: RectPacker = createRectPacker(texture.width, texture.height, options.packer ?? { algorithm: 'shelf' })
  const slotById = new Map<string, AtlasSlot>()
  let disposed = false

  function resolve(slot: AtlasSlot | string): AtlasSlot {
    const s = typeof slot === 'string' ? slotById.get(slot) : slot
    if (s === undefined || s === null) {
      throw new Error(`Atlas: slot "${typeof slot === 'string' ? slot : slot.id}" is not packed into this atlas`)
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
    if (disposed) throw new Error('Atlas: already disposed — create a new atlas')
  }
}
