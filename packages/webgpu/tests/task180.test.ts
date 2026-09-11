import { describe, expect, it } from 'bun:test'
import { createWgpuContext, compileWgslSpec, createRecordingGPU, createGpuExecutor } from '../src/index.ts'
import { withJournalGpu } from '../../gl/src/journalGpu.ts'
import type { WgpuDrawSpec, GPUFacade } from '../src/index.ts'
import { createSliceArena } from '../src/index.ts'
import { createTapeWriter, serializeTape, parseTape, OpCode } from '@rune/core'

/**
 * Task 180 — THE INDEX TIER (the WG dialect): the static index pattern on
 * the command spec → bindIndexBuffer (data-keyed, uploaded once) +
 * drawIndexed; `count` in the Draw op IS the index count for an indexed
 * command; an indexed command NEVER joins a multi-draw run (the run's emit
 * forms — bare draw / drawIndirectCount — are the non-indexed vocabulary).
 */

const WGSL = `
struct Params { u_mvp: mat4x4<f32>, u_tint: vec4<f32>, u_alpha: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@vertex fn vs_main(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
  return params.u_mvp * vec4<f32>(position, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4<f32> { return params.u_tint * params.u_alpha; }`

const CLEAR = [{ color: [0.1, 0.1, 0.12, 1] as const, depth: null }]

/** The quad-corner soup + the shared static index pattern (the facade's
 *  own shape: 4 verts × 9 floats per particle, [0,1,2,0,2,3] per quad). */
const SOUP = new Float32Array(4 * 4 * 9)
const INDICES_U16 = new Uint16Array(6 * 6)
const INDICES_U32 = new Uint32Array(6 * 6)
for (let q = 0; q < 6; q++) {
  const v = q * 4, at = q * 6
  INDICES_U16[at] = v; INDICES_U16[at + 1] = v + 1; INDICES_U16[at + 2] = v + 2
  INDICES_U16[at + 3] = v; INDICES_U16[at + 4] = v + 2; INDICES_U16[at + 5] = v + 3
  INDICES_U32.set(INDICES_U16.subarray(at, at + 6), at)
}

function spec(indices?: Uint16Array | Uint32Array): WgpuDrawSpec {
  return {
    shader: { wgsl: WGSL },
    pipeline: { depth: { test: 'less', write: true } },
    attributes: { position: { data: SOUP, size: 3, stride: 36, offset: 0 } },
    uniforms: { u_mvp: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    indices: indices !== undefined ? { data: indices } : undefined,
    count: () => 36, // the INDEX count when indexed
  }
}

function setup(indices?: Uint16Array | Uint32Array, withMulti = false) {
  const arena = createSliceArena(8192)
  const ctx = createWgpuContext(arena)
  const command = compileWgslSpec(spec(indices), ctx)
  const plain = indices === undefined
    ? command
    : compileWgslSpec(spec(undefined), ctx) // the non-indexed twin
  const { gpu, calls } = createRecordingGPU()
  let facade: GPUFacade = gpu
  if (withMulti) {
    // the recording multiDraw (the task174 discipline): a batch is logged
    // as multiDraw(<count x instances; …>) so the tape-level pins can see
    // exactly what the run emitted.
    facade = {
      ...gpu,
      multiDraw: (args: Uint32Array, drawCount: number) => {
        const members: string[] = []
        for (let i = 0; i < drawCount; i++) members.push(`${args[i * 4]}x${args[i * 4 + 1]}`)
        calls.push(`multiDraw(${members.join(';')})`)
        return true
      },
    }
  }
  const executor = createGpuExecutor({ gpu: facade, arena, commands: ctx.commands, clears: CLEAR })
  return { command, plain, calls, executor, facade, ctx }
}

function tapeOfDraws(commandId: number, members: ReadonlyArray<[number, number]>) {
  const writer = createTapeWriter(16)
  writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
  for (const [count, instances] of members) writer.emit(OpCode.Draw, commandId, 0, count, instances)
  writer.emit(OpCode.EndPass, 0, 0, 0, 0)
  return parseTape(serializeTape(writer))
}

describe('Task 180 — the WG index tier', () => {
  it('an indexed command binds the pattern and draws drawIndexed — never a bare draw', () => {
    const s = setup(INDICES_U16)
    s.executor.run(tapeOfDraws(s.command.id, [[36, 1]]))
    // the indexed draw pair, in order, right after the attribute binds
    expect(s.calls).toContain('bindIndexBuffer(36,u16)')
    expect(s.calls).toContain('drawIndexed(36,1)')
    // the non-indexed draw NEVER fires for an indexed command
    expect(s.calls.filter(c => c.startsWith('draw('))).toEqual([])
  })

  it('the format follows the array: Uint32Array → u32', () => {
    const s = setup(INDICES_U32)
    s.executor.run(tapeOfDraws(s.command.id, [[36, 1]]))
    expect(s.calls).toContain('bindIndexBuffer(36,u32)')
    expect(s.calls).toContain('drawIndexed(36,1)')
  })

  it('an indexed command NEVER joins a multi-draw run (the mixed tape)', () => {
    // the run's emit forms (multiDraw / bare draw) are the non-indexed
    // vocabulary — an indexed member ends the run and rides the classic
    // indexed path; the NEXT non-indexed draw starts a fresh run.
    const s = setup(INDICES_U16, true)
    const writer = createTapeWriter(16)
    writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
    // two non-indexed draws of the plain command (a batchable run)…
    writer.emit(OpCode.Draw, s.plain.id, 0, 36, 1)
    writer.emit(OpCode.Draw, s.plain.id, 0, 36, 1)
    // …the indexed command in between…
    writer.emit(OpCode.Draw, s.command.id, 0, 36, 1)
    // …and the plain command again — a NEW run's member 0.
    writer.emit(OpCode.Draw, s.plain.id, 0, 36, 1)
    writer.emit(OpCode.EndPass, 0, 0, 0, 0)
    s.executor.run(parseTape(serializeTape(writer)))
    // The indexed draw split the tape into: run 1 = the TWO pre-index
    // members (ONE multiDraw call — the indexed command can never join),
    // the indexed pair (classic, verbatim), run 2 = the post-index member
    // (a fresh run that ends lone at the tape's end — classic verbatim).
    expect(s.calls.filter(c => c === 'multiDraw(36x1;36x1)').length).toBe(1)
    expect(s.calls.filter(c => c === 'drawIndexed(36,1)').length).toBe(1)
    // the post-index lone member rides the classic bare draw (a run of one)
    expect(s.calls.filter(c => c === 'draw(36,1)').length).toBe(1)
    // and NO multiDraw ever carried the indexed member
    expect(s.calls.filter(c => c.startsWith('multiDraw(')).length).toBe(1)
  })

  it('a degenerate indexed draw (count 0) rides the classic no-op verbatim', () => {
    // the classic path's own contract (Task 174): pass.draw(0, 1) is a
    // LEGAL no-op the classic path still emits — the indexed twin keeps
    // the same verbatim behavior (drawIndexed(0, 1), no skip, no crash).
    const s = setup(INDICES_U16)
    s.executor.run(tapeOfDraws(s.command.id, [[0, 1]]))
    expect(s.calls).toContain('drawIndexed(0,1)')
    expect(s.calls.filter(c => c.startsWith('draw('))).toEqual([])
  })

  it('the wrappers forward the tier: withJournalGpu passes bindIndexBuffer + drawIndexed through', () => {
    const arena = createSliceArena(8192)
    const ctx = createWgpuContext(arena)
    const command = compileWgslSpec(spec(INDICES_U16), ctx)
    const { gpu, calls } = createRecordingGPU()
    const journaled = withJournalGpu(gpu, { resource: () => '' } as never)
    const executor = createGpuExecutor({ gpu: journaled, arena, commands: ctx.commands, clears: CLEAR })
    executor.run(tapeOfDraws(command.id, [[36, 1]]))
    // the forwarded calls land on the inner recorder verbatim
    expect(calls).toContain('bindIndexBuffer(36,u16)')
    expect(calls).toContain('drawIndexed(36,1)')
  })
})
