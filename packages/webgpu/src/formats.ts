/**
 * Таблица форматов текстур WebGPU (Task 112).
 *
 * Перенос таблиц W3C WebGPU TR (§26 «Texture Formats»):
 *  • Plain color formats — RENDER_ATTACHMENT / blendable / multisampling /
 *    STORAGE_BINDING + texel block copy footprint;
 *  • Depth-stencil formats — аспекты, copy src/dst;
 *  • Packed/compressed (rgb9e5ufloat, BC, ETC2/EAC, ASTC) — блоки и фичи.
 *
 * Фичи-гейты (availability определяется features адаптера):
 *  • texture-compression-bc / -etc2 / -astc — блочные семейства;
 *  • float32-filterable — LINEAR-фильтрация 32F;
 *  • float32-blendable — блендинг в 32F-цели;
 *  • bgra8unorm-storage — write-only storage bgra8unorm;
 *  • rg11b10ufloat-renderable — рендер в rg11b10ufloat;
 *  • texture-formats-tier1/tier2 — V2-спека: renderability snorm-семейства
 *    и расширенный storage. На адаптерах без этих фич (все браузеры V1)
 *    соответствующие возможности честно недоступны.
 *
 * Storage: кодируется ТОЛЬКО write-only (набор V1: rgba8unorm/snorm/
 * uint/sint, rgba16uint/sint/float, r32uint/sint/float, rgba32uint/sint/
 * float + bgra8unorm за фичей). Read-only/read-write storage — за tier2,
 * движок их пока не исполняет (caps.has('storage-texture') === false,
 * Контракт 5 из Task 79) — в таблице не заявлены.
 *
 * Канонические имена/статика — @rune/core (formats.ts); канонический id
 * для WebGPU-форматов равен строке GPUTextureFormat один-в-один.
 */

import type { TextureFormatId } from '@rune/core'
import { TEXTURE_FORMATS } from '@rune/core'

/** Условие возможности: core | имя GPUFeatureName | false. */
export type GpuFeatureGate = true | string | false

/** WebGPU-специфика формата. */
export interface GPUFormatInfo {
  /** Строка GPUTextureFormat (для WebGPU V1-браузеров недоступные форматы
   *  перекрыты requiredFeature — браузер отвергнет createTexture, наша
   *  проверка делает это раньше и честнее). */
  readonly gpu: string
  /** COPY_SRC/COPY_DST/TEXTURE_BINDING — все plain-форматы умеют;
   *  помечено для depth24plus-семейства (copy dst запрещён спекой). */
  readonly copySrc: boolean
  readonly copyDst: boolean
  /** RENDER_ATTACHMENT: true | имя фичи | false. */
  readonly renderAttachment: GpuFeatureGate
  /** Блендинг (только для renderAttachment). */
  readonly blendable: GpuFeatureGate
  /** LINEAR-фильтрация: true | 'float32-filterable' | false. */
  readonly filterable: GpuFeatureGate
  /** Multisample render target. */
  readonly multisample: boolean
  /** write-only STORAGE_BINDING: true | имя фичи | false (набор V1). */
  readonly storageWrite: GpuFeatureGate
  /** Фича, требуемая для САМОГО формата (compressed/tier) — не для осей. */
  readonly requiredFeature?: string
}

const CORE = true

/** Таблица: канонический id → WebGPU-специфика (V1-браузерная реальность
 *  + tier-гейты V2-спеки; ср. с GL_FORMATS в webgl2/formats.ts). */
export const GPU_FORMATS: Readonly<Partial<Record<TextureFormatId, GPUFormatInfo>>> = {
  // 8-bit
  r8unorm: { gpu: 'r8unorm', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: CORE, filterable: CORE, multisample: true, storageWrite: false },
  r8snorm: { gpu: 'r8snorm', copySrc: CORE, copyDst: CORE, renderAttachment: 'texture-formats-tier1', blendable: CORE, filterable: CORE, multisample: true, storageWrite: false },
  r8uint: { gpu: 'r8uint', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: 'texture-formats-tier1' },
  r8sint: { gpu: 'r8sint', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: 'texture-formats-tier1' },
  rg8unorm: { gpu: 'rg8unorm', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: CORE, filterable: CORE, multisample: true, storageWrite: false },
  rg8snorm: { gpu: 'rg8snorm', copySrc: CORE, copyDst: CORE, renderAttachment: 'texture-formats-tier1', blendable: CORE, filterable: CORE, multisample: true, storageWrite: false },
  rg8uint: { gpu: 'rg8uint', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: false },
  rg8sint: { gpu: 'rg8sint', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: false },
  rgba8unorm: { gpu: 'rgba8unorm', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: CORE, filterable: CORE, multisample: true, storageWrite: CORE },
  'rgba8unorm-srgb': { gpu: 'rgba8unorm-srgb', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: CORE, filterable: CORE, multisample: true, storageWrite: false },
  rgba8snorm: { gpu: 'rgba8snorm', copySrc: CORE, copyDst: CORE, renderAttachment: 'texture-formats-tier1', blendable: CORE, filterable: CORE, multisample: true, storageWrite: CORE },
  rgba8uint: { gpu: 'rgba8uint', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: CORE },
  rgba8sint: { gpu: 'rgba8sint', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: CORE },
  bgra8unorm: { gpu: 'bgra8unorm', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: CORE, filterable: CORE, multisample: true, storageWrite: 'bgra8unorm-storage' },
  // V2-формат: в V1-браузерах отсутствует в enum; feature 'core-features-and-
  // limits' есть только на V2-адаптерах (нормальный режим) — честный гейт.
  'bgra8unorm-srgb': { gpu: 'bgra8unorm-srgb', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: CORE, filterable: CORE, multisample: true, storageWrite: false, requiredFeature: 'core-features-and-limits' },
  // 16-bit int/float
  r16uint: { gpu: 'r16uint', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: 'texture-formats-tier1' },
  r16sint: { gpu: 'r16sint', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: 'texture-formats-tier1' },
  r16float: { gpu: 'r16float', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: CORE, filterable: CORE, multisample: true, storageWrite: 'texture-formats-tier1' },
  rg16uint: { gpu: 'rg16uint', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: false },
  rg16sint: { gpu: 'rg16sint', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: false },
  rg16float: { gpu: 'rg16float', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: CORE, filterable: CORE, multisample: true, storageWrite: false },
  rgba16uint: { gpu: 'rgba16uint', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: CORE },
  rgba16sint: { gpu: 'rgba16sint', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: CORE },
  rgba16float: { gpu: 'rgba16float', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: CORE, filterable: CORE, multisample: true, storageWrite: CORE },
  // V2-only 16-bit unorm/snorm (tier1): в браузерах V1 формата нет вовсе.
  r16unorm: { gpu: 'r16unorm', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: CORE, filterable: false, multisample: true, storageWrite: CORE, requiredFeature: 'texture-formats-tier1' },
  r16snorm: { gpu: 'r16snorm', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: CORE, filterable: CORE, multisample: true, storageWrite: CORE, requiredFeature: 'texture-formats-tier1' },
  rg16unorm: { gpu: 'rg16unorm', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: CORE, filterable: false, multisample: true, storageWrite: CORE, requiredFeature: 'texture-formats-tier1' },
  rg16snorm: { gpu: 'rg16snorm', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: CORE, filterable: CORE, multisample: true, storageWrite: CORE, requiredFeature: 'texture-formats-tier1' },
  rgba16unorm: { gpu: 'rgba16unorm', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: CORE, filterable: false, multisample: true, storageWrite: CORE, requiredFeature: 'texture-formats-tier1' },
  rgba16snorm: { gpu: 'rgba16snorm', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: CORE, filterable: CORE, multisample: true, storageWrite: CORE, requiredFeature: 'texture-formats-tier1' },
  // 32-bit
  r32uint: { gpu: 'r32uint', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: false, storageWrite: CORE },
  r32sint: { gpu: 'r32sint', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: false, storageWrite: CORE },
  r32float: { gpu: 'r32float', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: 'float32-blendable', filterable: 'float32-filterable', multisample: false, storageWrite: CORE },
  rg32uint: { gpu: 'rg32uint', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: false, storageWrite: false },
  rg32sint: { gpu: 'rg32sint', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: false, storageWrite: false },
  rg32float: { gpu: 'rg32float', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: 'float32-blendable', filterable: 'float32-filterable', multisample: false, storageWrite: false },
  rgba32uint: { gpu: 'rgba32uint', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: false, storageWrite: CORE },
  rgba32sint: { gpu: 'rgba32sint', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: false, storageWrite: CORE },
  rgba32float: { gpu: 'rgba32float', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: 'float32-blendable', filterable: 'float32-filterable', multisample: false, storageWrite: CORE },
  // Packed 32-bit
  rgb10a2uint: { gpu: 'rgb10a2uint', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: 'texture-formats-tier1' },
  rgb10a2unorm: { gpu: 'rgb10a2unorm', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: CORE, filterable: CORE, multisample: true, storageWrite: 'texture-formats-tier1' },
  rg11b10ufloat: { gpu: 'rg11b10ufloat', copySrc: CORE, copyDst: CORE, renderAttachment: 'rg11b10ufloat-renderable', blendable: 'texture-formats-tier1', filterable: CORE, multisample: false, storageWrite: 'texture-formats-tier1' },
  rgb9e5ufloat: { gpu: 'rgb9e5ufloat', copySrc: CORE, copyDst: CORE, renderAttachment: false, blendable: false, filterable: CORE, multisample: false, storageWrite: false },
  // Depth/stencil (copy dst запрещён для depth24plus-семейства; depth32float
  // — copy dst тоже запрещён по спеке, copy src разрешён)
  stencil8: { gpu: 'stencil8', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: false },
  depth16unorm: { gpu: 'depth16unorm', copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: false },
  depth24plus: { gpu: 'depth24plus', copySrc: false, copyDst: false, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: false },
  'depth24plus-stencil8': { gpu: 'depth24plus-stencil8', copySrc: false, copyDst: false, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: false },
  depth32float: { gpu: 'depth32float', copySrc: CORE, copyDst: false, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: false },
  'depth32float-stencil8': { gpu: 'depth32float-stencil8', copySrc: CORE, copyDst: false, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: false },
  // BC (feature texture-compression-bc; блоки 4×4)
  'bc1-rgba-unorm': bc('bc1-rgba-unorm'), 'bc1-rgba-unorm-srgb': bc('bc1-rgba-unorm-srgb'),
  'bc2-rgba-unorm': bc('bc2-rgba-unorm'), 'bc2-rgba-unorm-srgb': bc('bc2-rgba-unorm-srgb'),
  'bc3-rgba-unorm': bc('bc3-rgba-unorm'), 'bc3-rgba-unorm-srgb': bc('bc3-rgba-unorm-srgb'),
  'bc4-r-unorm': bc('bc4-r-unorm'), 'bc4-r-snorm': bc('bc4-r-snorm'),
  'bc5-rg-unorm': bc('bc5-rg-unorm'), 'bc5-rg-snorm': bc('bc5-rg-snorm'),
  'bc6h-rgb-ufloat': bc('bc6h-rgb-ufloat'), 'bc6h-rgb-float': bc('bc6h-rgb-float'),
  'bc7-rgba-unorm': bc('bc7-rgba-unorm'), 'bc7-rgba-unorm-srgb': bc('bc7-rgba-unorm-srgb'),
  // ETC2/EAC (feature texture-compression-etc2; блоки 4×4)
  'etc2-rgb8unorm': etc('etc2-rgb8unorm'), 'etc2-rgb8unorm-srgb': etc('etc2-rgb8unorm-srgb'),
  'etc2-rgb8a1unorm': etc('etc2-rgb8a1unorm'), 'etc2-rgb8a1unorm-srgb': etc('etc2-rgb8a1unorm-srgb'),
  'etc2-rgba8unorm': etc('etc2-rgba8unorm'), 'etc2-rgba8unorm-srgb': etc('etc2-rgba8unorm-srgb'),
  'eac-r11unorm': etc('eac-r11unorm'), 'eac-r11snorm': etc('eac-r11snorm'),
  'eac-rg11unorm': etc('eac-rg11unorm'), 'eac-rg11snorm': etc('eac-rg11snorm'),
  // ASTC (feature texture-compression-astc; блоки 16 байт)
  ...astcEntries(),
}

function bc(gpu: string): GPUFormatInfo {
  return { gpu, copySrc: CORE, copyDst: CORE, renderAttachment: false, blendable: false, filterable: CORE, multisample: false, storageWrite: false, requiredFeature: 'texture-compression-bc' }
}

function etc(gpu: string): GPUFormatInfo {
  return { gpu, copySrc: CORE, copyDst: CORE, renderAttachment: false, blendable: false, filterable: CORE, multisample: false, storageWrite: false, requiredFeature: 'texture-compression-etc2' }
}

function astcEntries(): Record<string, GPUFormatInfo> {
  const out: Record<string, GPUFormatInfo> = {}
  const sizes = ['4x4', '5x4', '5x5', '6x5', '6x6', '8x5', '8x6', '8x8', '10x5', '10x6', '10x8', '10x10', '12x10', '12x12']
  for (const size of sizes) {
    for (const suffix of ['unorm', 'unorm-srgb']) {
      const id = `astc-${size}-${suffix}`
      out[id] = { gpu: id, copySrc: CORE, copyDst: CORE, renderAttachment: false, blendable: false, filterable: CORE, multisample: false, storageWrite: false, requiredFeature: 'texture-compression-astc' }
    }
  }
  return out
}

// ─── Запросы ─────────────────────────────────────────────────────────────────

/** WebGPU-специфика формата; undefined — WebGPU формат не поддерживает
 *  (GL-only: rgb8*, rgb16*, rgb32*, rgb565/rgba4/rgb5a1; псевдо 'canvas'). */
export function gpuFormatInfo(format: TextureFormatId): GPUFormatInfo | undefined {
  return GPU_FORMATS[format]
}

/** Интерфейс фич адаптера (GPUSupportedFeatures-совместимый). */
export interface GpuFeatureSet {
  has(feature: string): boolean
}

/** Формат доступен на этом устройстве? (requiredFeature-гейт). */
export function gpuFormatAvailable(format: TextureFormatId, features: GpuFeatureSet): { readonly ok: boolean; readonly reason?: string } {
  const info = GPU_FORMATS[format]
  if (info === undefined) {
    return { ok: false, reason: `WebGPU не поддерживает формат '${format}' (GL-only или вне каталога)` }
  }
  if (info.requiredFeature !== undefined && !features.has(info.requiredFeature)) {
    return { ok: false, reason: `формат '${format}' требует feature '${info.requiredFeature}' (адаптер её не выдаёт)` }
  }
  return { ok: true }
}

/** Ось возможности с учётом фич адаптера. */
export function gpuCapability(gate: GpuFeatureGate, features: GpuFeatureSet): boolean {
  if (gate === true) return true
  if (gate === false) return false
  return features.has(gate)
}

/** bytesPerRow для writeTexture/readback региона width: несжатые —
 *  texelBytes·w; сжатые — blockBytes·ceil(w/blockWidth) (WebGPU требует
 *  выравнивания 256 для copy, writeTexture допускает кратное blockBytes). */
export function gpuBytesPerRow(format: TextureFormatId, width: number): number {
  const info = TEXTURE_FORMATS[format]
  if (info === undefined) return width * 4
  if (info.family !== 'uncompressed') {
    return Math.ceil(width / info.blockWidth) * info.blockBytes
  }
  return width * info.texelBytes
}
