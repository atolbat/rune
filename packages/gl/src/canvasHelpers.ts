/**
 * Canvas detection helpers — supports HTMLCanvasElement and OffscreenCanvas.
 *
 * Size semantics are fundamentally different:
 *  - HTMLCanvasElement: clientWidth/clientHeight (CSS), width/height (buffer).
 *    The renderer multiplies CSS by DPR → buffer.
 *  - OffscreenCanvas: width/height is BOTH the CSS size AND the buffer size
 *    at once (no DOM, no CSS sizes). DPR = 1 always, ResizeObserver does not work.
 */

/** Any canvas accepted by renderers. */
export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas

/** Type guard for OffscreenCanvas. Uses duck-typing as a fallback:
 *  in environments without a global OffscreenCanvas (Node, headless tests),
 *  HTMLCanvasElement is distinguished by having clientWidth/clientHeight (getters
 *  on HTMLElement.prototype), OffscreenCanvas — only width/height. */
export function isOffscreenCanvas(canvas: AnyCanvas): canvas is OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) return true
  // Fallback: HTMLCanvasElement has clientWidth (via HTMLElement.prototype),
  // OffscreenCanvas (and any mock with width/height) does not.
  return !('clientWidth' in canvas)
}

/** CSS size of the canvas: for HTML — clientWidth/Height (fallback to width/height
 *  if CSS has not been computed yet); for Offscreen — width/height directly (DPR=1). */
export function getCanvasCssSize(canvas: AnyCanvas): readonly [number, number] {
  if (isOffscreenCanvas(canvas)) {
    return [canvas.width, canvas.height]
  }
  // HTMLCanvasElement: clientWidth=0 if the DOM has not been rendered yet — fallback to attrs
  const css = canvas.clientWidth
  const cssH = canvas.clientHeight
  if (css > 0 && cssH > 0) return [css, cssH]
  return [canvas.width || 1, canvas.height || 1]
}

/** DPR: for HTML — window.devicePixelRatio (default 1); for Offscreen — always 1
 *  (no CSS sizes, bitmap = buffer). */
export function canvasDpr(canvas: AnyCanvas, override?: number): number {
  if (override !== undefined) return override
  if (isOffscreenCanvas(canvas)) return 1
  return typeof window !== 'undefined' ? window.devicePixelRatio ?? 1 : 1
}

/** Resolve a selector/element/Offscreen into a concrete canvas object. */
export function resolveCanvasAny(target: AnyCanvas | string): AnyCanvas {
  if (typeof target !== 'string') return target
  if (typeof document === 'undefined') {
    throw new Error('rune: canvas selector requires DOM — pass an element or OffscreenCanvas directly')
  }
  const canvas = document.querySelector<HTMLCanvasElement>(target)
  if (canvas === null) {
    throw new Error(
      `rune: canvas "${target}" not found — initialization before DOM? ` +
      'Wrap createRenderer in DOMContentLoaded or pass an element/OffscreenCanvas.',
    )
  }
  return canvas
}
