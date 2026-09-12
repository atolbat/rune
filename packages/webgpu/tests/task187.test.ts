import { describe, expect, it } from 'bun:test'
import { createSliceArena } from '../src/index.ts'
import { createWgpuContext, compileWgslSpec, createRecordingGPU, createGpuExecutor } from '../src/index.ts'
import type { GPUFacade } from '../src/index.ts'
import { createTapeWriter, writerView, OpCode } from '@rune/core'
import { createJournal } from '@rune/core'
import { withJournalGpu } from '../../gl/src/journalGpu.ts'

/**
 * Task 187 — THE INDEXED MULTI-DRAW TIER (the WG dialect): runs of
 * consecutive draws of the SAME indexed command now join the tier — the
 * fast-path floor (prologue once, bare drawIndexed per member) everywhere,
 * and ONE drawIndexedIndirectCount over the facade's 5-word records where
 * the browser kept the spec-dropped method. The mock pins, mirroring
 * task174's contract for the indexed vocabulary:
 *   1. THE EXPANSION PARITY — a batched run's 5-word records expand to the
 *      classic per-draw drawIndexed stream exactly (same draws, order).
 *   2. The record shape: [indexCount, instanceCount, firstIndex=0,
 *      baseVertex=0, firstInstance=0].
 *   3. A run of length 1 rides the classic path verbatim.
 *   4. THE FAST-PATH FLOOR (no multiDrawIndexed — Chrome ≤ 151's exact
 *      shape): prologue once — bindIndexBuffer ONCE per run, one drawIndexed
 *      per member (the removed binds were indexMemo no-ops on a real
 *      facade — the GPU stream is unchanged; the tier only REMOVES calls).
 *   5. The kill-switch: multiDraw: false → the per-draw classic prologue
 *      (bind+draw per member), zero batches.
 *   6. Degenerates END runs and keep their classic behavior.
 *   7. The ring-full fallback: multiDrawIndexed returns false → the classic
 *      expansion replays every member.
 *   8. The facade presence contract: withJournalGpu forwards multiDrawIndexed
 *      IFF the raw facade has it.
 */

const WGSL = `
struct Params { u_mvp: mat4x4<f32>, u_tint: vec4<f32> }
@group(0) @binding(0) var<uniform> params: Params;
@vertex fn vs_main(@location(0) i_par: vec4<f32>, @builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  var bbCorners = array<vec2<f32>, 4>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, -1.0));
  let bbCu = bbCorners[vi];
  return params.u_mvp * vec4<f32>(i_par.x * bbCu.x, i_par.x * bbCu.y, 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4<f32> { return params.u_tint; }`

const CLEAR = [{ color: [0.1, 0.1, 0.12, 1] as const, depth: null }]

const RECORDS = new Float32Array(16 * 8)
const QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3])

function indexedSpec() {
  return {
    shader: { wgsl: WGSL },
    pipeline: {} as Record<string, never>,
    attributes: { i_par: { data: RECORDS, size: 4, stride: 64, offset: 0, step: 'instance' as const } },
    uniforms: { u_mvp: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], u_tint: [1, 1, 1, 1] },
    indices: { data: QUAD_INDICES },
    count: 6,
    instances: 8,
  }
}

/** The mock facade WITH the indexed tier: records every batch's 5-word records. */
function setupMultiIndexed(options?: { failBatches?: boolean }) {
  const arena = createSliceArena(8192)
  const ctx = createWgpuContext(arena)
  const command = compileWgslSpec(indexedSpec(), ctx)
  const { gpu, calls } = createRecordingGPU()
  const batches: Array<{ records: number[][] }> = []
  const multi: GPUFacade = {
    ...gpu,
    multiDrawIndexed: (args: Uint32Array, drawCount: number) => {
      const records: number[][] = []
      for (let i = 0; i < drawCount; i++) records.push([args[i * 5], args[i * 5 + 1], args[i * 5 + 2], args[i * 5 + 3], args[i * 5 + 4]])
      batches.push({ records })
      calls.push(`multiDrawIndexed(${records.map(r => `${r[0]}x${r[1]}`).join(';')})`)
      return !options?.failBatches
    },
  }
  const executor = createGpuExecutor({ gpu: multi, arena, commands: ctx.commands, clears: CLEAR })
  return { command, calls, batches, executor, multi, ctx, commands: ctx.commands, arena }
}

function setupFloor() {
  const arena = createSliceArena(8192)
  const ctx = createWgpuContext(arena)
  const command = compileWgslSpec(indexedSpec(), ctx)
  const { gpu, calls } = createRecordingGPU() // NO multiDraw/multiDrawIndexed — Chrome 151's shape
  const executor = createGpuExecutor({ gpu, arena, commands: ctx.commands, clears: CLEAR })
  return { command, calls, executor }
}

function tapeOfDraws(members: ReadonlyArray<[number, number, number]>) {
  const writer = createTapeWriter(16)
  writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
  for (const [commandId, count, instances] of members) writer.emit(OpCode.Draw, commandId, 0, count, instances)
  writer.emit(OpCode.EndPass, 0, 0, 0, 0)
  return writerView(writer)
}

describe('Task 187 — the WG indexed multi-draw tier (the mock pins)', () => {
  it('THE EXPANSION PARITY + the 5-word record shape: the batch IS the classic drawIndexed stream', () => {
    const members: Array<[number, number]> = [[6, 1], [6, 2], [6, 4], [6, 8]]
    const on = setupMultiIndexed()
    on.executor.run(tapeOfDraws(members.map(([c, i]) => [on.command.id, c, i] as [number, number, number])))
    // ONE batch of four members, exactly the tape's draws
    expect(on.batches.length).toBe(1)
    expect(on.batches[0].records).toEqual(members.map(([c, i]) => [c, i, 0, 0, 0]))
    // all four rode the batch — zero classic draws leaked around it
    expect(on.calls.filter(c => c.startsWith('drawIndexed('))).toEqual([])
    // the classic stream: the kill-switch executor over the SAME tape
    const kill = setupMultiIndexed()
    const killExecutor = createGpuExecutor({ gpu: kill.multi, arena: createSliceArena(8192), commands: kill.commands, clears: CLEAR, multiDraw: false })
    killExecutor.run(tapeOfDraws(members.map(([c, i]) => [kill.command.id, c, i] as [number, number, number])))
    const classicDraws = kill.calls.filter(c => c.startsWith('drawIndexed('))
    expect(classicDraws).toEqual(members.map(([c, i]) => `drawIndexed(${c},${i})`))
    // the expansion parity: the batch's members ARE the classic stream's draws
    expect(on.batches[0].records.map(r => `drawIndexed(${r[0]},${r[1]})`)).toEqual(classicDraws)
  })

  it('a run of length 1 rides the classic path verbatim (bind + draw, no batch)', () => {
    const on = setupMultiIndexed()
    on.executor.run(tapeOfDraws([[on.command.id, 6, 4]]))
    expect(on.batches.length).toBe(0)
    expect(on.calls.filter(c => c === 'bindIndexBuffer(6,u16)').length).toBe(1)
    expect(on.calls.filter(c => c === 'drawIndexed(6,4)').length).toBe(1)
  })

  it('THE FAST-PATH FLOOR (no multiDrawIndexed — Chrome 151\u2019s shape): bind ONCE per run, a draw per member', () => {
    const members: Array<[number, number]> = [[6, 1], [6, 2], [6, 4]]
    const floor = setupFloor()
    floor.executor.run(tapeOfDraws(members.map(([c, i]) => [floor.command.id, c, i] as [number, number, number])))
    // the prologue ran once: ONE bind for the whole run (the removed binds
    // were indexMemo no-ops on a real facade — the GPU stream is unchanged)
    expect(floor.calls.filter(c => c === 'bindIndexBuffer(6,u16)').length).toBe(1)
    expect(floor.calls.filter(c => c === 'drawIndexed(6,1)').length).toBe(1)
    expect(floor.calls.filter(c => c === 'drawIndexed(6,2)').length).toBe(1)
    expect(floor.calls.filter(c => c === 'drawIndexed(6,4)').length).toBe(1)
    // and the prologue's pipeline asserts ran once too
    expect(floor.calls.filter(c => c === 'usePipeline(1)').length).toBe(1)
  })

  it('the kill-switch: multiDraw: false — the per-draw classic prologue, zero batches', () => {
    const members: Array<[number, number]> = [[6, 1], [6, 2]]
    const kill = setupMultiIndexed()
    const killExecutor = createGpuExecutor({ gpu: kill.multi, arena: createSliceArena(8192), commands: kill.commands, clears: CLEAR, multiDraw: false })
    killExecutor.run(tapeOfDraws(members.map(([c, i]) => [kill.command.id, c, i] as [number, number, number])))
    expect(kill.batches.length).toBe(0)
    expect(kill.calls.filter(c => c === 'bindIndexBuffer(6,u16)').length).toBe(2)
    expect(kill.calls.filter(c => c === 'drawIndexed(6,1)').length).toBe(1)
    expect(kill.calls.filter(c => c === 'drawIndexed(6,2)').length).toBe(1)
  })

  it('a degenerate member (instances 0) rides the classic no-op verbatim and ENDS the run', () => {
    const on = setupMultiIndexed()
    on.executor.run(tapeOfDraws([
      [on.command.id, 6, 1],
      [on.command.id, 6, 0],
      [on.command.id, 6, 2],
    ]))
    // the degenerate + the last draw ride classic; the first drew alone (a
    // run of one — classic too): zero batches
    expect(on.batches.length).toBe(0)
    expect(on.calls.filter(c => c === 'drawIndexed(6,0)').length).toBe(1)
    expect(on.calls.filter(c => c === 'drawIndexed(6,1)').length).toBe(1)
    expect(on.calls.filter(c => c === 'drawIndexed(6,2)').length).toBe(1)
  })

  it('the ring-full fallback: multiDrawIndexed returns false — the classic expansion replays every member', () => {
    const fail = setupMultiIndexed({ failBatches: true })
    fail.executor.run(tapeOfDraws([
      [fail.command.id, 6, 1],
      [fail.command.id, 6, 2],
      [fail.command.id, 6, 4],
    ]))
    // the batch call fired and failed; the expansion replayed all three
    expect(fail.batches.length).toBe(1)
    expect(fail.calls.filter(c => c === 'drawIndexed(6,1)').length).toBe(1)
    expect(fail.calls.filter(c => c === 'drawIndexed(6,2)').length).toBe(1)
    expect(fail.calls.filter(c => c === 'drawIndexed(6,4)').length).toBe(1)
  })

  it('the cross-kind ORDER: an indexed batch flushes BEFORE the arrays run\u2019s prologue', () => {
    const on = setupMultiIndexed()
    // a plain (non-indexed) command AFTER the indexed pair — compiled in the
    // SAME context (a fresh context restarts command ids and the ids would
    // collide — the executor resolves Draw ops through ITS OWN commands list)
    const plainCommand = compileWgslSpec({
      shader: { wgsl: WGSL },
      pipeline: {} as Record<string, never>,
      attributes: { i_par: { data: RECORDS, size: 4, stride: 64, offset: 0, step: 'instance' as const } },
      uniforms: { u_mvp: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], u_tint: [1, 1, 1, 1] },
      count: 6,
      instances: 8,
    }, on.ctx)
    on.executor.run(tapeOfDraws([
      [on.command.id, 6, 1],
      [on.command.id, 6, 2],
      [plainCommand.id, 6, 1],
      [plainCommand.id, 6, 2],
    ]))
    const idxAt = on.calls.findIndex(c => c === 'multiDrawIndexed(6x1;6x2)')
    expect(idxAt).toBeGreaterThanOrEqual(0)
    // the indexed batch emitted before the plain run's draws — the plain
    // command rides the ARRAYS floor (this mock has no arrays multiDraw),
    // and its first draw lands strictly after the indexed batch
    const plainDrawAt = on.calls.findIndex(c => c === 'draw(6,1)')
    expect(plainDrawAt).toBeGreaterThanOrEqual(0)
    expect(plainDrawAt).toBeGreaterThan(idxAt)
  })

  it('the facade presence contract: withJournalGpu forwards multiDrawIndexed IFF the raw has it', () => {
    const withMethod = setupMultiIndexed()
    const journal = createJournal()
    const wrapped = withJournalGpu(withMethod.multi, journal)
    expect(typeof (wrapped as GPUFacade & { multiDrawIndexed?: unknown }).multiDrawIndexed).toBe('function')
    // the plain recording facade has neither method — nothing forwarded
    const floorRaw = createRecordingGPU()
    const wrapped2 = withJournalGpu(floorRaw.gpu, journal)
    expect((wrapped2 as GPUFacade & { multiDrawIndexed?: unknown }).multiDrawIndexed).toBeUndefined()
  })
})
