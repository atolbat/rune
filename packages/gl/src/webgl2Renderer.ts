import {
  buildFrame,
  createEpoch,
  createLayoutGuard,
  createLiveCommand,
  createSegmentStore,
  createTapeWriter,
  createTransientPool,
  createUniformArena,
  derive,
  signal,
  writerView,
  OpCode,
} from '@rune/core'
import { createUploadScheduler, streamTexture } from '@rune/core'
import type { UploadScheduler, UploadSchedulerOptions, TextureUpload, TransientPool } from '@rune/core'
import type { TextureHandle } from '@rune/webgl2'
import type { LiveCommand, ReadableSignal } from '@rune/core'
import { compileDrawSpec, createCompileContext, createExecutor, createRealGL } from '@rune/webgl2'
import type { CompiledCommand, DrawSpec, GLFacade, UniformStrategy, GLTextureFormat, GLImageSource } from '@rune/webgl2'
import {
  FULLSCREEN_QUAD,
  PASS_VERT_GLSL,
  applyBuiltins,
  createPassBuiltins,
  scanBuiltins,
  withTarget,
} from './surface.ts'
import type { PassOptions, Surface, SurfaceOptions } from './surface.ts'
import { canvasDpr, getCanvasCssSize, isOffscreenCanvas, resolveCanvasAny } from './canvasHelpers.ts'
import type { AnyCanvas } from './canvasHelpers.ts'
import { withJournal } from './journalGl.ts'
import { createResourceSessionGL } from './resourceSessionGL.ts'
import type { ResourceJournal, RestoreReport, WorkingSet, EvictionReport, ResidencyStats } from '@rune/core'
import type { StatsCollector, GpuTimer } from '@rune/core'
import { createStatsCollector } from '@rune/core'
import type { TransportClient, TransportFeedView } from '@rune/core'
import { createRendererFeedGL } from './rendererFeed.ts'
import type { RendererFeed, RendererFeedOptions } from './rendererFeed.ts'
import { makeGLProbe, probeGLCaps, createGLGpuTimer } from '@rune/webgl2'
import type { Caps } from '@rune/core'
import { createCaps } from '@rune/core'
import type { Journal } from '@rune/core'

/** Frame context: a stable shape (field mutation, no allocations). */
export interface FrameContext {
  time: number
  dt: number
  aspect: number
  size: readonly [number, number]
}

/** A record of a command in the current frame (for renderer.frame callbacks). */
export type Recorder = (command: CompiledCommand, props?: unknown) => void

/** Frame subscription management. */
export interface FrameHandle {
  cancel(): void
}

/** WebGL2 renderer: canvas, auto-loop, resize/DPR, sim-time, commands and live. */
export interface WebGL2Renderer {
  readonly gl: GLFacade
  /** Caps — backend capabilities. null in headless mode (createGL injected). */
  readonly caps: Caps | null
  readonly size: ReadableSignal<readonly [number, number]>
  readonly aspect: ReadableSignal<number>
  readonly time: ReadableSignal<number>
  /** Streaming scheduler: tasks run in the idle slot of every frame. */
  readonly uploads: UploadScheduler
  /** Per-frame pool of scratch arrays (idea #2): no allocations in callbacks. */
  readonly transients: TransientPool
  /** M5 (Task 73): the reader's transport client — mode diagnostics
   *  (renderer.transport.mode, dossier §7.2: "Diagnostics are available via
   *  renderer.transport"). null — a renderer without transport. */
  readonly transport: TransportClient | null
  /** M5 (Task 73): create a renderer feed (dual-bind: vertex attributes +
   *  storage array of structs; sync — at the frame boundary, the dirty range
   *  in one call). Channel: T0/T1/T2 — SAB/local (.buffer → to the worker),
   *  T3 — ping-pong (worker: createMsgFeedWriter; chunks — applyChunks). */
  feed(options: RendererFeedOptions | TransportFeedView): RendererFeed
  /** Creates an empty texture (streaming — via texture.upload). */
  texture(width: number, height: number, options?: { mipLevels?: number; maxAnisotropy?: number; format?: GLTextureFormat }): Texture
  /** Task 62: a handle over an existing stable textureId (restored by
   *  restoreResources after device loss). Does not create a GPU resource. */
  attachTexture(textureId: number, width: number, height: number, mipLevels?: number): Texture
  /** Task 64: a handle over an existing stable viewId — a view restored
   *  by restoreResources() from the view.create op (viewId ≥ 1M, parent textureId < 1M).
   *  Does not create a GPU resource and does not write to the journal: the
   *  view.create op is already there.
   *  dispose() → deleteTextureView(viewId) — writes view.destroy into the
   *  session journal (a pair for a future compact). Release the parent texture
   *  separately: attachTexture(...).dispose() → texture.destroy. */
  attachView(viewId: number, textureId: number, baseMipLevel?: number, mipLevelCount?: number): TextureView
  /** Task 62: replay ResourceJournal v2 on a FRESH facade of this session —
   *  device-loss recovery. Present only with the resources option.
   *  Task 65: options.workingSet — soft reset (restore only the scene;
   *  the rest lazily via ensureResident). */
  restoreResources?(options?: { workingSet?: WorkingSet }): RestoreReport
  /** Task 65: lazy return of ONE deferred resource after a soft reset
   *  (texture/view/target id). null — already resident / no session. */
  ensureResident?(resourceId: number): RestoreReport | null
  /** Task 66: LRU eviction of resident textures down to a GPU memory
   *  budget (the flip side of ensureResident; memory pressure between losses).
   *  Evicted resources remain as declarations+content in the journal.
   *  Present only with the resources option. */
  evictLRU?(options?: { budgetBytes?: number; pinned?: WorkingSet }): EvictionReport
  /** Task 66: resident GPU memory estimate + LRU order (diagnostics). */
  residencyStats?(): ResidencyStats
  command(spec: DrawSpec): CompiledCommand
  /** Fullscreen pass to the canvas: inputs → fragment → screen. */
  pass(fragment: string, options?: PassOptions): CompiledCommand
  /** Target surface: a texture + fullscreen passes into it. */
  surface(options?: SurfaceOptions): Surface<CompiledCommand>
  live(spec: DrawSpec, deps?: readonly ReadableSignal[], props?: unknown): LiveCommand
  frame(callback: (ctx: FrameContext, record: Recorder) => void): FrameHandle
  resize(cssWidth: number, cssHeight: number): void
  step(nowMs: number): void
  start(): void
  stop(): void
  /** Full teardown: stop rAF + disconnect the ResizeObserver + delete all
   *  facade resources (textures/programs/buffers/targets). After dispose
   *  the renderer is unusable — re-create it via createWebGL2Renderer.
   *  Idempotent: a repeated dispose is a no-op. */
  dispose(): void
}

/** Renderer texture: facade id + streaming upload over the scheduler. */
export interface Texture extends TextureHandle {
  readonly width: number
  readonly height: number
  /** Number of mip levels in the chain (1 = no chain). >1 → the texture was
   *  created with texStorage2D levels=N, MIN_FILTER=LINEAR_MIPMAP_LINEAR.
   *  Streaming via uploadMip(level) gradually fills the mips from small to
   *  large; MAX_LEVEL is raised automatically to the loaded level. */
  readonly mipLevels: number
  /** Streaming upload of RGBA bytes: preview → chunks; progress and cancel.
   *  For ImageBitmap / HTMLCanvasElement / OffscreenCanvas / VideoFrame —
   *  see uploadImage (an atomic upload without streaming). */
  upload(source: Uint8Array, options?: { priority?: number; onProgress?: (fraction: number) => void }): TextureUpload
  /** Atomic upload from a bitmap/canvas/video — one call, no chunks.
   *  WebGL2: texImage2D overload with TexImageSource (overwrites mip 0).
   *  WebGPU: copyExternalImageToTexture (via the gpu facade, if available).
   *  The texture size must match the source (or be larger — tiles outside
   *  the source remain untouched).
   *
   *  options.flipY (default false): flip the source along Y. WebGL2 —
   *  via UNPACK_FLIP_Y_WEBGL; WebGPU — via GPUCopyExternalImageSourceInfo.flipY.
   *  Parity: with false both backends write source row 0 into texture row 0
   *  — the mapping is identical.
   *
   *  ALPHA CONTRACT (Task 116): the texture texels are expected to carry
   *  STRAIGHT (non-premultiplied) alpha. WebGPU's copyExternalImageToTexture
   *  un-premultiplies premultiplied sources automatically (the tagged
   *  destination, premultipliedAlpha: false); WebGL2 has NO un-premultiply
   *  path — it uploads the source bytes as-is. Canvas 2D sources are stored
   *  premultiplied, so for cross-backend parity create canvas-derived
   *  bitmaps with createImageBitmap(canvas, { premultiplyAlpha: 'none' }).
   *  A premultiplied texture + ('src-alpha', …) blending multiplies the
   *  alpha TWICE — sprites turn dark and muddy (the embers regression). */
  uploadImage(source: GLImageSource, options?: { flipY?: boolean }): void
  /** Upload of a part of a texture (sub-region) from a bitmap/canvas/video.
   *  WebGL2: texSubImage2D overload with TexImageSource (does NOT overwrite
   *  the rest of the texture). WebGPU: copyExternalImageToTexture with destination.origin=(x,y).
   *
   *  Used for:
   *   - runtime atlas packing (several bitmaps into one texture),
   *   - tile replacement (updating part of a map),
   *   - progressive loading.
   *
   *  The region is defined by [x, y, x+source.width, y+source.height]. Going
   *  outside the texture → a GL-error (no check on purpose — the cheap path).
   *  options.flipY (default false) — parity with WebGPU (see uploadImage). */
  uploadSubImage(x: number, y: number, source: GLImageSource, options?: { flipY?: boolean }): void
  /** Upload of a specific mip level (level 0 = base, 1 = 1/2 size, etc.).
   *
   *  WebGL2: texImage2D with a level parameter. The source must have size N/(2^level).
   *  For a mip-chain texture (mipLevels>1) raises TEXTURE_MAX_LEVEL up to level —
   *  the sampler sees only loaded mips, without a black frame during partial
   *  loading. For a non-mip texture (mipLevels=1) loading level>0 has no
   *  visible effect without re-creating the texture.
   *  WebGPU: copyExternalImageToTextureMip with destination.mipLevel=level.
   *  The WebGPU path ignores the WebGL2-specific options internalFormat/format/type
   *  (the texture format is set at createTexture, not at upload).
   *
   *  options.flipY (default false) — parity with WebGPU (see uploadImage).
   *
   *  options.internalFormat/format/type (WebGL2-only, Task 55): a strict
   *  format/type contract for HDR data. Default: RGBA8/RGBA/UNSIGNED_BYTE. For
   *  RGBA16F: internalFormat=0x881A, format=0x1908, type=0x140B (HALF_FLOAT).
   *  The WebGPU path ignores these options.
   *
   *  Used by the MipStreamer for progressive mip upload. */
  uploadMip(
    level: number,
    source: GLImageSource,
    options?: {
      flipY?: boolean
      /** WebGL2 internalFormat GLenum (default RGBA8=0x8058). WebGPU-ignored. */
      internalFormat?: number
      /** WebGL2 format GLenum (default RGBA=0x1908). WebGPU-ignored. */
      format?: number
      /** WebGL2 type GLenum (default UNSIGNED_BYTE=0x1401). WebGPU-ignored. */
      type?: number
    },
  ): void
  /** Create a sub-mip-range view of the texture (Task 58: exposed via the public handle).
   *
   *  WebGPU: a GPUTextureView with baseMipLevel/mipLevelCount — the sampler sees
   *  only the specified mip range. Useful for deep-zoom paging:
   *  bindTexture(viewId) picks a specific mip without auto-LOD.
   *
   *  WebGL2: emulated via TEXTURE_BASE_LEVEL / TEXTURE_MAX_LEVEL at
   *  bindTexture (Task 56: GLFacade.createTextureView). Disjoint id namespace:
   *  viewId ≥ 1M, textureId < 1M — bindTexture(viewId|textureId) works
   *  without changing the signature.
   *
   *  Contract:
   *   - textureId must have mipLevels ≥ 2 (otherwise the view makes no sense).
   *   - baseMipLevel (default 0): the starting mip level of the view.
   *   - mipLevelCount (default = mipLevels - baseMipLevel): the number of mips in the view.
   *   - baseMipLevel + mipLevelCount ≤ mipLevels.
   *
   *  @returns a TextureView handle with viewId. bindTexture(viewId) picks the
   *  mip range. dispose() — releases the view (deleteTextureView).
   *
   *  Journal integration: createTextureView/destroyTextureView — long-lived
   *  declarations, automatically written to the Journal via withJournal /
   *  withJournalGpu. At device-loss recovery they are re-created via
   *  replayJournalOn / replayJournalOnGpu. */
  createView(options?: { baseMipLevel?: number; mipLevelCount?: number }): TextureView
  /** Release the GPU texture (gl.deleteTexture). Idempotent.
   *  Also releases all sub-mip views (created via createView) —
   * the facade itself removes them from its internal cache. */
  dispose(): void
}

/** A sub-mip view of a texture (Task 58): exposes GPUFacade.createTextureView
 *  via the public Texture handle. A view is a slice of the texture over a mip
 *  range; the sampler sees only [baseMipLevel, baseMipLevel +
 *  mipLevelCount - 1]. Used in deep-zoom paging and LOD-clamp
 *  scenarios.
 *
 *  WebGPU ↔ WebGL2 parity: on both backends viewId ≥ 1M, a disjoint
 *  namespace with textureId (< 1M). bindTexture(viewId) works the same.
 *
 *  Dispose: deleteTextureView(viewId) on the facade. Idempotent. Does not touch
 *  the parent texture (it is managed via Texture.dispose()). */
export interface TextureView {
  /** viewId ≥ 1_000_000. Passed to bindTexture(viewId, unit) or into a
   *  command's texture reference (textureId: viewId). */
  readonly viewId: number
  /** Parent textureId (< 1M) — for information. */
  readonly textureId: number
  readonly baseMipLevel: number
  readonly mipLevelCount: number | undefined
  /** Release the view (facade.deleteTextureView). Idempotent.
   *  The parent texture is NOT touched. */
  dispose(): void
}

/** Compute the number of mip levels for a texture of size w×h.
 *  = 1 + floor(log2(min(w, h))). For example:
 *   - 256×256 → 9 levels (level 0 = 256², 1 = 128², ..., 8 = 1×1)
 *   - 64×64  → 7 levels
 *   - 4×4    → 3 levels
 *  Returns 1 if min(w,h) ≤ 1 (no mip chain).
 *
 *  Used by the MipStreamer and renderer.texture({ mipLevels: 'auto' }). */
export function computeMipLevels(w: number, h: number): number {
  const minDim = Math.min(w, h)
  if (minDim <= 1) return 1
  return 1 + Math.floor(Math.log2(minDim))
}

/** WebGL2 renderer options; injections — for headless tests. */
export interface WebGL2RendererOptions {
  readonly canvas: AnyCanvas | string
  readonly dpr?: number
  readonly clear?: { readonly color: readonly [number, number, number, number]; readonly depth: number | null }
  readonly uniformStrategy?: UniformStrategy
  readonly uploads?: UploadSchedulerOptions
  readonly createGL?: (canvas: AnyCanvas) => GLFacade
  readonly requestFrame?: (callback: (timestamp: number) => void) => () => void
  readonly observeResize?: boolean
  readonly now?: () => number
  /** Journal — a registry of long-lived declarations for device-loss recovery
   *  (= switchBackend = worker migration). If passed, GLFacade
   *  is wrapped with the withJournal decorator: create/destroy ops are
   *  written automatically. Replay — via replayJournalOn(journal, newGL, sourceFor). */
  readonly journal?: Journal
  /** Task 62: ResourceJournal v2 — stable ids + CONTENT in the journal.
   *  If passed, GLFacade is wrapped with the resourceSession decorator:
   *  texture/view/target get stable ids (surviving device loss),
   *  write/update/writeMip ops store CPU sources in the ContentStore.
   *  restoreResources() restores EVERYTHING — declarations and
   *  pixels — by replaying the same primitives on a fresh facade.
   *  Priority over journal (v1): if both are passed — resources is used. */
  readonly resources?: ResourceJournal
  /** Sink for silent GL errors (the WebGL2 parity of WebGPU's onGpuError):
   *  once per frame after submit, gl.getError() is drained — all error codes
   *  accumulated over the frame go out in one message. Deduplication: consecutive
   *  frames with the same error do not spam (one message per state change).
   *  Used by the demo to display on screen ("[webgl2 GL error] …") — silent
   *  GL_INVALID_* otherwise turn into a "black canvas" with no diagnostics. */
  readonly onGlError?: (message: string) => void
  /** StatsCollector — for RendererStats (cpuMs, drawCalls, memoryEstimate).
   *  In step() calls beginFrame()/endFrame() and addMemory at createTexture. */
  readonly stats?: StatsCollector
  /** The caps object — probing was done at the level of the unified createRenderer.
   *  The WebGL2 path uses it only for the caps.backend string. */
  readonly caps?: Caps | null
  /** M5 (Task 73): the reader's transport client (renderer.transport —
   *  mode diagnostics; dossier §7.2). Optional: without it renderer.feed()
   *  creates a channel via detectTransport(). */
  readonly transport?: TransportClient
}

const DEFAULT_CLEAR = { color: [0.07, 0.08, 0.11, 1] as const, depth: 1 }

/** Creates a WebGL2 renderer with an auto-loop (the explicit path without auto-selection). */
export function createWebGL2Renderer(options: WebGL2RendererOptions): WebGL2Renderer {
  const canvas = resolveCanvasAny(options.canvas)
  // acquireWebGL2 yields a raw WebGL2RenderingContext — kept for caps-probing.
  // If createGL is injected (headless tests) — probing is skipped (no raw gl).
  const rawContext = options.createGL === undefined ? acquireWebGL2(canvas) : null
  // Task 129: the viewport-heal sink is wired into the raw facade — a
  // drawing-buffer divergence (the live "everything in the bottom-left
  // corner, as if the canvas shrank 4x" report) lands in the GL error log
  // with its numbers, once per divergence.
  const rawGl = options.createGL !== undefined
    ? options.createGL(canvas)
    : createRealGL(rawContext!, message => options.onGlError?.(message))
  // Task 62: resourceSession (v2) takes priority over journal (v1):
  // stable ids + content in the journal + restoreResources(). The v1 path
  // (withJournal) is kept for backward compatibility of existing tests.
  const session = options.resources !== undefined ? createResourceSessionGL(rawGl, options.resources) : null
  // Journal decorator (v1): writes create/destroy ops into the registry for device-loss recovery.
  // Frame ops (useProgram, setUniform*, drawArrays etc.) — not journaled
  // (they are per-frame, going into the Tape, not the Journal).
  const gl = session !== null
    ? session.facade
    : (options.journal !== undefined ? withJournal(rawGl, options.journal) : rawGl)

  const arena = createUniformArena(64 * 1024)
  const ctx = createCompileContext(arena, 'codegen')
  const segments = createSegmentStore(256)
  const clears = [options.clear ?? DEFAULT_CLEAR]
  const executor = createExecutor({
    gl, arena, commands: ctx.commands, clears,
    segments, uniformStrategy: options.uniformStrategy ?? 'auto',
  })

  const epoch = createEpoch()
  const layoutGuard = createLayoutGuard() // safeguard: "attribute↔layout↔observer" loops
  const uploads = createUploadScheduler(options.uploads ?? {})
  const transients = createTransientPool() // idea #2: scratch without GC
  const feeds = new Set<RendererFeed>() // M5: sync at the frame boundary
  const builtinValues = createPassBuiltins() // u_time/u_resolution/u_texel of passes
  const writer = createTapeWriter(64)
  const [initW, initH] = getCanvasCssSize(canvas)
  const size = signal<readonly [number, number]>([initW, initH])
  const aspect = derive(() => size.value[0] / size.value[1])
  const time = signal(0)
  const frameCtx: FrameContext = { time: 0, dt: 0, aspect: 1, size: [1, 1] }
  const lives: LiveCommand[] = []
  const frameCallbacks: Array<(ctx: FrameContext, record: Recorder) => void> = []
  const startedAt = (options.now ?? defaultNow)()
  let lastNow = startedAt
  let running = false
  let cancelScheduled: (() => void) | null = null
  let lastCssWidth = -1
  let lastCssHeight = -1
  // Task 129: the buffer size + DPR we last applied — the per-frame canvas
  // state check (syncCanvasState) and the live-DPR re-read diverge from these.
  let lastBufferW = -1
  let lastBufferH = -1
  let lastDpr = canvasDpr(canvas, options.dpr)
  let dprPollFrame = 0
  let disposed = false
  // Task 137 — the CONTEXT-LOSS contract: a lost context makes every GL
  // call a silent no-op — the canvas stays black while the JS loop
  // (facade ledgers, pills) keeps "running": the exact "particles gone,
  // the counter counts" zombie. The listener stops the loop HONESTLY and
  // reports through the error sink; preventDefault keeps the context
  // RESTORABLE for a future restoreResources() re-attach (the journal is
  // the restore source; the auto-restore wiring stays the documented TODO).
  let contextLost = false
  const onContextLost = (event: Event): void => {
    event.preventDefault?.()
    contextLost = true
    running = false
    options.onGlError?.('WebGL context lost — rendering stopped (the browser/driver dropped this canvas\'s context; re-boot the backend toggle to recover)')
  }
  if (rawContext !== null && typeof (canvas as { addEventListener?: unknown }).addEventListener === 'function') {
    (canvas as HTMLCanvasElement).addEventListener('webglcontextlost', onContextLost)
  }

  const [startW, startH] = getCanvasCssSize(canvas)
  resize(startW, startH) // synchronous initial viewport
  const resizeObserver = observeSize(canvas, options)
  // Task 64 fix: FR cleanup of forgotten handles — ONLY GPU cleanup via the raw
  // facade, WITHOUT writing texture.destroy to the journal. Previously the
  // callback called the session facade: after device-loss GC collected old
  // handles (the demo nulls them at re-init), FR wrote texture.destroy into
  // the LIVE journal → compact() purged create→destroy pairs → "the journal is
  // empty" on the next loss → the scene did not restore.
  // Semantics: FR fires on a LEAK (the user forgot dispose) — it is not the
  // semantic destruction of a resource and has no right to touch the recovery
  // journal. The journal remains the source of truth: restoreResources()
  // will re-create the texture.
  const textureRegistry = makeTextureFinalizationRegistry(textureId => {
    if (session !== null) {
      // Stable id → raw id of the current incarnation; the id is already unknown
      // to the session — the resource was freed explicitly long ago, nothing to clean.
      const raw = session.rawId(textureId)
      if (raw !== undefined) rawGl.deleteTexture(raw)
      return
    }
    // Without resourceSession (v1 path): facade ids, no journal is kept.
    gl.deleteTexture(textureId)
  })
  // StatsCollector — the plumbing for cpuMs/drawCalls/memoryEstimate. If not
  // injected (headless tests or a demo without an explicit injection) — we create our own.
  const ownStatsCollector = options.stats ?? null
  const statsCollector = ownStatsCollector ?? createStatsCollector(options.now)

  function command(spec: DrawSpec): CompiledCommand {
    return compileDrawSpec(spec, ctx)
  }

  function surface(surfaceOptions: SurfaceOptions = {}): Surface<CompiledCommand> {
    const width = surfaceOptions.width ?? 512
    const height = surfaceOptions.height ?? 512
    const depth = surfaceOptions.depth ?? false
    const color = surfaceOptions.color ?? (options.clear ?? DEFAULT_CLEAR).color
    const textureId = gl.createTexture(width, height)
    const targetId = gl.createTarget(textureId, width, height, depth, color)
    let surfaceDisposed = false
    const result: Surface<CompiledCommand> = {
      targetId,
      texture: { textureId, width, height },
      width,
      height,
      pass: (fragment: string, passOptions: PassOptions = {}) =>
        createPassCommand(fragment, passOptions, targetId, () => [width, height]),
      capture: (command: CompiledCommand, captureOptions: { clear?: boolean } = {}) =>
        withTarget(command, targetId, captureOptions.clear !== false),
      // Task 80: readback — synchronous readPixels via the facade (row flip —
      // inside the facade); outside — the unified SurfaceRead contract (RGBA8, top-down).
      read: () => {
        if (surfaceDisposed) {
          return Promise.reject(new Error('rune: surface.read() after dispose — the surface is already released'))
        }
        try {
          return Promise.resolve({ width, height, data: gl.readTargetPixels(targetId) })
        } catch (e) {
          return Promise.reject(e)
        }
      },
      dispose: () => {
        if (surfaceDisposed) return
        surfaceDisposed = true
        gl.deleteTarget(targetId)
        gl.deleteTexture(textureId)
      },
    }
    return result
  }

  function pass(fragment: string, passOptions: PassOptions = {}): CompiledCommand {
    return createPassCommand(fragment, passOptions, 0, () => {
      const [w, h] = size.peek()
      // Task 129: the live DPR read (not the boot snapshot) — a zoom change
      // mid-session must re-derive the pass resolution with the new DPR.
      const dprNow = canvasDpr(canvas, options.dpr)
      return [Math.max(1, Math.round(w * dprNow)), Math.max(1, Math.round(h * dprNow))]
    })
  }

  function createPassCommand(
    fragment: string,
    passOptions: PassOptions,
    targetId: number,
    resolutionSource: () => readonly [number, number],
  ): CompiledCommand {
    const builtins = scanBuiltins(fragment)
    const uniforms: Record<string, unknown> = { ...passOptions.uniforms }
    applyBuiltins(uniforms, builtins, builtinValues, resolutionSource)
    const textures: Record<string, TextureHandle> = {}
    for (const [name, ref] of Object.entries(passOptions.inputs ?? {})) {
      textures[name] = { textureId: ref.textureId }
    }
    const compiled = compileDrawSpec({
      shader: { glsl: { vertex: PASS_VERT_GLSL, fragment } },
      // Fullscreen pass: no depth and no culling — the quad covers everything
      pipeline: { depth: { test: 'always', write: false }, raster: { cull: 'none' } },
      attributes: {
        position: { data: FULLSCREEN_QUAD.positions, size: 2 },
        uv: { data: FULLSCREEN_QUAD.uvs, size: 2 },
      },
      uniforms: uniforms as never,
      textures,
      count: FULLSCREEN_QUAD.vertexCount,
    }, ctx)
    return withTarget(compiled, targetId, passOptions.clear === true)
  }

  function texture(width: number, height: number, options?: { mipLevels?: number; maxAnisotropy?: number; format?: GLTextureFormat }): Texture {
    const mipLevels = options?.mipLevels ?? 1
    // Task 67 HDR: the storage format (rgba8/rgba16f/rgba32f) — goes to the
    // facade (texStorage2D internalFormat + automatic derivation of upload
    // type) and to the journal (texture.create.format → restoration with the
    // same format).
    const format = options?.format
    const textureId = gl.createTexture(width, height, { mipLevels, maxAnisotropy: options?.maxAnisotropy, format })
    // Memory tracking: bytes/pixel by format (rgba16f — 8, rgba32f — 16).
    // A mip chain adds ~33% (sum 1/4+1/16+...). For 256² rgba16f with 9
    // levels: 256*256*8 * 4/3 ≈ 700 KB (2× vs rgba8).
    const bytesPerPixel = format === 'rgba16f' ? 8 : format === 'rgba32f' ? 16 : 4
    const memBytes = Math.round(width * height * bytesPerPixel * (mipLevels > 1 ? 4 / 3 : 1))
    statsCollector?.addMemory(memBytes)
    const handle = makeTextureHandle(textureId, width, height, mipLevels, memBytes)
    // Belt-and-suspenders: if the user forgot to call dispose() and
    // released the handle reference — FR will call gl.deleteTexture for us.
    // BUT! FR is nondeterministic in timing (depends on GC). For production
    // always rely on an explicit dispose().
    textureRegistry.register(handle, textureId)
    return handle
  }

  /** Task 62: a handle over an ALREADY existing stable textureId — for
   *  textures restored by restoreResources() after device loss.
   *  Does not create a GPU resource and does not write to the journal: the
   *  texture.create op is already there. The upload methods and dispose work
   *  through the current facade (stable id). */
  function attachTexture(textureId: number, width: number, height: number, mipLevels = 1): Texture {
    return makeTextureHandle(textureId, width, height, Math.max(1, mipLevels), 0)
  }

  /** The common builder of a TextureView handle (createView and attachView —
   *  one path; Task 62 principle "create and attach — the same code"). Only the
   *  source of viewId differs: freshly created by the facade vs restored from
   *  the journal. onDispose — the parent's bookkeeping (subViews.delete)
   *  before release. */
  function makeTextureViewHandle(
    viewId: number,
    textureId: number,
    baseMipLevel: number,
    mipLevelCount: number | undefined,
    onDispose?: () => void,
  ): TextureView {
    let viewDisposed = false
    return {
      viewId,
      textureId,
      baseMipLevel,
      mipLevelCount,
      dispose: () => {
        if (viewDisposed) return
        viewDisposed = true
        onDispose?.()
        try { gl.deleteTextureView(viewId) } catch { /* the facade is already dead — no-op */ }
      },
    }
  }

  /** Task 64: a handle over an ALREADY existing stable viewId — for views
   *  restored by restoreResources() from the view.create op. Does not create
   *  a GPU resource and does not write to the journal. dispose() →
   *  deleteTextureView (will write view.destroy into the session journal). */
  function attachView(viewId: number, textureId: number, baseMipLevel = 0, mipLevelCount?: number): TextureView {
    return makeTextureViewHandle(viewId, textureId, baseMipLevel, mipLevelCount)
  }

  /** The common builder of a Texture handle (create and attach — one path).
   *  memBytes=0 → no memory tracking (an adopted texture is already counted at create). */
  function makeTextureHandle(textureId: number, width: number, height: number, mipLevels: number, memBytes: number): Texture {
    let manuallyDisposed = false
    // Task 58: sub-views are created via createView. The list is needed for
    // cascade dispose: when the parent texture is disposed we release the views too.
    // (This duplicates the behavior of facade.deleteTexture, which itself removes
    // sub-views from its internal cache — but we hold references to the TextureView
    // handles so that their dispose() also becomes a no-op without throwing.)
    const subViews: Set<TextureView> = new Set()
    const handle: Texture = {
      textureId,
      width,
      height,
      mipLevels,
      upload: (source, options = {}) =>
        streamTexture(uploads, source, width, height,
          (tile, bytes) => gl.texSubImage2D(textureId, tile.x, tile.y, tile.width, tile.height, bytes),
          options),
      uploadImage: (source, options) => gl.texImage2DFromSource(textureId, source, options),
      uploadSubImage: (x, y, source, options) => gl.texSubImage2DFromSource(textureId, x, y, source, options),
      uploadMip: (level, source, options) => gl.texImage2DLevel(textureId, level, source, options),
      createView: (viewOptions) => {
        // Delegate to facade.createTextureView (Task 56: WebGL2 LOD-clamp
        // via TEXTURE_BASE_LEVEL/TEXTURE_MAX_LEVEL; WebGPU — a native
        // GPUTextureView). The facade throws an Error on invalid options
        // (textureId not found, mipLevels < 2, baseMipLevel out of range).
        const viewId = gl.createTextureView(textureId, viewOptions)
        const view: TextureView = makeTextureViewHandle(
          viewId, textureId,
          viewOptions?.baseMipLevel ?? 0,
          viewOptions?.mipLevelCount,
          () => { subViews.delete(view) },
        )
        subViews.add(view)
        return view
      },
      dispose: () => {
        if (manuallyDisposed) return
        manuallyDisposed = true
        // First release all sub-views (so their dispose flags get set and
        // future calls are no-ops). Facade.deleteTexture also removes the
        // sub-views from the cache, but we call explicitly for API symmetry.
        for (const view of subViews) view.dispose()
        subViews.clear()
        gl.deleteTexture(textureId)
        if (memBytes > 0) statsCollector?.subMemory(memBytes)
        // Cancel the FR registration (if any): unregister suppresses the future callback
        textureRegistry.unregister(handle)
      },
    }
    return handle
  }

  function live(spec: DrawSpec, deps: readonly ReadableSignal[] = [], props: unknown = {}): LiveCommand {
    const compiled = compileDrawSpec(spec, ctx)
    const liveCommand = createLiveCommand(segments, w => compiled.record(props, frameCtx, w), deps)
    lives.push(liveCommand)
    return liveCommand
  }

  function frame(callback: (ctx: FrameContext, record: Recorder) => void): FrameHandle {
    frameCallbacks.push(callback)
    return { cancel: () => removeItem(frameCallbacks, callback) }
  }

  function resize(cssWidth: number, cssHeight: number): void {
    // Idempotency: repeated observer firings with the same CSS size (and
    // the same DPR) do not touch the backing store (every canvas.width
    // write resets the buffer). The DPR is RE-READ live on every call: a
    // browser zoom / display move changes devicePixelRatio mid-session,
    // and the boot-time snapshot would mis-size every later buffer.
    const dprNow = canvasDpr(canvas, options.dpr)
    if (cssWidth === lastCssWidth && cssHeight === lastCssHeight && dprNow === lastDpr) return
    lastCssWidth = cssWidth
    lastCssHeight = cssHeight
    lastDpr = dprNow
    const bufferWidth = Math.max(1, Math.round(cssWidth * dprNow))
    const bufferHeight = Math.max(1, Math.round(cssHeight * dprNow))
    if (canvas.width !== bufferWidth) canvas.width = bufferWidth
    if (canvas.height !== bufferHeight) canvas.height = bufferHeight
    lastBufferW = canvas.width
    lastBufferH = canvas.height
    size.value = [cssWidth, cssHeight]
    gl.setViewport(bufferWidth, bufferHeight)
  }

  /** Task 129: the per-frame canvas-state check. The canvas attributes are
   *  the AUTHORITATIVE drawing-buffer size — if anything moved them without
   *  our resize() seeing it (an external canvas.width write, a mobile
   *  URL-bar relayout racing the ResizeObserver, a blocked layout-guard
   *  verdict), our viewport notion is stale and a stale viewport draws the
   *  whole scene into the bottom-left corner. We adopt the real size, re-open
   *  the CSS guard (the next observer callback re-derives the buffer from
   *  CSS × DPR), and say so through the error sink — once per divergence. */
  function syncCanvasState(): void {
    const w = canvas.width
    const h = canvas.height
    if (w !== lastBufferW || h !== lastBufferH) {
      options.onGlError?.(
        `canvas state heal: the drawing buffer moved to ${w}x${h} (tracked ${lastBufferW}x${lastBufferH}) without our resize — the viewport re-synced`,
      )
      lastBufferW = w
      lastBufferH = h
      lastCssWidth = -1 // force the next resize() to re-derive from CSS
      gl.setViewport(w, h)
    }
    // A DPR change WITHOUT a CSS-size change (a browser zoom that keeps the
    // CSS layout, rare but permanent once it happens) would leave the buffer
    // at the boot DPR forever: poll it cheaply (a property read every 64th
    // frame) and re-derive when it moves. OffscreenCanvas has no DPR (it is
    // always 1) — the HTML path only.
    if ((++dprPollFrame & 63) === 0 && options.dpr === undefined && !isOffscreenCanvas(canvas) && canvas.clientWidth > 0) {
      const live = canvasDpr(canvas, undefined)
      if (live !== lastDpr) {
        lastCssWidth = -1 // force the guard open
        resize(canvas.clientWidth, canvas.clientHeight)
      }
    }
  }

  function step(nowMs: number): void {
    updateFrameContext(nowMs)
    statsCollector?.beginFrame()
    transients.beginFrame() // the previous frame's scratch starts aging
    syncCanvasState() // Task 129: the buffer/viewport self-heal, every frame
    try {
      stepFrame()
      frameErrorCount = 0 // a clean frame resets the consecutive count
    } catch (error) {
      // ONE bad frame must not kill the rAF loop forever (scheduleNext is
      // outside this try): report through the GL error sink; three
      // consecutive failures pause the loop with an honest reason instead
      // of a silently frozen canvas.
      frameErrorCount++
      options.onGlError?.(`frame error: ${error instanceof Error ? error.message : String(error)}`)
      if (frameErrorCount >= 3) {
        running = false
        options.onGlError?.(`detected ${frameErrorCount} consecutive frame errors — rendering stopped`)
        return
      }
    }
    statsCollector?.endFrame()
    drainGlErrors()
  }

  /** Consecutive frame-exception count (a clean frame resets it). */
  let frameErrorCount = 0

  /** The frame body — extracted so step() can guard it (see the catch). */
  function stepFrame(): void {
    epoch.frame(() => {
      // M5 (Task 73): transport — snapshot the changed slots at the frame
      // boundary (the epoch): signal mirrors are consistent before the frame callbacks.
      options.transport?.sampleAll()
      // M5 (Task 73): feeds — read published, upload the dirty range
      // in one call, raise the count signal. The frame's commands read
      // an already consistent snapshot.
      for (const feed of feeds) feed.sync()
      time.value = frameCtx.time
      writer.reset()
      writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
      buildFrame(lives, writer)
      emitFrameCallbacks()
      writer.emit(OpCode.EndPass, 0, 0, 0, 0)
      executor.run(writerView(writer))
      uploads.drain() // idle slot: streaming runs after the frame
    })
  }

  /** Task 69: drain silent GL errors once per frame (parity with onGpuError).
   *  getError() returns ONE code and clears the flag — we loop until NO_ERROR
   *  (with a limit to guard against an infinite loop). Errors accumulated by any
   *  ops of the frame (uploads, draws, state switches) are caught here.
   *  CONTEXT_LOST_WEBGL will pass too — duplicating the listener, but earlier
   *  (listener_async — the event is asynchronous). */
  let lastGlErrorKey = ''
  function drainGlErrors(): void {
    if (rawContext === null) return // headless facade injection — no raw context
    const codes: number[] = []
    for (let i = 0; i < 16; i++) {
      const code = rawContext.getError()
      if (code === 0 /* NO_ERROR */) break
      codes.push(code)
    }
    if (codes.length === 0) {
      lastGlErrorKey = ''
      return
    }
    const key = codes.join(',')
    if (key === lastGlErrorKey) return // do not spam the same error every frame
    lastGlErrorKey = key
    const described = codes.map(c => `${glErrorName(c)} (0x${c.toString(16)})`).join(', ')
    options.onGlError?.(`GL error: ${described} — an error accumulated in the last frame (texture creation/uploads/draw)`)
  }

  function updateFrameContext(nowMs: number): void {
    frameCtx.time = (nowMs - startedAt) / 1000
    frameCtx.dt = (nowMs - lastNow) / 1000
    frameCtx.aspect = aspect.peek()
    frameCtx.size = size.peek()
    lastNow = nowMs
  }

  function emitFrameCallbacks(): void {
    for (const callback of [...frameCallbacks]) callback(frameCtx, recordIntoWriter)
  }

  function recordIntoWriter(command: CompiledCommand, props: unknown = {}): void {
    command.record(props, frameCtx, writer)
    statsCollector?.addDrawCall()
  }

  function start(): void {
    if (running) return
    // Task 137 — a lost context does not restart: every GL call would be a
    // silent no-op (the zombie loop — a counting pill over a black canvas).
    if (contextLost) {
      options.onGlError?.('renderer.start() after a WebGL context loss — the context is dead; re-boot the renderer on a NEW canvas to recover')
      return
    }
    running = true
    scheduleNext()
  }

  function scheduleNext(): void {
    const request = options.requestFrame ?? requestFrameDefault
    cancelScheduled = request(timestamp => {
      if (!running || contextLost) return
      step(timestamp)
      if (!running || contextLost) return
      scheduleNext()
    })
  }

  function stop(): void {
    running = false
    cancelScheduled?.()
    cancelScheduled = null
  }

  function observeSize(canvas: AnyCanvas, options: WebGL2RendererOptions): ResizeObserver | null {
    if (options.observeResize === false) return null
    if (isOffscreenCanvas(canvas)) return null
    if (typeof ResizeObserver === 'undefined') return null
    const observer = new ResizeObserver(() => {
      // Task 129: a HIDDEN canvas (clientWidth 0 — the slot folded during a
      // backend re-boot, a display:none interlude) must not poison the CSS
      // guard: getCanvasCssSize would fall back to the BUFFER size as "CSS"
      // and resize() would multiply it by the DPR again. Skip those firings.
      if (canvas.clientWidth <= 0 || canvas.clientHeight <= 0) return
      const [cssW, cssH] = getCanvasCssSize(canvas)
      const verdict = layoutGuard.classify(cssW, cssH)
      if (verdict.verdict !== 'apply') return // ignore: jitter; runaway: the loop is blocked
      resize(verdict.cssWidth, verdict.cssHeight)
    })
    observer.observe(canvas)
    return observer
  }

  /** M5 (Task 73): a renderer feed — a dual-bind channel of instance data.
   *  Creates a GPU mirror (createBuffer — a journaled DeclOp) and hooks
   *  sync onto the frame boundary (inside epoch.frame — the count signal is consistent). */
  function feed(feedOptions: RendererFeedOptions | TransportFeedView): RendererFeed {
    const rendererFeed = createRendererFeedGL(gl, feedOptions)
    feeds.add(rendererFeed)
    return rendererFeed
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    stop()
    resizeObserver?.disconnect()
    // M5: renderer feeds — GPU buffers (GL: deleteBuffer → a journaled
    // destroy; WebGPU: the facade's keyed cache is cleaned by its dispose()).
    for (const rendererFeed of feeds) rendererFeed.dispose()
    feeds.clear()
    // Delete everything accumulated in the facade's internal caches.
    // (the facade can idempotently delete a nonexistent id — but we walk
    // our own records so as not to touch what the user already disposed.)
    // There is no iterator at the facade level — so we rely on the
    // user holding references to Texture/Surface and disposing them
    // themselves. renderer.dispose() is "close the loop + tear down the
    // ResizeObserver + reset the frame context". Full destruction of the GL
    // context is done by the browser when the page goes away.
    //
    // Task 137 — ...except the browser only reclaims the context with the
    // CANVAS, and a re-booting shell (the vfx backend toggle) detaches the
    // old canvas but the JS graph (the frame callbacks, the demo state)
    // can keep it reachable for a long time: every toggle LEAKED a live
    // context, and browsers cap the simultaneous WebGL contexts per page
    // (Chrome ~16, some ANGLE stacks fewer) — past the cap the browser
    // force-loses the least-recently-used context, and the eviction race
    // can land on the ACTIVE one (a black canvas with a counting loop —
    // the "the 2nd and further WebGL runs show nothing" report class).
    // THE FIX: dispose() explicitly loses the context (WEBGL_lose_context)
    // — the driver resources free NOW, the context count stays at ONE per
    // live renderer, and a later boot never evicts. GL calls on a lost
    // context are silently ignored, so the tier teardowns that follow a
    // renderer.dispose() (the vfx shell's activateDemo → state.dispose)
    // remain no-ops — harmless by design.
    if (rawContext !== null) {
      // OUR listener first: the intentional loss below must not fire the
      // "context lost" report from THIS (already disposed) renderer.
      try { (canvas as HTMLCanvasElement).removeEventListener?.('webglcontextlost', onContextLost) } catch { /* best-effort */ }
      try {
        const lose = (rawContext as unknown as { getExtension?: (name: string) => { loseContext?: () => void } | null })
          .getExtension?.('WEBGL_lose_context')
        lose?.loseContext?.()
        contextLost = true
      } catch { /* best-effort — the canvas is going away anyway */ }
    }
  }

  // Caps probing: on the real gl context (if present). Headless mode (createGL
  // injected) — caps = null; tests must inject their own caps.
  // GpuTimer — if the EXT_disjoint_timer_query_webgl2 extension exists. Hooked
  // to statsCollector via setGpuTimer — gpuMs starts being written to snapshot().
  const probedCaps: Caps | null = (() => {
    if (options.caps !== undefined) return options.caps
    if (rawContext === null) return null
    try {
      const query = probeGLCaps(makeGLProbe(rawContext))
      // GPU timer-query: create it if caps.has('timestamp-query'). Hooked into
      // StatsCollector via setGpuTimer — gpuMs will appear in snapshot() in the next frame.
      if (query.features.has('timestamp-query')) {
        const timer: GpuTimer | null = createGLGpuTimer(rawContext)
        if (timer !== null) {
          statsCollector.setGpuTimer(timer)
        }
      }
      // statsProvider always takes a snapshot from statsCollector (external OR our own).
      return createCaps(query, () => statsCollector.snapshot())
    } catch {
      return null
    }
  })()

  return {
    gl,
    caps: probedCaps,
    size,
    aspect,
    time,
    uploads,
    transients,
    transport: options.transport ?? null,
    feed,
    texture,
    attachTexture,
    attachView,
    restoreResources: session !== null ? (options?: { workingSet?: WorkingSet }) => session.restore(options?.workingSet) : undefined,
    ensureResident: session !== null ? (resourceId: number) => session.ensureResident(resourceId) : undefined,
    evictLRU: session !== null ? (options?: { budgetBytes?: number; pinned?: WorkingSet }) => session.evictLRU(options) : undefined,
    residencyStats: session !== null ? () => session.residencyStats() : undefined,
    command,
    pass,
    surface,
    live,
    frame,
    resize,
    step,
    start,
    stop,
    dispose,
  } as WebGL2Renderer
}

function acquireWebGL2(canvas: AnyCanvas): WebGL2RenderingContext {
  // Cascade: some drivers reject antialias+preserveDrawingBuffer together.
  // alpha:false — Task 69: COMPOSITING PARITY with WebGPU (alphaMode:'opaque').
  // With alpha:true (the previous default) transparent frame pixels (e.g. empty
  // atlas regions (0,0,0,0)) become SEE-THROUGH — the compositor shows the
  // page background; the behavior depends on browser/GPU/background styles.
  // With alpha:false alpha is ignored at compositing: the same pixels are
  // black, EXACTLY as on WebGPU. The same scene — the same picture on both
  // backends.
  const attempts: WebGLContextAttributes[] = [
    { antialias: true, preserveDrawingBuffer: true, alpha: false },
    { antialias: false, preserveDrawingBuffer: true, alpha: false },
    { alpha: false },
  ]
  for (const attributes of attempts) {
    const gl = canvas.getContext('webgl2', attributes)
    if (gl !== null) return gl as WebGL2RenderingContext
  }
  const inIframe = typeof window !== 'undefined' && window.self !== window.top
  throw new Error(
    inIframe
      ? 'rune: WebGL2 is unavailable inside this preview window (an iframe without GPU access). ' +
        'Open the page directly in the browser — in a new Chrome/Edge/Safari tab.'
      : 'rune: WebGL2 is unavailable. Enable hardware acceleration in the browser settings ' +
        '(system → Use hardware acceleration, restart) or open the file in an ' +
        'up-to-date Chrome/Edge/Firefox.',
  )
}

function defaultNow(): number {
  return performance.now()
}

/** A human-readable name of a GL error code (WebGL2 spec + CONTEXT_LOST_WEBGL). */
function glErrorName(code: number): string {
  switch (code) {
    case 0x0500: return 'INVALID_ENUM'
    case 0x0501: return 'INVALID_VALUE'
    case 0x0502: return 'INVALID_OPERATION'
    case 0x0503: return 'STACK_OVERFLOW'
    case 0x0504: return 'STACK_UNDERFLOW'
    case 0x0505: return 'OUT_OF_MEMORY'
    case 0x0506: return 'INVALID_FRAMEBUFFER_OPERATION'
    case 0x9242: return 'CONTEXT_LOST_WEBGL'
    default: return `UNKNOWN_${code}`
  }
}

function requestFrameDefault(callback: (timestamp: number) => void): () => void {
  const id = requestAnimationFrame(callback)
  return () => cancelAnimationFrame(id)
}

function removeItem<T>(list: T[], item: T): void {
  const at = list.indexOf(item)
  if (at >= 0) list.splice(at, 1)
}

/** FinalizationRegistry for Texture: belt-and-suspenders.
 *
 * If the user forgot to call texture.dispose() and released the handle
 * reference — GC will collect the object, the FR callback will clean up the
 * GPU texture for us.
 *
 * IMPORTANT: FR is NOT deterministic. It depends on GC, which may not run
 * until memory pressure appears. For production code ALWAYS rely on an
 * explicit dispose(). FR is only a safety net for leaks.
 *
 * IMPORTANT (Task 64): the disposer is invoked ONLY for GPU cleanup. It has
 * no right to write semantic ops (texture.destroy) into the ResourceJournal:
 * FR fires on a leak, not on an intentional release, and the recovery journal
 * must not depend on the GC schedule (after device-loss old handles are
 * collected by GC — this must NOT purge create ops from the journal).
 *
 * env check: in an environment without FinalizationRegistry (old Node/sandbox) —
 * a no-op registry is returned. */
function makeTextureFinalizationRegistry(disposeGpu: (textureId: number) => void): {
  register: (target: object, heldValue: number) => void
  unregister: (target: object) => void
} {
  if (typeof FinalizationRegistry === 'undefined') {
    return { register: () => {}, unregister: () => {} }
  }
  const registry = new FinalizationRegistry((textureId: number) => {
    // GPU-cleanup errors (the facade is already dead after renderer dispose) —
    // silently skipped: nothing to clean.
    try {
      disposeGpu(textureId)
    } catch {
      // the facade is closed — nothing to dispose
    }
  })
  return {
    register: (target, heldValue) => registry.register(target, heldValue),
    unregister: target => registry.unregister(target),
  }
}
