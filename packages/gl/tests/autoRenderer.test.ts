import { describe, expect, it } from 'bun:test'
import { createAutoRenderer, BackendResolutionError } from '../src/autoRenderer.ts'
import type { AutoDrawSpec } from '../src/autoBackend.ts'
import { createRecordingGL } from '@rune/webgl2'
import { createRecordingGPU } from '@rune/webgpu'

/**
 * createAutoRenderer — интеграционный путь: probe → resolveBackend → inner.
 * Late-reject: r.command(spec) с неподходящим шейдером кидает actionable-ошибку.
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

describe('createAutoRenderer — late-reject + интеграция', () => {
  it('GLSL-only спек, оба бэкенда доступны → тихий фолбэк на WebGL2 с reason', async () => {
    const recording = createRecordingGL()
    const r = await createAutoRenderer({
      canvas: fakeCanvas(),
      specs: [GLSL_ONLY],
      createGL: () => recording.gl,
      ...COMMON,
    })
    expect(r.backend).toBe('webgl2')
    expect(r.decision.chosen).toBe('webgl2')
    expect(r.decision.message).toContain('WebGL2')
    expect(r.decision.message).toContain('спекы без WGSL')
    r.stop()
  })

  it('dual-source без инъекций → BackendResolutionError (нет navigator.gpu в node)', async () => {
    // В node: navigator.gpu отсутствует → probe возвращает false
    // WebGL2-проба через canvas.cloneNode тоже упадёт (нет getContext в fake)
    // → нет ни одного hardware → конфликт
    await expect(createAutoRenderer({
      canvas: fakeCanvas(),
      specs: [DUAL],
      ...COMMON,
    })).rejects.toThrow()
  })

  it('strict order=["webgl2"] → WebGL2, даже если спек dual-source', async () => {
    const recording = createRecordingGL()
    const r = await createAutoRenderer({
      canvas: fakeCanvas(),
      order: ['webgl2'],
      specs: [DUAL],
      createGL: () => recording.gl,
      ...COMMON,
    })
    expect(r.backend).toBe('webgl2')
    expect(r.decision.message).toContain('Принудительный')
    r.stop()
  })

  it('late-reject: GLSL-only command на WebGL2 работает', async () => {
    const recording = createRecordingGL()
    const r = await createAutoRenderer({
      canvas: fakeCanvas(),
      order: ['webgl2'],
      specs: [GLSL_ONLY],
      createGL: () => recording.gl,
      ...COMMON,
    })
    expect(() => r.command(GLSL_ONLY)).not.toThrow()
    r.stop()
  })

  it('late-reject: WGSL-only command на WebGL2 кидает actionable-ошибку', async () => {
    const recording = createRecordingGL()
    const r = await createAutoRenderer({
      canvas: fakeCanvas(),
      order: ['webgl2'],
      specs: [GLSL_ONLY],
      createGL: () => recording.gl,
      ...COMMON,
    })
    expect(() => r.command(WGSL_ONLY)).toThrow(/только WGSL.*activ.*WebGL2|activ.*back.*WebGL2|перЗапустите|перезапустите/i)
    r.stop()
  })

  it('strict order=["webgpu"], инжекция createGPU → WebGPU работает', async () => {
    // Стаб navigator.gpu для probeGpu по умолчанию
    const original = (globalThis as { navigator?: unknown }).navigator
    ;(globalThis as { navigator?: unknown }).navigator = { gpu: { requestAdapter: async () => ({}) } }
    try {
      const { gpu } = createRecordingGPU()
      const r = await createAutoRenderer({
        canvas: fakeCanvas(),
        order: ['webgpu'],
        specs: [DUAL],
        createGPU: async () => gpu,
        ...COMMON,
      })
      expect(r.backend).toBe('webgpu')
      expect(r.decision.message).toContain('Принудительный')
      r.stop()
    } finally {
      ;(globalThis as { navigator?: unknown }).navigator = original
    }
  })

  it('BackendResolutionError несёт структурированный decision', async () => {
    try {
      await createAutoRenderer({
        canvas: fakeCanvas(),
        order: ['webgpu'], // strict WebGPU, в node недоступен
        specs: [DUAL],
        ...COMMON,
      })
      expect.unreachable('должна бросить')
    } catch (e) {
      expect(e).toBeInstanceOf(BackendResolutionError)
      const err = e as BackendResolutionError
      expect(err.decision.chosen).toBeNull()
      expect(err.decision.verdicts.webgpu.available).toBe(false)
      expect(err.decision.message).toContain('недоступен')
    }
  })
})
