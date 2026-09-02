/**
 * Tests for the caps module (M4, DESIGN.md §11.4 + §5.2).
 *
 * Covered:
 *  - createCaps(): has/format/path/ext/stats/limit/backend — delegation correctness
 *  - StatsCollector: beginFrame/endFrame, addDrawCall, addMemory/subMemory
 *  - Probe → Caps conversion: probeGLCaps + createCaps — integration
 *  - Edge cases: unknown feature → false, unknown format → 'none'
 */

import { test } from 'bun:test'
import { expect, mock } from 'bun:test'
import { createCaps, createStatsCollector } from '@rune/core'
import type { CapsQuery, StatsProvider } from '@rune/core'
import { probeGLCaps, makeGLProbe } from '@rune/webgl2'
import type { GLProbe } from '@rune/webgl2'
import { probeGPUCaps, makeGPUProbe } from '@rune/webgpu'
import type { GPUProbe } from '@rune/webgpu'

// ─── createCaps: basic contract ────────────────────────────────────────────

test('createCaps: has() returns true only for features in query.features', () => {
  const query: CapsQuery = {
    features: new Set(['astc', 'etc2', 'instancing']),
    formatMatrix: new Map(),
    paths: new Map(),
    extensions: new Map(),
    limits: {},
    backend: 'webgl2',
  }
  const caps = createCaps(query)
  expect(caps.has('astc')).toBe(true)
  expect(caps.has('etc2')).toBe(true)
  expect(caps.has('instancing')).toBe(true)
  expect(caps.has('bc1')).toBe(false)
  expect(caps.has('timestamp-query')).toBe(false)
})

test('createCaps: format() returns native/fallback/none from the matrix', () => {
  const formatMatrix = new Map([
    ['rgba8unorm|sampled', 'native' as const],
    ['rgba8unorm|render', 'native' as const],
    ['rgba8unorm|storage', 'none' as const],
    ['rgba16float|sampled', 'native' as const],
    ['rgba16float|render', 'fallback' as const],
  ])
  const query: CapsQuery = {
    features: new Set(),
    formatMatrix,
    paths: new Map(),
    extensions: new Map(),
    limits: {},
    backend: 'webgl2',
  }
  const caps = createCaps(query)
  expect(caps.format('rgba8unorm', 'sampled')).toBe('native')
  expect(caps.format('rgba8unorm', 'storage')).toBe('none')
  expect(caps.format('rgba16float', 'render')).toBe('fallback')
  // Unknown format → 'none' (no crash)
  expect(caps.format('unknown-format', 'sampled')).toBe('none')
})

test('createCaps: ext() returns the raw extension or null', () => {
  const astcExt = { /* mock extension object */ format: 'astc' }
  // Explicit <string, unknown>: without it TS infers Map<string, union-of-objects>
  // and cannot pick a constructor overload for heterogeneous values.
  const extensions = new Map<string, unknown>([
    ['WEBGL_compressed_texture_astc', astcExt],
    ['EXT_texture_filter_anisotropic', { maxAnisotropy: 16 }],
  ])
  const query: CapsQuery = {
    features: new Set(),
    formatMatrix: new Map(),
    paths: new Map(),
    extensions,
    limits: {},
    backend: 'webgl2',
  }
  const caps = createCaps(query)
  expect(caps.ext('WEBGL_compressed_texture_astc')).toBe(astcExt)
  expect(caps.ext('EXT_texture_filter_anisotropic')).toEqual({ maxAnisotropy: 16 })
  expect(caps.ext('NONEXISTENT_EXT')).toBeNull()
})

test('createCaps: path() returns supported/unsupported/unknown', () => {
  const paths = new Map([
    ['canvas-direct', 'supported' as const],
    ['asyncbmp', 'unsupported' as const],
  ])
  const query: CapsQuery = {
    features: new Set(),
    formatMatrix: new Map(),
    paths,
    extensions: new Map(),
    limits: {},
    backend: 'webgpu',
  }
  const caps = createCaps(query)
  expect(caps.path('canvas-direct')).toBe('supported')
  expect(caps.path('asyncbmp')).toBe('unsupported')
  // Unknown path → 'unknown'
  expect(caps.path('some-future-path')).toBe('unknown')
})

test('createCaps: limit() returns the number from query.limits', () => {
  const query: CapsQuery = {
    features: new Set(),
    formatMatrix: new Map(),
    paths: new Map(),
    extensions: new Map(),
    limits: { maxTextureSize2D: 8192, maxTextureArrayLayers: 256 },
    backend: 'webgl2',
  }
  const caps = createCaps(query)
  expect(caps.limit('maxTextureSize2D')).toBe(8192)
  expect(caps.limit('maxTextureArrayLayers')).toBe(256)
  expect(caps.limit('maxUnknown')).toBeNull()
})

test('createCaps: backend() returns the string', () => {
  const query: CapsQuery = {
    features: new Set(),
    formatMatrix: new Map(),
    paths: new Map(),
    extensions: new Map(),
    limits: {},
    backend: 'webgpu',
  }
  const caps = createCaps(query)
  expect(caps.backend).toBe('webgpu')
})

test('createCaps: stats() returns the zero state when there is no statsProvider', () => {
  const query: CapsQuery = {
    features: new Set(),
    formatMatrix: new Map(),
    paths: new Map(),
    extensions: new Map(),
    limits: {},
    backend: 'webgl2',
  }
  const caps = createCaps(query, null)
  const s = caps.stats()
  expect(s.cpuMs).toBe(0)
  expect(s.gpuMs).toBeNull()
  expect(s.memoryEstimate).toBe(0)
  expect(s.drawCalls).toBe(0)
  expect(s.hitRate).toBe(1.0)
})

test('createCaps: stats() delegates to statsProvider', () => {
  const stats: ReturnType<StatsProvider> = {
    cpuMs: 5.2,
    gpuMs: 3.1,
    memoryEstimate: 1024 * 1024,
    drawCalls: 12,
    frameCount: 100,
    hitRate: 0.85,
  }
  const provider: StatsProvider = () => stats
  const query: CapsQuery = {
    features: new Set(),
    formatMatrix: new Map(),
    paths: new Map(),
    extensions: new Map(),
    limits: {},
    backend: 'webgl2',
  }
  const caps = createCaps(query, provider)
  const s = caps.stats()
  expect(s.cpuMs).toBe(5.2)
  expect(s.gpuMs).toBe(3.1)
  expect(s.drawCalls).toBe(12)
  expect(s.hitRate).toBe(0.85)
})

test('createCaps: invalidate() resets statsProvider (caps.stats() returns zero)', () => {
  const provider: StatsProvider = () => ({
    cpuMs: 7.7,
    gpuMs: null,
    memoryEstimate: 0,
    drawCalls: 3,
    frameCount: 5,
    hitRate: 1.0,
  })
  const query: CapsQuery = {
    features: new Set(),
    formatMatrix: new Map(),
    paths: new Map(),
    extensions: new Map(),
    limits: {},
    backend: 'webgl2',
  }
  const caps = createCaps(query, provider)
  expect(caps.stats().cpuMs).toBe(7.7)
  caps.invalidate()
  expect(caps.stats().cpuMs).toBe(0)
})

// ─── StatsCollector: cpuMs and counters ─────────────────────────────────────────

test('StatsCollector: beginFrame/endFrame measures cpuMs', () => {
  let t = 1000
  const sc = createStatsCollector(() => t)
  sc.beginFrame()
  t = 1005  // +5ms
  sc.endFrame()
  const s = sc.snapshot()
  expect(s.cpuMs).toBe(5)
  expect(s.frameCount).toBe(1)
})

test('StatsCollector: addDrawCall increments the counter in the current frame', () => {
  const sc = createStatsCollector()
  sc.beginFrame()
  sc.addDrawCall()
  sc.addDrawCall()
  sc.addDrawCall()
  sc.endFrame()
  expect(sc.snapshot().drawCalls).toBe(3)
})

test('StatsCollector: addMemory/subMemory — text bytes', () => {
  const sc = createStatsCollector()
  sc.addMemory(1024)
  sc.addMemory(2048)
  expect(sc.snapshot().memoryEstimate).toBe(3072)
  sc.subMemory(1024)
  expect(sc.snapshot().memoryEstimate).toBe(2048)
  // subMemory does not go negative
  sc.subMemory(99999)
  expect(sc.snapshot().memoryEstimate).toBe(0)
})

test('StatsCollector: beginFrame zeroes drawCalls but not memory', () => {
  const sc = createStatsCollector()
  sc.beginFrame()
  sc.addDrawCall()
  sc.addMemory(1024)
  sc.endFrame()
  expect(sc.snapshot().drawCalls).toBe(1)
  expect(sc.snapshot().memoryEstimate).toBe(1024)

  // New frame
  sc.beginFrame()
  // drawCalls is already 0 (new frame)
  expect(sc.snapshot().drawCalls).toBe(0)
  // memoryEstimate was NOT zeroed (texture accumulator)
  expect(sc.snapshot().memoryEstimate).toBe(1024)
  // frameCount grows
  expect(sc.snapshot().frameCount).toBe(2)
})

// ─── probeGLCaps: GL context mock ────────────────────────────────────────────

function makeMockGLProbe(extensions: Record<string, unknown>, limits: Record<string, number> = {}): GLProbe {
  // Pseudo WebGL2 constants — made-up values, for the test
  const C = {
    MAX_TEXTURE_SIZE: 0x0D33,
    MAX_3D_TEXTURE_SIZE: 0x8073,
    MAX_ARRAY_TEXTURE_LAYERS: 0x88FF,
    MAX_CUBE_MAP_TEXTURE_SIZE: 0x851C,
    MAX_RENDERBUFFER_SIZE: 0x84E8,
    MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8B4C,
    MAX_TEXTURE_IMAGE_UNITS: 0x8872,
    MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8B4D,
    MAX_VERTEX_ATTRIBS: 0x8869,
    MAX_VERTEX_UNIFORM_VECTORS: 0x8DFB,
    MAX_FRAGMENT_UNIFORM_VECTORS: 0x8DFD,
    MAX_VARYING_VECTORS: 0x8DFC,
    MAX_DRAW_BUFFERS: 0x8824,
    MAX_VIEWPORT_DIMS: 0x0D3A,
    MAX_ELEMENTS_VERTICES: 0x80E8,
    MAX_ELEMENTS_INDICES: 0x80E9,
  }
  const paramMap: Record<number, number | Int32Array> = {
    [C.MAX_TEXTURE_SIZE]: limits.maxTextureSize2D ?? 8192,
    [C.MAX_3D_TEXTURE_SIZE]: limits.maxTextureSize3D ?? 2048,
    [C.MAX_ARRAY_TEXTURE_LAYERS]: limits.maxTextureArrayLayers ?? 256,
    [C.MAX_CUBE_MAP_TEXTURE_SIZE]: limits.maxCubeMapSize ?? 8192,
    [C.MAX_RENDERBUFFER_SIZE]: limits.maxRenderbufferSize ?? 8192,
    [C.MAX_VERTEX_TEXTURE_IMAGE_UNITS]: limits.maxVertexTextureUnits ?? 16,
    [C.MAX_TEXTURE_IMAGE_UNITS]: limits.maxFragmentTextureUnits ?? 16,
    [C.MAX_COMBINED_TEXTURE_IMAGE_UNITS]: limits.maxCombinedTextureUnits ?? 32,
    [C.MAX_VERTEX_ATTRIBS]: limits.maxVertexAttributes ?? 16,
    [C.MAX_VERTEX_UNIFORM_VECTORS]: limits.maxVertexUniformVectors ?? 256,
    [C.MAX_FRAGMENT_UNIFORM_VECTORS]: limits.maxFragmentUniformVectors ?? 256,
    [C.MAX_VARYING_VECTORS]: limits.maxVaryingVectors ?? 16,
    [C.MAX_DRAW_BUFFERS]: limits.maxDrawBuffers ?? 4,
    [C.MAX_VIEWPORT_DIMS]: new Int32Array([limits.maxViewportWidth ?? 8192, limits.maxViewportHeight ?? 8192]),
    [C.MAX_ELEMENTS_VERTICES]: limits.maxElementsVertices ?? 65536,
    [C.MAX_ELEMENTS_INDICES]: limits.maxElementsIndices ?? 65536,
  }
  return {
    getExtension: (name: string) => extensions[name] ?? null,
    getParameter: (pname: number) => paramMap[pname] ?? 0,
    getString: () => '',
    hasTimerQuery: () => extensions['EXT_disjoint_timer_query_webgl2'] !== undefined,
    hasFloatLinear: () => extensions['OES_texture_float_linear'] !== undefined,
    ...C,
  }
}

test('probeGLCaps: ASTC + ETC2 extensions → features.has()', () => {
  const probe = makeMockGLProbe({
    'WEBGL_compressed_texture_astc': { /* astc ext */ },
    'WEBGL_compressed_texture_etc': { /* etc2 ext */ },
  })
  const query = probeGLCaps(probe)
  expect(query.backend).toBe('webgl2')
  expect(query.features.has('astc')).toBe(true)
  expect(query.features.has('etc2')).toBe(true)
  expect(query.features.has('bc1')).toBe(false)
  expect(query.features.has('instancing')).toBe(true)  // native in WebGL2
})

test('probeGLCaps: float-blend requires EXT_color_buffer_float AND EXT_float_blend', () => {
  // Without EXT_color_buffer_float — no float-blend
  let probe = makeMockGLProbe({ 'EXT_float_blend': { /* ext */ } })
  expect(probeGLCaps(probe).features.has('float32-blend')).toBe(false)

  // With both — present
  probe = makeMockGLProbe({
    'EXT_color_buffer_float': { /* ext */ },
    'EXT_float_blend': { /* ext */ },
  })
  const caps = createCaps(probeGLCaps(probe))
  expect(caps.has('float32-blend')).toBe(true)
  expect(caps.has('float16-blend')).toBe(true)
  expect(caps.ext('EXT_float_blend')).toBeDefined()
})

test('probeGLCaps: limits are copied into query.limits', () => {
  const probe = makeMockGLProbe({}, {
    maxTextureSize2D: 8192,
    maxTextureSize3D: 2048,
    maxTextureArrayLayers: 256,
    maxVertexAttributes: 32,
    maxDrawBuffers: 8,
    maxViewportWidth: 16384,
    maxViewportHeight: 16384,
  })
  const caps = createCaps(probeGLCaps(probe))
  expect(caps.limit('maxTextureSize2D')).toBe(8192)
  expect(caps.limit('maxTextureSize3D')).toBe(2048)
  expect(caps.limit('maxTextureArrayLayers')).toBe(256)
  expect(caps.limit('maxVertexAttributes')).toBe(32)
  expect(caps.limit('maxDrawBuffers')).toBe(8)
  expect(caps.limit('maxViewportWidth')).toBe(16384)
  expect(caps.limit('maxViewportHeight')).toBe(16384)
})

test('probeGLCaps: format matrix — rgba8unorm baseline native (except storage)', () => {
  const probe = makeMockGLProbe({})
  const caps = createCaps(probeGLCaps(probe))
  expect(caps.format('rgba8unorm', 'sampled')).toBe('native')
  expect(caps.format('rgba8unorm', 'render')).toBe('native')
  expect(caps.format('rgba8unorm', 'blend')).toBe('native')
  expect(caps.format('rgba8unorm', 'filter')).toBe('native')
  expect(caps.format('rgba8unorm', 'msaa')).toBe('native')
  expect(caps.format('rgba8unorm', 'storage')).toBe('none')
})

test('probeGLCaps: rgba16float render requires EXT_color_buffer_half_float', () => {
  // Without the extension — render=none
  let probe = makeMockGLProbe({})
  let caps = createCaps(probeGLCaps(probe))
  expect(caps.format('rgba16float', 'sampled')).toBe('native')
  expect(caps.format('rgba16float', 'render')).toBe('none')
  expect(caps.format('rgba16float', 'filter')).toBe('none')

  // With EXT_color_buffer_half_float — render=native, filter=native (half_float_linear)
  probe = makeMockGLProbe({
    'EXT_color_buffer_half_float': { /* ext */ },
    'OES_texture_half_float_linear': { /* ext */ },
  })
  caps = createCaps(probeGLCaps(probe))
  expect(caps.format('rgba16float', 'render')).toBe('native')
  expect(caps.format('rgba16float', 'filter')).toBe('native')
})

test('probeGLCaps: path() returns supported for baseline paths', () => {
  const probe = makeMockGLProbe({})
  const caps = createCaps(probeGLCaps(probe))
  expect(caps.path('canvas-direct')).toBe('supported')
  expect(caps.path('preserve')).toBe('supported')
  expect(caps.path('blit')).toBe('supported')
})

// ─── probeGPUCaps: mock GPU adapter ───────────────────────────────────────────

function makeMockGPUProbe(features: Set<string>, limits: Record<string, number>): GPUProbe {
  return {
    hasFeature: (name) => features.has(name),
    getLimit: (name) => limits[name],
    info: { vendor: 'MockVendor', architecture: 'MockArch', description: 'Mock' },
    preferredFormat: 'bgra8unorm',
  }
}

test('probeGPUCaps: ASTC + BC via features', () => {
  const probe = makeMockGPUProbe(new Set(['texture-compression-astc', 'texture-compression-bc']), {})
  const query = probeGPUCaps(probe)
  expect(query.backend).toBe('webgpu')
  expect(query.features.has('astc')).toBe(true)
  expect(query.features.has('bc1')).toBe(true)
  expect(query.features.has('bc3')).toBe(true)
  expect(query.features.has('bc7')).toBe(true)
  expect(query.features.has('etc2')).toBe(false)
  // Native WebGPU features with execution paths in the engine — always present
  expect(query.features.has('instancing')).toBe(true)
  // Contract 5 (Task 79, caps hygiene): the WebGPU API can do compute/storage,
  // but the engine does NOT execute them (no dispatch / storage bindings /
  // drawIndirect) — the claims were dropped. The GL probe doesn't claim them
  // either: parity restored.
  expect(query.features.has('compute')).toBe(false)
  expect(query.features.has('storage-buffer')).toBe(false)
  expect(query.features.has('storage-texture')).toBe(false)
  expect(query.features.has('draw-indirect')).toBe(false)
})

test('probeGPUCaps: MSAA from maxSampleCount', () => {
  // maxSampleCount=4 → msaa-2x and msaa-4x, but NOT msaa-8x
  const probe = makeMockGPUProbe(new Set(), { maxSampleCount: 4 })
  const caps = createCaps(probeGPUCaps(probe))
  expect(caps.has('msaa-2x')).toBe(true)
  expect(caps.has('msaa-4x')).toBe(true)
  expect(caps.has('msaa-8x')).toBe(false)
  expect(caps.has('msaa-16x')).toBe(false)
})

test('probeGPUCaps: bgra8-storage via feature', () => {
  let probe = makeMockGPUProbe(new Set(['bgra8unorm-storage']), {})
  let caps = createCaps(probeGPUCaps(probe))
  expect(caps.has('bgra8-storage')).toBe(true)
  expect(caps.format('bgra8unorm', 'storage')).toBe('native')

  probe = makeMockGPUProbe(new Set(), {})
  caps = createCaps(probeGPUCaps(probe))
  expect(caps.has('bgra8-storage')).toBe(false)
  expect(caps.format('bgra8unorm', 'storage')).toBe('none')
})

test('probeGPUCaps: float32-filterable affects rgba32float render', () => {
  // Without float32-filterable: rgba32float render=none
  let probe = makeMockGPUProbe(new Set(), {})
  let caps = createCaps(probeGPUCaps(probe))
  expect(caps.format('rgba32float', 'sampled')).toBe('native')
  expect(caps.format('rgba32float', 'render')).toBe('none')

  probe = makeMockGPUProbe(new Set(['float32-filterable']), {})
  caps = createCaps(probeGPUCaps(probe))
  expect(caps.format('rgba32float', 'render')).toBe('native')
  expect(caps.format('rgba32float', 'filter')).toBe('native')
  expect(caps.format('rgba32float', 'msaa')).toBe('none')  // 32float msaa — never
})

// ─── probeGPUCaps: anisotropic filtering (Task 51 + device-limits fallback) ──

test('probeGPUCaps: maxAnisotropy=16 → features.has(anisotropic)=true, limits.maxAnisotropy=16', () => {
  const probe = makeMockGPUProbe(new Set(), { maxAnisotropy: 16 })
  const caps = createCaps(probeGPUCaps(probe))
  expect(caps.has('anisotropic')).toBe(true)
  expect(caps.limit('maxAnisotropy')).toBe(16)
})

test('probeGPUCaps: maxAnisotropy=undefined → fallback to 16 (native WebGPU)', () => {
  // The browser does not report maxAnisotropy in adapter.limits or device.limits.
  // WebGPU natively supports anisotropic filtering — fallback to 16.
  const probe = makeMockGPUProbe(new Set(), {})
  const caps = createCaps(probeGPUCaps(probe))
  expect(caps.has('anisotropic')).toBe(true)
  expect(caps.limit('maxAnisotropy')).toBe(16)
})

test('probeGPUCaps: maxAnisotropy=1 → still true (Task 54: WebGPU baseline)', () => {
  // Task 54: WebGPU spec — maxAnisotropy is NOT part of GPUSupportedLimits.
  // If a nonstandard browser extension returns 1, we still consider
  // anisotropic available, since WebGPU natively supports it
  // (the platform clamps GPUSamplerDescriptor.maxAnisotropy to its maximum).
  // caps.has('anisotropic')=true, limits.maxAnisotropy=16 — deterministic.
  const probe = makeMockGPUProbe(new Set(), { maxAnisotropy: 1 })
  const caps = createCaps(probeGPUCaps(probe))
  expect(caps.has('anisotropic')).toBe(true)
  expect(caps.limit('maxAnisotropy')).toBe(16) // overridden to 16 (native WebGPU max)
})

test('makeGPUProbe: adapter.limits.maxAnisotropy=undefined, device.limits.maxAnisotropy=16 → fallback to device', () => {
  // Simulate a browser where adapter.limits does NOT contain maxAnisotropy,
  // but device.limits (after requestDevice()) does. This is a real case
  // on Chromium < 130 and Safari < 18.
  const adapter = {
    features: new Set<string>(),
    limits: { /* adapter.limits WITHOUT maxAnisotropy */ } as unknown as Record<string, number>,
    info: { vendor: 'MockVendor', architecture: 'MockArch', description: 'Mock' },
  } as unknown as GPUAdapter
  const device = {
    limits: { maxAnisotropy: 16 } as unknown as Record<string, number>,
  } as unknown as GPUDevice

  const probe = makeGPUProbe(adapter, 'bgra8unorm', device)
  expect(probe.getLimit('maxAnisotropy')).toBe(16) // fallback to device.limits
  expect(probe.getLimit('maxBindGroups')).toBeUndefined() // not in adapter, not in device
})

test('makeGPUProbe: adapter.limits.maxAnisotropy=8 → returns the adapter value (device not needed)', () => {
  const adapter = {
    features: new Set<string>(),
    limits: { maxAnisotropy: 8 } as unknown as Record<string, number>,
    info: { vendor: 'MockVendor', architecture: 'MockArch', description: 'Mock' },
  } as unknown as GPUAdapter

  const probe = makeGPUProbe(adapter, 'bgra8unorm', null)
  expect(probe.getLimit('maxAnisotropy')).toBe(8)
})

test('makeGPUProbe: without device (recording facade) — adapter.limits only', () => {
  const adapter = {
    features: new Set<string>(),
    limits: { maxAnisotropy: 4 } as unknown as Record<string, number>,
    info: { vendor: 'MockVendor', architecture: 'MockArch', description: 'Mock' },
  } as unknown as GPUAdapter

  // device not passed (as in the recording facade)
  const probe = makeGPUProbe(adapter, 'bgra8unorm')
  expect(probe.getLimit('maxAnisotropy')).toBe(4)
})

test('Integration: probeGPUCaps + makeGPUProbe with device fallback → caps.has(anisotropic)=true', () => {
  // A real-browser scenario: adapter.limits does NOT contain maxAnisotropy,
  // but device.limits does. probe.getLimit() falls back to device.
  const adapter = {
    features: new Set<string>(),
    limits: {} as unknown as Record<string, number>, // empty adapter.limits
    info: { vendor: 'MockVendor', architecture: 'MockArch', description: 'Mock' },
  } as unknown as GPUAdapter
  const device = {
    limits: { maxAnisotropy: 16 } as unknown as Record<string, number>,
  } as unknown as GPUDevice

  const probe = makeGPUProbe(adapter, 'bgra8unorm', device)
  const caps = createCaps(probeGPUCaps(probe))
  expect(caps.has('anisotropic')).toBe(true) // was false before the Task 51+ fix
  expect(caps.limit('maxAnisotropy')).toBe(16)
})

// ─── uploadMip (recordingGL): write verification ────────────────────────────────

import { createRecordingGL } from '@rune/webgl2'

test('uploadMip (recordingGL): records the texImage2DLevel call with level and flipY', () => {
  const rec = createRecordingGL()
  // Source — HTMLCanvasElement (the most universal)
  const c = (typeof document !== 'undefined')
    ? document.createElement('canvas')
    : { width: 4, height: 4 } as unknown as HTMLCanvasElement
  ;(c as HTMLCanvasElement).width = 4
  ;(c as HTMLCanvasElement).height = 4

  rec.gl.texImage2DLevel(7, 2, c as never, { flipY: true })
  expect(rec.calls[0]).toContain('texImage2DLevel(7')
  expect(rec.calls[0]).toContain('level=2')
  expect(rec.calls[0]).toContain('flipY=true')
})

test('uploadMip (recordingGL): flipY defaults to false', () => {
  const rec = createRecordingGL()
  const c = { width: 2, height: 2 } as unknown as HTMLCanvasElement
  rec.gl.texImage2DLevel(1, 0, c)
  expect(rec.calls[0]).toContain('flipY=false')
})

test('uploadMip (recordingGL): flipY=false explicitly', () => {
  const rec = createRecordingGL()
  const c = { width: 2, height: 2 } as unknown as HTMLCanvasElement
  rec.gl.texImage2DLevel(3, 1, c, { flipY: false })
  expect(rec.calls[0]).toContain('flipY=false')
})

// ─── Integration: probeGLCaps → createCaps → renderer-like usage ──────────

test('Integration: mock GL probe → caps → full workflow', () => {
  const probe = makeMockGLProbe({
    'WEBGL_compressed_texture_astc': { format: 37808 },
    'EXT_texture_filter_anisotropic': { maxAnisotropy: 16 },
    'OES_texture_float_linear': { /* ext */ },
    'EXT_color_buffer_float': { /* ext */ },
    'EXT_float_blend': { /* ext */ },
  }, {
    maxTextureSize2D: 8192,
    maxVertexAttributes: 32,
    maxViewportWidth: 16384,
    maxViewportHeight: 16384,
  })

  const sc = createStatsCollector()
  sc.beginFrame()
  sc.addDrawCall()
  sc.addDrawCall()
  sc.addMemory(1024)
  sc.endFrame()

  const caps = createCaps(probeGLCaps(probe), () => sc.snapshot())

  // Check the typical workflow
  expect(caps.backend).toBe('webgl2')
  expect(caps.has('astc')).toBe(true)
  expect(caps.has('anisotropic')).toBe(true)
  expect(caps.has('float32-blend')).toBe(true)
  expect(caps.limit('maxTextureSize2D')).toBe(8192)
  expect(caps.ext('WEBGL_compressed_texture_astc')).toEqual({ format: 37808 })

  // RendererStats
  const s = caps.stats()
  expect(s.drawCalls).toBe(2)
  expect(s.memoryEstimate).toBe(1024)
  expect(s.frameCount).toBe(1)
  expect(s.cpuMs).toBeGreaterThan(-1) // 0+ (depends on mock now())
  expect(s.gpuMs).toBeNull() // timer-query is wired up separately
})
