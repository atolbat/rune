/**
 * Task 164 — THE STEADY-STATE PASS (GL side): the TF sort loop re-asserts
 * frame-static state ~178 times per frame (a bitonic pass + a PBO round-trip
 * per network step at 160k particles). The pins:
 *
 *   1. THE PER-FIELD UNIFORM MEMO — runTransformPass emits exactly the
 *      CHANGED uniforms (the bitonic loop moves only (k, j): 2 of ~6-8
 *      uniform calls per pass); an identical block emits NOTHING.
 *   2. THE SAMPLER-UNIT MEMO — uniform1i fires on the FIRST run only (the
 *      declaration slot i always samples unit i; program state persists).
 *   3. THE SCRATCH UPLOAD UNIT — texSubImage2DBuffer no longer kills the
 *      Task-163 unit-bind cache: the PBO bind lands on the LAST texture
 *      unit, so the next pass's bindTexture is a cache HIT.
 *   4. THE UNPACK_ALIGNMENT MIRROR — the PBO path pins 4 once; the plain
 *      byte path's pin of 1 re-arms it (both writers keep the mirror).
 *
 * The mock is the transformFeedback.test.ts recorder with bindTexture/
 * activeTexture recorded (the cache-hit assertions need the call counts).
 */

import { describe, expect, test } from 'bun:test'
import { createRealGL } from '../src/realGL.ts'

const RASTERIZER_DISCARD = 33901
const TRANSFORM_FEEDBACK = 33584
const TRANSFORM_FEEDBACK_BUFFER = 35982
const INTERLEAVED_ATTRIBS = 35980
const PIXEL_UNPACK_BUFFER = 35052
const ARRAY_BUFFER = 34962
const POINTS = 0
// MAX_TEXTURE_IMAGE_UNITS (0x8872) — the probe answers 8 → scratch unit 7
const MAX_TEXTURE_IMAGE_UNITS = 0x8872
const TEXTURE0 = 0x84c0

function mockGL(): { calls: string[]; gl: WebGL2RenderingContext } {
  const calls: string[] = []
  let program = 0
  let shader = 0
  let buffer = 0
  let texture = 0
  let tf = 0
  let vao = 0
  let currentArrayBuffer: { id?: number } | null = null
  const gl = {
    FRAMEBUFFER: 36009, FRAMEBUFFER_COMPLETE: 36053, COLOR_ATTACHMENT0: 36064, DEPTH_ATTACHMENT: 36096,
    RENDERBUFFER: 36161, DEPTH_COMPONENT16: 33189, TEXTURE_2D: 3553, DEPTH_TEST: 2929, CULL_FACE: 2884,
    LESS: 513, LEQUAL: 515, BACK: 1029, FRONT: 1028, COLOR_BUFFER_BIT: 16384, DEPTH_BUFFER_BIT: 256,
    BLEND: 3042, FUNC_ADD: 32774, ONE: 1, ZERO: 0, NONE: 0,
    UNPACK_FLIP_Y_WEBGL: 37440, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 37441, UNPACK_COLORSPACE_CONVERSION_WEBGL: 37443,
    UNPACK_ALIGNMENT: 3317,
    VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30, LINK_STATUS: 0x8b82, COMPILE_STATUS: 0x8b81,
    RASTERIZER_DISCARD, TRANSFORM_FEEDBACK, TRANSFORM_FEEDBACK_BUFFER, INTERLEAVED_ATTRIBS,
    PIXEL_UNPACK_BUFFER, ARRAY_BUFFER, POINTS,
    COPY_READ_BUFFER: 36662, STATIC_DRAW: 35044, DYNAMIC_DRAW: 35048,
    RGBA8: 0x8058, RGBA16F: 0x881a, RGBA32F: 0x8816, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401, HALF_FLOAT: 0x140b, FLOAT: 0x1406,
    NEAREST: 0x2600, LINEAR: 0x2601, TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803, CLAMP_TO_EDGE: 0x812f,
    TEXTURE_BASE_LEVEL: 0x813c, TEXTURE_MAX_LEVEL: 0x813d,
    TEXTURE0, MAX_TEXTURE_IMAGE_UNITS,
    createProgram: () => ({ id: ++program }),
    attachShader: () => {},
    linkProgram: () => calls.push('linkProgram'),
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    transformFeedbackVaryings: () => calls.push('transformFeedbackVaryings'),
    createShader: () => ({ id: ++shader }),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    deleteShader: () => {},
    getAttribLocation: () => 3,
    getUniformLocation: (_p: unknown, name: string) => ({ name }),
    useProgram: (p: unknown) => calls.push(`useProgram(${(p as { id?: number } | null)?.id ?? 'null'})`),
    createTransformFeedback: () => ({ id: ++tf }),
    deleteTransformFeedback: () => {},
    createVertexArray: () => ({ id: ++vao }),
    bindVertexArray: (v: unknown) => calls.push(`bindVertexArray(${(v as { id?: number } | null)?.id ?? 'null'})`),
    deleteVertexArray: () => {},
    bindTransformFeedback: (target: number, t: unknown) =>
      calls.push(`bindTransformFeedback(${target === TRANSFORM_FEEDBACK ? 'TF' : target},${(t as { id?: number } | null)?.id ?? 'null'})`),
    bindBufferBase: (target: number, index: number, b: unknown) =>
      calls.push(`bindBufferBase(${target === TRANSFORM_FEEDBACK_BUFFER ? 'TFB' : target},${index},${(b as { id?: number } | null)?.id ?? 'null'})`),
    beginTransformFeedback: () => calls.push('beginTransformFeedback(POINTS)'),
    endTransformFeedback: () => calls.push('endTransformFeedback'),
    createBuffer: () => ({ id: ++buffer }),
    deleteBuffer: () => {},
    bindBuffer: (target: number, b: unknown) => {
      calls.push(`bindBuffer(${target === PIXEL_UNPACK_BUFFER ? 'PBO' : target === ARRAY_BUFFER ? 'ARRAY' : target},${(b as { id?: number } | null)?.id ?? 'null'})`)
      if (target === ARRAY_BUFFER) currentArrayBuffer = b as { id?: number } | null
    },
    bufferData: () => {},
    bufferSubData: () => {},
    getBufferSubData: () => {},
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    vertexAttribDivisor: () => {},
    disableVertexAttribArray: () => {},
    createTexture: () => ({ id: ++texture }),
    bindTexture: (target: number, t: unknown) =>
      calls.push(`bindTexture(${target === 3553 ? 'TEXTURE_2D' : target},${(t as { id?: number } | null)?.id ?? 'null'})`),
    texImage2D: () => {},
    texParameteri: () => calls.push('texParameteri'),
    texSubImage2D: (target: number, level: number, x: number, y: number, w: number, h: number, format: number, type: number, offset: number | Uint8Array) =>
      calls.push(`texSubImage2D(${x},${y},${w}x${h},fmt=${format},type=${type},src=${typeof offset === 'number' ? `off${offset}` : 'array'})`),
    pixelStorei: (name: number, value: number | boolean) =>
      calls.push(`pixelStorei(${name === 3317 ? 'UNPACK_ALIGNMENT' : name},${value === true ? 1 : value === false ? 0 : value})`),
    activeTexture: (unit: number) => calls.push(`activeTexture(${unit})`),
    enable: (cap: number) => calls.push(`enable(${cap === RASTERIZER_DISCARD ? 'RASTERIZER_DISCARD' : cap})`),
    disable: (cap: number) => calls.push(`disable(${cap === RASTERIZER_DISCARD ? 'RASTERIZER_DISCARD' : cap})`),
    drawArrays: () => calls.push('drawArrays(POINTS,0,16)'),
    uniform1f: (loc: unknown, v: number) => calls.push(`uniform1f(${(loc as { name: string }).name},${v})`),
    uniform2f: (loc: unknown, a: number, b: number) => calls.push(`uniform2f(${(loc as { name: string }).name},${a},${b})`),
    uniform3f: (loc: unknown, a: number, b: number, c: number) => calls.push(`uniform3f(${(loc as { name: string }).name},${a},${b},${c})`),
    uniform4f: (loc: unknown, a: number, b: number, c: number, d: number) => calls.push(`uniform4f(${(loc as { name: string }).name},${a},${b},${c},${d})`),
    uniform1i: (loc: unknown, v: number) => calls.push(`uniform1i(${(loc as { name: string }).name},${v})`),
    deleteProgram: () => {},
    getError: () => 0,
    getExtension: () => null,
    // the facade's probe: 8 texture units → the scratch upload unit is 7
    getParameter: (pname: number) => (pname === MAX_TEXTURE_IMAGE_UNITS ? 8 : 4096),
  } as unknown as WebGL2RenderingContext
  return { calls, gl }
}

const VERT = `#version 300 es
precision highp float;
uniform highp sampler2D u_state;
uniform float u_k;
uniform float u_j;
uniform float u_count;
out vec4 v_s0;
void main() { v_s0 = vec4(u_k + u_j + u_count); }
`

describe('Task 164: the TF steady-state memos (realGL.runTransformPass)', () => {
  test('run 1 emits the full block (uniform1f ×3 + the sampler unit); run 2 with an IDENTICAL block emits NOTHING', () => {
    const { calls, gl } = mockGL()
    const facade = createRealGL(gl)
    const out = facade.createBuffer(new Float32Array(64))
    const tex = facade.createTexture(64, 4, { format: 'rgba32f' })
    const passId = facade.createTransformPass({
      vertex: VERT,
      outputs: ['v_s0'],
      textures: ['u_state'],
      uniforms: [
        { name: 'u_k', size: 1 },
        { name: 'u_j', size: 1 },
        { name: 'u_count', size: 1 },
      ],
    })
    calls.length = 0
    facade.runTransformPass(passId, 16, { bufferId: out, textures: [tex], uniformData: new Float32Array([2, 1, 8]) })
    // THE FIRST RUN: the full contract (Task 136 sampler + all uniforms)
    expect(calls.filter(c => c === 'uniform1f(u_k,2)').length).toBe(1)
    expect(calls.filter(c => c === 'uniform1f(u_j,1)').length).toBe(1)
    expect(calls.filter(c => c === 'uniform1f(u_count,8)').length).toBe(1)
    expect(calls.filter(c => c === 'uniform1i(u_state,0)').length).toBe(1)
    // ... and the pass machinery is intact
    expect(calls).toContain('enable(RASTERIZER_DISCARD)')
    expect(calls).toContain('drawArrays(POINTS,0,16)')

    // RUN 2 — the same values: ZERO uniform/texture work
    calls.length = 0
    facade.runTransformPass(passId, 16, { bufferId: out, textures: [tex], uniformData: new Float32Array([2, 1, 8]) })
    expect(calls.filter(c => c.startsWith('uniform1f(')).length).toBe(0)
    expect(calls.filter(c => c.startsWith('uniform1i(')).length).toBe(0)
    // the unit-bind cache (Task 163) holds: no bindTexture, no texParameteri
    expect(calls.filter(c => c.startsWith('bindTexture(')).length).toBe(0)
    expect(calls.filter(c => c === 'texParameteri').length).toBe(0)
    // ... but the pass itself still runs
    expect(calls).toContain('drawArrays(POINTS,0,16)')
  })

  test('THE BITONIC SHAPE — only (k, j) move: run 3 emits EXACTLY the changed uniform', () => {
    const { calls, gl } = mockGL()
    const facade = createRealGL(gl)
    const out = facade.createBuffer(new Float32Array(64))
    const tex = facade.createTexture(64, 4, { format: 'rgba32f' })
    const passId = facade.createTransformPass({
      vertex: VERT,
      outputs: ['v_s0'],
      textures: ['u_state'],
      uniforms: [
        { name: 'u_k', size: 1 },
        { name: 'u_j', size: 1 },
        { name: 'u_count', size: 1 },
      ],
    })
    facade.runTransformPass(passId, 16, { bufferId: out, textures: [tex], uniformData: new Float32Array([2, 1, 8]) })
    calls.length = 0
    // k: 2 → 4; j and count unchanged — the exact per-pass shape of the sort loop
    facade.runTransformPass(passId, 16, { bufferId: out, textures: [tex], uniformData: new Float32Array([4, 1, 8]) })
    expect(calls.filter(c => c.startsWith('uniform1f(')).length).toBe(1)
    expect(calls).toContain('uniform1f(u_k,4)')
    // j moves in the next step — same shape
    calls.length = 0
    facade.runTransformPass(passId, 16, { bufferId: out, textures: [tex], uniformData: new Float32Array([4, 2, 8]) })
    expect(calls.filter(c => c.startsWith('uniform1f(')).length).toBe(1)
    expect(calls).toContain('uniform1f(u_j,2)')
  })

  test('a length change (a different packed layout) falls back to the full emit', () => {
    const { calls, gl } = mockGL()
    const facade = createRealGL(gl)
    const out = facade.createBuffer(new Float32Array(64))
    const passId = facade.createTransformPass({
      vertex: VERT,
      outputs: ['v_s0'],
      uniforms: [
        { name: 'u_k', size: 1 },
        { name: 'u_j', size: 1 },
        { name: 'u_count', size: 1 },
      ],
    })
    facade.runTransformPass(passId, 16, { bufferId: out, uniformData: new Float32Array([2, 1, 8]) })
    calls.length = 0
    // a SHORTER array — the memo cannot assume field alignment: full emit
    // (every declaration fires; u_count reads past the array → the 0 default,
    // the Task-139 out-of-bounds contract)
    facade.runTransformPass(passId, 16, { bufferId: out, uniformData: new Float32Array([2, 1]) })
    expect(calls.filter(c => c.startsWith('uniform1f(')).length).toBe(3)
    expect(calls).toContain('uniform1f(u_count,0)')
    // and back to the full layout: full emit again (the memo was replaced)
    calls.length = 0
    facade.runTransformPass(passId, 16, { bufferId: out, uniformData: new Float32Array([2, 1, 8]) })
    expect(calls.filter(c => c.startsWith('uniform1f(')).length).toBe(3)
  })

  test('the A-B-A sort alternation: two passes keep independent memos', () => {
    const { calls, gl } = mockGL()
    const facade = createRealGL(gl)
    const out = facade.createBuffer(new Float32Array(64))
    const bitonic = facade.createTransformPass({
      vertex: VERT, outputs: ['v_s0'],
      uniforms: [{ name: 'u_k', size: 1 }, { name: 'u_j', size: 1 }],
    })
    const sortStep = facade.createTransformPass({
      vertex: VERT, outputs: ['v_s0'],
      uniforms: [{ name: 'u_k', size: 1 }, { name: 'u_j', size: 1 }],
    })
    facade.runTransformPass(bitonic, 16, { bufferId: out, uniformData: new Float32Array([2, 1]) })
    facade.runTransformPass(sortStep, 16, { bufferId: out, uniformData: new Float32Array([2, 1]) })
    calls.length = 0
    // A again, with k moved: only u_k — B's uniforms are untouched by A's memo
    facade.runTransformPass(bitonic, 16, { bufferId: out, uniformData: new Float32Array([4, 1]) })
    expect(calls.filter(c => c.startsWith('uniform1f(')).length).toBe(1)
    expect(calls).toContain('uniform1f(u_k,4)')
    // B with identical values: still nothing (B's memo is its own)
    calls.length = 0
    facade.runTransformPass(sortStep, 16, { bufferId: out, uniformData: new Float32Array([2, 1]) })
    expect(calls.filter(c => c.startsWith('uniform1f(')).length).toBe(0)
  })
})

describe('Task 164: the scratch upload unit (texSubImage2DBuffer)', () => {
  test('the PBO round-trip does NOT kill the unit-bind cache — the next bindTexture is a HIT', () => {
    const { calls, gl } = mockGL()
    const facade = createRealGL(gl)
    const tex = facade.createTexture(64, 4, { format: 'rgba32f' })
    const buf = facade.createBuffer(new Float32Array(1024))
    calls.length = 0
    facade.bindTexture(tex, 0) // a real bind (the first after createTexture)
    expect(calls.filter(c => c.startsWith('bindTexture(')).length).toBe(1)
    // the PBO round-trip (the sort loop's per-pass GPU→GPU state move)
    facade.texSubImage2DBuffer(tex, 0, 0, 64, 4, buf, 0)
    // the upload bound on the SCRATCH unit (8 units → unit 7): one bind,
    // and the ledger sees it — not the current-unit suicide of Task 163
    expect(calls.filter(c => c === `activeTexture(${TEXTURE0 + 7})`).length).toBe(1)
    expect(calls.filter(c => c.startsWith('bindTexture(')).length).toBe(2)
    // THE POINT: units 0..6 stayed mirror-valid — a re-assert of (tex, 0)
    // is a cache HIT: zero GL calls
    facade.bindTexture(tex, 0)
    expect(calls.filter(c => c.startsWith('bindTexture(')).length).toBe(2)
    expect(calls.filter(c => c === 'texParameteri').length).toBe(2) // only the first bind's LOD re-assert
  })

  test('the whole sort ITERATION profile: run → PBO round-trip → run — the second run is pure machinery', () => {
    const { calls, gl } = mockGL()
    const facade = createRealGL(gl)
    const out = facade.createBuffer(new Float32Array(1024))
    const tex = facade.createTexture(64, 4, { format: 'rgba32f' })
    const passId = facade.createTransformPass({
      vertex: VERT, outputs: ['v_s0'],
      textures: ['u_state'],
      uniforms: [{ name: 'u_k', size: 1 }, { name: 'u_j', size: 1 }, { name: 'u_count', size: 1 }],
    })
    facade.runTransformPass(passId, 16, { bufferId: out, textures: [tex], uniformData: new Float32Array([2, 1, 8]) })
    calls.length = 0
    // the network step: the pairs round-trip + the next pass with k moved
    facade.texSubImage2DBuffer(tex, 0, 0, 64, 4, out, 0)
    const afterPbo = calls.length
    facade.runTransformPass(passId, 16, { bufferId: out, textures: [tex], uniformData: new Float32Array([4, 1, 8]) })
    const secondRun = calls.slice(afterPbo)
    // the steady-state pass: exactly ONE uniform call (the moved k),
    // NO sampler re-assert, NO texture re-bind, NO useProgram churn
    expect(secondRun.filter(c => c.startsWith('uniform1f(')).length).toBe(1)
    expect(secondRun).toContain('uniform1f(u_k,4)')
    expect(secondRun.filter(c => c.startsWith('uniform1i(')).length).toBe(0)
    expect(secondRun.filter(c => c.startsWith('bindTexture(')).length).toBe(0)
    expect(secondRun.filter(c => c === 'texParameteri').length).toBe(0)
    expect(secondRun.filter(c => c.startsWith('useProgram(')).length).toBe(0)
    // the pass machinery itself is all there (the discipline is intact)
    expect(secondRun).toContain('enable(RASTERIZER_DISCARD)')
    expect(secondRun).toContain('beginTransformFeedback(POINTS)')
    expect(secondRun).toContain('drawArrays(POINTS,0,16)')
    expect(secondRun).toContain('endTransformFeedback')
    expect(secondRun).toContain('disable(RASTERIZER_DISCARD)')
    expect(secondRun).toContain('bindVertexArray(null)')
  })
})

describe('Task 164: the UNPACK_ALIGNMENT mirror', () => {
  test('repeated PBO uploads pin alignment 4 ONCE; the plain byte path re-arms it', () => {
    const { calls, gl } = mockGL()
    const facade = createRealGL(gl)
    const tex = facade.createTexture(64, 4, { format: 'rgba32f' })
    const buf = facade.createBuffer(new Float32Array(1024))
    calls.length = 0
    facade.texSubImage2DBuffer(tex, 0, 0, 64, 4, buf, 0)
    facade.texSubImage2DBuffer(tex, 0, 0, 64, 4, buf, 0)
    expect(calls.filter(c => c === 'pixelStorei(UNPACK_ALIGNMENT,4)').length).toBe(1)
    // the plain raw-byte path pins 1 (its own contract) — the mirror flips
    facade.texSubImage2D(tex, 0, 0, 4, 1, new Float32Array(4))
    expect(calls.filter(c => c === 'pixelStorei(UNPACK_ALIGNMENT,1)').length).toBe(1)
    // so the NEXT PBO upload re-pins 4 (a real state change — emitted)
    facade.texSubImage2DBuffer(tex, 0, 0, 64, 4, buf, 0)
    expect(calls.filter(c => c === 'pixelStorei(UNPACK_ALIGNMENT,4)').length).toBe(2)
  })
})
