// Task 112: the WebGL2 format table (@rune/webgl2 formats.ts).
//
// Spec-fixed values (gl3.h, the WebGL registry) and the renderable/filterable
// semantics from ES 3.0.6 Table 3.13 (mechanically extracted from the
// PDF) + the EXT_color_buffer_float / EXT_color_buffer_half_float extensions.

import { describe, test, expect } from 'bun:test'
import {
  GL_FORMATS,
  GL_INTERNAL_FORMATS,
  GL_UPLOAD_FORMATS,
  GL_UPLOAD_TYPES,
  glFormatInfo,
  glColorRenderable,
  glFilterable,
  glValidateUploadPair,
} from '../src/formats.ts'

const NO_EXTS = { colorBufferFloat: false, colorBufferHalfFloat: false, floatLinear: false }
const FULL_EXTS = { colorBufferFloat: true, colorBufferHalfFloat: true, floatLinear: true }
const HALF_ONLY = { colorBufferFloat: false, colorBufferHalfFloat: true, floatLinear: false }

describe('Task 112 — GL table: enum values (cross-checked against gl3.h)', () => {
  test('internalFormats are exact', () => {
    expect(GL_INTERNAL_FORMATS.RGBA8).toBe(0x8058)
    expect(GL_INTERNAL_FORMATS.RGBA16F).toBe(0x881a)
    // Task 112 BUG FIX: previously RGBA32F was 0x8816 — a nonexistent value
    // (texStorage2D would give a silent GL_INVALID_ENUM). Correct: 0x8814.
    expect(GL_INTERNAL_FORMATS.RGBA32F).toBe(0x8814)
    expect(GL_INTERNAL_FORMATS.R32F).toBe(0x822e)
    expect(GL_INTERNAL_FORMATS.SRGB8_ALPHA8).toBe(0x8c43)
    expect(GL_INTERNAL_FORMATS.RGB10_A2).toBe(0x8059)
    expect(GL_INTERNAL_FORMATS.DEPTH24_STENCIL8).toBe(0x88f0)
    expect(GL_INTERNAL_FORMATS.COMPRESSED_RGBA8_ETC2_EAC).toBe(0x9278)
    expect(GL_INTERNAL_FORMATS.COMPRESSED_RGBA_ASTC_4x4_KHR).toBe(0x93b0)
  })

  test('external formats and types', () => {
    expect(GL_UPLOAD_FORMATS.RGBA).toBe(0x1908)
    expect(GL_UPLOAD_FORMATS.RGBA_INTEGER).toBe(0x8d99)
    expect(GL_UPLOAD_TYPES.HALF_FLOAT).toBe(0x140b)
    expect(GL_UPLOAD_TYPES.UNSIGNED_INT_2_10_10_10_REV).toBe(0x8368)
  })

  test('WebGPU-only formats are absent from the GL table (honestly)', () => {
    expect(glFormatInfo('bgra8unorm')).toBeUndefined()
    expect(glFormatInfo('r16unorm' as never)).toBeUndefined() // V2-tier
  })
})

describe('Task 112 — GL table: upload pairs (ES 3.0 Table 3.2)', () => {
  test('rgba16float admits HALF_FLOAT and FLOAT; rgba32float — FLOAT only', () => {
    const f16 = glFormatInfo('rgba16float')!
    expect(glValidateUploadPair('rgba16float', ...f16.uploadPairs[0]!)).toBe(true)
    expect(f16.uploadPairs).toContainEqual([GL_UPLOAD_FORMATS.RGBA, GL_UPLOAD_TYPES.FLOAT])
    expect(f16.uploadPairs).toContainEqual([GL_UPLOAD_FORMATS.RGBA, GL_UPLOAD_TYPES.HALF_FLOAT])
    expect(glValidateUploadPair('rgba16float', GL_UPLOAD_FORMATS.RGBA, GL_UPLOAD_TYPES.UNSIGNED_BYTE)).toBe(false)
    const f32 = glFormatInfo('rgba32float')!
    expect(f32.uploadPairs).toEqual([[GL_UPLOAD_FORMATS.RGBA, GL_UPLOAD_TYPES.FLOAT]])
  })

  test('integer formats upload only via *_INTEGER', () => {
    const ui = glFormatInfo('rgba32uint')!
    expect(ui.uploadPairs).toEqual([[GL_UPLOAD_FORMATS.RGBA_INTEGER, GL_UPLOAD_TYPES.UNSIGNED_INT]])
    expect(glValidateUploadPair('rgba32uint', GL_UPLOAD_FORMATS.RGBA, GL_UPLOAD_TYPES.UNSIGNED_INT)).toBe(false)
  })

  test('rgb10a2unorm — 2_10_10_10_REV only; depth24plus-stencil8 — 24_8', () => {
    const packed = glFormatInfo('rgb10a2unorm')!
    expect(packed.uploadPairs).toEqual([[GL_UPLOAD_FORMATS.RGBA, GL_UPLOAD_TYPES.UNSIGNED_INT_2_10_10_10_REV]])
    const ds = glFormatInfo('depth24plus-stencil8')!
    expect(ds.uploadPairs).toEqual([[GL_UPLOAD_FORMATS.DEPTH_STENCIL, GL_UPLOAD_TYPES.UNSIGNED_INT_24_8]])
  })

  test('compressed formats have no upload pairs (the data is block-based)', () => {
    const etc2 = glFormatInfo('etc2-rgba8unorm')!
    expect(etc2.uploadPairs).toEqual([])
    expect(etc2.compressed!.glFormat).toBe(0x9278)
    expect(etc2.compressed!.extension).toBe('core')
    expect(glFormatInfo('bc7-rgba-unorm')!.compressed!.extension).toBe('EXT_texture_compression_bptc')
    expect(glFormatInfo('astc-6x6-unorm-srgb')!.compressed!.extension).toBe('WEBGL_compressed_texture_astc')
  })
})

describe('Task 112 — GL table: renderable (Table 3.13 + extensions)', () => {
  test('unorm/srgb-alpha/integer — renderable core', () => {
    expect(glColorRenderable('rgba8unorm', NO_EXTS).ok).toBe(true)
    expect(glColorRenderable('rgba8unorm-srgb', NO_EXTS).ok).toBe(true)
    expect(glColorRenderable('rgba32uint', NO_EXTS).ok).toBe(true)
    expect(glColorRenderable('rgb8unorm', NO_EXTS).ok).toBe(true)
  })

  test('float16: renderable only with EXT_color_buffer_* (16F)', () => {
    expect(glColorRenderable('rgba16float', NO_EXTS).ok).toBe(false)
    expect(glColorRenderable('rgba16float', NO_EXTS).reason).toContain('EXT_color_buffer_float')
    expect(glColorRenderable('rgba16float', HALF_ONLY).ok).toBe(true)
    expect(glColorRenderable('r16float', HALF_ONLY).ok).toBe(true)
    expect(glColorRenderable('rg16float', HALF_ONLY).ok).toBe(true)
  })

  test('float32: renderable only with EXT_color_buffer_float', () => {
    expect(glColorRenderable('rgba32float', NO_EXTS).ok).toBe(false)
    expect(glColorRenderable('rgba32float', HALF_ONLY).ok).toBe(false) // half-only does NOT give 32F!
    expect(glColorRenderable('rgba32float', FULL_EXTS).ok).toBe(true)
    expect(glColorRenderable('r32float', FULL_EXTS).ok).toBe(true)
    expect(glColorRenderable('rg11b10ufloat', FULL_EXTS).ok).toBe(true)
  })

  test('never renderable: rgb16float, snorm, srgb8, rgb9e5, rgb-integer, compressed', () => {
    // RGB16F is not renderable with ANY extension (the WebGL2 spec of EXT_color_buffer_*)
    expect(glColorRenderable('rgb16float', FULL_EXTS).ok).toBe(false)
    expect(glColorRenderable('rgba8snorm', FULL_EXTS).ok).toBe(false)
    expect(glColorRenderable('rgb8unorm-srgb', FULL_EXTS).ok).toBe(false) // SRGB8 without alpha
    expect(glColorRenderable('rgb9e5ufloat', FULL_EXTS).ok).toBe(false)
    expect(glColorRenderable('rgb32uint', FULL_EXTS).ok).toBe(false) // RGB-integer is not renderable
    expect(glColorRenderable('etc2-rgba8unorm', FULL_EXTS).ok).toBe(false)
  })
})

describe('Task 112 — GL table: filterable (Table 3.13 + OES_texture_float_linear)', () => {
  test('16F — filterable CORE (no half_float_linear needed!)', () => {
    expect(glFilterable('rgba16float', NO_EXTS)).toBe(true)
    expect(glFilterable('rg11b10ufloat', NO_EXTS)).toBe(true)
    expect(glFilterable('rgb9e5ufloat', NO_EXTS)).toBe(true)
  })

  test('32F — filterable only with OES_texture_float_linear', () => {
    expect(glFilterable('rgba32float', NO_EXTS)).toBe(false)
    expect(glFilterable('rgba32float', { ...NO_EXTS, floatLinear: true })).toBe(true)
  })

  test('integer — never', () => {
    expect(glFilterable('rgba32uint', FULL_EXTS)).toBe(false)
    expect(glFilterable('rgb10a2uint', FULL_EXTS)).toBe(false)
  })
})

describe('Task 112 — GL table: catalog coverage', () => {
  test('all GL entries carry a primaryPair and conditions', () => {
    const entries = Object.values(GL_FORMATS) as Array<NonNullable<ReturnType<typeof glFormatInfo>>>
    expect(entries.length).toBeGreaterThan(80)
    for (const info of entries) {
      expect(info.internalFormat).toBeGreaterThan(0)
      if (info.compressed === undefined) {
        expect(info.primaryPair[0]).toBeGreaterThan(0)
        expect(info.primaryPair[1]).toBeGreaterThan(0)
      }
      expect(['core', 'EXT_color_buffer_float', 'EXT_color_buffer_half_float', 'never']).toContain(info.renderable)
      expect(['core', 'OES_texture_float_linear', 'never']).toContain(info.filterable)
    }
  })
})
