// Task 132 — the TRANSFORM-FEEDBACK family (the GLSL twin of the WebGPU
// compute contract). Two layers are pinned here:
//   1. realGL: the exact GL call sequence + THE STATE CONTRACT —
//      RASTERIZER_DISCARD only between begin/endTransformFeedback, the TF
//      object and its buffer binding UNBOUND after the pass, the PBO
//      binding restored after texSubImage2DBuffer. The render executor
//      asserts its own state per draw; the TF family must never leave a
//      trace it does not clean up.
//   2. recordingGL: the call records (the orchestrator tests consume them).

import { describe, expect, test } from 'bun:test'
import { createRealGL } from '../src/realGL.ts'
import { createRecordingGL } from '../src/recordingGL.ts'

// The GLenums the TF family reads (spec-stable values).
const RASTERIZER_DISCARD = 0x8c50
const TRANSFORM_FEEDBACK = 0x8e22
const TRANSFORM_FEEDBACK_BUFFER = 0x8c8e
const INTERLEAVED_ATTRIBS = 0x8c8c
const PIXEL_UNPACK_BUFFER = 0x88ec
const ARRAY_BUFFER = 0x8892
const POINTS = 0

interface MockCallLog {
  readonly calls: string[]
  readonly gl: WebGL2RenderingContext
  /** program link order: the varyings submitted before each link. */
  readonly varyings: string[][]
}

function mockGL(): MockCallLog {
  const calls: string[] = []
  const varyings: string[][] = []
  let program = 0
  let shader = 0
  let buffer = 0
  let texture = 0
  let tf = 0
  let vao = 0
  let linkedProgram: unknown = null
  let currentArrayBuffer: { id?: number } | null = null
  let currentCopyReadBuffer: { id?: number; data?: Float32Array } | null = null
  const attribBindings = new Map<number, { id?: number } | null>()
  const gl = {
    // constants realGL reads
    FRAMEBUFFER: 36009, FRAMEBUFFER_COMPLETE: 36053, COLOR_ATTACHMENT0: 36064, DEPTH_ATTACHMENT: 36096,
    RENDERBUFFER: 36161, DEPTH_COMPONENT16: 33189, TEXTURE_2D: 3553, DEPTH_TEST: 2929, CULL_FACE: 2884,
    LESS: 513, LEQUAL: 515, BACK: 1029, FRONT: 1028, COLOR_BUFFER_BIT: 16384, DEPTH_BUFFER_BIT: 256,
    BLEND: 3042, FUNC_ADD: 32774, ONE: 1, ZERO: 0, NONE: 0,
    UNPACK_FLIP_Y_WEBGL: 37440, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 37441, UNPACK_COLORSPACE_CONVERSION_WEBGL: 37443,
    UNPACK_ALIGNMENT: 3317,
    VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30, LINK_STATUS: 0x8b82, COMPILE_STATUS: 0x8b81,
    RASTERIZER_DISCARD, TRANSFORM_FEEDBACK, TRANSFORM_FEEDBACK_BUFFER, INTERLEAVED_ATTRIBS,
    PIXEL_UNPACK_BUFFER, ARRAY_BUFFER, POINTS,
    // Task 140 — the usage hint + the readback path's constants
    COPY_READ_BUFFER: 36662, STATIC_DRAW: 35044, DYNAMIC_DRAW: 35048,
    RGBA8: 0x8058, RGBA16F: 0x881a, RGBA32F: 0x8816, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401, HALF_FLOAT: 0x140b, FLOAT: 0x1406,
    NEAREST: 0x2600, LINEAR: 0x2601, TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803, CLAMP_TO_EDGE: 0x812f,
    createProgram: () => ({ id: ++program }),
    attachShader: () => {},
    linkProgram: (p: unknown) => { linkedProgram = p; calls.push('linkProgram') },
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    transformFeedbackVaryings: (p: unknown, names: string[], mode: number) => {
      varyings.push([...names])
      calls.push(`transformFeedbackVaryings(${names.join('+')},${mode})`)
    },
    createShader: () => ({ id: ++shader }),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    deleteShader: () => {},
    getAttribLocation: () => 3,
    getUniformLocation: (p: unknown, name: string) => ({ name }),
    useProgram: (p: unknown) => calls.push(`useProgram(${(p as { id?: number } | null)?.id ?? 'null'})`),
    createTransformFeedback: () => ({ id: ++tf }),
    deleteTransformFeedback: (t: unknown) => calls.push(`deleteTransformFeedback(${(t as { id: number }).id})`),
    createVertexArray: () => ({ id: ++vao }),
    bindVertexArray: (v: unknown) => calls.push(`bindVertexArray(${(v as { id?: number } | null)?.id ?? 'null'})`),
    deleteVertexArray: (v: unknown) => calls.push(`deleteVertexArray(${(v as { id: number }).id})`),
    bindTransformFeedback: (target: number, t: unknown) =>
      calls.push(`bindTransformFeedback(${target === TRANSFORM_FEEDBACK ? 'TF' : target},${(t as { id?: number } | null)?.id ?? 'null'})`),
    bindBufferBase: (target: number, index: number, b: unknown) =>
      calls.push(`bindBufferBase(${target === TRANSFORM_FEEDBACK_BUFFER ? 'TFB' : target},${index},${(b as { id?: number } | null)?.id ?? 'null'})`),
    beginTransformFeedback: (mode: number) => calls.push(`beginTransformFeedback(${mode === POINTS ? 'POINTS' : mode})`),
    endTransformFeedback: () => calls.push('endTransformFeedback'),
    createBuffer: () => ({ id: ++buffer }),
    deleteBuffer: (b: unknown) => calls.push(`deleteBuffer(${(b as { id?: number }).id})`),
    bindBuffer: (target: number, b: unknown) => {
      calls.push(`bindBuffer(${target === PIXEL_UNPACK_BUFFER ? 'PBO' : target === 36662 ? 'COPY_READ' : target === ARRAY_BUFFER ? 'ARRAY' : target},${(b as { id?: number } | null)?.id ?? 'null'})`)
      if (target === ARRAY_BUFFER) currentArrayBuffer = b as { id?: number } | null
      if (target === 36662) currentCopyReadBuffer = b as { id?: number; data?: Float32Array } | null
    },
    // Task 140 — the contents ride the object (the readBuffer round-trip
    // tests); the usage lands in the call log (the hint contract).
    bufferData: (target: number, data: Float32Array, usage: number) => {
      const b = currentArrayBuffer as { id?: number; data?: Float32Array } | null
      if (b != null) b.data = data
      calls.push(`bufferData(${data.length},${usage === 35048 ? 'DYNAMIC_DRAW' : 'STATIC_DRAW'})`)
    },
    bufferSubData: () => {},
    getBufferSubData: (target: number, srcByteOffset: number, dst: Float32Array) => {
      const b = (currentCopyReadBuffer ?? null) as { id?: number; data?: Float32Array } | null
      calls.push(`getBufferSubData(${(b as { id?: number } | null)?.id ?? 'null'},${srcByteOffset},${dst.length})`)
      if (b?.data != null) {
        const src = b.data.subarray(srcByteOffset / 4, srcByteOffset / 4 + dst.length)
        dst.set(src)
      }
    },
    // Task 137 — the disarm tests' introspection: the attrib→buffer
    // associations as vertexAttribPointer captures them (the CURRENT
    // ARRAY_BUFFER binding — the GLES3 semantics; mock-level approximation,
    // one map — the ledger logic under test lives in realGL).
    VERTEX_ATTRIB_ARRAY_ENABLED: 34338,
    VERTEX_ATTRIB_ARRAY_BUFFER_BINDING: 34975,
    enableVertexAttribArray: (loc: number) => calls.push(`enableVertexAttribArray(${loc})`),
    vertexAttribPointer: (loc: number) => { attribBindings.set(loc, currentArrayBuffer) },
    vertexAttribDivisor: () => {},
    getVertexAttrib: (index: number, pname: number) =>
      pname === 34975 ? (attribBindings.get(index) ?? null) : undefined,
    disableVertexAttribArray: (loc: number) => calls.push(`disableVertexAttribArray(${loc})`),
    createTexture: () => ({ id: ++texture }),
    bindTexture: () => {},
    texImage2D: () => {},
    texParameteri: () => {},
    texSubImage2D: (target: number, level: number, x: number, y: number, w: number, h: number, format: number, type: number, offset: number | Uint8Array) =>
      calls.push(`texSubImage2D(${x},${y},${w}x${h},fmt=${format},type=${type},src=${typeof offset === 'number' ? `off${offset}` : 'array'})`),
    pixelStorei: (name: number, value: number | boolean) =>
      calls.push(`pixelStorei(${name === 3317 ? 'UNPACK_ALIGNMENT' : name},${value === true ? 1 : value === false ? 0 : value})`),
    activeTexture: () => {},
    enable: (cap: number) => calls.push(`enable(${cap === RASTERIZER_DISCARD ? 'RASTERIZER_DISCARD' : cap})`),
    disable: (cap: number) => calls.push(`disable(${cap === RASTERIZER_DISCARD ? 'RASTERIZER_DISCARD' : cap})`),
    drawArrays: (mode: number, first: number, count: number) => calls.push(`drawArrays(${mode === POINTS ? 'POINTS' : mode},${first},${count})`),
    uniform1f: (loc: unknown, v: number) => calls.push(`uniform1f(${(loc as { name: string }).name},${v})`),
    uniform2f: (loc: unknown, a: number, b: number) => calls.push(`uniform2f(${(loc as { name: string }).name},${a},${b})`),
    uniform3f: (loc: unknown, a: number, b: number, c: number) => calls.push(`uniform3f(${(loc as { name: string }).name},${a},${b},${c})`),
    uniform4f: (loc: unknown, a: number, b: number, c: number, d: number) => calls.push(`uniform4f(${(loc as { name: string }).name},${a},${b},${c},${d})`),
    uniform1i: (loc: unknown, v: number) => calls.push(`uniform1i(${(loc as { name: string }).name},${v})`),
    deleteProgram: (p: unknown) => calls.push(`deleteProgram(${(p as { id?: number }).id})`),
    getError: () => 0,
    // unused by the TF path but present for realGL's constructor probing
    getExtension: () => null,
    getParameter: () => 4096,
  } as unknown as WebGL2RenderingContext
  return { calls, gl, varyings }
}

const VERT = `#version 300 es
precision highp float;
in float a_map;
uniform highp sampler2D u_state;
uniform float u_dt;
out vec4 v_s0;
void main() { v_s0 = texelFetch(u_state, ivec2(int(a_map), 0), 0) + vec4(u_dt); }
`

describe('realGL: the transform-feedback family', () => {
  test('createTransformPass: the varyings are submitted BEFORE the link, INTERLEAVED', () => {
    const { calls, gl, varyings } = mockGL()
    const facade = createRealGL(gl)
    calls.length = 0
    facade.createTransformPass({
      vertex: VERT,
      outputs: ['v_s0'],
      attributes: [{ name: 'a_map', size: 1 }],
      textures: ['u_state'],
      uniforms: [{ name: 'u_dt', size: 1 }],
    })
    const varyingsAt = calls.findIndex(c => c.startsWith('transformFeedbackVaryings'))
    const linkAt = calls.indexOf('linkProgram')
    expect(varyingsAt).toBeGreaterThanOrEqual(0)
    expect(linkAt).toBeGreaterThan(varyingsAt)
    expect(calls[varyingsAt]).toBe(`transformFeedbackVaryings(v_s0,${INTERLEAVED_ATTRIBS})`)
    expect(varyings[0]).toEqual(['v_s0'])
  })

  test('runTransformPass: the full state contract — discard on, TF bound, POINTS drawn, everything restored', () => {
    const { calls, gl } = mockGL()
    const facade = createRealGL(gl)
    const outBuffer = facade.createBuffer(new Float32Array(64))
    const mapBuffer = facade.createBuffer(new Float32Array(64))
    const stateTex = facade.createTexture(64, 4, { format: 'rgba32f' })
    const passId = facade.createTransformPass({
      vertex: VERT,
      outputs: ['v_s0'],
      attributes: [{ name: 'a_map', size: 1, stride: 4 }],
      textures: ['u_state'],
      uniforms: [{ name: 'u_dt', size: 1 }],
    })
    calls.length = 0
    facade.runTransformPass(passId, 16, {
      bufferId: outBuffer,
      attribBuffers: [mapBuffer],
      textures: [stateTex],
      uniformData: new Float32Array([0.016]),
    })
    const seq = calls.join('\n')
    // The uniform is set while the program is active (before the pass).
    expect(seq).toContain('uniform1f(u_dt,')
    // THE PASS SEQUENCE, exactly: discard → TF bind → buffer base → begin →
    // draw → end → unbind buffer → unbind TF → un-discard.
    expect(calls).toContain('enable(RASTERIZER_DISCARD)')
    expect(calls).toContain('beginTransformFeedback(POINTS)')
    expect(calls).toContain('drawArrays(POINTS,0,16)')
    expect(calls).toContain('endTransformFeedback')
    const discardOn = calls.indexOf('enable(RASTERIZER_DISCARD)')
    const begin = calls.indexOf('beginTransformFeedback(POINTS)')
    const draw = calls.indexOf('drawArrays(POINTS,0,16)')
    const end = calls.indexOf('endTransformFeedback')
    const unbindBuf = calls.findIndex(c => c.startsWith('bindBufferBase(TFB,0,null)'))
    const unbindTf = calls.findIndex(c => c.startsWith('bindTransformFeedback(TF,null)'))
    const discardOff = calls.indexOf('disable(RASTERIZER_DISCARD)')
    expect(begin).toBeGreaterThan(discardOn)
    expect(draw).toBeGreaterThan(begin)
    expect(end).toBeGreaterThan(draw)
    expect(unbindBuf).toBeGreaterThan(end)
    expect(unbindTf).toBeGreaterThan(unbindBuf)
    expect(discardOff).toBeGreaterThan(unbindTf)
    // Task 132 — THE DEDICATED VAO: bound for the pass's duration, unbound
    // after (the renderer's default-VAO state never sees the TF family)
    const vaoBind = calls.findIndex(c => /^bindVertexArray\(\d+\)$/.test(c))
    const vaoUnbind = calls.indexOf('bindVertexArray(null)')
    expect(vaoBind).toBeGreaterThanOrEqual(0)
    expect(begin).toBeGreaterThan(vaoBind)
    expect(vaoUnbind).toBeGreaterThan(discardOff)
    // The attribute binding went through the facade's bindVertexBuffer (the
    // location from getAttribLocation, the divisor reset).
    expect(seq).toContain('bindBuffer(ARRAY,2)')
    // exactly ONE discard pair — no stray enables
    expect(calls.filter(c => c === 'enable(RASTERIZER_DISCARD)').length).toBe(1)
    expect(calls.filter(c => c === 'disable(RASTERIZER_DISCARD)').length).toBe(1)
  })

  test('runTransformPass: vertexCount 0 is a no-op (nothing touched)', () => {
    const { calls, gl } = mockGL()
    const facade = createRealGL(gl)
    const outBuffer = facade.createBuffer(new Float32Array(64))
    const passId = facade.createTransformPass({ vertex: VERT, outputs: ['v_s0'] })
    calls.length = 0
    facade.runTransformPass(passId, 0, { bufferId: outBuffer })
    expect(calls.length).toBe(0)
  })

  test('runTransformPass: unknown pass / unknown buffer throw loudly', () => {
    const { gl } = mockGL()
    const facade = createRealGL(gl)
    const outBuffer = facade.createBuffer(new Float32Array(64))
    expect(() => facade.runTransformPass(999, 4, { bufferId: outBuffer })).toThrow('no such transform pass')
    const passId = facade.createTransformPass({ vertex: VERT, outputs: ['v_s0'] })
    expect(() => facade.runTransformPass(passId, 4, { bufferId: 999 })).toThrow('no such output buffer')
  })

  test('deleteTransformPass: idempotent, disposes the TF object + the program', () => {
    const { calls, gl } = mockGL()
    const facade = createRealGL(gl)
    const passId = facade.createTransformPass({ vertex: VERT, outputs: ['v_s0'] })
    calls.length = 0
    facade.deleteTransformPass(passId)
    expect(calls.some(c => c.startsWith('deleteTransformFeedback('))).toBe(true)
    expect(calls.some(c => c.startsWith('deleteProgram('))).toBe(true)
    // idempotent
    facade.deleteTransformPass(passId)
    expect(calls.filter(c => c.startsWith('deleteTransformFeedback(')).length).toBe(1)
    expect(() => facade.runTransformPass(passId, 4, { bufferId: 1 })).toThrow('no such transform pass')
  })

  test('runTransformPass: THE SAMPLER UNITS (Task 136 — the black-screen root cause) — every declared texture sampler gets its unit via uniform1i, before the draw', () => {
    // GLSL samplers default to unit 0: a multi-texture pass (the particle
    // pack pass's u_state/u_ramp) silently sampled the WRONG texture — the
    // ramp LUT lookups read the STATE texture and the records came out as
    // garbage (the additive black screen + the full-screen white quads of
    // the WebGL2 TF tier). The fix: uniform1i(sampler, unit) per binding.
    const { calls, gl } = mockGL()
    const facade = createRealGL(gl)
    const outBuffer = facade.createBuffer(new Float32Array(64))
    const stateTex = facade.createTexture(64, 4, { format: 'rgba32f' })
    const rampTex = facade.createTexture(8, 1, { format: 'rgba32f' })
    const passId = facade.createTransformPass({
      vertex: VERT,
      outputs: ['v_s0'],
      textures: ['u_state', 'u_ramp'],
    })
    calls.length = 0
    facade.runTransformPass(passId, 4, { bufferId: outBuffer, textures: [stateTex, rampTex] })
    // BOTH samplers are pinned to their units — u_ramp to unit 1 (the bug:
    // it stayed at the default 0 and read the state texture).
    expect(calls).toContain('uniform1i(u_state,0)')
    expect(calls).toContain('uniform1i(u_ramp,1)')
    // the units are set BEFORE the TF draw (a sampler set after the draw
    // would bind the wrong texture for THIS pass).
    const rampUnit = calls.indexOf('uniform1i(u_ramp,1)')
    const draw = calls.indexOf('drawArrays(POINTS,0,4)')
    expect(draw).toBeGreaterThan(rampUnit)
    expect(rampUnit).toBeGreaterThanOrEqual(0)
  })

  test('runTransformPass: an undefined texture slot skips its sampler (partial bindings)', () => {
    const { calls, gl } = mockGL()
    const facade = createRealGL(gl)
    const outBuffer = facade.createBuffer(new Float32Array(64))
    const stateTex = facade.createTexture(64, 4, { format: 'rgba32f' })
    const passId = facade.createTransformPass({
      vertex: VERT,
      outputs: ['v_s0'],
      textures: ['u_state', 'u_ramp'],
    })
    calls.length = 0
    facade.runTransformPass(passId, 4, { bufferId: outBuffer, textures: [stateTex, undefined] })
    expect(calls).toContain('uniform1i(u_state,0)')
    expect(calls.filter(c => c === 'uniform1i(u_ramp,1)').length).toBe(0)
  })

  test('runTransformPass: THE PACKED-SLOT CONTRACT (Task 139 — the real-GPU default-path freeze) — an optimized-out uniform still advances the walk', () => {
    // The emit pass declares u_emitBase/u_emitCount but never READS them
    // (gl_VertexID drives the rows) — the GLSL compiler optimizes them out
    // and getUniformLocation returns null. The old walk `continue`d BEFORE
    // `at += u.size`, so every uniform AFTER the dead pair read floats TWO
    // SLOTS EARLY: the whole uniform block shifted and the newborn rows
    // came out as garbage (position (seed−1.5, 0, 0), life from the speed
    // row, size from the life row — the giant green quads that froze the
    // real-GPU default path at 160k). The contract: the uniform CALL is
    // skipped for a null location; the slot WALK never is.
    const { calls, gl } = mockGL()
    // the dead-uniform mock: u_deadA/u_deadB report NO location (optimized
    // out) — everything else resolves normally.
    const liveLoc = gl.getUniformLocation.bind(gl)
    ;(gl as unknown as { getUniformLocation: unknown }).getUniformLocation = (p: WebGLProgram, name: string) =>
      name === 'u_deadA' || name === 'u_deadB' ? null : liveLoc(p, name)
    const facade = createRealGL(gl)
    const outBuffer = facade.createBuffer(new Float32Array(64))
    const passId = facade.createTransformPass({
      vertex: VERT,
      outputs: ['v_s0'],
      uniforms: [
        { name: 'u_deadA', size: 1 },
        { name: 'u_deadB', size: 1 },
        { name: 'u_live1', size: 1 },
        { name: 'u_live3', size: 3 },
        { name: 'u_live4', size: 4 },
      ],
    })
    calls.length = 0
    // packed: [deadA=111, deadB=222, live1=333, live3=(4,5,6), live4=(7,8,9,10)]
    facade.runTransformPass(passId, 2, {
      bufferId: outBuffer,
      uniformData: new Float32Array([111, 222, 333, 4, 5, 6, 7, 8, 9, 10]),
    })
    // the LIVE uniforms read THEIR OWN slots — the walk advanced past the
    // dead pair (the bug: u_live1 got 111, the dead pair's first float).
    expect(calls).toContain('uniform1f(u_live1,333)')
    expect(calls).toContain('uniform3f(u_live3,4,5,6)')
    expect(calls).toContain('uniform4f(u_live4,7,8,9,10)')
    // the dead uniforms produced NO uniform call (a null location is a
    // no-op target) — and nothing crashed on them.
    expect(calls.filter(c => c.startsWith('uniform1f(u_dead')).length).toBe(0)
  })

  test('createBuffer/updateBuffer: the ARRAY_BUFFER discipline (Task 139) — the generic binding is EMPTY after the calls (a later TF capture never overlaps it)', () => {
    // WebGL2 forbids a buffer sitting on the generic ARRAY_BUFFER binding
    // at the moment bindBufferBase(TRANSFORM_FEEDBACK_BUFFER) captures it —
    // the capture raises INVALID_OPERATION and silently drops the TF write
    // on strict drivers. The facade's createBuffer used to LEAK the
    // binding (the task135 raw harness's own pinned lesson: ITS createBuffer
    // unbinds).
    const { calls, gl } = mockGL()
    const facade = createRealGL(gl)
    calls.length = 0
    const buf = facade.createBuffer(new Float32Array(16))
    expect(calls).toContain(`bindBuffer(ARRAY,${(buf as unknown as { id?: number }).id ?? 1})`)
    expect(calls).toContain('bindBuffer(ARRAY,null)')
    calls.length = 0
    facade.updateBuffer(buf, new Float32Array([1, 2, 3]))
    const lastArrayBind = calls.map((c, i) => ({ c, i })).filter(x => x.c.startsWith('bindBuffer(ARRAY,')).pop()
    expect(lastArrayBind?.c).toBe('bindBuffer(ARRAY,null)')
  })

  test('texSubImage2DBuffer: the PBO bound, the offset as the data pointer, UNPACK_ALIGNMENT pinned, the binding restored', () => {
    const { calls, gl } = mockGL()
    const facade = createRealGL(gl)
    const tex = facade.createTexture(64, 4, { format: 'rgba32f' })
    const buffer = facade.createBuffer(new Float32Array(1024))
    calls.length = 0
    facade.texSubImage2DBuffer(tex, 0, 0, 64, 4, buffer, 0)
    // the rgba32f pair: format RGBA (0x1908 = 6408), type FLOAT (0x1406 = 5126)
    expect(calls).toContain('texSubImage2D(0,0,64x4,fmt=6408,type=5126,src=off0)')
    const pboOn = calls.findIndex(c => c === 'bindBuffer(PBO,1)')
    const texAt = calls.findIndex(c => c.startsWith('texSubImage2D('))
    const pboOff = calls.findIndex(c => c === 'bindBuffer(PBO,null)')
    expect(texAt).toBeGreaterThan(pboOn)
    expect(pboOff).toBeGreaterThan(texAt)
    expect(calls).toContain('pixelStorei(UNPACK_ALIGNMENT,4)')
  })

  test('texSubImage2DBuffer: unknown texture/buffer throw', () => {
    const { gl } = mockGL()
    const facade = createRealGL(gl)
    const buffer = facade.createBuffer(new Float32Array(64))
    expect(() => facade.texSubImage2DBuffer(999, 0, 0, 4, 1, buffer)).toThrow('no such texture')
    const tex = facade.createTexture(4, 1, { format: 'rgba32f' })
    expect(() => facade.texSubImage2DBuffer(tex, 0, 0, 4, 1, 999)).toThrow('no such buffer')
  })
})

// Task 137 — THE DANGLING ENABLED ATTRIB. The live report class: "the 2nd
// WebGL run shows NO particles while the pill keeps counting" — a buffer
// deleted while its vertexAttribPointer association lives on in the DEFAULT
// VAO leaves the next drawArrays failing INVALID_OPERATION ("no buffer is
// bound to enabled attribute") — the draw is DROPPED silently on strict
// drivers (ANGLE/D3D, Vulkan GL); SwiftShader validates only a subset,
// which is why the software-GL container mostly rendered through it. The
// forensics: the GPU particle tier's records buffer sits at the 5
// instance-attribute locations; the demo-switch dispose deletes it; the
// neighbor demos' soup commands (3 locations) leave 2-4 dangling → every
// laser draw dropped for the first frames (pinned live by the VAO probe).
// The contract: deleteBuffer DISARMS every enabled location whose current
// association IS the deleted buffer (the next command's binds re-enable
// what it uses — bindVertexBuffer enables unconditionally).
describe('realGL: deleteBuffer disarms the dangling enabled attribs (Task 137)', () => {
  test('a location associated with the deleted buffer is disabled', () => {
    const { calls, gl } = mockGL()
    const facade = createRealGL(gl)
    const b = facade.createBuffer(new Float32Array(64))
    facade.bindVertexBuffer(b, 2, 4) // the executor's per-draw bind
    calls.length = 0
    facade.deleteBuffer(b)
    expect(calls).toContain('disableVertexAttribArray(2)')
    expect(calls).toContain('deleteBuffer(1)')
  })

  test('a re-pointed location survives the OLD buffer deletion (the association moved)', () => {
    const { calls, gl } = mockGL()
    const facade = createRealGL(gl)
    const b1 = facade.createBuffer(new Float32Array(64))
    const b2 = facade.createBuffer(new Float32Array(64))
    facade.bindVertexBuffer(b1, 2, 4)
    facade.bindVertexBuffer(b2, 2, 4) // the next command re-pointed loc 2
    calls.length = 0
    facade.deleteBuffer(b1) // the OLD buffer — loc 2 now lives on b2
    expect(calls.filter(c => c.startsWith('disableVertexAttribArray')).length).toBe(0)
    expect(calls).toContain('deleteBuffer(1)')
    // and the LIVE buffer's deletion disarms it
    facade.deleteBuffer(b2)
    expect(calls).toContain('disableVertexAttribArray(2)')
  })

  test('the pass-VAO locations are exempt (they die with their pass, not with deleteBuffer)', () => {
    const { calls, gl } = mockGL()
    const facade = createRealGL(gl)
    const stateTex = facade.createTexture(64, 4, { format: 'rgba32f' })
    const mapBuf = facade.createBuffer(new Float32Array(64))
    const outBuf = facade.createBuffer(new Float32Array(256))
    const passId = facade.createTransformPass({
      vertex: VERT,
      outputs: ['v_s0'],
      attributes: [{ name: 'a_map', size: 1 }], // getAttribLocation → 3 (the mock)
      textures: ['u_state'],
      uniforms: [{ name: 'u_dt', size: 1 }],
    })
    facade.runTransformPass(passId, 8, { bufferId: outBuf, attribBuffers: [mapBuf], textures: [stateTex], uniformData: new Float32Array([0.016]) })
    calls.length = 0
    facade.deleteBuffer(mapBuf) // the pass's own attribute source
    // the pass location (3) never entered the DEFAULT VAO's ledger — no disable
    expect(calls.filter(c => c.startsWith('disableVertexAttribArray')).length).toBe(0)
    expect(calls).toContain('deleteBuffer(1)')
  })

  test('multiple locations on one buffer all disarm (the instance-record layout)', () => {
    const { calls, gl } = mockGL()
    const facade = createRealGL(gl)
    const records = facade.createBuffer(new Float32Array(160))
    facade.bindVertexBuffer(records, 0, 4)
    facade.bindVertexBuffer(records, 1, 4)
    facade.bindVertexBuffer(records, 2, 4)
    calls.length = 0
    facade.deleteBuffer(records)
    expect(calls).toContain('disableVertexAttribArray(0)')
    expect(calls).toContain('disableVertexAttribArray(1)')
    expect(calls).toContain('disableVertexAttribArray(2)')
  })
})

describe('recordingGL: the transform-feedback family', () => {
  test('the records carry the pass shape + the run inputs', () => {
    const { gl, calls } = createRecordingGL()
    const passId = gl.createTransformPass({
      vertex: VERT,
      outputs: ['v_s0'],
      attributes: [{ name: 'a_map', size: 1 }],
      textures: ['u_state'],
      uniforms: [{ name: 'u_dt', size: 1 }],
    })
    expect(passId).toBe(1)
    const buffer = gl.createBuffer(new Float32Array(16))
    gl.runTransformPass(passId, 8, {
      bufferId: buffer,
      attribBuffers: [buffer],
      textures: [1],
      uniformData: new Float32Array([0.016]),
    })
    expect(calls).toContain('createTransformPass(out:1,attrs:1,tex:1,uni:1)')
    expect(calls).toContain('runTransformPass(1,8,buf:1,a:1,t:1,u:1)')
    gl.deleteTransformPass(passId)
    expect(calls).toContain('deleteTransformPass(1)')
    gl.texSubImage2DBuffer(1, 0, 0, 64, 4, buffer, 16)
    expect(calls).toContain('texSubImage2DBuffer(1,0,0,64,4,buf:1,off:16)')
  })
})

// ─── Task 140 — the usage hint + the readback surface ────────────────────

describe('realGL: Task 140 — the buffer usage hint + the readback', () => {
  test('createBuffer defaults to STATIC_DRAW; the dynamic hint maps to DYNAMIC_DRAW', () => {
    const { calls, gl } = mockGL()
    const facade = createRealGL(gl)
    facade.createBuffer(new Float32Array(8))
    facade.createBuffer(new Float32Array(8), 'dynamic')
    expect(calls).toContain('bufferData(8,STATIC_DRAW)')
    expect(calls).toContain('bufferData(8,DYNAMIC_DRAW)')
    // the ARRAY_BUFFER discipline holds for BOTH paths (the Task 139 contract)
    const tail = calls.filter(c => c.startsWith('bindBuffer(ARRAY'))
    expect(tail[tail.length - 1]).toBe('bindBuffer(ARRAY,null)')
  })

  test('readBuffer round-trips the contents through COPY_READ_BUFFER and restores the binding', () => {
    const { calls, gl } = mockGL()
    const facade = createRealGL(gl)
    const src = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8])
    const id = facade.createBuffer(src)
    const dst = new Float32Array(8)
    const ok = facade.readBuffer(id, dst)
    expect(ok).toBe(true)
    expect(Array.from(dst)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    // the read rode COPY_READ (never ARRAY — the TF-capture discipline),
    // and the binding is restored to null after the read
    expect(calls.filter(c => c.startsWith('bindBuffer(COPY_READ')).pop()).toBe('bindBuffer(COPY_READ,null)')
    expect(calls.some(c => c.startsWith('getBufferSubData('))).toBe(true)
  })

  test('readBuffer returns false for a deleted buffer (unknown, not degenerate)', () => {
    const { gl } = mockGL()
    const facade = createRealGL(gl)
    const id = facade.createBuffer(new Float32Array(4))
    facade.deleteBuffer(id)
    const dst = new Float32Array(4)
    expect(facade.readBuffer(id, dst)).toBe(false)
    expect(Array.from(dst)).toEqual([0, 0, 0, 0])
  })
})
