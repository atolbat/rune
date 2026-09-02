import { describe, expect, it } from 'bun:test'
import { createAutoRenderer, BackendResolutionError } from '../src/autoRenderer.ts'
import type { AutoDrawSpec } from '../src/autoBackend.ts'
import { createRecordingGL } from '@rune/webgl2'
import { createRecordingGPU } from '@rune/webgpu'

/**
 * createAutoRenderer — the integration path: probe → resolveBackend → inner.
 * Late-reject: r.command(spec) with an unsuitable shader throws an actionable error.
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

describe('createAutoRenderer — late-reject + integration', () => {
  it('GLSL-only spec, both backends available → silent fallback to WebGL2 with a reason', async () => {
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
    expect(r.decision.message).toContain('specs without WGSL')
    r.stop()
  })

  it('dual-source without injections → BackendResolutionError (no navigator.gpu in node)', async () => {
    // In node: navigator.gpu is missing → the probe returns false
    // The WebGL2 probe via canvas.cloneNode will also fail (no getContext in the fake)
    // → no hardware at all → conflict
    await expect(createAutoRenderer({
      canvas: fakeCanvas(),
      specs: [DUAL],
      ...COMMON,
    })).rejects.toThrow()
  })

  it('strict order=["webgl2"] → WebGL2, even if the spec is dual-source', async () => {
    const recording = createRecordingGL()
    const r = await createAutoRenderer({
      canvas: fakeCanvas(),
      order: ['webgl2'],
      specs: [DUAL],
      createGL: () => recording.gl,
      ...COMMON,
    })
    expect(r.backend).toBe('webgl2')
    expect(r.decision.message).toContain('Forced')
    r.stop()
  })

  it('late-reject: a GLSL-only command on WebGL2 works', async () => {
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

  it('late-reject: a WGSL-only command on WebGL2 throws an actionable error', async () => {
    const recording = createRecordingGL()
    const r = await createAutoRenderer({
      canvas: fakeCanvas(),
      order: ['webgl2'],
      specs: [GLSL_ONLY],
      createGL: () => recording.gl,
      ...COMMON,
    })
    expect(() => r.command(WGSL_ONLY)).toThrow(/only WGSL.*activ.*WebGL2|activ.*back.*WebGL2|Restart|restart/i)
    r.stop()
  })

  it('strict order=["webgpu"], createGPU injection → WebGPU works', async () => {
    // A navigator.gpu stub for the default probeGpu
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
      expect(r.decision.message).toContain('Forced')
      r.stop()
    } finally {
      ;(globalThis as { navigator?: unknown }).navigator = original
    }
  })

  it('BackendResolutionError carries a structured decision', async () => {
    try {
      await createAutoRenderer({
        canvas: fakeCanvas(),
        order: ['webgpu'], // strict WebGPU, unavailable in node
        specs: [DUAL],
        ...COMMON,
      })
      expect.unreachable('must throw')
    } catch (e) {
      expect(e).toBeInstanceOf(BackendResolutionError)
      const err = e as BackendResolutionError
      expect(err.decision.chosen).toBeNull()
      expect(err.decision.verdicts.webgpu.available).toBe(false)
      expect(err.decision.message).toContain('unavailable')
    }
  })
})
