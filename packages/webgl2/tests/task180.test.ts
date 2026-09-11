import { describe, expect, it } from 'bun:test'
import { createUniformArena } from '@rune/core'
import { createTapeWriter, writerView, OpCode } from '@rune/core'
import { compileDrawSpec, createCompileContext, createExecutor } from '../src/index.ts'
import { createRecordingGL } from '../src/index.ts'

/**
 * Task 180 — THE INDEX TIER (the GL dialect): the static index pattern on
 * the command spec → a LAZILY created element buffer (one createElementBuffer
 * per command, re-armed by invalidate) + drawElements per draw; `count` in
 * the Draw op IS the index count; an indexed command NEVER joins a
 * multi-draw batch (multiDrawArraysInstanced is the non-indexed vocabulary).
 */

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

/** The shared static quad pattern (the facade's own: [0,1,2,0,2,3] per quad). */
const INDICES_U16 = new Uint16Array(6 * 6)
const INDICES_U32 = new Uint32Array(6 * 6)
for (let q = 0; q < 6; q++) {
  const v = q * 4, at = q * 6
  INDICES_U16[at] = v; INDICES_U16[at + 1] = v + 1; INDICES_U16[at + 2] = v + 2
  INDICES_U16[at + 3] = v; INDICES_U16[at + 4] = v + 2; INDICES_U16[at + 5] = v + 3
  INDICES_U32.set(INDICES_U16.subarray(at, at + 6), at)
}

function fakeFrame() {
  return { time: 0, dt: 0.016, aspect: 1.5, size: [800, 600] as const }
}

function setup(indices?: Uint16Array | Uint32Array) {
  const { gl, calls } = createRecordingGL()
  const arena = createUniformArena(4096)
  const ctx = createCompileContext(arena, 'codegen')
  const command = compileDrawSpec({
    shader: { glsl: { vertex: VERT, fragment: FRAG } },
    attributes: { position: { data: new Float32Array(9), size: 3 } },
    uniforms: { u_mvp: () => MVP, u_tint: [1, 0.5, 0.25, 1] },
    indices: indices !== undefined ? { data: indices } : undefined,
    count: 36, // the INDEX count when indexed
  }, ctx)
  const plain = indices === undefined
    ? command
    : compileDrawSpec({
      shader: { glsl: { vertex: VERT, fragment: FRAG } },
      attributes: { position: { data: new Float32Array(9), size: 3 } },
      uniforms: { u_mvp: () => MVP, u_tint: [1, 0.5, 0.25, 1] },
      count: 36,
    }, ctx)
  const executor = createExecutor({ gl, arena, commands: ctx.commands, clears: [{ color: [0, 0, 0, 1], depth: 1 }] })
  return { gl, calls, command, plain, executor, ctx }
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

describe('Task 180 — the GL index tier', () => {
  it('an indexed command creates the element buffer LAZILY and draws drawElements', () => {
    const s = setup(INDICES_U16)
    s.executor.run(tapeOfDraws([[s.command.id, 36, 1]]))
    // the element buffer + the indexed draw — and NO drawArrays. The
    // element id 2: the command's vertex buffer took 1, the recorder's
    // shared counter hands the element buffer the next id.
    expect(s.calls.filter(c => c.startsWith('createElementBuffer(')).length).toBe(1)
    expect(s.calls).toContain('drawElements(2,36,1,u16)')
    expect(s.calls.filter(c => c.startsWith('drawArrays('))).toEqual([])
  })

  it('the element buffer is created ONCE — the id rides the command', () => {
    const s = setup(INDICES_U16)
    s.executor.run(tapeOfDraws([[s.command.id, 36, 1], [s.command.id, 36, 1]]))
    expect(s.calls.filter(c => c.startsWith('createElementBuffer(')).length).toBe(1)
    // both frames drew indexed (the multi-draw tier does NOT absorb them)
    expect(s.calls.filter(c => c === 'drawElements(2,36,1,u16)').length).toBe(2)
  })

  it('the element type follows the array: Uint32Array → u32', () => {
    const s = setup(INDICES_U32)
    s.executor.run(tapeOfDraws([[s.command.id, 36, 1]]))
    expect(s.calls).toContain('drawElements(2,36,1,u32)')
  })

  it('an indexed command NEVER joins a multi-draw batch (the mixed tape)', () => {
    // The recordingGL arms WEBGL_multi_draw. The tape: two plain draws of
    // one command (a batchable pair), an indexed command between, a plain
    // draw after. The indexed member SPLITS the batch — the batched form
    // (multiDraw×2) can never carry it; the indexed draw is the classic
    // drawElements pair.
    const s = setup(INDICES_U16)
    s.executor.run(tapeOfDraws([
      [s.plain.id, 36, 1],
      [s.plain.id, 36, 1],
      [s.command.id, 36, 1],
      [s.plain.id, 36, 1],
    ]))
    // the pre-index pair batched (the expansion form); the post-index draw
    // is a fresh run of one — classic verbatim
    expect(s.calls.filter(c => c === 'multiDraw×2[36×1@0,36×1@0]').length).toBe(1)
    // the element id 3: plain's vertex buffer 1, indexed's vertex buffer 2
    expect(s.calls.filter(c => c === 'drawElements(3,36,1,u16)').length).toBe(1)
    expect(s.calls.filter(c => c === 'drawArrays(triangles,0,36,1)').length).toBe(1)
  })

  it('invalidate() re-arms the element buffer (the context-restore twin)', () => {
    const s = setup(INDICES_U16)
    s.executor.run(tapeOfDraws([[s.command.id, 36, 1]]))
    expect(s.calls.filter(c => c.startsWith('createElementBuffer(')).length).toBe(1)
    s.executor.invalidate?.()
    s.executor.run(tapeOfDraws([[s.command.id, 36, 1]]))
    // the restored context killed the GL objects — the element buffer is
    // re-created lazily on the next draw
    expect(s.calls.filter(c => c.startsWith('createElementBuffer(')).length).toBe(2)
  })

  it('a degenerate indexed draw (count 0) rides the classic no-op verbatim', () => {
    // the classic path's own quirk (Task 169's pin): a 0-count draw falls
    // into the non-instanced drawArrays branch — the indexed twin keeps the
    // same verbatim behavior (drawElements(0), no skip, no crash).
    const s = setup(INDICES_U16)
    s.executor.run(tapeOfDraws([[s.command.id, 0, 1]]))
    expect(s.calls.filter(c => c === 'drawElements(2,0,1,u16)').length).toBe(1)
  })
})
