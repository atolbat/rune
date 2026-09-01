/**
 * Таблица форматов текстур WebGL2 / OpenGL ES 3.0 (Task 112).
 *
 * ПОЛНЫЙ перенос спеки — не «память», а извлечённые таблицы:
 *  • ES 3.0.6 Table 3.2 — валидные комбинации (format, type, internalformat)
 *    для texImage2D/texSubImage2D: несогласованная пара = молчаливый
 *    GL_INVALID_OPERATION (ловушка Tasks 64/67 — теперь таблица её закрывает
 *    честной валидацией до вызова GL).
 *  • ES 3.0.6 Table 3.13 — color-renderable / texture-filterable флаги
 *    (извлечены из PDF по позициям чекмарок, не по памяти).
 *  • WebGL-расширения renderability:
 *      EXT_color_buffer_float       → R16F, RG16F, RGBA16F, R32F, RG32F,
 *                                     RGBA32F, R11F_G11F_B10F (RGB16F — НЕТ)
 *      EXT_color_buffer_half_float  → RGBA16F, RG16F, R16F (RGB16F — НЕТ)
 *  • Фильтрация 32F — OES_texture_float_linear (core ES 3.0: НЕ filterable).
 *  • Compressed: ETC2/EAC — core ES 3.0 (Table 3.19); BC/S3TC, BC4-5/RGTC,
 *    BC6H-7/BPTC, ASTC — расширения (enum-значения сверены с реестром).
 *
 * Канонические имена и статические свойства — из @rune/core (formats.ts).
 * Этот файл — WebGL2-специфика: GLenum'ы + условия (расширения).
 */

import type { TextureFormatId } from '@rune/core'
import { TEXTURE_FORMATS } from '@rune/core'

// ─── Спек-фиксированные GLenum (не зависят от контекста, mock-GL безопасны) ──

/** internalFormat'ы (ES 3.0 / gl3.h, сверено по реестру Khronos). */
export const GL_INTERNAL_FORMATS = {
  R8: 0x8229,
  R8_SNORM: 0x8f94,
  RG8: 0x822b,
  RG8_SNORM: 0x8f95,
  RGB8: 0x8051,
  RGB8_SNORM: 0x8f96,
  RGB565: 0x8d62,
  RGBA4: 0x8056,
  RGB5_A1: 0x8057,
  RGBA8: 0x8058,
  RGBA8_SNORM: 0x8f97,
  RGB10_A2: 0x8059,
  RGB10_A2UI: 0x906f,
  SRGB8: 0x8c41,
  SRGB8_ALPHA8: 0x8c43,
  R16F: 0x822d,
  RG16F: 0x822f,
  RGB16F: 0x881b,
  RGBA16F: 0x881a,
  R32F: 0x822e,
  RG32F: 0x8230,
  RGB32F: 0x8815,
  RGBA32F: 0x8814,
  R11F_G11F_B10F: 0x8c3a,
  RGB9_E5: 0x8c3d,
  R8I: 0x8231,
  R8UI: 0x8232,
  R16I: 0x8233,
  R16UI: 0x8234,
  R32I: 0x8235,
  R32UI: 0x8236,
  RG8I: 0x8237,
  RG8UI: 0x8238,
  RG16I: 0x8239,
  RG16UI: 0x823a,
  RG32I: 0x823b,
  RG32UI: 0x823c,
  RGB8I: 0x8d8f,
  RGB8UI: 0x8d7d,
  RGB16I: 0x8d89,
  RGB16UI: 0x8d77,
  RGB32I: 0x8d83,
  RGB32UI: 0x8d71,
  RGBA8I: 0x8d8e,
  RGBA8UI: 0x8d7c,
  RGBA16I: 0x8d88,
  RGBA16UI: 0x8d76,
  RGBA32I: 0x8d82,
  RGBA32UI: 0x8d70,
  DEPTH_COMPONENT16: 0x81a5,
  DEPTH_COMPONENT24: 0x81a6,
  DEPTH_COMPONENT32F: 0x8cac,
  DEPTH24_STENCIL8: 0x88f0,
  DEPTH32F_STENCIL8: 0x8cad,
  STENCIL_INDEX8: 0x8d48,
  // Compressed ETC2/EAC — core ES 3.0 (Table 3.19)
  COMPRESSED_R11_EAC: 0x9270,
  COMPRESSED_SIGNED_R11_EAC: 0x9271,
  COMPRESSED_RG11_EAC: 0x9272,
  COMPRESSED_SIGNED_RG11_EAC: 0x9273,
  COMPRESSED_RGB8_ETC2: 0x9274,
  COMPRESSED_SRGB8_ETC2: 0x9275,
  COMPRESSED_RGB8_PUNCHTHROUGH_ALPHA1_ETC2: 0x9276,
  COMPRESSED_SRGB8_PUNCHTHROUGH_ALPHA1_ETC2: 0x9277,
  COMPRESSED_RGBA8_ETC2_EAC: 0x9278,
  COMPRESSED_SRGB8_ALPHA8_ETC2_EAC: 0x9279,
  // Compressed — расширения WebGL2 (значения сверены с реестром WebGL)
  COMPRESSED_RGB_S3TC_DXT1_EXT: 0x83f0,      // bc1 (rgb)
  COMPRESSED_RGBA_S3TC_DXT1_EXT: 0x83f1,     // bc1 (rgba, 1-бит альфа)
  COMPRESSED_RGBA_S3TC_DXT3_EXT: 0x83f2,     // bc2
  COMPRESSED_RGBA_S3TC_DXT5_EXT: 0x83f3,     // bc3
  COMPRESSED_SRGB_S3TC_DXT1_EXT: 0x8c4c,
  COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT: 0x8c4d,
  COMPRESSED_SRGB_ALPHA_S3TC_DXT3_EXT: 0x8c4e,
  COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT: 0x8c4f,
  COMPRESSED_RED_RGTC1_EXT: 0x8dbb,          // bc4
  COMPRESSED_SIGNED_RED_RGTC1_EXT: 0x8dbc,
  COMPRESSED_RED_GREEN_RGTC2_EXT: 0x8dbd,    // bc5
  COMPRESSED_SIGNED_RED_GREEN_RGTC2_EXT: 0x8dbe,
  COMPRESSED_RGBA_BPTC_UNORM_EXT: 0x8e8c,    // bc7
  COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT: 0x8e8d,
  COMPRESSED_RGB_BPTC_SIGNED_FLOAT_EXT: 0x8e8e,   // bc6h signed
  COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT_EXT: 0x8e8f, // bc6h unsigned
  COMPRESSED_RGBA_ASTC_4x4_KHR: 0x93b0,
  COMPRESSED_RGBA_ASTC_5x4_KHR: 0x93b1,
  COMPRESSED_RGBA_ASTC_5x5_KHR: 0x93b2,
  COMPRESSED_RGBA_ASTC_6x5_KHR: 0x93b3,
  COMPRESSED_RGBA_ASTC_6x6_KHR: 0x93b4,
  COMPRESSED_RGBA_ASTC_8x5_KHR: 0x93b5,
  COMPRESSED_RGBA_ASTC_8x6_KHR: 0x93b6,
  COMPRESSED_RGBA_ASTC_8x8_KHR: 0x93b7,
  COMPRESSED_RGBA_ASTC_10x5_KHR: 0x93b8,
  COMPRESSED_RGBA_ASTC_10x6_KHR: 0x93b9,
  COMPRESSED_RGBA_ASTC_10x8_KHR: 0x93ba,
  COMPRESSED_RGBA_ASTC_10x10_KHR: 0x93bb,
  COMPRESSED_RGBA_ASTC_12x10_KHR: 0x93bc,
  COMPRESSED_RGBA_ASTC_12x12_KHR: 0x93bd,
  COMPRESSED_SRGB8_ALPHA8_ASTC_4x4_KHR: 0x93d0,
  COMPRESSED_SRGB8_ALPHA8_ASTC_5x4_KHR: 0x93d1,
  COMPRESSED_SRGB8_ALPHA8_ASTC_5x5_KHR: 0x93d2,
  COMPRESSED_SRGB8_ALPHA8_ASTC_6x5_KHR: 0x93d3,
  COMPRESSED_SRGB8_ALPHA8_ASTC_6x6_KHR: 0x93d4,
  COMPRESSED_SRGB8_ALPHA8_ASTC_8x5_KHR: 0x93d5,
  COMPRESSED_SRGB8_ALPHA8_ASTC_8x6_KHR: 0x93d6,
  COMPRESSED_SRGB8_ALPHA8_ASTC_8x8_KHR: 0x93d7,
  COMPRESSED_SRGB8_ALPHA8_ASTC_10x5_KHR: 0x93d8,
  COMPRESSED_SRGB8_ALPHA8_ASTC_10x6_KHR: 0x93d9,
  COMPRESSED_SRGB8_ALPHA8_ASTC_10x8_KHR: 0x93da,
  COMPRESSED_SRGB8_ALPHA8_ASTC_10x10_KHR: 0x93db,
  COMPRESSED_SRGB8_ALPHA8_ASTC_12x10_KHR: 0x93dc,
  COMPRESSED_SRGB8_ALPHA8_ASTC_12x12_KHR: 0x93dd,
} as const

/** Внешние форматы загрузки (format-параметр texImage2D). */
export const GL_UPLOAD_FORMATS = {
  RED: 0x1903,
  RG: 0x8227,
  RGB: 0x1907,
  RGBA: 0x1908,
  RED_INTEGER: 0x8d94,
  RG_INTEGER: 0x8228,
  RGB_INTEGER: 0x8d98,
  RGBA_INTEGER: 0x8d99,
  DEPTH_COMPONENT: 0x1902,
  DEPTH_STENCIL: 0x84f9,
} as const

/** Типы данных загрузки (type-параметр texImage2D). */
export const GL_UPLOAD_TYPES = {
  BYTE: 0x1400,
  UNSIGNED_BYTE: 0x1401,
  SHORT: 0x1402,
  UNSIGNED_SHORT: 0x1403,
  INT: 0x1404,
  UNSIGNED_INT: 0x1405,
  FLOAT: 0x1406,
  HALF_FLOAT: 0x140b,
  UNSIGNED_SHORT_5_6_5: 0x8363,
  UNSIGNED_SHORT_4_4_4_4: 0x8033,
  UNSIGNED_SHORT_5_5_5_1: 0x8034,
  UNSIGNED_INT_2_10_10_10_REV: 0x8368,
  UNSIGNED_INT_10F_11F_11F_REV: 0x8c3b,
  UNSIGNED_INT_5_9_9_9_REV: 0x8c3e,
  UNSIGNED_INT_24_8: 0x84fa,
  FLOAT_32_UNSIGNED_INT_24_8_REV: 0x8dad,
} as const

const IF = GL_INTERNAL_FORMATS
const UF = GL_UPLOAD_FORMATS
const UT = GL_UPLOAD_TYPES

// ─── Условия расширений ──────────────────────────────────────────────────────

/** Какое расширение делает формат color-renderable. */
export type GLRenderability =
  | 'core'                        // ES 3.0 core (Table 3.13)
  | 'EXT_color_buffer_float'      // float-цели (полный float-набор)
  | 'EXT_color_buffer_half_float' // только 16F (R/RG/RGBA)
  | 'never'                       // не renderable ни с каким расширением

/** Какое расширение делает формат texture-filterable. */
export type GLFilterability =
  | 'core'                     // ES 3.0 core (Table 3.13)
  | 'OES_texture_float_linear' // 32F-форматы
  | 'never'                    // integer-форматы не фильтруются никогда

/** Формат сжатых данных: GLenum compressedTexImage2D + блок + расширение. */
export interface GLCompressedInfo {
  /** internalFormat == format параметр compressedTex{Sub}Image2D. */
  readonly glFormat: number
  /** Расширение, дающее формат ('core' — ETC2/EAC, core ES 3.0). */
  readonly extension: string | 'core'
}

/** WebGL2-специфика формата (канонический id → GLenum'ы + условия). */
export interface GLFormatInfo {
  /** internalFormat аллокации (texStorage2D / texImage2D). */
  readonly internalFormat: number
  /** Валидные (format, type) пары загрузки — ES 3.0 Table 3.2, ВСЕ. */
  readonly uploadPairs: ReadonlyArray<readonly [number, number]>
  /** Основная пара авто-вывода (первая естественная для формата). */
  readonly primaryPair: readonly [number, number]
  /** Color-renderable условие (Table 3.13 + расширения WebGL2). */
  readonly renderable: GLRenderability
  /** Texture-filterable условие (Table 3.13 + OES_texture_float_linear). */
  readonly filterable: GLFilterability
  /** Сжатый формат (если есть). */
  readonly compressed?: GLCompressedInfo
}

// ─── Таблица (ES 3.0.6 Tables 3.2 + 3.13, механически извлечено) ─────────────

const F = GL_INTERNAL_FORMATS

/** WebGL2-поддерживаемые канонические id → GL-специфика. */
export const GL_FORMATS: Readonly<Partial<Record<TextureFormatId, GLFormatInfo>>> = {
  // 8-bit unorm/snorm (Table 3.2: R8=(RED,UBYTE); 3.13: R8 R=Y F=Y)
  r8unorm: { internalFormat: F.R8, uploadPairs: [[UF.RED, UT.UNSIGNED_BYTE]], primaryPair: [UF.RED, UT.UNSIGNED_BYTE], renderable: 'core', filterable: 'core' },
  r8snorm: { internalFormat: F.R8_SNORM, uploadPairs: [[UF.RED, UT.BYTE]], primaryPair: [UF.RED, UT.BYTE], renderable: 'never', filterable: 'core' },
  rg8unorm: { internalFormat: F.RG8, uploadPairs: [[UF.RG, UT.UNSIGNED_BYTE]], primaryPair: [UF.RG, UT.UNSIGNED_BYTE], renderable: 'core', filterable: 'core' },
  rg8snorm: { internalFormat: F.RG8_SNORM, uploadPairs: [[UF.RG, UT.BYTE]], primaryPair: [UF.RG, UT.BYTE], renderable: 'never', filterable: 'core' },
  rgb8unorm: { internalFormat: F.RGB8, uploadPairs: [[UF.RGB, UT.UNSIGNED_BYTE]], primaryPair: [UF.RGB, UT.UNSIGNED_BYTE], renderable: 'core', filterable: 'core' },
  'rgb8unorm-srgb': { internalFormat: F.SRGB8, uploadPairs: [[UF.RGB, UT.UNSIGNED_BYTE]], primaryPair: [UF.RGB, UT.UNSIGNED_BYTE], renderable: 'never', filterable: 'core' },
  rgb8snorm: { internalFormat: F.RGB8_SNORM, uploadPairs: [[UF.RGB, UT.BYTE]], primaryPair: [UF.RGB, UT.BYTE], renderable: 'never', filterable: 'core' },
  rgba8unorm: { internalFormat: F.RGBA8, uploadPairs: [[UF.RGBA, UT.UNSIGNED_BYTE]], primaryPair: [UF.RGBA, UT.UNSIGNED_BYTE], renderable: 'core', filterable: 'core' },
  'rgba8unorm-srgb': { internalFormat: F.SRGB8_ALPHA8, uploadPairs: [[UF.RGBA, UT.UNSIGNED_BYTE]], primaryPair: [UF.RGBA, UT.UNSIGNED_BYTE], renderable: 'core', filterable: 'core' },
  rgba8snorm: { internalFormat: F.RGBA8_SNORM, uploadPairs: [[UF.RGBA, UT.BYTE]], primaryPair: [UF.RGBA, UT.BYTE], renderable: 'never', filterable: 'core' },
  // GL legacy packed 16-bit (Table 3.2: RGBA4=(RGBA,USHORT_4_4_4_4) и т.д.)
  rgb565: { internalFormat: F.RGB565, uploadPairs: [[UF.RGB, UT.UNSIGNED_SHORT_5_6_5]], primaryPair: [UF.RGB, UT.UNSIGNED_SHORT_5_6_5], renderable: 'core', filterable: 'core' },
  rgba4: { internalFormat: F.RGBA4, uploadPairs: [[UF.RGBA, UT.UNSIGNED_SHORT_4_4_4_4]], primaryPair: [UF.RGBA, UT.UNSIGNED_SHORT_4_4_4_4], renderable: 'core', filterable: 'core' },
  rgb5a1: { internalFormat: F.RGB5_A1, uploadPairs: [[UF.RGBA, UT.UNSIGNED_SHORT_5_5_5_1], [UF.RGBA, UT.UNSIGNED_INT_2_10_10_10_REV]], primaryPair: [UF.RGBA, UT.UNSIGNED_SHORT_5_5_5_1], renderable: 'core', filterable: 'core' },
  // Packed 32-bit (Table 3.2: RGB10_A2=(RGBA,UINT_2_10_10_10_REV))
  rgb10a2unorm: { internalFormat: F.RGB10_A2, uploadPairs: [[UF.RGBA, UT.UNSIGNED_INT_2_10_10_10_REV]], primaryPair: [UF.RGBA, UT.UNSIGNED_INT_2_10_10_10_REV], renderable: 'core', filterable: 'core' },
  rgb10a2uint: { internalFormat: F.RGB10_A2UI, uploadPairs: [[UF.RGBA_INTEGER, UT.UNSIGNED_INT_2_10_10_10_REV]], primaryPair: [UF.RGBA_INTEGER, UT.UNSIGNED_INT_2_10_10_10_REV], renderable: 'core', filterable: 'never' },
  // 16F (Table 3.2: (RG|x, HALF_FLOAT) и (x, FLOAT) оба валидны; 3.13: F=Y, R=N)
  r16float: { internalFormat: F.R16F, uploadPairs: [[UF.RED, UT.HALF_FLOAT], [UF.RED, UT.FLOAT]], primaryPair: [UF.RED, UT.HALF_FLOAT], renderable: 'EXT_color_buffer_half_float', filterable: 'core' },
  rg16float: { internalFormat: F.RG16F, uploadPairs: [[UF.RG, UT.HALF_FLOAT], [UF.RG, UT.FLOAT]], primaryPair: [UF.RG, UT.HALF_FLOAT], renderable: 'EXT_color_buffer_half_float', filterable: 'core' },
  rgb16float: { internalFormat: F.RGB16F, uploadPairs: [[UF.RGB, UT.HALF_FLOAT], [UF.RGB, UT.FLOAT]], primaryPair: [UF.RGB, UT.HALF_FLOAT], renderable: 'never', filterable: 'core' },
  rgba16float: { internalFormat: F.RGBA16F, uploadPairs: [[UF.RGBA, UT.HALF_FLOAT], [UF.RGBA, UT.FLOAT]], primaryPair: [UF.RGBA, UT.HALF_FLOAT], renderable: 'EXT_color_buffer_half_float', filterable: 'core' },
  // 32F (Table 3.13: R=N F=N — фильтрация только с OES_texture_float_linear)
  r32float: { internalFormat: F.R32F, uploadPairs: [[UF.RED, UT.FLOAT]], primaryPair: [UF.RED, UT.FLOAT], renderable: 'EXT_color_buffer_float', filterable: 'OES_texture_float_linear' },
  rg32float: { internalFormat: F.RG32F, uploadPairs: [[UF.RG, UT.FLOAT]], primaryPair: [UF.RG, UT.FLOAT], renderable: 'EXT_color_buffer_float', filterable: 'OES_texture_float_linear' },
  rgb32float: { internalFormat: F.RGB32F, uploadPairs: [[UF.RGB, UT.FLOAT]], primaryPair: [UF.RGB, UT.FLOAT], renderable: 'EXT_color_buffer_float', filterable: 'OES_texture_float_linear' },
  rgba32float: { internalFormat: F.RGBA32F, uploadPairs: [[UF.RGBA, UT.FLOAT]], primaryPair: [UF.RGBA, UT.FLOAT], renderable: 'EXT_color_buffer_float', filterable: 'OES_texture_float_linear' },
  // Packed float (Table 3.2: REV-типы + HALF_FLOAT/FLOAT; 3.13: F=Y)
  rg11b10ufloat: { internalFormat: F.R11F_G11F_B10F, uploadPairs: [[UF.RGB, UT.UNSIGNED_INT_10F_11F_11F_REV], [UF.RGB, UT.HALF_FLOAT], [UF.RGB, UT.FLOAT]], primaryPair: [UF.RGB, UT.HALF_FLOAT], renderable: 'EXT_color_buffer_float', filterable: 'core' },
  rgb9e5ufloat: { internalFormat: F.RGB9_E5, uploadPairs: [[UF.RGB, UT.UNSIGNED_INT_5_9_9_9_REV], [UF.RGB, UT.HALF_FLOAT], [UF.RGB, UT.FLOAT]], primaryPair: [UF.RGB, UT.HALF_FLOAT], renderable: 'never', filterable: 'core' },
  // Integer 8-bit (Table 3.13: R=Y F=N)
  r8uint: { internalFormat: F.R8UI, uploadPairs: [[UF.RED_INTEGER, UT.UNSIGNED_BYTE]], primaryPair: [UF.RED_INTEGER, UT.UNSIGNED_BYTE], renderable: 'core', filterable: 'never' },
  r8sint: { internalFormat: F.R8I, uploadPairs: [[UF.RED_INTEGER, UT.BYTE]], primaryPair: [UF.RED_INTEGER, UT.BYTE], renderable: 'core', filterable: 'never' },
  rg8uint: { internalFormat: F.RG8UI, uploadPairs: [[UF.RG_INTEGER, UT.UNSIGNED_BYTE]], primaryPair: [UF.RG_INTEGER, UT.UNSIGNED_BYTE], renderable: 'core', filterable: 'never' },
  rg8sint: { internalFormat: F.RG8I, uploadPairs: [[UF.RG_INTEGER, UT.BYTE]], primaryPair: [UF.RG_INTEGER, UT.BYTE], renderable: 'core', filterable: 'never' },
  rgba8uint: { internalFormat: F.RGBA8UI, uploadPairs: [[UF.RGBA_INTEGER, UT.UNSIGNED_BYTE]], primaryPair: [UF.RGBA_INTEGER, UT.UNSIGNED_BYTE], renderable: 'core', filterable: 'never' },
  rgba8sint: { internalFormat: F.RGBA8I, uploadPairs: [[UF.RGBA_INTEGER, UT.BYTE]], primaryPair: [UF.RGBA_INTEGER, UT.BYTE], renderable: 'core', filterable: 'never' },
  // Integer 16-bit
  r16uint: { internalFormat: F.R16UI, uploadPairs: [[UF.RED_INTEGER, UT.UNSIGNED_SHORT]], primaryPair: [UF.RED_INTEGER, UT.UNSIGNED_SHORT], renderable: 'core', filterable: 'never' },
  r16sint: { internalFormat: F.R16I, uploadPairs: [[UF.RED_INTEGER, UT.SHORT]], primaryPair: [UF.RED_INTEGER, UT.SHORT], renderable: 'core', filterable: 'never' },
  rg16uint: { internalFormat: F.RG16UI, uploadPairs: [[UF.RG_INTEGER, UT.UNSIGNED_SHORT]], primaryPair: [UF.RG_INTEGER, UT.UNSIGNED_SHORT], renderable: 'core', filterable: 'never' },
  rg16sint: { internalFormat: F.RG16I, uploadPairs: [[UF.RG_INTEGER, UT.SHORT]], primaryPair: [UF.RG_INTEGER, UT.SHORT], renderable: 'core', filterable: 'never' },
  rgba16uint: { internalFormat: F.RGBA16UI, uploadPairs: [[UF.RGBA_INTEGER, UT.UNSIGNED_SHORT]], primaryPair: [UF.RGBA_INTEGER, UT.UNSIGNED_SHORT], renderable: 'core', filterable: 'never' },
  rgba16sint: { internalFormat: F.RGBA16I, uploadPairs: [[UF.RGBA_INTEGER, UT.SHORT]], primaryPair: [UF.RGBA_INTEGER, UT.SHORT], renderable: 'core', filterable: 'never' },
  // Integer 32-bit
  r32uint: { internalFormat: F.R32UI, uploadPairs: [[UF.RED_INTEGER, UT.UNSIGNED_INT]], primaryPair: [UF.RED_INTEGER, UT.UNSIGNED_INT], renderable: 'core', filterable: 'never' },
  r32sint: { internalFormat: F.R32I, uploadPairs: [[UF.RED_INTEGER, UT.INT]], primaryPair: [UF.RED_INTEGER, UT.INT], renderable: 'core', filterable: 'never' },
  rg32uint: { internalFormat: F.RG32UI, uploadPairs: [[UF.RG_INTEGER, UT.UNSIGNED_INT]], primaryPair: [UF.RG_INTEGER, UT.UNSIGNED_INT], renderable: 'core', filterable: 'never' },
  rg32sint: { internalFormat: F.RG32I, uploadPairs: [[UF.RG_INTEGER, UT.INT]], primaryPair: [UF.RG_INTEGER, UT.INT], renderable: 'core', filterable: 'never' },
  rgba32uint: { internalFormat: F.RGBA32UI, uploadPairs: [[UF.RGBA_INTEGER, UT.UNSIGNED_INT]], primaryPair: [UF.RGBA_INTEGER, UT.UNSIGNED_INT], renderable: 'core', filterable: 'never' },
  rgba32sint: { internalFormat: F.RGBA32I, uploadPairs: [[UF.RGBA_INTEGER, UT.INT]], primaryPair: [UF.RGBA_INTEGER, UT.INT], renderable: 'core', filterable: 'never' },
  // GL-only RGB integer (Table 3.13: R=N F=N — не renderable!)
  rgb8uint: { internalFormat: F.RGB8UI, uploadPairs: [[UF.RGB_INTEGER, UT.UNSIGNED_BYTE]], primaryPair: [UF.RGB_INTEGER, UT.UNSIGNED_BYTE], renderable: 'never', filterable: 'never' },
  rgb8sint: { internalFormat: F.RGB8I, uploadPairs: [[UF.RGB_INTEGER, UT.BYTE]], primaryPair: [UF.RGB_INTEGER, UT.BYTE], renderable: 'never', filterable: 'never' },
  rgb16uint: { internalFormat: F.RGB16UI, uploadPairs: [[UF.RGB_INTEGER, UT.UNSIGNED_SHORT]], primaryPair: [UF.RGB_INTEGER, UT.UNSIGNED_SHORT], renderable: 'never', filterable: 'never' },
  rgb16sint: { internalFormat: F.RGB16I, uploadPairs: [[UF.RGB_INTEGER, UT.SHORT]], primaryPair: [UF.RGB_INTEGER, UT.SHORT], renderable: 'never', filterable: 'never' },
  rgb32uint: { internalFormat: F.RGB32UI, uploadPairs: [[UF.RGB_INTEGER, UT.UNSIGNED_INT]], primaryPair: [UF.RGB_INTEGER, UT.UNSIGNED_INT], renderable: 'never', filterable: 'never' },
  rgb32sint: { internalFormat: F.RGB32I, uploadPairs: [[UF.RGB_INTEGER, UT.INT]], primaryPair: [UF.RGB_INTEGER, UT.INT], renderable: 'never', filterable: 'never' },
  // Depth/stencil текстуры (renderable как depth/stencil attachment,
  // НЕ как color; Table 3.2 — пары DEPTH_*)
  depth16unorm: { internalFormat: F.DEPTH_COMPONENT16, uploadPairs: [[UF.DEPTH_COMPONENT, UT.UNSIGNED_SHORT], [UF.DEPTH_COMPONENT, UT.UNSIGNED_INT]], primaryPair: [UF.DEPTH_COMPONENT, UT.UNSIGNED_INT], renderable: 'never', filterable: 'never' },
  depth24plus: { internalFormat: F.DEPTH_COMPONENT24, uploadPairs: [[UF.DEPTH_COMPONENT, UT.UNSIGNED_INT]], primaryPair: [UF.DEPTH_COMPONENT, UT.UNSIGNED_INT], renderable: 'never', filterable: 'never' },
  depth32float: { internalFormat: F.DEPTH_COMPONENT32F, uploadPairs: [[UF.DEPTH_COMPONENT, UT.FLOAT]], primaryPair: [UF.DEPTH_COMPONENT, UT.FLOAT], renderable: 'never', filterable: 'never' },
  'depth24plus-stencil8': { internalFormat: F.DEPTH24_STENCIL8, uploadPairs: [[UF.DEPTH_STENCIL, UT.UNSIGNED_INT_24_8]], primaryPair: [UF.DEPTH_STENCIL, UT.UNSIGNED_INT_24_8], renderable: 'never', filterable: 'never' },
  'depth32float-stencil8': { internalFormat: F.DEPTH32F_STENCIL8, uploadPairs: [[UF.DEPTH_STENCIL, UT.FLOAT_32_UNSIGNED_INT_24_8_REV]], primaryPair: [UF.DEPTH_STENCIL, UT.FLOAT_32_UNSIGNED_INT_24_8_REV], renderable: 'never', filterable: 'never' },
  // Compressed ETC2/EAC — core ES 3.0
  'etc2-rgb8unorm': { internalFormat: F.COMPRESSED_RGB8_ETC2, uploadPairs: [], primaryPair: [0, 0], renderable: 'never', filterable: 'core', compressed: { glFormat: F.COMPRESSED_RGB8_ETC2, extension: 'core' } },
  'etc2-rgb8unorm-srgb': { internalFormat: F.COMPRESSED_SRGB8_ETC2, uploadPairs: [], primaryPair: [0, 0], renderable: 'never', filterable: 'core', compressed: { glFormat: F.COMPRESSED_SRGB8_ETC2, extension: 'core' } },
  'etc2-rgb8a1unorm': { internalFormat: F.COMPRESSED_RGB8_PUNCHTHROUGH_ALPHA1_ETC2, uploadPairs: [], primaryPair: [0, 0], renderable: 'never', filterable: 'core', compressed: { glFormat: F.COMPRESSED_RGB8_PUNCHTHROUGH_ALPHA1_ETC2, extension: 'core' } },
  'etc2-rgb8a1unorm-srgb': { internalFormat: F.COMPRESSED_SRGB8_PUNCHTHROUGH_ALPHA1_ETC2, uploadPairs: [], primaryPair: [0, 0], renderable: 'never', filterable: 'core', compressed: { glFormat: F.COMPRESSED_SRGB8_PUNCHTHROUGH_ALPHA1_ETC2, extension: 'core' } },
  'etc2-rgba8unorm': { internalFormat: F.COMPRESSED_RGBA8_ETC2_EAC, uploadPairs: [], primaryPair: [0, 0], renderable: 'never', filterable: 'core', compressed: { glFormat: F.COMPRESSED_RGBA8_ETC2_EAC, extension: 'core' } },
  'etc2-rgba8unorm-srgb': { internalFormat: F.COMPRESSED_SRGB8_ALPHA8_ETC2_EAC, uploadPairs: [], primaryPair: [0, 0], renderable: 'never', filterable: 'core', compressed: { glFormat: F.COMPRESSED_SRGB8_ALPHA8_ETC2_EAC, extension: 'core' } },
  'eac-r11unorm': { internalFormat: F.COMPRESSED_R11_EAC, uploadPairs: [], primaryPair: [0, 0], renderable: 'never', filterable: 'core', compressed: { glFormat: F.COMPRESSED_R11_EAC, extension: 'core' } },
  'eac-r11snorm': { internalFormat: F.COMPRESSED_SIGNED_R11_EAC, uploadPairs: [], primaryPair: [0, 0], renderable: 'never', filterable: 'core', compressed: { glFormat: F.COMPRESSED_SIGNED_R11_EAC, extension: 'core' } },
  'eac-rg11unorm': { internalFormat: F.COMPRESSED_RG11_EAC, uploadPairs: [], primaryPair: [0, 0], renderable: 'never', filterable: 'core', compressed: { glFormat: F.COMPRESSED_RG11_EAC, extension: 'core' } },
  'eac-rg11snorm': { internalFormat: F.COMPRESSED_SIGNED_RG11_EAC, uploadPairs: [], primaryPair: [0, 0], renderable: 'never', filterable: 'core', compressed: { glFormat: F.COMPRESSED_SIGNED_RG11_EAC, extension: 'core' } },
  // Compressed BC — расширения
  'bc1-rgba-unorm': { internalFormat: F.COMPRESSED_RGBA_S3TC_DXT1_EXT, uploadPairs: [], primaryPair: [0, 0], renderable: 'never', filterable: 'core', compressed: { glFormat: F.COMPRESSED_RGBA_S3TC_DXT1_EXT, extension: 'WEBGL_compressed_texture_s3tc' } },
  'bc1-rgba-unorm-srgb': { internalFormat: F.COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT, uploadPairs: [], primaryPair: [0, 0], renderable: 'never', filterable: 'core', compressed: { glFormat: F.COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT, extension: 'WEBGL_compressed_texture_s3tc_srgb' } },
  'bc2-rgba-unorm': { internalFormat: F.COMPRESSED_RGBA_S3TC_DXT3_EXT, uploadPairs: [], primaryPair: [0, 0], renderable: 'never', filterable: 'core', compressed: { glFormat: F.COMPRESSED_RGBA_S3TC_DXT3_EXT, extension: 'WEBGL_compressed_texture_s3tc' } },
  'bc2-rgba-unorm-srgb': { internalFormat: F.COMPRESSED_SRGB_ALPHA_S3TC_DXT3_EXT, uploadPairs: [], primaryPair: [0, 0], renderable: 'never', filterable: 'core', compressed: { glFormat: F.COMPRESSED_SRGB_ALPHA_S3TC_DXT3_EXT, extension: 'WEBGL_compressed_texture_s3tc_srgb' } },
  'bc3-rgba-unorm': { internalFormat: F.COMPRESSED_RGBA_S3TC_DXT5_EXT, uploadPairs: [], primaryPair: [0, 0], renderable: 'never', filterable: 'core', compressed: { glFormat: F.COMPRESSED_RGBA_S3TC_DXT5_EXT, extension: 'WEBGL_compressed_texture_s3tc' } },
  'bc3-rgba-unorm-srgb': { internalFormat: F.COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT, uploadPairs: [], primaryPair: [0, 0], renderable: 'never', filterable: 'core', compressed: { glFormat: F.COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT, extension: 'WEBGL_compressed_texture_s3tc_srgb' } },
  'bc4-r-unorm': { internalFormat: F.COMPRESSED_RED_RGTC1_EXT, uploadPairs: [], primaryPair: [0, 0], renderable: 'never', filterable: 'core', compressed: { glFormat: F.COMPRESSED_RED_RGTC1_EXT, extension: 'EXT_texture_compression_rgtc' } },
  'bc4-r-snorm': { internalFormat: F.COMPRESSED_SIGNED_RED_RGTC1_EXT, uploadPairs: [], primaryPair: [0, 0], renderable: 'never', filterable: 'core', compressed: { glFormat: F.COMPRESSED_SIGNED_RED_RGTC1_EXT, extension: 'EXT_texture_compression_rgtc' } },
  'bc5-rg-unorm': { internalFormat: F.COMPRESSED_RED_GREEN_RGTC2_EXT, uploadPairs: [], primaryPair: [0, 0], renderable: 'never', filterable: 'core', compressed: { glFormat: F.COMPRESSED_RED_GREEN_RGTC2_EXT, extension: 'EXT_texture_compression_rgtc' } },
  'bc5-rg-snorm': { internalFormat: F.COMPRESSED_SIGNED_RED_GREEN_RGTC2_EXT, uploadPairs: [], primaryPair: [0, 0], renderable: 'never', filterable: 'core', compressed: { glFormat: F.COMPRESSED_SIGNED_RED_GREEN_RGTC2_EXT, extension: 'EXT_texture_compression_rgtc' } },
  'bc6h-rgb-ufloat': { internalFormat: F.COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT_EXT, uploadPairs: [], primaryPair: [0, 0], renderable: 'never', filterable: 'core', compressed: { glFormat: F.COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT_EXT, extension: 'EXT_texture_compression_bptc' } },
  'bc6h-rgb-float': { internalFormat: F.COMPRESSED_RGB_BPTC_SIGNED_FLOAT_EXT, uploadPairs: [], primaryPair: [0, 0], renderable: 'never', filterable: 'core', compressed: { glFormat: F.COMPRESSED_RGB_BPTC_SIGNED_FLOAT_EXT, extension: 'EXT_texture_compression_bptc' } },
  'bc7-rgba-unorm': { internalFormat: F.COMPRESSED_RGBA_BPTC_UNORM_EXT, uploadPairs: [], primaryPair: [0, 0], renderable: 'never', filterable: 'core', compressed: { glFormat: F.COMPRESSED_RGBA_BPTC_UNORM_EXT, extension: 'EXT_texture_compression_bptc' } },
  'bc7-rgba-unorm-srgb': { internalFormat: F.COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT, uploadPairs: [], primaryPair: [0, 0], renderable: 'never', filterable: 'core', compressed: { glFormat: F.COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT, extension: 'EXT_texture_compression_bptc' } },
  // Compressed ASTC — расширение (28 вариантов)
  ...astcEntries(),
}

/** ASTC-записи таблицы (генерация по 14 размерам блока × unorm/srgb). */
function astcEntries(): Record<string, GLFormatInfo> {
  const blocks: ReadonlyArray<readonly [string, number, number]> = [
    // [suffix, unormEnum, srgbEnum]
    ['4x4', F.COMPRESSED_RGBA_ASTC_4x4_KHR, F.COMPRESSED_SRGB8_ALPHA8_ASTC_4x4_KHR],
    ['5x4', F.COMPRESSED_RGBA_ASTC_5x4_KHR, F.COMPRESSED_SRGB8_ALPHA8_ASTC_5x4_KHR],
    ['5x5', F.COMPRESSED_RGBA_ASTC_5x5_KHR, F.COMPRESSED_SRGB8_ALPHA8_ASTC_5x5_KHR],
    ['6x5', F.COMPRESSED_RGBA_ASTC_6x5_KHR, F.COMPRESSED_SRGB8_ALPHA8_ASTC_6x5_KHR],
    ['6x6', F.COMPRESSED_RGBA_ASTC_6x6_KHR, F.COMPRESSED_SRGB8_ALPHA8_ASTC_6x6_KHR],
    ['8x5', F.COMPRESSED_RGBA_ASTC_8x5_KHR, F.COMPRESSED_SRGB8_ALPHA8_ASTC_8x5_KHR],
    ['8x6', F.COMPRESSED_RGBA_ASTC_8x6_KHR, F.COMPRESSED_SRGB8_ALPHA8_ASTC_8x6_KHR],
    ['8x8', F.COMPRESSED_RGBA_ASTC_8x8_KHR, F.COMPRESSED_SRGB8_ALPHA8_ASTC_8x8_KHR],
    ['10x5', F.COMPRESSED_RGBA_ASTC_10x5_KHR, F.COMPRESSED_SRGB8_ALPHA8_ASTC_10x5_KHR],
    ['10x6', F.COMPRESSED_RGBA_ASTC_10x6_KHR, F.COMPRESSED_SRGB8_ALPHA8_ASTC_10x6_KHR],
    ['10x8', F.COMPRESSED_RGBA_ASTC_10x8_KHR, F.COMPRESSED_SRGB8_ALPHA8_ASTC_10x8_KHR],
    ['10x10', F.COMPRESSED_RGBA_ASTC_10x10_KHR, F.COMPRESSED_SRGB8_ALPHA8_ASTC_10x10_KHR],
    ['12x10', F.COMPRESSED_RGBA_ASTC_12x10_KHR, F.COMPRESSED_SRGB8_ALPHA8_ASTC_12x10_KHR],
    ['12x12', F.COMPRESSED_RGBA_ASTC_12x12_KHR, F.COMPRESSED_SRGB8_ALPHA8_ASTC_12x12_KHR],
  ]
  const out: Record<string, GLFormatInfo> = {}
  for (const [suffix, unormEnum, srgbEnum] of blocks) {
    out[`astc-${suffix}-unorm`] = {
      internalFormat: unormEnum,
      uploadPairs: [],
      primaryPair: [0, 0],
      renderable: 'never',
      filterable: 'core',
      compressed: { glFormat: unormEnum, extension: 'WEBGL_compressed_texture_astc' },
    }
    out[`astc-${suffix}-unorm-srgb`] = {
      internalFormat: srgbEnum,
      uploadPairs: [],
      primaryPair: [0, 0],
      renderable: 'never',
      filterable: 'core',
      compressed: { glFormat: srgbEnum, extension: 'WEBGL_compressed_texture_astc' },
    }
  }
  return out
}

// ─── Запросы ─────────────────────────────────────────────────────────────────

/** GL-специфика формата; undefined — WebGL2 формат не поддерживает
 *  (bgra8unorm, canvas, 16-бит unorm/snorm V2 и т.д.). */
export function glFormatInfo(format: TextureFormatId): GLFormatInfo | undefined {
  return GL_FORMATS[format]
}

/** Расширения, влияющие на форматы (пробятся capsProbe'ом/фасадом). */
export interface GLFormatExtensions {
  /** EXT_color_buffer_float: рендер в 16F/32F-цели. */
  readonly colorBufferFloat: boolean
  /** EXT_color_buffer_half_float: рендер в 16F (R/RG/RGBA). */
  readonly colorBufferHalfFloat: boolean
  /** OES_texture_float_linear: LINEAR-фильтрация 32F. */
  readonly floatLinear: boolean
}

/** Формат color-renderable при данном наборе расширений?
 *  Возвращает ok + честную причину для ошибки (Контракт 5). */
export function glColorRenderable(
  format: TextureFormatId,
  exts: GLFormatExtensions,
): { readonly ok: boolean; readonly reason?: string } {
  const info = GL_FORMATS[format]
  if (info === undefined) {
    return { ok: false, reason: `WebGL2 не поддерживает формат '${format}'` }
  }
  switch (info.renderable) {
    case 'core':
      return { ok: true }
    case 'EXT_color_buffer_float':
      return exts.colorBufferFloat
        ? { ok: true }
        : { ok: false, reason: `рендер в '${format}' требует EXT_color_buffer_float (на этом контексте расширения нет)` }
    case 'EXT_color_buffer_half_float': {
      // RGBA16F/RG16F/R16F: либо EXT_color_buffer_float, либо half_float
      if (exts.colorBufferFloat) return { ok: true }
      if (exts.colorBufferHalfFloat) return { ok: true }
      return { ok: false, reason: `рендер в '${format}' требует EXT_color_buffer_float или EXT_color_buffer_half_float (на этом контексте их нет)` }
    }
    default:
      return { ok: false, reason: `формат '${format}' не color-renderable в WebGL2 (ES 3.0 Table 3.13)` }
  }
}

/** Формат texture-filterable при данном наборе расширений? */
export function glFilterable(format: TextureFormatId, exts: GLFormatExtensions): boolean {
  const info = GL_FORMATS[format]
  if (info === undefined) return false
  if (info.filterable === 'core') return true
  if (info.filterable === 'OES_texture_float_linear') return exts.floatLinear
  return false
}

/** Валидна ли пара (format, type) для загрузки в формат хранения
 *  (ES 3.0 Table 3.2)? Несовместимая пара — молчаливый GL_INVALID_OPERATION;
 *  эта проверка заменяет его честной ошибкой ДО вызова GL. */
export function glValidateUploadPair(
  format: TextureFormatId,
  uploadFormat: number,
  uploadType: number,
): boolean {
  const info = GL_FORMATS[format]
  if (info === undefined) return false
  return info.uploadPairs.some(([f, t]) => f === uploadFormat && t === uploadType)
}

/** Статические свойства канонического каталога для GL-формата. */
export function glCatalogInfo(format: TextureFormatId) {
  return TEXTURE_FORMATS[format]
}
