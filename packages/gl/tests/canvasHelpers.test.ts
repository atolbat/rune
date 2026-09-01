import { describe, expect, it } from 'bun:test'
import { createWebGL2Renderer } from '../src/index.ts'
import { createRecordingGL } from '@rune/webgl2'
import { isOffscreenCanvas, getCanvasCssSize, canvasDpr } from '../src/index.ts'

/**
 * OffscreenCanvas support (DESIGN.md §9.13).
 * Внешние канвасы — рендерер принимает HTMLCanvasElement | OffscreenCanvas | string.
 * Семантика размеров принципиально разная (см. canvasHelpers.ts).
 */

/** Подделка OffscreenCanvas: нет clientWidth/clientHeight, только width/height. */
function fakeOffscreenCanvas(w: number, h: number): OffscreenCanvas {
  return {
    width: w,
    height: h,
    getContext: () => null,
  } as unknown as OffscreenCanvas
}

describe('OffscreenCanvas — внешние канвасы', () => {
  it('isOffscreenCanvas отличает Offscreen от HTML', () => {
    const html = { clientWidth: 1, clientHeight: 1 } as HTMLCanvasElement
    const off = fakeOffscreenCanvas(10, 10)
    expect(isOffscreenCanvas(html)).toBe(false)
    expect(isOffscreenCanvas(off)).toBe(true)
  })

  it('getCanvasCssSize: HTML — clientWidth/Height; Offscreen — width/height', () => {
    const html = { clientWidth: 800, clientHeight: 600, width: 1600, height: 1200 } as unknown as HTMLCanvasElement
    const off = fakeOffscreenCanvas(1024, 768)
    expect(getCanvasCssSize(html)).toEqual([800, 600])
    expect(getCanvasCssSize(off)).toEqual([1024, 768])
  })

  it('canvasDpr: HTML — window.devicePixelRatio; Offscreen — всегда 1', () => {
    const html = { clientWidth: 1, clientHeight: 1 } as HTMLCanvasElement
    const off = fakeOffscreenCanvas(10, 10)
    expect(canvasDpr(off)).toBe(1)
    // html-путь зависит от window.devicePixelRatio; в тестах обычно 1
    expect(canvasDpr(html)).toBeGreaterThan(0)
  })

  it('createWebGL2Renderer принимает OffscreenCanvas + createGL инъекцию', () => {
    const recording = createRecordingGL()
    const off = fakeOffscreenCanvas(800, 600)
    // createGL инъекция обходит acquireWebGL2 (не зовёт canvas.getContext)
    const renderer = createWebGL2Renderer({
      canvas: off,
      createGL: () => recording.gl,
      observeResize: false,  // выключаем ResizeObserver-путь (Offscreen всё равно его не поддерживает)
      now: () => 0,
      requestFrame: () => () => {},
    })
    // size инициализирован из canvas.width/height (а не clientWidth — его нет)
    const [w, h] = renderer.size.peek()
    expect(w).toBe(800)
    expect(h).toBe(600)
    // aspect = w/h
    expect(renderer.aspect.peek()).toBeCloseTo(800 / 600, 5)
    renderer.stop()
  })

  it('createWebGL2Renderer на OffscreenCanvas не падает на step', () => {
    const recording = createRecordingGL()
    const off = fakeOffscreenCanvas(64, 64)
    const renderer = createWebGL2Renderer({
      canvas: off,
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    // Простой кадр не бросает
    expect(() => renderer.step(16)).not.toThrow()
    renderer.stop()
  })

  it('HTML canvas с clientWidth=0 (DOM не отрисован) — fallback на width/height', () => {
    // Старый HTMLCanvasElement до отрисовки имеет clientWidth=0; fallback на attr width/height
    const earlyHtml = { clientWidth: 0, clientHeight: 0, width: 300, height: 200 } as unknown as HTMLCanvasElement
    const [w, h] = getCanvasCssSize(earlyHtml)
    expect(w).toBe(300)
    expect(h).toBe(200)
  })
})
