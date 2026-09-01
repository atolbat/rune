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
 * Task 80: readback — surface.read() на обоих бэкендах.
 *
 * Контракт (parity!): SurfaceRead { width, height, data } — RGBA8, tight,
 * строки СВЕРХУ ВНИЗ. GL-фасад: readPixels + флип; WebGPU-фасад:
 * copyTextureToBuffer → submit → mapAsync + уплотнение + BGRA→RGBA.
 * Юнит-уровень (recording-фасады) проверяет ВЫЗОВ и форму; реальное
 * чтение пикселей (флип/свиззл/ориентация) — e2e на живом WebGL2/WebGPU
 * (smoke-readback: градиент, верх-красный/низ-синий на обоих бэкендах).
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
  it('читает цель: вызов readTargetPixels(targetId), форма SurfaceRead', async () => {
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
    // recording-фасад отдаёт пустой массив — важна ФОРМА и сам вызов:
    expect(read.data).toBeInstanceOf(Uint8Array)
    expect(recording.calls).toContain('readTargetPixels(1)')
    renderer.stop()
  })

  it('после dispose — honest reject', async () => {
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
    await expect(surface.read()).rejects.toThrow('после dispose')
    renderer.stop()
  })

  it('канвас (targetId 0) не читается — честная ошибка паритета', async () => {
    const gl = createRecordingGL().gl
    expect(() => gl.readTargetPixels(0)).toThrow('канвас не читается')
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

  it('читает цель: вызов readTargetPixels(targetId), форма SurfaceRead', async () => {
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

  it('после dispose — honest reject', async () => {
    const { renderer } = await setupGpu()
    const surface = renderer.surface({ width: 32, height: 32 })
    surface.dispose()
    await expect(surface.read()).rejects.toThrow('после dispose')
    renderer.stop()
  })

  it('канвас (targetId 0) не читается — честная ошибка паритета', async () => {
    const { gpu } = createRecordingGPU()
    await expect(gpu.readTargetPixels(0)).rejects.toThrow('канвас не читается')
  })
})

describe('surface.read() — декораторы фасадов', () => {
  it('withJournal (GL): пробрасывает чтение, НЕ пишет опс в журнал', () => {
    const recording = createRecordingGL()
    const journal = createJournal() as Journal
    const wrapped: GLFacade = withJournal(recording.gl, journal)
    const surfaceTarget = 1

    wrapped.readTargetPixels(surfaceTarget)

    expect(recording.calls).toContain(`readTargetPixels(${surfaceTarget})`)
    // Чтение — не декларация: журнал пуст (никаких record-опсов)
    expect(journal.entries().length).toBe(0)
  })

  it('withJournalGpu (GPU): пробрасывает чтение, НЕ пишет опс в журнал', async () => {
    const recording = createRecordingGPU()
    const journal = createJournal() as Journal
    const wrapped: GPUFacade = withJournalGpu(recording.gpu, journal)
    const surfaceTarget = 1

    await wrapped.readTargetPixels(surfaceTarget)

    expect(recording.calls).toContain(`readTargetPixels(${surfaceTarget})`)
    expect(journal.entries().length).toBe(0)
  })
})
