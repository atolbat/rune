import { describe, expect, it } from 'bun:test'
import { createWebGL2Renderer } from '../src/index.ts'
import { createRecordingGL } from '@rune/webgl2'
import { isOffscreenCanvas, getCanvasCssSize, canvasDpr } from '../src/index.ts'

/**
 * OffscreenCanvas support (DESIGN.md §9.13).
 * External canvases — the renderer accepts HTMLCanvasElement | OffscreenCanvas | string.
 * Size semantics are fundamentally different (see canvasHelpers.ts).
 */

/** Fake OffscreenCanvas: no clientWidth/clientHeight, only width/height. */
function fakeOffscreenCanvas(w: number, h: number): OffscreenCanvas {
  return {
    width: w,
    height: h,
    getContext: () => null,
  } as unknown as OffscreenCanvas
}

describe('OffscreenCanvas — external canvases', () => {
  it('isOffscreenCanvas distinguishes Offscreen from HTML', () => {
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

  it('canvasDpr: HTML — window.devicePixelRatio; Offscreen — always 1', () => {
    const html = { clientWidth: 1, clientHeight: 1 } as HTMLCanvasElement
    const off = fakeOffscreenCanvas(10, 10)
    expect(canvasDpr(off)).toBe(1)
    // the html path depends on window.devicePixelRatio; in tests it is usually 1
    expect(canvasDpr(html)).toBeGreaterThan(0)
  })

  it('createWebGL2Renderer accepts OffscreenCanvas + createGL injection', () => {
    const recording = createRecordingGL()
    const off = fakeOffscreenCanvas(800, 600)
    // the createGL injection bypasses acquireWebGL2 (does not call canvas.getContext)
    const renderer = createWebGL2Renderer({
      canvas: off,
      createGL: () => recording.gl,
      observeResize: false,  // disable the ResizeObserver path (Offscreen does not support it anyway)
      now: () => 0,
      requestFrame: () => () => {},
    })
    // size is initialized from canvas.width/height (not clientWidth — it does not exist)
    const [w, h] = renderer.size.peek()
    expect(w).toBe(800)
    expect(h).toBe(600)
    // aspect = w/h
    expect(renderer.aspect.peek()).toBeCloseTo(800 / 600, 5)
    renderer.stop()
  })

  it('createWebGL2Renderer on OffscreenCanvas does not crash on step', () => {
    const recording = createRecordingGL()
    const off = fakeOffscreenCanvas(64, 64)
    const renderer = createWebGL2Renderer({
      canvas: off,
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    // a simple frame does not throw
    expect(() => renderer.step(16)).not.toThrow()
    renderer.stop()
  })

  it('HTML canvas with clientWidth=0 (DOM not laid out) — fallback to width/height', () => {
    // an HTMLCanvasElement before layout has clientWidth=0; fallback to the width/height attributes
    const earlyHtml = { clientWidth: 0, clientHeight: 0, width: 300, height: 200 } as unknown as HTMLCanvasElement
    const [w, h] = getCanvasCssSize(earlyHtml)
    expect(w).toBe(300)
    expect(h).toBe(200)
  })
})
