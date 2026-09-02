/**
 * @rune/kit — high-level utilities on top of @rune/gl.
 *
 * A layer between the core (@rune/gl with the Texture/Command/... primitives)
 * and user code. Includes:
 *  - AssetCache<T>: a generic cache with refcount/TTL/churn-window/scope.
 *  - RectPacker: a rectangle packer (shelf + maxrects).
 *  - MipStreamer: progressive mip streaming.
 *  - createTextureView: a texture sub-region (UV-rect emulation for WebGL2).
 *  - batchCommand: a generalized batch on top of command.
 *
 * Contract: kit knows NOTHING about HTTP/decode — that is @rune/loaders' job.
 * Kit knows about the GPU (via the @rune/gl interface) but never touches the network.
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

// Task 62: a unified atlas on top of Texture — packer + slots + upload
// via texture.uploadSubImage (logged by ResourceJournal v2 → the atlas is
// restored after device loss together with its content).
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
