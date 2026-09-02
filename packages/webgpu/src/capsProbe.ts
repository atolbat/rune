/**
 * capsProbe for WebGPU — probing adapter.features + adapter.limits + adapter.info.
 *
 * Mappings (FeatureId ↔ WebGPU GPUFeatureName):
 *   astc               ↔ 'texture-compression-astc'
 *   bc1, bc3, bc7      ↔ 'texture-compression-bc'
 *   etc2               ↔ 'texture-compression-etc2'
 *   depth-clamp        ↔ 'depth-clamping'
 *   timestamp-query    ↔ 'timestamp-query'
 *   pipeline-stats     ↔ 'pipeline-statistics-query'
 *   occlusion-query    ↔ 'occlusion-query' (native in WebGPU)
 *   bgra8-storage      ↔ 'bgra8unorm-storage'
 *   float32-filterable ↔ 'float32-filterable'
 *   rg11b10ufloat-render ↔ 'rg11b10ufloat-render'
 *   shared-exponent   ↔ 'shared-texture-bgra8unorm' — no, more precisely:
 *                        the 'rgba8snorm-...' family. Simplified for M4.
 *
 * In WebGPU 'instancing' is always native (no restriction), 'depth-texture' is
 *   native (pipeline depth attachments). 'anisotropic' is base
 *   specification (GPUSamplerDescriptor.maxAnisotropy).
 * Contract 5 (Task 79, caps hygiene): do NOT claim a feature without an
 *   execution path in the engine. The WebGPU API can do
 *   compute/storage/drawIndirect, but rune's renderers do NOT execute them
 *   (no dispatch, no storage bindings, no drawIndirect)
 *   — therefore 'compute', 'storage-buffer', 'storage-texture', 'draw-indirect'
 *   are NOT claimed until the paths appear (M6+). Parity with the WebGL2 probe.
 * 'msaa-2x'/'4x'/'8x' — device.limits.maxSampleCount (usually 4 on mobile, 8 on desktop).
 *
 * FormatMatrix in WebGPU: query via device.features for float/blend.
 * rgba8unorm — baseline native, always.
 * rgba16float — renderable iff features.has('float32-filterable') (paradox name —
 * it actually covers float16 too). More precisely: sampleable always, renderable iff
 * features.has('float32-filterable') OR color-attachment-float.
 */

import type { CapsQuery, FeatureName, FormatAxis, FormatSupport } from '@rune/core'

/** Minimal interface for probing a WebGPU adapter. */
export interface GPUProbe {
  /** adapter.features.has(name). */
  hasFeature(name: string): boolean
  /** adapter.limits[limit] — first adapter, then fallback to device.limits
   *  (needed for maxAnisotropy: in some browsers the field is available only
   *  in device.limits after requestDevice(), but not in adapter.limits). */
  getLimit(name: string): number | undefined
  /** adapter.info (vendor / architecture / description). */
  info: { vendor: string; architecture: string; description: string }
  /** Preferred canvas format (navigator.gpu.getPreferredCanvasFormat()). */
  readonly preferredFormat: string
}

/**
 * Probes CapsQuery from a GPUProbe (wrapper over adapter/device).
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
    ['shared-exponent', 'rgba8snorm-color-render-..'], // simplified
  ]
  for (const [feature, gpuName] of featureMap) {
    if (probe.hasFeature(gpuName)) {
      features.add(feature)
      extensions.set(gpuName, true)
    }
  }

  // Native WebGPU features (always in the specification — no extension).
  // Contract 5 (Task 79): we claim ONLY what the engine executes:
  //   'instancing' — draw(instances) + stepMode 'instance' (Task 75);
  //   'depth-texture' — pipeline depth attachments (test/write);
  //   'offscreen-canvas'/'video-frame' — environment features.
  // NOT claimed (the API can, the engine cannot yet; paths appear in M6+):
  //   'compute', 'storage-buffer', 'storage-texture', 'draw-indirect'.
  //   Previously these were added unconditionally — a lie for caps consumers
  //   (audit Task 72: "remove false compute/draw-indirect claims").
  features.add('instancing')
  features.add('depth-texture')
  features.add('offscreen-canvas') // browser environment, not a device feature
  if (typeof VideoFrame !== 'undefined') features.add('video-frame')

  // ─── Limits (adapter.limits — always numbers for all GPU limits) ────────
  // IMPORTANT: 'maxAnisotropy' is included explicitly — this gives parity
  // with WebGL2, where the 'anisotropic' feature is probed via
  // EXT_texture_filter_anisotropic. WebGPU has no GPUFeatureName of the
  // same name; anisotropic filtering is native
  // (GPUSamplerDescriptor.maxAnisotropy), and its maximum value is available
  // via device.limits.maxAnisotropy (usually 16 on desktop, 1 on mobile
  // without support). When maxAnisotropy ≥ 2 — add 'anisotropic' to features
  // (see below) so caps.has('anisotropic')=true stays consistent with the
  // actual maxAnisotropy usage in realGPU.createTexture.
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
      // Snake case for unification with the WebGL2 mapping (maxTextureSize2D).
      const alias = name
        .replace('maxTextureDimension2D', 'maxTextureSize2D')
        .replace('maxTextureDimension3D', 'maxTextureSize3D')
        .replace('maxTextureDimension1D', 'maxTextureSize1D')
      limits[alias] = v
      limits[name] = v // original name
    }
  }

  // ─── Anisotropic filtering feature ───────────────────────────────────────
  //
  // IMPORTANT (Task 54, WebGPU spec ver. 2026-08-20, MDN GPUSupportedLimits):
  // `maxAnisotropy` is NOT part of the specified list of
  // `GPUSupportedLimits` properties (neither adapter.limits nor
  // device.limits). The fields
  // `adapter.limits.maxAnisotropy` / `device.limits.maxAnisotropy` do NOT
  // exist as standard — accessing them via Record<string, number>
  // always returns `undefined` (not 0, not 1, not 16).
  //
  // On WebGPU anisotropic filtering is part of the base specification (no
  // feature-request, no requiredLimits). The platform automatically clamps
  // `GPUSamplerDescriptor.maxAnisotropy` to its native maximum (usually
  // 16 on desktop, 1 on some mobile GPUs without support). See MDN
  // GPUDevice.createSampler: "Most implementations support maxAnisotropy
  // values in a range between 1 and 16, inclusive. The value used will be
  // clamped to the maximum value that the underlying platform supports."
  //
  // Therefore on WebGPU we ALWAYS consider the 'anisotropic' feature
  // available, with the maximum value = 16 (the native WebGPU max per
  // specification). realGPU.createTexture passes maxAnisotropy via
  // GPUSamplerDescriptor and the platform clamps — consistent with
  // caps.has('anisotropic')=true.
  //
  // This contrasts with WebGL2, where anisotropic requires the
  // EXT_texture_filter_anisotropic extension and is probed via MAX_TEXTURE_MAX_ANISOTROPY.
  features.add('anisotropic')
  limits['maxAnisotropy'] = 16

  // MSAA — from device.limits.maxSampleCount (WebGPU has this explicitly)
  const msc = probe.getLimit('maxSampleCount')
  if (typeof msc === 'number') {
    if (msc >= 2) features.add('msaa-2x')
    if (msc >= 4) features.add('msaa-4x')
    if (msc >= 8) features.add('msaa-8x')
    if (msc >= 16) features.add('msaa-16x')
  } else {
    // Default for desktop WebGPU — 4x.
    features.add('msaa-2x')
    features.add('msaa-4x')
  }

  // ─── FormatMatrix ─────────────────────────────────────────────────────────
  // The full WebGPU matrix is determined via wgpu NativeCaps + canvas config.
  // For M4 — simplified: native for the basics, feature-dependent for float.
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

  // bgra8unorm — preferred canvas format, native. Storage iff feature.
  for (const axis of ['sampled', 'render', 'blend', 'filter', 'msaa'] as const) {
    setFmt('bgra8unorm', axis, 'native')
  }
  setFmt('bgra8unorm', 'storage', features.has('bgra8-storage') ? 'native' : 'none')

  // r8unorm, rg8unorm — sampled/filter, not render
  for (const axis of ['sampled', 'filter'] as const) {
    setFmt('r8unorm', axis, 'native')
    setFmt('rg8unorm', axis, 'native')
  }
  for (const axis of ['render', 'blend', 'msaa', 'storage'] as const) {
    setFmt('r8unorm', axis, 'none')
    setFmt('rg8unorm', axis, 'none')
  }

  // rgba16float — sampled always, filter/render iff float32-filterable (WebGPU paradox)
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
  setFmt('rgba32float', 'msaa', 'none') // 32float is never MSAA
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

  // depth24plus-stencil8 — same
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
 * Creates a GPUProbe wrapper over a real GPUAdapter (+ optionally GPUDevice).
 *
 * IMPORTANT: in some browsers (Chromium < 130, Safari < 18, Firefox < 140)
 * adapter.limits does NOT contain maxAnisotropy, while device.limits does.
 * So getLimit() first tries adapter.limits[name], then device.limits[name].
 * This is critical for caps.has('anisotropic'): without the fallback to
 * device.limits caps lies (false), although the sampler actually applies
 * anisotropic.
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
  // Device.limits — fallback to adapter.limits. Optional (the recording
  // facade passes no device, then getLimit works only with adapter.limits).
  const deviceLimits = device?.limits ?? null

  // Adapter.info is Promise<GPUAdapterInfo> in the standard, but in practice
  // many browsers already return sync adapter.info (Chrome 113+).
  // We probe the sync path; if absent — fallback to empty strings.
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
        // 1) Adapter.limits — the adapter's maximum limits (can be requested
        // via requiredLimits in requestDevice()).
        const adapterV = (adapterLimits as unknown as Record<string, number>)[name]
        if (typeof adapterV === 'number') return adapterV
        // 2) Device.limits — fallback (after requestDevice without requiredLimits
        // device.limits contains default values, including maxAnisotropy).
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
