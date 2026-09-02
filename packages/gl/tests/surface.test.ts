import { describe, expect, it } from 'bun:test'
import { createWebGL2Renderer } from '../src/index.ts'
import { createRecordingGL } from '@rune/webgl2'

/**
 * Surface + pass — a unified structure of fullscreen passes (the WebGL2 path).
 * Call order on the recorder: the post-processing chain
 * capture(scene → surface) → pass(surface → canvas).
 */

function fakeCanvas(): HTMLCanvasElement {
  return { clientWidth: 800, clientHeight: 600, width: 0, height: 0 } as unknown as HTMLCanvasElement
}

function setup() {
  const recording = createRecordingGL()
  const renderer = createWebGL2Renderer({
    canvas: fakeCanvas(),
    createGL: () => recording.gl,
    observeResize: false,
    now: () => 0,
    requestFrame: () => () => {},
  })
  return { renderer, calls: recording.calls }
}

const SCENE_VERT = `#version 300 es
layout(location = 0) in vec3 position;
uniform mat4 u_mvp;
void main() { gl_Position = u_mvp * vec4(position, 1.0); }`

const SCENE_FRAG = `#version 300 es
precision mediump float;
out vec4 o_color;
void main() { o_color = vec4(0.4, 0.6, 0.9, 1.0); }`

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

/** Present-pass fragment: an input sampler (the former image()). */
const PRESENT_FRAG = `#version 300 es
precision mediump float;
uniform sampler2D u_src;
in vec2 v_uv;
out vec4 o_color;
void main() { o_color = texture(u_src, v_uv); }`

/** Generator fragment: no inputs (the former frag()). */
const GEN_FRAG = `#version 300 es
precision mediump float;
uniform float u_time;
uniform vec2 u_resolution;
in vec2 v_uv;
out vec4 o_color;
void main() {
  float wave = 0.5 + 0.5 * sin((v_uv.x + v_uv.y) * 20.0 + u_time * 3.0);
  o_color = vec4(vec3(wave) * u_resolution.x * 0.0 + wave, 1.0);
}`

describe('surface/pass — WebGL2', () => {
  it('the full post-processing chain: capture → present, target order is correct', () => {
    const { renderer, calls } = setup()
    const scene = renderer.command({
      shader: { glsl: { vertex: SCENE_VERT, fragment: SCENE_FRAG } },
      attributes: { position: { data: new Float32Array(9), size: 3 } },
      uniforms: { u_mvp: () => IDENTITY },
      count: 3,
    })
    const surface = renderer.surface({ width: 256, height: 256, depth: true })
    const present = renderer.pass(PRESENT_FRAG, { inputs: { u_src: surface.texture } })

    renderer.frame((_ctx, record) => {
      record(surface.capture(scene), {})
      record(present)
    })
    renderer.step(16)

    // The surface is created: texture + target with depth
    expect(calls).toContain('createTexture(256,256)')
    expect(calls).toContain('createTarget(1,256,256,depth)')

    // Frame order: clear the canvas → bindTarget(surface,clear) → scene →
    // bindTarget(canvas) → fullscreen pass
    const clearAt = calls.findIndex(call => call.startsWith('clear('))
    const intoSurfaceAt = calls.indexOf('bindTarget(1,1)')
    const sceneDrawAt = calls.indexOf('drawArrays(triangles,0,3,1)')
    const backToCanvasAt = calls.indexOf('bindTarget(0,0)')
    const presentDrawAt = calls.indexOf('drawArrays(triangles,0,6,1)')
    expect(clearAt).toBeGreaterThanOrEqual(0)
    expect(intoSurfaceAt).toBeGreaterThan(clearAt)
    expect(sceneDrawAt).toBeGreaterThan(intoSurfaceAt)
    expect(backToCanvasAt).toBeGreaterThan(sceneDrawAt)
    expect(presentDrawAt).toBeGreaterThan(backToCanvasAt)
    renderer.stop()
  })

  it('present (image case): input sampler on unit 0, a quad of 6 vertices, no bindTarget', () => {
    const { renderer, calls } = setup()
    const texture = renderer.texture(64, 64)
    const present = renderer.pass(PRESENT_FRAG, { inputs: { u_src: texture } })
    renderer.frame((_ctx, record) => record(present))
    renderer.step(16)

    expect(calls).toContain('bindTexture(1,0)') // textureId 1, unit 0
    expect(calls).toContain('uniform1i(u_src,0)')
    expect(calls).toContain('drawArrays(triangles,0,6,1)')
    // A pure canvas frame: no target switches (skip in the facade)
    expect(calls.filter(call => call.startsWith('bindTarget(')).length).toBe(0)
    renderer.stop()
  })

  it('generation (frag case): a pass INTO a surface, the builtin u_time updates', () => {
    const { renderer, calls } = setup()
    const surface = renderer.surface({ width: 128, height: 128 })
    const gen = surface.pass(GEN_FRAG)
    renderer.frame((_ctx, record) => record(gen))
    renderer.step(500)

    // The target is the surface, no clear (the quad covers everything)
    expect(calls).toContain('bindTarget(1,0)')
    expect(calls).toContain('drawArrays(triangles,0,6,1)')
    // The builtin u_time is substituted and received the frame time (500 ms = 0.5 s,
    // exactly representable in float32 — no rounding in the call string)
    const timeCalls = calls.filter(call => call.startsWith('uniform1f(u_time,'))
    expect(timeCalls.length).toBeGreaterThan(0)
    expect(timeCalls[0]).toBe('uniform1f(u_time,0.5)')
    // The builtin u_resolution — the TARGET size (the surface's, not the canvas's)
    expect(calls).toContain('uniform2fv(u_resolution)')
    renderer.stop()
  })

  it('capture(clear: false) does not clear the surface; by default it does', () => {
    const { renderer, calls } = setup()
    const scene = renderer.command({
      shader: { glsl: { vertex: SCENE_VERT, fragment: SCENE_FRAG } },
      attributes: { position: { data: new Float32Array(9), size: 3 } },
      uniforms: { u_mvp: () => IDENTITY },
      count: 3,
    })
    const surface = renderer.surface({ width: 64, height: 64 })
    renderer.frame((_ctx, record) => {
      record(surface.capture(scene, { clear: false }), {})
    })
    renderer.step(16)
    expect(calls).toContain('bindTarget(1,0)')
    expect(calls).not.toContain('bindTarget(1,1)')
    renderer.stop()
  })

  it('pingpong of two surfaces: A → B → canvas, targets alternate without reading the target', () => {
    const { renderer, calls } = setup()
    const a = renderer.surface({ width: 64, height: 64 })
    const b = renderer.surface({ width: 64, height: 64 })
    const gen = a.pass(GEN_FRAG)
    const toB = b.pass(PRESENT_FRAG, { inputs: { u_src: a.texture } })
    const toCanvas = renderer.pass(PRESENT_FRAG, { inputs: { u_src: b.texture } })
    renderer.frame((_ctx, record) => {
      record(gen)
      record(toB)
      record(toCanvas)
    })
    renderer.step(16)

    const order = calls.filter(call => call.startsWith('bindTarget('))
    // The surfaces got targetId 1 and 2; order: A → B → canvas
    expect(order).toEqual(['bindTarget(1,0)', 'bindTarget(2,0)', 'bindTarget(0,0)'])
    // The input of the second pass is the first surface's texture
    expect(calls).toContain('bindTexture(1,0)')
    renderer.stop()
  })

  it('second frame: the return to the canvas is guaranteed (BeginPass), the scene goes into the surface again', () => {
    const { renderer, calls } = setup()
    const scene = renderer.command({
      shader: { glsl: { vertex: SCENE_VERT, fragment: SCENE_FRAG } },
      attributes: { position: { data: new Float32Array(9), size: 3 } },
      uniforms: { u_mvp: () => IDENTITY },
      count: 3,
    })
    const surface = renderer.surface({ width: 64, height: 64, depth: true })
    const present = renderer.pass(PRESENT_FRAG, { inputs: { u_src: surface.texture } })
    renderer.frame((_ctx, record) => {
      record(surface.capture(scene), {})
      record(present)
    })
    renderer.step(16)
    renderer.step(32)

    // Frame 2: clear the canvas after returning from the surface — before the new scene recording
    const clears = calls.map((call, at) => ({ call, at })).filter(c => c.call.startsWith('clear('))
    expect(clears.length).toBe(2)
    const secondClearAt = clears[1].at
    const secondIntoSurfaceAt = calls.indexOf('bindTarget(1,1)', secondClearAt)
    expect(secondIntoSurfaceAt).toBeGreaterThan(secondClearAt)
    renderer.stop()
  })
})
