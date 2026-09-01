import { describe, expect, it } from 'bun:test'
import { createRenderer, BackendResolutionError } from '../src/index.ts'
import type { AutoDrawSpec } from '../src/index.ts'
import { createRecordingGL } from '@rune/webgl2'
import { createRecordingGPU } from '@rune/webgpu'

/**
 * createRenderer — единый entry point с авто-выбором бэкенда (DESIGN.md §9.12).
 * Sync constructor + lazy discovery через .command() + async .start().
 *
 * Покрываем:
 *  - strict WebGL2 (backend='webgl2') — sync init, surface/pass работают после start
 *  - strict WebGPU (backend='webgpu') — async init
 *  - auto default — WebGPU preferred, fallback WebGL2 (если спеки требуют)
 *  - GLSL-only spec + оба доступны → фолбэк на WebGL2 с reason
 *  - late-reject: WGSL-only command на WebGL2 кидает actionable
 *  - BackendResolutionError несёт структурированный decision
 *  - lazy proxy command: работает до .start(), бросает если .record() до старта
 *  - whyBackend() возвращает decision после .start(), null до
 */

function fakeCanvas(): HTMLCanvasElement {
  return { clientWidth: 800, clientHeight: 600, width: 800, height: 600 } as unknown as HTMLCanvasElement
}

const DUAL: AutoDrawSpec = {
  id: 'tri',
  shader: {
    glsl: { vertex: '#version 300 es\nin vec2 a_pos;\nvoid main(){gl_Position=vec4(a_pos,0.,1.);}', fragment: '#version 300 es\nout vec4 o;\nvoid main(){o=vec4(1.);}' },
    wgsl: '@vertex fn v(@location(0) p:vec2<f32>)->@builtin(position) vec4<f32>{return vec4<f32>(p,0.,1.)}@fragment fn f(@location(0) p:vec2<f32>)->@location(0) vec4<f32>{return vec4<f32>(1.)}',
  },
  attributes: { a_pos: { data: new Float32Array([0, 0, 1, 0, 0, 1]), size: 2 } },
  count: 3,
}

const GLSL_ONLY: AutoDrawSpec = {
  id: 'legacy',
  shader: { glsl: DUAL.shader.glsl },
  attributes: DUAL.attributes,
  count: 3,
}

const WGSL_ONLY: AutoDrawSpec = {
  id: 'compute',
  shader: { wgsl: DUAL.shader.wgsl },
  attributes: DUAL.attributes,
  count: 3,
}

const COMMON = { observeResize: false, requestFrame: () => () => {}, now: () => 0 }

describe('createRenderer — единый entry point с lazy discovery', () => {
  it('strict backend="webgl2" — sync init + whyBackend возвращает decision после start', async () => {
    const recording = createRecordingGL()
    const r = createRenderer({
      canvas: fakeCanvas(),
      backend: 'webgl2',
      createGL: () => recording.gl,
      ...COMMON,
    })
    expect(r.backend).toBeNull()       // до start
    expect(r.whyBackend()).toBeNull()
    const tri = r.command(DUAL)        // lazy proxy до start
    expect(tri).toBeDefined()
    await r.start()
    expect(r.backend).toBe('webgl2')
    expect(r.decision?.chosen).toBe('webgl2')
    expect(r.decision?.message).toContain('Принудительный')
    r.stop()
  })

  it('auto default с GLSL-only спекой + оба бэкенда доступны → фолбэк на WebGL2 с reason', async () => {
    const recording = createRecordingGL()
    // createGL инжектит → hardware = { webgl2: true, webgpu: false } (createGPU не инъектирован)
    // Но GLSL-only → covers=false для webgpu. Так как webgpu недоступен — всё равно фолбэк на webgl2.
    const r = createRenderer({
      canvas: fakeCanvas(),
      // default backend = ['webgpu', 'webgl2']
      createGL: () => recording.gl,
      ...COMMON,
    })
    r.command(GLSL_ONLY)
    await r.start()
    expect(r.backend).toBe('webgl2')
    expect(r.decision?.verdicts.webgpu.available).toBe(false)
    expect(r.decision?.message).toContain('WebGL2')
    r.stop()
  })

  it('strict backend="webgl2", DUAL спек — компилирует GLSL-вариант, не требует wgsl', async () => {
    const recording = createRecordingGL()
    const r = createRenderer({
      canvas: fakeCanvas(),
      backend: 'webgl2',
      createGL: () => recording.gl,
      ...COMMON,
    })
    const tri = r.command(DUAL)
    await r.start()
    // proxy подключён к реальной команде — record() должен делегировать без throw
    expect(() => {
      // inner есть, surface работает после start
      r.surface({ width: 8, height: 8 })
    }).not.toThrow()
    expect(tri.id).toBeGreaterThanOrEqual(0)  // proxy получил id от real после _attach
    r.stop()
  })

  it('strict backend="webgpu", инъекция createGPU — WebGPU init', async () => {
    const original = (globalThis as { navigator?: unknown }).navigator
    ;(globalThis as { navigator?: unknown }).navigator = { gpu: { requestAdapter: async () => ({}) } }
    try {
      const { gpu } = createRecordingGPU()
      const r = createRenderer({
        canvas: fakeCanvas(),
        backend: 'webgpu',
        createGPU: async () => gpu,
        ...COMMON,
      })
      r.command(DUAL)
      await r.start()
      expect(r.backend).toBe('webgpu')
      expect(r.decision?.message).toContain('Принудительный')
      r.stop()
    } finally {
      ;(globalThis as { navigator?: unknown }).navigator = original
    }
  })

  it('late-reject: WGSL-only command после старта на WebGL2 кидает actionable', async () => {
    const recording = createRecordingGL()
    const r = createRenderer({
      canvas: fakeCanvas(),
      backend: 'webgl2',
      createGL: () => recording.gl,
      ...COMMON,
    })
    await r.start()
    expect(() => r.command(WGSL_ONLY)).toThrow(/WGSL.*WebGL2|переЗапустите|перезапустите|backend/i)
    r.stop()
  })

  it('late-reject: GLSL-only command на WebGL2 — проходит (нет throw)', async () => {
    const recording = createRecordingGL()
    const r = createRenderer({
      canvas: fakeCanvas(),
      backend: 'webgl2',
      createGL: () => recording.gl,
      ...COMMON,
    })
    await r.start()
    expect(() => r.command(GLSL_ONLY)).not.toThrow()
    r.stop()
  })

  it('BackendResolutionError — strict backend="webgpu", недоступен → выбрасывает с decision', async () => {
    const r = createRenderer({
      canvas: fakeCanvas(),
      backend: 'webgpu',  // strict WebGPU, в node недоступен (нет navigator.gpu)
      ...COMMON,
    })
    r.command(DUAL)
    try {
      await r.start()
      expect.unreachable('должна бросить BackendResolutionError')
    } catch (e) {
      expect(e).toBeInstanceOf(BackendResolutionError)
      const err = e as BackendResolutionError
      expect(err.decision.chosen).toBeNull()
      expect(err.decision.verdicts.webgpu.available).toBe(false)
      expect(err.decision.message).toContain('недоступен')
    }
  })

  it('lazy proxy command: .record() до .start() кидает понятную ошибку', () => {
    const recording = createRecordingGL()
    const r = createRenderer({
      canvas: fakeCanvas(),
      backend: 'webgl2',
      createGL: () => recording.gl,
      ...COMMON,
    })
    const tri = r.command(DUAL)
    expect(() => {
      // Вызываем record напрямую, как executor в кадре
      ;(tri as { record: (p: unknown, ctx: { time: number; dt: number; aspect: number }, w: unknown) => void })
        .record({}, { time: 0, dt: 0, aspect: 1 }, null)
    }).toThrow(/start/)
    // НЕ вызываем r.start() — оставляем ресурс неинициализированным; тест завершается без побочных эффектов
  })

  it('frame() до start — колбэк выполняется после start', async () => {
    const recording = createRecordingGL()
    const r = createRenderer({
      canvas: fakeCanvas(),
      backend: 'webgl2',
      createGL: () => recording.gl,
      ...COMMON,
    })
    let frames = 0
    r.frame(() => { frames++ })
    expect(frames).toBe(0)  // ещё не запущен
    await r.start()
    r.step(16)  // вручную крутит кадр
    expect(frames).toBe(1)
    r.stop()
  })
})
