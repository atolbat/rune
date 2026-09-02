/**
 * createAutoRenderer — an async wrapper over createRenderer / createWebGpuRenderer.
 *
 * 1. Probes hardware (probeWebGpu + canvas.getContext('webgl2'))
 * 2. Calls resolveBackend({order, specs, hardware}) — a pure function
 * 3. If chosen === null — throws an Error with decision.message
 * 4. Otherwise creates an inner renderer of the chosen backend
 *
 * Late-reject: r.command(spec) with an unsuitable shader throws an actionable error
 * with instructions on what to adjust.
 */

import type { AutoDrawSpec, BackendDecision, BackendId } from './autoBackend.ts'
import { resolveBackend } from './autoBackend.ts'
import { createRenderer } from './renderer.ts'
import type { FrameContext, FrameHandle, Renderer, RendererOptions, Texture } from './renderer.ts'
import { createWebGpuRenderer } from './webgpuRenderer.ts'
import type { GpuFrameContext, WebGpuRenderer, WebGpuRendererOptions } from './webgpuRenderer.ts'
import type { CompiledCommand } from '@rune/webgl2'
import type { WgpuCommand } from '@rune/webgpu'
import type { UploadScheduler, TransientPool, ReadableSignal } from '@rune/core'
import type { Surface, SurfaceOptions, PassOptions } from './surface.ts'

/** Union command — both have record(), structurally compatible by shape. */
export type AnyCommand = CompiledCommand | WgpuCommand
export type AnyFrameCallback =
  | ((ctx: FrameContext, record: AnyRecorder) => void)
  | ((ctx: GpuFrameContext, record: AnyRecorder) => void)
export type AnyRecorder = (command: AnyCommand, props?: unknown) => void

export interface AutoRendererOptions {
  readonly canvas: HTMLCanvasElement | string
  /** Try order. Default ['webgpu', 'webgl2']. Length 1 = strict. */
  readonly order?: readonly BackendId[]
  /** Pre-flight specs for coverage checking. */
  readonly specs?: readonly AutoDrawSpec[]
  /** Injections for headless tests: GL facade (recorder or real). */
  readonly createGL?: RendererOptions['createGL']
  /** Injections for headless tests: GPU facade. */
  readonly createGPU?: WebGpuRendererOptions['createGPU']
  readonly requestFrame?: (callback: (timestamp: number) => void) => () => void
  readonly observeResize?: boolean
  readonly now?: () => number
  readonly dpr?: number
  /** WebGPU probe injection — for tests. */
  readonly probeGpu?: () => Promise<boolean>
  /** WebGL2 probe injection — for tests. Default: typeof WebGL2RenderingContext. */
  readonly probeGl2?: () => boolean
}

export interface AutoRenderer {
  /** The chosen backend. */
  readonly backend: BackendId
  /** Structured reason for the choice. */
  readonly decision: BackendDecision
  /** Inner renderer — for direct access (gpu/gl facade). */
  readonly inner: Renderer | WebGpuRenderer
  // Unified API
  readonly size: ReadableSignal<readonly [number, number]>
  readonly aspect: ReadableSignal<number>
  readonly time: ReadableSignal<number>
  readonly uploads: UploadScheduler
  readonly transients: TransientPool
  /** Texture: created on the active backend. */
  texture(width: number, height: number): Texture
  /** Command with late-reject: spec.shader must have a variant for the active backend. */
  command(spec: AutoDrawSpec): AnyCommand
  pass(fragment: string, options?: PassOptions): AnyCommand
  surface(options?: SurfaceOptions): Surface<AnyCommand>
  frame(callback: AnyFrameCallback): FrameHandle
  resize(cssWidth: number, cssHeight: number): void
  step(nowMs: number): void
  start(): void
  stop(): void
}

/** Main entry point: automatic backend selection with pre-flight. */
export async function createAutoRenderer(options: AutoRendererOptions): Promise<AutoRenderer> {
  const order = options.order ?? ['webgpu', 'webgl2']

  // Hardware probes (outside resolveBackend — it is a pure function)
  // createGL/createGPU injections are treated as "backend available": a test
  // passing a facade explicitly takes responsibility for availability.
  const probeGpu = options.probeGpu ?? (() => probeWebGpu())
  const probeGl2 = options.probeGl2 ?? defaultProbeGl2
  const hardware = {
    webgpu: options.createGPU !== undefined ? true : await probeGpu(),
    webgl2: options.createGL !== undefined ? true : probeGl2(),
  }

  // Pure selection
  const decision = resolveBackend({ order, specs: options.specs, hardware })
  if (decision.chosen === null) {
    throw new BackendResolutionError(decision)
  }

  // Create an inner renderer for the chosen backend
  if (decision.chosen === 'webgpu') {
    const inner = await createWebGpuRenderer({
      canvas: options.canvas,
      createGPU: options.createGPU,
      requestFrame: options.requestFrame,
      observeResize: options.observeResize,
      now: options.now,
    })
    return wrapGpu(inner, decision)
  }
  const inner = createRenderer({
    canvas: options.canvas,
    dpr: options.dpr,
    createGL: options.createGL,
    requestFrame: options.requestFrame,
    observeResize: options.observeResize,
    now: options.now,
  })
  return wrapGl(inner, decision)
}

/** An error with a structured decision — the catching code can show verdicts. */
export class BackendResolutionError extends Error {
  readonly decision: BackendDecision
  constructor(decision: BackendDecision) {
    super(decision.message)
    this.name = 'BackendResolutionError'
    this.decision = decision
  }
}

// ─── wrappers ─────────────────────────────────────────────────────────────

function wrapGl(inner: Renderer, decision: BackendDecision): AutoRenderer {
  return {
    backend: 'webgl2',
    decision,
    inner,
    get size() { return inner.size },
    get aspect() { return inner.aspect },
    get time() { return inner.time },
    get uploads() { return inner.uploads },
    get transients() { return inner.transients },
    texture: (w, h) => inner.texture(w, h),
    command: spec => commandGl(spec, inner),
    pass: (frag, opts) => inner.pass(frag, opts),
    surface: opts => inner.surface(opts) as Surface<AnyCommand>,
    frame: cb => inner.frame(cb as never),
    resize: (w, h) => inner.resize(w, h),
    step: now => inner.step(now),
    start: () => inner.start(),
    stop: () => inner.stop(),
  }
}

function wrapGpu(inner: WebGpuRenderer, decision: BackendDecision): AutoRenderer {
  return {
    backend: 'webgpu',
    decision,
    inner,
    get size() { return inner.size },
    get aspect() { return inner.aspect },
    get time() { return inner.time },
    get uploads() { return inner.uploads },
    get transients() { return inner.transients },
    // The WebGPU renderer has no texture() — textures via gpu.createTexture
    // (as in showWebgpu.ts). For unification — we delegate to the facade.
    texture: (w, h) => ({
      textureId: inner.gpu.createTexture(w, h),
      width: w,
      height: h,
      upload: () => ({ done: Promise.resolve() }) as never,
    }) as never,
    command: spec => commandGpu(spec, inner),
    pass: (frag, opts) => inner.pass(frag, opts),
    surface: opts => inner.surface(opts) as Surface<AnyCommand>,
    frame: cb => inner.frame(cb as never),
    resize: (w, h) => inner.resize(w, h),
    step: now => inner.step(now),
    start: () => inner.start(),
    stop: () => inner.stop(),
  }
}

// ─── late-reject ─────────────────────────────────────────────────────────────

function commandGl(spec: AutoDrawSpec, inner: Renderer): AnyCommand {
  if (!spec.shader.glsl) {
    throw lateRejectError(spec, 'webgl2', inner)
  }
  // The GL compiler accepts a DrawSpec with shader.glsl; the wgsl part is ignored
  return inner.command({
    shader: { glsl: spec.shader.glsl },
    pipeline: spec.pipeline,
    attributes: spec.attributes,
    uniforms: spec.uniforms,
    textures: spec.textures,
    count: spec.count,
  } as never)
}

function commandGpu(spec: AutoDrawSpec, inner: WebGpuRenderer): AnyCommand {
  if (!spec.shader.wgsl) {
    throw lateRejectError(spec, 'webgpu', inner)
  }
  return inner.command({
    shader: { wgsl: spec.shader.wgsl },
    uniforms: spec.uniforms,
    attributes: spec.attributes,
    textures: spec.textures,
    count: spec.count,
  } as never)
}

function lateRejectError(spec: AutoDrawSpec, backend: BackendId, _inner: Renderer | WebGpuRenderer): Error {
  const hasOther = backend === 'webgl2' ? !!spec.shader.wgsl : !!spec.shader.glsl
  const other = backend === 'webgl2' ? 'WGSL' : 'GLSL'
  const target = backend === 'webgl2' ? 'GLSL' : 'WGSL'
  const id = spec.id ?? '<no id>'
  if (hasOther) {
    return new Error(
      `Spec "${id}" has only ${other}, but the active backend is ${backend.toUpperCase()} (no ${target}). ` +
      `Restart with order=${JSON.stringify(backend === 'webgl2' ? ['webgpu', 'webgl2'] : ['webgl2', 'webgpu'])} OR add ${target} to the spec.`
    )
  }
  return new Error(
    `Spec "${id}" has neither GLSL nor WGSL. Invalid spec — add at least one shader variant.`
  )
}

// ─── hardware probes ─────────────────────────────────────────────────────────

/** WebGPU probe: navigator.gpu + requestAdapter(). */
async function probeWebGpu(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) return false
  try {
    const adapter = await navigator.gpu.requestAdapter()
    return adapter !== null
  } catch {
    return false
  }
}

/** Default WebGL2 probe: presence of the global WebGL2RenderingContext.
 *  Does not create a context — a safe check, does not touch the canvas. */
function defaultProbeGl2(): boolean {
  return typeof WebGL2RenderingContext !== 'undefined'
}
