import type { Show, ShowOptions } from './scene.ts'
import { show } from './scene.ts'
import type { WebGpuShow } from './showWebgpu.ts'
import { showOnWebGpu } from './showWebgpu.ts'
import type { BackendId } from './autoBackend.ts'

/**
 * showOn(): показать на ВЫБРАННОМ бэкенде — без фолбэка.
 * Для страниц сравнения (табы WebGL2/WebGPU): каждый рендерер на своём
 * канвасе, отказ виден как причина, а не тихое переключение.
 */

export type { BackendId } from './autoBackend.ts'

/** Показ на форсированном бэкенде. */
export interface BackendShow {
  /** Запрошенный бэкенд. */
  readonly backend: BackendId
  /** Что реально работает; null — бэкенд недоступен (см. failureReason). */
  readonly active: BackendId | null
  readonly webgl2?: Show
  readonly webgpu?: WebGpuShow
  /** Причина отказа, когда active === null. */
  readonly failureReason?: string
  pause(): void
  resume(): void
  stop(): void
}

/** Показать куб на выбранном бэкенде: showOn('#canvas', 'webgpu', { texture }). */
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
    return dead('webgpu', new Error('WebGPU недоступен: navigator.gpu отсутствует или адаптер не получен'))
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

/** Проба WebGPU без захвата канваса (общая для showOn/showAny). */
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
  if (typeof document === 'undefined') throw new Error('rune: showOn без DOM требует элемент')
  const canvas = document.querySelector<HTMLCanvasElement>(target)
  if (canvas === null) throw new Error(`rune: канвас "${target}" не найден`)
  return canvas
}

function setLabel(selector: string | undefined, text: string): void {
  if (typeof document === 'undefined') return
  const label = document.querySelector(selector ?? '#backend')
  if (label !== null) label.textContent = text
}
