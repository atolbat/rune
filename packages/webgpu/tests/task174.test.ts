import { describe, expect, it } from 'bun:test'
import { createWgpuContext, compileWgslSpec, createRecordingGPU, createGpuExecutor } from '../src/index.ts'
import type { WgpuDrawSpec, GPUFacade } from '../src/index.ts'
import { createSliceArena } from '../src/index.ts'
import { createTapeWriter, serializeTape, parseTape, OpCode } from '@rune/core'
import { createJournal } from '@rune/core'
import { withJournalGpu } from '../../gl/src/journalGpu.ts'

/**
 * Task 174 — THE MULTI-DRAW TIER (the WG dialect). The mock pins, mirroring
 * packages/webgl2/tests/task169.test.ts (the GL tier's discipline):
 *
 *   1. THE EXPANSION PARITY — a batched run's multiDraw args expand to the
 *      classic per-draw stream exactly (same draws, same order).
 *   2. A run of length 1 rides the classic path verbatim.
 *   3. Cross-command runs stay classic (no cross-command merge).
 *   4. Non-Draw ops (BeginPass/EndPass/BindTarget) break runs — the pending
 *      batch emits BEFORE the boundary op.
 *   5. Degenerates (count 0 / instances 0) END runs and keep their classic
 *      behavior (pass.draw(count, 0) verbatim).
 *   6. The 512 cap: 600 draws → 512 + 88 (two batches).
 *   7. The kill-switch: multiDraw: false → the classic stream, zero batches,
 *      even with a capable facade.
 *   8. THE FAST-PATH FLOOR (a facade WITHOUT multiDraw — Chrome 151's exact
 *      shape): the call stream is byte-identical to the kill-switch's —
 *      the floor can only skip memo checks, never change a GPU call. The
 *      tape-end flush must not double-draw (the first draft's bug).
 *   9. The facade presence contract: withJournalGpu forwards multiDraw IFF
 *      the raw facade has it (the Task-169 GL lesson — a dropped method
 *      silently disarms, a stub silently eats draws).
 *  10. The ring-full fallback: a multiDraw that returns false → the classic
 *      expansion replays every member.
 */

const WGSL = `
struct Params { u_mvp: mat4x4<f32>, u_tint: vec4<f32>, u_alpha: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@vertex fn vs_main(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
  return params.u_mvp * vec4<f32>(position, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4<f32> { return params.u_tint * params.u_alpha; }`

const CLEAR = [{ color: [0.1, 0.1, 0.12, 1] as const, depth: null }]

function makeSpec(): WgpuDrawSpec {
  return {
    shader: { wgsl: WGSL },
    pipeline: { depth: { test: 'less', write: true } },
    uniforms: { u_mvp: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    count: () => 3,
  }
}

/** A tape of raw Draw ops over one command — (count, instances) pairs are
 * the run's members; the exact multi-draw shape (a repeated command). */
function tapeOfDraws(commandId: number, members: ReadonlyArray<[number, number]>) {
  const writer = createTapeWriter(16)
  writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
  for (const [count, instances] of members) {
    writer.emit(OpCode.Draw, commandId, 0, count, instances)
  }
  writer.emit(OpCode.EndPass, 0, 0, 0, 0)
  return parseTape(serializeTape(writer))
}

/** The mock facade WITH the tier's indirect shape: records every batch as
 * multiDraw(<counts×instances list>, n) plus the classic calls. */
function setupMulti(options?: { failBatches?: boolean }) {
  const arena = createSliceArena(8192)
  const ctx = createWgpuContext(arena)
  const command = compileWgslSpec(makeSpec(), ctx)
  const { gpu, calls } = createRecordingGPU()
  const batches: Array<{ members: [number, number][] }> = []
  const multi: GPUFacade = {
    ...gpu,
    multiDraw: (args: Uint32Array, drawCount: number) => {
      const members: [number, number][] = []
      for (let i = 0; i < drawCount; i++) members.push([args[i * 4], args[i * 4 + 1]])
      batches.push({ members })
      calls.push(`multiDraw(${members.map(m => `${m[0]}x${m[1]}`).join(';')})`)
      return !options?.failBatches
    },
  }
  const executor = createGpuExecutor({ gpu: multi, arena, commands: ctx.commands, clears: CLEAR })
  return { command, calls, batches, executor, multi, multiCommands: ctx.commands }
}

function setupFloor() {
  const arena = createSliceArena(8192)
  const ctx = createWgpuContext(arena)
  const command = compileWgslSpec(makeSpec(), ctx)
  const { gpu, calls } = createRecordingGPU() // NO multiDraw — Chrome 151's shape
  const executor = createGpuExecutor({ gpu, arena, commands: ctx.commands, clears: CLEAR })
  return { command, calls, executor }
}

describe('Task 174 — the WG multi-draw tier (the mock pins)', () => {
  it('THE EXPANSION PARITY: a batched run is the classic stream expanded', () => {
    const members: Array<[number, number]> = [[3, 1], [3, 1], [4, 2], [4, 2], [5, 3], [5, 3]]
    const on = setupMulti()
    on.executor.run(tapeOfDraws(on.command.id, members))
    // the tier ON: ONE batch of six members, exactly the tape's draws
    expect(on.batches.length).toBe(1)
    expect(on.batches[0].members).toEqual(members)
    // all six rode the batch — zero classic draws leaked around it
    expect(on.calls.filter(c => c.startsWith('draw('))).toEqual([])
    // the classic stream: the kill-switch executor over the SAME tape
    const kill = setupMulti()
    const killExecutor = createGpuExecutor({
      gpu: kill.multi,
      arena: createSliceArena(8192),
      commands: kill.multiCommands,
      clears: CLEAR,
      multiDraw: false,
    })
    killExecutor.run(tapeOfDraws(kill.command.id, members))
    const classicDraws = kill.calls.filter(c => c.startsWith('draw('))
    expect(classicDraws).toEqual(members.map(([c, i]) => `draw(${c},${i})`))
    // the expansion parity: the batch's members ARE the classic stream's
    // draws (same counts, same instances, same order)
    expect(on.batches[0].members.map(([c, i]) => `draw(${c},${i})`)).toEqual(classicDraws)
  })

  it('a run of length 1 rides the classic path verbatim (no batch, no multiDraw call)', () => {
    const { command, calls, batches, executor } = setupMulti()
    executor.run(tapeOfDraws(command.id, [[3, 1]]))
    expect(batches.length).toBe(0)
    expect(calls).toContain('draw(3,1)')
  })

  it('cross-command runs stay classic', () => {
    const arena = createSliceArena(8192)
    const ctx = createWgpuContext(arena)
    const a = compileWgslSpec(makeSpec(), ctx)
    const b = compileWgslSpec({ ...makeSpec(), pipeline: { depth: false } }, ctx)
    const { gpu, calls } = createRecordingGPU()
    const batches: Array<{ members: [number, number][] }> = []
    const multi: GPUFacade = {
      ...gpu,
      multiDraw: (args: Uint32Array, drawCount: number) => {
        const members: [number, number][] = []
        for (let i = 0; i < drawCount; i++) members.push([args[i * 4], args[i * 4 + 1]])
        batches.push({ members })
        return true
      },
    }
    const executor = createGpuExecutor({ gpu: multi, arena, commands: ctx.commands, clears: CLEAR })
    const writer = createTapeWriter(16)
    writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
    writer.emit(OpCode.Draw, a.id, 0, 3, 1)
    writer.emit(OpCode.Draw, b.id, 0, 3, 1)
    writer.emit(OpCode.Draw, a.id, 0, 3, 1)
    writer.emit(OpCode.EndPass, 0, 0, 0, 0)
    executor.run(parseTape(serializeTape(writer)))
    expect(batches.length).toBe(0) // A, B, A — three runs of one, all classic
    expect(calls.filter(c => c.startsWith('draw(')).length).toBe(3)
  })

  it('non-Draw ops break runs — the pending batch emits BEFORE the boundary op', () => {
    const { command, calls, batches, executor } = setupMulti()
    const writer = createTapeWriter(16)
    writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
    writer.emit(OpCode.Draw, command.id, 0, 3, 1)
    writer.emit(OpCode.Draw, command.id, 0, 3, 1)
    writer.emit(OpCode.EndPass, 0, 0, 0, 0)
    writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
    writer.emit(OpCode.Draw, command.id, 0, 4, 2)
    writer.emit(OpCode.Draw, command.id, 0, 4, 2)
    writer.emit(OpCode.BindTarget, 1, 1, 0, 0)
    writer.emit(OpCode.Draw, command.id, 0, 5, 3)
    writer.emit(OpCode.EndPass, 0, 0, 0, 0)
    executor.run(parseTape(serializeTape(writer)))
    expect(batches.length).toBe(2) // the EndPass and BindTarget each broke a run
    expect(batches[0].members).toEqual([[3, 1], [3, 1]])
    expect(batches[1].members).toEqual([[4, 2], [4, 2]])
    // the third run (after BindTarget) is length 1 → classic
    expect(calls).toContain('draw(5,3)')
    // the boundary ordering: the batch emitted BEFORE endPass / bindTarget
    const firstEnd = calls.indexOf('endPass')
    const firstBatch = calls.findIndex(c => c.startsWith('multiDraw('))
    expect(firstBatch).toBeGreaterThan(-1)
    expect(firstBatch).toBeLessThan(firstEnd)
    const bindAt = calls.findIndex(c => c.startsWith('bindTarget'))
    const secondBatch = calls.map(c => c.startsWith('multiDraw(')).lastIndexOf(true)
    expect(secondBatch).toBeLessThan(bindAt)
  })

  it('degenerates (instances 0) END runs and keep their classic behavior', () => {
    const { command, calls, batches, executor } = setupMulti()
    executor.run(tapeOfDraws(command.id, [[3, 1], [3, 1], [3, 0], [3, 1]]))
    // the run [A, A] batched; the degenerate rode classic verbatim; the
    // trailing lone draw is a run of one — classic
    expect(batches.length).toBe(1)
    expect(batches[0].members).toEqual([[3, 1], [3, 1]])
    expect(calls).toContain('draw(3,0)') // the degenerate's pinned classic behavior
    expect(calls.filter(c => c === 'draw(3,1)').length).toBe(1) // the trailing lone member
  })

  it('the 512 cap: 600 draws → 512 + 88 (two batches)', () => {
    const members: Array<[number, number]> = []
    for (let i = 0; i < 600; i++) members.push([3, 1])
    const { command, batches, executor } = setupMulti()
    executor.run(tapeOfDraws(command.id, members))
    expect(batches.length).toBe(2)
    expect(batches[0].members.length).toBe(512)
    expect(batches[1].members.length).toBe(88)
  })

  it('THE KILL-SWITCH: multiDraw: false → the classic stream, zero batches', () => {
    const arena = createSliceArena(8192)
    const ctx = createWgpuContext(arena)
    const command = compileWgslSpec(makeSpec(), ctx)
    const { gpu, calls } = createRecordingGPU()
    let batchCalls = 0
    const multi: GPUFacade = {
      ...gpu,
      multiDraw: () => { batchCalls++; return true },
    }
    const executor = createGpuExecutor({ gpu: multi, arena, commands: ctx.commands, clears: CLEAR, multiDraw: false })
    executor.run(tapeOfDraws(command.id, [[3, 1], [3, 1], [3, 1], [3, 1]]))
    expect(batchCalls).toBe(0)
    expect(calls.filter(c => c.startsWith('draw(')).length).toBe(4)
  })

  it('THE FAST-PATH FLOOR: a facade without multiDraw — byte-identical call stream to the kill-switch', () => {
    const members: Array<[number, number]> = [[3, 1], [3, 1], [4, 2], [4, 2], [5, 3]]
    const floor = setupFloor()
    floor.executor.run(tapeOfDraws(floor.command.id, members))
    // the tier ON (default) over an incapable facade = the floor: every
    // member is a classic draw, and the tape-end flush does NOT re-emit
    // the run's members (the first draft's double-draw bug)
    const floorDraws = floor.calls.filter(c => c.startsWith('draw('))
    expect(floorDraws).toEqual(members.map(([c, i]) => `draw(${c},${i})`))
    // vs the kill-switch over the same shape — byte-identical
    const arena2 = createSliceArena(8192)
    const ctx2 = createWgpuContext(arena2)
    const command2 = compileWgslSpec(makeSpec(), ctx2)
    const rec2 = createRecordingGPU()
    const killExecutor = createGpuExecutor({ gpu: rec2.gpu, arena: arena2, commands: ctx2.commands, clears: CLEAR, multiDraw: false })
    killExecutor.run(tapeOfDraws(command2.id, members))
    expect(rec2.calls.filter(c => c.startsWith('draw('))).toEqual(floorDraws)
  })

  it('THE PRESENCE CONTRACT: withJournalGpu forwards multiDraw IFF the raw facade has it', () => {
    // WITH the method — the wrapper mirrors it
    const journal = createJournal()
    const base = createRecordingGPU()
    let forwarded = 0
    const withMulti: GPUFacade = {
      ...base.gpu,
      multiDraw: (args: Uint32Array, drawCount: number) => {
        forwarded++
        expect(drawCount).toBe(2)
        expect(args[0]).toBe(3)
        return true
      },
    }
    const decorated = withJournalGpu(withMulti, journal)
    expect(decorated.multiDraw).toBeDefined()
    expect(decorated.multiDraw!(new Uint32Array([3, 1, 0, 0, 3, 1, 0, 0]), 2)).toBe(true)
    expect(forwarded).toBe(1)
    // WITHOUT the method — the wrapper must not invent one (a stub would
    // silently eat draws; absence honestly disarms the tier)
    const bare = withJournalGpu(createRecordingGPU().gpu, createJournal())
    expect(bare.multiDraw).toBeUndefined()
  })

  it('THE RING-FULL FALLBACK: a multiDraw that returns false → the classic expansion replays every member', () => {
    const members: Array<[number, number]> = [[3, 1], [4, 2], [5, 3]]
    const failing = setupMulti({ failBatches: true })
    failing.executor.run(tapeOfDraws(failing.command.id, members))
    // the batch was attempted once...
    expect(failing.batches.length).toBe(1)
    // ...rejected, and every member replayed through the classic path
    const draws = failing.calls.filter(c => c.startsWith('draw('))
    expect(draws).toEqual(members.map(([c, i]) => `draw(${c},${i})`))
  })
})
