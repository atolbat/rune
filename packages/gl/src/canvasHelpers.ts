/**
 * Canvas detection helpers — поддерживает HTMLCanvasElement и OffscreenCanvas.
 *
 * Семантика размеров принципиально разная:
 *  - HTMLCanvasElement: clientWidth/clientHeight (CSS), width/height (buffer).
 *    Renderer множит CSS на DPR → buffer.
 *  - OffscreenCanvas: width/height — это И CSS, И buffer одновременно
 *    (нет DOM, нет CSS-размеров). DPR = 1 всегда, ResizeObserver не работает.
 */

/** Любой канвас, принимаемый рендерерами. */
export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas

/** Type guard для OffscreenCanvas. Использует duck-typing как fallback:
 *  в окружениях без глобального OffscreenCanvas (Node, headless-тесты)
 *  HTMLCanvasElement отличается наличием clientWidth/clientHeight (геттеры на
 *  HTMLElement.prototype), OffscreenCanvas — только width/height. */
export function isOffscreenCanvas(canvas: AnyCanvas): canvas is OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) return true
  // Fallback: HTMLCanvasElement имеет clientWidth (через HTMLElement.prototype),
  // OffscreenCanvas (и любой mock с width/height) — нет.
  return !('clientWidth' in canvas)
}

/** CSS-размер канваса: для HTML — clientWidth/Height (fallback на width/height
 *  если CSS ещё не посчитан); для Offscreen — width/height напрямую (DPR=1). */
export function getCanvasCssSize(canvas: AnyCanvas): readonly [number, number] {
  if (isOffscreenCanvas(canvas)) {
    return [canvas.width, canvas.height]
  }
  // HTMLCanvasElement: clientWidth=0 если DOM ещё не отрисован — fallback на attr
  const css = canvas.clientWidth
  const cssH = canvas.clientHeight
  if (css > 0 && cssH > 0) return [css, cssH]
  return [canvas.width || 1, canvas.height || 1]
}

/** DPR: для HTML — window.devicePixelRatio (default 1); для Offscreen — всегда 1
 *  (нет CSS-размеров, bitmap = buffer). */
export function canvasDpr(canvas: AnyCanvas, override?: number): number {
  if (override !== undefined) return override
  if (isOffscreenCanvas(canvas)) return 1
  return typeof window !== 'undefined' ? window.devicePixelRatio ?? 1 : 1
}

/** Резолв селектора/элемента/Offscreen в конкретный canvas-объект. */
export function resolveCanvasAny(target: AnyCanvas | string): AnyCanvas {
  if (typeof target !== 'string') return target
  if (typeof document === 'undefined') {
    throw new Error('rune: селектор канваса требует DOM — передайте элемент или OffscreenCanvas напрямую')
  }
  const canvas = document.querySelector<HTMLCanvasElement>(target)
  if (canvas === null) {
    throw new Error(
      `rune: канвас "${target}" не найден — инициализация раньше DOM? ` +
      'Оберните createRenderer в DOMContentLoaded или передайте элемент/OffscreenCanvas.',
    )
  }
  return canvas
}
