import { describe, expect, it } from 'bun:test'
import { createUniformArena, createTapeWriter, writerView, OpCode } from '@rune/core'
import {
  reflectGlsl,
  resolveAttribLocations,
  compileDrawSpec,
  createCompileContext,
  createExecutor,
  createRecordingGL,
  createRealGL,
} from '../src/index.ts'

/**
 * Task 194 — THE GLSL-100 ATTRIBUTE CONTRACT.
 *
 * The root cause this task closed (found while converting the task169/174/
 * 187 pixel gates to the surface-readback channel — they had been riding
 * parity-of-blanks for months): a vertex shader declaring its inputs the
 * GLSL-100 way (`attribute vec3 position;` — legal WebGL2: no #version
 * directive = the 100 dialect) or the bare 300-es way (`in vec3 position;`
 * without a layout qualifier) reflected as ZERO attributes. The command
 * compiled attribute-less: no vertex buffers were ever created or bound,
 * every draw rasterized degenerate garbage — while the shader itself linked
 * fine and the uniforms uploaded (zero GL errors, a pure silent blank).
 *
 * The fix, pinned here:
 *   1. the reflection parses both dialects (location −1 for unqualified);
 *   2. resolveAttribLocations pins −1 to FREE slots in declaration order;
 *   3. realGL bindAttribLocation's the same pin BEFORE the link, so the
 *      driver's assignment and the executor's binds agree;
 *   4. the executor indexes bufferIds by the attribute LIST position, not
 *      by the GL location (a non-identity location set bound the wrong
 *      buffers before).
 */

const VERT_100 = `precision mediump float;
attribute vec3 position;
attribute vec3 a_color;
uniform float u_alpha;
varying vec3 v_color;
void main() { v_color = a_color; gl_Position = vec4(position.x * u_alpha, position.y, position.z, 1.0); }`

const FRAG_100 = `precision mediump float;
varying vec3 v_color;
void main() { gl_FragColor = vec4(v_color, 1.0); }`

const VERT_BARE_IN = `#version 300 es
in vec3 position;
uniform mat4 u_mvp;
void main() { gl_Position = u_mvp * vec4(position, 1.0); }`

const VERT_MIXED = `#version 300 es
layout(location = 2) in vec3 a_pos;
attribute vec3 a_color;
void main() { gl_Position = vec4(a_pos * 0.5, 1.0) ; }`

const FRAG_300 = `#version 300 es
precision mediump float;
out vec4 o_color;
void main() { o_color = vec4(1.0); }`

function fakeFrame() {
  return { time: 0, dt: 0.016, aspect: 1.5, size: [800, 600] as const }
}

function tapeOfDraws(members: ReadonlyArray<[number, number, number]>) {
  const writer = createTapeWriter(16)
  writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
  for (const [commandId, count, instances] of members) {
    writer.emit(OpCode.Draw, commandId, 0, count, instances)
  }
  writer.emit(OpCode.EndPass, 0, 0, 0, 0)
  return writerView(writer)
}

describe('Task 194 — the GLSL-100 attribute contract (the reflection layer)', () => {
  it('GLSL 100 `attribute` declarations reflect as real attributes with pinned free slots', () => {
    const r = reflectGlsl(VERT_100, FRAG_100)
    // sorted by location: position(-1→0), a_color(-1→1); u_alpha reflects too
    expect(r.attributes).toEqual([
      { name: 'position', location: 0, size: 3 },
      { name: 'a_color', location: 1, size: 3 },
    ])
    expect(r.uniforms.map(u => u.name)).toContain('u_alpha')
  })

  it('bare 300-es `in` (no layout qualifier) reflects and pins', () => {
    const r = reflectGlsl(VERT_BARE_IN, FRAG_300)
    expect(r.attributes).toEqual([{ name: 'position', location: 0, size: 3 }])
  })

  it('mixed dialects: explicit layout locations are kept, the unqualified take the free slots', () => {
    const r = reflectGlsl(VERT_MIXED, FRAG_300)
    // a_color is unqualified → the first free slot (0); a_pos keeps 2
    expect(r.attributes).toEqual([
      { name: 'a_color', location: 0, size: 3 },
      { name: 'a_pos', location: 2, size: 3 },
    ])
  })

  it('commented-out declarations do not become attributes', () => {
    const vert = `#version 300 es
// attribute vec3 ghost;
layout(location = 0) in vec3 position;
/* attribute vec3 phantom; */
void main() { gl_Position = vec4(position, 1.0); }`
    const r = reflectGlsl(vert, FRAG_300)
    expect(r.attributes.map(a => a.name)).toEqual(['position'])
  })

  it('keyword substrings (sin, inline) are not input declarations', () => {
    const vert = `#version 300 es
layout(location = 0) in vec3 position;
void main() { float s = sin(position.x); gl_Position = vec4(position + vec3(s), 1.0); }`
    const r = reflectGlsl(vert, FRAG_300)
    expect(r.attributes.map(a => a.name)).toEqual(['position'])
  })

  it('resolveAttribLocations: free slots skip the taken ones', () => {
    expect(resolveAttribLocations([{ location: -1 }, { location: 5 }, { location: -1 }]))
      .toEqual([0, 5, 1])
    expect(resolveAttribLocations([{ location: -1 }, { location: 0 }]))
      .toEqual([1, 0])
    expect(resolveAttribLocations([])).toEqual([])
  })
})

describe('Task 194 — the GLSL-100 attribute contract (the executor layer)', () => {
  it('a GLSL-100 command CREATES and BINDS its vertex buffers (the regression: zero binds before the fix)', () => {
    const { gl, calls } = createRecordingGL()
    const arena = createUniformArena(4096)
    const ctx = createCompileContext(arena, 'codegen')
    const command = compileDrawSpec({
      shader: { glsl: { vertex: VERT_100, fragment: FRAG_100 } },
      attributes: {
        position: { data: new Float32Array(9), size: 3 },
        a_color: { data: new Float32Array(9), size: 3 },
      },
      uniforms: { u_alpha: 0.9 },
      count: 3,
    }, ctx)
    const executor = createExecutor({ gl, arena, commands: ctx.commands, clears: [{ color: [0, 0, 0, 1], depth: 1 }] })
    const writer = createTapeWriter(16)
    command.record({ count: 3 }, fakeFrame(), writer) // writes the uniforms into the arena
    executor.run(writerView(writer))
    // THE pin: two vertex buffers created and bound at the pinned locations
    // 0/1 — before Task 194 this command compiled attribute-less and the
    // bind list was EMPTY (the silent-blank root cause).
    expect(calls.filter(c => c.startsWith('createBuffer(')).length).toBe(2)
    expect(calls).toContain('bindVertexBuffer(1,0,3)')
    expect(calls).toContain('bindVertexBuffer(2,1,3)')
    expect(calls).toContain('drawArrays(triangles,0,3,1)')
    expect(calls).toContain('uniform1f(u_alpha,0.9)')
  })

  it('a non-identity location set (2/5): each buffer lands at ITS attribute location, not bufferIds[location]', () => {
    const vert = `#version 300 es
layout(location = 2) in vec3 a_pos;
layout(location = 5) in vec3 a_col;
void main() { gl_Position = vec4(a_pos * a_col.x, 1.0); }`
    const { gl, calls } = createRecordingGL()
    const arena = createUniformArena(4096)
    const ctx = createCompileContext(arena, 'codegen')
    const command = compileDrawSpec({
      shader: { glsl: { vertex: vert, fragment: FRAG_300 } },
      attributes: {
        a_pos: { data: new Float32Array(9), size: 3 },
        a_col: { data: new Float32Array(9), size: 3 },
      },
      count: 3,
    }, ctx)
    const executor = createExecutor({ gl, arena, commands: ctx.commands, clears: [{ color: [0, 0, 0, 1], depth: 1 }] })
    executor.run(tapeOfDraws([[command.id, 3, 1]]))
    // bufferIds has TWO entries (positions 0/1) but the GL locations are
    // 2/5: the bind must pair bufferIds[a] with attributes[a].location.
    // The old bufferIds[location] read was undefined for both.
    expect(calls).toContain('bindVertexBuffer(1,2,3)')
    expect(calls).toContain('bindVertexBuffer(2,5,3)')
  })

  it('a GLSL-100 command records and replays through the tape (the cross-world shape)', () => {
    const { gl, calls } = createRecordingGL()
    const arena = createUniformArena(4096)
    const ctx = createCompileContext(arena, 'interpret')
    const command = compileDrawSpec({
      shader: { glsl: { vertex: VERT_100, fragment: FRAG_100 } },
      attributes: {
        position: { data: new Float32Array(9), size: 3 },
        a_color: { data: new Float32Array(9), size: 3 },
      },
      uniforms: { u_alpha: 0.9 },
      count: 3,
    }, ctx)
    const writer = createTapeWriter(16)
    command.record({ count: 3 }, fakeFrame(), writer)
    const executor = createExecutor({ gl, arena, commands: ctx.commands, clears: [{ color: [0, 0, 0, 1], depth: 1 }] })
    executor.run(writerView(writer))
    expect(calls).toContain('bindVertexBuffer(1,0,3)')
    expect(calls).toContain('drawArrays(triangles,0,3,1)')
  })
})

describe('Task 194 — the GLSL-100 attribute contract (the realGL pin)', () => {
  it('createProgram bindAttribLocation\'s the pinned locations BEFORE the link', () => {
    const calls: string[] = []
    let programCount = 0
    const gl = {
      VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30, LINK_STATUS: 0x8b82, COMPILE_STATUS: 0x8b81,
      ARRAY_BUFFER: 0x8892, STATIC_DRAW: 35044, DYNAMIC_DRAW: 35048,
      FRAMEBUFFER: 36009, TEXTURE_2D: 3553,
      getExtension: () => null,
      getParameter: () => 4096,
      isContextLost: () => false,
      getError: () => 0,
      createProgram: () => ({ id: ++programCount }),
      createShader: () => ({ id: 0 }),
      shaderSource: () => {},
      compileShader: () => {},
      getShaderParameter: () => true,
      attachShader: () => {},
      bindAttribLocation: (program: { id: number }, location: number, name: string) =>
        calls.push(`bindAttribLocation(p${program.id},${location},${name})`),
      linkProgram: (program: { id: number }) => calls.push(`linkProgram(p${program.id})`),
      getProgramParameter: () => true,
      getProgramInfoLog: () => '',
      getUniformLocation: () => ({}),
      getAttribLocation: () => 0,
      useProgram: () => {},
      createBuffer: () => ({ id: 0 }),
      bindBuffer: () => {},
      bufferData: () => {},
      getFramebufferStatus: () => 36053,
      enableVertexAttribArray: () => {},
      vertexAttribPointer: () => {},
      vertexAttribDivisor: () => {},
      bindFramebuffer: () => {},
      viewport: () => {},
      clearColor: () => {},
      clear: () => {},
      depthFunc: () => {},
      enable: () => {},
      disable: () => {},
      depthMask: () => {},
      clearDepth: () => {},
      createTexture: () => ({ id: 0 }),
      bindTexture: () => {},
      texImage2D: () => {},
      texParameteri: () => {},
      drawArrays: () => {},
      drawArraysInstanced: () => {},
      drawingBufferWidth: 256,
      drawingBufferHeight: 256,
    } as unknown as WebGL2RenderingContext
    const facade = createRealGL(gl)
    const programId = facade.createProgram(VERT_100, FRAG_100)
    // the pin: both attributes bound to their pinned slots (0/1) BEFORE
    // linkProgram — the driver's link-time assignment now AGREES with the
    // executor's binds by construction.
    const pinA = calls.indexOf('bindAttribLocation(p1,0,position)')
    const pinB = calls.indexOf('bindAttribLocation(p1,1,a_color)')
    const link = calls.indexOf('linkProgram(p1)')
    expect(pinA).toBeGreaterThanOrEqual(0)
    expect(pinB).toBeGreaterThanOrEqual(0)
    expect(link).toBeGreaterThanOrEqual(0)
    expect(pinA).toBeLessThan(link)
    expect(pinB).toBeLessThan(link)
    expect(programId).toBe(1)
  })
})
