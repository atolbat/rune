/**
 * Тесты caps-модуля (M4, DESIGN.md §11.4 + §5.2).
 *
 * Покрываем:
 *  - createCaps(): has/format/path/ext/stats/limit/backend — корректность делегирования
 *  - StatsCollector: beginFrame/endFrame, addDrawCall, addMemory/subMemory
 *  - Probe → Caps конверсия: probeGLCaps + createCaps — интеграция
 *  - Edge cases: неизвестная фича → false, неизвестный формат → 'none'
 */

import { test } from 'bun:test'
import { expect, mock } from 'bun:test'
import { createCaps, createStatsCollector } from '@rune/core'
import type { CapsQuery, StatsProvider } from '@rune/core'
import { probeGLCaps, makeGLProbe } from '@rune/webgl2'
import type { GLProbe } from '@rune/webgl2'
import { probeGPUCaps, makeGPUProbe } from '@rune/webgpu'
import type { GPUProbe } from '@rune/webgpu'

// ─── createCaps: базовый контракт ────────────────────────────────────────────

test('createCaps: has() возвращает true только для фич в query.features', () => {
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

test('createCaps: format() возвращает native/fallback/none из матрицы', () => {
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
  // Неизвестный формат → 'none' (не падает)
  expect(caps.format('unknown-format', 'sampled')).toBe('none')
})

test('createCaps: ext() возвращает raw extension или null', () => {
  const astcExt = { /* mock extension object */ format: 'astc' }
  // Явный <string, unknown>: без него TS выводит Map<string, union-of-объектов>
  // и не подбирает перегрузку конструктора для разнородных значений.
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

test('createCaps: path() возвращает supported/unsupported/unknown', () => {
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
  // Неизвестный путь → 'unknown'
  expect(caps.path('some-future-path')).toBe('unknown')
})

test('createCaps: limit() возвращает число из query.limits', () => {
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

test('createCaps: backend() возвращает строку', () => {
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

test('createCaps: stats() возвращает zero-state если нет statsProvider', () => {
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

test('createCaps: stats() делегирует в statsProvider', () => {
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

test('createCaps: invalidate() сбрасывает statsProvider (caps.stats() возвращает zero)', () => {
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

// ─── StatsCollector: cpuMs и counters ─────────────────────────────────────────

test('StatsCollector: beginFrame/endFrame измеряет cpuMs', () => {
  let t = 1000
  const sc = createStatsCollector(() => t)
  sc.beginFrame()
  t = 1005  // +5ms
  sc.endFrame()
  const s = sc.snapshot()
  expect(s.cpuMs).toBe(5)
  expect(s.frameCount).toBe(1)
})

test('StatsCollector: addDrawCall инкрементит счётчик в текущем кадре', () => {
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
  // subMemory не уходит в минус
  sc.subMemory(99999)
  expect(sc.snapshot().memoryEstimate).toBe(0)
})

test('StatsCollector: beginFrame обнуляет drawCalls но не memory', () => {
  const sc = createStatsCollector()
  sc.beginFrame()
  sc.addDrawCall()
  sc.addMemory(1024)
  sc.endFrame()
  expect(sc.snapshot().drawCalls).toBe(1)
  expect(sc.snapshot().memoryEstimate).toBe(1024)

  // Новый кадр
  sc.beginFrame()
  // drawCalls уже 0 (новый кадр)
  expect(sc.snapshot().drawCalls).toBe(0)
  // memoryEstimate НЕ обнулился (аккумулятор текстур)
  expect(sc.snapshot().memoryEstimate).toBe(1024)
  // frameCount растёт
  expect(sc.snapshot().frameCount).toBe(2)
})

// ─── probeGLCaps: мок GL-контекста ────────────────────────────────────────────

function makeMockGLProbe(extensions: Record<string, unknown>, limits: Record<string, number> = {}): GLProbe {
  // Псевдо-константы WebGL2 — вымышленные значения, для теста
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

test('probeGLCaps: ASTC + ETC2 расширения → features.has()', () => {
  const probe = makeMockGLProbe({
    'WEBGL_compressed_texture_astc': { /* astc ext */ },
    'WEBGL_compressed_texture_etc': { /* etc2 ext */ },
  })
  const query = probeGLCaps(probe)
  expect(query.backend).toBe('webgl2')
  expect(query.features.has('astc')).toBe(true)
  expect(query.features.has('etc2')).toBe(true)
  expect(query.features.has('bc1')).toBe(false)
  expect(query.features.has('instancing')).toBe(true)  // нативно в WebGL2
})

test('probeGLCaps: float-blend требует EXT_color_buffer_float И EXT_float_blend', () => {
  // Без EXT_color_buffer_float — float-blend нет
  let probe = makeMockGLProbe({ 'EXT_float_blend': { /* ext */ } })
  expect(probeGLCaps(probe).features.has('float32-blend')).toBe(false)

  // С обоими — есть
  probe = makeMockGLProbe({
    'EXT_color_buffer_float': { /* ext */ },
    'EXT_float_blend': { /* ext */ },
  })
  const caps = createCaps(probeGLCaps(probe))
  expect(caps.has('float32-blend')).toBe(true)
  expect(caps.has('float16-blend')).toBe(true)
  expect(caps.ext('EXT_float_blend')).toBeDefined()
})

test('probeGLCaps: limits копируются в query.limits', () => {
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

test('probeGLCaps: format matrix — rgba8unorm baseline native (кроме storage)', () => {
  const probe = makeMockGLProbe({})
  const caps = createCaps(probeGLCaps(probe))
  expect(caps.format('rgba8unorm', 'sampled')).toBe('native')
  expect(caps.format('rgba8unorm', 'render')).toBe('native')
  expect(caps.format('rgba8unorm', 'blend')).toBe('native')
  expect(caps.format('rgba8unorm', 'filter')).toBe('native')
  expect(caps.format('rgba8unorm', 'msaa')).toBe('native')
  expect(caps.format('rgba8unorm', 'storage')).toBe('none')
})

test('probeGLCaps: rgba16float render требует EXT_color_buffer_half_float', () => {
  // Без расширения — render=none
  let probe = makeMockGLProbe({})
  let caps = createCaps(probeGLCaps(probe))
  expect(caps.format('rgba16float', 'sampled')).toBe('native')
  expect(caps.format('rgba16float', 'render')).toBe('none')
  expect(caps.format('rgba16float', 'filter')).toBe('none')

  // С EXT_color_buffer_half_float — render=native, filter=native (half_float_linear)
  probe = makeMockGLProbe({
    'EXT_color_buffer_half_float': { /* ext */ },
    'OES_texture_half_float_linear': { /* ext */ },
  })
  caps = createCaps(probeGLCaps(probe))
  expect(caps.format('rgba16float', 'render')).toBe('native')
  expect(caps.format('rgba16float', 'filter')).toBe('native')
})

test('probeGLCaps: path() возвращает supported для baseline paths', () => {
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

test('probeGPUCaps: ASTC + BC через features', () => {
  const probe = makeMockGPUProbe(new Set(['texture-compression-astc', 'texture-compression-bc']), {})
  const query = probeGPUCaps(probe)
  expect(query.backend).toBe('webgpu')
  expect(query.features.has('astc')).toBe(true)
  expect(query.features.has('bc1')).toBe(true)
  expect(query.features.has('bc3')).toBe(true)
  expect(query.features.has('bc7')).toBe(true)
  expect(query.features.has('etc2')).toBe(false)
  // Нативные WebGPU фичи с путями исполнения в движке — всегда есть
  expect(query.features.has('instancing')).toBe(true)
  // Контракт 5 (Task 79, гигиена caps): WebGPU-АПИ умеет compute/storage,
  // но движок НЕ исполняет (нет dispatch / storage-биндингов / drawIndirect)
  // — заявления сняты. GL-проб их тоже не заявляет: паритет восстановлен.
  expect(query.features.has('compute')).toBe(false)
  expect(query.features.has('storage-buffer')).toBe(false)
  expect(query.features.has('storage-texture')).toBe(false)
  expect(query.features.has('draw-indirect')).toBe(false)
})

test('probeGPUCaps: MSAA из maxSampleCount', () => {
  // maxSampleCount=4 → msaa-2x и msaa-4x, но НЕ msaa-8x
  const probe = makeMockGPUProbe(new Set(), { maxSampleCount: 4 })
  const caps = createCaps(probeGPUCaps(probe))
  expect(caps.has('msaa-2x')).toBe(true)
  expect(caps.has('msaa-4x')).toBe(true)
  expect(caps.has('msaa-8x')).toBe(false)
  expect(caps.has('msaa-16x')).toBe(false)
})

test('probeGPUCaps: bgra8-storage через feature', () => {
  let probe = makeMockGPUProbe(new Set(['bgra8unorm-storage']), {})
  let caps = createCaps(probeGPUCaps(probe))
  expect(caps.has('bgra8-storage')).toBe(true)
  expect(caps.format('bgra8unorm', 'storage')).toBe('native')

  probe = makeMockGPUProbe(new Set(), {})
  caps = createCaps(probeGPUCaps(probe))
  expect(caps.has('bgra8-storage')).toBe(false)
  expect(caps.format('bgra8unorm', 'storage')).toBe('none')
})

test('probeGPUCaps: float32-filterable влияет на rgba32float render', () => {
  // Без float32-filterable: rgba32float render=none
  let probe = makeMockGPUProbe(new Set(), {})
  let caps = createCaps(probeGPUCaps(probe))
  expect(caps.format('rgba32float', 'sampled')).toBe('native')
  expect(caps.format('rgba32float', 'render')).toBe('none')

  probe = makeMockGPUProbe(new Set(['float32-filterable']), {})
  caps = createCaps(probeGPUCaps(probe))
  expect(caps.format('rgba32float', 'render')).toBe('native')
  expect(caps.format('rgba32float', 'filter')).toBe('native')
  expect(caps.format('rgba32float', 'msaa')).toBe('none')  // 32float msaa — никогда
})

// ─── probeGPUCaps: anisotropic filtering (Task 51 + device-limits fallback) ──

test('probeGPUCaps: maxAnisotropy=16 → features.has(anisotropic)=true, limits.maxAnisotropy=16', () => {
  const probe = makeMockGPUProbe(new Set(), { maxAnisotropy: 16 })
  const caps = createCaps(probeGPUCaps(probe))
  expect(caps.has('anisotropic')).toBe(true)
  expect(caps.limit('maxAnisotropy')).toBe(16)
})

test('probeGPUCaps: maxAnisotropy=undefined → fallback к 16 (нативный WebGPU)', () => {
  // Браузер не репортит maxAnisotropy ни в adapter.limits, ни в device.limits.
  // WebGPU нативно поддерживает anisotropic filtering — fallback к 16.
  const probe = makeMockGPUProbe(new Set(), {})
  const caps = createCaps(probeGPUCaps(probe))
  expect(caps.has('anisotropic')).toBe(true)
  expect(caps.limit('maxAnisotropy')).toBe(16)
})

test('probeGPUCaps: maxAnisotropy=1 → всё равно true (Task 54: WebGPU baseline)', () => {
  // Task 54: WebGPU spec — maxAnisotropy НЕ входит в GPUSupportedLimits.
  // Если нестандартное расширение браузера возвращает 1, мы всё равно
  // считаем anisotropic доступной, т.к. WebGPU нативно поддерживает её
  // (платформа клампит GPUSamplerDescriptor.maxAnisotropy к своему максимуму).
  // caps.has('anisotropic')=true, limits.maxAnisotropy=16 — детерминированно.
  const probe = makeMockGPUProbe(new Set(), { maxAnisotropy: 1 })
  const caps = createCaps(probeGPUCaps(probe))
  expect(caps.has('anisotropic')).toBe(true)
  expect(caps.limit('maxAnisotropy')).toBe(16) // переопределено на 16 (нативный WebGPU max)
})

test('makeGPUProbe: adapter.limits.maxAnisotropy=undefined, device.limits.maxAnisotropy=16 → fallback к device', () => {
  // Симулируем браузер, где adapter.limits НЕ содержит maxAnisotropy,
  // но device.limits (после requestDevice()) — да. Это реальный кейс
  // на Chromium < 130 и Safari < 18.
  const adapter = {
    features: new Set<string>(),
    limits: { /* adapter.limits БЕЗ maxAnisotropy */ } as unknown as Record<string, number>,
    info: { vendor: 'MockVendor', architecture: 'MockArch', description: 'Mock' },
  } as unknown as GPUAdapter
  const device = {
    limits: { maxAnisotropy: 16 } as unknown as Record<string, number>,
  } as unknown as GPUDevice

  const probe = makeGPUProbe(adapter, 'bgra8unorm', device)
  expect(probe.getLimit('maxAnisotropy')).toBe(16) // fallback к device.limits
  expect(probe.getLimit('maxBindGroups')).toBeUndefined() // нет ни в adapter, ни в device
})

test('makeGPUProbe: adapter.limits.maxAnisotropy=8 → возвращает adapter значение (device не нужен)', () => {
  const adapter = {
    features: new Set<string>(),
    limits: { maxAnisotropy: 8 } as unknown as Record<string, number>,
    info: { vendor: 'MockVendor', architecture: 'MockArch', description: 'Mock' },
  } as unknown as GPUAdapter

  const probe = makeGPUProbe(adapter, 'bgra8unorm', null)
  expect(probe.getLimit('maxAnisotropy')).toBe(8)
})

test('makeGPUProbe: без device (recording-фасад) — только adapter.limits', () => {
  const adapter = {
    features: new Set<string>(),
    limits: { maxAnisotropy: 4 } as unknown as Record<string, number>,
    info: { vendor: 'MockVendor', architecture: 'MockArch', description: 'Mock' },
  } as unknown as GPUAdapter

  // device не передан (как в recording-фасаде)
  const probe = makeGPUProbe(adapter, 'bgra8unorm')
  expect(probe.getLimit('maxAnisotropy')).toBe(4)
})

test('Integration: probeGPUCaps + makeGPUProbe с device fallback → caps.has(anisotropic)=true', () => {
  // Сценарий из реального браузера: adapter.limits НЕ содержит maxAnisotropy,
  // но device.limits содержит. probe.getLimit() fallback к device.
  const adapter = {
    features: new Set<string>(),
    limits: {} as unknown as Record<string, number>, // пустые adapter.limits
    info: { vendor: 'MockVendor', architecture: 'MockArch', description: 'Mock' },
  } as unknown as GPUAdapter
  const device = {
    limits: { maxAnisotropy: 16 } as unknown as Record<string, number>,
  } as unknown as GPUDevice

  const probe = makeGPUProbe(adapter, 'bgra8unorm', device)
  const caps = createCaps(probeGPUCaps(probe))
  expect(caps.has('anisotropic')).toBe(true) // было false до фикса Task 51+
  expect(caps.limit('maxAnisotropy')).toBe(16)
})

// ─── uploadMip (recordingGL): проверка записи ────────────────────────────────

import { createRecordingGL } from '@rune/webgl2'

test('uploadMip (recordingGL): запись вызова texImage2DLevel с level и flipY', () => {
  const rec = createRecordingGL()
  // Source — HTMLCanvasElement (наиболее универсальный)
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

test('uploadMip (recordingGL): flipY по умолчанию false', () => {
  const rec = createRecordingGL()
  const c = { width: 2, height: 2 } as unknown as HTMLCanvasElement
  rec.gl.texImage2DLevel(1, 0, c)
  expect(rec.calls[0]).toContain('flipY=false')
})

test('uploadMip (recordingGL): flipY=false явно', () => {
  const rec = createRecordingGL()
  const c = { width: 2, height: 2 } as unknown as HTMLCanvasElement
  rec.gl.texImage2DLevel(3, 1, c, { flipY: false })
  expect(rec.calls[0]).toContain('flipY=false')
})

// ─── Интеграция: probeGLCaps → createCaps → renderer-подобный usage ──────────

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

  // Проверка типичного workflow
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
  expect(s.gpuMs).toBeNull() // timer-query подключается отдельно
})
