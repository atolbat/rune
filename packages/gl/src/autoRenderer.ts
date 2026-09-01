/**
 * createAutoRenderer — async-обёртка над createRenderer / createWebGpuRenderer.
 *
 * 1. Пробирует hardware (probeWebGpu + canvas.getContext('webgl2'))
 * 2. Вызывает resolveBackend({order, specs, hardware}) — чистую функцию
 * 3. Если chosen === null — кидает Error с decision.message
 * 4. Иначе создаёт inner-рендерер нужного бэкенда
 *
 * Late-reject: r.command(spec) с неподходящим шейдером кидает actionable-ошибку
 * с инструкцией: что подкрутить.
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

/** Union-команда — у обеих есть record(), структура совместима по форме. */
export type AnyCommand = CompiledCommand | WgpuCommand
export type AnyFrameCallback =
  | ((ctx: FrameContext, record: AnyRecorder) => void)
  | ((ctx: GpuFrameContext, record: AnyRecorder) => void)
export type AnyRecorder = (command: AnyCommand, props?: unknown) => void

export interface AutoRendererOptions {
  readonly canvas: HTMLCanvasElement | string
  /** Порядок попыток. Default ['webgpu', 'webgl2']. Длина 1 = strict. */
  readonly order?: readonly BackendId[]
  /** Pre-flight спеки для проверки покрытия. */
  readonly specs?: readonly AutoDrawSpec[]
  /** Инъекции для headless-тестов: GL-фасад (рекордер или real). */
  readonly createGL?: RendererOptions['createGL']
  /** Инъекции для headless-тестов: GPU-фасад. */
  readonly createGPU?: WebGpuRendererOptions['createGPU']
  readonly requestFrame?: (callback: (timestamp: number) => void) => () => void
  readonly observeResize?: boolean
  readonly now?: () => number
  readonly dpr?: number
  /** Инъекция пробы WebGPU — для тестов. */
  readonly probeGpu?: () => Promise<boolean>
  /** Инъекция пробы WebGL2 — для тестов. Default: typeof WebGL2RenderingContext. */
  readonly probeGl2?: () => boolean
}

export interface AutoRenderer {
  /** Выбранный бэкенд. */
  readonly backend: BackendId
  /** Структурированная причина выбора. */
  readonly decision: BackendDecision
  /** Внутренний рендерер — для прямого доступа (gpu/gl фасад). */
  readonly inner: Renderer | WebGpuRenderer
  // Унифицированный API
  readonly size: ReadableSignal<readonly [number, number]>
  readonly aspect: ReadableSignal<number>
  readonly time: ReadableSignal<number>
  readonly uploads: UploadScheduler
  readonly transients: TransientPool
  /** Текстура: создаётся на активном бэкенде. */
  texture(width: number, height: number): Texture
  /** Команда с late-reject: spec.shader должен иметь вариант для активного бэкенда. */
  command(spec: AutoDrawSpec): AnyCommand
  pass(fragment: string, options?: PassOptions): AnyCommand
  surface(options?: SurfaceOptions): Surface<AnyCommand>
  frame(callback: AnyFrameCallback): FrameHandle
  resize(cssWidth: number, cssHeight: number): void
  step(nowMs: number): void
  start(): void
  stop(): void
}

/** Главная точка входа: авто-выбор бэкенда с pre-flight. */
export async function createAutoRenderer(options: AutoRendererOptions): Promise<AutoRenderer> {
  const order = options.order ?? ['webgpu', 'webgl2']

  // Пробы hardware (вне resolveBackend — там чистая функция)
  // Инъекции createGL/createGPU трактуются как «бэкенд доступен»: тест,
  // передающий фасад, явно берёт ответственность за доступность на себя.
  const probeGpu = options.probeGpu ?? (() => probeWebGpu())
  const probeGl2 = options.probeGl2 ?? defaultProbeGl2
  const hardware = {
    webgpu: options.createGPU !== undefined ? true : await probeGpu(),
    webgl2: options.createGL !== undefined ? true : probeGl2(),
  }

  // Чистый выбор
  const decision = resolveBackend({ order, specs: options.specs, hardware })
  if (decision.chosen === null) {
    throw new BackendResolutionError(decision)
  }

  // Создаём inner-рендерер выбранного бэкенда
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

/** Ошибка с структурированным decision — ловящий код может показать вердикты. */
export class BackendResolutionError extends Error {
  readonly decision: BackendDecision
  constructor(decision: BackendDecision) {
    super(decision.message)
    this.name = 'BackendResolutionError'
    this.decision = decision
  }
}

// ─── обёртки ────────────────────────────────────────────────────────────────

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
    // WebGPU-рендерер не имеет texture() — текстуры через gpu.createTexture
    // (как в showWebgpu.ts). Для унификации — делегируем в фасад.
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
  // GL-компилятор принимает DrawSpec с shader.glsl; wgsl-часть игнорируем
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
  const id = spec.id ?? '<без id>'
  if (hasOther) {
    return new Error(
      `Spec "${id}" имеет только ${other}, а активный бэкенд — ${backend.toUpperCase()} (нет ${target}). ` +
      `Перезапустите с order=${JSON.stringify(backend === 'webgl2' ? ['webgpu', 'webgl2'] : ['webgl2', 'webgpu'])} ИЛИ добавьте ${target} к спеку.`
    )
  }
  return new Error(
    `Spec "${id}" не имеет ни GLSL, ни WGSL. Невалидный спек — добавьте хотя бы один вариант шейдера.`
  )
}

// ─── hardware probes ─────────────────────────────────────────────────────────

/** WebGPU-проба: navigator.gpu + requestAdapter(). */
async function probeWebGpu(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) return false
  try {
    const adapter = await navigator.gpu.requestAdapter()
    return adapter !== null
  } catch {
    return false
  }
}

/** WebGL2-проба по умолчанию: наличие глобального WebGL2RenderingContext.
 *  Не создаёт контекст — это безопасная проверка, не трогает canvas. */
function defaultProbeGl2(): boolean {
  return typeof WebGL2RenderingContext !== 'undefined'
}
