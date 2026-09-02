/**
 * The real WebGPU facade: adapter/device, canvas context, UBO with dynamic
 * offsets, lazy pipelines (descriptors are derived from command attributes —
 * a lesson of the "dark canvas" incident), writeTexture tiles with origin,
 * the texture bind group (group 1). Silent validation errors go to onGpuError.
 */

import type { GPUFacade, GPUImageSource, GpuTimerHandle, GpuAttrSlot } from './facade.ts'
import type { GpuPipelineDesc } from './pipeline/pipelineCache.ts'
import { createGpuGpuTimer } from './gpuTimer.ts'
import type { GpuTimer } from '@rune/core'
import { GPU_FORMATS } from './formats.ts'
import type { TextureFormat, TextureFormatId } from '@rune/core'

/** A canvas of any type (HTML or Offscreen). We avoid a circular dependency
 *  on @rune/gl, so the type is local and structurally compatible. */
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas

/** Task 69: the sampleType variant of the texture binding (group 1).
 *  'float' — filterable textures (LINEAR); 'unfilterable-float' —
 *  rgba32float without feature 'float32-filterable' (NEAREST, sampling
 *  only via textureSampleLevel). */
type TextureSampleVariant = 'float' | 'unfilterable-float'

export async function createRealGPU(
  canvas: AnyCanvas,
  onGpuError?: (message: string) => void,
): Promise<GPUFacade> {
  const adapter = await navigator.gpu.requestAdapter()
  if (adapter === null) throw new Error('rune: WebGPU adapter unavailable')
  // Request the timestamp-query feature IF the adapter supports it.
  // This enables device.createQuerySet({ type: 'timestamp' }) and pass.writeTimestamp.
  // On adapters without the feature — the device is created without it, GpuTimer is not wired.
  const requiredFeatures: GPUFeatureName[] = []
  if (adapter.features.has('timestamp-query' as GPUFeatureName)) {
    requiredFeatures.push('timestamp-query' as GPUFeatureName)
  }
  // Task 69: 'float32-filterable' — linear filtering of rgba32float.
  // Requested IF the adapter can (like timestamp-query): on such devices
  // rgba32float stays LINEAR + sampleType 'float' — behavior unchanged.
  // On devices without the feature the facade degrades correctly: sampler →
  // nearest, bind-group/pipeline layout → sampleType 'unfilterable-float' +
  // sampler 'non-filtering' (see bindTexture/ensurePipeline). Previously the
  // bind-group was created with sampleType 'float' for any texture → a
  // validation error "None of the supported sample types (UnfilterableFloat)
  // ... match the expected sample types (Float)" on first rgba32float
  // sampling.
  if (adapter.features.has('float32-filterable' as GPUFeatureName)) {
    requiredFeatures.push('float32-filterable' as GPUFeatureName)
  }
  // ─── WebGPU baseline: anisotropic filtering natively, no requiredLimits ────
  // Task 54: per the WebGPU spec (ver. 2026-08-20, MDN GPUSupportedLimits)
  // maxAnisotropy is NOT part of the specified list of GPUSupportedLimits
  // properties — neither adapter.limits nor device.limits. It is part of
  // the base specification: GPUSamplerDescriptor.maxAnisotropy is clamped
  // by the platform to its native maximum (usually 16). Neither
  // requiredFeatures nor requiredLimits is needed — anisotropic filtering
  // is available on all WebGPU devices (the platform clamps to 1 if the
  // hardware does not support it, which is equivalent to bilinear).
  //
  // realGPU.createTexture passes maxAnisotropy via GPUSamplerDescriptor
  // and the platform clamps. caps.has('anisotropic')=true (see
  // probeGPUCaps) — consistent with the sampler's actual usage.
  let device: GPUDevice
  try {
    device = await adapter.requestDevice({ requiredFeatures })
  } catch {
    // requestDevice can fail on feature validation or when the device is
    // absent. Fallback — without requiredFeatures (timestamp-query not
    // requested, gpuMs will be null — honest, not a fake 0).
    device = await adapter.requestDevice()
  }
  device.addEventListener('uncapturederror', event => {
    onGpuError?.(String((event as GPUUncapturedErrorEvent).error.message ?? event))
  })

  const context = canvas.getContext('webgpu') as GPUCanvasContext | null
  if (context === null) throw new Error('rune: webgpu canvas context unavailable')
  const gpuContext: GPUCanvasContext = context
  const format = navigator.gpu.getPreferredCanvasFormat()

  const textures = new Map<number, { texture: GPUTexture; sampler: GPUSampler; view: GPUTextureView; format: GPUTextureFormat; filterable: boolean }>()
  const textureViews = new Map<number, { textureId: number; view: GPUTextureView }>()
  // Task 69: the pipeline is cached by SPEC + VARIANTS of the texture
  // binding's sampleType. The 'float' variant (sampler 'filtering' +
  // texture 'float') is the default; 'unfilterable-float' (sampler
  // 'non-filtering' + texture 'unfilterable-float') is created lazily in
  // bindTexture on the first bind of rgba32float without the
  // 'float32-filterable' feature. The pipeline layout and bind group must
  // match in sampleType — otherwise setBindGroup validation fails.
  const pipelines = new Map<number, PipelineRecord>()
  // Vertex buffers: keyed by Float32Array (usually one command = one spec =
  // one data). If the user dropped the reference to data — the GPUBuffer
  // leaks, but only for the whole renderer session. dispose() cleans
  // everything. FR not applied: tied to the spec command's lifetime, not a
  // user-facing handle.
  const vertexBuffers = new Map<Float32Array, GPUBuffer>()
  const textureBindGroups = new Map<string, GPUBindGroup>()
  const targets = new Map<number, {
    view: GPUTextureView
    depthView: GPUTextureView | null
    depthTexture: GPUTexture | null
    color: readonly number[]
    /** Task 80 (readback): target size and texture — copyTextureToBuffer. */
    width: number
    height: number
    textureId: number
  }>()
  let nextTextureId = 1
  let nextTargetId = 1
  let nextTextureViewId = 1_000_000 // separate the namespace from textureId (1, 2, 3...)
  let width = 0
  let height = 0
  let depthTexture: GPUTexture | null = null
  let depthView: GPUTextureView | null = null
  let ubo: GPUBuffer | null = null
  let uboSize = 0
  let uboGroup: GPUBindGroup | null = null
  let encoder: GPUCommandEncoder | null = null
  let pass: GPURenderPassEncoder | null = null
  let currentPipeline: GPURenderPipeline | null = null
  let currentPipelineId = -1
  let currentTarget = 0
  /** Multi-textures (Nefertiti model base+normal): command textures
   *  accumulate via bindTexture, the bind group is fixed in draw(). */
  const pendingTextureIds: number[] = []
  let timerHandle: GpuTimerHandle | null = null
  // Create the timer IF the device has the 'timestamp-query' feature.
  // createGpuGpuTimer returns {timer, handle} or null (if no feature).
  // The handle is wired into this facade via timerHandle — onBeginPass /
  // onEndPass / onSubmit are called in bindTarget/endPass/submit. The timer
  // is exposed via the gpu.timer getter — renderer.ts will wire it to
  // statsCollector.
  const timerBundle = createGpuGpuTimer(device)
  const gpuTimer: GpuTimer | null = timerBundle === null ? null : timerBundle.timer
  if (timerBundle !== null) {
    timerHandle = timerBundle.handle
  }

  function configure(w: number, h: number): void {
    gpuContext.configure({ device, format, alphaMode: 'opaque' })
    resize(w, h)
  }

  function resize(w: number, h: number): void {
    if (w === width && h === height && depthTexture !== null) return
    width = w
    height = h
    depthTexture?.destroy()
    depthTexture = device.createTexture({
      size: [w, h],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })
    depthView = depthTexture.createView()
  }

  /** Canonical id → native GPUTextureFormat (Task 110, restoration). */
  function resolveGpuFormat(id: TextureFormatId): string {
    const info = GPU_FORMATS[id]
    if (info === undefined) {
      throw new TypeError(`WebGPU does not support format '${id}' (GL-only or out of catalog)`)
    }
    return info.gpu
  }

  function createTexture(
    w: number,
    h: number,
    textureFormat: TextureFormat = 'rgba8unorm',
    options?: { mipLevels?: number; maxAnisotropy?: number },
  ): number {
    const mipLevels = options?.mipLevels ?? 1
    // Task 67 HDR: 'rgba16float'/'rgba32float' — core WebGPU formats
    // (renderable, and for rgba16float — filterable too). rgba32float is
    // NOT linearly filtered without feature 'float32-filterable' — the
    // sampler degrades to 'nearest' (valid for any format), and the
    // bind group and pipeline get sampleType 'unfilterable-float'
    // (Task 69) — otherwise a bind-group validation error on first
    // sampling.
    // Task 110 (restoration): the full format catalog — TextureFormatId
    // is resolved via GPU_FORMATS (formats.ts); 'canvas' — the canvas
    // format.
    const gpuFormat: GPUTextureFormat =
      textureFormat === 'canvas'
        ? format
        : (resolveGpuFormat(textureFormat) as GPUTextureFormat)
    const filterable =
      textureFormat !== 'rgba32float' || device.features.has('float32-filterable' as GPUFeatureName)
    const texture = device.createTexture({
      size: [w, h],
      format: gpuFormat,
      // Task 80 (readback): COPY_SRC — copyTextureToBuffer for readTargetPixels
      // (surface.read()); parity with the GL facade (readPixels always reads the FBO).
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
      // mipLevelCount: 1 by default. With >1 it creates a mip-chain (imm storage).
      // A sampler with mipmapFilter='linear' picks the mip by distance — the
      // analogue of LINEAR_MIPMAP_LINEAR in WebGL2.
      mipLevelCount: mipLevels,
    })
    // Anisotropic filtering — WebGPU GPUSamplerDescriptor.maxAnisotropy.
    // WebGPU supports it natively (no feature-request, no requiredLimits).
    // The platform itself clamps maxAnisotropy to its native maximum (usually
    // 16 on desktop, may be 1 on some mobile GPUs — bilinear effect).
    // Default 1 = disabled. caps.has('anisotropic')=true always on WebGPU
    // (see probeGPUCaps — Task 54: it is part of the base specification).
    // Applied only with mipLevels>1 — useless for non-mip.
    let appliedAniso = 1
    if (mipLevels > 1) {
      const requested = options?.maxAnisotropy ?? 16 // default 16 — the native WebGPU max
      // WebGPU requires a power of two for maxAnisotropy (1, 2, 4, 8, 16).
      // Clamp to [1, 16] (the native WebGPU maximum per specification; the
      // platform additionally clamps to its real maximum in createSampler).
      // If the platform does not support anisotropic — clamp to 1, bilinear effect.
      const limit = 16 // native WebGPU max; device.limits.maxAnisotropy does NOT exist
      const clamped = Math.max(1, Math.min(requested, limit))
      appliedAniso = clamped
    }
    const sampler = device.createSampler({
      magFilter: filterable ? 'linear' : 'nearest',
      minFilter: filterable ? 'linear' : 'nearest',
      // mipmapFilter='linear' if there is a mip-chain. Otherwise 'nearest'
      // (by default in WebGPU — sampling with mipmapFilter='nearest' ignores
      // the mip-chain, always samples level 0 — which is what textures
      // without mips need).
      mipmapFilter: mipLevels > 1 && filterable ? 'linear' : 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      // maxAnisotropy: applied with mipmapFilter='linear'. WebGPU itself
      // validates: maxAnisotropy must be ∈ {1, 2, 4, 8, 16} and ≤
      // device.limits.maxAnisotropy. On mobile=1 — neutral effect.
      ...(appliedAniso > 1 ? { maxAnisotropy: appliedAniso } : {}),
    })
    const id = nextTextureId++
    textures.set(id, { texture, sampler, view: texture.createView(), format: gpuFormat, filterable })
    return id
  }

  function texSubImage2D(textureId: number, x: number, y: number, w: number, h: number, bytes: Uint8Array): void {
    const record = textures.get(textureId)
    if (record === undefined) return
    // Task 67 HDR: bytesPerRow depends on the format (rgba16float — 8 B/pixel,
    // rgba32float — 16). The caller prepares the data: the bytes length must
    // be w*h*bytesPerPixel of the format.
    const bytesPerPixel = record.format === 'rgba16float' ? 8 : record.format === 'rgba32float' ? 16 : 4
    device.queue.writeTexture(
      { texture: record.texture, origin: { x, y, z: 0 } },
      bytes as Uint8Array<ArrayBuffer>,
      { bytesPerRow: w * bytesPerPixel, rowsPerImage: h },
      { width: w, height: h, depthOrArrayLayers: 1 },
    )
  }

  function copyExternalImageToTexture(
    textureId: number,
    source: GPUImageSource,
    dstX: number,
    dstY: number,
    copyWidth: number,
    copyHeight: number,
    flipY?: boolean,
  ): void {
    const record = textures.get(textureId)
    if (record === undefined) return
    // WebGPU ExternalImageCopy — source: ImageBitmap | HTMLcanvasElement | HTMLVideoElement | VideoFrame | OffscreenCanvas
    // destination.origin = where in the texture to write (mip 0 by default).
    // copySize = the size of the copied region. MUST be ≤ source.width/height,
    // otherwise validation error "Copy rect is out of bounds of external image".
    //
    // flipY (default false) — if true, the source is flipped along Y
    // BEFORE copying. WebGPU supports it natively via
    // GPUCopyExternalImageSourceInfo.flipY. This is exactly the parity with
    // WebGL2 UNPACK_FLIP_Y_WEBGL: flipY=true on both backends gives an
    // identical result — source row 0 pixels land in texture row H-1.
    device.queue.copyExternalImageToTexture(
      { source: source as GPUCopyExternalImageSource, flipY: flipY === true },
      { texture: record.texture, mipLevel: 0, origin: { x: dstX, y: dstY, z: 0 } },
      { width: copyWidth, height: copyHeight, depthOrArrayLayers: 1 },
    )
  }

  function copyExternalImageToTextureMip(
    textureId: number,
    mipLevel: number,
    source: GPUImageSource,
    dstX: number,
    dstY: number,
    copyWidth: number,
    copyHeight: number,
    flipY?: boolean,
  ): void {
    const record = textures.get(textureId)
    if (record === undefined) return
    // WebGPU copyExternalImageToTexture with destination.mipLevel=level.
    // The source must have size N/(2^level). WebGPU will check it itself —
    // on mismatch there will be a validation error (asynchronously in onGpuError).
    // flipY — see copyExternalImageToTexture above (GPUCopyExternalImageSourceInfo.flipY).
    device.queue.copyExternalImageToTexture(
      { source: source as GPUCopyExternalImageSource, flipY: flipY === true },
      { texture: record.texture, mipLevel, origin: { x: dstX, y: dstY, z: 0 } },
      { width: copyWidth, height: copyHeight, depthOrArrayLayers: 1 },
    )
  }

  function uploadUniforms(offset: number, data: Uint8Array): void {
    ensureUBO(offset + data.length)
    try {
      device.queue.writeBuffer(ubo!, offset, data as Uint8Array<ArrayBuffer>)
    } catch (error) {
      // Task 75: synchronous writeBuffer validation errors (e.g. size
      // larger than the buffer) must NOT crash the demo with an
      // "Uncaught OperationError" — they go to the onGpuError channel, the
      // frame degrades but lives.
      onGpuError?.(`writeBuffer(uniforms, ${data.length} bytes @${offset}) rejected: ${errorMessage(error)}`)
    }
  }

  function ensureUBO(needed: number): void {
    const rounded = Math.ceil(needed / 256) * 256
    if (ubo !== null && rounded <= uboSize) return
    const size = Math.max(65536, rounded)
    const next = device.createBuffer({ size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    const layout = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform', hasDynamicOffset: true },
      }],
    })
    uboGroup = device.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: { buffer: next, size: 256 } }],
    })
    if (ubo !== null) ubo.destroy()
    ubo = next
    uboSize = size
    currentPipeline = null // rebuild layout-dependent pipeline caches
    pipelines.clear()
  }

  function ensurePipeline(pipelineId: number, wgsl: string, attrs: readonly GpuAttrSlot[], hasTextures: boolean, desc?: GpuPipelineDesc): void {
    if (pipelines.has(pipelineId)) return
    const record = {
      wgsl,
      attrs,
      hasTextures,
      // Multi-textures: layout group 1 is built by the number of texture_2d
      // declarations in WGSL (1 — the old single-texture contract, 2+ —
      // base+normal map etc.)
      textureCount: hasTextures ? countGroup1TextureBindings(wgsl) : 0,
      desc: desc ?? {},
      variants: new Map<TextureSampleVariant, GPURenderPipeline>(),
    }
    pipelines.set(pipelineId, record)
    // The default 'float' variant — filterable textures (all except
    // rgba32float on devices without 'float32-filterable').
    record.variants.set('float', buildPipeline(record, 'float'))
  }

  /** Task 69: build a pipeline for a specific texture binding sampleType.
   *  'float' → sampler 'filtering' + texture 'float' (LINEAR filtering);
   *  'unfilterable-float' → sampler 'non-filtering' + texture
   *  'unfilterable-float' (NEAREST; the only legal way to sample
   *  rgba32float without feature 'float32-filterable'). WGSL must use
   *  textureSampleLevel (textureSample requires a filterable texture). */
  function buildPipeline(
    record: { wgsl: string; attrs: readonly GpuAttrSlot[]; hasTextures: boolean; textureCount: number; desc: GpuPipelineDesc },
    variant: TextureSampleVariant,
  ): GPURenderPipeline {
    const wgsl = record.wgsl
    const attrs = record.attrs
    const desc = record.desc
    const module = device.createShaderModule({ code: wgsl })
    // getCompilationInfo — best-effort diagnostics: on SwiftShader / a
    // GPU-process crash the promise may reject ("Instance dropped error") —
    // this is NOT an engine error, we swallow it to avoid an unhandled
    // rejection.
    void module.getCompilationInfo().then(info => {
      for (const message of info.messages) {
        if (message.type === 'error') onGpuError?.(`WGSL: ${message.message} (line ${message.lineNum})`)
      }
    }).catch(() => {})
    const group0 = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform', hasDynamicOffset: true },
      }],
    })
    const layouts: GPUBindGroupLayout[] = [group0]
    if (record.hasTextures) {
      // Multi-textures: bindings 1..N by the number of texture_2d in WGSL
      // (N=1 — the previous single-texture layout, backward compatible).
      // All textures of the command share one sampler (binding 0).
      const textureEntries: { binding: number; visibility: number; texture: { sampleType: TextureSampleVariant } }[] = []
      for (let slot = 1; slot <= Math.max(1, record.textureCount); slot++) {
        textureEntries.push({
          binding: slot,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: variant },
        })
      }
      layouts.push(device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: variant === 'float' ? 'filtering' : 'non-filtering' } },
          ...textureEntries,
        ],
      }))
      // Proactive diagnostics (Task 69): textureSample in WGSL is
      // incompatible with the 'unfilterable-float' variant — the pipeline
      // will not build. We say honestly how to fix it (textureSampleLevel
      // is valid for BOTH variants).
      if (variant === 'unfilterable-float' && /\btextureSample\s*\(/.test(wgsl)) {
        onGpuError?.('rgba32float without feature float32-filterable: WGSL calls textureSample — it requires a filterable texture (sampleType float). For unfilterable-float, textureSampleLevel(t, s, uv, level) is allowed — it is valid for filterable textures too (level 0 = base mip).')
      }
    }
    return device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: layouts }),
      vertex: {
        module,
        entryPoint: 'vsMain',
        // M5 (Task 73): tight numbers — their own layout (size*4); feed
        // interleaving — an object {size, stride, offset}: arrayStride=record,
        // attribute offset=field. Several fields of one feed — several
        // slots pointing at a shared buffer (binding — bindVertexBuffer).
        // Task 75: slot.step='instance' → stepMode 'instance' — a feed record
        // is read once per INSTANCE (quad-stars: corners are expanded from
        // @builtin(vertex_index) in the shader, count=6, instances=feed.count).
        buffers: attrs.map((slot, i) =>
          typeof slot === 'number'
            ? { arrayStride: slot * 4, attributes: [{ shaderLocation: i, offset: 0, format: vertexFormat(slot) }] }
            : {
                arrayStride: slot.stride ?? slot.size * 4,
                attributes: [{ shaderLocation: i, offset: slot.offset ?? 0, format: vertexFormat(slot.size) }],
                stepMode: slot.step === 'instance' ? 'instance' : 'vertex',
              },
        ),
      },
      fragment: {
        module,
        entryPoint: 'fsMain',
        // Task 75: blend from GpuPipelineDesc (premultiplied shader
        // output: additive = one/one, alpha = one/one-minus-src-alpha).
        // The facade's BlendFactor dictionary matches GPUBlendFactor one-to-one.
        targets: [{
          format,
          blend: desc.blend === undefined || desc.blend === false ? undefined : {
            color: { srcFactor: desc.blend.src as GPUBlendFactor, dstFactor: desc.blend.dst as GPUBlendFactor, operation: 'add' },
            alpha: { srcFactor: desc.blend.src as GPUBlendFactor, dstFactor: desc.blend.dst as GPUBlendFactor, operation: 'add' },
          },
        }],
      },
      // Task 75: depth from the descriptor. The canvas pass ALWAYS carries
      // a depth24plus attachment → the pipeline must declare a compatible
      // depthStencil; for "disabled" depth it is write:false +
      // compare:'always' (we keep the format to avoid spawning a second
      // branch of depth-less passes).
      primitive: {
        topology: desc.primitive === 'triangle-strip' ? 'triangle-strip' : 'triangle-list',
        cullMode: desc.raster?.cull === 'back' || desc.raster?.cull === 'front' ? desc.raster.cull : 'none',
        frontFace: desc.raster?.frontFace === 'cw' ? 'cw' : 'ccw',
      },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: desc.depth === false ? false : (desc.depth?.write ?? true),
        depthCompare: desc.depth === false ? 'always' : depthCompareOf(desc.depth?.test),
      },
    })
  }

  /** Facade DepthFunc → GPUCompareFunction. */
  function depthCompareOf(test: string | undefined): GPUCompareFunction {
    switch (test) {
      case 'never': return 'never'
      case 'equal': return 'equal'
      case 'lequal': return 'less-equal'
      case 'greater': return 'greater'
      case 'notequal': return 'not-equal'
      case 'gequal': return 'greater-equal'
      case 'always': return 'always'
      default: return 'less'
    }
  }

  function vertexFormat(size: number): GPUVertexFormat {
    if (size >= 4) return 'float32x4'
    if (size === 3) return 'float32x3'
    if (size === 2) return 'float32x2'
    return 'float32'
  }

  function usePipeline(pipelineId: number): void {
    const record = pipelines.get(pipelineId)
    if (record === undefined) return
    currentPipelineId = pipelineId
    // New command — accumulated textures are reset (the bind group is
    // built in draw() from the current command's set)
    pendingTextureIds.length = 0
    // The default 'float' variant; bindTexture will switch to
    // 'unfilterable-float' if an rgba32float without the feature is bound.
    setPipelineVariant(record, 'float')
  }

  /** Set the pipeline variant (created lazily on first use). */
  function setPipelineVariant(
    record: { wgsl: string; attrs: readonly GpuAttrSlot[]; hasTextures: boolean; textureCount: number; desc: GpuPipelineDesc; variants: Map<TextureSampleVariant, GPURenderPipeline> },
    variant: TextureSampleVariant,
  ): void {
    let pipeline = record.variants.get(variant)
    if (pipeline === undefined) {
      pipeline = buildPipeline(record, variant)
      record.variants.set(variant, pipeline)
    }
    if (pipeline === currentPipeline) return
    currentPipeline = pipeline
    pass?.setPipeline(pipeline)
  }

  function bindUniforms(dynamicOffset: number): void {
    pass?.setBindGroup(0, uboGroup!, [dynamicOffset])
  }

  function bindVertexBuffer(slot: number, data: Float32Array, _size: number): void {
    let buffer = vertexBuffers.get(data)
    if (buffer === undefined) {
      buffer = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
      guardedWriteVertex(buffer, data, data.byteLength)
      vertexBuffers.set(data, buffer)
    }
    pass?.setVertexBuffer(slot, buffer)
  }

  /** M5 (Task 73): the feed's dynamic vertex buffer — writeBuffer in a
   *  single call per frame with the dirty range [0, byteLength). The key
   *  is the feed renderer's stable Float32Array (SAB view / T3 mirror).
   *  Binding — later, via bindVertexBuffer (the same keyed cache, no
   *  repeated write). */
  function syncVertexBuffer(data: Float32Array, byteLength: number): void {
    let buffer = vertexBuffers.get(data)
    if (buffer === undefined) {
      buffer = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
      vertexBuffers.set(data, buffer)
    }
    if (byteLength <= 0) return
    guardedWriteVertex(buffer, data, byteLength)
  }

  /** Task 75: guarded vertex buffer write. Three lines of defense:
   *  (1) clamp byteLength to the GPU buffer size (data.byteLength may
   *      grow/diverge from the cache key under stress);
   *  (2) copy the SAB view into a plain ArrayBuffer (WebGPU forbids shared
   *      memory in writeBuffer — T1/T2 feeds);
   *  (3) try/catch around writeBuffer — a synchronous validation error
   *      ("Number of bytes to write is too large", non-multiple of 4 etc.)
   *      goes to onGpuError, the frame CONTINUES, the demo does not crash.
   *  ⚠️ Call forms: TypedArray → dataOffset/size in ELEMENTS; ArrayBuffer →
   *  in BYTES (GPUQueue.writeBuffer spec). */
  function guardedWriteVertex(buffer: GPUBuffer, data: Float32Array, byteLength: number): void {
    // (1) clamp: write no more than the GPU buffer size.
    const capped = Math.min(byteLength, buffer.size)
    if (capped !== byteLength) {
      onGpuError?.(`writeBuffer(vertex) clamp: ${byteLength} → ${capped} bytes (buffer size ${buffer.size})`)
    }
    if (capped <= 0) return
    try {
      const isSabView = typeof SharedArrayBuffer !== 'undefined' && data.buffer instanceof SharedArrayBuffer
      if (isSabView) {
        // capped — part of the write range (multiple of 4); copy into a plain buffer.
        const copy = new Uint8Array(new ArrayBuffer(capped))
        copy.set(new Uint8Array(data.buffer, data.byteOffset, capped))
        device.queue.writeBuffer(buffer, 0, copy)
        return
      }
      if (data.byteOffset === 0 && capped === data.byteLength) {
        device.queue.writeBuffer(buffer, 0, data as Float32Array<ArrayBuffer>)
        return
      }
      // ArrayBuffer form: offset and size — in BYTES.
      device.queue.writeBuffer(buffer, 0, data.buffer as ArrayBuffer, data.byteOffset, capped)
    } catch (error) {
      onGpuError?.(`writeBuffer(vertex, ${capped} bytes) rejected: ${errorMessage(error)}`)
    }
  }

  function bindTexture(textureOrViewId: number): void {
    // Multi-textures: bindings ACCUMULATE until draw() — the bind group
    // is assembled from all the command's textures (layout: sampler@0 +
    // tex@1..N).
    // Single-texture commands: previous behavior, but setBindGroup is
    // moved into draw() (for tapes the "bindTexture before draw" order
    // is the same).
    //
    // textureOrViewId: either a textureId (1..1M) → default view, or a
    // viewId (1M+) → sub-mip-range view from the textureViews Map.
    // If id ∈ textureViews → take the sub-view (created via
    // createTextureView). Otherwise — the default view from the textures Map.
    //
    // Task 69: the bind-group layout sampleType is derived from the
    // texture's FILTERABILITY: rgba32float without feature
    // 'float32-filterable' → 'unfilterable-float' + sampler
    // 'non-filtering' (such a texture's sampler is already nearest).
    // The hardcoded 'float' produced a CreateBindGroup validation error:
    // "None of the supported sample types (UnfilterableFloat) of [Texture
    // rgba32float] match the expected sample types (Float)". The pipeline
    // layout is synchronously switched to the matching variant
    // (setPipelineVariant) — otherwise the pipeline/bind-group
    // incompatibility would surface at draw.
    const record = pipelineOfTexture()
    const resolved = resolveTexture(textureOrViewId)
    if (resolved === undefined) return
    if (record !== undefined && record.hasTextures) {
      setPipelineVariant(record, resolved.filterable ? 'float' : 'unfilterable-float')
    }
    if (pendingTextureIds.length < 32) pendingTextureIds.push(textureOrViewId)
  }

  /** The current pipeline record (for variant and texture count). */
  function pipelineOfTexture(): PipelineRecord | undefined {
    return currentPipelineId >= 0 ? pipelines.get(currentPipelineId) : undefined
  }

  /** Texture/sub-view by id: view + sampler + filterability. */
  function resolveTexture(textureOrViewId: number): { view: GPUTextureView; sampler: GPUSampler; filterable: boolean } | undefined {
    const subView = textureViews.get(textureOrViewId)
    if (subView !== undefined) {
      const record = textures.get(subView.textureId)
      if (record === undefined) return undefined
      return { view: subView.view, sampler: record.sampler, filterable: record.filterable }
    }
    const record = textures.get(textureOrViewId)
    if (record === undefined) return undefined
    return { view: record.view, sampler: record.sampler, filterable: record.filterable }
  }

  /** Multi-texture bind group: sampler@0 + tex@1..N from all accumulated
   *  textures (missing slots — repeat of the last one). Cached by
   *  composition (id string + variant) — a set change = a new group. */
  function flushTextureBindGroup(): void {
    if (pendingTextureIds.length === 0) return
    if (pass === null) {
      pendingTextureIds.length = 0
      return
    }
    const record = pipelineOfTexture()
    const count = Math.max(1, record?.textureCount ?? 1)
    const key = `${currentPipelineId}:${count}:${pendingTextureIds.join(',')}`
    let group = textureBindGroups.get(key)
    if (group === undefined) {
      const first = resolveTexture(pendingTextureIds[0])
      if (first === undefined) {
        pendingTextureIds.length = 0
        return
      }
      const variant = first.filterable ? 'float' : 'unfilterable-float'
      const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: first.sampler }]
      for (let slot = 1; slot <= count; slot++) {
        const id = pendingTextureIds[Math.min(slot - 1, pendingTextureIds.length - 1)]
        const resolved = resolveTexture(id)
        if (resolved === undefined) {
          pendingTextureIds.length = 0
          return
        }
        entries.push({ binding: slot, resource: resolved.view })
      }
      const layout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: variant === 'float' ? 'filtering' : 'non-filtering' } },
          ...Array.from({ length: count }, (_, at): GPUBindGroupLayoutEntry => ({
            binding: at + 1,
            visibility: GPUShaderStage.FRAGMENT,
            texture: { sampleType: variant },
          })),
        ],
      })
      group = device.createBindGroup({ layout, entries })
      textureBindGroups.set(key, group)
    }
    pass.setBindGroup(1, group)
    pendingTextureIds.length = 0
  }

  function beginPass(_clearIndex: number): void {
    // Canvas pass = bindTarget(0, clear): the single target-switching path
    bindTarget(0, true)
  }

  function createTarget(
    textureId: number,
    targetWidth: number,
    targetHeight: number,
    depth: boolean,
    color: readonly [number, number, number, number],
  ): number {
    const record = textures.get(textureId)
    if (record === undefined) throw new Error(`rune: createTarget — texture ${textureId} not found`)
    let targetDepthView: GPUTextureView | null = null
    let targetDepthTexture: GPUTexture | null = null
    if (depth) {
      targetDepthTexture = device.createTexture({
        size: [targetWidth, targetHeight],
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      })
      targetDepthView = targetDepthTexture.createView()
    }
    const id = nextTargetId++
    targets.set(id, { view: record.view, depthView: targetDepthView, depthTexture: targetDepthTexture, color, width: targetWidth, height: targetHeight, textureId })
    return id
  }

  function bindTarget(targetId: number, clear: boolean): void {
    if (targetId === currentTarget && pass !== null && !clear) return
    if (pass !== null) {
      // END stamp BEFORE pass.end(): writeTimestamp(querySet, END_INDEX)
      if (timerHandle !== null) timerHandle.onEndPass(pass)
      pass.end()
      pass = null
    }
    currentTarget = targetId
    encoder ??= device.createCommandEncoder()
    const loadOp: GPULoadOp = clear ? 'clear' : 'load'
    let colorView: GPUTextureView
    let depthAttachment: GPURenderPassDepthStencilAttachment | undefined
    let clearValue: GPUColor
    if (targetId === 0) {
      colorView = gpuContext.getCurrentTexture().createView()
      clearValue = { r: 0.07, g: 0.08, b: 0.11, a: 1 }
      depthAttachment = depthView !== null ? {
        view: depthView,
        depthClearValue: 1,
        depthLoadOp: loadOp,
        depthStoreOp: 'store',
      } : undefined
    } else {
      const target = targets.get(targetId)
      if (target === undefined) return
      colorView = target.view
      clearValue = { r: target.color[0], g: target.color[1], b: target.color[2], a: target.color[3] }
      depthAttachment = target.depthView !== null ? {
        view: target.depthView,
        depthClearValue: 1,
        depthLoadOp: loadOp,
        depthStoreOp: 'store',
      } : undefined
    }
    pass = encoder.beginRenderPass({
      colorAttachments: [{ view: colorView, clearValue, loadOp, storeOp: 'store' }],
      depthStencilAttachment: depthAttachment,
    })
    // BEGIN stamp AFTER beginRenderPass: writeTimestamp(querySet, BEGIN_INDEX)
    if (timerHandle !== null) timerHandle.onBeginPass(pass)
    // New pass — the pipeline and its variant are set anew (usePipeline);
    // resetting the id prevents a variant swap on a stale pipeline in bindTexture.
    currentPipelineId = -1
    currentPipeline = null
  }

  function draw(count: number, instances: number): void {
    flushTextureBindGroup()
    pass?.draw(count, instances)
  }

  function endPass(): void {
    if (pass !== null && timerHandle !== null) timerHandle.onEndPass(pass)
    pass?.end()
    pass = null
  }

  function submit(): void {
    if (encoder === null) return
    // onSubmit BEFORE encoder.finish(): resolveQuerySet(BEGIN..END →
    // resolveBuffer) + copyBuffer(resolveBuffer → readBuffer for mapAsync).
    if (timerHandle !== null) timerHandle.onSubmit(encoder)
    device.queue.submit([encoder.finish()])
    encoder = null
  }

  // ─── Task 80: readback (copyTextureToBuffer + mapAsync) ──────────────
  // Contract: RGBA8, rows TOP-DOWN (texture row 0 = top), tight layout
  // (no 256-byte bytesPerRow alignment), RGBA channels — BGRA canvas
  // formats are swizzled. Full parity with the GL facade (readPixels +
  // flip): data[0..3] — the top-left pixel on BOTH backends.

  function readTargetPixels(targetId: number): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      if (targetId === 0) {
        reject(new Error('rune: readTargetPixels(0) — the canvas cannot be read (a presented texture lives one frame). Read the SURFACE: renderer.surface(...) → capture/passes → surface.read()'))
        return
      }
      const target = targets.get(targetId)
      if (target === undefined) {
        reject(new Error(`rune: readTargetPixels — target ${targetId} not found (deleted or never created)`))
        return
      }
      const record = textures.get(target.textureId)
      if (record === undefined) {
        reject(new Error(`rune: readTargetPixels — texture ${target.textureId} of target ${targetId} not found`))
        return
      }
      try {
        const w = target.width
        const h = target.height
        // An open pass on this target cannot be read — we close it; the
        // copy is appended to the SAME command buffer (order preserved), then submit.
        if (pass !== null) {
          if (timerHandle !== null) timerHandle.onEndPass(pass)
          pass.end()
          pass = null
        }
        encoder ??= device.createCommandEncoder()
        const rowBytes = w * 4
        const bytesPerRow = Math.ceil(rowBytes / 256) * 256 // WebGPU alignment
        const buffer = device.createBuffer({
          size: bytesPerRow * h,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        })
        encoder.copyTextureToBuffer(
          { texture: record.texture },
          { buffer, bytesPerRow, rowsPerImage: h },
          [w, h, 1],
        )
        // The BGRA→RGBA swizzle is needed for canvas formats (bgra8unorm on most platforms).
        const swizzle = record.format === 'bgra8unorm' || record.format === 'bgra8unorm-srgb'
        submit()
        void buffer.mapAsync(GPUMapMode.READ).then(
          () => {
            try {
              const mapped = new Uint8Array(buffer.getMappedRange())
              const out = new Uint8Array(rowBytes * h)
              for (let y = 0; y < h; y++) {
                const src = y * bytesPerRow
                const dst = y * rowBytes
                if (swizzle) {
                  for (let x = 0; x < rowBytes; x += 4) {
                    out[dst + x] = mapped[src + x + 2]! // B → R
                    out[dst + x + 1] = mapped[src + x + 1]! // G
                    out[dst + x + 2] = mapped[src + x]! // R → B
                    out[dst + x + 3] = mapped[src + x + 3]! // A
                  }
                } else {
                  out.set(mapped.subarray(src, src + rowBytes), dst)
                }
              }
              buffer.unmap()
              buffer.destroy()
              resolve(out)
            } catch (e) {
              try { buffer.destroy() } catch { /* already dead */ }
              reject(e instanceof Error ? e : new Error(String(e)))
            }
          },
          (e: unknown) => {
            // mapAsync rejected: device lost / buffer destroyed — honest reject.
            try { buffer.destroy() } catch { /* already dead */ }
            reject(e instanceof Error ? e : new Error(`readTargetPixels: mapAsync rejected (${String(e)})`))
          },
        )
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  // ─── Disposal: explicit release of GPU resources ────────────────────────
  // Idempotency: deleting the same id again — no-op (the record is already gone from the Map).

  function deleteTexture(textureId: number): void {
    const record = textures.get(textureId)
    if (record === undefined) return
    // Invalidate bind groups (including multi-texture compositions) that
    // involve this texture: on the next draw() the group will be recreated.
    for (const key of textureBindGroups.keys()) {
      const parts = key.split(':')
      if (parts.length > 2 && parts[2].split(',').includes(String(textureId))) {
        textureBindGroups.delete(key)
      }
    }
    // Delete all sub-views of this texture (created via createTextureView)
    for (const [viewId, sv] of textureViews) {
      if (sv.textureId === textureId) {
        invalidateTextureViewBindGroups(viewId)
        textureViews.delete(viewId)
      }
    }
    record.texture.destroy()
    // GPUSampler has no destroy() — GC will clean it up
    textures.delete(textureId)
  }

  /** Evicts from the cache all compositions containing the sub-view (viewId). */
  function invalidateTextureViewBindGroups(viewId: number): void {
    for (const key of textureBindGroups.keys()) {
      const parts = key.split(':')
      if (parts.length > 2 && parts[2].split(',').includes(String(viewId))) {
        textureBindGroups.delete(key)
      }
    }
  }

  function createTextureView(
    textureId: number,
    options?: { baseMipLevel?: number; mipLevelCount?: number; baseArrayLayer?: number; arrayLayerCount?: number },
  ): number {
    const record = textures.get(textureId)
    if (record === undefined) {
      // Texture not found — WebGPU itself would throw; we would silently
      // return 0. The caller should check textureId ∈ textures, but we do
      // not expose the Map. Better to throw a clear error.
      throw new Error(`rune: createTextureView — texture ${textureId} not found`)
    }
    const view = record.texture.createView({
      baseMipLevel: options?.baseMipLevel ?? 0,
      mipLevelCount: options?.mipLevelCount,
      baseArrayLayer: options?.baseArrayLayer,
      arrayLayerCount: options?.arrayLayerCount,
      dimension: '2d',
      aspect: 'all',
    })
    const viewId = nextTextureViewId++
    textureViews.set(viewId, { textureId, view })
    return viewId
  }

  function deleteTextureView(viewId: number): void {
    const sv = textureViews.get(viewId)
    if (sv === undefined) return
    // GPUTextureView has no destroy() — it is freed when the parent
    // texture is destroyed (implicitly by device.destroy()). But we remove
    // it from the Map so bindTexture no longer finds this view.
    invalidateTextureViewBindGroups(viewId)
    textureViews.delete(viewId)
  }

  function deleteTarget(targetId: number): void {
    const target = targets.get(targetId)
    if (target === undefined) return
    target.depthTexture?.destroy()
    targets.delete(targetId)
  }

  let facadeDisposed = false

  function installTimer(handle: GpuTimerHandle | null): GpuTimerHandle | null {
    const prev = timerHandle
    timerHandle = handle
    return prev
  }

  function dispose(): void {
    if (facadeDisposed) return
    facadeDisposed = true
    // 0. Remove timer hooks — writeTimestamp after dispose is pointless anyway
    timerHandle = null
    // 1. Destroy all facade textures (color + sampler needs no destroy)
    for (const record of textures.values()) {
      record.texture.destroy()
    }
    textures.clear()
    textureBindGroups.clear()
    // 1b. Clear the sub-views — GPUTextureView is freed implicitly via
    // device.destroy(), like the parent textures.
    textureViews.clear()
    // 2. Destroy the depth textures of the canvas attachment and targets
    depthTexture?.destroy()
    depthTexture = null
    depthView = null
    for (const target of targets.values()) {
      target.depthTexture?.destroy()
    }
    targets.clear()
    // 3. UBO — GPUBuffer.destroy
    ubo?.destroy()
    ubo = null
    uboSize = 0
    uboGroup = null
    // 4. Vertex buffers — keyed by Float32Array
    for (const buf of vertexBuffers.values()) {
      buf.destroy()
    }
    vertexBuffers.clear()
    // 5. Pipelines: GPURenderPipeline has no destroy() — device.destroy()
    //    will free them implicitly. Clear the Map to avoid dragging references.
    pipelines.clear()
    // 6. The active pass/encoder — reset it (device.destroy() will make
    //    submit throw, but we will not get there — nobody will call submit
    //    after dispose).
    encoder = null
    pass = null
    currentPipeline = null
    currentTarget = 0
    // 7. Final: device.destroy() — deterministically frees ALL GPU memory
    //    of the device (textures/buffers/pipelines/samplers/texture-views),
    //    even what was not destroyed explicitly. After this the browser
    //    will close the canvas context. This is exactly the parity with
    //    WebGL2 loseContext + explicit release. QuerySet, resolveBuffer,
    //    readBuffer of GpuTimer — will also be freed by device.destroy()
    //    (they were created through this device).
    device.destroy()
  }

  return {
    configure,
    resize,
    createTexture,
    texSubImage2D,
    copyExternalImageToTexture,
    copyExternalImageToTextureMip,
    uploadUniforms,
    ensurePipeline,
    usePipeline,
    bindUniforms,
    bindVertexBuffer,
    syncVertexBuffer,
    bindTexture,
    beginPass,
    draw,
    endPass,
    submit,
    readTargetPixels,
    createTarget,
    bindTarget,
    deleteTexture,
    deleteTarget,
    createTextureView,
    deleteTextureView,
    dispose,
    installTimer,
    get adapter() { return adapter },
    get device() { return device },
    get preferredFormat() { return format },
    get timer() { return gpuTimer },
  }
}

/** The error message as a single line (for the onGpuError channel). */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Pipeline record: WGSL + descriptor + lazy variants by sampleType. */
interface PipelineRecord {
  readonly wgsl: string
  readonly attrs: readonly GpuAttrSlot[]
  readonly hasTextures: boolean
  /** Multi-textures: the number of texture_2d declarations in group 1 of WGSL. */
  readonly textureCount: number
  readonly desc: GpuPipelineDesc
  readonly variants: Map<TextureSampleVariant, GPURenderPipeline>
}

/** The number of group-1 texture_2d bindings in WGSL — the size of the
 *  multi-texture layout (sampler@0 + tex@1..N). Single-texture shaders
 *  give 1 — the previous v1 contract; base+normal map — 2. */
export function countGroup1TextureBindings(wgsl: string): number {
  let count = 0
  for (const _match of wgsl.matchAll(/@group\(1\)[^\n;]*var\s+\w+\s*:\s*texture_2d/g)) count++
  return Math.max(1, count)
}
