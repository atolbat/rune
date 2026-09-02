import { describe, expect, it } from 'bun:test'
import { showOn } from '../src/index.ts'
import type { ShowOptions } from '../src/index.ts'
import { createRecordingGL } from '@rune/webgl2'
import { createRecordingGPU } from '@rune/webgpu'

/**
 * showOn(): a forced backend without fallback — the basis of the tabbed demo.
 * Both outcomes (alive/failure) and the pause lifecycle are checked.
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

/** Manual rAF driver: pause = the rAF callback disarmed, frames are physically impossible. */
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

describe('showOn() — forced backend', () => {
  it('webgl2: live showing, the frame draws a cube', async () => {
    const recording = createRecordingGL()
    const show = await showOn(fakeCanvas(), 'webgl2', inject(recording))

    expect(show.active).toBe('webgl2')
    expect(show.failureReason).toBeUndefined()
    show.webgl2!.renderer.step(16)
    show.webgl2!.renderer.step(32)
    expect(draws(recording.calls)).toBeGreaterThan(0)
    show.stop()
  })

  it('webgl2: context failure — a reason, not an exception', async () => {
    const show = await showOn(fakeCanvas(), 'webgl2', {
      ...inject(createRecordingGL()),
      createGL: () => {
        throw new Error('WebGL2 unavailable in this environment')
      },
    } as never)

    expect(show.active).toBeNull()
    expect(show.failureReason).toContain('WebGL2 unavailable')
  })

  it('webgpu: without navigator.gpu — a reason, the canvas untouched', async () => {
    const show = await showOn(fakeCanvas(), 'webgpu', { observeResize: false } as never)

    expect(show.active).toBeNull()
    expect(show.failureReason).toContain('WebGPU unavailable')
  })

  it('webgpu: live showing on the recorder (a navigator.gpu stub + createGPU)', async () => {
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

  it('webgpu: the cube without a texture carries Lambert lighting (the "flat cube" regression)', async () => {
    // Incident: WGSL_FLAT returned a bare u_albedo — the WebGPU cube had no
    // face shading, unlike the GLSL version. The wrapper over the recorder
    // intercepts WGSL at ensurePipeline and checks the shader for lighting.
    const original = (globalThis as { navigator?: unknown }).navigator
    ;(globalThis as { navigator?: unknown }).navigator = { gpu: { requestAdapter: async () => ({}) } }
    try {
      const { gpu, calls } = createRecordingGPU()
      const shaders: string[] = []
      const capturing = {
        ...gpu,
        ensurePipeline: (pipelineId: number, wgsl: string, attrs: never[], hasTextures: boolean, desc: never) => {
          shaders.push(wgsl)
          return gpu.ensurePipeline(pipelineId, wgsl, attrs, hasTextures, desc)
        },
      } as typeof gpu
      const show = await showOn(fakeCanvas(), 'webgpu', {
        createGPU: async () => capturing,
        observeResize: false,
        requestFrame: () => () => {},
        now: () => 0,
      } as never)

      expect(show.active).toBe('webgpu')
      show.webgpu!.renderer.step(16)
      expect(calls.filter(call => call.startsWith('draw(')).length).toBeGreaterThan(0)
      const flat = shaders.join('\n')
      // Lighting must be present in the shader without a texture
      expect(flat).toContain('lambert')
      expect(flat).toContain('worldNormal')
      expect(flat).toContain('u_lightDir')
      // Regression: bare albedo without Lambert
      expect(flat).not.toMatch(/return\s+vec4<f32>\(\s*params\.u_albedo\.rgb\s*,\s*1\.0\s*\)/)
      show.stop()
    } finally {
      ;(globalThis as { navigator?: unknown }).navigator = original
    }
  })

  it('theory N: a 1024² texture entirely in the first idle slot — BOTH backends', async () => {
    const texture = new Uint8Array(1024 * 1024 * 4)
    const tileCalls = (calls: string[]): string[] =>
      calls.filter(call => call.startsWith('texSubImage2D('))

    // WebGL2 path: show() → renderer.texture().upload → texSubImage2D
    {
      const recording = createRecordingGL()
      const show = await showOn(fakeCanvas(), 'webgl2',
        { ...inject(recording), texture } as never)
      show.webgl2!.renderer.step(16)
      expect(tileCalls(recording.calls).length).toBe(65) // preview + 64 tiles in one frame
      show.webgl2!.renderer.step(32)
      expect(tileCalls(recording.calls).length).toBe(65) // no new ones
      show.stop()
    }

    // WebGPU path: showWebgpu() → streamTexture → gpu.texSubImage2D
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

  it('pause freezes, resume continues: the basis of tabs', async () => {
    const recording = createRecordingGL()
    const driver = createDriver()
    const show = await showOn(fakeCanvas(), 'webgl2', { ...inject(recording), requestFrame: driver.requestFrame } as never)

    expect(driver.armed()).toBe(true) // show() starts the loop itself
    driver.pump(16)
    driver.pump(32)
    const before = draws(recording.calls)
    expect(before).toBe(2)

    show.pause()
    expect(driver.armed()).toBe(false) // the rAF callback disarmed
    driver.pump(48)
    driver.pump(64)
    expect(draws(recording.calls)).toBe(before) // paused: frames are physically impossible

    show.resume()
    expect(driver.armed()).toBe(true)
    driver.pump(80)
    expect(draws(recording.calls)).toBe(before + 1) // resume: the loop is back
    show.stop()
  })

  it('coexistence: two renderers in one process, pausing one does not touch the other', async () => {
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
    leftDriver.pump(32) // to no effect: no armed callback
    expect(draws(first.calls)).toBe(1) // paused
    expect(draws(second.calls)).toBe(2) // the second lives its own life
    left.stop()
    right.stop()
  })
})
