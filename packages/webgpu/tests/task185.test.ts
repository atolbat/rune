// Task 185 — THE NESTED UNIFORM CONTRACT (the WG half): a uniform value
// whose first element is an Array/TypedArray row (the natural spelling of
// array<vec4<f32>> — "u_bones: [[x,y,z,w], …]") used to flatten into pure
// NaN lanes in writeUniforms (numbers[at] ?? 0 handed the ROW OBJECT to the
// Float32Array store; ToNumber(row) = NaN — the Task-178 audit's
// "array-of-arrays writes NaN lanes" trap; the Task-179 guard stopped the
// per-frame re-dirty, the NaN garbage still shipped). Rows now flatten
// ROW-MAJOR through the slice lane walk with the Task-179 NaN-stable
// compare — correct values, ONE upload, stable across frames.
//
// The pins:
//  1. nested rows land as the FLATTENED lanes in the slice (exact floats);
//  2. an unchanged nested value does NOT re-dirty the slice (one upload,
//     the frames after are silent — the old shape re-uploaded every frame
//     because every lane was a "new" NaN);
//  3. short row sets zero-pad the tail (the flat loop's own rule);
//  4. a NaN row lane is stable per Task 179; NaN → number re-dirties;
//  5. flat values are UNTOUCHED (the nested branch never fires).
import { describe, expect, test } from 'bun:test'
import { createSliceArena, createWgpuContext, compileWgslSpec, createGpuExecutor } from '../src/index.ts'
import { createRecordingGPU } from '../src/recordingGPU.ts'
import type { WgpuDrawSpec, WgpuCommand, GPUFacade } from '../src/index.ts'
import { createTapeWriter, OpCode, writerView } from '@rune/core'

const WGSL = `
struct Params { u_mvp: mat4x4<f32>, u_bones: array<vec4<f32>, 2>, u_tint: vec4<f32> }
@group(0) @binding(0) var<uniform> params: Params;
@vertex fn vs_main(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
  return params.u_mvp * (position + params.u_bones[0].xyz);
}
@fragment fn fs_main() -> @location(0) vec4<f32> { return params.u_tint + params.u_bones[1]; }`

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const

// ────────────────── the recording executor harness (task178's own shape) ──────────────────

function makeUboGpu(capacity = 1 << 16): { gpu: GPUFacade; calls: string[] } {
  // The uploadUniforms-recording twin of task178.test.ts's makeUboGpu —
  // only the call COUNT matters here (dirty/not-dirty), not the bytes.
  const recording = createRecordingGPU()
  const calls: string[] = []
  const gpu = new Proxy(recording.gpu, {
    get(target, prop, receiver) {
      if (prop === 'uploadUniforms') {
        return (offset: number, data: Uint8Array, bindingWindow?: number) => {
          calls.push(`uploadUniforms(${offset},${data.length})`)
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  }) as unknown as GPUFacade
  return { gpu, calls }
}

function recordFrame(commands: readonly WgpuCommand[], time: number): ReturnType<typeof writerView> {
  const writer = createTapeWriter(commands.length + 2)
  writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
  for (const command of commands) command.record({}, { time, dt: 0.016, aspect: 1.5 }, writer)
  writer.emit(OpCode.EndPass, 0, 0, 0, 0)
  return writerView(writer)
}

// ────────────────────────── 1. the flattened lanes ──────────────────────────

describe('task185: the nested uniform contract (the WG slice lane walk)', () => {
  test('nested rows land FLATTENED in the slice — u_bones: [[…],[…]] writes real values, not NaN soup', () => {
    const { gpu, calls } = makeUboGpu()
    const arena = createSliceArena(1 << 14)
    const ctx = createWgpuContext(arena)
    // THE TRAP SHAPE: pre-185, every lane of u_bones was NaN (ToNumber of
    // the row object); the values below could never reach the GPU.
    const bones: unknown = [[1, 2, 3, 4], [5, 6, 7, 8]]
    const command = compileWgslSpec({
      shader: { wgsl: WGSL },
      pipeline: { depth: { test: 'less', write: true } },
      uniforms: { u_mvp: () => IDENTITY, u_tint: [0.25, 0, 0, 1], u_bones: bones as never },
      count: 3,
    }, ctx)
    const executor = createGpuExecutor({ gpu, arena, commands: ctx.commands, clears: [], context: ctx })
    executor.run(recordFrame([command], 1))
    expect(calls.length).toBe(1)
    // u_bones lives at slice offset 64 (after u_mvp) — 8 lanes of REAL data
    const base = (command.sliceOffset + 64) / 4
    expect(Array.from(arena.floats.subarray(base, base + 8))).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  test('an UNCHANGED nested value is stable — ONE upload, the frames after are silent', () => {
    const { gpu, calls } = makeUboGpu()
    const arena = createSliceArena(1 << 14)
    const ctx = createWgpuContext(arena)
    const bones = [[1, 2, 3, 4], [5, 6, 7, 8]]
    const command = compileWgslSpec({
      shader: { wgsl: WGSL },
      pipeline: { depth: { test: 'less', write: true } },
      uniforms: { u_mvp: () => IDENTITY, u_tint: [0.25, 0, 0, 1], u_bones: bones as never },
      count: 3,
    }, ctx)
    const executor = createGpuExecutor({ gpu, arena, commands: ctx.commands, clears: [], context: ctx })
    executor.run(recordFrame([command], 1))
    expect(calls.length).toBe(1)
    // frames 2..4: the same rows — STABLE (pre-185 every lane was a "new"
    // NaN each write — a silent writeBuffer EVERY frame)
    executor.run(recordFrame([command], 2))
    executor.run(recordFrame([command], 3))
    executor.run(recordFrame([command], 4))
    expect(calls.length).toBe(1)
    // a row change — one more upload
    bones[1] = [5, 6, 7, 9]
    executor.run(recordFrame([command], 5))
    expect(calls.length).toBe(2)
  })

  test("short row sets zero-pad the tail (the flat loop's own 'missing → 0' rule)", () => {
    const arena = createSliceArena(1 << 14)
    const ctx = createWgpuContext(arena)
    const command = compileWgslSpec({
      shader: { wgsl: WGSL },
      pipeline: { depth: { test: 'less', write: true } },
      uniforms: { u_mvp: () => IDENTITY, u_tint: [0.25, 0, 0, 1], u_bones: [[9, 8, 7]] },
      count: 3,
    }, ctx)
    // warm the slice with the short row set, then re-read the lanes
    command.record({}, { time: 1, dt: 0.016, aspect: 1.5 }, createTapeWriter(4))
    const base = (command.sliceOffset + 64) / 4
    expect(Array.from(arena.floats.subarray(base, base + 8))).toEqual([9, 8, 7, 0, 0, 0, 0, 0])
  })

  test('a NaN row lane is stable (Task 179); NaN → number re-dirties the slice', () => {
    const { gpu, calls } = makeUboGpu()
    const arena = createSliceArena(1 << 14)
    const ctx = createWgpuContext(arena)
    const bones = [[NaN, 2, 3, 4], [5, 6, 7, 8]]
    const command = compileWgslSpec({
      shader: { wgsl: WGSL },
      pipeline: { depth: { test: 'less', write: true } },
      uniforms: { u_mvp: () => IDENTITY, u_tint: [0.25, 0, 0, 1], u_bones: bones as never },
      count: 3,
    }, ctx)
    const executor = createGpuExecutor({ gpu, arena, commands: ctx.commands, clears: [], context: ctx })
    executor.run(recordFrame([command], 1))
    expect(calls.length).toBe(1)
    // the NaN lane stays NaN on the GPU (once), the slice stays stable
    const base = (command.sliceOffset + 64) / 4
    expect(arena.floats[base]).toBeNaN()
    executor.run(recordFrame([command], 2))
    executor.run(recordFrame([command], 3))
    expect(calls.length).toBe(1)
    // NaN → number — a real change, one more upload
    bones[0] = [0.5, 2, 3, 4]
    executor.run(recordFrame([command], 4))
    expect(calls.length).toBe(2)
    expect(arena.floats[base]).toBe(0.5)
  })

  test('flat values are untouched — the nested branch never fires', () => {
    const arena = createSliceArena(1 << 14)
    const ctx = createWgpuContext(arena)
    const command = compileWgslSpec({
      shader: { wgsl: WGSL },
      pipeline: { depth: { test: 'less', write: true } },
      uniforms: { u_mvp: () => IDENTITY, u_tint: [0.25, 0, 0, 1], u_bones: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]) },
      count: 3,
    }, ctx)
    command.record({}, { time: 1, dt: 0.016, aspect: 1.5 }, createTapeWriter(4))
    const base = (command.sliceOffset + 64) / 4
    expect(Array.from(arena.floats.subarray(base, base + 8))).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    // a SHORT flat array — the classic ?? 0 semantics, no nested detour
    const command2 = compileWgslSpec({
      shader: { wgsl: WGSL },
      pipeline: { depth: { test: 'less', write: true } },
      uniforms: { u_mvp: () => IDENTITY, u_tint: [0.25, 0, 0, 1], u_bones: [9, 8, 7] },
      count: 3,
    }, ctx)
    command2.record({}, { time: 1, dt: 0.016, aspect: 1.5 }, createTapeWriter(4))
    const base2 = (command2.sliceOffset + 64) / 4
    expect(Array.from(arena.floats.subarray(base2, base2 + 8))).toEqual([9, 8, 7, 0, 0, 0, 0, 0])
  })
})
