/**
 * @rune/kit — высокоуровневые утилиты поверх @rune/gl.
 *
 * Слой между ядром (@rune/gl с примитивами Texture/Command/...) и
 * пользовательским кодом. Включает:
 *  - AssetCache<T>: generic-кэш с refcount/TTL/churn-window/scope.
 *  - RectPacker: упаковщик прямоугольников (shelf + maxrects).
 *  - MipStreamer: progressive mip-стриминг.
 *  - createTextureView: sub-region текстуры (UV-rect эмуляция для WebGL2).
 *  - batchCommand: обобщённый батч поверх command.
 *
 * Контракт: kit НЕ знает про HTTP/decode — для этого есть @rune/loaders.
 * Kit знает про GPU (через @rune/gl интерфейс), но не лезет в сеть.
 */

export {
  createAssetCache,
} from './assetCache.ts'
export type {
  AssetCache,
  AssetHandle,
  AssetCacheOptions,
  AcquireOptions,
} from './assetCache.ts'

export {
  createRectPacker,
} from './rectPacker.ts'
export type {
  RectPacker,
  RectInput,
  RectSlot,
  RectPackerOptions,
} from './rectPacker.ts'

// Task 62: унифицированный атлас поверх Texture — packer + слоты + upload
// через texture.uploadSubImage (журналируется ResourceJournal v2 → атлас
// восстанавливается после потери устройства вместе с контентом).
export {
  createAtlas,
} from './atlas.ts'
export type {
  Atlas,
  AtlasSlot,
  AtlasTexture,
  AtlasOptions,
} from './atlas.ts'

export {
  createMipStreamer,
} from './mipStreamer.ts'
export type {
  MipStreamer,
  MipStreamerOptions,
  MipTargetTexture,
} from './mipStreamer.ts'

export {
  createTextureView,
} from './textureView.ts'
export type {
  TextureView,
  TextureViewDescriptor,
  ViewableTexture,
} from './textureView.ts'

export {
  batchCommand,
} from './batchCommand.ts'
export type {
  BatchCommand,
  BatchSpec,
  InstanceAttribute,
} from './batchCommand.ts'
