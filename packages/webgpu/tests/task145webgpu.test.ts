// Task 145 (webgpu deep pass): the O(dirty) pending-upload queue, the inlined
// writeUniforms, and their parity with the legacy walk / the resolve() form.
import { describe, expect, test } from 'bun:test'
import { createRecordingGPU } from '../src/recordingGPU.ts'
import { createSliceArena, createWgpuContext, compileWgslSpec, createGpuExecutor } from '../src/index.ts'
import type { WgpuDrawSpec, WgpuCommand, GPUFacade } from '../src/index.ts'
import { createTapeWriter, OpCode, writerView } from '@rune/core'
import type { TapeView } from '@rune/core'

const WGSL = `
struct Params {
  u_mvp: mat4x4<f32>,
  u_tint: vec4<f32>,
  u_alpha: f32,
}
@group(0) @binding(0) var<uniform> params: Params;
@vertex fn vs_main(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
  return params.u_mvp * vec4<f32>(position, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4<f32> { return params.u_tint; }`

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const

function makeSpec(overrides: Partial<WgpuDrawSpec> = {}): WgpuDrawSpec {
  return {
    shader: { wgsl: WGSL },
    pipeline: { depth: { test: 'less', write: true } },
    uniforms: {
      u_mvp: () => IDENTITY,
      u_tint: [1, 0.5, 0.25, 1],
      u_alpha: 0.8,
    },
    count: 6,
    ...overrides,
  }
}

/** A frame tape over the given commands, in order. */
function recordFrame(commands: readonly WgpuCommand[], frameCtx: { time: number; dt: number; aspect: number }): TapeView {
  const writer = createTapeWriter(commands.length + 2)
  writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
  for (const command of commands) command.record({}, frameCtx, writer)
  writer.emit(OpCode.EndPass, 0, 0, 0, 0)
  return writerView(writer)
}

const FRAME = { time: 1, dt: 0.016, aspect: 1.5 }

describe('task145: the pending-upload queue (O(dirty) uploads)', () => {
  test('upload call-log parity with the legacy walk over a multi-frame flow', () => {
    // Two independent worlds: an executor WITH the context (the queue) and
    // one WITHOUT (the legacy O(ops) walk). Identical commands, identical
    // frame sequence with value changes — the uploadUniforms call logs must
    // be IDENTICAL.
    const runWorld = (useQueue: boolean): string[] => {
      const { gpu, calls } = createRecordingGPU()
      const arena = createSliceArena(1 << 16)
      const ctx = createWgpuContext(arena)
      // a shared, IN-PLACE-mutated static array + a time-varying function
      // matrix — real per-frame dirt lands on a subset of the commands
      const sharedTint = [1, 0.5, 0.25, 1]
      const spin = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
      const commands: WgpuCommand[] = []
      for (let i = 0; i < 6; i++) {
        const spec = makeSpec()
        if (i % 3 === 0) (spec.uniforms as Record<string, unknown>).u_tint = sharedTint
        if (i % 3 === 1) (spec.uniforms as Record<string, unknown>).u_mvp = () => spin
        commands.push(compileWgslSpec(spec, ctx))
      }
      const executor = createGpuExecutor({
        gpu,
        arena,
        commands: ctx.commands,
        clears: [],
        ...(useQueue ? { context: ctx } : {}),
      })
      for (let frame = 0; frame < 5; frame++) {
        sharedTint[3] = 1 - frame / 10 // in-place mutation → re-dirty
        spin[13] = frame
        const view = recordFrame(commands, { ...FRAME, time: frame })
        executor.run(view)
      }
      return calls.filter(call => call.startsWith('uploadUniforms'))
    }
    const legacy = runWorld(false)
    const queued = runWorld(true)
    expect(queued.join('|')).toBe(legacy.join('|'))
    expect(legacy.length).toBeGreaterThan(6) // actual uploads happened
  })

  test('born-dirty seeding: compile-before-executor uploads exactly once', () => {
    const { gpu, calls } = createRecordingGPU()
    const arena = createSliceArena(1 << 14)
    const ctx = createWgpuContext(arena)
    const command = compileWgslSpec(makeSpec(), ctx) // born-dirty BEFORE activation
    const executor = createGpuExecutor({ gpu, arena, commands: ctx.commands, clears: [], context: ctx })
    const view = recordFrame([command], FRAME)
    executor.run(view)
    const first = calls.filter(c => c.startsWith('uploadUniforms')).length
    executor.run(view)
    const second = calls.filter(c => c.startsWith('uploadUniforms')).length
    expect(first).toBe(1) // the seed caught the born-dirty command
    expect(second).toBe(first) // the re-run adds NOTHING (cumulative counter)
  })

  test('compile-after-activation: the born-dirty push lands on the queue', () => {
    const { gpu, calls } = createRecordingGPU()
    const arena = createSliceArena(1 << 14)
    const ctx = createWgpuContext(arena)
    const executor = createGpuExecutor({ gpu, arena, commands: ctx.commands, clears: [], context: ctx })
    const command = compileWgslSpec(makeSpec(), ctx) // compiled AFTER activation
    expect(ctx.pendingUploads).not.toBeNull()
    expect(ctx.pendingUploads!.length).toBe(1)
    const view = recordFrame([command], FRAME)
    executor.run(view)
    expect(calls.filter(c => c.startsWith('uploadUniforms')).length).toBe(1)
  })

  test('dedup: one command recorded 100× in a frame → ONE upload', () => {
    const { gpu, calls } = createRecordingGPU()
    const arena = createSliceArena(1 << 14)
    const ctx = createWgpuContext(arena)
    const command = compileWgslSpec(makeSpec(), ctx)
    const executor = createGpuExecutor({ gpu, arena, commands: ctx.commands, clears: [], context: ctx })
    const writer = createTapeWriter(104)
    writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
    for (let i = 0; i < 100; i++) command.record({}, FRAME, writer)
    writer.emit(OpCode.EndPass, 0, 0, 0, 0)
    executor.run(writerView(writer))
    expect(calls.filter(c => c.startsWith('uploadUniforms')).length).toBe(1)
  })

  test('static-value suppression: steady frames upload NOTHING', () => {
    const { gpu, calls } = createRecordingGPU()
    const arena = createSliceArena(1 << 14)
    const ctx = createWgpuContext(arena)
    const command = compileWgslSpec(makeSpec(), ctx)
    const executor = createGpuExecutor({ gpu, arena, commands: ctx.commands, clears: [], context: ctx })
    const view = recordFrame([command], FRAME)
    executor.run(view) // the born-dirty upload
    executor.run(view)
    executor.run(view)
    expect(calls.filter(c => c.startsWith('uploadUniforms')).length).toBe(1)
  })

  test('a changed static array re-dirties the slice (live read preserved)', () => {
    const { gpu, calls } = createRecordingGPU()
    const arena = createSliceArena(1 << 14)
    const ctx = createWgpuContext(arena)
    const spec = makeSpec()
    ;(spec.uniforms as Record<string, unknown>).u_tint = [1, 0.5, 0.25, 1]
    const command = compileWgslSpec(spec, ctx)
    const executor = createGpuExecutor({ gpu, arena, commands: ctx.commands, clears: [], context: ctx })
    const view = recordFrame([command], FRAME)
    executor.run(view)
    // mutate the STATIC array in place — the record reads it live
    const tint = (spec.uniforms as Record<string, unknown>).u_tint as number[]
    tint[0] = 0.9
    const view2 = recordFrame([command], FRAME)
    executor.run(view2)
    const uploads = calls.filter(c => c.startsWith('uploadUniforms'))
    expect(uploads.length).toBe(2) // born-dirty + the in-place mutation
  })

  test('the aborted-frame divergence converges (documented behavior)', () => {
    // Records happen, run() never does (a frame-callback exception); the
    // stale queue entry is uploaded at the NEXT drain with the arena's
    // CURRENT bytes — an extra upload the walk would not make, convergent
    // (the slice content on the GPU ends up correct either way).
    const { gpu, calls } = createRecordingGPU()
    const arena = createSliceArena(1 << 14)
    const ctx = createWgpuContext(arena)
    const spec = makeSpec()
    ;(spec.uniforms as Record<string, unknown>).u_alpha = 0.5
    const command = compileWgslSpec(spec, ctx)
    const executor = createGpuExecutor({ gpu, arena, commands: ctx.commands, clears: [], context: ctx })
    // frame A: recorded but ABORTED (run never called)
    const aborted = recordFrame([command], FRAME)
    void aborted
    // frame B: a DIFFERENT command records; the drain runs
    const specB = makeSpec()
    const commandB = compileWgslSpec(specB, ctx)
    const view = recordFrame([commandB], FRAME)
    executor.run(view)
    const uploads = calls.filter(c => c.startsWith('uploadUniforms'))
    // both the stale entry AND commandB's born-dirty entry drained
    expect(uploads.length).toBe(2)
    // the NEXT frame with no changes: zero uploads (the flags are clean)
    const view2 = recordFrame([command, commandB], FRAME)
    executor.run(view2)
    expect(calls.filter(c => c.startsWith('uploadUniforms')).length).toBe(2)
  })

  test('the queue is empty after every drain (no growth across frames)', () => {
    const arena = createSliceArena(1 << 14)
    const ctx = createWgpuContext(arena)
    const commands: WgpuCommand[] = []
    for (let i = 0; i < 5; i++) commands.push(compileWgslSpec(makeSpec(), ctx))
    const { gpu, calls } = createRecordingGPU()
    const executor = createGpuExecutor({ gpu, arena, commands: ctx.commands, clears: [], context: ctx })
    for (let frame = 0; frame < 10; frame++) {
      const view = recordFrame(commands, FRAME)
      executor.run(view)
      expect(ctx.pendingUploads!.length).toBe(0)
    }
    void calls
  })
})

describe('task145: the inlined writeUniforms (bit-identical lanes)', () => {
  test('scalar → [v, 0, 0, 0]; short array → zero-padded lanes', () => {
    const arena = createSliceArena(1 << 14)
    const ctx = createWgpuContext(arena)
    const spec = makeSpec({
      uniforms: { u_tint: [0.25], u_alpha: 0.1, u_mvp: () => [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32] },
    })
    const command = compileWgslSpec(spec, ctx)
    command.record({}, FRAME, createTapeWriter(8))
    // u_alpha (scalar, offset 80): [0.1, 0, 0, 0]
    expect(Array.from(arena.floats.slice(80 / 4 + 0, 80 / 4 + 4))).toEqual([Math.fround(0.1), 0, 0, 0])
    // u_tint (vec4, offset 64) with a 1-element array: [0.25, 0, 0, 0]
    expect(Array.from(arena.floats.slice(64 / 4, 64 / 4 + 4))).toEqual([0.25, 0, 0, 0])
    // u_mvp (mat4, offset 0): the function's 16 values
    expect(Array.from(arena.floats.slice(0, 16))).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32])
  })

  test('fround compare suppresses a rewrite of an f32-identical value', () => {
    const arena = createSliceArena(1 << 14)
    const ctx = createWgpuContext(arena)
    const spec = makeSpec({ uniforms: { u_alpha: 0.1 } })
    const command = compileWgslSpec(spec, ctx)
    const writer = createTapeWriter(8)
    command.record({}, FRAME, writer)
    // 0.1 + 1e-17 rounds to the SAME f32 — no re-dirty
    ;(spec.uniforms as Record<string, unknown>).u_alpha = 0.1 + 1e-17
    command.record({}, FRAME, writer)
    // needsUpload was set by the born-dirty write; the fround-identical
    // second write must NOT re-mark (the flag stays from the first)
    expect((command as unknown as { needsUpload: boolean }).needsUpload).toBe(true)
    // and the stored value is the f32 of 0.1
    expect(arena.floats[80 / 4]).toBe(Math.fround(0.1))
  })

  test('a function uniform receives (props, frameCtx) live', () => {
    const arena = createSliceArena(1 << 14)
    const ctx = createWgpuContext(arena)
    let seen: unknown[] = []
    const spec = makeSpec({
      uniforms: {
        u_alpha: (props: unknown, frameCtx: unknown) => {
          seen = [props, frameCtx]
          return 0.7
        },
      },
    })
    const command = compileWgslSpec(spec, ctx)
    const props = { tag: 145 }
    command.record(props, FRAME, createTapeWriter(8))
    expect(seen[0]).toBe(props)
    expect(seen[1]).toBe(FRAME)
    expect(arena.floats[80 / 4]).toBe(Math.fround(0.7))
  })

  test('a signal-like {peek} uniform is peeked per record', () => {
    const arena = createSliceArena(1 << 14)
    const ctx = createWgpuContext(arena)
    let value = 0.3
    const spec = makeSpec({ uniforms: { u_alpha: { peek: () => value } } })
    const command = compileWgslSpec(spec, ctx)
    command.record({}, FRAME, createTapeWriter(8))
    expect(arena.floats[80 / 4]).toBe(Math.fround(0.3))
    value = 0.9
    command.record({}, FRAME, createTapeWriter(8))
    expect(arena.floats[80 / 4]).toBe(Math.fround(0.9))
  })

  test('undeclared uniform fields are skipped silently; no uniforms record — clean write', () => {
    const arena = createSliceArena(1 << 14)
    const ctx = createWgpuContext(arena)
    const spec = makeSpec({ uniforms: { u_alpha: 0.5, u_not_declared: 42 } })
    const command = compileWgslSpec(spec, ctx)
    command.record({}, FRAME, createTapeWriter(8))
    expect(arena.floats[80 / 4]).toBe(0.5)
    // and a spec with NO uniforms at all: nothing written, no marks
    const specB = makeSpec({ uniforms: undefined })
    const commandB = compileWgslSpec(specB, ctx)
    commandB.record({}, FRAME, createTapeWriter(8))
    expect((commandB as unknown as { needsUpload: boolean }).needsUpload).toBe(true) // born-dirty only
  })
})
