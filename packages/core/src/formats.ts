/**
 * Canonical texture format catalog (Task 112).
 *
 * One name dictionary for BOTH backends: names are WebGPU-style (lowercase,
 * 'rgba16float'), as already used in the journal (TextureFormat, Task 67) and in the
 * caps matrix (formatMatrix). The WebGL2 table (packages/webgl2/src/formats.ts)
 * and the WebGPU table (packages/webgpu/src/formats.ts) narrow this catalog down to
 * the formats actually supported by the backend, with their own GLenum/flags.
 *
 * Sources (checked against primary sources, not from memory):
 *  - OpenGL ES 3.0.6 spec, Table 3.2 (valid format/type/
 *    internalformat), Table 3.13 (color-renderable / texture-filterable),
 *    Table 3.19 (compressed ETC2/EAC) — extracted from the Khronos registry PDF.
 *  - WebGL EXT_color_buffer_float: renderable = R16F, RG16F, RGBA16F, R32F,
 *    RG32F, RGBA32F, R11F_G11F_B10F (RGB16F — NOT renderable).
 *  - WebGL EXT_color_buffer_half_float (WebGL2): renderable = RGBA16F,
 *    RG16F, R16F (RGB16F — NOT renderable).
 *  - WebGL2/ES 3.0: 32F formats are NOT texture-filterable (linear filtering —
 *    OES_texture_float_linear); 16F — filterable core.
 *  - WebGPU spec (W3C TR): plain/depth/packed format tables + features
 *    texture-compression-bc/etc2/astc, float32-filterable, float32-blendable,
 *    bgra8unorm-storage, rg11b10ufloat-renderable, texture-formats-tier1/2.
 *
 * Legacy aliases (Task 67 GL facade): 'rgba8' → 'rgba8unorm',
 * 'rgba16f' → 'rgba16float', 'rgba32f' → 'rgba32float'.
 */

// ─── Catalog types ───────────────────────────────────────────────────────────

/** Format family — for family Negotiation (dossier §11.1:
 *  "Texture compression … caps.pickFormat — family Negotiation"). */
export type TextureFormatFamily =
  | 'uncompressed'
  | 'bc1' | 'bc2' | 'bc3' | 'bc4' | 'bc5' | 'bc6h' | 'bc7'
  | 'etc2' | 'eac'
  | 'astc'

/** Format data class. */
export type TextureFormatKind = 'color' | 'depth' | 'stencil' | 'depth-stencil'

/** Numeric interpretation of components (affects filtering and blending). */
export type TextureFormatNumeric =
  | 'unorm'      // unsigned normalized [0,1]
  | 'snorm'      // signed normalized [-1,1]
  | 'float'      // float16/float32/packed-float
  | 'uint'       // unsigned integer (not filterable)
  | 'sint'       // signed integer (not filterable)
  | 'ufloat'     // bc6h-rgb-ufloat (unsigned float BC6H)

/** Shader sampling type (unified nomenclature of WebGPU sampleType). */
export type TextureFormatSampleType =
  | 'float' | 'unfilterable-float' | 'uint' | 'sint' | 'depth'

/** Static (backend-independent) format properties. */
export interface TextureFormatInfo {
  /** Bytes per texel for UNcompressed formats; for compressed — 0
   *  (use blockBytes / blockWidth / blockHeight). */
  readonly texelBytes: number
  /** Compression block width (texels); 1 for uncompressed. */
  readonly blockWidth: number
  /** Compression block height (texels); 1 for uncompressed. */
  readonly blockHeight: number
  /** Bytes per compression block; for uncompressed = texelBytes. */
  readonly blockBytes: number
  /** sRGB decoding on sampling (gamma → linear). */
  readonly srgb: boolean
  /** Data class. */
  readonly kind: TextureFormatKind
  /** Numeric interpretation. */
  readonly numeric: TextureFormatNumeric
  /** Number of color channels (0 for depth/stencil). */
  readonly channels: number
  /** Shader sampling type. */
  readonly sampleType: TextureFormatSampleType
  /** Family (compression family negotiation). */
  readonly family: TextureFormatFamily
}

// ─── Canonical name union ─────────────────────────────────────────────────

/** Canonical texture format (WebGPU names as the canon).
 *
 *  'canvas' — a pseudo-format: the preferred WebGPU canvas format
 *  (getPreferredCanvasFormat, usually bgra8unorm). For WebGL2 this is RGBA8.
 *  Introduced by Task 67; kept for rendering onto canvas-compatible
 *  surfaces. Static properties — as for 4-byte unorm RGBA. */
export type TextureFormatId =
  // 8-bit per component
  | 'r8unorm' | 'r8snorm' | 'r8uint' | 'r8sint'
  | 'rg8unorm' | 'rg8snorm' | 'rg8uint' | 'rg8sint'
  | 'rgba8unorm' | 'rgba8unorm-srgb' | 'rgba8snorm' | 'rgba8uint' | 'rgba8sint'
  | 'bgra8unorm' | 'bgra8unorm-srgb'
  // GL-only 8-bit (WebGPU has no 24-bit RGB paths)
  | 'rgb8unorm' | 'rgb8unorm-srgb' | 'rgb8snorm' | 'rgb8uint' | 'rgb8sint'
  // GL-only legacy packed 16-bit
  | 'rgb565' | 'rgba4' | 'rgb5a1'
  // 16-bit per component
  | 'r16uint' | 'r16sint' | 'r16float'
  | 'rg16uint' | 'rg16sint' | 'rg16float'
  | 'rgba16uint' | 'rgba16sint' | 'rgba16float'
  // GL-only 16-bit RGB
  | 'rgb16uint' | 'rgb16sint' | 'rgb16float'
  // WebGPU V2 (tier1): 16-bit unorm/snorm
  | 'r16unorm' | 'r16snorm' | 'rg16unorm' | 'rg16snorm' | 'rgba16unorm' | 'rgba16snorm'
  // 32-bit per component
  | 'r32uint' | 'r32sint' | 'r32float'
  | 'rg32uint' | 'rg32sint' | 'rg32float'
  | 'rgba32uint' | 'rgba32sint' | 'rgba32float'
  // GL-only 32-bit RGB
  | 'rgb32uint' | 'rgb32sint' | 'rgb32float'
  // Packed 32-bit per texel
  | 'rgb10a2uint' | 'rgb10a2unorm' | 'rg11b10ufloat' | 'rgb9e5ufloat'
  // Depth/stencil
  | 'stencil8' | 'depth16unorm' | 'depth24plus' | 'depth24plus-stencil8'
  | 'depth32float' | 'depth32float-stencil8'
  // BC (desktop; WebGL2 — S3TC/RGTC/BPTC extensions, WebGPU — feature bc)
  | 'bc1-rgba-unorm' | 'bc1-rgba-unorm-srgb'
  | 'bc2-rgba-unorm' | 'bc2-rgba-unorm-srgb'
  | 'bc3-rgba-unorm' | 'bc3-rgba-unorm-srgb'
  | 'bc4-r-unorm' | 'bc4-r-snorm'
  | 'bc5-rg-unorm' | 'bc5-rg-snorm'
  | 'bc6h-rgb-ufloat' | 'bc6h-rgb-float'
  | 'bc7-rgba-unorm' | 'bc7-rgba-unorm-srgb'
  // ETC2/EAC (WebGL2 core ES 3.0; WebGPU — feature etc2)
  | 'etc2-rgb8unorm' | 'etc2-rgb8unorm-srgb'
  | 'etc2-rgb8a1unorm' | 'etc2-rgb8a1unorm-srgb'
  | 'etc2-rgba8unorm' | 'etc2-rgba8unorm-srgb'
  | 'eac-r11unorm' | 'eac-r11snorm'
  | 'eac-rg11unorm' | 'eac-rg11snorm'
  // ASTC (WebGL2 — an extension; WebGPU — feature astc)
  | 'astc-4x4-unorm' | 'astc-4x4-unorm-srgb'
  | 'astc-5x4-unorm' | 'astc-5x4-unorm-srgb'
  | 'astc-5x5-unorm' | 'astc-5x5-unorm-srgb'
  | 'astc-6x5-unorm' | 'astc-6x5-unorm-srgb'
  | 'astc-6x6-unorm' | 'astc-6x6-unorm-srgb'
  | 'astc-8x5-unorm' | 'astc-8x5-unorm-srgb'
  | 'astc-8x6-unorm' | 'astc-8x6-unorm-srgb'
  | 'astc-8x8-unorm' | 'astc-8x8-unorm-srgb'
  | 'astc-10x5-unorm' | 'astc-10x5-unorm-srgb'
  | 'astc-10x6-unorm' | 'astc-10x6-unorm-srgb'
  | 'astc-10x8-unorm' | 'astc-10x8-unorm-srgb'
  | 'astc-10x10-unorm' | 'astc-10x10-unorm-srgb'
  | 'astc-12x10-unorm' | 'astc-12x10-unorm-srgb'
  | 'astc-12x12-unorm' | 'astc-12x12-unorm-srgb'

/** Full texture format: canonical id OR the 'canvas' pseudo-format. */
export type TextureFormat = TextureFormatId | 'canvas'

/** Task 67 legacy aliases (GL facade): normalized to canonical ids. */
const LEGACY_ALIASES: Readonly<Record<string, TextureFormatId>> = {
  rgba8: 'rgba8unorm',
  rgba16f: 'rgba16float',
  rgba32f: 'rgba32float',
}

// ─── Table ─────────────────────────────────────────────────────────────────

function unorm(channels: number, bytesPerChannel: number, srgb = false): TextureFormatInfo {
  return {
    texelBytes: channels * bytesPerChannel,
    blockWidth: 1,
    blockHeight: 1,
    blockBytes: channels * bytesPerChannel,
    srgb,
    kind: 'color',
    numeric: 'unorm',
    channels,
    sampleType: 'float',
    family: 'uncompressed',
  }
}

function snorm(channels: number, bytesPerChannel: number): TextureFormatInfo {
  return {
    texelBytes: channels * bytesPerChannel,
    blockWidth: 1,
    blockHeight: 1,
    blockBytes: channels * bytesPerChannel,
    srgb: false,
    kind: 'color',
    numeric: 'snorm',
    channels,
    sampleType: 'float',
    family: 'uncompressed',
  }
}

function intFormat(channels: number, bytesPerChannel: number, signed: boolean): TextureFormatInfo {
  return {
    texelBytes: channels * bytesPerChannel,
    blockWidth: 1,
    blockHeight: 1,
    blockBytes: channels * bytesPerChannel,
    srgb: false,
    kind: 'color',
    numeric: signed ? 'sint' : 'uint',
    channels,
    sampleType: signed ? 'sint' : 'uint',
    family: 'uncompressed',
  }
}

function floatFormat(channels: number, bytesPerChannel: number): TextureFormatInfo {
  return {
    texelBytes: channels * bytesPerChannel,
    blockWidth: 1,
    blockHeight: 1,
    blockBytes: channels * bytesPerChannel,
    srgb: false,
    kind: 'color',
    numeric: 'float',
    channels,
    sampleType: 'float',
    family: 'uncompressed',
  }
}

function packed(numeric: TextureFormatNumeric, channels: number, texelBytes: number, sampleType: TextureFormatSampleType = 'float'): TextureFormatInfo {
  return {
    texelBytes,
    blockWidth: 1,
    blockHeight: 1,
    blockBytes: texelBytes,
    srgb: false,
    kind: 'color',
    numeric,
    channels,
    sampleType,
    family: 'uncompressed',
  }
}

function compressed(family: TextureFormatFamily, blockWidth: number, blockHeight: number, blockBytes: number, srgb: boolean, channels: number, numeric: TextureFormatNumeric = 'unorm'): TextureFormatInfo {
  return {
    texelBytes: 0,
    blockWidth,
    blockHeight,
    blockBytes,
    srgb,
    kind: 'color',
    numeric,
    channels,
    sampleType: 'float',
    family,
  }
}

function depthFormat(kind: TextureFormatKind, texelBytes: number): TextureFormatInfo {
  return {
    texelBytes,
    blockWidth: 1,
    blockHeight: 1,
    blockBytes: texelBytes,
    srgb: false,
    kind,
    numeric: 'float',
    channels: 0,
    sampleType: 'depth',
    family: 'uncompressed',
  }
}

/** Catalog: canonical id → static properties. */
export const TEXTURE_FORMATS: Readonly<Record<TextureFormatId, TextureFormatInfo>> = {
  // 8-bit
  r8unorm: unorm(1, 1), r8snorm: snorm(1, 1), r8uint: intFormat(1, 1, false), r8sint: intFormat(1, 1, true),
  rg8unorm: unorm(2, 1), rg8snorm: snorm(2, 1), rg8uint: intFormat(2, 1, false), rg8sint: intFormat(2, 1, true),
  rgba8unorm: unorm(4, 1), 'rgba8unorm-srgb': unorm(4, 1, true), rgba8snorm: snorm(4, 1), rgba8uint: intFormat(4, 1, false), rgba8sint: intFormat(4, 1, true),
  bgra8unorm: unorm(4, 1), 'bgra8unorm-srgb': unorm(4, 1, true),
  rgb8unorm: unorm(3, 1), 'rgb8unorm-srgb': unorm(3, 1, true), rgb8snorm: snorm(3, 1), rgb8uint: intFormat(3, 1, false), rgb8sint: intFormat(3, 1, true),
  // GL legacy packed
  rgb565: packed('unorm', 3, 2), rgba4: packed('unorm', 4, 2), rgb5a1: packed('unorm', 4, 2),
  // 16-bit
  r16uint: intFormat(1, 2, false), r16sint: intFormat(1, 2, true), r16float: floatFormat(1, 2),
  rg16uint: intFormat(2, 2, false), rg16sint: intFormat(2, 2, true), rg16float: floatFormat(2, 2),
  rgba16uint: intFormat(4, 2, false), rgba16sint: intFormat(4, 2, true), rgba16float: floatFormat(4, 2),
  rgb16uint: intFormat(3, 2, false), rgb16sint: intFormat(3, 2, true), rgb16float: floatFormat(3, 2),
  r16unorm: unorm(1, 2), r16snorm: snorm(1, 2), rg16unorm: unorm(2, 2), rg16snorm: snorm(2, 2),
  rgba16unorm: unorm(4, 2), rgba16snorm: snorm(4, 2),
  // 32-bit
  r32uint: intFormat(1, 4, false), r32sint: intFormat(1, 4, true), r32float: floatFormat(1, 4),
  rg32uint: intFormat(2, 4, false), rg32sint: intFormat(2, 4, true), rg32float: floatFormat(2, 4),
  rgba32uint: intFormat(4, 4, false), rgba32sint: intFormat(4, 4, true), rgba32float: floatFormat(4, 4),
  rgb32uint: intFormat(3, 4, false), rgb32sint: intFormat(3, 4, true), rgb32float: floatFormat(3, 4),
  // Packed
  rgb10a2uint: packed('uint', 4, 4, 'uint'),
  rgb10a2unorm: packed('unorm', 4, 4),
  rg11b10ufloat: packed('float', 3, 4),
  rgb9e5ufloat: packed('float', 3, 4),
  // Depth/stencil
  stencil8: { texelBytes: 1, blockWidth: 1, blockHeight: 1, blockBytes: 1, srgb: false, kind: 'stencil', numeric: 'uint', channels: 0, sampleType: 'uint', family: 'uncompressed' },
  depth16unorm: depthFormat('depth', 2),
  depth24plus: depthFormat('depth', 4),
  'depth24plus-stencil8': depthFormat('depth-stencil', 4),
  depth32float: depthFormat('depth', 4),
  'depth32float-stencil8': depthFormat('depth-stencil', 4),
  // BC: 4×4 blocks; DXT1/BC4/BC6H?? — bc1/bc4 = 8 bytes, bc2/bc3/bc5/bc6h/bc7 = 16
  'bc1-rgba-unorm': compressed('bc1', 4, 4, 8, false, 4),
  'bc1-rgba-unorm-srgb': compressed('bc1', 4, 4, 8, true, 4),
  'bc2-rgba-unorm': compressed('bc2', 4, 4, 16, false, 4),
  'bc2-rgba-unorm-srgb': compressed('bc2', 4, 4, 16, true, 4),
  'bc3-rgba-unorm': compressed('bc3', 4, 4, 16, false, 4),
  'bc3-rgba-unorm-srgb': compressed('bc3', 4, 4, 16, true, 4),
  'bc4-r-unorm': compressed('bc4', 4, 4, 8, false, 1),
  'bc4-r-snorm': compressed('bc4', 4, 4, 8, false, 1, 'snorm'),
  'bc5-rg-unorm': compressed('bc5', 4, 4, 16, false, 2),
  'bc5-rg-snorm': compressed('bc5', 4, 4, 16, false, 2, 'snorm'),
  'bc6h-rgb-ufloat': compressed('bc6h', 4, 4, 16, false, 3, 'ufloat'),
  'bc6h-rgb-float': compressed('bc6h', 4, 4, 16, false, 3, 'float'),
  'bc7-rgba-unorm': compressed('bc7', 4, 4, 16, false, 4),
  'bc7-rgba-unorm-srgb': compressed('bc7', 4, 4, 16, true, 4),
  // ETC2/EAC: 4×4 blocks
  'etc2-rgb8unorm': compressed('etc2', 4, 4, 8, false, 3),
  'etc2-rgb8unorm-srgb': compressed('etc2', 4, 4, 8, true, 3),
  'etc2-rgb8a1unorm': compressed('etc2', 4, 4, 8, false, 4),
  'etc2-rgb8a1unorm-srgb': compressed('etc2', 4, 4, 8, true, 4),
  'etc2-rgba8unorm': compressed('etc2', 4, 4, 16, false, 4),
  'etc2-rgba8unorm-srgb': compressed('etc2', 4, 4, 16, true, 4),
  'eac-r11unorm': compressed('eac', 4, 4, 8, false, 1),
  'eac-r11snorm': compressed('eac', 4, 4, 8, false, 1, 'snorm'),
  'eac-rg11unorm': compressed('eac', 4, 4, 16, false, 2),
  'eac-rg11snorm': compressed('eac', 4, 4, 16, false, 2, 'snorm'),
  // ASTC: blocks of various sizes, all 16 bytes
  'astc-4x4-unorm': compressed('astc', 4, 4, 16, false, 4),
  'astc-4x4-unorm-srgb': compressed('astc', 4, 4, 16, true, 4),
  'astc-5x4-unorm': compressed('astc', 5, 4, 16, false, 4),
  'astc-5x4-unorm-srgb': compressed('astc', 5, 4, 16, true, 4),
  'astc-5x5-unorm': compressed('astc', 5, 5, 16, false, 4),
  'astc-5x5-unorm-srgb': compressed('astc', 5, 5, 16, true, 4),
  'astc-6x5-unorm': compressed('astc', 6, 5, 16, false, 4),
  'astc-6x5-unorm-srgb': compressed('astc', 6, 5, 16, true, 4),
  'astc-6x6-unorm': compressed('astc', 6, 6, 16, false, 4),
  'astc-6x6-unorm-srgb': compressed('astc', 6, 6, 16, true, 4),
  'astc-8x5-unorm': compressed('astc', 8, 5, 16, false, 4),
  'astc-8x5-unorm-srgb': compressed('astc', 8, 5, 16, true, 4),
  'astc-8x6-unorm': compressed('astc', 8, 6, 16, false, 4),
  'astc-8x6-unorm-srgb': compressed('astc', 8, 6, 16, true, 4),
  'astc-8x8-unorm': compressed('astc', 8, 8, 16, false, 4),
  'astc-8x8-unorm-srgb': compressed('astc', 8, 8, 16, true, 4),
  'astc-10x5-unorm': compressed('astc', 10, 5, 16, false, 4),
  'astc-10x5-unorm-srgb': compressed('astc', 10, 5, 16, true, 4),
  'astc-10x6-unorm': compressed('astc', 10, 6, 16, false, 4),
  'astc-10x6-unorm-srgb': compressed('astc', 10, 6, 16, true, 4),
  'astc-10x8-unorm': compressed('astc', 10, 8, 16, false, 4),
  'astc-10x8-unorm-srgb': compressed('astc', 10, 8, 16, true, 4),
  'astc-10x10-unorm': compressed('astc', 10, 10, 16, false, 4),
  'astc-10x10-unorm-srgb': compressed('astc', 10, 10, 16, true, 4),
  'astc-12x10-unorm': compressed('astc', 12, 10, 16, false, 4),
  'astc-12x10-unorm-srgb': compressed('astc', 12, 10, 16, true, 4),
  'astc-12x12-unorm': compressed('astc', 12, 12, 16, false, 4),
  'astc-12x12-unorm-srgb': compressed('astc', 12, 12, 16, true, 4),
}

// ─── Queries ─────────────────────────────────────────────────────────────────

/** Canonical format properties. 'canvas' — same as rgba8unorm (4 bytes,
 *  unorm; the actual WebGPU canvas format is bgra8unorm, but for size/memory
 *  calculations 4 bytes are correct on both backends). An unknown name —
 *  undefined (honest, no default). */
export function textureFormatInfo(format: TextureFormat): TextureFormatInfo | undefined {
  if (format === 'canvas') return TEXTURE_FORMATS.rgba8unorm
  return TEXTURE_FORMATS[format as TextureFormatId]
}

/** Name normalization: Task 67 legacy aliases → canonical id.
 *  'canvas' and canonical names pass through as is. Unknown — undefined. */
export function normalizeTextureFormat(name: string): TextureFormat | undefined {
  const legacy = LEGACY_ALIASES[name]
  if (legacy !== undefined) return legacy
  if (name === 'canvas') return 'canvas'
  if (Object.prototype.hasOwnProperty.call(TEXTURE_FORMATS, name)) return name as TextureFormatId
  return undefined
}

/** Compressed (block) format? */
export function isCompressedTextureFormat(format: TextureFormat): boolean {
  const info = textureFormatInfo(format)
  return info !== undefined && info.family !== 'uncompressed'
}

/** Format family. */
export function textureFormatFamily(format: TextureFormat): TextureFormatFamily | undefined {
  return textureFormatInfo(format)?.family
}

/** Bytes per pixel (Task 67, extended by Task 112 to the whole catalog).
 *  For compressed formats — the per-block AVERAGE (blockBytes / (bw·bh)): a memory
 *  estimate; compute the exact upload size via textureCompressedSize().
 *  'canvas'/undefined — 4 (RGBA8/BGRA8). */
export function textureFormatBytesPerPixel(format?: TextureFormat): number {
  if (format === undefined) return 4
  const info = textureFormatInfo(format)
  if (info === undefined) return 4
  if (info.family !== 'uncompressed') {
    return info.blockBytes / (info.blockWidth * info.blockHeight)
  }
  return info.texelBytes
}

/** Compressed data size of a w×h region for a block format:
 *  ceil(w/bw)·ceil(h/bh)·blockBytes bytes. For uncompressed — w·h·texelBytes. */
export function textureDataSize(format: TextureFormat, width: number, height: number): number {
  const info = textureFormatInfo(format)
  if (info === undefined) return width * height * 4
  if (info.family !== 'uncompressed') {
    const blocksX = Math.ceil(width / info.blockWidth)
    const blocksY = Math.ceil(height / info.blockHeight)
    return blocksX * blocksY * info.blockBytes
  }
  return width * height * info.texelBytes
}

/** List of all canonical ids (declaration order). */
export const TEXTURE_FORMAT_IDS: readonly TextureFormatId[] = Object.keys(TEXTURE_FORMATS) as TextureFormatId[]

/** Family Negotiation (dossier §11.1 "caps.pickFormat — family
 *  Negotiation"): the first AVAILABLE format from the preference list.
 *
 *  available — a callback for actual backend availability (the caps matrix or the
 *  package's format table). Returns undefined if nothing is available —
 *  the caller decides whether to fail or take an uncompressed fallback (Contract 5
 *  honesty: there is NO substitution here).
 *
 *  Example: pickTextureFormat(['astc-8x8-unorm','bc7-rgba-unorm',
 *  'etc2-rgba8unorm'], f => caps.format(f,'sampled') !== 'none'). */
export function pickTextureFormat(
  preferences: readonly TextureFormat[],
  available: (format: TextureFormat) => boolean,
): TextureFormat | undefined {
  for (const format of preferences) {
    if (available(format)) return format
  }
  return undefined
}
