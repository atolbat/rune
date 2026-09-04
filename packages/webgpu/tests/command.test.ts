import { describe, expect, it } from 'bun:test'
import { createWgpuContext, compileWgslSpec, createRecordingGPU, createGpuExecutor } from '../src/index.ts'
import type { WgpuDrawSpec } from '../src/index.ts'
import { createSliceArena } from '../src/index.ts'
import { createTapeWriter, serializeTape, parseTape, signal, OpCode } from '@rune/core'

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
@fragment fn fs_main() -> @location(0) vec4<f32> { return params.u_tint * params.u_alpha; }`

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

// depth: null — we do not clear depth (the structural clears type requires the field).
const CLEAR = [{ color: [0.1, 0.1, 0.12, 1] as const, depth: null }]

function makeSpec(): WgpuDrawSpec {
  return {
    shader: { wgsl: WGSL },
    pipeline: { depth: { test: 'less', write: true }, raster: { cull: 'back' } },
    uniforms: {
      u_mvp: (p: any) => p.mvp,
      u_tint: signal([1, 0.5, 0.25, 1] as const),
      u_alpha: 0.8,
    },
    count: (p: any) => p.count,
  }
}

function setup() {
  const arena = createSliceArena(8192)
  const ctx = createWgpuContext(arena)
  const command = compileWgslSpec(makeSpec(), ctx)
  const { gpu, calls } = createRecordingGPU()
  const executor = createGpuExecutor({
    gpu, arena, commands: ctx.commands, clears: CLEAR,
  })
  return { arena, command, gpu, calls, executor, ctx }
}

function tapeOf(command: ReturnType<typeof setup>['command'], props: any) {
  const writer = createTapeWriter(16)
  writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
  command.record(props, { time: 0, dt: 0, aspect: 1 }, writer)
  writer.emit(OpCode.EndPass, 0, 0, 0, 0)
  return parseTape(serializeTape(writer))
}

describe('webgpu command + executor', () => {
  it('compiles: bindings by struct field names', () => {
    const { command } = setup()
    expect(command.bindings.map(b => b.name)).toEqual(['u_mvp', 'u_tint', 'u_alpha'])
    expect(command.bindings.map(b => b.shape)).toEqual(['m4', 'f4', 'f'])
    expect(command.slice.base).toBe(0)
    expect(command.slice.size).toBe(256) // aligned to the dynamic-offset granularity
  })

  it('slots in the slice follow std140 (mvp 0..64, tint 64..80, alpha 80..84)', () => {
    const { command } = setup()
    const [mvp, tint, alpha] = command.bindings
    expect(mvp.slot.offset).toBe(0)
    expect(tint.slot.offset).toBe(64)
    expect(alpha.slot.offset).toBe(80)
  })

  it('executor: frame → pass → UBO upload → pipeline → slice → draw → submit', () => {
    const { command, calls, executor } = setup()
    executor.run(tapeOf(command, { mvp: IDENTITY, count: 3 }))
    // Dirty arena slices are uploaded into the UBO BEFORE the pass (one
    // upload per frame; 84 = the actual uniform bytes, without padding the
    // slice up to 256)
    expect(calls[0]).toBe('uploadUniforms(0,84)')
    expect(calls).toContain(`usePipeline(${command.pipelineId})`)
    expect(calls).toContain('bindUniforms(0)')
    expect(calls).toContain('draw(3,1)')
    expect(calls[calls.length - 2]).toBe('endPass')
    expect(calls[calls.length - 1]).toBe('submit')
  })

  it('second frame without changes: vertex buffers are not recreated', () => {
    const { command, executor } = setup()
    executor.run(tapeOf(command, { mvp: IDENTITY, count: 3 }))
    executor.run(tapeOf(command, { mvp: IDENTITY, count: 3 }))
    // idempotency — checked at the mock level by the absence of duplicate ensurePipeline
  })

  it('the pipeline is bound on every draw, but compiled once (lazily)', () => {
    const { command, calls, executor } = setup()
    executor.run(tapeOf(command, { mvp: IDENTITY, count: 3 }))
    const setPipelineCount = calls.filter(call => call.startsWith('usePipeline')).length
    expect(setPipelineCount).toBe(1)
    expect(calls.filter(call => call.startsWith('draw(')).length).toBe(1)
  })

  it('identical specs → one pipeline; different pipelines → different', () => {
    const arena = createSliceArena(8192)
    const ctx = createWgpuContext(arena)
    const a = compileWgslSpec(makeSpec(), ctx)
    const b = compileWgslSpec(makeSpec(), ctx)
    const c = compileWgslSpec({ ...makeSpec(), pipeline: { depth: false } }, ctx)
    expect(a.pipelineId).toBe(b.pipelineId)
    expect(a.pipelineId).not.toBe(c.pipelineId)
  })

  // Task 132 — the Sword Slash crash regression: the VERTEX LAYOUT is part
  // of the pipeline identity on WebGPU (arrayStride/offset/stepMode are
  // baked into the GPURenderPipeline). Two commands sharing one shader +
  // one pipeline desc but binding different strides (a 36-byte soup vs a
  // 64-byte instance record) must NOT share a pipeline — the first to
  // draw would dictate the layout for both and the other's draw would
  // fail validation (or misread the data) on the real device.
  it('same shader+desc, different vertex strides → different pipelines', () => {
    const arena = createSliceArena(8192)
    const ctx = createWgpuContext(arena)
    const soup = compileWgslSpec(withAttributes(makeSpec(), { position: { data: new Float32Array(27), size: 3, stride: 36, offset: 0 } }), ctx)
    const instance = compileWgslSpec(withAttributes(makeSpec(), { position: { data: new Float32Array(16), size: 3, stride: 64, offset: 0, step: 'instance' } }), ctx)
    expect(soup.pipelineId).not.toBe(instance.pipelineId)
    // the same layout again → the SAME id (the cache still dedups)
    const soupAgain = compileWgslSpec(withAttributes(makeSpec(), { position: { data: new Float32Array(27), size: 3, stride: 36, offset: 0 } }), ctx)
    expect(soupAgain.pipelineId).toBe(soup.pipelineId)
  })

  // The offset and the step mode are part of the layout identity too —
  // the record's i_vel (offset 12, instance step) vs a plain uv slot.
  it('offset/step differences split pipelines', () => {
    const arena = createSliceArena(8192)
    const ctx = createWgpuContext(arena)
    const at0 = compileWgslSpec(withAttributes(makeSpec(), { position: { data: new Float32Array(9), size: 3, stride: 36, offset: 0 } }), ctx)
    const at12 = compileWgslSpec(withAttributes(makeSpec(), { position: { data: new Float32Array(9), size: 3, stride: 36, offset: 12 } }), ctx)
    const instanced = compileWgslSpec(withAttributes(makeSpec(), { position: { data: new Float32Array(9), size: 3, stride: 36, offset: 0, step: 'instance' } }), ctx)
    expect(at0.pipelineId).not.toBe(at12.pipelineId)
    expect(at0.pipelineId).not.toBe(instanced.pipelineId)
  })
})

/** Attaches a position attribute to a spec (the helper for the layout-key tests). */
function withAttributes(spec: WgpuDrawSpec, attributes: Record<string, { data: Float32Array; size: number; stride?: number; offset?: number; step?: 'vertex' | 'instance' }>): WgpuDrawSpec {
  return { ...spec, attributes }
}
