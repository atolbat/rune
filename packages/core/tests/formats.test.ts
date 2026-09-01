// Task 112: канонический каталог форматов текстур (@rune/core formats.ts).
//
// Проверки сверены с первоисточниками:
//  - ES 3.0.6 Table 3.2/3.13 (PDF-извлечение), WebGL-расширения;
//  - W3C WebGPU TR §26 (plain/depth/packed таблицы);
//  - gl3.h — enum-значения.

import { describe, test, expect } from 'bun:test'
import {
  TEXTURE_FORMATS,
  TEXTURE_FORMAT_IDS,
  textureFormatInfo,
  normalizeTextureFormat,
  isCompressedTextureFormat,
  textureFormatBytesPerPixel,
  textureDataSize,
  textureFormatFamily,
  pickTextureFormat,
} from '../src/formats.ts'

describe('Task 112 — каталог форматов: метаданные', () => {
  test('каталог полный: несжатые + depth/stencil + bc/etc2/eac/astc', () => {
    // Ключевые представители каждого класса
    for (const id of [
      'r8unorm', 'rg8unorm', 'rgba8unorm', 'rgba8unorm-srgb', 'bgra8unorm',
      'rgba16float', 'rgba32float', 'r32float', 'rg11b10ufloat', 'rgb9e5ufloat',
      'rgb10a2unorm', 'rgb10a2uint', 'rgba16uint', 'rgba32sint',
      'stencil8', 'depth16unorm', 'depth24plus', 'depth24plus-stencil8', 'depth32float', 'depth32float-stencil8',
      'bc1-rgba-unorm', 'bc3-rgba-unorm-srgb', 'bc4-r-snorm', 'bc5-rg-unorm', 'bc6h-rgb-ufloat', 'bc7-rgba-unorm',
      'etc2-rgb8unorm', 'etc2-rgba8unorm-srgb', 'eac-r11unorm', 'eac-rg11snorm',
      'astc-4x4-unorm', 'astc-8x8-unorm-srgb', 'astc-12x12-unorm',
    ]) {
      expect(TEXTURE_FORMATS[id as keyof typeof TEXTURE_FORMATS]).toBeDefined()
    }
    // ASTC: все 14 размеров × 2 варианта = 28
    const astcCount = TEXTURE_FORMAT_IDS.filter(f => f.startsWith('astc-')).length
    expect(astcCount).toBe(28)
    // Каталог ~110 форматов
    expect(TEXTURE_FORMAT_IDS.length).toBeGreaterThan(100)
  })

  test('байты на тексель: несжатые (спека)', () => {
    expect(TEXTURE_FORMATS.r8unorm.texelBytes).toBe(1)
    expect(TEXTURE_FORMATS.rg8unorm.texelBytes).toBe(2)
    expect(TEXTURE_FORMATS.rgba8unorm.texelBytes).toBe(4)
    expect(TEXTURE_FORMATS.rgba16float.texelBytes).toBe(8)
    expect(TEXTURE_FORMATS.rgba32float.texelBytes).toBe(16)
    expect(TEXTURE_FORMATS.r32float.texelBytes).toBe(4)
    expect(TEXTURE_FORMATS.rg11b10ufloat.texelBytes).toBe(4)
    expect(TEXTURE_FORMATS.rgb9e5ufloat.texelBytes).toBe(4)
  })

  test('сжатые блоки: BC/ETC2/EAC 4×4, ASTC размерный, 16 байт ASTC', () => {
    const bc1 = TEXTURE_FORMATS['bc1-rgba-unorm']!
    expect(bc1.blockWidth).toBe(4)
    expect(bc1.blockHeight).toBe(4)
    expect(bc1.blockBytes).toBe(8) // DXT1
    expect(TEXTURE_FORMATS['bc3-rgba-unorm']!.blockBytes).toBe(16) // DXT5
    expect(TEXTURE_FORMATS['etc2-rgb8unorm']!.blockBytes).toBe(8)
    expect(TEXTURE_FORMATS['etc2-rgba8unorm']!.blockBytes).toBe(16)
    expect(TEXTURE_FORMATS['eac-rg11unorm']!.blockBytes).toBe(16)
    const astc = TEXTURE_FORMATS['astc-12x12-unorm']!
    expect(astc.blockWidth).toBe(12)
    expect(astc.blockHeight).toBe(12)
    expect(astc.blockBytes).toBe(16)
    // texelBytes сжатых — 0 (только блоки)
    expect(bc1.texelBytes).toBe(0)
  })

  test('srgb-флаг', () => {
    expect(TEXTURE_FORMATS['rgba8unorm-srgb'].srgb).toBe(true)
    expect(TEXTURE_FORMATS.rgba8unorm.srgb).toBe(false)
    expect(TEXTURE_FORMATS['bc3-rgba-unorm-srgb'].srgb).toBe(true)
    expect(TEXTURE_FORMATS['etc2-rgba8unorm-srgb'].srgb).toBe(true)
    expect(TEXTURE_FORMATS['astc-8x8-unorm-srgb'].srgb).toBe(true)
  })

  test('sampleType: integer ≠ float ≠ depth', () => {
    expect(TEXTURE_FORMATS.rgba8uint.sampleType).toBe('uint')
    expect(TEXTURE_FORMATS.rgba32sint.sampleType).toBe('sint')
    expect(TEXTURE_FORMATS.rgba16float.sampleType).toBe('float')
    expect(TEXTURE_FORMATS.depth24plus.sampleType).toBe('depth')
    expect(TEXTURE_FORMATS.stencil8.sampleType).toBe('uint')
  })
})

describe('Task 112 — нормализация и запросы', () => {
  test('легаси-алиасы Task 67 → канонические id', () => {
    expect(normalizeTextureFormat('rgba8')).toBe('rgba8unorm')
    expect(normalizeTextureFormat('rgba16f')).toBe('rgba16float')
    expect(normalizeTextureFormat('rgba32f')).toBe('rgba32float')
  })

  test('канонические и canvas проходят; мусор — undefined', () => {
    expect(normalizeTextureFormat('rgba16float')).toBe('rgba16float')
    expect(normalizeTextureFormat('canvas')).toBe('canvas')
    expect(normalizeTextureFormat('rgba99float')).toBeUndefined()
    expect(normalizeTextureFormat('')).toBeUndefined()
  })

  test('textureFormatInfo: canvas ≡ 4-байтовый unorm; мусор — undefined', () => {
    expect(textureFormatInfo('canvas')!.texelBytes).toBe(4)
    expect(textureFormatInfo('rgba32float')!.texelBytes).toBe(16)
    expect(textureFormatInfo('nope' as never)).toBeUndefined()
  })

  test('isCompressedTextureFormat / textureFormatFamily', () => {
    expect(isCompressedTextureFormat('bc7-rgba-unorm')).toBe(true)
    expect(isCompressedTextureFormat('etc2-rgba8unorm')).toBe(true)
    expect(isCompressedTextureFormat('astc-5x5-unorm')).toBe(true)
    expect(isCompressedTextureFormat('rgba8unorm')).toBe(false)
    expect(isCompressedTextureFormat('canvas')).toBe(false)
    expect(textureFormatFamily('bc1-rgba-unorm')).toBe('bc1')
    expect(textureFormatFamily('eac-r11snorm')).toBe('eac')
    expect(textureFormatFamily('rgba8unorm')).toBe('uncompressed')
  })

  test('textureDataSize: несжатые точно; сжатые по блокам (ceil)', () => {
    expect(textureDataSize('rgba8unorm', 64, 64)).toBe(64 * 64 * 4)
    expect(textureDataSize('rgba16float', 32, 32)).toBe(32 * 32 * 8)
    // BC1 4×4 блоки по 8 байт: 64×64 → 16×16 блоков × 8 = 2048
    expect(textureDataSize('bc1-rgba-unorm', 64, 64)).toBe(16 * 16 * 8)
    // Некратное: 65×65 → 17×17 блоков
    expect(textureDataSize('bc1-rgba-unorm', 65, 65)).toBe(17 * 17 * 8)
    // ASTC 8×8: 64×64 → 8×8 блоков × 16 байт
    expect(textureDataSize('astc-8x8-unorm', 64, 64)).toBe(8 * 8 * 16)
  })

  test('textureFormatBytesPerPixel: сжатые — среднее по блоку', () => {
    expect(textureFormatBytesPerPixel('rgba8unorm')).toBe(4)
    expect(textureFormatBytesPerPixel('rgba16float')).toBe(8)
    expect(textureFormatBytesPerPixel(undefined)).toBe(4)
    // bc1: 8 байт / 16 текселей = 0.5
    expect(textureFormatBytesPerPixel('bc1-rgba-unorm')).toBeCloseTo(0.5, 10)
  })

  test('pickTextureFormat — семейная Negotiation (первый доступный)', () => {
    const none = (): boolean => false
    expect(pickTextureFormat(['astc-8x8-unorm', 'bc7-rgba-unorm'], none)).toBeUndefined()
    const onlyBc = (f: string): boolean => f.startsWith('bc')
    expect(pickTextureFormat(['astc-8x8-unorm', 'bc7-rgba-unorm', 'etc2-rgba8unorm'], onlyBc)).toBe('bc7-rgba-unorm')
    const all = (): boolean => true
    expect(pickTextureFormat(['etc2-rgba8unorm', 'bc7-rgba-unorm'], all)).toBe('etc2-rgba8unorm')
  })
})
