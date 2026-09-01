import type { WebGL2Renderer } from './webgl2Renderer.ts'
import type { ShowOptions } from './scene.ts'
import { show } from './scene.ts'
import type { Show } from './scene.ts'
import { probeWebGpu } from './showOn.ts'
import { showOnWebGpu } from './showWebgpu.ts'

/**
 * show(): куб в одну строку на ЛУЧШЕМ доступном бэкенде.
 * WebGPU с авто-фолбэком на WebGL2 — тот же принцип, что в демо-6.
 */

/** Показ на выбранном бэкенде. */
export interface AnyShow {
  readonly backend: 'webgpu' | 'webgl2'
  readonly webgl2?: Show
  readonly webgpu?: { renderer: unknown; stop(): void }
  stop(): void
}

/** Показать куб: WebGPU, при недоступности — WebGL2 (фолбэк). */
export async function showAny(
  target: string | HTMLCanvasElement,
  options: ShowOptions = {},
): Promise<AnyShow> {
  const canvas = resolveCanvas(target)

  // Проба WebGPU без захвата канваса
  if (await probeWebGpu()) {
    try {
      const webgpu = await showOnWebGpu(canvas, options)
      setBackendLabel('WebGPU')
      return { backend: 'webgpu', webgpu, stop: () => webgpu.stop() }
    } catch (error) {
      reportFallbackReason(error)
    }
  }

  // Фолбэк: канвас мог быть захвачен webgpu-попыткой — всегда свежий
  const fresh = freshCanvas(canvas)
  const webgl2 = show(fresh, options)
  setBackendLabel('WebGL2 (фолбэк)', options.badge)
  return { backend: 'webgl2', webgl2, stop: () => webgl2.stop() }
}

function resolveCanvas(target: string | HTMLCanvasElement): HTMLCanvasElement {
  if (typeof target !== 'string') return target
  if (typeof document === 'undefined') throw new Error('rune: show без DOM требует элемент')
  const canvas = document.querySelector<HTMLCanvasElement>(target)
  if (canvas === null) throw new Error(`rune: канвас "${target}" не найден`)
  return canvas
}

function freshCanvas(old: HTMLCanvasElement): HTMLCanvasElement {
  const replacement = old.cloneNode(false) as HTMLCanvasElement
  old.replaceWith(replacement)
  return replacement
}

function setBackendLabel(text: string, selector = '#backend'): void {
  if (typeof document === 'undefined') return
  const label = document.querySelector(selector)
  if (label !== null) label.textContent = text
}

function reportFallbackReason(error: unknown): void {
  if (typeof document === 'undefined') return
  const reason = document.querySelector('#reason') as HTMLElement | null
  if (reason === null) return
  reason.style.display = 'block'
  reason.textContent = `WebGPU не запустился: ${String(error instanceof Error ? error.message : error)}\nРендерим на WebGL2.`
}

// Реэкспорт для совместимости: show без указания бэкенда = showAny
export { show as showWebgl2 }
export type { WebGL2Renderer }
