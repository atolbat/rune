// Task 165 — THE RENDER-PASS TWIN (WebGL2 side): Task 164's steady-state
// memos covered the COMPUTE/TF loops; the RENDER path still re-asserted its
// frame-static machinery per draw. Pinned here:
//
//   1. THE VERTEX-BIND MEMO — an identical pointer tuple
//      (buffer, size, stride, offset, divisor) re-asserted within a pass is
//      skipped entirely (bindBuffer + enable + pointer + divisor → 0 calls);
//      the pass boundary (bindTarget) re-arms it; a DIFFERENT tuple
//      re-binds for real.
//   2. THE ARRAY-BUFFER DISCIPLINE — after every REAL bind the generic
//      ARRAY_BUFFER binding ends EMPTY (a TF capture can never overlap the
//      buffer the memo would otherwise leave stale).
//   3. THE FEED WIN — updateBuffer (a contents-only upload) does NOT
//      invalidate the memo: the per-frame feed rebinds die too.
//   4. deleteBuffer disarms the memoized location (the Task-137 ledger walk).
//   5. THE SAMPLER-UNIT MEMO — setUniform1i with an unchanged
//      (program, name, value) skips the whole chain (no useProgram, no
//      location probe, no uniform1i); a different value re-arms.
//   6. THE EXECUTOR STEADY STATE — a tape of 2 commands drawn twice per
//      frame: from frame 2 on, ZERO vertex-bind and sampler-uniform GL
//      calls; the draws themselves land every frame.

import { describe, expect, test } from 'bun:test'
import { createRealGL } from '../src/realGL.ts'
import { createExecutor } from '../src/executor.ts'
import { compileDrawSpec, createCompileContext } from '../src/command.ts'
import { createUniformArena, createTapeWriter, writerView, OpCode } from '@rune/core'

const ARRAY_BUFFER = 34962
const KHR_COMPLETION_STATUS = 0x91b1
const LINK_STATUS = 0x8b82
const COMPILE_STATUS = 0x8b81

/** A raw-GL mock recording the vertex/uniform1i machinery (the task163
 *  shape, plus the bindBuffer/enable/pointer/divisor/uniform1i log). */
function glMock(): { calls: string[]; gl: WebGL2RenderingContext } {
  const calls: string[] = []
  let program = 0
  let shader = 0
  let buffer = 0
  let texture = 0
  let tf = 0
  let vao = 0
  const gl = {
    FRAMEBUFFER: 36009, FRAMEBUFFER_COMPLETE: 36053, COLOR_ATTACHMENT0: 36064, DEPTH_ATTACHMENT: 36096,
    RENDERBUFFER: 36161, DEPTH_COMPONENT16: 33189, TEXTURE_2D: 3553, DEPTH_TEST: 2929, CULL_FACE: 2884,
    LESS: 513, LEQUAL: 515, BACK: 1029, FRONT: 1028, COLOR_BUFFER_BIT: 16384, DEPTH_BUFFER_BIT: 256,
    BLEND: 3042, FUNC_ADD: 32774, ONE: 1, ZERO: 0, NONE: 0,
    UNPACK_FLIP_Y_WEBGL: 37440, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 37441, UNPACK_COLORSPACE_CONVERSION_WEBGL: 37443,
    UNPACK_ALIGNMENT: 3317,
    VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30, LINK_STATUS, COMPILE_STATUS,
    RASTERIZER_DISCARD: 0x8c50, TRANSFORM_FEEDBACK: 0x8e22, TRANSFORM_FEEDBACK_BUFFER: 0x8c8e,
    INTERLEAVED_ATTRIBS: 0x8c8c, PIXEL_UNPACK_BUFFER: 0x88ec, ARRAY_BUFFER, POINTS: 0,
    COPY_READ_BUFFER: 36662, STATIC_DRAW: 35044, DYNAMIC_DRAW: 35048,
    RGBA8: 0x8058, RGBA16F: 0x881a, RGBA32F: 0x8814, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401, HALF_FLOAT: 0x140b, FLOAT: 0x1406,
    TRIANGLES: 513,
    NEAREST: 0x2600, LINEAR: 0x2601, TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803, CLAMP_TO_EDGE: 0x812f,
    TEXTURE_BASE_LEVEL: 0x813c, TEXTURE_MAX_LEVEL: 0x813d,
    drawingBufferWidth: 800, drawingBufferHeight: 600,
    getExtension: (name: string) =>
      name === 'KHR_parallel_shader_compile' ? { COMPLETION_STATUS_KHR: KHR_COMPLETION_STATUS } : null,
    getParameter: () => 4096,
    isContextLost: () => false,
    createProgram: () => ({ id: ++program }),
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: (_p: unknown, pname: number) => (pname === KHR_COMPLETION_STATUS ? true : true),
    getProgramInfoLog: () => 'info-log',
    transformFeedbackVaryings: () => {},
    createShader: () => ({ id: ++shader }),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    deleteShader: () => {},
    createTransformFeedback: () => ({ id: ++tf }),
    deleteTransformFeedback: () => {},
    createVertexArray: () => ({ id: ++vao }),
    bindVertexArray: () => {},
    deleteVertexArray: () => {},
    bindTransformFeedback: () => {},
    bindBufferBase: () => {},
    beginTransformFeedback: () => {},
    endTransformFeedback: () => {},
    getAttribLocation: (_p: unknown, name: string) => (name === 'position' ? 0 : 1),
    getUniformLocation: (_p: unknown, name: string) => ({ name }),
    useProgram: (p: unknown) => calls.push(`useProgram(${(p as { id?: number } | null)?.id ?? 'null'})`),
    deleteProgram: () => {},
    uniform1f: () => {},
    uniform1i: (_loc: unknown, value: number) => calls.push(`uniform1i(${value})`),
    uniformMatrix4fv: () => calls.push('uniformMatrix4fv'),
    uniform4fv: () => calls.push('uniform4fv'),
    uniform3fv: () => calls.push('uniform3fv'),
    uniform2fv: () => calls.push('uniform2fv'),
    createBuffer: () => ({ id: ++buffer }),
    deleteBuffer: () => {},
    bindBuffer: (target: number, b: unknown) =>
      calls.push(`bindBuffer(${target === ARRAY_BUFFER ? 'ARRAY' : target},${(b as { id?: number } | null)?.id ?? 'null'})`),
    bufferData: () => {},
    bufferSubData: () => calls.push('bufferSubData'),
    getBufferSubData: () => {},
    enableVertexAttribArray: (loc: number) => calls.push(`enable(${loc})`),
    vertexAttribPointer: (loc: number, size: number) => calls.push(`pointer(${loc},${size})`),
    vertexAttribDivisor: (loc: number, d: number) => calls.push(`divisor(${loc},${d})`),
    disableVertexAttribArray: (loc: number) => calls.push(`disable(${loc})`),
    createTexture: () => ({ id: ++texture }),
    deleteTexture: () => {},
    bindTexture: (t: unknown) => calls.push(`bindTexture(${(t as { id?: number } | null)?.id ?? 'null'})`),
    activeTexture: (unit: number) => calls.push(`activeTexture(${unit})`),
    texParameteri: (target: number, pname: number, value: number) => calls.push(`texParameteri(${pname},${value})`),
    texImage2D: () => {},
    texStorage2D: () => {},
    texSubImage2D: () => calls.push('texSubImage2D'),
    pixelStorei: () => {},
    viewport: () => {},
    bindFramebuffer: () => calls.push('bindFramebuffer'),
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
    clear: () => calls.push('clear'),
    enable: () => {},
    disable: () => {},
    depthFunc: () => {},
    cullFace: () => {},
    drawArrays: (mode: number, _first: number, count: number) =>
      calls.push(`drawArrays(${mode === 0 ? 'POINTS' : mode},${count})`),
    drawArraysInstanced: (mode: number, _first: number, count: number, instances: number) =>
      calls.push(`drawArrays(${mode === 0 ? 'POINTS' : mode},${count})`),
    getError: () => 0,
  } as unknown as WebGL2RenderingContext
  return { calls, gl }
}

// ─── the vertex-bind memo ────────────────────────────────────────────────────

describe('realGL Task 165: the vertex-bind memo', () => {
  test('an identical tuple re-asserted within a pass is skipped (4 GL calls → 0)', () => {
    const { calls, gl } = glMock()
    const facade = createRealGL(gl)
    const a = facade.createBuffer(new Float32Array(12))
    calls.length = 0
    facade.bindVertexBuffer(a, 0, 3)
    const first = calls.filter(c => !c.startsWith('useProgram'))
    // the REAL bind: bindBuffer + enable + pointer + divisor + the trailing
    // ARRAY_BUFFER unbind (the Task 165 capture discipline)
    expect(first).toEqual([`bindBuffer(ARRAY,${(a as unknown as { id?: number }).id ?? 1})`, 'enable(0)', 'pointer(0,3)', 'divisor(0,0)', 'bindBuffer(ARRAY,null)'])
    calls.length = 0
    facade.bindVertexBuffer(a, 0, 3) // 100% redundant
    expect(calls.length).toBe(0)
  })

  test('a different buffer, size, stride, offset or divisor re-binds for real', () => {
    const { calls, gl } = glMock()
    const facade = createRealGL(gl)
    const a = facade.createBuffer(new Float32Array(12))
    const b = facade.createBuffer(new Float32Array(12))
    facade.bindVertexBuffer(a, 0, 3)
    calls.length = 0
    facade.bindVertexBuffer(b, 0, 3) // different buffer
    expect(calls.filter(c => c.startsWith('enable(')).length).toBe(1)
    calls.length = 0
    facade.bindVertexBuffer(b, 0, 2) // different size
    expect(calls.filter(c => c.startsWith('enable(')).length).toBe(1)
    calls.length = 0
    facade.bindVertexBuffer(b, 0, 2, 16, 0) // different stride
    expect(calls.filter(c => c.startsWith('enable(')).length).toBe(1)
    calls.length = 0
    facade.bindVertexBuffer(b, 0, 2, 16, 4) // different offset
    expect(calls.filter(c => c.startsWith('enable(')).length).toBe(1)
    calls.length = 0
    facade.bindVertexBuffer(b, 0, 2, 16, 4, 1) // different divisor
    expect(calls.filter(c => c.startsWith('enable(')).length).toBe(1)
    calls.length = 0
    facade.bindVertexBuffer(b, 0, 2, 16, 4, 1) // and the exact repeat dies again
    expect(calls.length).toBe(0)
  })

  test('the pass boundary (bindTarget) re-arms the memo — the 75b discipline', () => {
    const { calls, gl } = glMock()
    const facade = createRealGL(gl)
    const a = facade.createBuffer(new Float32Array(12))
    facade.bindVertexBuffer(a, 0, 3)
    calls.length = 0
    facade.bindTarget(0, false) // the pass start
    facade.bindVertexBuffer(a, 0, 3) // must re-assert
    expect(calls.filter(c => c.startsWith('enable(')).length).toBe(1)
    expect(calls.filter(c => c.startsWith('pointer(')).length).toBe(1)
    expect(calls.filter(c => c.startsWith('divisor(')).length).toBe(1)
  })

  test('THE FEED WIN: updateBuffer (contents-only) does NOT invalidate the memo', () => {
    const { calls, gl } = glMock()
    const facade = createRealGL(gl)
    const feed = facade.createBuffer(new Float32Array(64 * 16), 'dynamic')
    facade.bindVertexBuffer(feed, 0, 4, 64, 0, 1)
    calls.length = 0
    facade.updateBuffer(feed, new Float32Array(16)) // the per-frame record upload
    facade.bindVertexBuffer(feed, 0, 4, 64, 0, 1) // the same tuple — still skipped
    expect(calls.filter(c => c.startsWith('enable(')).length).toBe(0)
    expect(calls.filter(c => c.startsWith('bufferSubData')).length).toBe(1)
    // and the ARRAY_BUFFER discipline survives the upload path
    const arrayBinds = calls.filter(c => c.startsWith('bindBuffer(ARRAY'))
    expect(arrayBinds[arrayBinds.length - 1]).toBe('bindBuffer(ARRAY,null)')
  })

  test('deleteBuffer disarms the memoized location (the next same-tuple bind re-arms it)', () => {
    const { calls, gl } = glMock()
    const facade = createRealGL(gl)
    const a = facade.createBuffer(new Float32Array(12))
    facade.bindVertexBuffer(a, 0, 3)
    facade.deleteBuffer(a)
    calls.length = 0
    const b = facade.createBuffer(new Float32Array(12)) // a fresh id — no alias
    facade.bindVertexBuffer(b, 0, 3)
    expect(calls.filter(c => c.startsWith('enable(')).length).toBe(1)
    expect(calls.filter(c => c.startsWith('disable(')).length).toBe(0) // disarm ran at delete time
  })

  test('a transform pass does not disturb the default-VAO memo (the pass VAO is its own)', () => {
    const { calls, gl } = glMock()
    const facade = createRealGL(gl)
    const a = facade.createBuffer(new Float32Array(12), 'dynamic')
    facade.bindVertexBuffer(a, 0, 3)
    const passId = facade.createTransformPass({
      vertex: '#version 300 es\nin float a_x;\nvoid main() {}',
      outputs: ['v_x'],
    })
    facade.runTransformPass(passId, 4, { bufferId: a })
    calls.length = 0
    // the default VAO still holds the tuple — the bind is skipped
    facade.bindVertexBuffer(a, 0, 3)
    expect(calls.filter(c => c.startsWith('enable(')).length).toBe(0)
  })

  test('THE TF-CAPTURE DISCIPLINE: after every real bind the generic ARRAY_BUFFER ends EMPTY', () => {
    const { calls, gl } = glMock()
    const facade = createRealGL(gl)
    const a = facade.createBuffer(new Float32Array(12))
    facade.bindVertexBuffer(a, 0, 3)
    const arrayBinds = calls.filter(c => c.startsWith('bindBuffer(ARRAY'))
    expect(arrayBinds[arrayBinds.length - 1]).toBe('bindBuffer(ARRAY,null)')
  })
})

// ─── the sampler-unit memo ───────────────────────────────────────────────────

describe('realGL Task 165: the sampler-unit memo (setUniform1i)', () => {
  test('an unchanged (program, name, value) skips the WHOLE chain — no useProgram, no uniform1i', () => {
    const { calls, gl } = glMock()
    const facade = createRealGL(gl)
    const id = facade.createProgram(
      '#version 300 es\nvoid main() {}',
      '#version 300 es\nuniform sampler2D u_tex;\nout vec4 o;\nvoid main() { o = vec4(1.0); }',
    )
    calls.length = 0
    facade.setUniform1i(id, 'u_tex', 0)
    expect(calls.filter(c => c === 'uniform1i(0)').length).toBe(1)
    calls.length = 0
    facade.setUniform1i(id, 'u_tex', 0) // the per-draw re-assert of a steady scene
    expect(calls.length).toBe(0) // not even useProgram
  })

  test('a DIFFERENT value re-arms the memo (last-write-wins stays exact)', () => {
    const { calls, gl } = glMock()
    const facade = createRealGL(gl)
    const id = facade.createProgram(
      '#version 300 es\nvoid main() {}',
      '#version 300 es\nuniform sampler2D u_tex;\nout vec4 o;\nvoid main() { o = vec4(1.0); }',
    )
    facade.setUniform1i(id, 'u_tex', 0)
    calls.length = 0
    facade.setUniform1i(id, 'u_tex', 1)
    expect(calls.filter(c => c === 'uniform1i(1)').length).toBe(1)
    calls.length = 0
    facade.setUniform1i(id, 'u_tex', 1)
    expect(calls.length).toBe(0)
    facade.setUniform1i(id, 'u_tex', 0) // back — a real write again
    expect(calls.filter(c => c === 'uniform1i(0)').length).toBe(1)
  })

  test('a different program or name keeps independent memos', () => {
    const { calls, gl } = glMock()
    const facade = createRealGL(gl)
    const frag = '#version 300 es\nuniform sampler2D u_a;\nuniform sampler2D u_b;\nout vec4 o;\nvoid main() { o = vec4(1.0); }'
    const p1 = facade.createProgram('#version 300 es\nvoid main() {}', frag)
    const p2 = facade.createProgram('#version 300 es\nvoid main() {}', frag)
    facade.setUniform1i(p1, 'u_a', 0)
    facade.setUniform1i(p2, 'u_a', 0)
    calls.length = 0
    facade.setUniform1i(p1, 'u_a', 0) // hit
    facade.setUniform1i(p2, 'u_a', 0) // hit
    facade.setUniform1i(p1, 'u_b', 0) // miss — a different name
    expect(calls.filter(c => c === 'uniform1i(0)').length).toBe(1)
  })
})

// ─── the executor steady state ───────────────────────────────────────────────

const VERT = `#version 300 es
layout(location = 0) in vec3 position;
uniform mat4 u_mvp;
void main() { gl_Position = u_mvp * vec4(position, 1.0); }`
const FRAG = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
out vec4 o_color;
void main() { o_color = vec4(1.0); }`

describe('executor Task 165: the steady-state render pass', () => {
  test('a 2-command scene drawn twice per frame: from frame 2 on — ZERO vertex-bind and sampler-uniform GL calls, the draws land', () => {
    const { calls, gl } = glMock()
    const facade = createRealGL(gl)
    const arena = createUniformArena(1 << 12)
    const ctx = createCompileContext(arena, 'codegen')
    const tex = facade.createTexture(4, 4)
    const commands = [
      compileDrawSpec({
        shader: { glsl: { vertex: VERT, fragment: FRAG } },
        attributes: { position: { data: new Float32Array(9), size: 3 } },
        textures: { u_tex: { textureId: tex } },
        uniforms: { u_mvp: new Float32Array(16) },
        count: 3,
      }, ctx),
      compileDrawSpec({
        shader: { glsl: { vertex: VERT, fragment: FRAG } },
        attributes: { position: { data: new Float32Array(9), size: 3 } },
        textures: { u_tex: { textureId: tex } },
        uniforms: { u_mvp: new Float32Array(16) },
        count: 3,
      }, ctx),
    ]
    const executor = createExecutor({ gl: facade, arena, commands, clears: [] })
    const writer = createTapeWriter(64)
    const frame = (): void => {
      writer.reset()
      writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
      for (const command of commands) {
        command.record({}, { time: 0, dt: 1 / 60, aspect: 1 }, writer)
        command.record({}, { time: 0, dt: 1 / 60, aspect: 1 }, writer)
      }
      writer.emit(OpCode.EndPass, 0, 0, 0, 0)
      executor.run(writerView(writer))
    }
    frame() // frame 1: programs, buffers, first binds, sampler units
    calls.length = 0
    frame() // frame 2: the steady state
    // THE PINS — the scene shape: two commands own TWO different vertex
    // buffers, so each pass pays one real bind per COMMAND (the A→B switch
    // is honest — 2 enables), while the per-command REPEAT draws (4 draws =
    // A,A,B,B) and the frame-to-frame re-asserts are all gone: WITHOUT the
    // memo this frame emits 4 enables + 4 pointers + 4 divisors.
    expect(calls.filter(c => c.startsWith('enable(')).length).toBe(2)
    expect(calls.filter(c => c.startsWith('pointer(')).length).toBe(2)
    expect(calls.filter(c => c.startsWith('divisor(')).length).toBe(2)
    expect(calls.filter(c => c.startsWith('uniform1i(')).length).toBe(0)
    // the draws themselves land every frame
    expect(calls.filter(c => c === 'drawArrays(513,3)').length).toBe(4)
    // the pass boundary (bindTarget) still re-asserts the canvas FBO
    expect(calls.filter(c => c === 'bindFramebuffer').length).toBeGreaterThanOrEqual(1)
    // and frame 3 keeps the shape
    calls.length = 0
    frame()
    expect(calls.filter(c => c.startsWith('enable(')).length).toBe(2)
    expect(calls.filter(c => c === 'drawArrays(513,3)').length).toBe(4)
  })

  test('a ONE-command scene (the instancing shape): the steady-state frame has ZERO vertex machinery', () => {
    const { calls, gl } = glMock()
    const facade = createRealGL(gl)
    const arena = createUniformArena(1 << 12)
    const ctx = createCompileContext(arena, 'codegen')
    const tex = facade.createTexture(4, 4)
    const command = compileDrawSpec({
      shader: { glsl: { vertex: VERT, fragment: FRAG } },
      attributes: { position: { data: new Float32Array(9), size: 3 } },
      textures: { u_tex: { textureId: tex } },
      uniforms: { u_mvp: new Float32Array(16) },
      count: 3,
      instances: 4096,
    }, ctx)
    const executor = createExecutor({ gl: facade, arena, commands: [command], clears: [] })
    const writer = createTapeWriter(64)
    const frame = (): void => {
      writer.reset()
      writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
      command.record({}, { time: 0, dt: 1 / 60, aspect: 1 }, writer)
      writer.emit(OpCode.EndPass, 0, 0, 0, 0)
      executor.run(writerView(writer))
    }
    frame()
    calls.length = 0
    frame()
    // The honest steady state of a ONE-command scene: the vertex memo is
    // PASS-scoped (the 75b discipline — bindTarget re-arms it), so the pass
    // pays exactly ONE real bind (the first of the pass; every repeat draw,
    // every feed rebind and every samplers re-assert is gone — without the
    // memos this frame would emit the bind + uniform1i + texture rebind).
    expect(calls.filter(c => c.startsWith('enable(')).length).toBe(1)
    expect(calls.filter(c => c.startsWith('pointer(')).length).toBe(1)
    expect(calls.filter(c => c.startsWith('divisor(')).length).toBe(1)
    expect(calls.filter(c => c.startsWith('uniform1i(')).length).toBe(0)
    expect(calls.filter(c => c === 'drawArrays(513,3)').length).toBe(1)
  })
})
