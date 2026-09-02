// WebGPU facade contract: fat operations over device/queue.

import type { TextureFormat, GpuTimer } from '@rune/core'
import type { GpuPipelineDesc } from './pipeline/pipelineCache.ts'

/** Source for atomic texture upload (without streaming/chunking).
 *  WebGPU ExternalImageSource = ImageBitmap | HTMLCanvasElement | HTMLVideoElement |
 *  VideoFrame | OffscreenCanvas (with getContext('2d') | 'webgl' | 'webgl2' | 'webgpu'). */
export type GPUImageSource =
  | ImageBitmap
  | HTMLCanvasElement
  | HTMLVideoElement
  | OffscreenCanvas
  | VideoFrame

/** Source dimensions for copyExternalImageToTexture.
 *
 *  WebGPU requires copySize to match the size of the copied source
 *  region — otherwise "Copy rect is out of bounds of external image". We
 *  cannot pass the "destination texture size" as copySize (which the
 *  unified renderer did before): a smaller source → out of bounds.
 *
 *  We extract width/height from source:
 *   • ImageBitmap / OffscreenCanvas / HTMLCanvasElement: .width / .height
 *   • HTMLVideoElement: .videoWidth / .videoHeight (the video may not be
 *     fully loaded — then 0×0, which WebGPU will reject; that is the
 *     caller's responsibility)
 *   • VideoFrame: .displayWidth / .displayHeight (coded* may include padding)
 */
export function externalImageSize(source: GPUImageSource): readonly [number, number] {
  // ImageBitmap, HTMLCanvasElement, OffscreenCanvas — all have .width/.height
  // HTMLVideoElement — has .videoWidth/.videoHeight (while .width/.height is
  // the element's CSS size, useless for the GPU)
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) {
    return [source.videoWidth || 0, source.videoHeight || 0]
  }
  // VideoFrame — displayWidth/displayHeight (preferred over coded*, which
  // may include codec alignment)
  const vf = source as { displayWidth?: number; displayHeight?: number; codedWidth?: number; codedHeight?: number }
  if (typeof vf.displayWidth === 'number' && typeof vf.displayHeight === 'number' && vf.displayWidth > 0) {
    return [vf.displayWidth, vf.displayHeight]
  }
  if (typeof vf.codedWidth === 'number' && typeof vf.codedHeight === 'number' && vf.codedWidth > 0) {
    return [vf.codedWidth, vf.codedHeight]
  }
  // ImageBitmap / HTMLCanvasElement / OffscreenCanvas — the simple path
  const s = source as { width?: number; height?: number }
  return [s.width ?? 0, s.height ?? 0]
}

// Type utility for ConditionalTypes (moved out to avoid spawning copies in types)
// (globalType was removed in Task 71: the only use — a conditional VideoFrame —
// was replaced with a direct VideoFrame reference from lib.dom; WebCodecs types
// exist in the environment.)

/** Handle that GPUFacade invokes at the right moments for writeTimestamp.
 *  Created by createGpuGpuTimer together with GpuTimer (core). Installed
 *  into GPUFacade via installTimer(). realGPU calls handle.onBeginPass /
 *  onEndPass / onSubmit at the right moments of the command stream. */
export interface GpuTimerHandle {
  onBeginPass(pass: GPURenderPassEncoder): void
  onEndPass(pass: GPURenderPassEncoder): void
  onSubmit(encoder: GPUCommandEncoder): void
}

/** M5 (Task 73): pipeline vertex buffer slot.
 *  number — tight layout (arrayStride = size*4, offset 0);
 *  object — feed interleaving: stride (record bytes) + offset (field bytes).
 *  The pipeline builds GPUVertexBufferLayout: arrayStride=stride,
 *  attribute offset=offset, format by size.
 *  Task 75: step='instance' → stepMode 'instance' (a feed record is read
 *  once per instance — quad-stars; corners are expanded from
 *  @builtin(vertex_index) in the shader). */
export type GpuAttrSlot = number | {
  readonly size: number
  readonly stride?: number
  readonly offset?: number
  readonly step?: 'vertex' | 'instance'
}

export interface GPUFacade {
  configure(width: number, height: number): void
  resize(width: number, height: number): void
  /** format 'canvas' — the canvas format (targets need it so that
   *  pipelines fit both the canvas and the surface).
   *  Task 67 HDR: 'rgba16float' (8 B/pixel, filterable+renderable core)
   *  and 'rgba32float' (16 B/pixel, renderable core; linear filtering
   *  requires feature 'float32-filterable' — without it the facade's
   *  sampler degrades to nearest). Parity with WebGL2 createTexture({format}).
   *
   *  options.mipLevels (default 1): the number of mip levels in the chain.
   *  If >1 — mipLevelCount in the descriptor, a sampler with
   *  mipmapFilter='linear' (minification picks the mip by distance, the
   *  analogue of LINEAR_MIPMAP_LINEAR in WebGL2).
   *  copyExternalImageToTexture writes into mip 0; for other mips —
   *  copyExternalImageToTextureMip.
   *
   *  Contract: WebGPU automatically uses the mip-chain when sampling if
   *  mipLevelCount>1. Unloaded mips return zeros. For progressive
   *  streaming (MipStreamer) it is recommended to keep lodMaxClamp at the
   *  highest loaded mip — but that is the responsibility of the texture
   *  wrapper, not the facade. */
  createTexture(
    width: number,
    height: number,
    format?: TextureFormat,
    options?: { mipLevels?: number; maxAnisotropy?: number },
  ): number
  texSubImage2D(textureId: number, x: number, y: number, width: number, height: number, bytes: Uint8Array): void
  /** Atomic upload from bitmap/canvas/video into mip 0 — a single
   *  copyExternalImageToTexture call.
   *
   *  Semantics (fix for the "Copy rect is out of bounds of external image" bug):
   *   • dstX, dstY — origin in the destination texture (where to write)
   *   • copyWidth, copyHeight — size of the copied region (= source size,
   *     NOT the texture size). Must be ≤ source.width/height and ≤
   *     (texture.width - dstX) / (texture.height - dstY), otherwise WebGPU
   *     will throw a validation error.
   *   • flipY (default false) — if true, the source is flipped along Y
   *     BEFORE copying. WebGPU supports this option natively via
   *     GPUCopyExternalImageSourceInfo.flipY. Parity with WebGL2:
   *     UNPACK_FLIP_Y_WEBGL does the same — flipY=true on both backends
   *     gives an identical result.
   *
   *  For a full-texture upload: dstX=0, dstY=0, copyWidth=texture.width,
   *  copyHeight=texture.height (when the source size matches).
   *
   *  For a sub-region upload (atlas packing): dstX=slot.x, dstY=slot.y,
   *  copyWidth=source.width, copyHeight=source.height. */
  copyExternalImageToTexture(
    textureId: number,
    source: GPUImageSource,
    dstX: number,
    dstY: number,
    copyWidth: number,
    copyHeight: number,
    flipY?: boolean,
  ): void
  /** Upload of a specific mip level. copyExternalImageToTexture with
   *  destination.mipLevel=level. The source must have size N/(2^level).
   *  Used by MipStreamer for progressive mip upload.
   *
   *  Semantics: dstX/dstY — origin in the mip level, copyWidth/copyHeight —
   *  size of the copied region (usually = mip size = N/(2^level)).
   *  flipY (default false) — analogue of copyExternalImageToTexture (see above).
   *
   *  WebGPU parity with WebGL2 texImage2DLevel. */
  copyExternalImageToTextureMip(
    textureId: number,
    mipLevel: number,
    source: GPUImageSource,
    dstX: number,
    dstY: number,
    copyWidth: number,
    copyHeight: number,
    flipY?: boolean,
  ): void
  uploadUniforms(offset: number, data: Uint8Array): void
  /** M5 (Task 73): vertex buffer slot — a number (tight: size×4 bytes,
   *  offset 0 — backward compatibility) OR a feed interleaving descriptor
   *  (size components, stride record bytes, offset field bytes).
   *  Task 75: desc — rasterization state (blend/depth/cull/
   *  primitive) from GpuPipelineDesc; previously the pipeline hardcoded
   *  less+write without blending. */
  ensurePipeline(pipelineId: number, wgsl: string, attrs: readonly GpuAttrSlot[], hasTextures: boolean, desc?: GpuPipelineDesc): void
  usePipeline(pipelineId: number): void
  bindUniforms(dynamicOffset: number): void
  bindVertexBuffer(slot: number, data: Float32Array, size: number): void
  /** M5 (Task 73): the feed's dynamic vertex buffer — writeBuffer in a
   *  single call per frame (dirty range [0, byteLength)). The key is the
   *  Float32Array itself (stable in the feed renderer). Binding is done by
   *  the executor via bindVertexBuffer (the same keyed cache). */
  syncVertexBuffer(data: Float32Array, byteLength: number): void
  bindTexture(textureId: number): void
  beginPass(clearIndex: number): void
  draw(count: number, instances: number): void
  endPass(): void
  submit(): void
  /** Task 80 (readback): read the pixels of the TARGET (surface) — Promise<Uint8Array>.
   *
   *  Parity contract with the GL facade (readTargetPixels → Uint8Array):
   *   - RGBA8, tight layout (rowBytes = width*4, without WebGPU's 256-byte
   *     alignment — the facade compacts rows);
   *   - rows TOP-DOWN: data[0..3] = top-left pixel (texture
   *     row 0; the GL facade flips readPixels for this same contract);
   *   - RGBA channels: canvas bgra8unorm formats are swizzled (B↔R).
   *
   *  Asynchrony: copyTextureToBuffer → submit → mapAsync (the WebGPU path
   *  reads only via buffer mapping). An open render-pass is closed by the
   *  facade; the copy is appended to the same command buffer (order preserved).
   *  targetId 0 (canvas) is not read — honest reject (a presented texture
   *  lives one frame); read the surface (renderer.surface().read()). */
  readTargetPixels(targetId: number): Promise<Uint8Array>
  /** Render target: the pass writes into a texture (view + optional depth). */
  createTarget(
    textureId: number,
    width: number,
    height: number,
    depth: boolean,
    color: readonly [number, number, number, number],
  ): number
  /** Switch the target: 0 = canvas (closes the current pass, opens a new one). */
  bindTarget(targetId: number, clear: boolean): void

  /** Adapter — for caps probing (probeGPUCaps via exposeGPUCaps).
   *  null if caps probing is not needed (headless/mock). */
  readonly adapter: GPUAdapter | null
  /** Device — for caps probing (device.limits.maxAnisotropy etc.).
   *  null in the recording facade (no device). In some browsers
   *  adapter.limits does NOT contain maxAnisotropy, but device.limits does
   *  (after requestDevice()). Therefore probeGPUCaps uses the device
   *  as a fallback to adapter.limits. */
  readonly device: GPUDevice | null
  /** Preferred canvas format — needed by capsProbe for the bgra8unorm baseline. */
  readonly preferredFormat: GPUTextureFormat

  // ─── Disposal (M1 §9.9 disposal discipline) ───────────────────────────
  // WebGPU resources: texture (GPUTexture) and target (color view + optional
  // depth). Pipelines/bindGroupLayouts/shaderModule/device — NOT freed manually
  // before the full dispose(), because they are created once per spec
  // compilation and live until the end of the renderer session (internal
  // cache).
  // VertexBuffers — a special case: they are keyed by Float32Array and freed
  // automatically via FinalizationRegistry (see realGPU.ts).

  /** Delete a texture: GPUTexture.destroy + removal from the cache.
   *  Its BindGroup is invalidated and will be recreated on the next bindTexture. */
  deleteTexture(textureId: number): void
  /** Delete a target: destroys the target's depth texture (if any). The
   *  color texture is NOT touched (it is a separate resource, see deleteTexture). */
  deleteTarget(targetId: number): void
  /** Create a GPUTextureView with a sub-mip-range. By default createTexture()
   *  creates a default view over the whole mip-chain. This method allows
   *  creating additional views with a limited mip range — for deep-zoom
   *  paging (the sampler samples only a specific mip, no avg between levels).
   *
   *  WebGPU: GPUTextureViewDescriptor with baseMipLevel/mipLevelCount.
   *  WebGL2: emulated via TEXTURE_BASE_LEVEL / TEXTURE_MAX_LEVEL at
   *  bindTexture (per-texture state, rewritten on every bind to prevent
   *  state leaking between views). Implemented in Task 56
   *  (GLFacade.createTextureView + deleteTextureView, disjoint id namespace
   *  with textureId across the 1M boundary). LOD-clamp parity on both
   *  backends.
   *
   *  Contract: createTextureView does not require mipLevels>1 in createTexture.
   *  If textureId points to a texture with mipLevels=1 while options pass
   *  baseMipLevel=2 — WebGPU will throw a validation error (asynchronously
   *  via onGpuError). It is recommended to check texture.mipLevels before
   *  creating a view.
   *
   *  @returns viewId — an integer handle. Used in bindTexture(viewId).
   *  On facade dispose() the view is destroyed automatically (the
   *  GPUTextureView is freed implicitly via device.destroy(), like the
   *  original texture).
   *  For per-item freeing — deleteTextureView(viewId). */
  createTextureView(
    textureId: number,
    options?: { baseMipLevel?: number; mipLevelCount?: number; baseArrayLayer?: number; arrayLayerCount?: number },
  ): number
  /** Delete a GPUTextureView (if created via createTextureView).
   *  A default view (created in createTexture) cannot be deleted by this
   *  method — it is managed together with the texture (deleteTexture).
   *  Idempotent: deleting the same id again — no-op. */
  deleteTextureView(viewId: number): void
  /** Full teardown of the facade: destroys ALL GPUTexture (textures map),
   *  UBO, vertex buffers, the depth texture (canvas attachment), target
   *  depth textures, and finally — device.destroy(). Idempotent:
   *  a repeated dispose — no-op.
   *
   *  WebGPU specifics: device.destroy() deterministically frees all
   *  GPU memory allocated by the device, including all textures/buffers/
   *  pipelines/samplers, even if they were not destroyed explicitly. This
   *  is critical with frequent backend switching (kit-demo): each switch
   *  creates a new device. Without destroy() old devices stay alive until
   *  page unload → GPU memory leak.
   *
   *  After dispose the renderer must recreate the facade via createRealGPU —
   *  the old GPUFacade must not be used (all resources and the device are dead). */
  dispose(): void
  /** Install a GPU-timer handle for writeTimestamp hooks. handle != null
   *  enables begin/endPass + onSubmit hooks for timestamp-query. handle=null
   *  removes the hooks (for dispose or on a timer error).
   *
   *  realGPU calls handle.onBeginPass(pass) right after beginRenderPass,
   *  handle.onEndPass(pass) before pass.end(), handle.onSubmit(encoder)
   *  before encoder.finish() — this closes timestamps in the correct order.
   *
   *  Returns the previous handle (or null) — for chain/uninstall. */
  installTimer(handle: GpuTimerHandle | null): GpuTimerHandle | null
  /** GpuTimer (core) if the device has the 'timestamp-query' feature. null —
   *  if the feature is unavailable or the timer is deactivated (device lost,
   *  mapAsync failed). Wired to StatsCollector.setGpuTimer() in renderer.ts.
   *
   *  Important: the timer is initialized inside realGPU (querySet +
   *  resolveBuffer + readBuffer are created on the device). The handle is
   *  already wired to this timer via installTimer inside createRealGPU —
   *  the GPUFacade user must not call installTimer manually (unless
   *  replacing the timer for tests). */
  readonly timer: GpuTimer | null
}
