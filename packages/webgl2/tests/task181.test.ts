import { describe, expect, it } from 'bun:test'
import { createUniformArena } from '@rune/core'
import { createTapeWriter, writerView, OpCode } from '@rune/core'
import { compileDrawSpec, createCompileContext, createExecutor, createRecordingGL } from '../src/index.ts'

/**
 * Task 181 — THE INSTANCE TIER'S INDEXED QUAD (the GL dialect): the
 * billboard instanced draw is ONE indexed instanced call — the shared
 * static [0,1,2,0,2,3] pattern (6 indices) × the live instance count over
 * the 4-entry BB_CORNERS table (the Task-180 soup trick on the instance
 * records: gl_VertexID takes only the values 0..3, drawElementsInstanced
 * carries the instance divisor — 4 real VS invocations per quad instead
 * of the pre-181 six). `count` in the Draw op is the INDEX count; the
 * instance-step attributes bind with divisor 1 exactly as before.
 */

const VERT = `#version 300 es
layout(location = 0) in vec4 i_par;
uniform mat4 u_mvp;
void main() {
  const vec2 BB_CORNERS[4] = vec2[4](vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(1.0, 1.0), vec2(-1.0, 1.0));
  vec2 bbCu = BB_CORNERS[gl_VertexID];
  gl_Position = u_mvp * vec4(i_par.x * bbCu.x, i_par.x * bbCu.y, 0.0, 1.0);
}`

const FRAG = `#version 300 es
precision mediump float;
uniform vec4 u_tint;
out vec4 o_color;
void main() { o_color = u_tint; }`

const MVP = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/** The instance record feed (16 floats per record — the facade's shape). */
const RECORDS = new Float32Array(16 * 8)
/** The shared static quad pattern of ONE instanced quad (Task 181's form). */
const INSTANCE_QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3])

function setup(indices?: Uint16Array) {
  const { gl, calls } = createRecordingGL()
  const arena = createUniformArena(4096)
  const ctx = createCompileContext(arena, 'codegen')
  const command = compileDrawSpec({
    shader: { glsl: { vertex: VERT, fragment: FRAG } },
    attributes: { i_par: { data: RECORDS, size: 4, stride: 64, offset: 0, step: 'instance' } },
    uniforms: { u_mvp: () => MVP, u_tint: [1, 0.5, 0.25, 1] },
    indices: indices !== undefined ? { data: indices } : undefined,
    count: 6, // the INDEX COUNT of the shared quad pattern
    instances: 8,
  }, ctx)
  const executor = createExecutor({ gl, arena, commands: ctx.commands, clears: [{ color: [0, 0, 0, 1], depth: 1 }] })
  return { gl, calls, command, executor }
}

/** A tape of raw Draw ops over one command — (count, instances) members. */
function tapeOfDraws(members: ReadonlyArray<[number, number, number]>) {
  const writer = createTapeWriter(16)
  writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
  for (const [commandId, count, instances] of members) {
    writer.emit(OpCode.Draw, commandId, 0, count, instances)
  }
  writer.emit(OpCode.EndPass, 0, 0, 0, 0)
  return writerView(writer)
}

describe('Task 181 — the instance tier\'s indexed quad (GL)', () => {
  it('the instanced indexed draw: lazily created element buffer + drawElements(…, 6, instances, u16) — never drawArrays', () => {
    const s = setup(INSTANCE_QUAD_INDICES)
    s.executor.run(tapeOfDraws([[s.command.id, 6, 8]]))
    // the element buffer is created ONCE (the 6-index shared pattern)
    expect(s.calls.filter(c => c === 'createElementBuffer(6,u16)').length).toBe(1)
    // the indexed INSTANCED draw: count 6 (the index count), instances 8
    expect(s.calls.filter(c => /^drawElements\(\d+,6,8,u16\)$/.test(c)).length).toBe(1)
    // the classic draw NEVER fires for the indexed instance command
    expect(s.calls.filter(c => c.startsWith('drawArrays('))).toEqual([])
    // the instance attribute binds with divisor 1 (the !i suffix; this spec
    // has no external bufferId → the executor's tight-layout else-branch —
    // the real instance path passes the interleaved external buffer and
    // rides the `64@0,!i` form, pinned at the compile level in materials).
    expect(s.calls).toContain('bindVertexBuffer(1,0,4,!i)')
  })

  it('the element buffer is NOT recreated on the second frame (the per-command elementId)', () => {
    const s = setup(INSTANCE_QUAD_INDICES)
    s.executor.run(tapeOfDraws([[s.command.id, 6, 8]]))
    s.executor.run(tapeOfDraws([[s.command.id, 6, 4]]))
    expect(s.calls.filter(c => c === 'createElementBuffer(6,u16)').length).toBe(1)
    expect(s.calls.filter(c => /^drawElements\(\d+,6,8,u16\)$/.test(c)).length).toBe(1)
    expect(s.calls.filter(c => /^drawElements\(\d+,6,4,u16\)$/.test(c)).length).toBe(1)
  })

  it('a zero instance count is a verbatim no-op draw (the degenerate contract)', () => {
    const s = setup(INSTANCE_QUAD_INDICES)
    s.executor.run(tapeOfDraws([[s.command.id, 6, 0]]))
    expect(s.calls.filter(c => /^drawElements\(\d+,6,0,u16\)$/.test(c)).length).toBe(1)
  })

  it('without indices the instance command keeps the classic drawArrays(…, 6, instances) — the back-compat form', () => {
    const s = setup(undefined)
    s.executor.run(tapeOfDraws([[s.command.id, 6, 8]]))
    expect(s.calls.filter(c => c === 'drawArrays(triangles,0,6,8)').length).toBe(1)
    expect(s.calls.filter(c => c.startsWith('drawElements('))).toEqual([])
  })
})
