import { describe, expect, it } from 'bun:test'
import { createSliceArena } from '../src/index.ts'
import { createWgpuContext, compileWgslSpec, createRecordingGPU, createGpuExecutor } from '../src/index.ts'
import { createTapeWriter, writerView, OpCode } from '@rune/core'

/**
 * Task 181 — THE INSTANCE TIER'S INDEXED QUAD (the WG dialect): the
 * billboard instanced draw is ONE indexed instanced call — the shared
 * static [0,1,2,0,2,3] pattern (6 indices) × the live instance count over
 * the 4-entry BB_CORNERS table (the Task-180 soup trick, applied to the
 * instance records: the post-transform vertex cache turns the two shared
 * corners into hits — 4 real VS invocations per quad instead of 6).
 * `count` in the Draw op is the INDEX COUNT; `instances` rides the op as
 * before. The instance-step attributes bind with step 'instance' exactly
 * as in the pre-181 non-indexed form.
 */

const WGSL = `
struct Params { u_mvp: mat4x4<f32>, u_tint: vec4<f32> }
@group(0) @binding(0) var<uniform> params: Params;
@vertex fn vs_main(@location(0) i_par: vec4<f32>, @builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  var bbCorners = array<vec2<f32>, 4>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0));
  let bbCu = bbCorners[vi];
  return params.u_mvp * vec4<f32>(i_par.x * bbCu.x, i_par.x * bbCu.y, 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4<f32> { return params.u_tint; }`

const CLEAR = [{ color: [0.1, 0.1, 0.12, 1] as const, depth: null }]

/** The instance record feed (16 floats per record — the facade's shape). */
const RECORDS = new Float32Array(16 * 8)
/** The shared static quad pattern of ONE instanced quad (Task 181's form). */
const INSTANCE_QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3])

function spec(indices?: Uint16Array): {
  shader: { wgsl: string }
  pipeline: Record<string, never>
  attributes: { i_par: { data: Float32Array; size: number; stride: number; offset: number; step: 'instance' } }
  uniforms: Record<string, number[]>
  indices: { data: Uint16Array } | undefined
  count: number
  instances: number
} {
  return {
    shader: { wgsl: WGSL },
    pipeline: {} as Record<string, never>,
    attributes: { i_par: { data: RECORDS, size: 4, stride: 64, offset: 0, step: 'instance' } },
    uniforms: { u_mvp: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], u_tint: [1, 1, 1, 1] },
    indices: indices !== undefined ? { data: indices } : undefined,
    count: 6, // the INDEX COUNT of the shared quad pattern
    instances: 8,
  }
}

function setup(indices?: Uint16Array) {
  const arena = createSliceArena(8192)
  const ctx = createWgpuContext(arena)
  const command = compileWgslSpec(spec(indices), ctx)
  const { gpu, calls } = createRecordingGPU()
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

describe('Task 181 — the instance tier\'s indexed quad (WG)', () => {
  it('the instanced indexed draw: bindIndexBuffer + drawIndexed(6, instances) — never a bare draw', () => {
    const s = setup(INSTANCE_QUAD_INDICES)
    s.executor.run(tapeOfDraws([[s.command.id, 6, 8]]))
    // the indexed instanced pair: the 6-index pattern, the live instance
    // count riding the op's instances slot.
    expect(s.calls).toContain('bindIndexBuffer(6,u16)')
    expect(s.calls).toContain('drawIndexed(6,8)')
    // the non-indexed draw NEVER fires for the indexed instance command
    expect(s.calls.filter(c => c.startsWith('draw('))).toEqual([])
  })

  it('the floor run: bind ONCE per run, every member draws (the dedup is now BOTH the executor\'s floor and the facade\'s memo)', () => {
    const s = setup(INSTANCE_QUAD_INDICES)
    // the same command twice in one frame (two layers' instance draws).
    // Task 187: the executor's fast-path floor skips the whole prologue for
    // appends — bindIndexBuffer rides member 0 ONLY (on a real facade the
    // per-draw re-binds were already indexMemo no-ops — Task 180; the GPU
    // call stream is byte-identical, the tier may only REMOVE calls). The
    // recording mock (no memo, no multiDrawIndexed) sees the floor's raw
    // form: one bind, one draw per member.
    s.executor.run(tapeOfDraws([[s.command.id, 6, 4], [s.command.id, 6, 8]]))
    expect(s.calls.filter(c => c === 'bindIndexBuffer(6,u16)').length).toBe(1)
    expect(s.calls.filter(c => c === 'drawIndexed(6,4)').length).toBe(1)
    expect(s.calls.filter(c => c === 'drawIndexed(6,8)').length).toBe(1)
  })

  it('a zero instance count is a verbatim no-op draw (the degenerate contract)', () => {
    const s = setup(INSTANCE_QUAD_INDICES)
    s.executor.run(tapeOfDraws([[s.command.id, 6, 0]]))
    // the executor's degenerate guard: the draw still lands (verbatim
    // classic behavior — drawIndexed(6, 0), no skip, no crash).
    expect(s.calls).toContain('drawIndexed(6,0)')
  })

  it('without indices the instance command keeps the classic draw(6, instances) — the back-compat form', () => {
    const s = setup(undefined)
    s.executor.run(tapeOfDraws([[s.command.id, 6, 8]]))
    expect(s.calls).toContain('draw(6,8)')
    expect(s.calls.filter(c => c.startsWith('drawIndexed('))).toEqual([])
  })
})
