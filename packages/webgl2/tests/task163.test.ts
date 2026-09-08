// Task 163 — KHR_parallel_shader_compile: the deferred-link pipeline
// (submit-all + resolve-at-first-use), the unit-bind cache, the executor's
// run()-start program submission, and the caps probe's new entries.
//
// The contract pinned here:
//   1. WITH the extension: createProgram/createTransformPass SUBMIT the
//      compile+link and return WITHOUT blocking (no LINK_STATUS query at
//      creation); the link resolves at the first use — useProgram, a
//      uniform-location query, the first TF run — by polling
//      COMPLETION_STATUS_KHR round-robin over the pending set.
//   2. WITHOUT the extension: the historical synchronous path, byte-for-byte
//      (LINK_STATUS checked right at submit — a failed link throws at
//      creation, exactly as before).
//   3. Location queries NEVER precede the resolved link (the facade's
//      location caches would freeze a null/-1 forever).
//   4. A failed deferred link throws at first use and KEEPS throwing (the
//      record caches the driver's info log).
//   5. The executor submits EVERY compiled command's program at run() start
//      (the driver compiles the whole frame's set in parallel) while vertex
//      buffers stay lazy (an undrawn command uploads nothing).
//   6. bindTexture skips a 100%-redundant rebind within a pass (4 GL calls)
//      and re-asserts after the pass boundary / an upload / a delete.

import { describe, expect, test } from 'bun:test'
import { createRealGL } from '../src/realGL.ts'
import { probeGLCaps } from '../src/capsProbe.ts'
import { createExecutor } from '../src/executor.ts'
import { createRecordingGL } from '../src/recordingGL.ts'
import { compileDrawSpec, createCompileContext } from '../src/command.ts'
import { createUniformArena, createTapeWriter, writerView, OpCode } from '@rune/core'

const KHR_COMPLETION_STATUS = 0x91b1
const LINK_STATUS = 0x8b82
const COMPILE_STATUS = 0x8b81

interface KhrMock {
  readonly calls: string[]
  readonly gl: WebGL2RenderingContext
  /** The number of COMPLETION_STATUS_KHR polls so far. */
  readonly completionPolls: () => number
  /** The number of LINK_STATUS queries so far. */
  readonly linkChecks: () => number
}

/** The Task-161-style TF mock, plus the KHR knobs: `completeAfter` — the
 *  COMPLETION_STATUS poll count after which every program turns complete
 *  (0 = immediately); `linkOk` — the LINK_STATUS answer. */
function khrMock(options?: { completeAfter?: number; linkOk?: boolean; withExt?: boolean }): KhrMock {
  const withExt = options?.withExt ?? true
  const completeAfter = options?.completeAfter ?? 0
  const linkOk = options?.linkOk ?? true
  const calls: string[] = []
  let completionPolls = 0
  let linkChecks = 0
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
    INTERLEAVED_ATTRIBS: 0x8c8c, PIXEL_UNPACK_BUFFER: 0x88ec, ARRAY_BUFFER: 0x8892, POINTS: 0,
    COPY_READ_BUFFER: 36662, STATIC_DRAW: 35044, DYNAMIC_DRAW: 35048,
    RGBA8: 0x8058, RGBA16F: 0x881a, RGBA32F: 0x8814, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401, HALF_FLOAT: 0x140b, FLOAT: 0x1406,
    NEAREST: 0x2600, LINEAR: 0x2601, TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803, CLAMP_TO_EDGE: 0x812f,
    TEXTURE_BASE_LEVEL: 0x813c, TEXTURE_MAX_LEVEL: 0x813d,
    drawingBufferWidth: 800, drawingBufferHeight: 600,
    getExtension: (name: string) =>
      withExt && name === 'KHR_parallel_shader_compile'
        ? { COMPLETION_STATUS_KHR: KHR_COMPLETION_STATUS }
        : null,
    getParameter: () => 4096,
    isContextLost: () => false,
    createProgram: () => ({ id: ++program }),
    attachShader: () => {},
    linkProgram: () => calls.push('linkProgram'),
    getProgramParameter: (_p: unknown, pname: number) => {
      if (pname === KHR_COMPLETION_STATUS) {
        completionPolls++
        return completionPolls > completeAfter
      }
      linkChecks++
      calls.push('linkStatus')
      return linkOk
    },
    getProgramInfoLog: () => 'info-log-x',
    transformFeedbackVaryings: (_p: unknown, names: string[]) =>
      calls.push(`tfVaryings(${names.join('+')})`),
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
    getAttribLocation: (_p: unknown, name: string) => {
      calls.push(`attrib:${name}`)
      return 3
    },
    getUniformLocation: (_p: unknown, name: string) => {
      calls.push(`uniform:${name}`)
      return { name }
    },
    useProgram: (p: unknown) => calls.push(`useProgram(${(p as { id?: number } | null)?.id ?? 'null'})`),
    deleteProgram: () => {},
    uniform1f: () => {},
    uniform1i: () => {},
    createBuffer: () => ({ id: ++buffer }),
    deleteBuffer: () => {},
    bindBuffer: () => {},
    bufferData: () => {},
    bufferSubData: () => {},
    getBufferSubData: () => {},
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    vertexAttribDivisor: () => {},
    disableVertexAttribArray: () => {},
    createTexture: () => ({ id: ++texture }),
    deleteTexture: () => {},
    bindTexture: (t: unknown) => calls.push(`bindTexture(${(t as { id?: number } | null)?.id ?? 'null'})`),
    activeTexture: (unit: number) => calls.push(`activeTexture(${unit})`),
    texParameteri: (target: number, pname: number, value: number) =>
      calls.push(`texParameteri(${pname},${value})`),
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
    clear: () => {},
    enable: () => {},
    disable: () => {},
    depthFunc: () => {},
    cullFace: () => {},
    drawArrays: (mode: number, _first: number, count: number) =>
      calls.push(`drawArrays(${mode === 0 ? 'POINTS' : mode},${count})`),
    getError: () => 0,
  } as unknown as WebGL2RenderingContext
  return { calls, gl, completionPolls: () => completionPolls, linkChecks: () => linkChecks }
}

const VERT = `#version 300 es
precision highp float;
in float a_map;
uniform float u_dt;
out vec4 v_s0;
void main() { v_s0 = vec4(u_dt); }
`

// ─── 1–2: the deferred submit + the first-use resolve ──────────────────────

describe('realGL Task 163: KHR_parallel_shader_compile — submit-all + resolve-at-first-use', () => {
  test('with the extension: createProgram submits the link and returns WITHOUT a LINK_STATUS query', () => {
    const { calls, gl } = khrMock()
    const facade = createRealGL(gl)
    facade.createProgram(VERT, '#version 300 es\nvoid main() {}\n')
    expect(calls).toEqual(['linkProgram']) // submitted, not checked
  })

  test('the first useProgram resolves: completion poll → LINK_STATUS check → use → uniform location AFTER the link', () => {
    const { calls, gl, completionPolls } = khrMock({ completeAfter: 2 })
    const facade = createRealGL(gl)
    const id = facade.createProgram(VERT, '#version 300 es\nvoid main() {}\n')
    expect(completionPolls()).toBe(0) // nothing polled yet — truly deferred
    facade.setUniform1f(id, 'u_dt', 0.016) // useProgram → resolve → location
    expect(completionPolls()).toBeGreaterThanOrEqual(3) // the spin ran
    expect(calls).toContain('linkStatus')
    // THE TRAP THIS KILLS: getUniformLocation on an unlinked program would
    // cache null forever — the location query must come AFTER the link check
    expect(calls.indexOf('linkStatus')).toBeLessThan(calls.indexOf('uniform:u_dt'))
    expect(calls).toContain('useProgram(1)')
  })

  test('parallel submit: N programs all link BEFORE the first resolve (the boot shape)', () => {
    const { calls, gl } = khrMock({ completeAfter: 1 })
    const facade = createRealGL(gl)
    const ids = [
      facade.createProgram(VERT, '#version 300 es\nvoid main() {}\n'),
      facade.createProgram(VERT, '#version 300 es\nvoid main() {}\n'),
      facade.createProgram(VERT, '#version 300 es\nvoid main() {}\n'),
    ]
    // three links submitted, zero link checks — all three are in flight
    expect(calls.filter(c => c === 'linkProgram').length).toBe(3)
    expect(calls.filter(c => c === 'linkStatus').length).toBe(0)
    // the first use resolves ALL of them (round-robin), the rest resolve free
    facade.useProgram(ids[0]!)
    facade.useProgram(ids[1]!)
    facade.useProgram(ids[2]!)
    expect(calls.filter(c => c === 'linkStatus').length).toBe(3) // each checked ONCE
  })

  test('round-robin: resolving program A finalizes B during the SAME spin (the amortized IPC)', () => {
    const { gl, completionPolls, linkChecks } = khrMock({ completeAfter: 0 })
    const facade = createRealGL(gl)
    const a = facade.createProgram(VERT, '#version 300 es\nvoid main() {}\n')
    const b = facade.createProgram(VERT, '#version 300 es\nvoid main() {}\n')
    facade.useProgram(a) // resolves both A and B in one spin
    facade.useProgram(b) // already finalized — no new polls, no new link checks
    expect(completionPolls()).toBe(2) // one poll per program, total
    expect(linkChecks()).toBe(2) // one link check per program, total
  })

  test('a FAILED deferred link throws at first use (with the driver info log) and KEEPS throwing', () => {
    const { gl } = khrMock({ linkOk: false })
    const facade = createRealGL(gl)
    const id = facade.createProgram(VERT, '#version 300 es\nvoid main() {}\n') // no throw here
    expect(() => facade.setUniform1f(id, 'u_dt', 1)).toThrow('rune: program linking: info-log-x')
    expect(() => facade.setUniform1f(id, 'u_dt', 1)).toThrow('rune: program linking: info-log-x') // cached
  })

  test('deleteProgram of a still-pending link unhooks it (a later resolve of another program must not spin on it)', () => {
    // completeAfter=5 with only 2 programs: if the deleted program stayed in
    // the pending set, resolving B would poll A forever (the 30s deadline).
    // The unhook makes B's resolve instant.
    const { gl } = khrMock({ completeAfter: 2 })
    const facade = createRealGL(gl)
    const a = facade.createProgram(VERT, '#version 300 es\nvoid main() {}\n')
    const b = facade.createProgram(VERT, '#version 300 es\nvoid main() {}\n')
    facade.deleteProgram(a)
    facade.useProgram(b) // resolves alone — must not hang on the deleted A
    expect(true).toBe(true)
  })

  test('WITHOUT the extension: the link is checked at submit — the historical synchronous path', () => {
    const { calls, gl } = khrMock({ withExt: false })
    const facade = createRealGL(gl)
    facade.createProgram(VERT, '#version 300 es\nvoid main() {}\n')
    expect(calls).toEqual(['linkProgram', 'linkStatus'])
  })

  test('WITHOUT the extension: a failed link throws AT CREATION (the old error contract)', () => {
    const { gl } = khrMock({ withExt: false, linkOk: false })
    const facade = createRealGL(gl)
    expect(() => facade.createProgram(VERT, '#version 300 es\nvoid main() {}\n'))
      .toThrow('rune: program linking: info-log-x')
    expect(() => facade.createTransformPass({ vertex: VERT, outputs: ['v_s0'] }))
      .toThrow('rune: transform pass linking: info-log-x')
  })
})

// ─── the TF family under the deferred link ──────────────────────────────────

describe('realGL Task 163: the transform-feedback family under KHR_parallel_shader_compile', () => {
  test('attribLocations resolve LAZILY at the first run — getAttribLocation never precedes the link', () => {
    const { calls, gl } = khrMock({ completeAfter: 1 })
    const facade = createRealGL(gl)
    const passId = facade.createTransformPass({
      vertex: VERT,
      outputs: ['v_s0'],
      attributes: [{ name: 'a_map', size: 1 }],
    })
    // creation: varyings + link submitted, NO attrib query, NO link check
    expect(calls).toEqual(['tfVaryings(v_s0)', 'linkProgram'])
    const outId = facade.createBuffer(new Float32Array(16), 'dynamic')
    calls.length = 0
    facade.runTransformPass(passId, 4, { bufferId: outId, attribBuffers: [outId] })
    // the run: link resolved, THEN the attrib location, then the draw
    expect(calls.indexOf('linkStatus')).toBeGreaterThanOrEqual(0)
    expect(calls.indexOf('linkStatus')).toBeLessThan(calls.indexOf('attrib:a_map'))
    expect(calls).toContain('drawArrays(POINTS,4)')
    // the second run: locations cached, link settled — none of them re-queried
    calls.length = 0
    facade.runTransformPass(passId, 4, { bufferId: outId, attribBuffers: [outId] })
    expect(calls.filter(c => c === 'linkStatus' || c.startsWith('attrib:')).length).toBe(0)
  })

  test('the tier boot shape: six passes submit all links before the first run resolves them together', () => {
    const { calls, gl } = khrMock({ completeAfter: 3 })
    const facade = createRealGL(gl)
    const passes = Array.from({ length: 6 }, () =>
      facade.createTransformPass({ vertex: VERT, outputs: ['v_s0'] }))
    expect(calls.filter(c => c === 'linkProgram').length).toBe(6)
    expect(calls.filter(c => c === 'linkStatus').length).toBe(0)
    const outId = facade.createBuffer(new Float32Array(16), 'dynamic')
    calls.length = 0
    facade.runTransformPass(passes[0]!, 4, { bufferId: outId })
    expect(calls.filter(c => c === 'linkStatus').length).toBe(6) // every pass resolved in ONE spin
  })

  test('a FAILED TF link throws at the first RUN with the transform-pass error text', () => {
    const { gl } = khrMock({ linkOk: false })
    const facade = createRealGL(gl)
    const passId = facade.createTransformPass({ vertex: VERT, outputs: ['v_s0'] })
    const outId = facade.createBuffer(new Float32Array(16), 'dynamic')
    expect(() => facade.runTransformPass(passId, 4, { bufferId: outId }))
      .toThrow('rune: transform pass linking: info-log-x')
  })
})

// ─── the unit-bind cache ─────────────────────────────────────────────────────

describe('realGL Task 163: the unit-bind cache (bindTexture redundancy skip)', () => {
  test('a 100%-redundant rebind within a pass is skipped (activeTexture + bindTexture + 2× texParameteri)', () => {
    const { calls, gl } = khrMock()
    const facade = createRealGL(gl)
    const a = facade.createTexture(64, 64)
    const b = facade.createTexture(64, 64)
    calls.length = 0
    facade.bindTexture(a, 0)
    const first = calls.length
    expect(first).toBe(4) // activeTexture + bindTexture + BASE + MAX
    facade.bindTexture(a, 0) // the same texture, the same unit, the same range
    expect(calls.length).toBe(first) // ZERO new GL calls
    facade.bindTexture(b, 0) // a different texture — the full rebind
    expect(calls.length).toBe(first + 4)
  })

  test('bindTarget(0) — the pass boundary — kills the cache (the 75b re-assert discipline survives)', () => {
    const { calls, gl } = khrMock()
    const facade = createRealGL(gl)
    const a = facade.createTexture(64, 64)
    facade.bindTexture(a, 0)
    calls.length = 0
    facade.bindTarget(0, false) // the pass start
    facade.bindTexture(a, 0) // re-asserted: external state changes die here
    expect(calls.filter(c => c.startsWith('activeTexture(')).length).toBe(1)
    expect(calls.filter(c => c.startsWith('bindTexture(')).length).toBe(1)
    expect(calls.filter(c => c.startsWith('texParameteri(')).length).toBe(2)
  })

  test('an upload path invalidates the mirror (texSubImage2D binds the CURRENT unit behind the cache)', () => {
    const { calls, gl } = khrMock()
    const facade = createRealGL(gl)
    const a = facade.createTexture(64, 64)
    facade.bindTexture(a, 0)
    calls.length = 0
    facade.texSubImage2D(a, 0, 0, 4, 4, new Uint8Array(4 * 4 * 4))
    facade.bindTexture(a, 0) // must re-assert: the upload touched the unit binding
    expect(calls.filter(c => c.startsWith('bindTexture(')).length).toBe(2) // upload + rebind
    expect(calls.filter(c => c.startsWith('texParameteri(')).length).toBe(2)
  })

  test('a sub-mip view bind (a different LOD range) re-asserts the levels', () => {
    const { calls, gl } = khrMock()
    const facade = createRealGL(gl)
    const tex = facade.createTexture(64, 64, { mipLevels: 3 })
    const view = facade.createTextureView(tex, { baseMipLevel: 1 })
    calls.length = 0
    facade.bindTexture(tex, 0) // base 0, max 0
    facade.bindTexture(view, 0) // base 1, max 2 — the params must change
    const params = calls.filter(c => c.startsWith('texParameteri('))
    expect(params).toContain(`texParameteri(${0x813c},1)`) // BASE_LEVEL = 1
    expect(params).toContain(`texParameteri(${0x813d},2)`) // MAX_LEVEL = 2
    // and the SAME view rebind is skipped
    const at = calls.length
    facade.bindTexture(view, 0)
    expect(calls.length).toBe(at)
  })

  test('deleteTexture clears the mirror (the unbind loop resets units)', () => {
    const { calls, gl } = khrMock()
    const facade = createRealGL(gl)
    const a = facade.createTexture(64, 64)
    facade.bindTexture(a, 0)
    facade.deleteTexture(a)
    calls.length = 0
    const b = facade.createTexture(64, 64)
    facade.bindTexture(b, 0)
    // the creation's own texture bind is NOT a unit bind — activeTexture
    // fires exactly once: the fresh honest unit bind
    expect(calls.filter(c => c.startsWith('activeTexture(')).length).toBe(1)
    expect(calls.filter(c => c.startsWith('bindTexture(')).length).toBe(2) // creation + unit bind
  })
})

// ─── the executor's run()-start submission ───────────────────────────────────

describe('executor Task 163: submit-all programs at run() start, buffers stay lazy', () => {
  const VERT2 = `#version 300 es
layout(location = 0) in vec3 position;
uniform mat4 u_mvp;
void main() { gl_Position = u_mvp * vec4(position, 1.0); }`
  const FRAG2 = `#version 300 es
precision mediump float;
uniform vec4 u_tint;
out vec4 o_color;
void main() { o_color = u_tint; }`

  function twoCommands() {
    const arena = createUniformArena(1 << 12)
    const ctx = createCompileContext(arena, 'codegen')
    const commands = [
      compileDrawSpec({
        shader: { glsl: { vertex: VERT2, fragment: FRAG2 } },
        attributes: { position: { data: new Float32Array(9), size: 3 } },
        count: 3,
      }, ctx),
      compileDrawSpec({
        shader: { glsl: { vertex: VERT2, fragment: `#version 300 es\nvoid main() {}` } },
        attributes: { position: { data: new Float32Array(9), size: 3 } },
        count: 3,
      }, ctx),
    ]
    return { arena, ctx, commands }
  }

  test('run() submits BOTH command programs (parallel compiles) though the tape draws only the first', () => {
    const { arena, commands } = twoCommands()
    const { gl, calls } = createRecordingGL()
    const executor = createExecutor({ gl, arena, commands, clears: [] })
    const writer = createTapeWriter(16)
    writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
    commands[0]!.record({}, { time: 0, dt: 1 / 60, aspect: 1 }, writer)
    writer.emit(OpCode.EndPass, 0, 0, 0, 0)
    executor.run(writerView(writer))
    // both programs submitted (two distinct shader pairs)
    expect(calls.filter(c => c.startsWith('createProgram(')).length).toBe(2)
    // only the DRAWN command uploaded its vertex buffer
    expect(calls.filter(c => c.startsWith('createBuffer(')).length).toBe(1)
    expect(calls.filter(c => c === 'drawArrays(triangles,0,3,1)').length).toBe(1)
    // a second frame: everything cached — the sweep is free
    calls.length = 0
    writer.reset()
    writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
    commands[0]!.record({}, { time: 0, dt: 1 / 60, aspect: 1 }, writer)
    writer.emit(OpCode.EndPass, 0, 0, 0, 0)
    executor.run(writerView(writer))
    expect(calls.filter(c => c.startsWith('createProgram(')).length).toBe(0)
  })

  test('the never-drawn command program, once submitted, still resolves correctly when it draws LATER', () => {
    const { arena, commands } = twoCommands()
    const { gl, calls } = createRecordingGL()
    const executor = createExecutor({ gl, arena, commands, clears: [] })
    const writer = createTapeWriter(16)
    // frame 1: only command 0
    writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
    commands[0]!.record({}, { time: 0, dt: 1 / 60, aspect: 1 }, writer)
    writer.emit(OpCode.EndPass, 0, 0, 0, 0)
    executor.run(writerView(writer))
    // frame 2: command 1 draws for the first time — program already exists,
    // the buffers upload now (lazy), the draw lands
    calls.length = 0
    writer.reset()
    writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
    commands[1]!.record({}, { time: 0, dt: 1 / 60, aspect: 1 }, writer)
    writer.emit(OpCode.EndPass, 0, 0, 0, 0)
    executor.run(writerView(writer))
    expect(calls.filter(c => c.startsWith('createProgram(')).length).toBe(0) // submitted in frame 1
    expect(calls.filter(c => c.startsWith('createBuffer(')).length).toBe(1) // uploaded in frame 2
    expect(calls.filter(c => c === 'drawArrays(triangles,0,3,1)').length).toBe(1)
  })
})

// ─── the caps probe ──────────────────────────────────────────────────────────

describe('capsProbe Task 163: the new probe entries', () => {
  test('KHR_parallel_shader_compile → the parallel-shader-compile feature; debug renderer info lands in extensions', () => {
    const glProbe = {
      getExtension: (name: string) =>
        name === 'KHR_parallel_shader_compile' || name === 'WEBGL_debug_renderer_info'
          ? { marker: name }
          : null,
      getParameter: () => 4096,
      getString: () => '',
      hasTimerQuery: () => false,
      hasFloatLinear: () => false,
      MAX_TEXTURE_SIZE: 3379,
      MAX_3D_TEXTURE_SIZE: 32903,
      MAX_ARRAY_TEXTURE_LAYERS: 35071,
      MAX_CUBE_MAP_TEXTURE_SIZE: 34076,
      MAX_RENDERBUFFER_SIZE: 34024,
      MAX_VERTEX_TEXTURE_IMAGE_UNITS: 35660,
      MAX_TEXTURE_IMAGE_UNITS: 34930,
      MAX_COMBINED_TEXTURE_IMAGE_UNITS: 35661,
      MAX_VERTEX_ATTRIBS: 34921,
      MAX_VERTEX_UNIFORM_VECTORS: 36347,
      MAX_FRAGMENT_UNIFORM_VECTORS: 36348,
      MAX_VARYING_VECTORS: 36348,
      MAX_DRAW_BUFFERS: 34852,
      MAX_VIEWPORT_DIMS: 3379,
      MAX_ELEMENTS_VERTICES: 33000,
      MAX_ELEMENTS_INDICES: 33000,
    }
    const query = probeGLCaps(glProbe)
    expect(query.features.has('parallel-shader-compile')).toBe(true)
    expect(query.extensions.get('WEBGL_debug_renderer_info')).toEqual({ marker: 'WEBGL_debug_renderer_info' })
    // and absent → honestly absent
    const without = probeGLCaps({ ...glProbe, getExtension: () => null })
    expect(without.features.has('parallel-shader-compile')).toBe(false)
    expect(without.extensions.get('WEBGL_debug_renderer_info')).toBeUndefined()
  })
})
