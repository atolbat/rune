// Task 168 — THE RESTORE WIRE: in-place recovery from webglcontextlost →
// webglcontextrestored on the RESOURCE-SESSION path.
//
// The pre-168 behavior: context loss stopped the loop with an honest
// report; a RESTORED context (the browser fires webglcontextrestored after
// our preventDefault) was never picked up — the documented TODO in the
// Task-137 comment. The wire:
//   SESSION PATH (resources: journal): restored → the raw facade resets
//     (fresh Maps, counters at zero, every memo disarmed) → the journal
//     replays (stable ids hold) → the executor's commands re-create
//     programs/buffers lazily and re-dirty their uniform fields → the loop
//     resumes if the loss stopped a running one.
//   PLAIN PATH: the honest boundary — a report names what cannot be
//     replayed, the loop stays stopped (no silent zombie, no half-alive
//     renderer with dead texture ids).
//   DISPOSE: the restore wire is removed with the loss wire — a disposed
//     renderer cannot be resurrected.

import { describe, expect, it } from 'bun:test'
import { createWebGL2Renderer } from '../src/webgl2Renderer.ts'
import { createResourceJournal } from '@rune/core'

const VERT = `#version 300 es
layout(location = 0) in vec3 position;
uniform mat4 u_mvp;
void main() { gl_Position = u_mvp * vec4(position, 1.0); }`
const FRAG = `#version 300 es
precision mediump float;
uniform vec4 u_tint;
out vec4 o_color;
void main() { o_color = u_tint; }`

/** A raw-context canvas + event-listener capture + call counters (the
 *  restore oracle: every GL object the mock hands out is a FRESH {} — the
 *  pre-168 facade would keep pointing at the DEAD ones). */
function restoreMock(): {
  canvas: HTMLCanvasElement
  fire: (name: 'webglcontextlost' | 'webglcontextrestored') => boolean
  counts: { createProgram: number; createTexture: number; drawArrays: number; uniform4fv: number; useProgram: number }
  prevented: () => number
} {
  const listeners = new Map<string, Array<(event: Event) => void>>()
  let preventCount = 0
  let program = 0
  let texture = 0
  const counts = { createProgram: 0, createTexture: 0, drawArrays: 0, uniform4fv: 0, useProgram: 0 }
  const raw = {
    // the constants realGL reads off the context
    VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30, LINK_STATUS: 0x8b82, COMPILE_STATUS: 0x8b81,
    COLOR_BUFFER_BIT: 16384, DEPTH_BUFFER_BIT: 256,
    TEXTURE_2D: 3553, DEPTH_TEST: 2929, CULL_FACE: 2884, BLEND: 3042,
    FRAMEBUFFER: 36009, FRAMEBUFFER_COMPLETE: 36053, ARRAY_BUFFER: 0x8892,
    FUNC_ADD: 32774, ONE: 1, ZERO: 0, NONE: 0, TRIANGLES: 4,
    NEAREST: 0x2600, LINEAR: 0x2601,
    TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800, TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803,
    CLAMP_TO_EDGE: 0x812f, TEXTURE_BASE_LEVEL: 0x813c, TEXTURE_MAX_LEVEL: 0x813d,
    UNPACK_FLIP_Y_WEBGL: 37440, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 37441,
    UNPACK_COLORSPACE_CONVERSION_WEBGL: 37443, UNPACK_ALIGNMENT: 3317,
    drawingBufferWidth: 800, drawingBufferHeight: 600,
    getExtension: () => null, // no KHR parallel compile — the sync link path
    getParameter: () => 4096,
    isContextLost: () => false,
    createProgram: () => { counts.createProgram++; return { id: ++program } },
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    deleteShader: () => {},
    getUniformLocation: () => ({ name: 'u' }),
    getAttribLocation: () => 0,
    useProgram: () => { counts.useProgram++ },
    deleteProgram: () => {},
    uniform1f: () => {}, uniform1i: () => {},
    uniform4fv: () => { counts.uniform4fv++ },
    uniformMatrix4fv: () => {},
    createBuffer: () => ({}),
    deleteBuffer: () => {},
    bindBuffer: () => {},
    bufferData: () => {},
    bufferSubData: () => {},
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    vertexAttribDivisor: () => {},
    createTexture: () => { counts.createTexture++; return { id: ++texture } },
    deleteTexture: () => {},
    bindTexture: () => {},
    activeTexture: () => {},
    texParameteri: () => {},
    texImage2D: () => {},
    texStorage2D: () => {},
    texSubImage2D: () => {},
    pixelStorei: () => {},
    viewport: () => {},
    bindFramebuffer: () => {},
    createFramebuffer: () => ({}),
    deleteFramebuffer: () => {},
    framebufferTexture2D: () => {},
    createRenderbuffer: () => ({}),
    renderbufferStorage: () => {},
    framebufferRenderbuffer: () => {},
    checkFramebufferStatus: () => 36053,
    clearColor: () => {},
    clearDepth: () => {},
    depthMask: () => {},
    clear: () => {},
    enable: () => {},
    disable: () => {},
    depthFunc: () => {},
    cullFace: () => {},
    frontFace: () => {},
    drawArrays: () => { counts.drawArrays++ },
    drawArraysInstanced: () => { counts.drawArrays++ },
    getError: () => 0,
  } as unknown as WebGL2RenderingContext
  const canvas = {
    clientWidth: 800,
    clientHeight: 600,
    width: 0,
    height: 0,
    getContext: () => raw,
    addEventListener: (name: string, cb: (event: Event) => void) => {
      const list = listeners.get(name) ?? []
      list.push(cb)
      listeners.set(name, list)
    },
    removeEventListener: (name: string) => { listeners.delete(name) },
  } as unknown as HTMLCanvasElement
  return {
    canvas,
    fire: name => {
      let saw = false
      for (const cb of listeners.get(name) ?? []) {
        cb({ preventDefault: () => { preventCount++; saw = true } } as unknown as Event)
      }
      return listeners.has(name)
    },
    counts,
    prevented: () => preventCount,
  }
}

function makeRenderer(canvas: HTMLCanvasElement, errors: string[], journal?: ReturnType<typeof createResourceJournal>, frameSink?: { cb: ((t: number) => void) | null; armed: number }) {
  return createWebGL2Renderer({
    canvas,
    ...(journal !== undefined ? { resources: journal } : {}),
    caps: null,
    observeResize: false,
    now: () => 0,
    requestFrame: (callback: (timestamp: number) => void) => {
      if (frameSink !== undefined) { frameSink.cb = callback; frameSink.armed++ }
      return () => { if (frameSink !== undefined && frameSink.cb === callback) frameSink.cb = null }
    },
    onGlError: message => errors.push(message),
  })
}

describe('Task 168: THE RESTORE WIRE (in-place context-loss recovery)', () => {
  it('the session path: loss stops the loop with the replay promise; restore replays the journal, re-creates the program, re-uploads the uniforms and RESUMES', () => {
    const mock = restoreMock()
    const errors: string[] = []
    const journal = createResourceJournal()
    const frameSink = { cb: null as ((t: number) => void) | null, armed: 0 }
    const renderer = makeRenderer(mock.canvas, errors, journal, frameSink)

    const command = renderer.command({
      shader: { glsl: { vertex: VERT, fragment: FRAG } },
      attributes: { position: { data: new Float32Array(9), size: 3 } },
      uniforms: { u_tint: [1, 0.5, 0.25, 1] },
      count: 3,
    })
    renderer.frame((_ctx, record) => record(command, {}))
    const tex = renderer.texture(256, 256)
    renderer.start()
    frameSink.cb!(16) // frame 1: the program + buffer + texture created, the uniform uploaded
    expect(mock.counts.createProgram).toBe(1)
    expect(mock.counts.createTexture).toBe(1)
    expect(mock.counts.uniform4fv).toBe(1)
    expect(mock.counts.drawArrays).toBe(1)

    // ── the loss: the loop stops, preventDefault keeps the context restorable ──
    mock.fire('webglcontextlost')
    expect(mock.prevented()).toBe(1)
    expect(errors.some(e => e.includes('WebGL context lost'))).toBe(true)
    expect(errors.some(e => e.includes('journal will replay automatically'))).toBe(true)
    const drawsAtLoss = mock.counts.drawArrays
    frameSink.cb?.(32) // a stale scheduled callback — the loop is dead, no draw
    expect(mock.counts.drawArrays).toBe(drawsAtLoss)

    // ── the restore: the journal replays, the derived state re-creates ──
    mock.fire('webglcontextrestored')
    expect(mock.counts.createTexture).toBe(2) // the journal replay re-created the texture
    expect(errors.some(e => e.includes('WebGL context restored'))).toBe(true)
    expect(errors.some(e => e.includes('1 textures'))).toBe(true)
    // the loop RESUMED: start() re-armed the schedule (a NEW frame callback)
    expect(frameSink.cb).not.toBeNull()
    frameSink.cb!(48)
    expect(mock.counts.createProgram).toBe(2) // the command's program re-created from its spec
    expect(mock.counts.uniform4fv).toBe(2) // the uniform re-dirtied → re-uploaded to the FRESH program
    expect(mock.counts.drawArrays).toBe(drawsAtLoss + 1) // drawing again
    // the stable texture id survived the incarnation change
    expect(tex.textureId).toBe(1)
    expect(() => renderer.attachTexture(tex.textureId, 256, 256)).not.toThrow()
    renderer.stop()
  })

  it('the plain path (no journal): restore reports the honest boundary, the loop does NOT resume', () => {
    const mock = restoreMock()
    const errors: string[] = []
    const frameSink = { cb: null as ((t: number) => void) | null, armed: 0 }
    const renderer = makeRenderer(mock.canvas, errors, undefined, frameSink)
    renderer.start()
    frameSink.cb!(16) // an empty frame: the clear ran, no commands to draw
    expect(frameSink.cb).not.toBeNull() // the loop is alive and re-armed

    mock.fire('webglcontextlost')
    expect(errors.some(e => e.includes('WebGL context lost'))).toBe(true)
    expect(errors.some(e => e.includes('re-boot the backend toggle'))).toBe(true)
    frameSink.cb?.(32) // a stale scheduled callback — the loop is dead, a no-op
    mock.fire('webglcontextrestored')
    expect(errors.some(e => e.includes('WITHOUT the resource journal'))).toBe(true)
    expect(errors.some(e => e.includes('Re-boot the renderer to recover'))).toBe(true)
    // NO auto-resume: the restore armed no new frame callback
    const armedAtBoundary = frameSink.armed
    frameSink.cb?.(48) // still only the stale no-op callback
    expect(frameSink.armed).toBe(armedAtBoundary)
    // start() still refuses (contextLost was never cleared on the plain path)
    errors.length = 0
    renderer.start()
    expect(errors.some(e => e.includes('context loss'))).toBe(true)
    renderer.stop()
  })

  it('dispose removes the restore wire: a disposed renderer cannot be resurrected', () => {
    const mock = restoreMock()
    const errors: string[] = []
    const journal = createResourceJournal()
    const renderer = makeRenderer(mock.canvas, errors, journal)
    renderer.start()
    mock.fire('webglcontextlost') // pre-dispose loss (the listener fires — the renderer is alive)
    renderer.dispose()
    errors.length = 0
    // both listeners are gone: neither event reaches the dead renderer
    expect(mock.fire('webglcontextlost')).toBe(false)
    expect(mock.fire('webglcontextrestored')).toBe(false)
    expect(errors.length).toBe(0)
  })

  it('a restore while the loop was NEVER running recovers the resources but does not start the loop', () => {
    const mock = restoreMock()
    const errors: string[] = []
    const journal = createResourceJournal()
    const frameSink = { cb: null as ((t: number) => void) | null, armed: 0 }
    const renderer = makeRenderer(mock.canvas, errors, journal, frameSink)
    renderer.texture(256, 256) // journaled — but the loop never started
    mock.fire('webglcontextlost')
    mock.fire('webglcontextrestored')
    expect(mock.counts.createTexture).toBe(2) // replayed anyway
    expect(errors.some(e => e.includes('WebGL context restored'))).toBe(true)
    expect(frameSink.armed).toBe(0) // no auto-start: nothing was ever armed
    // and the renderer can still be started by hand afterwards
    renderer.start()
    expect(frameSink.cb).not.toBeNull()
    renderer.stop()
  })
})
