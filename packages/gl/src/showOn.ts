import type { Show, ShowOptions } from './scene.ts'
import { show } from './scene.ts'
import type { WebGpuShow } from './showWebgpu.ts'
import { showOnWebGpu } from './showWebgpu.ts'
import type { BackendId } from './autoBackend.ts'

/**
 * showOn(): show on the CHOSEN backend — no fallback.
 * For comparison pages (WebGL2/WebGPU tabs): each renderer on its own
 * canvas, failure surfaces as a reason, not a silent switch.
 */

export type { BackendId } from './autoBackend.ts'

/** A showing on a forced backend. */
export interface BackendShow {
  /** The requested backend. */
  readonly backend: BackendId
  /** What is actually running; null — the backend is unavailable (see failureReason). */
  readonly active: BackendId | null
  readonly webgl2?: Show
  readonly webgpu?: WebGpuShow
  /** Failure reason when active === null. */
  readonly failureReason?: string
  pause(): void
  resume(): void
  stop(): void
}

/** Show a cube on the chosen backend: showOn('#canvas', 'webgpu', { texture }). */
export async function showOn(
  target: string | HTMLCanvasElement,
  backend: BackendId,
  options: ShowOptions = {},
): Promise<BackendShow> {
  return backend === 'webgpu'
    ? bootWebGpu(target, options)
    : bootWebGl2(target, options)
}

async function bootWebGl2(target: string | HTMLCanvasElement, options: ShowOptions): Promise<BackendShow> {
  try {
    const webgl2 = show(target, options)
    return alive('webgl2', { webgl2 })
  } catch (error) {
    return dead('webgl2', error)
  }
}

async function bootWebGpu(target: string | HTMLCanvasElement, options: ShowOptions): Promise<BackendShow> {
  const canvas = resolveCanvas(target)
  if (!await probeWebGpu()) {
    return dead('webgpu', new Error('WebGPU unavailable: navigator.gpu is missing or no adapter was obtained'))
  }
  try {
    const webgpu = await showOnWebGpu(canvas, options)
    setLabel(options.badge, 'WebGPU')
    return alive('webgpu', { webgpu })
  } catch (error) {
    return dead('webgpu', error)
  }
}

function alive(backend: BackendId, shows: { webgl2?: Show; webgpu?: WebGpuShow }): BackendShow {
  const inner = shows.webgl2 ?? shows.webgpu
  return {
    backend,
    active: backend,
    ...shows,
    pause: () => inner?.pause(),
    resume: () => inner?.resume(),
    stop: () => inner?.stop(),
  }
}

function dead(backend: BackendId, error: unknown): BackendShow {
  return {
    backend,
    active: null,
    failureReason: error instanceof Error ? error.message : String(error),
    pause: () => {},
    resume: () => {},
    stop: () => {},
  }
}

/** Probe WebGPU without acquiring the canvas (shared by showOn/showAny). */
export async function probeWebGpu(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) return false
  try {
    const adapter = await navigator.gpu.requestAdapter()
    return adapter !== null
  } catch {
    return false
  }
}

function resolveCanvas(target: string | HTMLCanvasElement): HTMLCanvasElement {
  if (typeof target !== 'string') return target
  if (typeof document === 'undefined') throw new Error('rune: showOn without DOM requires an element')
  const canvas = document.querySelector<HTMLCanvasElement>(target)
  if (canvas === null) throw new Error(`rune: canvas "${target}" not found`)
  return canvas
}

function setLabel(selector: string | undefined, text: string): void {
  if (typeof document === 'undefined') return
  const label = document.querySelector(selector ?? '#backend')
  if (label !== null) label.textContent = text
}
