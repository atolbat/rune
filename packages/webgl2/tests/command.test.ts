import { describe, expect, it } from 'bun:test'
import { createUniformArena } from '@rune/core'
import { createTapeWriter, writerView, OpCode } from '@rune/core'
import { compileDrawSpec, createCompileContext, createExecutor } from '../src/index.ts'
import { createRecordingGL } from '../src/index.ts'

/** The WebGL2 compiler + executor on the recorder: the full tape path. */

const VERT = `#version 300 es
layout(location = 0) in vec3 position;
uniform mat4 u_mvp;
void main() { gl_Position = u_mvp * vec4(position, 1.0); }`

const FRAG = `#version 300 es
precision mediump float;
uniform vec4 u_tint;
out vec4 o_color;
void main() { o_color = u_tint; }`

const MVP = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function fakeFrame() {
  return { time: 0, dt: 0.016, aspect: 1.5, size: [800, 600] as const }
}

describe('webgl2 tape path', () => {
  it('frame: clear → program → uniforms by name → draw', () => {
    const { gl, calls } = createRecordingGL()
    const arena = createUniformArena(4096)
    const ctx = createCompileContext(arena, 'codegen')
    const executor = createExecutor({ gl, arena, commands: ctx.commands, clears: [{ color: [0, 0, 0, 1], depth: 1 }] })
    const command = compileDrawSpec({
      shader: { glsl: { vertex: VERT, fragment: FRAG } },
      attributes: { position: { data: new Float32Array(9), size: 3 } },
      uniforms: { u_mvp: () => MVP, u_tint: [1, 0.5, 0.25, 1] },
      count: 3,
    }, ctx)

    const writer = createTapeWriter(8)
    writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
    command.record({}, fakeFrame(), writer)
    writer.emit(OpCode.EndPass, 0, 0, 0, 0)
    executor.run(writerView(writer))

    const clearAt = calls.findIndex(call => call.startsWith('clear('))
    const mvpAt = calls.indexOf('uniformMatrix4fv(u_mvp)')
    const tintAt = calls.indexOf('uniform4fv(u_tint)')
    const drawAt = calls.indexOf('drawArrays(triangles,0,3,1)')
    expect(clearAt).toBeGreaterThanOrEqual(0)
    expect(mvpAt).toBeGreaterThan(clearAt)
    expect(tintAt).toBeGreaterThan(clearAt)
    expect(drawAt).toBeGreaterThan(Math.max(mvpAt, tintAt))
  })

  it('value-compare: a clean second frame does not re-upload uniforms', () => {
    const { gl, calls } = createRecordingGL()
    const arena = createUniformArena(4096)
    const ctx = createCompileContext(arena, 'codegen')
    const executor = createExecutor({ gl, arena, commands: ctx.commands, clears: [{ color: [0, 0, 0, 1], depth: 1 }] })
    const command = compileDrawSpec({
      shader: { glsl: { vertex: VERT, fragment: FRAG } },
      attributes: { position: { data: new Float32Array(9), size: 3 } },
      uniforms: { u_mvp: () => MVP, u_tint: [1, 0.5, 0.25, 1] },
      count: 3,
    }, ctx)

    const writer = createTapeWriter(8)
    const frame = (): void => {
      writer.reset()
      writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
      command.record({}, fakeFrame(), writer)
      writer.emit(OpCode.EndPass, 0, 0, 0, 0)
      executor.run(writerView(writer))
    }
    frame()
    const afterFirst = calls.filter(call => call.startsWith('uniform')).length
    frame()
    expect(calls.filter(call => call.startsWith('uniform')).length).toBe(afterFirst) // no growth
  })

  it('textures: bindTexture + uniform1i of the unit before draw', () => {
    const { gl, calls } = createRecordingGL()
    const arena = createUniformArena(4096)
    const ctx = createCompileContext(arena, 'codegen')
    const executor = createExecutor({ gl, arena, commands: ctx.commands, clears: [{ color: [0, 0, 0, 1], depth: 1 }] })
    const FRAG_TEX = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
out vec4 o_color;
void main() { o_color = texture(u_tex, vec2(0.5)); }`
    const command = compileDrawSpec({
      shader: { glsl: { vertex: VERT, fragment: FRAG_TEX } },
      attributes: { position: { data: new Float32Array(9), size: 3 } },
      uniforms: { u_mvp: () => MVP },
      textures: { u_tex: { textureId: 7 } },
      count: 3,
    }, ctx)

    const writer = createTapeWriter(8)
    writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
    command.record({}, fakeFrame(), writer)
    writer.emit(OpCode.EndPass, 0, 0, 0, 0)
    executor.run(writerView(writer))

    expect(calls).toContain('bindTexture(7,0)')
    expect(calls).toContain('uniform1i(u_tex,0)')
    const bindAt = calls.indexOf('bindTexture(7,0)')
    const drawAt = calls.indexOf('drawArrays(triangles,0,3,1)')
    expect(bindAt).toBeLessThan(drawAt)
  })
})
