import { describe, expect, it } from 'bun:test'
import { createWebGL2Renderer } from '../src/webgl2Renderer.ts'
import { createJournal, createResourceJournal } from '@rune/core'
import { createRecordingGL } from '@rune/webgl2'
import type { GLFacade } from '@rune/webgl2'

// Task 169 — the renderer-level wiring of the multi-draw tier:
//   • renderer.multiDraw — the live verdict (option AND facade capability,
//     seen THROUGH the journal/resource-session decorators, which forward
//     the method conditionally so presence mirrors the raw context);
//   • the kill-switch option;
//   • an end-to-end frame: a command recorded THREE times in one frame
//     callback lands as ONE multiDraw call through the whole stack
//     (renderer → tape → executor → facade).

function fakeCanvas(): HTMLCanvasElement {
  return { clientWidth: 800, clientHeight: 600, width: 0, height: 0 } as unknown as HTMLCanvasElement
}

/** A recording facade clone WITHOUT the multi-draw method — the extension-less context. */
function classicFacade(recording: { gl: GLFacade }): GLFacade {
  const gl = { ...recording.gl } as GLFacade & { multiDrawArraysInstanced?: unknown }
  delete gl.multiDrawArraysInstanced
  return gl as unknown as GLFacade
}

const VERT = `#version 300 es
layout(location = 0) in vec3 position;
uniform float u_x;
void main() { gl_Position = vec4(position, u_x, 1.0); }`

const FRAG = `#version 300 es
precision mediump float;
out vec4 o_color;
void main() { o_color = vec4(1.0, 0.5, 0.25, 1.0); }`

describe('Task 169: the multi-draw tier wiring (webgl2Renderer)', () => {
  it('renderer.multiDraw: true with the facade method present (default), false without it, false via the kill-switch', () => {
    const withMethod = createRecordingGL()
    const r1 = createWebGL2Renderer({
      canvas: fakeCanvas(), createGL: () => withMethod.gl, caps: null, observeResize: false, now: () => 0,
    })
    expect(r1.multiDraw).toBe(true)

    const without = createRecordingGL()
    const r2 = createWebGL2Renderer({
      canvas: fakeCanvas(), createGL: () => classicFacade(without), caps: null, observeResize: false, now: () => 0,
    })
    expect(r2.multiDraw).toBe(false)

    const killed = createRecordingGL()
    const r3 = createWebGL2Renderer({
      canvas: fakeCanvas(), createGL: () => killed.gl, caps: null, observeResize: false, now: () => 0,
      multiDraw: false,
    })
    expect(r3.multiDraw).toBe(false)
    r1.dispose(); r2.dispose(); r3.dispose()
  })

  it('the journal decorator forwards the method conditionally (presence mirrors the raw facade)', () => {
    const withMethod = createRecordingGL()
    const rj1 = createWebGL2Renderer({
      canvas: fakeCanvas(), createGL: () => withMethod.gl, journal: createJournal(), caps: null, observeResize: false, now: () => 0,
    })
    expect(rj1.multiDraw).toBe(true)

    const without = createRecordingGL()
    const rj2 = createWebGL2Renderer({
      canvas: fakeCanvas(), createGL: () => classicFacade(without), journal: createJournal(), caps: null, observeResize: false, now: () => 0,
    })
    expect(rj2.multiDraw).toBe(false)
    rj1.dispose(); rj2.dispose()
  })

  it('the resource-session decorator forwards the method conditionally (presence mirrors the raw facade)', () => {
    const withMethod = createRecordingGL()
    const rs1 = createWebGL2Renderer({
      canvas: fakeCanvas(), createGL: () => withMethod.gl, resources: createResourceJournal(), caps: null, observeResize: false, now: () => 0,
    })
    expect(rs1.multiDraw).toBe(true)

    const without = createRecordingGL()
    const rs2 = createWebGL2Renderer({
      canvas: fakeCanvas(), createGL: () => classicFacade(without), resources: createResourceJournal(), caps: null, observeResize: false, now: () => 0,
    })
    expect(rs2.multiDraw).toBe(false)
    rs1.dispose(); rs2.dispose()
  })

  it('an end-to-end frame: a command recorded THREE times in one frame callback lands as ONE multiDraw call', () => {
    const recording = createRecordingGL()
    let frames = 0
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(), createGL: () => recording.gl, caps: null, observeResize: false, now: () => 0,
      requestFrame: () => () => {},
    })
    const command = renderer.command({
      shader: { glsl: { vertex: VERT, fragment: FRAG } },
      attributes: { position: { data: new Float32Array(9), size: 3 } },
      uniforms: { u_x: 0.5 },
      count: 6,
    })
    renderer.frame((_ctx, record) => {
      frames++
      // the same command THREE times — the multi-draw shape (a layered
      // glow, a repeated decal, a sliced soup)
      record(command, {})
      record(command, {})
      record(command, {})
    })
    renderer.step(0) // frame 1: programs, buffers, the first batch
    recording.calls.length = 0
    renderer.step(16) // frame 2: the steady state — the pinned window
    const multi = recording.calls.filter(c => c.startsWith('multiDraw'))
    const draws = recording.calls.filter(c => c.startsWith('drawArrays'))
    expect(frames).toBe(2)
    expect(multi.length).toBe(1)
    expect(multi[0]).toBe('multiDraw×3[6×1@0,6×1@0,6×1@0]')
    expect(draws.length).toBe(0)
    renderer.dispose()
  })

  it('the kill-switch end-to-end: multiDraw:false keeps every draw on the classic path', () => {
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(), createGL: () => recording.gl, caps: null, observeResize: false, now: () => 0,
      requestFrame: () => () => {},
      multiDraw: false,
    })
    const command = renderer.command({
      shader: { glsl: { vertex: VERT, fragment: FRAG } },
      attributes: { position: { data: new Float32Array(9), size: 3 } },
      uniforms: { u_x: 0.5 },
      count: 6,
    })
    renderer.frame((_ctx, record) => {
      record(command, {})
      record(command, {})
      record(command, {})
    })
    renderer.step(0)
    recording.calls.length = 0
    renderer.step(16)
    expect(recording.calls.filter(c => c.startsWith('multiDraw')).length).toBe(0)
    expect(recording.calls.filter(c => c === 'drawArrays(triangles,0,6,1)').length).toBe(3)
    renderer.dispose()
  })
})
