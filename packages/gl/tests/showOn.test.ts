import { describe, expect, it } from 'bun:test'
import { showOn } from '../src/index.ts'
import type { ShowOptions } from '../src/index.ts'
import { createRecordingGL } from '@rune/webgl2'
import { createRecordingGPU } from '@rune/webgpu'

/**
 * showOn(): форсированный бэкенд без фолбэка — основа демо с табами.
 * Проверяются оба исхода (живой/отказ) и жизненный цикл паузы.
 */

function fakeCanvas(): HTMLCanvasElement {
  return { clientWidth: 800, clientHeight: 600, width: 800, height: 600 } as unknown as HTMLCanvasElement
}

function inject(recording: ReturnType<typeof createRecordingGL>): ShowOptions {
  return {
    createGL: () => recording.gl,
    observeResize: false,
    requestFrame: () => () => {},
    now: () => 0,
  } as never
}

/** Ручной драйвер rAF: пауза = стрелок снят, кадры физически невозможны. */
function createDriver() {
  let tick: ((timestamp: number) => void) | null = null
  return {
    requestFrame: (callback: (timestamp: number) => void): (() => void) => {
      tick = callback
      return () => { if (tick === callback) tick = null }
    },
    pump(timestamp: number): void { tick?.(timestamp) },
    armed: (): boolean => tick !== null,
  }
}

function draws(calls: string[]): number {
  return calls.filter(call => call.startsWith('drawArrays(')).length
}

describe('showOn() — форсированный бэкенд', () => {
  it('webgl2: живой показ, кадр рисует куб', async () => {
    const recording = createRecordingGL()
    const show = await showOn(fakeCanvas(), 'webgl2', inject(recording))

    expect(show.active).toBe('webgl2')
    expect(show.failureReason).toBeUndefined()
    show.webgl2!.renderer.step(16)
    show.webgl2!.renderer.step(32)
    expect(draws(recording.calls)).toBeGreaterThan(0)
    show.stop()
  })

  it('webgl2: отказ контекста — причина, а не исключение', async () => {
    const show = await showOn(fakeCanvas(), 'webgl2', {
      ...inject(createRecordingGL()),
      createGL: () => {
        throw new Error('WebGL2 недоступен в этом окружении')
      },
    } as never)

    expect(show.active).toBeNull()
    expect(show.failureReason).toContain('WebGL2 недоступен')
  })

  it('webgpu: без navigator.gpu — причина, канвас не тронут', async () => {
    const show = await showOn(fakeCanvas(), 'webgpu', { observeResize: false } as never)

    expect(show.active).toBeNull()
    expect(show.failureReason).toContain('WebGPU недоступен')
  })

  it('webgpu: живой показ на рекордере (стаб navigator.gpu + createGPU)', async () => {
    const original = (globalThis as { navigator?: unknown }).navigator
    ;(globalThis as { navigator?: unknown }).navigator = { gpu: { requestAdapter: async () => ({}) } }
    try {
      const { gpu, calls } = createRecordingGPU()
      const show = await showOn(fakeCanvas(), 'webgpu', {
        createGPU: async () => gpu,
        observeResize: false,
        requestFrame: () => () => {},
        now: () => 0,
      } as never)

      expect(show.active).toBe('webgpu')
      show.webgpu!.renderer.step(16)
      const painted = calls.filter(call => call.startsWith('draw(')).length
      expect(painted).toBeGreaterThan(0)
      expect(calls[calls.length - 1]).toBe('submit')
      show.stop()
    } finally {
      ;(globalThis as { navigator?: unknown }).navigator = original
    }
  })

  it('теория N: текстура 1024² целиком в первом idle-слоте — ОБА бэкенда', async () => {
    const texture = new Uint8Array(1024 * 1024 * 4)
    const tileCalls = (calls: string[]): string[] =>
      calls.filter(call => call.startsWith('texSubImage2D('))

    // WebGL2-путь: show() → renderer.texture().upload → texSubImage2D
    {
      const recording = createRecordingGL()
      const show = await showOn(fakeCanvas(), 'webgl2',
        { ...inject(recording), texture } as never)
      show.webgl2!.renderer.step(16)
      expect(tileCalls(recording.calls).length).toBe(65) // превью + 64 тайла за один кадр
      show.webgl2!.renderer.step(32)
      expect(tileCalls(recording.calls).length).toBe(65) // новых нет
      show.stop()
    }

    // WebGPU-путь: showWebgpu() → streamTexture → gpu.texSubImage2D
    {
      const original = (globalThis as { navigator?: unknown }).navigator
      ;(globalThis as { navigator?: unknown }).navigator = { gpu: { requestAdapter: async () => ({}) } }
      try {
        const { gpu, calls } = createRecordingGPU()
        const show = await showOn(fakeCanvas(), 'webgpu', {
          createGPU: async () => gpu,
          observeResize: false,
          requestFrame: () => () => {},
          now: () => 0,
          texture,
        } as never)
        expect(show.active).toBe('webgpu')
        show.webgpu!.renderer.step(16)
        expect(tileCalls(calls).length).toBe(65)
        show.webgpu!.renderer.step(32)
        expect(tileCalls(calls).length).toBe(65)
        show.stop()
      } finally {
        ;(globalThis as { navigator?: unknown }).navigator = original
      }
    }
  })

  it('пауза замирает, резюм продолжает: основа табов', async () => {
    const recording = createRecordingGL()
    const driver = createDriver()
    const show = await showOn(fakeCanvas(), 'webgl2', { ...inject(recording), requestFrame: driver.requestFrame } as never)

    expect(driver.armed()).toBe(true) // show() стартует цикл сам
    driver.pump(16)
    driver.pump(32)
    const before = draws(recording.calls)
    expect(before).toBe(2)

    show.pause()
    expect(driver.armed()).toBe(false) // стрелок rAF снят
    driver.pump(48)
    driver.pump(64)
    expect(draws(recording.calls)).toBe(before) // пауза: кадры физически невозможны

    show.resume()
    expect(driver.armed()).toBe(true)
    driver.pump(80)
    expect(draws(recording.calls)).toBe(before + 1) // резюм: цикл вернулся
    show.stop()
  })

  it('сосуществование: два рендерера в одном процессе, пауза одного не трогает второй', async () => {
    const first = createRecordingGL()
    const second = createRecordingGL()
    const leftDriver = createDriver()
    const rightDriver = createDriver()
    const left = await showOn(fakeCanvas(), 'webgl2', { ...inject(first), requestFrame: leftDriver.requestFrame } as never)
    const right = await showOn(fakeCanvas(), 'webgl2', { ...inject(second), requestFrame: rightDriver.requestFrame } as never)

    leftDriver.pump(16)
    rightDriver.pump(16)
    expect(draws(first.calls)).toBe(1)
    expect(draws(second.calls)).toBe(1)

    left.pause()
    expect(leftDriver.armed()).toBe(false)
    expect(rightDriver.armed()).toBe(true)
    rightDriver.pump(32)
    leftDriver.pump(32) // вхолостую: стрелка нет
    expect(draws(first.calls)).toBe(1) // на паузе
    expect(draws(second.calls)).toBe(2) // второй живёт своей жизнью
    left.stop()
    right.stop()
  })
})
