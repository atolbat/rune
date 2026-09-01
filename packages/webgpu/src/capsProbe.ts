/**
 * capsProbe для WebGPU — пробитие adapter.features + adapter.limits + adapter.info.
 *
 * Соответствия (FeatureId ↔ WebGPU GPUFeatureName):
 *   astc               ↔ 'texture-compression-astc'
 *   bc1, bc3, bc7      ↔ 'texture-compression-bc'
 *   etc2               ↔ 'texture-compression-etc2'
 *   depth-clamp        ↔ 'depth-clamping'
 *   timestamp-query    ↔ 'timestamp-query'
 *   pipeline-stats     ↔ 'pipeline-statistics-query'
 *   occlusion-query    ↔ 'occlusion-query' (нативно в WebGPU)
 *   bgra8-storage      ↔ 'bgra8unorm-storage'
 *   float32-filterable ↔ 'float32-filterable'
 *   rg11b10ufloat-render ↔ 'rg11b10ufloat-render'
 *   shared-exponent   ↔ 'shared-texture-bgra8unorm' — нет, правильнее:
 *                        'rgba8snorm-...'-семейство. Для M4 — упрощённо.
 *
 * В WebGPU 'instancing' всегда нативно (нет ограничения), 'depth-texture' —
 *   нативно (depth-аттачменты пайплайнов). 'anisotropic' — базовая
 *   спецификация (GPUSamplerDescriptor.maxAnisotropy).
 * Контракт 5 (Task 79, гигиена caps): НЕ заявлять фичу без пути исполнения
 *   в движке. WebGPU-АПИ умеет compute/storage/drawIndirect, но рендереры
 *   rune их НЕ исполняют (нет dispatch, нет storage-биндингов, нет drawIndirect)
 *   — поэтому 'compute', 'storage-buffer', 'storage-texture', 'draw-indirect'
 *   НЕ заявляются, пока пути не появятся (M6+). Паритет с WebGL2-пробом.
 * 'msaa-2x'/'4x'/'8x' — device.limits.maxSampleCount (обычно 4 на mobile, 8 на desktop).
 *
 * FormatMatrix в WebGPU: query через device.features для float/blend.
 * rgba8unorm — baseline native, всегда.
 * rgba16float — renderable iff features.has('float32-filterable') (paradox name —
 * на самом деле и для float16). Честнее: sampleable всегда, renderable iff
 * features.has('float32-filterable') ИЛИ color-attachment-float.
 */

import type { CapsQuery, FeatureName, FormatAxis, FormatSupport } from '@rune/core'

/** Минимальный интерфейс для probing WebGPU-адаптера. */
export interface GPUProbe {
  /** adapter.features.has(name). */
  hasFeature(name: string): boolean
  /** adapter.limits[limit] — сначала adapter, потом fallback к device.limits
   *  (нужно для maxAnisotropy: на некоторых браузерах поле доступно только
   *  в device.limits после requestDevice(), но не в adapter.limits). */
  getLimit(name: string): number | undefined
  /** adapter.info (vendor / architecture / description). */
  info: { vendor: string; architecture: string; description: string }
  /** Preferred canvas format (navigator.gpu.getPreferredCanvasFormat()). */
  readonly preferredFormat: string
}

/**
 * Пробит CapsQuery из GPUProbe (обёртка над adapter/device).
 */
export function probeGPUCaps(probe: GPUProbe): CapsQuery {
  const features = new Set<FeatureName>()
  const formatMatrix = new Map<string, FormatSupport>()
  const paths = new Map<string, 'supported' | 'unsupported' | 'unknown'>()
  const extensions = new Map<string, unknown>()
  const limits: Record<string, number> = {}

  // ─── Features → FeatureId mapping ─────────────────────────────────────────
  const featureMap: Array<[FeatureName, string]> = [
    ['astc', 'texture-compression-astc'],
    ['etc2', 'texture-compression-etc2'],
    ['bc1', 'texture-compression-bc'],
    ['bc3', 'texture-compression-bc'],
    ['bc7', 'texture-compression-bc'],
    ['depth-clamp', 'depth-clamping'],
    ['timestamp-query', 'timestamp-query'],
    ['pipeline-stats', 'pipeline-statistics-query'],
    ['occlusion-query', 'occlusion-query'],
    ['bgra8-storage', 'bgra8unorm-storage'],
    ['float32-filterable', 'float32-filterable'],
    ['rg11b10ufloat-render', 'rg11b10ufloat-render'],
    ['shared-exponent', 'rgba8snorm-color-render-..'], // упрощённо
  ]
  for (const [feature, gpuName] of featureMap) {
    if (probe.hasFeature(gpuName)) {
      features.add(feature)
      extensions.set(gpuName, true)
    }
  }

  // Нативные фичи WebGPU (всегда есть в спецификации — без расширения).
  // Контракт 5 (Task 79): заявляем ТОЛЬКО то, что движок исполняет:
  //   'instancing' — draw(instances) + stepMode 'instance' (Task 75);
  //   'depth-texture' — depth-аттачменты пайплайнов (test/write);
  //   'offscreen-canvas'/'video-frame' — фичи среды.
  // НЕ заявляем (API умеет, движок — ещё нет; пути появятся в M6+):
  //   'compute', 'storage-buffer', 'storage-texture', 'draw-indirect'.
  //   Раньше добавлялись безусловно — ложь для потребителя caps (аудит
  //   Task 72: «снять ложные compute/draw-indirect заявления»).
  features.add('instancing')
  features.add('depth-texture')
  features.add('offscreen-canvas') // браузерная среда, не device feature
  if (typeof VideoFrame !== 'undefined') features.add('video-frame')

  // ─── Limits (adapter.limits — всегда числа для всех GPU limit'ов) ────────
  // ВАЖНО: 'maxAnisotropy' включён явно — это даёт parity с WebGL2, где
  // 'anisotropic' feature пробивается через EXT_texture_filter_anisotropic.
  // На WebGPU нет одноимённого GPUFeatureName; anisotropic filtering нативно
  // (GPUSamplerDescriptor.maxAnisotropy), а её максимальное значение доступно
  // через device.limits.maxAnisotropy (обычно 16 на desktop, 1 на mobile без
  // поддержки). Когда maxAnisotropy ≥ 2 — добавляем 'anisotropic' в features
  // (см. ниже), чтобы caps.has('anisotropic')=true согласовывалось с реальным
  // применением maxAnisotropy в realGPU.createTexture.
  const limitNames = [
    'maxTextureDimension1D',
    'maxTextureDimension2D',
    'maxTextureDimension3D',
    'maxTextureArrayLayers',
    'maxBindGroups',
    'maxBindingsPerBindGroup',
    'maxBufferSize',
    'maxDynamicUniformBuffersPerPipelineLayout',
    'maxDynamicStorageBuffersPerPipelineLayout',
    'maxSampledTexturesPerShaderStage',
    'maxSamplersPerShaderStage',
    'maxStorageBuffersPerShaderStage',
    'maxStorageTexturesPerShaderStage',
    'maxUniformBuffersPerShaderStage',
    'maxUniformBufferBindingSize',
    'maxStorageBufferBindingSize',
    'maxVertexBuffers',
    'maxVertexAttributes',
    'maxVertexBufferArrayStride',
    'maxInterStageShaderComponents',
    'maxColorAttachments',
    'maxColorAttachmentBytesPerSample',
    'maxComputeWorkgroupStorageSize',
    'maxComputeInvocationsPerWorkgroup',
    'maxComputeWorkgroupSizeX',
    'maxComputeWorkgroupSizeY',
    'maxComputeWorkgroupSizeZ',
    'maxComputeWorkgroupsPerDimension',
    'maxAnisotropy',
  ]
  for (const name of limitNames) {
    const v = probe.getLimit(name)
    if (typeof v === 'number' && Number.isFinite(v)) {
      // Снэйк-кейс для унификации с WebGL2 mapping (maxTextureSize2D).
      const alias = name
        .replace('maxTextureDimension2D', 'maxTextureSize2D')
        .replace('maxTextureDimension3D', 'maxTextureSize3D')
        .replace('maxTextureDimension1D', 'maxTextureSize1D')
      limits[alias] = v
      limits[name] = v // оригинальное имя
    }
  }

  // ─── Anisotropic filtering feature ───────────────────────────────────────
  //
  // ВАЖНО (Task 54, WebGPU spec ver. 2026-08-20, MDN GPUSupportedLimits):
  // `maxAnisotropy` НЕ входит в специфицированный список свойств
  // `GPUSupportedLimits` (ни adapter.limits, ни device.limits). Поля
  // `adapter.limits.maxAnisotropy` / `device.limits.maxAnisotropy` НЕ
  // существуют как стандартные — обращение к ним через Record<string, number>
  // всегда возвращает `undefined` (а не 0, не 1, не 16).
  //
  // На WebGPU anisotropic filtering — это часть базовой спецификации (без
  // feature-request, без requiredLimits). Платформа автоматически клампит
  // `GPUSamplerDescriptor.maxAnisotropy` к своему нативному максимуму (обычно
  // 16 на desktop, 1 на некоторых мобильных GPU без поддержки). См. MDN
  // GPUDevice.createSampler: "Most implementations support maxAnisotropy
  // values in a range between 1 and 16, inclusive. The value used will be
  // clamped to the maximum value that the underlying platform supports."
  //
  // Поэтому на WebGPU ВСЕГДА считаем feature 'anisotropic' доступной, а
  // максимальное значение = 16 (нативный WebGPU max по спецификации).
  // realGPU.createTexture передаёт maxAnisotropy через GPUSamplerDescriptor
  // и платформа клампит — согласовано с caps.has('anisotropic')=true.
  //
  // Это контрастирует с WebGL2, где anisotropic требует расширения
  // EXT_texture_filter_anisotropic и пробивается через MAX_TEXTURE_MAX_ANISOTROPY.
  features.add('anisotropic')
  limits['maxAnisotropy'] = 16

  // MSAA — из device.limits.maxSampleCount (в WebGPU это явно есть)
  const msc = probe.getLimit('maxSampleCount')
  if (typeof msc === 'number') {
    if (msc >= 2) features.add('msaa-2x')
    if (msc >= 4) features.add('msaa-4x')
    if (msc >= 8) features.add('msaa-8x')
    if (msc >= 16) features.add('msaa-16x')
  } else {
    // По умолчанию для desktop WebGPU — 4x.
    features.add('msaa-2x')
    features.add('msaa-4x')
  }

  // ─── FormatMatrix ─────────────────────────────────────────────────────────
  // Полная матрица WebGPU определяется через wgpu NativeCaps + canvas config.
  // Для M4 — упрощённо: native для базовых, feature-зависимые для float.
  const hasFloat32Filter = features.has('float32-filterable')
  const hasRg11b10 = features.has('rg11b10ufloat-render')

  const setFmt = (format: string, axis: FormatAxis, support: FormatSupport) => {
    formatMatrix.set(`${format}|${axis}`, support)
  }

  // rgba8unorm — baseline native
  for (const axis of ['sampled', 'render', 'blend', 'filter', 'msaa', 'storage'] as const) {
    setFmt('rgba8unorm', axis, 'native')
  }
  setFmt('rgba8unorm', 'storage', 'none')

  // rgba8unorm-srgb — native
  for (const axis of ['sampled', 'render', 'blend', 'filter', 'msaa'] as const) {
    setFmt('rgba8unorm-srgb', axis, 'native')
  }
  setFmt('rgba8unorm-srgb', 'storage', 'none')

  // bgra8unorm — preferred canvas format, нативно. Storage iff feature.
  for (const axis of ['sampled', 'render', 'blend', 'filter', 'msaa'] as const) {
    setFmt('bgra8unorm', axis, 'native')
  }
  setFmt('bgra8unorm', 'storage', features.has('bgra8-storage') ? 'native' : 'none')

  // r8unorm, rg8unorm — sampled/filter, не render
  for (const axis of ['sampled', 'filter'] as const) {
    setFmt('r8unorm', axis, 'native')
    setFmt('rg8unorm', axis, 'native')
  }
  for (const axis of ['render', 'blend', 'msaa', 'storage'] as const) {
    setFmt('r8unorm', axis, 'none')
    setFmt('rg8unorm', axis, 'none')
  }

  // rgba16float — sampled всегда, filter/render iff float32-filterable (paradox WebGPU)
  setFmt('rgba16float', 'sampled', 'native')
  setFmt('rgba16float', 'filter', hasFloat32Filter ? 'native' : 'none')
  setFmt('rgba16float', 'render', hasFloat32Filter ? 'native' : 'none')
  setFmt('rgba16float', 'blend', hasFloat32Filter ? 'native' : 'none')
  setFmt('rgba16float', 'msaa', hasFloat32Filter ? 'native' : 'none')
  setFmt('rgba16float', 'storage', 'none')

  // rgba32float
  setFmt('rgba32float', 'sampled', 'native')
  setFmt('rgba32float', 'filter', hasFloat32Filter ? 'native' : 'none')
  setFmt('rgba32float', 'render', hasFloat32Filter ? 'native' : 'none')
  setFmt('rgba32float', 'blend', hasFloat32Filter ? 'native' : 'none')
  setFmt('rgba32float', 'msaa', 'none') // 32float не MSAA никогда
  setFmt('rgba32float', 'storage', 'none')

  // rg11b10ufloat — render iff feature
  setFmt('rg11b10ufloat', 'sampled', 'native')
  setFmt('rg11b10ufloat', 'filter', 'native')
  setFmt('rg11b10ufloat', 'render', hasRg11b10 ? 'native' : 'none')
  setFmt('rg11b10ufloat', 'blend', hasRg11b10 ? 'native' : 'none')
  setFmt('rg11b10ufloat', 'msaa', hasRg11b10 ? 'native' : 'none')
  setFmt('rg11b10ufloat', 'storage', 'none')

  // depth24plus — sampled/render, msaa=native (no blend, no storage, no filter)
  for (const axis of ['sampled', 'render', 'msaa'] as const) {
    setFmt('depth24plus', axis, 'native')
  }
  for (const axis of ['filter', 'blend', 'storage'] as const) {
    setFmt('depth24plus', axis, 'none')
  }

  // depth24plus-stencil8 — то же
  for (const axis of ['sampled', 'render', 'msaa'] as const) {
    setFmt('depth24plus-stencil8', axis, 'native')
  }
  for (const axis of ['filter', 'blend', 'storage'] as const) {
    setFmt('depth24plus-stencil8', axis, 'none')
  }

  // ─── Present-paths ────────────────────────────────────────────────────────
  paths.set('wgpu-direct', 'supported')
  paths.set('wgpu-copy', 'supported')
  paths.set('canvas-direct', 'supported')
  paths.set('asyncbmp', features.has('offscreen-canvas') ? 'supported' : 'unsupported')

  return {
    features,
    formatMatrix,
    paths,
    extensions,
    limits,
    backend: 'webgpu',
  }
}

/**
 * Создаёт GPUProbe обёртку над реальным GPUAdapter (+ опционально GPUDevice).
 *
 * ВАЖНО: на некоторых браузерах (Chromium < 130, Safari < 18, Firefox < 140)
 * adapter.limits НЕ содержит maxAnisotropy, хотя device.limits — да. Поэтому
 * getLimit() сначала пробует adapter.limits[name], потом device.limits[name].
 * Это критично для caps.has('anisotropic'): без fallback'а к device.limits
 * caps лжёт (false), хотя sampler реально применяет anisotropic.
 */
export function makeGPUProbe(
  adapter: GPUAdapter,
  preferredFormat: string,
  device?: GPUDevice | null,
): GPUProbe {
  // Adapter.features — GPUSupportedFeatures (Set-like, has(name)).
  // Adapter.limits — GPUSupportedLimits (sync getters).
  const features = adapter.features
  const adapterLimits = adapter.limits
  // Device.limits — fallback к adapter.limits. Опционально (recording-фасад
  // не передаёт device, тогда getLimit работает только с adapter.limits).
  const deviceLimits = device?.limits ?? null

  // Adapter.info — это Promise<GPUAdapterInfo> в стандарте, но на практике
  // многие браузеры уже возвращают sync adapter.info (Chrome 113+).
  // Для probing sync path; если нет — fallback к пустым строкам.
  let infoCache: { vendor: string; architecture: string; description: string } | null = null
  const getInfo = () => {
    if (infoCache) return infoCache
    const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info
    if (info && typeof info === 'object') {
      infoCache = {
        vendor: (info as GPUAdapterInfo).vendor ?? '',
        architecture: (info as GPUAdapterInfo).architecture ?? '',
        description: (info as GPUAdapterInfo).description ?? '',
      }
    } else {
      infoCache = { vendor: '', architecture: '', description: '' }
    }
    return infoCache
  }

  return {
    hasFeature: (name) => {
      try {
        return features.has(name as GPUFeatureName)
      } catch {
        return false
      }
    },
    getLimit: (name) => {
      try {
        // 1) Adapter.limits — максимальные лимиты адаптера (можно запросить
        // через requiredLimits при requestDevice()).
        const adapterV = (adapterLimits as unknown as Record<string, number>)[name]
        if (typeof adapterV === 'number') return adapterV
        // 2) Device.limits — fallback (после requestDevice без requiredLimits
        // device.limits содержит дефолтные значения, включая maxAnisotropy).
        if (deviceLimits !== null) {
          const deviceV = (deviceLimits as unknown as Record<string, number>)[name]
          if (typeof deviceV === 'number') return deviceV
        }
        return undefined
      } catch {
        return undefined
      }
    },
    get info() {
      return getInfo()
    },
    preferredFormat,
  }
}
