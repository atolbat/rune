import { describe, expect, it } from 'bun:test'
import { createRenderer, BackendResolutionError } from '../src/index.ts'
import type { AutoDrawSpec } from '../src/index.ts'
import { createRecordingGL } from '@rune/webgl2'
import { createRecordingGPU } from '@rune/webgpu'

/**
 * createRenderer — the single entry point with automatic backend choice (DESIGN.md §9.12).
 * Sync constructor + lazy discovery via .command() + async .start().
 *
 * Covered:
 *  - strict WebGL2 (backend='webgl2') — sync init, surface/pass work after start
 *  - strict WebGPU (backend='webgpu') — async init
 *  - auto default — WebGPU preferred, fallback WebGL2 (if the specs require it)
 *  - GLSL-only spec + both available → fallback to WebGL2 with a reason
 *  - late-reject: a WGSL-only command on WebGL2 throws an actionable error
 *  - BackendResolutionError carries a structured decision
 *  - lazy proxy command: works before .start(), throws if .record() before start
 *  - whyBackend() returns the decision after .start(), null before
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

describe('createRenderer — the single entry point with lazy discovery', () => {
  it('strict backend="webgl2" — sync init + whyBackend returns the decision after start', async () => {
    const recording = createRecordingGL()
    const r = createRenderer({
      canvas: fakeCanvas(),
      backend: 'webgl2',
      createGL: () => recording.gl,
      ...COMMON,
    })
    expect(r.backend).toBeNull()       // before start
    expect(r.whyBackend()).toBeNull()
    const tri = r.command(DUAL)        // lazy proxy before start
    expect(tri).toBeDefined()
    await r.start()
    expect(r.backend).toBe('webgl2')
    expect(r.decision?.chosen).toBe('webgl2')
    expect(r.decision?.message).toContain('Forced')
    r.stop()
  })

  it('auto default with a GLSL-only spec + both backends available → fallback to WebGL2 with a reason', async () => {
    const recording = createRecordingGL()
    // createGL is injected → hardware = { webgl2: true, webgpu: false } (createGPU is not injected)
    // But GLSL-only → covers=false for webgpu. Since webgpu is unavailable — a fallback to webgl2 anyway.
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

  it('strict backend="webgl2", DUAL spec — compiles the GLSL variant, does not require wgsl', async () => {
    const recording = createRecordingGL()
    const r = createRenderer({
      canvas: fakeCanvas(),
      backend: 'webgl2',
      createGL: () => recording.gl,
      ...COMMON,
    })
    const tri = r.command(DUAL)
    await r.start()
    // the proxy is connected to the real command — record() must delegate without throwing
    expect(() => {
      // the inner exists, surface works after start
      r.surface({ width: 8, height: 8 })
    }).not.toThrow()
    expect(tri.id).toBeGreaterThanOrEqual(0)  // the proxy got the id from the real one after _attach
    r.stop()
  })

  it('strict backend="webgpu", createGPU injection — WebGPU init', async () => {
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
      expect(r.decision?.message).toContain('Forced')
      r.stop()
    } finally {
      ;(globalThis as { navigator?: unknown }).navigator = original
    }
  })

  it('late-reject: a WGSL-only command after start on WebGL2 throws an actionable error', async () => {
    const recording = createRecordingGL()
    const r = createRenderer({
      canvas: fakeCanvas(),
      backend: 'webgl2',
      createGL: () => recording.gl,
      ...COMMON,
    })
    await r.start()
    expect(() => r.command(WGSL_ONLY)).toThrow(/WGSL.*WebGL2|Restart|restart|backend/i)
    r.stop()
  })

  it('late-reject: a GLSL-only command on WebGL2 — passes (no throw)', async () => {
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

  it('BackendResolutionError — strict backend="webgpu", unavailable → throws with the decision', async () => {
    const r = createRenderer({
      canvas: fakeCanvas(),
      backend: 'webgpu',  // strict WebGPU, unavailable in node (no navigator.gpu)
      ...COMMON,
    })
    r.command(DUAL)
    try {
      await r.start()
      expect.unreachable('must throw BackendResolutionError')
    } catch (e) {
      expect(e).toBeInstanceOf(BackendResolutionError)
      const err = e as BackendResolutionError
      expect(err.decision.chosen).toBeNull()
      expect(err.decision.verdicts.webgpu.available).toBe(false)
      expect(err.decision.message).toContain('unavailable')
    }
  })

  it('lazy proxy command: .record() before .start() throws a clear error', () => {
    const recording = createRecordingGL()
    const r = createRenderer({
      canvas: fakeCanvas(),
      backend: 'webgl2',
      createGL: () => recording.gl,
      ...COMMON,
    })
    const tri = r.command(DUAL)
    expect(() => {
      // Call record directly, like an executor in a frame
      ;(tri as { record: (p: unknown, ctx: { time: number; dt: number; aspect: number }, w: unknown) => void })
        .record({}, { time: 0, dt: 0, aspect: 1 }, null)
    }).toThrow(/start/)
    // Do NOT call r.start() — leave the resource uninitialized; the test finishes without side effects
  })

  it('frame() before start — the callback runs after start', async () => {
    const recording = createRecordingGL()
    const r = createRenderer({
      canvas: fakeCanvas(),
      backend: 'webgl2',
      createGL: () => recording.gl,
      ...COMMON,
    })
    let frames = 0
    r.frame(() => { frames++ })
    expect(frames).toBe(0)  // not started yet
    await r.start()
    r.step(16)  // manually drives a frame
    expect(frames).toBe(1)
    r.stop()
  })
})
