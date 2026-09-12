import { describe, expect, it } from 'bun:test'
import { createUniformArena, createTapeWriter, writerView, OpCode } from '@rune/core'
import { compileDrawSpec, createCompileContext, createExecutor, createRecordingGL } from '../src/index.ts'
import type { DrawSpec, GLFacade } from '../src/index.ts'

/**
 * Task 187 — THE INDEXED MULTI-DRAW TIER (the GL dialect): runs of
 * consecutive draws of the SAME indexed command collapse into ONE
 * multiDrawElementsInstanced call (the WEBGL_multi_draw elements form —
 * Task 180's exclusion lifted). The pins, mirroring task169's contract:
 *   1. the batch arithmetic (what collapses, what does not);
 *   2. THE EXPANSION PARITY — the batched call stream, expanded back into
 *      per-draw form, is IDENTICAL to the classic indexed stream;
 *   3. the cross-kind ORDER: a mixed indexed/arrays tape emits both tiers'
 *      batches in TAPE order (a pending run flushes before the other kind's
 *      prologue changes state);
 *   4. runs of one, degenerates, the u32 type, the 512 cap, and the
 *      presence contract (a facade without the method stays classic).
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

const INDICES_U16 = new Uint16Array(6 * 6)
const INDICES_U32 = new Uint32Array(6 * 6)
for (let q = 0; q < 6; q++) {
  const v = q * 4, at = q * 6
  INDICES_U16[at] = v; INDICES_U16[at + 1] = v + 1; INDICES_U16[at + 2] = v + 2
  INDICES_U16[at + 3] = v; INDICES_U16[at + 4] = v + 2; INDICES_U16[at + 5] = v + 3
  INDICES_U32.set(INDICES_U16.subarray(at, at + 6), at)
}

function setup(indices: Uint16Array | Uint32Array = INDICES_U16) {
  const { gl, calls } = createRecordingGL()
  const arena = createUniformArena(4096)
  const ctx = createCompileContext(arena, 'codegen')
  const command = compileDrawSpec({
    shader: { glsl: { vertex: VERT, fragment: FRAG } },
    attributes: { position: { data: new Float32Array(9), size: 3 } },
    uniforms: { u_mvp: () => MVP, u_tint: [1, 0.5, 0.25, 1] },
    indices: { data: indices },
    count: 36,
  }, ctx)
  const plain = compileDrawSpec({
    shader: { glsl: { vertex: VERT, fragment: FRAG } },
    attributes: { position: { data: new Float32Array(9), size: 3 } },
    uniforms: { u_mvp: () => MVP, u_tint: [1, 0.5, 0.25, 1] },
    count: 36,
  }, ctx)
  const executor = createExecutor({ gl, arena, commands: ctx.commands, clears: [{ color: [0, 0, 0, 1], depth: 1 }] })
  return { gl, calls, command, plain, executor, ctx, arena }
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

/** A facade clone with BOTH multi-draw methods removed — the classic control group. */
function classicMock(): { gl: GLFacade; calls: string[] } {
  const recording = createRecordingGL()
  const gl = { ...recording.gl } as GLFacade & { multiDrawArraysInstanced?: unknown; multiDrawElementsInstanced?: unknown }
  delete gl.multiDrawArraysInstanced
  delete gl.multiDrawElementsInstanced
  return { gl: gl as unknown as GLFacade, calls: recording.calls }
}

/** Expand `multiDrawElems(id,u16)×N[c×i@o,...]` into per-draw drawElements calls. */
function expandElementsDraws(calls: string[]): string[] {
  const out: string[] = []
  for (const call of calls) {
    const match = /^multiDrawElems\((\d+),(u16|u32)\)×(\d+)\[(.*)\]$/.exec(call)
    if (match === null) { out.push(call); continue }
    for (const part of match[4].split(',')) {
      const cut = part.indexOf('×')
      const at = part.indexOf('@')
      out.push(`drawElements(${match[1]},${part.slice(0, cut)},${part.slice(cut + 1, at)},${match[2]})`)
    }
  }
  return out
}

describe('task 187: the indexed multi-draw batch tier (GL)', () => {
  it('FOUR same-command indexed draws collapse into ONE multiDrawElems — order preserved, prologue once', () => {
    const s = setup()
    s.executor.run(tapeOfDraws([
      [s.command.id, 36, 1],
      [s.command.id, 30, 2],
      [s.command.id, 24, 3],
      [s.command.id, 18, 4],
    ]))
    const multi = s.calls.filter(c => c.startsWith('multiDrawElems('))
    expect(multi.length).toBe(1)
    expect(multi[0]).toBe('multiDrawElems(2,u16)×4[36×1@0,30×2@0,24×3@0,18×4@0]')
    expect(s.calls.filter(c => c.startsWith('drawElements(')).length).toBe(0)
    // the run's prologue ran ONCE: one program use, ONE element buffer
    expect(s.calls.filter(c => c.startsWith('useProgram')).length).toBe(1)
    expect(s.calls.filter(c => c.startsWith('createElementBuffer(')).length).toBe(1)
  })

  it('THE EXPANSION PARITY — the batched indexed stream is the classic stream, call-for-call', () => {
    const members: ReadonlyArray<[number, number, number]> = [
      [0, 36, 1], [0, 36, 2], [0, 30, 3],
      [1, 36, 1], // a different (plain) command — splits the runs
      [0, 36, 4], [0, 36, 5],
      [0, 0, 1], // a degenerate — ends the run
      [0, 36, 6],
    ]
    const membersA = members.map(([id, c, i]) => [id, c, i] as [number, number, number])
    // the batched side
    const s1 = setup()
    s1.executor.run(tapeOfDraws(membersA.map(([id, c, i]) => [id === 0 ? s1.command.id : s1.plain.id, c, i] as [number, number, number])))
    // the classic side (its own command set — fresh lazy state)
    const classic = classicMock()
    const ctx2 = createCompileContext(createUniformArena(4096), 'codegen')
    const command2 = compileDrawSpec({
      shader: { glsl: { vertex: VERT, fragment: FRAG } },
      attributes: { position: { data: new Float32Array(9), size: 3 } },
      uniforms: { u_mvp: () => MVP, u_tint: [1, 0.5, 0.25, 1] },
      indices: { data: INDICES_U16 },
      count: 36,
    }, ctx2)
    const plain2 = compileDrawSpec({
      shader: { glsl: { vertex: VERT, fragment: FRAG } },
      attributes: { position: { data: new Float32Array(9), size: 3 } },
      uniforms: { u_mvp: () => MVP, u_tint: [1, 0.5, 0.25, 1] },
      count: 36,
    }, ctx2)
    const classicExecutor = createExecutor({ gl: classic.gl, arena: createUniformArena(4096), commands: ctx2.commands, clears: [{ color: [0, 0, 0, 1], depth: 1 }] })
    classicExecutor.run(tapeOfDraws(members.map(([id, c, i]) => [id === 0 ? command2.id : plain2.id, c, i] as [number, number, number])))
    // (a) the expanded draw sequences are IDENTICAL
    const batched = expandElementsDraws(s1.calls).filter(c => c.startsWith('drawElements(') || c.startsWith('drawArrays('))
    const classicDraws = classic.calls.filter(c => c.startsWith('drawElements(') || c.startsWith('drawArrays('))
    expect(batched).toEqual(classicDraws)
    // (b) the batched NON-draw calls are a SUBSEQUENCE of the classic's
    let j = 0
    for (const call of s1.calls) {
      if (call.startsWith('drawElements(') || call.startsWith('drawArrays(') || call.startsWith('multiDraw')) continue
      while (j < classic.calls.length && classic.calls[j] !== call) j++
      expect(j < classic.calls.length).toBe(true)
      j++
    }
  })

  it('a run of length 1 rides the classic path verbatim', () => {
    const s = setup()
    s.executor.run(tapeOfDraws([[s.command.id, 36, 1]]))
    expect(s.calls.filter(c => c === 'drawElements(2,36,1,u16)').length).toBe(1)
    expect(s.calls.filter(c => c.startsWith('multiDrawElems(')).length).toBe(0)
  })

  it('a degenerate member (count 0) rides the classic no-op verbatim and ENDS the run', () => {
    const s = setup()
    s.executor.run(tapeOfDraws([
      [s.command.id, 36, 1],
      [s.command.id, 0, 1],
      [s.command.id, 36, 2],
    ]))
    // the first draw batched alone (the degenerate cannot join), the degenerate
    // classic, the last draw classic (a fresh run of one)
    expect(s.calls.filter(c => c === 'drawElements(2,0,1,u16)').length).toBe(1)
    expect(s.calls.filter(c => c === 'drawElements(2,36,2,u16)').length).toBe(1)
    expect(s.calls.filter(c => c.startsWith('multiDrawElems(')).length).toBe(0)
  })

  it('the cross-kind ORDER: a mixed tape emits both tiers\u2019 batches in TAPE order', () => {
    const s = setup()
    s.executor.run(tapeOfDraws([
      [s.command.id, 36, 1], // indexed run member 0 (pending)
      [s.command.id, 36, 2], // indexed append
      [s.plain.id, 36, 1],   // the arrays run starts — the indexed batch FLUSHES first
      [s.plain.id, 36, 2],   // arrays append
    ]))
    const idxAt = s.calls.findIndex(c => c === 'multiDrawElems(2,u16)×2[36×1@0,36×2@0]')
    const arrAt = s.calls.findIndex(c => c === 'multiDraw×2[36×1@0,36×2@0]')
    expect(idxAt).toBeGreaterThanOrEqual(0)
    expect(arrAt).toBeGreaterThanOrEqual(0)
    expect(idxAt).toBeLessThan(arrAt)
  })

  it('Uint32Array indices ride the u32 type through the batch call', () => {
    const s = setup(INDICES_U32)
    s.executor.run(tapeOfDraws([[s.command.id, 36, 1], [s.command.id, 36, 2]]))
    expect(s.calls.filter(c => c === 'multiDrawElems(2,u32)×2[36×1@0,36×2@0]').length).toBe(1)
  })

  it('the 512 cap: the 513th member starts a fresh run (the arrays tier\u2019s discipline)', () => {
    const s = setup()
    const members: [number, number, number][] = []
    for (let i = 0; i < 513; i++) members.push([s.command.id, 36, 1])
    s.executor.run(tapeOfDraws(members))
    expect(s.calls.filter(c => c.startsWith('multiDrawElems(') && c.includes('×512[')).length).toBe(1)
    expect(s.calls.filter(c => c === 'drawElements(2,36,1,u16)').length).toBe(1)
  })

  it('the kill-switch: multiDraw:false keeps indexed commands on the classic path', () => {
    const { gl, calls } = createRecordingGL()
    const arena = createUniformArena(4096)
    const ctx = createCompileContext(arena, 'codegen')
    const command = compileDrawSpec({
      shader: { glsl: { vertex: VERT, fragment: FRAG } },
      attributes: { position: { data: new Float32Array(9), size: 3 } },
      uniforms: { u_mvp: () => MVP, u_tint: [1, 0.5, 0.25, 1] },
      indices: { data: INDICES_U16 },
      count: 36,
    }, ctx)
    const executor = createExecutor({ gl, arena, commands: ctx.commands, clears: [], multiDraw: false })
    executor.run(tapeOfDraws([[command.id, 36, 1], [command.id, 36, 2]]))
    expect(calls.filter(c => c === 'drawElements(2,36,1,u16)').length).toBe(1)
    expect(calls.filter(c => c === 'drawElements(2,36,2,u16)').length).toBe(1)
    expect(calls.filter(c => c.startsWith('multiDraw')).length).toBe(0)
  })

  it('the presence contract: a facade WITHOUT the method stays classic (Task 180\u2019s behavior)', () => {
    const mock = classicMock()
    const arena = createUniformArena(4096)
    const ctx = createCompileContext(arena, 'codegen')
    const command = compileDrawSpec({
      shader: { glsl: { vertex: VERT, fragment: FRAG } },
      attributes: { position: { data: new Float32Array(9), size: 3 } },
      uniforms: { u_mvp: () => MVP, u_tint: [1, 0.5, 0.25, 1] },
      indices: { data: INDICES_U16 },
      count: 36,
    }, ctx)
    const executor = createExecutor({ gl: mock.gl, arena, commands: ctx.commands, clears: [] })
    executor.run(tapeOfDraws([[command.id, 36, 1], [command.id, 36, 2]]))
    expect(mock.calls.filter(c => c === 'drawElements(2,36,1,u16)').length).toBe(1)
    expect(mock.calls.filter(c => c === 'drawElements(2,36,2,u16)').length).toBe(1)
    expect(mock.calls.filter(c => c.startsWith('multiDraw')).length).toBe(0)
  })
})

void (setup as (indices?: Uint16Array | Uint32Array) => {
  gl: GLFacade
  calls: string[]
  command: ReturnType<typeof compileDrawSpec>
  plain: ReturnType<typeof compileDrawSpec>
  executor: ReturnType<typeof createExecutor>
  ctx: ReturnType<typeof createCompileContext>
  arena: ReturnType<typeof createUniformArena>
})
