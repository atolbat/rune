/**
 * The unified createRenderer — a layer over WebGL2/WebGPU with automatic backend selection.
 *
 * Contract (see DESIGN.md §9.12):
 * 1. createRenderer(opts) is SYNCHRONOUS, no GPU work. Returns a wrapper.
 * 2. command(spec) before .start(): records the spec, returns a proxy CompiledCommand.
 * 3. frame(cb) before .start(): records the callback.
 * 4. start() is ASYNCHRONOUS: probe hardware → resolveBackend → creates the
 *    inner renderer of the chosen backend → proxies pending specs/frames → starts rAF.
 * 5. command(spec) after .start(): late-reject — if spec.shader does not cover
 *    the chosen backend, throws an actionable error.
 * 6. surface/pass/texture require .start() (a GL/GPU context is needed).
 *
 * Lazy discovery replaces the pre-declaration `specs: DrawSpec[]` of round 2
 * (the "specs twice" boilerplate). Specs are collected automatically from
 * what the user actually calls in command(). The decision is made at .start() —
 * that is the "pre-check before the first render".
 *
 * BackendResolutionError — thrown from .start() if chosen === null.
 * Carries a structured BackendDecision with verdicts and coverage.
 */

import type { AutoDrawSpec, BackendDecision, BackendId } from './autoBackend.ts'
import { resolveBackend } from './autoBackend.ts'
import { createWebGL2Renderer } from './webgl2Renderer.ts'
import type { WebGL2Renderer, WebGL2RendererOptions, FrameContext, FrameHandle, Texture, TextureView } from './webgl2Renderer.ts'
import { createWebGpuRenderer } from './webgpuRenderer.ts'
import type { WebGpuRenderer, WebGpuRendererOptions, GpuFrameContext } from './webgpuRenderer.ts'
import type { CompiledCommand, GLImageSource } from '@rune/webgl2'
import type { WgpuCommand, GPUImageSource, GPUFacade } from '@rune/webgpu'
import { probeGPUCaps, makeGPUProbe, externalImageSize } from '@rune/webgpu'
import type { TapeWriter, UploadScheduler, UploadSchedulerOptions, TransientPool, ReadableSignal, Journal, ResourceJournal, RestoreReport, WorkingSet, EvictionReport, ResidencyStats, TextureFormat, TransportClient, TransportFeedView } from '@rune/core'
import { createCaps, createStatsCollector } from '@rune/core'
import type { RendererFeed, RendererFeedOptions } from './rendererFeed.ts'
import { glFormatFromTextureFormat } from './resourceSessionGL.ts'
import type { Caps, StatsCollector } from '@rune/core'
import type { Surface, SurfaceOptions, PassOptions } from './surface.ts'
import type { AnyCanvas } from './canvasHelpers.ts'

/** A union command — both have record(), the structure is compatible by shape. */
export type AnyCommand = CompiledCommand | WgpuCommand

/** Re-export of handle types (autoRenderer and consumers import them
 *  from renderer.ts — the single entry point of the unified layer). */
export type { FrameContext, Recorder, FrameHandle, Texture, TextureView } from './webgl2Renderer.ts'

/** Unified frame callback: FrameContext and GpuFrameContext are structurally identical. */
export type AnyFrameCallback =
  | ((ctx: FrameContext, record: AnyRecorder) => void)
  | ((ctx: GpuFrameContext, record: AnyRecorder) => void)
export type AnyRecorder = (command: AnyCommand, props?: unknown) => void

export interface RendererOptions {
  readonly canvas: AnyCanvas | string
  /** Order of attempts. Default ['webgpu', 'webgl2']. A string = strict (no fallback). */
  readonly backend?: BackendId | readonly BackendId[]
  readonly dpr?: number
  readonly clear?: WebGL2RendererOptions['clear']
  readonly uploads?: UploadSchedulerOptions
  /** GL facade injection for headless tests. */
  readonly createGL?: WebGL2RendererOptions['createGL']
  /** GPU facade injection for headless tests. */
  readonly createGPU?: WebGpuRendererOptions['createGPU']
  /** Sink for silent WebGPU validation errors (they do not throw). */
  readonly onGpuError?: WebGpuRendererOptions['onGpuError']
  /** Task 69: sink for silent WebGL2 GL errors (a once-per-frame getError drain —
   *  parity with onGpuError). Without a channel GL_INVALID_* silently turn
   *  into a "black canvas" with no diagnostics. */
  readonly onGlError?: WebGL2RendererOptions['onGlError']
  readonly requestFrame?: (callback: (timestamp: number) => void) => () => void
  readonly observeResize?: boolean
  readonly now?: () => number
  /** WebGPU probe injection — for tests. */
  readonly probeGpu?: () => Promise<boolean>
  /** WebGL2 probe injection — for tests. Default: typeof WebGL2RenderingContext. */
  readonly probeGl2?: () => boolean
  /** Journal — a registry of long-lived declarations for device-loss recovery
   *  (= switchBackend = worker migration). Applied to BOTH backends
   *  (Task 57: the WebGPU decorator added; before that only the WebGL2 path).
   *  If journal is passed and chosen=webgl2 — GLFacade is wrapped withJournal.
   *  If chosen=webgpu — GPUFacade is wrapped withJournalGpu. Replay —
   *  via replayJournalOn (WebGL2) or replayJournalOnGpu (WebGPU). */
  readonly journal?: Journal
  /** Task 62: ResourceJournal v2 — the UNIFIED journal of primary
   *  resources WITH CONTENT: texture.create/write/update/writeMip, view.*,
   *  target.*. Stable ids survive device loss; the ContentStore
   *  keeps CPU pixel sources. After re-init call
   *  renderer.restoreResources() — resources AND content come back.
   *  Takes priority over journal (v1). */
  readonly resources?: ResourceJournal
  /** M5 (Task 73): the reader's transport client — renderer.transport
   *  (T0–T3 mode diagnostics, dossier §7.2). Optional. */
  readonly transport?: TransportClient
}

/** The unified renderer: commands both backends. */
export interface Renderer {
  readonly size: ReadableSignal<readonly [number, number]>
  readonly aspect: ReadableSignal<number>
  readonly time: ReadableSignal<number>
  readonly uploads: UploadScheduler
  readonly transients: TransientPool
  /** Escape-hatch to the concrete backend (for WebGL2-only methods like .gl/.live). */
  readonly inner: WebGL2Renderer | WebGpuRenderer | null
  /** The chosen backend (null before .start()). */
  readonly backend: BackendId | null
  /** The structured decision (null before .start()). */
  readonly decision: BackendDecision | null
  /** Capabilities of the chosen backend (null before .start()).
   *
   *  M4 (DESIGN.md §11.4): caps.has(FeatureId), caps.format(format, axis),
   *  caps.path(name), caps.ext(name), caps.stats(), caps.limit(name),
   *  caps.invalidate(). Probing runs once at .start() — on
   *  WebGL2 via gl.getExtension + gl.getParameter, on WebGPU via
   *  adapter.features + adapter.limits. invalidate() is called on
   *  contextlost / device.lost — the user must re-probe and re-create
   *  caps (see TODO webglcontextlost). */
  readonly caps: Caps | null
  texture(width: number, height: number, options?: { mipLevels?: number; maxAnisotropy?: number; format?: TextureFormat }): Texture
  /** Task 62: a handle over an existing stable textureId — a texture
   *  restored by restoreResources() after device loss. Does not create a
   *  GPU resource and does not write to the journal (the texture.create op
   *  is already there). */
  attachTexture(textureId: number, width: number, height: number, mipLevels?: number): Texture
  /** Task 64: a handle over an existing stable viewId — a view restored
   *  by restoreResources() from the view.create op (viewId ≥ 1M). Does not
   *  create a GPU resource and does not write to the journal (the view.create
   *  op is already there). dispose() releases the view (view.destroy into
   *  the session journal). Release the parent texture separately:
   *  attachTexture(...).dispose(). */
  attachView(viewId: number, textureId: number, baseMipLevel?: number, mipLevelCount?: number): TextureView
  /** Task 62: restore primary resources FROM ResourceJournal v2 onto a
   *  fresh facade of the current inner — device-loss recovery. Returns a
   *  report (stable ids of live resources + content counters) or null if
   *  the renderer was created without the resources option. Call AFTER
   *  re-init, BEFORE creating new resources.
   *
   *  Task 65 soft reset: options.workingSet — restore ONLY the closure of
   *  the working set (the current scene + its content + parents of views);
   *  the other live resources remain in the journal as declarations
   *  (report.deferred) and will come back lazily via ensureResident().
   *  Without options — a full replay (strategy='full'). */
  restoreResources(options?: { workingSet?: WorkingSet }): RestoreReport | null
  /** Task 65: lazy return of ONE deferred resource after a soft reset
   *  (textureId / viewId ≥ 1M / targetId). Replays a sublist of the journal
   *  (create + content + dependencies) onto the current facade through the
   *  same code path as live operation. Idempotent: an already resident
   *  resource → null. Also null if the renderer has no resources option. */
  ensureResident(resourceId: number): RestoreReport | null
  /** Task 66: LRU eviction of resident textures down to a GPU memory
   *  budget — memory pressure management BETWEEN losses (catalog #14
   *  pressure→evict). Evicts the least recently used (LRU) textures until
   *  the resident memory estimate fits into budgetBytes; pinned (e.g. the
   *  scene) is untouchable. Evicted resources do NOT die: declarations and
   *  content remain in the journal, the resource will come back via
   *  ensureResident() through the same code path. Usage is marked
   *  automatically (bind/upload/view/target through the session facade).
   *  A null report never happens: an empty plan is a legitimate "budget not
   *  exceeded" result. */
  evictLRU(options?: { budgetBytes?: number; pinned?: WorkingSet }): EvictionReport | null
  /** Task 66: resident GPU memory estimate + LRU order (diagnostics;
   *  null — the renderer has no resources option). */
  residencyStats(): ResidencyStats | null
  /** Lazy: before .start() records the spec + returns a proxy; after — late-reject. */
  command(spec: AutoDrawSpec): AnyCommand
  pass(fragment: string, options?: PassOptions): AnyCommand
  surface(options?: SurfaceOptions): Surface<AnyCommand>
  /** M5 (Task 73): the renderer feed (dual-bind: vertex + storage).
   *  Requires .start() (like surface/texture) — the backend facade is needed. */
  feed(options: RendererFeedOptions | TransportFeedView): RendererFeed
  /** M5 (Task 73): the reader's transport client (null — not passed). */
  readonly transport: TransportClient | null
  frame(callback: AnyFrameCallback): FrameHandle
  resize(cssWidth: number, cssHeight: number): void
  step(nowMs: number): void
  start(): Promise<void>
  stop(): void
  /** Full teardown: stop() + inner.dispose() (disconnect the ResizeObserver
   *  + for WebGL2 — GL context destruction is not done; the browser will do
   *  it itself when the page goes away). After dispose the renderer is unusable.
   *  Idempotent. */
  dispose(): void
  /** Alias to decision for debugging (as in DESIGN.md §9.12.5). */
  whyBackend(): BackendDecision | null
}

/** An error with a structured decision — the catching code can show the verdicts. */
export class BackendResolutionError extends Error {
  readonly decision: BackendDecision
  constructor(decision: BackendDecision) {
    super(decision.message)
    this.name = 'BackendResolutionError'
    this.decision = decision
  }
}

/** The main entry point: a unified renderer with automatic backend selection. */
export function createRenderer(options: RendererOptions): Renderer {
  const order = normalizeOrder(options.backend)
  const pendingSpecs: AutoDrawSpec[] = []
  const pendingFrames: AnyFrameCallback[] = []
  const proxies: Array<{ proxy: ProxyCommand; spec: AutoDrawSpec }> = []
  let decision: BackendDecision | null = null
  let inner: WebGL2Renderer | WebGpuRenderer | null = null
  let caps: Caps | null = null
  let statsCollector: StatsCollector | null = null

  function requireInner(method: string): WebGL2Renderer | WebGpuRenderer {
    if (inner === null) {
      throw new Error(
        `rune: renderer.${method}() requires .start(). ` +
        'First await renderer.start(), then create surfaces/textures/passes.',
      )
    }
    return inner
  }

  return {
    get size() { return requireInner('size').size },
    get aspect() { return requireInner('aspect').aspect },
    get time() { return requireInner('time').time },
    get uploads() { return requireInner('uploads').uploads },
    get transients() { return requireInner('transients').transients },
    get inner() { return inner as WebGL2Renderer | WebGpuRenderer | null },
    get backend() { return decision?.chosen ?? null },
    get decision() { return decision },
    get caps() { return caps },
    get transport() { return options.transport ?? null },

    feed(feedOptions) {
      // M5: the feed needs the chosen backend's facade (the GPU mirror) —
      // only after .start() (like surface/texture). Dossier §4.3: the render
      // worker creates the renderer already with a ready device.
      return requireInner('feed').feed(feedOptions)
    },

    texture(w, h, options) {
      const i = requireInner('texture')
      const mipLevels = options?.mipLevels ?? 1
      const maxAnisotropy = options?.maxAnisotropy
      // Task 67 HDR: the storage format is the single journal type TextureFormat;
      // the GL path maps it to GLTextureFormat ('rgba16float' → 'rgba16f'),
      // the GPU path passes it as is. Both backends restore the format from
      // the journal after device loss (texture.create carries format).
      const format = options?.format
      if ('gl' in i) {
        return i.texture(w, h, { mipLevels, maxAnisotropy, format: glFormatFromTextureFormat(format) }) as Texture
      }
      // WebGPU: textures via gpu.createTexture (with mipLevels if passed);
      // a wrapper as in showWebgpu.ts. Task 58: createView added for parity
      // with the WebGL2 path — calls gpu.createTextureView/deleteTextureView.
      const gpu = i.gpu
      const textureId = gpu.createTexture(w, h, format ?? 'rgba8unorm', { mipLevels, maxAnisotropy })
      return makeGpuTextureHandle(gpu, textureId, w, h, mipLevels)
    },

    attachTexture(textureId, width, height, mipLevels = 1) {
      const i = requireInner('attachTexture')
      if ('gl' in i) return i.attachTexture(textureId, width, height, mipLevels) as Texture
      // WebGPU: a handle over the restored stable id (the GPU resource is
      // already created by restoreResources; nothing is written to the journal).
      return makeGpuTextureHandle(i.gpu, textureId, width, height, Math.max(1, mipLevels))
    },

    attachView(viewId, textureId, baseMipLevel = 0, mipLevelCount) {
      const i = requireInner('attachView')
      if ('gl' in i) return i.attachView(viewId, textureId, baseMipLevel, mipLevelCount) as TextureView
      // WebGPU: a handle over the restored stable viewId (the GPU view is
      // already created by restoreResources from the view.create op; nothing
      // is written to the journal).
      return makeGpuTextureViewHandle(i.gpu, viewId, textureId, baseMipLevel, mipLevelCount)
    },

    restoreResources(options) {
      const i = requireInner('restoreResources')
      const restore = (i as WebGL2Renderer & WebGpuRenderer).restoreResources
      return restore !== undefined ? restore.call(i, options) : null
    },

    ensureResident(resourceId) {
      const i = requireInner('ensureResident')
      const ensure = (i as WebGL2Renderer & WebGpuRenderer).ensureResident
      return ensure !== undefined ? ensure.call(i, resourceId) : null
    },

    evictLRU(options) {
      const i = requireInner('evictLRU')
      const evict = (i as WebGL2Renderer & WebGpuRenderer).evictLRU
      return evict !== undefined ? evict.call(i, options) : null
    },

    residencyStats() {
      const i = requireInner('residencyStats')
      const stats = (i as WebGL2Renderer & WebGpuRenderer).residencyStats
      return stats !== undefined ? stats.call(i) : null
    },

    command(spec) {
      if (inner !== null) {
        // After start — late-reject + delegate
        assertCovers(spec, decision!, 'inner')
        return adaptAndCompile(spec, decision!.chosen!, inner)
      }
      // Before start — record the spec, return a proxy
      pendingSpecs.push(spec)
      const proxy = makeProxyCommand()
      proxies.push({ proxy, spec })
      return proxy as unknown as AnyCommand
    },

    pass(fragment, passOptions) {
      return requireInner('pass').pass(fragment, passOptions)
    },

    surface(surfaceOptions) {
      return requireInner('surface').surface(surfaceOptions) as Surface<AnyCommand>
    },

    frame(callback) {
      if (inner !== null) return inner.frame(callback as never)
      pendingFrames.push(callback)
      return { cancel: () => removeItem(pendingFrames, callback) }
    },

    resize(w, h) {
      if (inner === null) return // canvas not created yet — the initial resize will be done by inner
      inner.resize(w, h)
    },

    step(now) {
      requireInner('step').step(now)
    },

    async start() {
      if (inner !== null) {
        // Already initialized — just resume rAF after stop()
        inner.start()
        return
      }
      // Probe hardware — only for the backends in order (Task 75: strict
      // webgl2 should not pay for navigator.gpu.requestAdapter() — on
      // SwiftShader/software renderers that takes seconds).
      const hardware = await probeHardware(options, order)
      // Resolve
      decision = resolveBackend({ order, specs: pendingSpecs, hardware })
      if (decision.chosen === null) throw new BackendResolutionError(decision)
      // Create inner
      // StatsCollector — the plumbing for cpuMs/drawCalls/memoryEstimate. Before .start()
      // stats are not collected; after — step() drives beginFrame/endFrame.
      statsCollector = createStatsCollector(options.now ?? (() => performance.now()))
      inner = decision.chosen === 'webgpu'
        ? await createWebGpuRenderer({
            canvas: options.canvas,
            clear: options.clear,
            createGPU: options.createGPU,
            onGpuError: options.onGpuError,
            requestFrame: options.requestFrame,
            observeResize: options.observeResize,
            now: options.now,
            journal: options.journal,
            resources: options.resources,
            transport: options.transport,
          })
        : createWebGL2Renderer({
            canvas: options.canvas,
            dpr: options.dpr,
            clear: options.clear,
            uploads: options.uploads,
            createGL: options.createGL,
            onGlError: options.onGlError,
            requestFrame: options.requestFrame,
            observeResize: options.observeResize,
            now: options.now,
            journal: options.journal,
            resources: options.resources,
            stats: statsCollector,
            transport: options.transport,
          })
      // Probe caps on the chosen backend.
      // The WebGL2 renderer probed caps itself (inside createWebGL2Renderer via
      // raw gl, including GpuTimer hookup). WebGPU — here, via
      // gpu.adapter and gpu.preferredFormat (adapter is public in GPUFacade
      // since M4-addendum-2).
      if ('caps' in inner) {
        caps = (inner as WebGL2Renderer).caps
        // WebGL2 hooked the GpuTimer to its own statsCollector itself (inside
        // createWebGL2Renderer). The external statsCollector is not involved —
        // inner uses its own.
      } else if ('gpu' in inner) {
        // WebGPU path: probe caps via gpu.adapter + probeGPUCaps.
        // IMPORTANT: pass device to makeGPUProbe — on some browsers
        // adapter.limits does NOT contain maxAnisotropy, while device.limits does.
        // Without this fallback caps.has('anisotropic')=false on WebGPU,
        // even though realGPU.createTexture applies anisotropic x16.
        const gpu = (inner as WebGpuRenderer).gpu
        const adapter = gpu.adapter
        const device = gpu.device
        const preferredFormat = gpu.preferredFormat
        if (adapter !== null) {
          try {
            const query = probeGPUCaps(makeGPUProbe(adapter, preferredFormat, device))
            caps = createCaps(query, () => statsCollector!.snapshot())
            // GpuTimer: realGPU creates the timer internally at requestDevice
            // (if the adapter supports the 'timestamp-query' feature). The timer
            // is available via the gpu.timer getter (null if the feature is absent).
            // Hook it up to statsCollector — gpuMs will appear in snapshot() in
            // the next frame (after the first writeTimestamp→resolve→map).
            const gpuTimer = gpu.timer
            if (gpuTimer !== null) {
              statsCollector.setGpuTimer(gpuTimer)
            }
          } catch {
            caps = null
          }
        }
      }
      // Bind the statsProvider to caps (so that caps.stats() returns fresh
      // metrics from the statsCollector). probeGLCaps / probeGPUCaps already did
      // the probing — we simply replace statsProvider with our collector.
      if (caps && statsCollector) {
        const backendStr = caps.backend
        const prev = caps
        caps = {
          has: (f) => prev.has(f),
          format: (f, a) => prev.format(f, a),
          path: (n) => prev.path(n),
          ext: (n) => prev.ext(n),
          stats: () => statsCollector!.snapshot(),
          limit: (n) => prev.limit(n),
          get backend() { return backendStr },
          invalidate: () => prev.invalidate(),
        }
      }
      // Attach proxies: compile the specs on the chosen backend, hook up to the proxy
      for (const { proxy, spec } of proxies) {
        const real = adaptAndCompile(spec, decision.chosen, inner)
        proxy._attach(real)
      }
      // Replay frames
      for (const cb of pendingFrames) inner.frame(cb as never)
      pendingFrames.length = 0
      pendingSpecs.length = 0
      proxies.length = 0
      // Begin rAF
      inner.start()
    },

    stop() {
      inner?.stop()
    },

    dispose() {
      if (inner === null) return
      // inner can be WebGL2 or WebGPU — both have dispose()
      const i = inner as WebGL2Renderer & WebGpuRenderer
      i.dispose()
    },

    whyBackend() { return decision },
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

/** GPU builder of a Texture handle: the common path for texture() and
 *  attachTexture() (Task 62: create and attach — the same code; only the
 *  source of textureId differs: freshly created vs restored from the journal). */
function makeGpuTextureHandle(
  gpu: GPUFacade,
  textureId: number,
  w: number,
  h: number,
  mipLevels: number,
): Texture {
  let manuallyDisposed = false
  const subViews: Set<TextureView> = new Set()
  const handle: Texture = {
    textureId,
    width: w,
    height: h,
    mipLevels,
    upload: () => ({ done: Promise.resolve() }) as never,
    uploadImage: (source: GLImageSource | GPUImageSource, options?: { flipY?: boolean }) => {
      const [sw, sh] = externalImageSize(source as GPUImageSource)
      gpu.copyExternalImageToTexture(textureId, source as GPUImageSource, 0, 0, sw, sh, options?.flipY)
    },
    uploadSubImage: (x: number, y: number, source: GLImageSource | GPUImageSource, options?: { flipY?: boolean }) => {
      const [sw, sh] = externalImageSize(source as GPUImageSource)
      gpu.copyExternalImageToTexture(textureId, source as GPUImageSource, x, y, sw, sh, options?.flipY)
    },
    uploadMip: (
      level: number,
      source: GLImageSource | GPUImageSource,
      options?: {
        flipY?: boolean
        /** WebGL2 internalFormat GLenum (default RGBA8). WebGPU-ignored. */
        internalFormat?: number
        /** WebGL2 format GLenum (default RGBA). WebGPU-ignored. */
        format?: number
        /** WebGL2 type GLenum (default UNSIGNED_BYTE). WebGPU-ignored. */
        type?: number
      },
    ) => {
      const [sw, sh] = externalImageSize(source as GPUImageSource)
      gpu.copyExternalImageToTextureMip(textureId, level, source as GPUImageSource, 0, 0, sw, sh, options?.flipY)
    },
    createView: (viewOptions?: { baseMipLevel?: number; mipLevelCount?: number }) => {
      // Task 58: delegate to gpu.createTextureView (a native GPUTextureView).
      // The facade throws an Error on invalid options (textureId not found,
      // mipLevels < 2, baseMipLevel out of range).
      const viewId = gpu.createTextureView(textureId, viewOptions)
      const view: TextureView = makeGpuTextureViewHandle(
        gpu, viewId, textureId,
        viewOptions?.baseMipLevel ?? 0,
        viewOptions?.mipLevelCount,
      )
      subViews.add(view)
      return view
    },
    dispose: () => {
      if (manuallyDisposed) return
      manuallyDisposed = true
      // Cascade dispose: release all sub-views (native GPUTextureViews are
      // released via device.destroy() when the facade is disposed, but we
      // call deleteTextureView explicitly for symmetry with the WebGL2 path).
      for (const view of subViews) view.dispose()
      subViews.clear()
      gpu.deleteTexture(textureId)
    },
  } as Texture
  return handle
}

/** GPU builder of a TextureView handle (createView and attachView — one path;
 *  Task 64: the source of viewId — freshly created or restored from the journal).
 *  dispose() → deleteTextureView(viewId) on the facade. Idempotent. */
function makeGpuTextureViewHandle(
  gpu: GPUFacade,
  viewId: number,
  textureId: number,
  baseMipLevel: number,
  mipLevelCount: number | undefined,
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
      try { gpu.deleteTextureView(viewId) } catch { /* the facade is already dead — no-op */ }
    },
  }
}

function normalizeOrder(backend: BackendId | readonly BackendId[] | undefined): readonly BackendId[] {
  if (backend === undefined) return ['webgpu', 'webgl2']
  if (Array.isArray(backend)) return backend
  return [backend as BackendId]
}

async function probeHardware(options: RendererOptions, order: readonly BackendId[]): Promise<{ webgpu: boolean; webgl2: boolean }> {
  // Injections of createGL/createGPU are treated as "backend available": the test takes responsibility.
  if (options.createGPU !== undefined || options.createGL !== undefined) {
    return {
      webgpu: options.createGPU !== undefined,
      webgl2: options.createGL !== undefined,
    }
  }
  const probeGpu = options.probeGpu ?? defaultProbeGpu
  const probeGl2 = options.probeGl2 ?? defaultProbeGl2
  return {
    webgpu: order.includes('webgpu') ? await probeGpu() : false,
    webgl2: order.includes('webgl2') ? probeGl2() : false,
  }
}

/** WebGPU probe: navigator.gpu + requestAdapter(). */
async function defaultProbeGpu(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) return false
  try {
    const adapter = await navigator.gpu.requestAdapter()
    return adapter !== null
  } catch {
    return false
  }
}

/** WebGL2 probe: the presence of the global WebGL2RenderingContext (without acquiring a canvas). */
function defaultProbeGl2(): boolean {
  return typeof WebGL2RenderingContext !== 'undefined'
}

/** Checks that spec.shader covers the chosen backend; otherwise late-reject. */
function assertCovers(spec: AutoDrawSpec, decision: BackendDecision, _when: string): void {
  if (decision.chosen === null) return // must not happen after start
  const need = decision.chosen === 'webgpu' ? 'wgsl' : 'glsl'
  if (!spec.shader[need]) {
    throw lateRejectError(spec, decision.chosen)
  }
}

/** Actionable late-reject: what to tweak. */
function lateRejectError(spec: AutoDrawSpec, backend: BackendId): Error {
  const hasOther = backend === 'webgl2' ? !!spec.shader.wgsl : !!spec.shader.glsl
  const other = backend === 'webgl2' ? 'WGSL' : 'GLSL'
  const target = backend === 'webgl2' ? 'GLSL' : 'WGSL'
  const id = spec.id ?? '<no id>'
  const altOrder = backend === 'webgl2' ? '["webgpu","webgl2"]' : '["webgl2","webgpu"]'
  if (hasOther) {
    return new Error(
      `Spec "${id}" has only ${other}, while the active backend is ${backend.toUpperCase()} (no ${target}). ` +
      `Restart with backend=${altOrder} OR add ${target} to the spec.`,
    )
  }
  return new Error(
    `Spec "${id}" has neither GLSL nor WGSL. Invalid spec — add at least one shader variant.`,
  )
}

/** Adapts an AutoDrawSpec to the concrete backend and compiles it via inner. */
function adaptAndCompile(spec: AutoDrawSpec, backend: BackendId, inner: WebGL2Renderer | WebGpuRenderer): AnyCommand {
  if (backend === 'webgpu') {
    return (inner as WebGpuRenderer).command({
      shader: { wgsl: spec.shader.wgsl! },
      uniforms: spec.uniforms,
      attributes: spec.attributes,
      textures: spec.textures,
      pipeline: spec.pipeline,
      count: spec.count,
      // Task 75: instances are passed through (star quads: instances=feed.count).
      instances: spec.instances,
    } as never)
  }
  return (inner as WebGL2Renderer).command({
    shader: { glsl: spec.shader.glsl! },
    pipeline: spec.pipeline,
    attributes: spec.attributes,
    uniforms: spec.uniforms,
    textures: spec.textures,
    count: spec.count,
    instances: spec.instances,
  } as never)
}

// ─── proxy CompiledCommand ───────────────────────────────────────────────────

interface ProxyCommand {
  id: number
  record(props: unknown, frameCtx: { time: number; dt: number; aspect: number }, writer: TapeWriter): void
  lastProps: unknown
  _attach(real: AnyCommand): void
}

/** Creates a proxy CompiledCommand: delegates .record to real after _attach(). */
function makeProxyCommand(): ProxyCommand {
  let real: AnyCommand | null = null
  let lastPropsValue: unknown = undefined
  const proxy: ProxyCommand = {
    id: -1,
    record(props, frameCtx, writer) {
      if (real === null) {
        throw new Error('rune: command.record() called before renderer.start(). First await renderer.start().')
      }
      real.record(props, frameCtx, writer)
      lastPropsValue = props
    },
    get lastProps() { return lastPropsValue },
    set lastProps(v: unknown) { lastPropsValue = v },
    _attach(realCmd) {
      real = realCmd
      proxy.id = realCmd.id
    },
  }
  return proxy
}

function removeItem<T>(list: T[], item: T): void {
  const at = list.indexOf(item)
  if (at >= 0) list.splice(at, 1)
}
