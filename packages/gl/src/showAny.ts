import type { WebGL2Renderer } from './webgl2Renderer.ts'
import type { ShowOptions } from './scene.ts'
import { show } from './scene.ts'
import type { Show } from './scene.ts'
import { probeWebGpu } from './showOn.ts'
import { showOnWebGpu } from './showWebgpu.ts'

/**
 * show(): a cube in one line on the BEST available backend.
 * WebGPU with automatic fallback to WebGL2 — the same principle as in demo-6.
 */

/** A showing on the chosen backend. */
export interface AnyShow {
  readonly backend: 'webgpu' | 'webgl2'
  readonly webgl2?: Show
  readonly webgpu?: { renderer: unknown; stop(): void }
  stop(): void
}

/** Show a cube: WebGPU, falling back to WebGL2 when unavailable. */
export async function showAny(
  target: string | HTMLCanvasElement,
  options: ShowOptions = {},
): Promise<AnyShow> {
  const canvas = resolveCanvas(target)

  // Probe WebGPU without acquiring the canvas
  if (await probeWebGpu()) {
    try {
      const webgpu = await showOnWebGpu(canvas, options)
      setBackendLabel('WebGPU')
      return { backend: 'webgpu', webgpu, stop: () => webgpu.stop() }
    } catch (error) {
      reportFallbackReason(error)
    }
  }

  // Fallback: the canvas may have been acquired by the webgpu attempt — always fresh
  const fresh = freshCanvas(canvas)
  const webgl2 = show(fresh, options)
  setBackendLabel('WebGL2 (fallback)', options.badge)
  return { backend: 'webgl2', webgl2, stop: () => webgl2.stop() }
}

function resolveCanvas(target: string | HTMLCanvasElement): HTMLCanvasElement {
  if (typeof target !== 'string') return target
  if (typeof document === 'undefined') throw new Error('rune: show without DOM requires an element')
  const canvas = document.querySelector<HTMLCanvasElement>(target)
  if (canvas === null) throw new Error(`rune: canvas "${target}" not found`)
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
  reason.textContent = `WebGPU failed to start: ${String(error instanceof Error ? error.message : error)}\nFalling back to WebGL2.`
}

// Re-export for compatibility: show without a backend specified = showAny
export { show as showWebgl2 }
export type { WebGL2Renderer }
