import { describe, expect, test } from 'bun:test'
import { createUniformArena, createTapeWriter, writerView, OpCode } from '@rune/core'
import { compileDrawSpec, createCompileContext, createExecutor, createRecordingGL, createRealGL, probeGLCaps } from '../src/index.ts'
import type { DrawSpec, GLFacade } from '../src/index.ts'

// Task 169 — THE MULTI-DRAW TIER: the executor collapses runs of consecutive
// draws of the SAME command into one WEBGL_multi_drawArraysInstanced call.
// The pins here are the CONTRACT:
//   1. the batch arithmetic (what collapses, what does not);
//   2. THE EXPANSION PARITY — the batched call stream, with every multiDraw
//      expanded back into its per-draw form, is IDENTICAL to the classic
//      stream of the same tape (the documented semantics of the extension
//      are the verbatim expansion; the tier must be invisible to everything
//      but a driver profiler);
//   3. presence == capability at the facade (the task165 lesson: an
//      always-present no-op method silently swallowed every batched draw —
//      4 draws expected, 0 landed);
//   4. the caps probe and the recording mock.

const VERT = `#version 300 es
layout(location = 0) in vec3 position;
uniform float u_x;
void main() { gl_Position = vec4(position, u_x, 1.0); }`

const FRAG = `#version 300 es
precision mediump float;
out vec4 o_color;
void main() { o_color = vec4(1.0, 0.5, 0.25, 1.0); }`

const CTX = { time: 0, dt: 1 / 60, aspect: 1 }

function specOf(overrides: Partial<DrawSpec> = {}): DrawSpec {
  return {
    shader: { glsl: { vertex: VERT, fragment: FRAG } },
    attributes: { position: { data: new Float32Array(9), size: 3 } },
    uniforms: { u_x: 0.5 },
    count: 6,
    ...overrides,
  }
}

/** A facade clone with the multi-draw method REMOVED — the tier's control group. */
function classicMock(): { gl: GLFacade; calls: string[] } {
  const recording = createRecordingGL()
  const gl = { ...recording.gl } as GLFacade & { multiDrawArraysInstanced?: unknown }
  delete gl.multiDrawArraysInstanced
  return { gl: gl as unknown as GLFacade, calls: recording.calls }
}

/** Expand `multiDraw×N[c×i@f,...]` logs into their per-draw `drawArrays` form. */
function expandDraws(calls: string[]): string[] {
  const out: string[] = []
  for (const call of calls) {
    const match = /^multiDraw×(\d+)\[(.*)\]$/.exec(call)
    if (match === null) { out.push(call); continue }
    for (const part of match[2].split(',')) {
      const cut = part.indexOf('×')
      const at = part.indexOf('@')
      const count = part.slice(0, cut)
      const instances = part.slice(cut + 1, at)
      out.push(`drawArrays(triangles,0,${count},${instances})`)
    }
  }
  return out
}

interface TapeEntry {
  readonly command: { record(props: unknown, frameCtx: unknown, writer: ReturnType<typeof createTapeWriter>): void }
  readonly props: Record<string, number>
}

/** Records the entries into one BeginPass/EndPass tape and runs the executor. */
function runTape(executor: ReturnType<typeof createExecutor>, entries: readonly TapeEntry[], passes = 1): void {
  const writer = createTapeWriter(64)
  writer.reset()
  for (let p = 0; p < passes; p++) writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
  for (const entry of entries) entry.command.record(entry.props, CTX, writer)
  writer.emit(OpCode.EndPass, 0, 0, 0, 0)
  executor.run(writerView(writer))
}

describe('task 169: the multi-draw batch tier (the executor)', () => {
  test('FOUR same-command draws collapse into ONE multiDraw — counts and instances preserved in order', () => {
    const arena = createUniformArena(1 << 12)
    const ctx = createCompileContext(arena, 'codegen')
    const command = compileDrawSpec(specOf({
      count: (p: unknown) => (p as { count?: number }).count ?? 6,
      instances: (p: unknown) => (p as { inst?: number }).inst ?? 1,
    }), ctx)
    const { gl, calls } = createRecordingGL()
    const executor = createExecutor({ gl, arena, commands: ctx.commands, clears: [] })
    runTape(executor, [
      { command, props: { count: 6, inst: 1 } },
      { command, props: { count: 8, inst: 2 } },
      { command, props: { count: 10, inst: 3 } },
      { command, props: { count: 12, inst: 4 } },
    ])
    const multi = calls.filter(c => c.startsWith('multiDraw'))
    expect(multi.length).toBe(1)
    expect(multi[0]).toBe('multiDraw×4[6×1@0,8×2@0,10×3@0,12×4@0]')
    expect(calls.filter(c => c.startsWith('drawArrays')).length).toBe(0)
    // the run's prologue ran ONCE: one program use for the whole batch
    expect(calls.filter(c => c.startsWith('useProgram')).length).toBe(1)
  })

  test('THE EXPANSION PARITY — the batched draws are the classic draws, call-for-call; the tier never ADDS a GL call', () => {
    // The two sides compile their OWN command sets (fresh lazy-creation
    // state — sharing commands would leak programId/bufferIds across sides
    // and the streams would differ by WHO created what, not by the tier).
    // The comparison is two-part:
    //   (a) the EXPANDED draw sequence is IDENTICAL — the batched draws are
    //       the classic draws, same counts, same instances, same order;
    //   (b) the batched NON-draw calls are a SUBSEQUENCE of the classic's —
    //       the tier may only REMOVE calls (the per-append prologue
    //       re-asserts, which realGL's Task-165 memos skip anyway — the
    //       recording mock has no memos, hence the visible difference),
    //       never add one. A stream that grew would mean the tier changed
    //       semantics — the exact regression class this test exists for.
    const shapes: ReadonlyArray<{ name: string, entries: (ctx: ReturnType<typeof createCompileContext>) => TapeEntry[] }> = [
      {
        name: 'a plain run (uniform values identical between records)',
        entries: (ctx) => {
          const a = compileDrawSpec(specOf({ count: (p: unknown) => (p as { count?: number }).count ?? 6, instances: (p: unknown) => (p as { inst?: number }).inst ?? 1 }), ctx)
          return [
            { command: a, props: {} },
            { command: a, props: { count: 8, inst: 2 } },
            { command: a, props: { count: 10, inst: 3 } },
            { command: a, props: { count: 12, inst: 4 } },
          ]
        },
      },
      {
        name: 'per-record uniform VARIATION (the arena holds the LAST write at execute time — both paths draw it)',
        entries: (ctx) => {
          const a = compileDrawSpec(specOf({ uniforms: { u_x: (p: { x?: number }) => p.x ?? 0.5 } }), ctx)
          return [
            { command: a, props: { x: 0.5 } },
            { command: a, props: { x: 0.9 } },
            { command: a, props: { x: 0.7 } },
          ]
        },
      },
      {
        name: 'cross-command interleaving (runs never span commands)',
        entries: (ctx) => {
          const a = compileDrawSpec(specOf(), ctx)
          const b = compileDrawSpec(specOf({ uniforms: { u_x: 0.9 } }), ctx)
          return [
            { command: a, props: {} }, { command: a, props: {} },
            { command: b, props: {} },
            { command: a, props: {} },
            { command: b, props: {} }, { command: b, props: {} },
          ]
        },
      },
      {
        name: 'degenerate members (count 0 / instances 0) flush and ride classic',
        entries: (ctx) => {
          const a = compileDrawSpec(specOf({ count: (p: unknown) => (p as { count?: number }).count ?? 6, instances: (p: unknown) => (p as { inst?: number }).inst ?? 1 }), ctx)
          return [
            { command: a, props: {} },
            { command: a, props: { inst: 0 } },
            { command: a, props: { count: 0 } },
            { command: a, props: {} },
          ]
        },
      },
      {
        name: 'a single draw (the run of one)',
        entries: (ctx) => [{ command: compileDrawSpec(specOf({ uniforms: { u_x: 0.9 } }), ctx), props: {} }],
      },
    ]
    for (const shape of shapes) {
      // the batched side
      const arenaB = createUniformArena(1 << 12)
      const ctxB = createCompileContext(arenaB, 'codegen')
      const entriesB = shape.entries(ctxB)
      const batched = createRecordingGL()
      const execBatched = createExecutor({ gl: batched.gl, arena: arenaB, commands: ctxB.commands, clears: [] })
      runTape(execBatched, entriesB)
      // the classic side (a fresh compile — its own lazy-creation state)
      const arenaC = createUniformArena(1 << 12)
      const ctxC = createCompileContext(arenaC, 'codegen')
      const entriesC = shape.entries(ctxC)
      const classic = classicMock()
      const execClassic = createExecutor({ gl: classic.gl, arena: arenaC, commands: ctxC.commands, clears: [] })
      runTape(execClassic, entriesC)

      // (a) the draws, expanded, are identical
      const drawsB = expandDraws(batched.calls.filter(c => c.startsWith('drawArrays') || c.startsWith('multiDraw')))
      const drawsC = classic.calls.filter(c => c.startsWith('drawArrays'))
      expect(drawsB).toEqual(drawsC)
      // (b) the batched non-draw calls are a subsequence of the classic's
      const nonDrawB = batched.calls.filter(c => !c.startsWith('drawArrays') && !c.startsWith('multiDraw'))
      const nonDrawC = classic.calls.filter(c => !c.startsWith('drawArrays'))
      let at = 0
      for (const call of nonDrawB) {
        const found = nonDrawC.indexOf(call, at)
        expect(found).toBeGreaterThanOrEqual(0)
        at = found + 1
      }
    }
  })

  test('cross-command sequences stay classic (A,B,A → three drawArrays, zero multiDraw)', () => {
    const arena = createUniformArena(1 << 12)
    const ctx = createCompileContext(arena, 'codegen')
    const a = compileDrawSpec(specOf(), ctx)
    const b = compileDrawSpec(specOf({ uniforms: { u_x: 0.9 } }), ctx)
    const { gl, calls } = createRecordingGL()
    const executor = createExecutor({ gl, arena, commands: ctx.commands, clears: [] })
    runTape(executor, [
      { command: a, props: {} },
      { command: b, props: {} },
      { command: a, props: {} },
    ])
    expect(calls.filter(c => c.startsWith('multiDraw')).length).toBe(0)
    expect(calls.filter(c => c === 'drawArrays(triangles,0,6,1)').length).toBe(3)
  })

  test('a BeginPass between draws breaks the run (state resets flush pending draws FIRST)', () => {
    const arena = createUniformArena(1 << 12)
    const ctx = createCompileContext(arena, 'codegen')
    const a = compileDrawSpec(specOf(), ctx)
    const { gl, calls } = createRecordingGL()
    const executor = createExecutor({ gl, arena, commands: ctx.commands, clears: [] })
    // TWO passes in one tape: A,A | A,A — the pass boundary must not absorb
    // the second pass's draws into the first run
    const writer = createTapeWriter(64)
    writer.reset()
    writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
    a.record({}, CTX, writer)
    a.record({}, CTX, writer)
    writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
    a.record({}, CTX, writer)
    a.record({}, CTX, writer)
    writer.emit(OpCode.EndPass, 0, 0, 0, 0)
    executor.run(writerView(writer))
    const multi = calls.filter(c => c.startsWith('multiDraw'))
    expect(multi.length).toBe(2)
    expect(multi.every(m => m === 'multiDraw×2[6×1@0,6×1@0]')).toBe(true)
  })

  test('the kill-switch: multiDraw:false restores the per-draw path exactly (the method present, the tier off)', () => {
    const arena = createUniformArena(1 << 12)
    const ctx = createCompileContext(arena, 'codegen')
    const a = compileDrawSpec(specOf(), ctx)
    const { gl, calls } = createRecordingGL()
    const executor = createExecutor({ gl, arena, commands: ctx.commands, clears: [], multiDraw: false })
    runTape(executor, [
      { command: a, props: {} },
      { command: a, props: {} },
      { command: a, props: {} },
    ])
    expect(calls.filter(c => c.startsWith('multiDraw')).length).toBe(0)
    expect(calls.filter(c => c === 'drawArrays(triangles,0,6,1)').length).toBe(3)
  })

  test('the MAX_BATCH cap: 600 same-command draws flush 512 + 88 (no run exceeds the cap)', () => {
    const arena = createUniformArena(1 << 12)
    const ctx = createCompileContext(arena, 'codegen')
    const a = compileDrawSpec(specOf(), ctx)
    const { gl, calls } = createRecordingGL()
    const executor = createExecutor({ gl, arena, commands: ctx.commands, clears: [] })
    const entries: TapeEntry[] = []
    for (let i = 0; i < 600; i++) entries.push({ command: a, props: {} })
    runTape(executor, entries)
    const multi = calls.filter(c => c.startsWith('multiDraw'))
    expect(multi.length).toBe(2)
    expect(multi[0].startsWith('multiDraw×512['[0] === 'm' ? 'multiDraw×512[' : '')).toBe(true)
    expect(multi[1]).toBe('multiDraw×88[' + '6×1@0,'.repeat(87) + '6×1@0]')
    expect(calls.filter(c => c.startsWith('drawArrays')).length).toBe(0)
  })

  test('degenerate draws (instances 0 / count 0) keep the classic behavior byte-for-byte', () => {
    const arena = createUniformArena(1 << 12)
    const ctx = createCompileContext(arena, 'codegen')
    const a = compileDrawSpec(specOf({
      count: (p: unknown) => (p as { count?: number }).count ?? 6,
      instances: (p: unknown) => (p as { inst?: number }).inst ?? 1,
    }), ctx)
    const { gl, calls } = createRecordingGL()
    const executor = createExecutor({ gl, arena, commands: ctx.commands, clears: [] })
    runTape(executor, [
      { command: a, props: {} },
      { command: a, props: { inst: 0 } },
      { command: a, props: {} },
    ])
    // the degenerate middle draw broke BOTH runs → all three rode classic
    expect(calls.filter(c => c.startsWith('multiDraw')).length).toBe(0)
    expect(calls.filter(c => c === 'drawArrays(triangles,0,6,1)').length).toBe(2)
    expect(calls.filter(c => c === 'drawArrays(triangles,0,6,0)').length).toBe(1)
  })
})

describe('task 169: the facade contract (presence == capability)', () => {
  test('realGL WITHOUT WEBGL_multi_draw does not expose the method (the task165 lesson, pinned)', () => {
    const gl = {
      getExtension: () => null,
      TRIANGLES: 4,
    }
    const facade = createRealGL(gl as unknown as WebGL2RenderingContext)
    expect((facade as GLFacade & { multiDrawArraysInstanced?: unknown }).multiDrawArraysInstanced).toBeUndefined()
  })

  test('realGL WITH the extension exposes it and forwards the lists with offset 0 and the mapped primitive', () => {
    const received: unknown[] = []
    const ext = {
      multiDrawArraysInstancedWEBGL: (...args: unknown[]) => { received.push(...args) },
    }
    const gl = {
      getExtension: (name: string) => (name === 'WEBGL_multi_draw' ? ext : null),
      TRIANGLES: 4,
    }
    const facade = createRealGL(gl as unknown as WebGL2RenderingContext)
    const method = (facade as GLFacade & { multiDrawArraysInstanced?: (mode: string, firsts: Int32Array, counts: Int32Array, instanceCounts: Int32Array, drawcount: number) => void }).multiDrawArraysInstanced
    expect(method).toBeDefined()
    const firsts = new Int32Array([0, 0])
    const counts = new Int32Array([6, 8])
    const instances = new Int32Array([1, 2])
    method!('triangles', firsts, counts, instances, 2)
    // the extension signature: (mode, firsts, 0, counts, 0, instances, 0, drawcount)
    expect(received).toEqual([4, firsts, 0, counts, 0, instances, 0, 2])
    // drawcount <= 0 is refused (an empty batch is a no-op, not a driver call)
    received.length = 0
    method!('triangles', firsts, counts, instances, 0)
    expect(received.length).toBe(0)
  })
})

describe('task 169: the caps probe', () => {
  test("caps.has('multi-draw') rides the WEBGL_multi_draw extension probe", () => {
    const caps = probeGLCaps({
      getExtension: (name: string) => (name === 'WEBGL_multi_draw' ? {} : null),
      getParameter: () => 4096,
      MAX_VIEWPORT_DIMS: 0,
    } as never)
    expect(caps.features.has('multi-draw')).toBe(true)

    const capsWithout = probeGLCaps({
      getExtension: () => null,
      getParameter: () => 4096,
      MAX_VIEWPORT_DIMS: 0,
    } as never)
    expect(capsWithout.features.has('multi-draw')).toBe(false)
  })
})
