import { describe, expect, it } from 'bun:test'
import { createWebGL2Renderer, createWebGpuRenderer } from '../src/index.ts'
import { withJournal, withJournalGpu } from '../src/index.ts'
import { createRecordingGL } from '@rune/webgl2'
import { createRecordingGPU } from '@rune/webgpu'
import { createJournal } from '@rune/core'
import type { GLFacade } from '@rune/webgl2'
import type { GPUFacade } from '@rune/webgpu'
import type { Journal } from '@rune/core'

/**
 * Task 80: readback — surface.read() on both backends.
 *
 * Contract (parity!): SurfaceRead { width, height, data } — RGBA8, tight,
 * rows TOP-DOWN. GL facade: readPixels + flip; WebGPU facade:
 * copyTextureToBuffer → submit → mapAsync + compaction + BGRA→RGBA.
 * The unit level (recording facades) checks the CALL and the shape; real
 * pixel reading (flip/swizzle/orientation) is e2e on live WebGL2/WebGPU
 * (smoke-readback: gradient, top-red/bottom-blue on both backends).
 */

function fakeCanvas(): HTMLCanvasElement {
  return { clientWidth: 800, clientHeight: 600, width: 0, height: 0 } as unknown as HTMLCanvasElement
}

const GLSL_PASS = `#version 300 es
precision mediump float;
in vec2 v_uv;
out vec4 o_color;
void main() { o_color = vec4(v_uv.x, v_uv.y, 0.5, 1.0); }`

const WGSL_PASS = `@fragment
fn fsMain(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  return vec4<f32>(uv.x, uv.y, 0.5, 1.0);
}`

describe('surface.read() — WebGL2', () => {
  it('reads the target: a readTargetPixels(targetId) call, SurfaceRead shape', async () => {
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    const surface = renderer.surface({ width: 128, height: 64 })
    const gen = surface.pass(GLSL_PASS)
    renderer.frame((_ctx, record) => record(gen))
    renderer.step(16)

    const read = await surface.read()
    expect(read.width).toBe(128)
    expect(read.height).toBe(64)
    // the recording facade returns an empty array — the SHAPE and the call itself matter:
    expect(read.data).toBeInstanceOf(Uint8Array)
    expect(recording.calls).toContain('readTargetPixels(1)')
    renderer.stop()
  })

  it('after dispose — honest reject', async () => {
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    const surface = renderer.surface({ width: 32, height: 32 })
    surface.dispose()
    await expect(surface.read()).rejects.toThrow('after dispose')
    renderer.stop()
  })

  it('canvas (targetId 0) cannot be read — an honest parity error', async () => {
    const gl = createRecordingGL().gl
    expect(() => gl.readTargetPixels(0)).toThrow('canvas cannot be read')
  })
})

describe('surface.read() — WebGPU', () => {
  async function setupGpu() {
    const recording = createRecordingGPU()
    const renderer = await createWebGpuRenderer({
      canvas: fakeCanvas(),
      createGPU: async () => recording.gpu,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    return { renderer, calls: recording.calls }
  }

  it('reads the target: a readTargetPixels(targetId) call, SurfaceRead shape', async () => {
    const { renderer, calls } = await setupGpu()
    const surface = renderer.surface({ width: 128, height: 64 })
    const gen = surface.pass(WGSL_PASS)
    renderer.frame((_ctx, record) => record(gen))
    renderer.step(16)

    const read = await surface.read()
    expect(read.width).toBe(128)
    expect(read.height).toBe(64)
    expect(read.data).toBeInstanceOf(Uint8Array)
    expect(calls).toContain('readTargetPixels(1)')
    renderer.stop()
  })

  it('after dispose — honest reject', async () => {
    const { renderer } = await setupGpu()
    const surface = renderer.surface({ width: 32, height: 32 })
    surface.dispose()
    await expect(surface.read()).rejects.toThrow('after dispose')
    renderer.stop()
  })

  it('canvas (targetId 0) cannot be read — an honest parity error', async () => {
    const { gpu } = createRecordingGPU()
    await expect(gpu.readTargetPixels(0)).rejects.toThrow('canvas cannot be read')
  })
})

describe('surface.read() — facade decorators', () => {
  it('withJournal (GL): passes the read through, does NOT write an op to the journal', () => {
    const recording = createRecordingGL()
    const journal = createJournal() as Journal
    const wrapped: GLFacade = withJournal(recording.gl, journal)
    const surfaceTarget = 1

    wrapped.readTargetPixels(surfaceTarget)

    expect(recording.calls).toContain(`readTargetPixels(${surfaceTarget})`)
    // A read is not a declaration: the journal is empty (no record ops)
    expect(journal.entries().length).toBe(0)
  })

  it('withJournalGpu (GPU): passes the read through, does NOT write an op to the journal', async () => {
    const recording = createRecordingGPU()
    const journal = createJournal() as Journal
    const wrapped: GPUFacade = withJournalGpu(recording.gpu, journal)
    const surfaceTarget = 1

    await wrapped.readTargetPixels(surfaceTarget)

    expect(recording.calls).toContain(`readTargetPixels(${surfaceTarget})`)
    expect(journal.entries().length).toBe(0)
  })
})
