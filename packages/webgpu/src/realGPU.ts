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
  onDeviceLost?: (reason: string) => void,
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

  // ─── Task 175 — THE DEVICE-LOSS WIRE (gated: real hardware only) ──────
  // device.lost is the ONE spec channel for a dead WebGPU device: a GPU
  // process crash, an adapter removal, a driver reset. The uncapturederror
  // listener above goes DEAD on a lost device: validation errors stop
  // surfacing, submits silently no-op, and the renderer would keep
  // "rendering" a frozen canvas forever. The renderer wires this callback
  // into a FATAL storm pause — one report, immediate, no counting to three.
  //
  // THE GATE — the subscription itself is a hazard on known-broken
  // software stacks: the container's SwiftShader+Vulkan Chrome destroys
  // the whole instance the moment ANY handler subscribes to device.lost
  // (traced raw: two devices, subscribe one — reason 'destroyed' at +2ms,
  // the sibling's next submit throws "external Instance no longer
  // exists"; the same stack also lets devices die unwatched right after
  // their first present — every "copy fails after presents" symptom this
  // task chased was a copy landing on an ALREADY-dead device). The
  // adapter's info names those stacks (vendor 'google' / architecture
  // 'swiftshader'; llvmpipe and lavapipe likewise) — on them the
  // subscription is SKIPPED and the copy armor (the sync-throw report on
  // copyExternalImageToTexture, the first call that notices a dead
  // device) carries the detection instead. On real hardware the
  // subscription is the spec channel and is safe — every major WebGPU
  // application subscribes. Our own dispose() also fires device.lost
  // (reason 'destroyed'); the facadeDisposed flag flips before
  // device.destroy() runs, so the expected teardown stays silent.
  const adapterInfo = (adapter as GPUAdapter & {
    info?: { vendor?: string; architecture?: string; device?: string; description?: string }
  }).info
  const softwareAdapter = adapterInfo !== undefined
    && /swiftshader|llvmpipe|lavapipe|software|basicrender/i
      .test(`${adapterInfo.vendor ?? ''} ${adapterInfo.architecture ?? ''} ${adapterInfo.device ?? ''} ${adapterInfo.description ?? ''}`)
  if (!softwareAdapter) {
    device.lost.then((info: GPUDeviceLostInfo) => {
      if (facadeDisposed) return // our own teardown — the expected path
      onDeviceLost?.(info.reason)
    })
  }

  // ─── Task 174 — THE MULTI-DRAW TIER's capability probe ────────────────
  // drawIndirectCount was dropped from the WebGPU spec and ships nowhere
  // in Chrome through 151 (probed in this container: the prototype lacks
  // it; plain drawIndirect IS present; @webgpu/types@0.1.72 does not even
  // declare it). PRESENCE == CAPABILITY is the facade's contract: the
  // multiDraw method is exposed IFF the encoder has it, so the executor
  // arms the indirect shape exactly where the browser can and rides the
  // fast-path floor everywhere else. Probed ONCE here — a prototype
  // method does not appear mid-session. (The cast: the tracking types
  // cannot declare a method the spec dropped; the probe is the truth.)
  const encoderProto = typeof GPURenderPassEncoder === 'function'
    ? GPURenderPassEncoder.prototype as GPURenderPassEncoder & { drawIndirectCount?: (indirectBuffer: GPUBuffer, indirectOffset: number, countBuffer: GPUBuffer, countOffset: number, maxDrawCount: number) => void }
    : null
  const hasDrawIndirectCount = encoderProto !== null && typeof encoderProto.drawIndirectCount === 'function'

  const context = canvas.getContext('webgpu') as GPUCanvasContext | null
  if (context === null) throw new Error('rune: webgpu canvas context unavailable')
  const gpuContext: GPUCanvasContext = context
  const format = navigator.gpu.getPreferredCanvasFormat()

  const textureRecords: (TextureRecord | undefined)[] = [undefined] // Task 145: dense ids from 1 — array index instead of Map.get
  const textureViews = new Map<number, { textureId: number; view: GPUTextureView }>()
  // Task 69: the pipeline is cached by SPEC + VARIANTS of the texture
  // binding's sampleType. The 'float' variant (sampler 'filtering' +
  // texture 'float') is the default; 'unfilterable-float' (sampler
  // 'non-filtering' + texture 'unfilterable-float') is created lazily in
  // bindTexture on the first bind of rgba32float without the
  // 'float32-filterable' feature. The pipeline layout and bind group must
  // match in sampleType — otherwise setBindGroup validation fails.
  const pipelineRecords: (PipelineRecord | undefined)[] = [undefined] // Task 145: dense ids from 1 — array index instead of Map.get (per-draw lookup: usePipeline + pipelineOfTexture + flushTextureBindGroup)
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
  // The CANVAS clear (target 0): set via setCanvasClearColor (the renderer's
  // `clear` option). The legacy default matches the GL facade's DEFAULT_CLEAR —
  // before Task 116 this was hardcoded inline in bindTarget, so the user's
  // clear color silently never reached the WebGPU canvas (the same demo
  // rendered a ~4.5× lighter background on WebGPU than on WebGL2).
  let canvasClearR = 0.07
  let canvasClearG = 0.08
  let canvasClearB = 0.11
  let canvasClearA = 1
  let canvasDepthClear = 1
  let depthTexture: GPUTexture | null = null
  let depthView: GPUTextureView | null = null
  let ubo: GPUBuffer | null = null
  let uboSize = 0
  // Task 178: the max (offset + length) ever uploaded — the span the
  // dynamic-offset binds must fit against (see uploadUniforms).
  let uboSpanSeen = 0
  let uboGroup: GPUBindGroup | null = null
  // The dynamic-offset binding window: the bind group exposes [offset,
  // offset + window) of the UBO to the pipeline. Dawn validates it against
  // the shader's uniform block — a hardcoded 256-byte window rejected every
  // draw whose block is larger (the skinned model-viewer: "binding ... is
  // too small; the pipeline requires at least 4448 bytes" → Invalid
  // CommandBuffer → rendering stopped). The window grows to the largest
  // uniform slice ever uploaded, rounded to the 256-byte dynamic-offset
  // granularity.
  let uboBindingWindow = 256
  let encoder: GPUCommandEncoder | null = null
  let pass: GPURenderPassEncoder | null = null
  let currentPipeline: GPURenderPipeline | null = null
  let currentPipelineId = -1
  let currentTarget = 0
  // Task 172 — THE DEPTH-LESS PASS AXIS: a pipeline that declares a
  // depthStencil format is INVALID in a render pass without that depth
  // attachment (spec: "the pipeline's depthStencil format must match the
  // pass's depthStencil attachment" — Chrome 150's Dawn enforces it: a
  // phone field report's «Attachment state of RenderPipeline is not
  // compatible with RenderPassEncoder» → three errors → the storm pause;
  // the container's older Dawn does NOT, which is why local gates
  // passed while the phone died). Pipelines now carry a per-DEPTH-PRESENCE
  // variant (× the Task-69 sampleType variants), chosen at bind time from
  // the CURRENT pass's attachment state — bindTarget owns this flag.
  let passHasDepth = true
  // Task 164 — THE MERGED COMPUTE PASS: runCompute used to open AND close a
  // GPUComputePassEncoder per call — the bitonic sort loop dispatches ~171
  // times per frame (Task 179 halved the 342: the sortStep twin per pass
  // is dead), so the frame paid ~342 begin/end pairs that all carried the
  // SAME pass state. Consecutive dispatches now share ONE pass: it opens on
  // the first runCompute and closes where the frame's structure demands it
  // — before a render pass opens (bindTarget), before submit, before an
  // encoder-level copy (readTargetPixels). Ordering between dispatches is a
  // WebGPU guarantee (each dispatch is its own sync scope; the
  // implementation barriers read-after-write on storage buffers — the
  // property the whole barrier-free API is built on), so merging cannot
  // reorder effects.
  let computePass: GPUComputePassEncoder | null = null
  // Task 164 — the compute bind-group memo: setBindGroup(0, family.group)
  // was re-asserted per dispatch; one family's dispatches share one group,
  // so the sort loop re-set the SAME group ~342 times per frame.
  let computeGroup: GPUBindGroup | null = null
  // Task 179 — the compute PIPELINE memo: setPipeline was re-asserted per
  // dispatch as well (the pre-179 alternating (bitonic, sortStep) entries
  // made EVERY dispatch a pipeline switch; with the clock folded into
  // bitonic, the sort loop's 171 dispatches ride ONE pipeline — the memo
  // turns 171 setPipeline calls into 1). Reset with the group memo at
  // every fresh pass (a fresh encoder binds nothing until told).
  let computePipeline: GPUComputePipeline | null = null
  // Task 164 — THE VERTEX-BIND MEMO: the executor re-binds every command's
  // attribute buffers per draw (the Task-75b state discipline — the same
  // re-assert that GL's Task 163 unit-bind cache already dedupes). Within a
  // render pass, pass.setVertexBuffer(slot, buffer) with the slot's already-
  // bound buffer is a pure no-op: skipped here. The memo dies at every pass
  // boundary (a fresh pass encoder binds nothing until told) — the GL twin
  // of Task 163's cache, with the same pass-scoped honesty.
  const vertexBindMemo: (GPUBuffer | undefined)[] = []
  // Task 164 — THE SAB STAGING CACHE: guardedWriteVertex copied SAB-backed
  // vertex feeds into a FRESH Uint8Array every frame (WebGPU forbids shared
  // memory in writeBuffer) — a ~MB-scale allocation per frame per feed, i.e.
  // sustained GC churn for T1/T2-style shared feeds. The staging buffer is
  // now cached per source view and grown on demand; only the copy itself
  // (unavoidable) remains per frame.
  const sabStaging = new Map<Float32Array, Uint8Array<ArrayBuffer>>()
  /** Multi-textures (Nefertiti model base+normal): command textures
   *  accumulate via bindTexture, the bind group is fixed in draw(). */
  const pendingTextureIds: number[] = []
  /** Scratch for setBindGroup dynamic offsets (a typed array is a valid
   *  sequence for the WebGPU API; avoids an array allocation per draw). */
  const dynamicOffsetScratch = new Uint32Array(1)
  // Task 165 — THE GROUP-0 OFFSET MEMO (see bindUniforms): the dynamic offset
  // of the LAST setBindGroup(0) on the CURRENT render pass (-1 = none). The
  // skip is legal because the shared group-0 layout is byte-identical across
  // every pipeline (structurally equal layouts are pipeline-compatible), so
  // the binding survives pipeline switches; a fresh pass / a rebuilt group
  // object re-arms it.
  let boundGroup0Offset = -1
  // Task 165 — THE GROUP-1 ASSERT MEMO (see flushTextureBindGroup): the group
  // object last bound on set 1 of the CURRENT pass (null = none). Only an
  // EXACT group-object repeat is skipped — a different command's flush
  // re-binds, so a stale group can never survive a texture-set change.
  let boundGroup1: GPUBindGroup | null = null
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
    textureRecords[id] = { texture, sampler, view: texture.createView(), format: gpuFormat, filterable }
    return id
  }

  function texSubImage2D(textureId: number, x: number, y: number, w: number, h: number, bytes: Uint8Array): void {
    const record = textureRecords[textureId]
    if (record === undefined) return
    // Task 67 HDR: bytesPerRow depends on the format (rgba16float — 8 B/pixel,
    // rgba32float — 16). The caller prepares the data: the bytes length must
    // be w*h*bytesPerPixel of the format.
    const bytesPerPixel = record.format === 'rgba16float' ? 8 : record.format === 'rgba32float' ? 16 : 4
    // Task 120 — THE WEBGPU ROW ALIGNMENT: bytesPerRow MUST be a multiple of
    // 256 (spec validation). w*4 is aligned only by luck (w=64 → 256, w=128 →
    // 512); any other width (w=100 → 400) fails validation and the write is
    // SILENTLY dropped via the error scope — the texture stays empty and the
    // caller sees nothing (the raw-byte sprite regression class). Fix: repack
    // the rows into a padded buffer when the natural row is unaligned.
    const rowBytes = w * bytesPerPixel
    const alignedRow = Math.ceil(rowBytes / 256) * 256
    let data: Uint8Array = bytes
    if (alignedRow !== rowBytes && h > 1) {
      data = new Uint8Array(alignedRow * h)
      for (let row = 0; row < h; row++) {
        data.set(bytes.subarray(row * rowBytes, (row + 1) * rowBytes), row * alignedRow)
      }
    }
    device.queue.writeTexture(
      { texture: record.texture, origin: { x, y, z: 0 } },
      data as Uint8Array<ArrayBuffer>,
      { bytesPerRow: alignedRow, rowsPerImage: h },
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
    const record = textureRecords[textureId]
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
    //
    // Task 116 — the ALPHA CONTRACT, pinned explicitly: the destination is
    // GPUImageCopyTextureTagged with premultipliedAlpha: false (the spec
    // default, now written out). Canvas/ImageBitmap sources store
    // PREMULTIPLIED pixels; with this tag the implementation UN-premultiplies
    // (rgb /= a) during the copy, so the texture holds STRAIGHT alpha.
    // WebGL2's texImage2DFromSource has no un-premultiply hardware path — it
    // uploads the source bytes as-is. Cross-backend parity therefore requires
    // the SOURCE to be straight-alpha: for canvas-derived bitmaps pass
    // createImageBitmap(canvas, { premultiplyAlpha: 'none' }) — the browser
    // un-premultiplies at bitmap creation (see the particles demo sprite).
    //
    // Task 175 — THE COPY ARMOR: on some stacks this call dies with a SYNC
    // TypeError ("Failed to copy content from external image") once the
    // device has presented a frame — the container's SwiftShader+Vulkan
    // Chrome is the documented case, traced with a raw-WebGPU matrix (0
    // presents → the copy works; any present → the copy throws AND the
    // WebGPU instance dies with it: device.lost fires, every later submit
    // silently no-ops). The throw is reported through the GPU error
    // channel so the renderer's storm sees it, then RETHROWN — the
    // caller's own catch keeps its error UX (model-viewer's "Failed to
    // load ..."), and the device-lost wire pauses the loop honestly.
    try {
      device.queue.copyExternalImageToTexture(
        { source: source as GPUCopyExternalImageSource, flipY: flipY === true },
        { texture: record.texture, mipLevel: 0, origin: { x: dstX, y: dstY, z: 0 }, premultipliedAlpha: false },
        { width: copyWidth, height: copyHeight, depthOrArrayLayers: 1 },
      )
    } catch (error) {
      onGpuError?.(`copyExternalImageToTexture rejected: ${errorMessage(error)} — the texture was NOT uploaded (the device may be lost; check for a device-loss report)`)
      throw error
    }
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
    const record = textureRecords[textureId]
    if (record === undefined) return
    // WebGPU copyExternalImageToTexture with destination.mipLevel=level.
    // The source must have size N/(2^level). WebGPU will check it itself —
    // on mismatch there will be a validation error (asynchronously in onGpuError).
    // flipY — see copyExternalImageToTexture above (GPUCopyExternalImageSourceInfo.flipY).
    // Task 116: premultipliedAlpha: false — the same straight-alpha contract
    // as copyExternalImageToTexture (see the comment there).
    // Task 175 — THE COPY ARMOR: the same sync-throw report + rethrow as the
    // mip-0 twin (see the comment there).
    try {
      device.queue.copyExternalImageToTexture(
        { source: source as GPUCopyExternalImageSource, flipY: flipY === true },
        { texture: record.texture, mipLevel, origin: { x: dstX, y: dstY, z: 0 }, premultipliedAlpha: false },
        { width: copyWidth, height: copyHeight, depthOrArrayLayers: 1 },
      )
    } catch (error) {
      onGpuError?.(`copyExternalImageToTextureMip (level ${mipLevel}) rejected: ${errorMessage(error)} — the texture was NOT uploaded (the device may be lost; check for a device-loss report)`)
      throw error
    }
  }

  function uploadUniforms(offset: number, data: Uint8Array, bindingWindow?: number): void {
    // The window must cover the WHOLE slice (the shader's uniform block +
    // any padding up to it) for the pipeline to accept the binding, and the
    // buffer must fit offset + window for the dynamic-offset range check.
    // Task 178 — THE MERGED UPLOAD: bindingWindow is the executor's MAX
    // per-slice window for a coalesced run (the merged data can be LONGER
    // than any single block — the range check still needs only the largest
    // block; a merged-length window would over-provision and could push
    // tail slices out of the buffer). Omitted — the call's own length.
    const window = bindingWindow ?? Math.ceil(data.length / 256) * 256
    if (window > uboBindingWindow) {
      uboBindingWindow = window
      uboGroup = null // rebuilt with the larger window in ensureUBO
    }
    // Task 178 — THE SPAN SIZING: EVERY live slice's dynamic-offset bind
    // validates offset + uboBindingWindow ≤ uboSize. The pre-178 form only
    // ensured THIS call's offset — a tail slice (bound AFTER a big-window
    // slice grew the global window) was a latent Dawn validation error
    // (the error-storm pause class). The max span seen + the window covers
    // every slice base ≤ span — a one-time ≤ window bytes over-provision.
    const extent = offset + data.length
    if (extent > uboSpanSeen) uboSpanSeen = extent
    ensureUBO(uboSpanSeen + uboBindingWindow)
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
    const grow = ubo === null || rounded > uboSize
    if (!grow && uboGroup !== null) return
    if (grow) {
      const size = Math.max(65536, rounded)
      const next = device.createBuffer({ size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      if (ubo !== null) ubo.destroy()
      ubo = next
      uboSize = size
      uboGroup = null
      // Task 178: the UBO OBJECT feeds only the bind GROUP (rebuilt below)
      // — the pipeline objects hold the group-0 LAYOUT, which is
      // byte-identical across builds ("structurally equal layouts are
      // pipeline-compatible"), and the executor's pipelineReady flags are
      // NOT reset by a facade-side wipe. The pre-178 pipelineRecords wipe
      // here was a correctness hazard: usePipeline silently returned on
      // the missing record (pipelineReady still true → ensurePipeline
      // never re-ran → pass.setPipeline NEVER called for already-drawn
      // commands). The group rebuild + boundGroup0Offset = -1 below are
      // the only state that must follow the new buffer.
      currentPipeline = null // force one re-assert (harmless; the pass is closed during uploads)
    }
    // The shared group-0 bind group: the binding covers the window (not a
    // fixed 256 B). The BGL descriptor is byte-identical to buildPipeline's
    // group0 — structurally equal layouts are pipeline-compatible.
    const layout = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform', hasDynamicOffset: true },
      }],
    })
    uboGroup = device.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: { buffer: ubo!, size: uboBindingWindow } }],
    })
    // Task 165 — a NEW group-0 OBJECT: the offset memo must not skip the
    // next bind onto the OLD group still sitting on the pass.
    boundGroup0Offset = -1
  }

  function ensurePipeline(pipelineId: number, wgsl: string, attrs: readonly GpuAttrSlot[], hasTextures: boolean, desc?: GpuPipelineDesc): void {
    if (pipelineRecords[pipelineId] !== undefined) return
    const record: PipelineRecord = {
      wgsl,
      attrs,
      hasTextures,
      // Multi-textures: layout group 1 is built from the DECLARED @binding
      // numbers of the texture_2d declarations in WGSL, in declaration
      // order (Task 126: the materials reserve tex@1, nrm@2, mat@3, mr@4,
      // depth@5 — a sequential 1..N layout only matches prefix sets and
      // broke SOFT_PARTICLES, whose set is {1, 5}: "Binding doesn't exist in
      // [BindGroupLayout]" → an invalid pipeline → the error storm pause).
      textureBindings: hasTextures ? group1TextureBindings(wgsl) : [],
      // The count (kept for the memo keys / diagnostics): the number of
      // texture_2d declarations in group 1.
      textureCount: hasTextures ? countGroup1TextureBindings(wgsl) : 0,
      desc: desc ?? {},
      // Task 145: the two lazy variant slots as nullable fields (a Map per
      // record with string keys cost a hash lookup per draw; the variant set
      // is exactly two — 'float' and 'unfilterable-float'). Task 172 adds the
      // depth-presence twins (lazy: only pipelines actually bound in a
      // depth-less pass pay the build).
      variantFloat: null,
      variantUnfilterable: null,
      variantFloatNoDepth: null,
      variantUnfilterableNoDepth: null,
    }
    pipelineRecords[pipelineId] = record
    // The default 'float' variant — filterable textures (all except
    // rgba32float on devices without 'float32-filterable'). Eagerly built
    // WITH depth (the canvas default); the depth-less twins stay lazy.
    record.variantFloat = buildPipeline(record, 'float', true)
  }

  /** Task 69: build a pipeline for a specific texture binding sampleType.
   *  'float' → sampler 'filtering' + texture 'float' (LINEAR filtering);
   *  'unfilterable-float' → sampler 'non-filtering' + texture
   *  'unfilterable-float' (NEAREST; the only legal way to sample
   *  rgba32float without feature 'float32-filterable'). WGSL must use
   *  textureSampleLevel (textureSample requires a filterable texture).
   *  Task 172: withDepth=false — the depth-less pass twin (NO depthStencil
   *  on the pipeline; a declared format is incompatible with a pass that
   *  carries no depth attachment — a phone field report's storm pause). */
  function buildPipeline(
    record: { wgsl: string; attrs: readonly GpuAttrSlot[]; hasTextures: boolean; textureBindings: readonly number[]; textureCount: number; desc: GpuPipelineDesc },
    variant: TextureSampleVariant,
    withDepth: boolean,
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
      // Task 126: the texture entries sit at their DECLARED @binding
      // numbers (declaration order), NOT sequentially 1..N — the materials
      // reserve tex@1, nrm@2, mat@3, mr@4, depth@5, and only prefix sets
      // coincide with a sequential layout. All textures of the command
      // share one sampler (binding 0).
      const textureEntries: { binding: number; visibility: number; texture: { sampleType: TextureSampleVariant } }[] = []
      for (const binding of record.textureBindings.length > 0 ? record.textureBindings : [1]) {
        textureEntries.push({
          binding,
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
          // Task 122: the equation follows the desc (absent = 'add'); the
          // facade BlendEquation names ARE the GPUBlendOperation names.
          blend: desc.blend === undefined || desc.blend === false ? undefined : {
            color: { srcFactor: desc.blend.src as GPUBlendFactor, dstFactor: desc.blend.dst as GPUBlendFactor, operation: (desc.blend.equation ?? 'add') as GPUBlendOperation },
            alpha: { srcFactor: desc.blend.src as GPUBlendFactor, dstFactor: desc.blend.dst as GPUBlendFactor, operation: (desc.blend.equation ?? 'add') as GPUBlendOperation },
          },
        }],
      },
      primitive: {
        // Task 167 — the topology mapping twin: 'lines'/'points' were
        // silently drawn as triangle-list (the GL-side fossil's twin — the
        // PrimitiveKind type promised them; only 'triangle-strip' was
        // honored). Nothing in the repo records a line/point pipeline
        // today, so nobody's pixels change.
        topology: desc.primitive === 'triangle-strip'
          ? 'triangle-strip'
          : desc.primitive === 'lines'
            ? 'line-list'
            : desc.primitive === 'points'
              ? 'point-list'
              : 'triangle-list',
        cullMode: desc.raster?.cull === 'back' || desc.raster?.cull === 'front' ? desc.raster.cull : 'none',
        frontFace: desc.raster?.frontFace === 'cw' ? 'cw' : 'ccw',
      },
      // Task 75 + Task 172: depth from the descriptor AND the pass kind. A
      // pipeline bound in a pass WITH a depth attachment (the canvas — it
      // always carries one; a depth:true target) declares a compatible
      // depthStencil: "disabled" depth = write:false + compare:'always'. A
      // pipeline bound in a DEPTH-LESS pass (a depth:false target) declares
      // NO depthStencil at all — the format would be a validation error
      // there (a phone field report: a post chain's scene surface).
      depthStencil: withDepth ? {
        format: 'depth24plus',
        depthWriteEnabled: desc.depth === false ? false : (desc.depth?.write ?? true),
        depthCompare: desc.depth === false ? 'always' : depthCompareOf(desc.depth?.test),
      } : undefined,
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
    const record = pipelineRecords[pipelineId]
    if (record === undefined) return
    currentPipelineId = pipelineId
    // New command — accumulated textures are reset (the bind group is
    // built in draw() from the current command's set)
    pendingTextureIds.length = 0
    // The default 'float' variant; bindTexture will switch to
    // 'unfilterable-float' if an rgba32float without the feature is bound.
    setPipelineVariant(record, 'float')
  }

  /** Set the pipeline variant (created lazily on first use). Task 172: the
   *  variant space is sampleType × DEPTH PRESENCE of the current pass — a
   *  depth-less pass binds the depth-less twin of the same pipeline (a
   *  pipeline WITH depthStencil is a validation error there, see
   *  passHasDepth's declaration). */
  function setPipelineVariant(
    record: { wgsl: string; attrs: readonly GpuAttrSlot[]; hasTextures: boolean; textureBindings: readonly number[]; textureCount: number; desc: GpuPipelineDesc; variantFloat: GPURenderPipeline | null; variantUnfilterable: GPURenderPipeline | null; variantFloatNoDepth: GPURenderPipeline | null; variantUnfilterableNoDepth: GPURenderPipeline | null },
    variant: TextureSampleVariant,
  ): void {
    let pipeline: GPURenderPipeline | null
    if (passHasDepth) {
      pipeline = variant === 'float' ? record.variantFloat : record.variantUnfilterable
      if (pipeline === null) {
        pipeline = buildPipeline(record, variant, true)
        if (variant === 'float') record.variantFloat = pipeline
        else record.variantUnfilterable = pipeline
      }
    } else {
      pipeline = variant === 'float' ? record.variantFloatNoDepth : record.variantUnfilterableNoDepth
      if (pipeline === null) {
        pipeline = buildPipeline(record, variant, false)
        if (variant === 'float') record.variantFloatNoDepth = pipeline
        else record.variantUnfilterableNoDepth = pipeline
      }
    }
    if (pipeline === currentPipeline) return
    currentPipeline = pipeline
    pass?.setPipeline(pipeline)
  }

  function bindUniforms(dynamicOffset: number): void {
    // Task 165 — THE GROUP-0 OFFSET MEMO (pass-scoped, the render-path twin
    // of Task 164's compute memos): every draw re-issued setBindGroup(0, …)
    // even when the dynamic offset was UNCHANGED — consecutive draws of the
    // same command (multi-record draws, layer passes) re-asserted the exact
    // same binding. The memo skips the identical re-assert within one pass;
    // it dies at every pass boundary (bindTarget/endPass/readTargetPixels)
    // and when ensureUBO rebuilds the group OBJECT (the old group on the
    // pass would otherwise be skipped onto forever). The shared group-0
    // layout is byte-identical across pipelines — the bind survives
    // pipeline switches, so the memo does not key on the pipeline.
    if (pass !== null && dynamicOffset === boundGroup0Offset) return
    // Scratch buffer instead of a fresh [offset] array per draw — the array
    // crosses an external API boundary, so the allocator cannot elide it.
    dynamicOffsetScratch[0] = dynamicOffset
    pass?.setBindGroup(0, uboGroup!, dynamicOffsetScratch)
    if (pass !== null) boundGroup0Offset = dynamicOffset
  }

  function bindVertexBuffer(slot: number, data: Float32Array, _size: number): void {
    let buffer = vertexBuffers.get(data)
    if (buffer === undefined) {
      buffer = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
      guardedWriteVertex(buffer, data, data.byteLength)
      vertexBuffers.set(data, buffer)
    }
    // Task 164 — the vertex-bind memo (see its declaration): an identical
    // re-bind inside the same render pass is skipped; a fresh pass resets
    // the memo (bindTarget), so the first bind of every pass is real.
    if (pass === null) return
    if (vertexBindMemo[slot] === buffer) return
    pass.setVertexBuffer(slot, buffer)
    vertexBindMemo[slot] = buffer
  }

  /** M5 (Task 73): the feed's dynamic vertex buffer — writeBuffer in a
   *  single call per frame with the dirty range. The key is the feed
   *  renderer's stable Float32Array (SAB view / T3 mirror). Binding —
   *  later, via bindVertexBuffer (the same keyed cache, no repeated write).
   *  Task 178 — THE UPLOAD WIRE: byteOffset lands the DIRTY WINDOW
   *  [byteOffset, byteOffset+byteLength) — the pre-178 shape re-uploaded
   *  the full prefix [0, published·stride) every frame (O(total records)
   *  per frame: 10.24 MB/frame at a 160k×64 B feed, ~614 MB/s of queue
   *  traffic at 60 fps — measured, bench/ab-upload.ts); the GL twin always
   *  shipped the window. Append-only contract: the offset is the synced
   *  mark, the length is the append — the same clamps and guards apply. */
  function syncVertexBuffer(data: Float32Array, byteLength: number, byteOffset = 0): void {
    let buffer = vertexBuffers.get(data)
    if (buffer === undefined) {
      buffer = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
      vertexBuffers.set(data, buffer)
    }
    if (byteLength <= 0) return
    guardedWriteVertex(buffer, data, byteLength, byteOffset)
  }

  /** Task 75: guarded vertex buffer write. Three lines of defense:
   *  (1) clamp byteLength to the GPU buffer's remaining window (data
   *      .byteLength may grow/diverge from the cache key under stress);
   *  (2) copy the SAB view into a plain ArrayBuffer (WebGPU forbids shared
   *      memory in writeBuffer — T1/T2 feeds);
   *  (3) try/catch around writeBuffer — a synchronous validation error
   *      ("Number of bytes to write is too large", non-multiple of 4 etc.)
   *      goes to onGpuError, the frame CONTINUES, the demo does not crash.
   *  Task 178 — THE UPLOAD WIRE: byteOffset is the dirty window's base
   *      (append-only feeds: synced·stride; the first upload is 0). The
   *      staging copy sizes to the WINDOW, the source view starts at
   *      data.byteOffset + byteOffset, writeBuffer lands at the offset.
   *  ⚠️ Call forms: TypedArray → dataOffset/size in ELEMENTS; ArrayBuffer →
   *      in BYTES (GPUQueue.writeBuffer spec). */
  function guardedWriteVertex(buffer: GPUBuffer, data: Float32Array, byteLength: number, byteOffset = 0): void {
    // (1) clamp: write no more than the GPU buffer's remaining window.
    const capped = Math.min(byteLength, buffer.size - byteOffset)
    if (capped !== byteLength) {
      onGpuError?.(`writeBuffer(vertex) clamp: ${byteLength} → ${capped} bytes (buffer size ${buffer.size})`)
    }
    if (capped <= 0) return
    try {
      const isSabView = typeof SharedArrayBuffer !== 'undefined' && data.buffer instanceof SharedArrayBuffer
      if (isSabView) {
        // capped — part of the write range (multiple of 4); copied into the
        // REUSED staging buffer (Task 164 — see sabStaging's declaration:
        // the per-frame allocation was pure GC churn; the copy is the only
        // unavoidable part). Grown on demand; writeBuffer takes the element
        // offset/size form so a larger staging writes exactly `capped` bytes.
        let staging = sabStaging.get(data)
        if (staging === undefined || staging.byteLength < capped) {
          staging = new Uint8Array(new ArrayBuffer(capped))
          sabStaging.set(data, staging)
        }
        staging.set(new Uint8Array(data.buffer, data.byteOffset + byteOffset, capped))
        device.queue.writeBuffer(buffer, byteOffset, staging, 0, capped)
        return
      }
      if (byteOffset === 0 && data.byteOffset === 0 && capped === data.byteLength) {
        device.queue.writeBuffer(buffer, 0, data as Float32Array<ArrayBuffer>)
        return
      }
      // ArrayBuffer form: offset and size — in BYTES.
      device.queue.writeBuffer(buffer, byteOffset, data.buffer as ArrayBuffer, data.byteOffset + byteOffset, capped)
    } catch (error) {
      onGpuError?.(`writeBuffer(vertex, ${capped} bytes @${byteOffset}) rejected: ${errorMessage(error)}`)
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
    return currentPipelineId >= 0 ? pipelineRecords[currentPipelineId] : undefined
  }

  /** Texture/sub-view by id: view + sampler + filterability. Writes into a
   *  REUSED scratch record (hot path — one bindTexture per draw); the result
   *  must be consumed before the next call, never retained. */
  const resolveScratch = { view: null as GPUTextureView | null, sampler: null as GPUSampler | null, filterable: false }
  function resolveTexture(textureOrViewId: number): { view: GPUTextureView; sampler: GPUSampler; filterable: boolean } | undefined {
    // Task 145: the id namespaces are DISJOINT BY DOCUMENT (texture ids grow
    // from 1, sub-view ids from 1M) — the boundary check skips the
    // textureViews Map lookup (a guaranteed miss) for plain texture ids,
    // the per-bindTexture hot path. Parity with the old lookup order: a
    // view id always resolves through textureViews, a texture id — never.
    const subView = textureOrViewId >= SUB_VIEW_ID_BASE ? textureViews.get(textureOrViewId) : undefined
    if (subView !== undefined) {
      const record = textureRecords[subView.textureId]
      if (record === undefined) return undefined
      resolveScratch.view = subView.view
      resolveScratch.sampler = record.sampler
      resolveScratch.filterable = record.filterable
      return resolveScratch as { view: GPUTextureView; sampler: GPUSampler; filterable: boolean }
    }
    const record = textureRecords[textureOrViewId]
    if (record === undefined) return undefined
    resolveScratch.view = record.view
    resolveScratch.sampler = record.sampler
    resolveScratch.filterable = record.filterable
    return resolveScratch as { view: GPUTextureView; sampler: GPUSampler; filterable: boolean }
  }

  /** Multi-texture bind group: sampler@0 + each texture at its DECLARED
   *  @binding (the pipeline record's declaration order; missing slots —
   *  repeat of the last one). Cached by composition (id string + variant)
   *  — a set change = a new group. Hot path: a per-draw memo (pipelineId +
   *  ids, compared numerically) skips the string key and the Map lookup
   *  when the command repeats the same texture set — the common case. */
  let flushMemoBox: { pipelineId: number; count: number; ids: number[]; group: GPUBindGroup } | null = null
  function flushTextureBindGroup(): void {
    if (pendingTextureIds.length === 0) return
    if (pass === null) {
      pendingTextureIds.length = 0
      return
    }
    const record = pipelineOfTexture()
    // Task 126: the DECLARED bindings (declaration order) — the flush maps
    // the command's texture list (the reflection's declaration order) onto
    // the same slots the pipeline layout was built from. The fallback [1]
    // is the legacy single-texture contract.
    const bindings = record !== undefined && record.textureBindings.length > 0 ? record.textureBindings : [1]
    const count = bindings.length
    // Memo fast path: the same texture set on the same pipeline class —
    // bind the remembered group directly (no key string, no Map.get).
    const memo = flushMemoBox
    if (memo !== null && memo.pipelineId === currentPipelineId && memo.count === count
      && memo.ids.length === pendingTextureIds.length) {
      let same = true
      for (let at = 0; at < memo.ids.length; at++) {
        if (memo.ids[at] !== pendingTextureIds[at]) { same = false; break }
      }
      if (same) {
        // Task 165 — the group-1 assert memo: an EXACT group-object repeat
        // within the pass is skipped (the pass already holds it). A different
        // command between the two flushes re-bound → boundGroup1 differs →
        // this re-asserts; the stale-group class cannot exist.
        if (boundGroup1 !== memo.group) {
          pass.setBindGroup(1, memo.group)
          boundGroup1 = memo.group
        }
        pendingTextureIds.length = 0
        return
      }
    }
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
      for (let slot = 0; slot < count; slot++) {
        const id = pendingTextureIds[Math.min(slot, pendingTextureIds.length - 1)]
        const resolved = resolveTexture(id)
        if (resolved === undefined) {
          pendingTextureIds.length = 0
          return
        }
        entries.push({ binding: bindings[slot], resource: resolved.view })
      }
      const layout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: variant === 'float' ? 'filtering' : 'non-filtering' } },
          ...bindings.map((binding): GPUBindGroupLayoutEntry => ({
            binding,
            visibility: GPUShaderStage.FRAGMENT,
            texture: { sampleType: variant },
          })),
        ],
      })
      group = device.createBindGroup({ layout, entries })
      textureBindGroups.set(key, group)
    }
    pass.setBindGroup(1, group)
    boundGroup1 = group
    flushMemoBox = { pipelineId: currentPipelineId, count, ids: pendingTextureIds.slice(), group }
    pendingTextureIds.length = 0
  }

  function beginPass(_clearIndex: number): void {
    // Canvas pass = bindTarget(0, clear): the single target-switching path
    bindTarget(0, true)
  }

  function setCanvasClearColor(color: readonly [number, number, number, number], depth?: number): void {
    // Task 116: the renderer's `clear` option — stored as scalars, read in
    // bindTarget(0) when the pass descriptor is built. A call with a bad
    // (NaN / non-finite) color would poison EVERY frame's clear — validate
    // loudly (the facade's discipline: a silent bad clear is a "why is the
    // canvas black/white" bug).
    const [r, g, b, a] = color
    if (![r, g, b, a].every(v => Number.isFinite(v))) {
      throw new Error(`rune: setCanvasClearColor — the color must be finite rgba (got [${r}, ${g}, ${b}, ${a}])`)
    }
    if (depth !== undefined && !Number.isFinite(depth)) {
      throw new Error(`rune: setCanvasClearColor — depth must be a finite number (got ${depth})`)
    }
    canvasClearR = r
    canvasClearG = g
    canvasClearB = b
    canvasClearA = a
    canvasDepthClear = depth ?? 1
  }

  function createTarget(
    textureId: number,
    targetWidth: number,
    targetHeight: number,
    depth: boolean,
    color: readonly [number, number, number, number],
  ): number {
    const record = textureRecords[textureId]
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
    // Task 164 — a render pass opening is a structural boundary: the merged
    // compute pass must END before beginRenderPass (one pass per encoder at
    // a time), and the vertex-bind memo dies with the pass boundary (a
    // fresh pass encoder binds nothing until told).
    closeComputePass()
    vertexBindMemo.length = 0
    boundGroup0Offset = -1 // Task 165 — the bind-group memos die with the pass
    boundGroup1 = null
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
      // The canvas clear — setCanvasClearColor state (the renderer's `clear`
      // option; the legacy default 0.07/0.08/0.11 if never set).
      clearValue = { r: canvasClearR, g: canvasClearG, b: canvasClearB, a: canvasClearA }
      depthAttachment = depthView !== null ? {
        view: depthView,
        depthClearValue: canvasDepthClear,
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
    // Task 172 — the pass's depth presence drives the pipeline variant (see
    // passHasDepth's declaration): the first usePipeline after this re-picks.
    passHasDepth = depthAttachment !== undefined
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

  // ─── Task 174 — THE MULTI-DRAW TIER's indirect ring ────────────────────
  // Two persistent INDIRECT buffers: the args ring (512 × 16-byte draw
  // structs) and the count ring (512 × 4-byte draw counts). Each flush of
  // a batched run takes DISJOINT ring slots — the queue.writeBuffer calls
  // (args + count) enqueue during pass encoding, but WebGPU's queue is a
  // single ordered timeline: writes enqueued before the frame's submit
  // execute before it, and each flush's drawIndirectCount reads only ITS
  // OWN slots, so multiple flushes per submit cannot overwrite each
  // other's arguments. The cursor resets at submit() — the next frame's
  // writes are queue-ordered after this frame's draws, so reuse is safe.
  // A frame needing more than 512 batched draws (pathological — the cap
  // of one RUN is already 512) makes multiDraw return false; the executor
  // replays the classic per-draw path for that flush.
  let indirectArgsBuffer: GPUBuffer | null = null
  let indirectCountBuffer: GPUBuffer | null = null
  const INDIRECT_RING = 512
  let indirectRingSlot = 0
  const indirectCountScratch = new Uint32Array(1)

  function multiDraw(args: Uint32Array, drawCount: number): boolean {
    if (indirectRingSlot + drawCount > INDIRECT_RING) return false
    if (indirectArgsBuffer === null || indirectCountBuffer === null) {
      // Lazy creation — a session that never batches (no repeated
      // commands, the kill-switch, a browser without the method) never
      // allocates the rings.
      indirectArgsBuffer = device.createBuffer({
        size: INDIRECT_RING * 16,
        usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
      })
      indirectCountBuffer = device.createBuffer({
        size: INDIRECT_RING * 4,
        usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
      })
    }
    const byteOffset = indirectRingSlot * 16
    // the 5-arg writeBuffer form — dataOffset/size, no subarray views
    device.queue.writeBuffer(indirectArgsBuffer, byteOffset, args.buffer as ArrayBuffer, args.byteOffset, drawCount * 16)
    indirectCountScratch[0] = drawCount
    device.queue.writeBuffer(indirectCountBuffer, indirectRingSlot * 4, indirectCountScratch.buffer as ArrayBuffer, 0, 4)
    // (the cast mirrors the probe's: the spec dropped the method, the
    // probe proved THIS browser kept it — only callable when armed)
    ;(pass as (GPURenderPassEncoder & { drawIndirectCount?: (a: GPUBuffer, b: number, c: GPUBuffer, d: number, e: number) => void }) | null)?.drawIndirectCount?.(
      indirectArgsBuffer, byteOffset, indirectCountBuffer, indirectRingSlot * 4, drawCount,
    )
    indirectRingSlot += drawCount
    return true
  }

  function endPass(): void {
    if (pass !== null && timerHandle !== null) timerHandle.onEndPass(pass)
    pass?.end()
    pass = null
    // Task 164 — the vertex-bind memo is pass-scoped (see bindVertexBuffer).
    vertexBindMemo.length = 0
    // Task 165 — the bind-group memos die with the pass (see their
    // declarations): a fresh pass binds nothing until told.
    boundGroup0Offset = -1
    boundGroup1 = null
  }

  function submit(): void {
    if (encoder === null) return
    // Task 164 — the merged compute pass closes BEFORE the timer hook and
    // encoder.finish() (encoder-level ops — resolveQuerySet, copies — are
    // invalid while a pass is open, and the submit itself is the frame's
    // structural end).
    closeComputePass()
    // onSubmit BEFORE encoder.finish(): resolveQuerySet(BEGIN..END →
    // resolveBuffer) + copyBuffer(resolveBuffer → readBuffer for mapAsync).
    if (timerHandle !== null) timerHandle.onSubmit(encoder)
    device.queue.submit([encoder.finish()])
    encoder = null
    // Task 174 — the multi-draw ring resets at the frame's structural end:
    // the next frame's writeBuffer calls are queue-ordered AFTER this
    // submit, so the slots are free to reuse (the GPU consumed this
    // frame's args before any new write lands).
    indirectRingSlot = 0
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
      const record = textureRecords[target.textureId]
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
          vertexBindMemo.length = 0 // Task 164 — the memo is pass-scoped
          boundGroup0Offset = -1 // Task 165 — the bind-group memos too
          boundGroup1 = null
        }
        // Task 164 — encoder-level copies are invalid while a pass is open:
        // the merged compute pass (if one is mid-frame) ends here, landing
        // BEFORE the copy in the command stream — the readback observes
        // post-compute state, in submit order.
        closeComputePass()
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
    const record = textureRecords[textureId]
    if (record === undefined) return
    // Invalidate bind groups (including multi-texture compositions) that
    // involve this texture: on the next draw() the group will be recreated.
    if (flushMemoBox !== null && flushMemoBox.ids.includes(textureId)) flushMemoBox = null
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
    textureRecords[textureId] = undefined
  }

  /** Evicts from the cache all compositions containing the sub-view (viewId). */
  function invalidateTextureViewBindGroups(viewId: number): void {
    if (flushMemoBox !== null && flushMemoBox.ids.includes(viewId)) flushMemoBox = null
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
    const record = textureRecords[textureId]
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
    for (const record of textureRecords) {
      if (record !== undefined) record.texture.destroy()
    }
    textureRecords.length = 0
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
    uboBindingWindow = 256
    // 4. Vertex buffers — keyed by Float32Array
    for (const buf of vertexBuffers.values()) {
      buf.destroy()
    }
    vertexBuffers.clear()
    // 5. Pipelines: GPURenderPipeline has no destroy() — device.destroy()
    //    will free them implicitly. Clear the array to avoid dragging references.
    pipelineRecords.length = 0
    // 6. The active pass/encoder — reset it (device.destroy() will make
    //    submit throw, but we will not get there — nobody will call submit
    //    after dispose).
    encoder = null
    pass = null
    currentPipeline = null
    currentTarget = 0
    // Task 174 — the multi-draw ring buffers die with the facade (like the
    // GPGPU staging buffers — device.destroy() covers them, the explicit
    // destroy is the deterministic-parity arm of the same stroke).
    indirectArgsBuffer?.destroy()
    indirectArgsBuffer = null
    indirectCountBuffer?.destroy()
    indirectCountBuffer = null
    indirectRingSlot = 0
    // Task 164 — the merged-compute/staging/memo state dies with the facade.
    computePass = null
    computeGroup = null
    vertexBindMemo.length = 0
    boundGroup0Offset = -1 // Task 165 — the bind-group memos too
    boundGroup1 = null
    sabStaging.clear()
    // 7. Final: device.destroy() — deterministically frees ALL GPU memory
    //    of the device (textures/buffers/pipelines/samplers/texture-views),
    //    even what was not destroyed explicitly. After this the browser
    //    will close the canvas context. This is exactly the parity with
    //    WebGL2 loseContext + explicit release. QuerySet, resolveBuffer,
    //    readBuffer of GpuTimer — will also be freed by device.destroy()
    //    (they were created through this device).
    device.destroy()
  }

  // ─── Task 131: the GPGPU tier — external buffers + compute passes ───────
  // The contract (see docs/particles-optimization.md Phase 2): a caller-
  // owned buffer (STORAGE usage, optionally VERTEX|COPY_DST|COPY_SRC — the
  // facade stays usage-agnostic, the flags are the caller's), a compute
  // pipeline family over a FIXED five-binding layout (0 uniform, 1 rw
  // storage, 2 ro storage, 3 rw storage, 4 ro storage — one bind group for
  // all entries), and dispatches that MUST run before the render pass
  // opens (the frame callback's step() precedes record/draw by the tape
  // contract). Validation errors are loud (onGpuError), never silent.

  const externalBuffers = new Map<number, GPUBuffer>()
  let nextExternalId = 1

  function createExternalBuffer(byteLength: number, usage: number): number {
    if (!Number.isFinite(byteLength) || byteLength <= 0) {
      onGpuError?.(`createExternalBuffer: byteLength must be > 0 (got ${byteLength})`)
      return -1
    }
    const buffer = device.createBuffer({ size: Math.ceil(byteLength / 4) * 4, usage })
    const id = nextExternalId++
    externalBuffers.set(id, buffer)
    return id
  }

  function externalBufferOf(id: number): GPUBuffer | undefined {
    return externalBuffers.get(id)
  }

  function writeExternalBuffer(id: number, data: Float32Array | Uint32Array, byteOffset = 0, byteLength = data.byteLength): void {
    const buffer = externalBuffers.get(id)
    if (buffer === undefined) {
      onGpuError?.(`writeExternalBuffer(${id}): no such external buffer`)
      return
    }
    const capped = Math.min(byteLength, buffer.size - byteOffset)
    if (capped !== byteLength) {
      onGpuError?.(`writeExternalBuffer(${id}) clamp: ${byteLength} @${byteOffset} → ${capped} (buffer size ${buffer.size})`)
    }
    if (capped <= 0) return
    try {
      device.queue.writeBuffer(buffer, byteOffset, data.buffer as ArrayBuffer, data.byteOffset, capped)
    } catch (error) {
      onGpuError?.(`writeExternalBuffer(${id}, ${capped} bytes) rejected: ${errorMessage(error)}`)
    }
  }

  function readExternalBuffer(id: number, byteLength: number): Promise<Float32Array> {
    return new Promise((resolve, reject) => {
      const buffer = externalBuffers.get(id)
      if (buffer === undefined) {
        reject(new Error(`rune: readExternalBuffer(${id}) — no such external buffer`))
        return
      }
      const capped = Math.min(byteLength, buffer.size)
      const staging = device.createBuffer({ size: Math.max(16, Math.ceil(capped / 256) * 256), usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
      const enc = device.createCommandEncoder()
      enc.copyBufferToBuffer(buffer, 0, staging, 0, Math.ceil(capped / 4) * 4)
      device.queue.submit([enc.finish()])
      void staging.mapAsync(GPUMapMode.READ).then(() => {
        // NaN-safe: build from a copied byte view (the mapped range
        // detaches on unmap).
        const bytes = new Uint8Array(staging.getMappedRange().slice(0))
        staging.unmap()
        staging.destroy()
        resolve(new Float32Array(bytes.buffer, 0, Math.floor(capped / 4)))
      }, (error: unknown) => {
        staging.destroy()
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  function deleteExternalBuffer(id: number): void {
    const buffer = externalBuffers.get(id)
    if (buffer === undefined) return
    externalBuffers.delete(id)
    buffer.destroy()
  }

  function bindExternalVertexBuffer(slot: number, bufferId: number): void {
    const buffer = externalBuffers.get(bufferId)
    if (buffer === undefined) {
      onGpuError?.(`bindExternalVertexBuffer(${slot}, ${bufferId}): no such external buffer`)
      return
    }
    // Task 164 — the vertex-bind memo (same slot/same buffer re-bind skip).
    if (pass === null) return
    if (vertexBindMemo[slot] === buffer) return
    pass.setVertexBuffer(slot, buffer)
    vertexBindMemo[slot] = buffer
  }

  /** The compute family record: the module, the shared five-binding layout,
   *  the per-entry pipelines, the uniform staging + the ONE bind group. */
  interface ComputeFamily {
    readonly module: GPUShaderModule
    readonly layout: GPUBindGroupLayout
    readonly group: GPUBindGroup
    readonly uniform: GPUBuffer
    readonly uniformBytes: number
    readonly pipelines: Map<string, GPUComputePipeline>
    /** Task 164 — the uniform write-skip memo: the last uploaded float
     *  values (a COPY — the caller's scratch is reused and mutated). The
     *  sort loop re-asserts the frame-static block per dispatch (~342
     *  identical writeBuffer queue ops per frame — now one). */
    lastUniform: Float32Array | null
  }
  const computeFamilies = new Map<number, ComputeFamily>()
  let nextComputeId = 1

  function createCompute(wgsl: string, uniformBytes: number, bufferIds: readonly number[]): number {
    const module = device.createShaderModule({ code: wgsl })
    void module.getCompilationInfo().then(info => {
      for (const message of info.messages) {
        if (message.type === 'error') onGpuError?.(`compute WGSL: ${message.message} (line ${message.lineNum})`)
      }
    }).catch(() => {})
    // THE FIXED LAYOUT (the particles contract; other consumers follow the
    // same slots): 0 uniform / 1 rw storage / 2 ro storage / 3 rw storage /
    // 4 ro storage / 5 rw storage (Task 179 — the sort family's NETWORK
    // CLOCK). Entries may use a subset — a pipeline layout may declare more
    // than its entry reads — and the layout is sized by the bufferIds the
    // caller hands over (the four-buffer families keep the exact pre-179
    // five-entry layout; a bind group must carry an entry for EVERY layout
    // slot, so the layout never declares more than it binds).
    const STORAGE_TYPES = ['storage', 'read-only-storage', 'storage', 'read-only-storage', 'storage'] as const
    const bufferCount = Math.min(bufferIds.length, STORAGE_TYPES.length)
    const entries: GPUBindGroupLayoutEntry[] = [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ]
    for (let b = 0; b < bufferCount; b++) {
      entries.push({ binding: b + 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: STORAGE_TYPES[b] } })
    }
    const layout = device.createBindGroupLayout({ entries })
    const uniformSize = Math.max(16, Math.ceil(uniformBytes / 16) * 16)
    const uniform = device.createBuffer({ size: uniformSize, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    const groupEntries: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: uniform } }]
    for (let b = 0; b < bufferCount; b++) {
      const buffer = externalBuffers.get(bufferIds[b])
      if (buffer === undefined) {
        onGpuError?.(`createCompute: binding ${b + 1} — no external buffer ${bufferIds[b]}`)
        return -1
      }
      groupEntries.push({ binding: b + 1, resource: { buffer } })
    }
    const group = device.createBindGroup({ layout, entries: groupEntries })
    const id = nextComputeId++
    computeFamilies.set(id, { module, layout, group, uniform, uniformBytes: uniformSize, pipelines: new Map(), lastUniform: null })
    return id
  }

  // Task 164 — THE MERGED COMPUTE PASS (see the computePass declaration
  // comment): one pass per run of consecutive dispatches.
  function ensureComputePass(): GPUComputePassEncoder {
    if (computePass === null) {
      encoder ??= device.createCommandEncoder()
      computePass = encoder.beginComputePass()
      computeGroup = null // a fresh pass binds nothing until told
      computePipeline = null // Task 179 — the pipeline memo dies with the pass
    }
    return computePass
  }

  /** Ends the merged compute pass (a no-op when none is open). Called
   *  before a render pass opens, before submit, and before encoder-level
   *  copies — the frame's structural boundaries. */
  function closeComputePass(): void {
    if (computePass !== null) {
      computePass.end()
      computePass = null
    }
  }

  // Task 133 — the compute family teardown: the staging uniform buffer is
  // the only explicitly-destroyable resource (modules/layouts/bind groups/
  // pipelines are GC'd with the entry). Idempotent; a no-op for a family
  // that never existed (the facade's own delete discipline).
  function deleteCompute(computeId: number): void {
    const family = computeFamilies.get(computeId)
    if (family === undefined) return
    computeFamilies.delete(computeId)
    try {
      family.uniform.destroy()
    } catch {
      // an already-destroyed buffer (device loss) — the entry is gone either way
    }
  }

  function runCompute(computeId: number, entry: string, uniformData: Float32Array, workgroups: number): void {
    const family = computeFamilies.get(computeId)
    if (family === undefined) {
      onGpuError?.(`runCompute(${computeId}): no such compute family`)
      return
    }
    if (pass !== null) {
      onGpuError?.(`runCompute(${entry}): a render pass is open — compute must run BEFORE the frame's draws (the tape contract: step() in the frame callback, record/draw after)`)
      return
    }
    let pipeline = family.pipelines.get(entry)
    if (pipeline === undefined) {
      try {
        pipeline = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [family.layout] }), compute: { module: family.module, entryPoint: entry } })
      } catch (error) {
        onGpuError?.(`createComputePipeline(${entry}) rejected: ${errorMessage(error)}`)
        return
      }
      family.pipelines.set(entry, pipeline)
    }
    // the uniform write (clamped to the staging size — a struct change
    // between calls is a caller bug, reported once, never fatal)
    const bytes = Math.min(uniformData.byteLength, family.uniformBytes)
    if (uniformData.byteLength > family.uniformBytes) {
      onGpuError?.(`runCompute(${entry}) uniform clamp: ${uniformData.byteLength} → ${family.uniformBytes} bytes (the staging was sized at createCompute)`)
    }
    // Task 164 — THE UNIFORM WRITE-SKIP MEMO: the frame-static block
    // (the sort loop's count/padN/forward/planes — every dispatch of the
    // family re-asserts it) uploads ONCE; a changed field uploads again.
    // The compare is over the clamped write range; NaN fields compare
    // unequal and fall back to a real write (conservative, never wrong).
    // Last-write-wins semantics are preserved exactly: a skipped write
    // means the GPU already holds those bytes.
    const floats = bytes >> 2
    const last = family.lastUniform
    let skipWrite = false
    if (last !== null && last.length === floats) {
      const base = uniformData.byteOffset >> 2
      skipWrite = true
      for (let i = 0; i < floats; i++) {
        if (last[i] !== uniformData[base + i]) { skipWrite = false; break }
      }
    }
    if (!skipWrite) {
      device.queue.writeBuffer(family.uniform, 0, uniformData.buffer as ArrayBuffer, uniformData.byteOffset, bytes)
      family.lastUniform = uniformData.slice(0, floats)
    }
    if (workgroups <= 0) return
    // Task 164/179 — dispatches accumulate in the MERGED pass (see
    // ensureComputePass); the bind group AND the pipeline are memoed (same
    // family — same group; same entry — same pipeline: the sort loop's 171
    // dispatches pay one setBindGroup and one setPipeline, not 342 of each).
    const cp = ensureComputePass()
    if (computePipeline !== pipeline) {
      cp.setPipeline(pipeline)
      computePipeline = pipeline
    }
    if (computeGroup !== family.group) {
      cp.setBindGroup(0, family.group)
      computeGroup = family.group
    }
    cp.dispatchWorkgroups(workgroups)
  }

  return {
    configure,
    resize,
    setCanvasClearColor,
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
    bindExternalVertexBuffer,
    bindTexture,
    beginPass,
    draw,
    // Task 174 — PRESENCE == CAPABILITY: the tier's indirect shape is
    // armed exactly where the browser's encoder kept the spec-dropped
    // method; a facade without it rides the executor's fast-path floor.
    ...(hasDrawIndirectCount ? { multiDraw } : {}),
    endPass,
    submit,
    // Task 131 — the GPGPU tier
    createExternalBuffer,
    writeExternalBuffer,
    readExternalBuffer,
    deleteExternalBuffer,
    externalBufferOf,
    createCompute,
    runCompute,
    deleteCompute,
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
  /** Task 126: the DECLARED @binding numbers of the group-1 texture_2d
   *  resources, in declaration order — the layout (and the bind group)
   *  mirror the shader's own numbering instead of a sequential 1..N. */
  readonly textureBindings: readonly number[]
  readonly desc: GpuPipelineDesc
  /** Task 145: the two lazy sampleType variants as nullable fields (was a
   *  Map<TextureSampleVariant, GPURenderPipeline> — a string-keyed hash
   *  lookup per draw; the variant set is exactly two). Task 172: the
   *  depth-presence twins — a pipeline WITH a declared depthStencil format
   *  is invalid in a depth-less pass, so depth-less binds get their own
   *  (lazy) twins of the same shader+desc. */
  variantFloat: GPURenderPipeline | null
  variantUnfilterable: GPURenderPipeline | null
  variantFloatNoDepth: GPURenderPipeline | null
  variantUnfilterableNoDepth: GPURenderPipeline | null
}

/** Task 145: texture registry record (the dense textureRecords array). */
interface TextureRecord {
  readonly texture: GPUTexture
  readonly sampler: GPUSampler
  readonly view: GPUTextureView
  readonly format: GPUTextureFormat
  readonly filterable: boolean
}

/** The sub-view id namespace base (nextTextureViewId starts here — the
 *  textureView ids are disjoint from texture ids BY DOCUMENT). */
const SUB_VIEW_ID_BASE = 1_000_000

/** The number of group-1 texture_2d bindings in WGSL — the size of the
 *  multi-texture layout (sampler@0 + tex@1..N). Single-texture shaders
 *  give 1 — the previous v1 contract; base+normal map — 2. */
export function countGroup1TextureBindings(wgsl: string): number {
  let count = 0
  for (const _match of wgsl.matchAll(/@group\(1\)[^\n;]*var\s+\w+\s*:\s*texture_2d/g)) count++
  return Math.max(1, count)
}

/** Task 126: the DECLARED group-1 texture_2d binding numbers in WGSL, in
 *  declaration order (deduplicated). The layout follows the shader's own
 *  numbering: a material reserving tex@1 + depth@5 gets a {sampler@0,
 *  tex@1, depth@5} layout, NOT {sampler@0, tex@1, tex@2} — the sequential
 *  layout fails entry-point validation ("Binding doesn't exist in
 *  [BindGroupLayout]") whenever the shader's binding set is not a prefix
 *  of 1..N (SOFT_PARTICLES: {1, 5}). */
export function group1TextureBindings(wgsl: string): number[] {
  const found: number[] = []
  for (const match of wgsl.matchAll(/@group\(1\)[^\n;]*var\s+\w+\s*:\s*texture_2d/g)) {
    const bMatch = /@binding\((\d+)\)/.exec(match[0])
    if (bMatch === null) continue
    const binding = Number(bMatch[1])
    if (Number.isInteger(binding) && binding >= 0 && !found.includes(binding)) found.push(binding)
  }
  if (found.length === 0) found.push(1) // the legacy single-texture contract
  return found
}
