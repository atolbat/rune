import {
  createEpoch,
  createLayoutGuard,
  createTapeWriter,
  createTransientPool,
  derive,
  signal,
  writerView,
  OpCode,
} from '@rune/core'
import type { ReadableSignal, TransientPool, Journal, TransportClient, TransportFeedView } from '@rune/core'
import { createRealGPU } from '@rune/webgpu'
import { compileWgslSpec, createGpuExecutor, createSliceArena, createWgpuContext } from '@rune/webgpu'
import { createUploadScheduler } from '@rune/core'
import type { UploadScheduler, UploadSchedulerOptions } from '@rune/core'
import type { GPUFacade, WgpuCommand, WgpuDrawSpec, GpuTapeExecutor, SliceArena, WgpuCompileContext, TextureHandle } from '@rune/webgpu'
import { createRendererFeedGPU } from './rendererFeed.ts'
import type { RendererFeed, RendererFeedOptions } from './rendererFeed.ts'
import {
  FULLSCREEN_QUAD,
  PASS_VERT_WGSL,
  applyBuiltins,
  createPassBuiltins,
  scanBuiltins,
  withTarget,
} from './surface.ts'
import type { PassOptions, Surface, SurfaceOptions } from './surface.ts'
import { canvasDpr, getCanvasCssSize, isOffscreenCanvas, resolveCanvasAny } from './canvasHelpers.ts'
import type { AnyCanvas } from './canvasHelpers.ts'
import { withJournalGpu } from './journalGpu.ts'
import { createResourceSessionGPU } from './resourceSessionGPU.ts'
import type { ResourceJournal, RestoreReport, WorkingSet, EvictionReport, ResidencyStats } from '@rune/core'

/** WebGPU renderer frame context (shape-compatible with the WebGL2 facade). */
export interface GpuFrameContext {
  time: number
  dt: number
  aspect: number
  size: readonly [number, number]
}

/** Records a WG command of the current frame (into the tape, as in WebGL2). */
export type GpuRecorder = (command: WgpuCommand, props?: unknown) => void

/** Frame callback: context + recording commands into the tape. */
export type GpuFrameCallback = (ctx: GpuFrameContext, record: GpuRecorder) => void
/** WebGPU renderer: device, auto loop, resize/DPR, sim-time. */
export interface WebGpuRenderer {
  readonly gpu: GPUFacade
  /** Task 62: replay ResourceJournal v2 on a FRESH facade of this session —
   *  device-loss recovery. Present only with the resources option.
   *  Task 65: options.workingSet — soft reset (restore only the scene;
   *  the rest lazily via ensureResident). */
  restoreResources?(options?: { workingSet?: WorkingSet }): RestoreReport
  /** Task 65: lazily bring back ONE deferred resource after a soft reset
   *  (texture/view/target id). null — already resident / no session. */
  ensureResident?(resourceId: number): RestoreReport | null
  /** Task 66: LRU eviction of resident textures down to a GPU memory budget
   *  (parity with the WebGL2 renderer; memory pressure between losses). */
  evictLRU?(options?: { budgetBytes?: number; pinned?: WorkingSet }): EvictionReport
  /** Task 66: resident GPU memory estimate + LRU order (diagnostics). */
  residencyStats?(): ResidencyStats
  readonly size: ReadableSignal<readonly [number, number]>
  readonly aspect: ReadableSignal<number>
  readonly time: ReadableSignal<number>
  /** Streaming scheduler: tasks in each frame's idle slot. */
  readonly uploads: UploadScheduler
  /** Per-frame scratch array pool (idea #2): parity with the WebGL2 renderer. */
  readonly transients: TransientPool
  /** M5 (Task 73): reader transport client — mode diagnostics
   *  (renderer.transport.mode, dossier §7.2). null — no transport. */
  readonly transport: TransportClient | null
  /** M5 (Task 73): renderer feed (dual-bind: vertex attributes + storage;
   *  sync — one writeBuffer call at the frame boundary). */
  feed(options: RendererFeedOptions | TransportFeedView): RendererFeed
  /** Compiles a WG spec into a command (tapes, slice arena, lazy pipeline). */
  command(spec: WgpuDrawSpec): WgpuCommand
  /** Fullscreen pass to the canvas: inputs → fragment → screen. */
  pass(fragment: string, options?: PassOptions): WgpuCommand
  /** Target surface: texture + fullscreen passes into it. */
  surface(options?: SurfaceOptions): Surface<WgpuCommand>
  frame(callback: GpuFrameCallback): { cancel(): void }
  resize(cssWidth: number, cssHeight: number): void
  step(nowMs: number): void
  start(): void
  stop(): void
  /** Clears the error-storm pause and resumes the loop. */
  restart(): void
  /** Full teardown: stop rAF + disconnect ResizeObserver + GPUFacade.dispose()
   *  (destroying all textures/buffers/pipelines + device.destroy()).
   *  Unlike WebGL2, a WebGPU device deterministically frees
   *  all GPU memory via device.destroy() — this is critical with frequent
   *  switch backend in kit-demo: without destroy() GPU memory leaks.
   *  For releasing WebGL2 textures one by one use
   *  Texture.dispose() / Surface.dispose() — that is gpu.deleteTexture.
   *  Idempotent: a repeated dispose is a no-op. */
  dispose(): void
}

export interface WebGpuRendererOptions {
  readonly canvas: AnyCanvas | string
  readonly dpr?: number
  readonly uploads?: UploadSchedulerOptions
  /** GPU facade injection for headless tests. */
  readonly createGPU?: (canvas: AnyCanvas, onError?: (message: string) => void) => Promise<GPUFacade>
  /** Sink for silent WebGPU validation errors (they throw no exceptions). */
  readonly onGpuError?: (message: string) => void
  readonly requestFrame?: (callback: (timestamp: number) => void) => () => void
  readonly observeResize?: boolean
  readonly now?: () => number
  /** Journal — a registry of long-lived declarations for device-loss recovery
   *  (= switchBackend = worker migration). Task 57: WebGPU parity with WebGL2.
   *  If passed, the GPUFacade is wrapped with the withJournalGpu decorator:
   *  create/destroy ops (createTexture, createTarget, createTextureView,
   *  copyExternalImageToTexture as a full-texture upload) are written automatically.
   *  Replay — via replayJournalOnGpu(journal, newGpu, sourceFor).
   *
   *  Frame ops (usePipeline, bindUniforms, bindTexture, draw, submit etc.)
   *  are NOT journaled — those are per-frame, they go to the Tape, not the Journal.
   *  The WGSL source of pipelines is stored in WgpuCommand (compiled), so for
   *  device-loss recovery it is enough to replay only textures/targets/views —
   *  pipelines are recreated automatically on the first draw on the new device. */
  readonly journal?: Journal
  /** Task 62: ResourceJournal v2 — stable ids + content in the journal.
   *  Parity with the WebGL2 path (webgl2Renderer.ts): the GPUFacade is wrapped
   *  with the resourceSession decorator, restoreResources() restores
   *  textures/targets/views AND THEIR CONTENT on a fresh device.
   *  Takes priority over journal (v1). */
  readonly resources?: ResourceJournal
  /** M5 (Task 73): reader transport client (renderer.transport). */
  readonly transport?: TransportClient
}

/** Storm threshold: after this many GPU errors the renderer is paused. */
const ERROR_STORM_LIMIT = 3

/** Creates a WebGPU renderer: frame = beginPass → callbacks → endPass → submit.
 * Storm protection: after ERROR_STORM_LIMIT GPU errors the loop stops. */
export async function createWebGpuRenderer(options: WebGpuRendererOptions): Promise<WebGpuRenderer> {
  const canvas = resolveCanvasAny(options.canvas)
  const dpr = canvasDpr(canvas, options.dpr)
  const storm = createErrorStorm(options.onGpuError)
  const rawGpu = options.createGPU !== undefined
    ? await options.createGPU(canvas, storm.handle)
    : await createRealGPU(canvas, storm.handle)
  // Task 62: resourceSession (v2) — priority over journal (v1).
  // Stable ids above the facade + content in the journal + restoreResources().
  const session = options.resources !== undefined ? createResourceSessionGPU(rawGpu, options.resources) : null
  // Task 57 (v1): Journal decorator for WebGPU (parity with WebGL2).
  const gpu: GPUFacade = session !== null
    ? session.facade
    : (options.journal !== undefined ? withJournalGpu(rawGpu, options.journal) : rawGpu)

  const epoch = createEpoch()
  const layoutGuard = createLayoutGuard()
  const uploads = createUploadScheduler(options.uploads ?? {})
  const transients = createTransientPool() // idea #2: scratch without GC
  const feeds = new Set<RendererFeed>() // M5: sync at the frame boundary
  const builtinValues = createPassBuiltins() // u_time/u_resolution/u_texel of passes
  const writer = createTapeWriter(64)
  const arena: SliceArena = createSliceArena(1 << 16)
  const wgslCtx: WgpuCompileContext = createWgpuContext(arena)
  // the executor holds THE SAME reference to the command array: compileWgslSpec appends to it
  const executor: GpuTapeExecutor = createGpuExecutor({ gpu, arena, commands: wgslCtx.commands, clears: [] })
  const [initW, initH] = getCanvasCssSize(canvas)
  const size = signal<readonly [number, number]>([initW, initH])
  const aspect = derive(() => size.value[0] / size.value[1])
  const time = signal(0)
  const frameCtx: GpuFrameContext = { time: 0, dt: 0, aspect: 1, size: [1, 1] }
  const callbacks: GpuFrameCallback[] = []
  const startedAt = (options.now ?? defaultNow)()
  let lastNow = startedAt
  let running = false
  let cancelScheduled: (() => void) | null = null
  let lastCssWidth = -1
  let lastCssHeight = -1

  await gpu.configure(canvas.width, canvas.height)
  const [startW, startH] = getCanvasCssSize(canvas)
  resize(startW, startH)
  const resizeObserver = observeSize(canvas, options)
  let disposed = false

  function frame(callback: GpuFrameCallback): { cancel(): void } {
    callbacks.push(callback)
    return { cancel: () => removeItem(callbacks, callback) }
  }

  function command(spec: WgpuDrawSpec): WgpuCommand {
    return compileWgslSpec(spec, wgslCtx)
  }

  function surface(surfaceOptions: SurfaceOptions = {}): Surface<WgpuCommand> {
    const width = surfaceOptions.width ?? 512
    const height = surfaceOptions.height ?? 512
    const depth = surfaceOptions.depth ?? false
    const color = surfaceOptions.color ?? DEFAULT_SURFACE_COLOR
    // Canvas format: pipelines (targets: [format]) fit both the canvas
    // and the surface — no second pipeline-creation branch
    const textureId = gpu.createTexture(width, height, 'canvas')
    const targetId = gpu.createTarget(textureId, width, height, depth, color)
    let surfaceDisposed = false
    return {
      targetId,
      texture: { textureId, width, height },
      width,
      height,
      pass: (fragment: string, passOptions: PassOptions = {}) =>
        createPassCommand(fragment, passOptions, targetId, () => [width, height]),
      capture: (command: WgpuCommand, captureOptions: { clear?: boolean } = {}) =>
        withTarget(command, targetId, captureOptions.clear !== false),
      // Task 80: readback — asynchronous (copyTextureToBuffer → submit →
      // mapAsync); the facade returns already tight RGBA top-down — like GL.
      read: () => {
        if (surfaceDisposed) {
          return Promise.reject(new Error('rune: surface.read() after dispose — surface already released'))
        }
        return gpu.readTargetPixels(targetId).then(data => ({ width, height, data }))
      },
      dispose: () => {
        if (surfaceDisposed) return
        surfaceDisposed = true
        gpu.deleteTarget(targetId)
        gpu.deleteTexture(textureId)
      },
    }
  }

  function pass(fragment: string, passOptions: PassOptions = {}): WgpuCommand {
    return createPassCommand(fragment, passOptions, 0, () => {
      const [w, h] = size.peek()
      return [Math.max(1, Math.round(w * dpr)), Math.max(1, Math.round(h * dpr))]
    })
  }

  function createPassCommand(
    fragment: string,
    passOptions: PassOptions,
    targetId: number,
    resolutionSource: () => readonly [number, number],
  ): WgpuCommand {
    const inputs = Object.entries(passOptions.inputs ?? {})
    if (inputs.length > 1) {
      throw new Error('rune: v1 WebGPU pass — a single texture input (bind group group 1); use sequential passes for chains')
    }
    const builtins = scanBuiltins(fragment)
    const uniforms: Record<string, unknown> = { ...passOptions.uniforms }
    applyBuiltins(uniforms, builtins, builtinValues, resolutionSource)
    const textures: Record<string, TextureHandle> = {}
    for (const [name, ref] of inputs) {
      textures[name] = { textureId: ref.textureId }
    }
    const compiled = compileWgslSpec({
      shader: { wgsl: PASS_VERT_WGSL + fragment },
      uniforms,
      attributes: {
        position: { data: FULLSCREEN_QUAD.positions, size: 2 },
        uv: { data: FULLSCREEN_QUAD.uvs, size: 2 },
      },
      textures,
      count: FULLSCREEN_QUAD.vertexCount,
    }, wgslCtx)
    return withTarget(compiled, targetId, passOptions.clear === true)
  }

  /** Records a WG command into the frame tape (called from frame callbacks). */
  function recordIntoWriter(command: WgpuCommand, props: unknown = {}): void {
    command.record(props, frameCtx, writer)
  }

  function resize(cssWidth: number, cssHeight: number): void {
    if (cssWidth === lastCssWidth && cssHeight === lastCssHeight) return
    lastCssWidth = cssWidth
    lastCssHeight = cssHeight
    const bufferWidth = Math.max(1, Math.round(cssWidth * dpr))
    const bufferHeight = Math.max(1, Math.round(cssHeight * dpr))
    if (canvas.width !== bufferWidth) canvas.width = bufferWidth
    if (canvas.height !== bufferHeight) canvas.height = bufferHeight
    size.value = [cssWidth, cssHeight]
    gpu.resize(bufferWidth, bufferHeight)
  }

  function step(nowMs: number): void {
    if (storm.paused) return // error storm: rendering paused
    updateFrameContext(nowMs)
    transients.beginFrame() // last frame's scratch starts aging
    epoch.frame(() => {
      // M5 (Task 73): transport — snapshot of slots at the frame boundary (epoch),
      // then feeds — one writeBuffer call for the dirty range.
      options.transport?.sampleAll()
      for (const feed of feeds) feed.sync()
      time.value = frameCtx.time
      writer.reset()
      writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
      for (const callback of [...callbacks]) callback(frameCtx, recordIntoWriter)
      writer.emit(OpCode.EndPass, 0, 0, 0, 0)
      executor.run(writerView(writer)) // tapes: the same path as WebGL2
      uploads.drain() // idle slot: streaming after the frame
    })
  }

  function updateFrameContext(nowMs: number): void {
    frameCtx.time = (nowMs - startedAt) / 1000
    frameCtx.dt = (nowMs - lastNow) / 1000
    frameCtx.aspect = aspect.peek()
    frameCtx.size = size.peek()
    lastNow = nowMs
  }

  function start(): void {
    if (running) return
    if (storm.paused) return // after a storm, start manually via restart()
    running = true
    scheduleNext()
  }

  function scheduleNext(): void {
    const request = options.requestFrame ?? defaultRequestFrame
    cancelScheduled = request(timestamp => {
      if (!running) return
      step(timestamp)
      scheduleNext()
    })
  }

  function stop(): void {
    running = false
    cancelScheduled?.()
    cancelScheduled = null
  }

  function restart(): void {
    storm.resume()
    start()
  }

  function observeSize(canvas: AnyCanvas, options: WebGpuRendererOptions): ResizeObserver | null {
    if (options.observeResize === false) return null
    if (isOffscreenCanvas(canvas)) return null
    if (typeof ResizeObserver === 'undefined') return null
    const observer = new ResizeObserver(() => {
      const [cssW, cssH] = getCanvasCssSize(canvas)
      const verdict = layoutGuard.classify(cssW, cssH)
      if (verdict.verdict !== 'apply') return
      resize(verdict.cssWidth, verdict.cssHeight)
    })
    observer.observe(canvas)
    return observer
  }

  /** M5 (Task 73): renderer feed — keyed buffer by stable view,
   *  one writeBuffer call at the frame boundary. */
  function feed(feedOptions: RendererFeedOptions | TransportFeedView): RendererFeed {
    const rendererFeed = createRendererFeedGPU(gpu, feedOptions)
    feeds.add(rendererFeed)
    return rendererFeed
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    stop()
    resizeObserver?.disconnect()
    // M5: feeds (facade keyed buffers — device.destroy() in gpu.dispose()
    // frees them deterministically).
    for (const rendererFeed of feeds) rendererFeed.dispose()
    feeds.clear()
    // Full GPU facade teardown: device.destroy() deterministically frees all
    // of the device's GPU memory (textures/buffers/
    // pipelines/samplers, including ones not explicitly destroyed). This is
    // critical with frequent switch backend in kit-demo: without destroy()
    // each switch would create a new GPUDevice while the old ones
    // stayed alive until page unload → GPU memory leak.
    gpu.dispose()
  }

  return { gpu, size, aspect, time, uploads, transients, transport: options.transport ?? null, feed, restoreResources: session !== null ? (options?: { workingSet?: WorkingSet }) => session.restore(options?.workingSet) : undefined, ensureResident: session !== null ? (resourceId: number) => session.ensureResident(resourceId) : undefined, evictLRU: session !== null ? (options?: { budgetBytes?: number; pinned?: WorkingSet }) => session.evictLRU(options) : undefined, residencyStats: session !== null ? () => session.residencyStats() : undefined, command, pass, surface, frame, resize, step, start, stop, restart, dispose }
}

/** Default surface clear color — the renderer background. */
const DEFAULT_SURFACE_COLOR: readonly [number, number, number, number] = [0.07, 0.08, 0.11, 1]

/** Storm guard: counts GPU errors; past the limit it stops the loop. */
interface ErrorStorm {
  readonly paused: boolean
  readonly handle: (message: string) => void
  resume(): void
}

function createErrorStorm(report?: (message: string) => void): ErrorStorm {
  let count = 0
  let paused = false
  return {
    get paused() { return paused },
    handle: (message: string): void => {
      if (paused) return // silence after the pause: no spam
      count++
      report?.(message)
      if (count >= ERROR_STORM_LIMIT) {
        paused = true
        report?.(`detected ${count} GPU errors — rendering stopped (storm pause)`)
      }
    },
    resume(): void {
      count = 0
      paused = false
    },
  }
}

function defaultRequestFrame(callback: (timestamp: number) => void): () => void {
  // requestAnimationFrame is a property of window, not of the prototype: a bare call is legal
  const id = requestAnimationFrame(callback)
  return () => cancelAnimationFrame(id)
}

function defaultNow(): number {
  return performance.now() // called from its owner: a native method torn
  // out of its object throws "Illegal invocation" in Chrome
}

function removeItem<T>(list: T[], item: T): void {
  const at = list.indexOf(item)
  if (at >= 0) list.splice(at, 1)
}
