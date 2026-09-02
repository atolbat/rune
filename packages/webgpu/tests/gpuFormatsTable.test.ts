// Task 112: the WebGPU format table (@rune/webgpu formats.ts).
//
// Cross-checked against W3C WebGPU TR §26 (plain/depth/packed tables,
// extracted from the spec) + feature gates (texture-compression-bc/etc2/
// astc, float32-filterable, float32-blendable, bgra8unorm-storage,
// rg11b10ufloat-renderable, texture-formats-tier1/2).

import { describe, test, expect } from 'bun:test'
import { GPU_FORMATS, gpuFormatInfo, gpuFormatAvailable, gpuCapability, gpuBytesPerRow } from '../src/formats.ts'

const NO_FEATURES = { has: (_f: string) => false }
const ALL_FEATURES = { has: (_f: string) => true }

describe('Task 112 — GPU table: basic flags (per the spec)', () => {
  test('rgba8unorm — render+blend+filter+msaa core', () => {
    const f = gpuFormatInfo('rgba8unorm')!
    expect(f.renderAttachment).toBe(true)
    expect(f.blendable).toBe(true)
    expect(f.filterable).toBe(true)
    expect(f.multisample).toBe(true)
  })

  test('rgba32float — render CORE; filter/blend behind features; msaa never', () => {
    const f = gpuFormatInfo('rgba32float')!
    expect(f.renderAttachment).toBe(true)
    expect(f.filterable).toBe('float32-filterable')
    expect(f.blendable).toBe('float32-blendable')
    expect(f.multisample).toBe(false)
  })

  test('rgba16float — filterable+renderable+blendable core (no paradoxes)', () => {
    const f = gpuFormatInfo('rgba16float')!
    expect(f.filterable).toBe(true)
    expect(f.renderAttachment).toBe(true)
    expect(f.blendable).toBe(true)
    expect(f.multisample).toBe(true)
  })

  test('rgb9e5ufloat — NOT renderable, but filterable (packed table)', () => {
    const f = gpuFormatInfo('rgb9e5ufloat')!
    expect(f.renderAttachment).toBe(false)
    expect(f.filterable).toBe(true)
  })

  test('rg11b10ufloat — render behind the rg11b10ufloat-renderable feature', () => {
    const f = gpuFormatInfo('rg11b10ufloat')!
    expect(f.renderAttachment).toBe('rg11b10ufloat-renderable')
  })

  test('integer formats are neither filtered nor blended', () => {
    const ui = gpuFormatInfo('rgba32uint')!
    expect(ui.filterable).toBe(false)
    expect(ui.blendable).toBe(false)
    expect(ui.renderAttachment).toBe(true)
  })

  test('depth: the 24plus family without copy, 32float without copy-dst', () => {
    expect(gpuFormatInfo('depth24plus')!.copySrc).toBe(false)
    expect(gpuFormatInfo('depth24plus')!.copyDst).toBe(false)
    expect(gpuFormatInfo('depth32float')!.copySrc).toBe(true)
    expect(gpuFormatInfo('depth32float')!.copyDst).toBe(false)
    expect(gpuFormatInfo('depth16unorm')!.copyDst).toBe(true)
  })

  test('GL-only formats are absent (rgb8*, legacy packed)', () => {
    expect(gpuFormatInfo('rgb8unorm')).toBeUndefined()
    expect(gpuFormatInfo('rgb16float')).toBeUndefined()
    expect(gpuFormatInfo('rgb565' as never)).toBeUndefined()
  })
})

describe('Task 112 — GPU table: compressed gates', () => {
  test('the bc family behind texture-compression-bc', () => {
    const f = gpuFormatInfo('bc7-rgba-unorm')!
    expect(f.requiredFeature).toBe('texture-compression-bc')
    expect(gpuFormatAvailable('bc7-rgba-unorm', NO_FEATURES).ok).toBe(false)
    expect(gpuFormatAvailable('bc7-rgba-unorm', NO_FEATURES).reason).toContain('texture-compression-bc')
    expect(gpuFormatAvailable('bc7-rgba-unorm', ALL_FEATURES).ok).toBe(true)
    expect(gpuFormatAvailable('etc2-rgba8unorm', ALL_FEATURES).ok).toBe(true)
    expect(gpuFormatAvailable('astc-8x8-unorm', ALL_FEATURES).ok).toBe(true)
  })

  test('compressed formats are not renderable (texture family)', () => {
    expect(gpuFormatInfo('bc1-rgba-unorm')!.renderAttachment).toBe(false)
    expect(gpuFormatInfo('etc2-rgb8unorm')!.renderAttachment).toBe(false)
    expect(gpuFormatInfo('astc-4x4-unorm')!.renderAttachment).toBe(false)
  })

  test('28 ASTC formats in the table', () => {
    const astc = Object.keys(GPU_FORMATS).filter(k => k.startsWith('astc-'))
    expect(astc.length).toBe(28)
  })
})

describe('Task 112 — GPU table: availability and helpers', () => {
  test('V2-tier formats are gated off without the feature (V1 browser reality)', () => {
    expect(gpuFormatInfo('r16unorm')!.requiredFeature).toBe('texture-formats-tier1')
    expect(gpuFormatAvailable('r16unorm', NO_FEATURES).ok).toBe(false)
    expect(gpuFormatAvailable('r16unorm', ALL_FEATURES).ok).toBe(true)
    // bgra8unorm-srgb — a V2 format: gated by core-features-and-limits
    expect(gpuFormatAvailable('bgra8unorm-srgb', NO_FEATURES).ok).toBe(false)
  })

  test('gpuCapability: true/false/feature', () => {
    expect(gpuCapability(true, NO_FEATURES)).toBe(true)
    expect(gpuCapability(false, ALL_FEATURES)).toBe(false)
    expect(gpuCapability('float32-filterable', { has: f => f === 'float32-filterable' })).toBe(true)
    expect(gpuCapability('float32-filterable', NO_FEATURES)).toBe(false)
  })

  test('gpuBytesPerRow: uncompressed texelBytes·w; compressed by blocks', () => {
    expect(gpuBytesPerRow('rgba8unorm', 64)).toBe(256)
    expect(gpuBytesPerRow('rgba16float', 64)).toBe(512)
    expect(gpuBytesPerRow('r32float', 16)).toBe(64)
    // bc1: 4×4×8-byte blocks → 16 blocks per row × 8 = 128
    expect(gpuBytesPerRow('bc1-rgba-unorm', 64)).toBe(16 * 8)
    // astc-8x8: 8 blocks × 16 bytes
    expect(gpuBytesPerRow('astc-8x8-unorm', 64)).toBe(8 * 16)
  })
})
