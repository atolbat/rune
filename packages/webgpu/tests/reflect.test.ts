import { describe, expect, it } from 'bun:test'
import { reflectWgsl } from '../src/wgslReflect.ts'
import { createSliceArena } from '../src/sliceArena.ts'
import { compileWgslSpec, createWgpuContext } from '../src/command.ts'
import { createGpuExecutor } from '../src/executor.ts'
import { createRecordingGPU } from '../src/recordingGPU.ts'
import { createTapeWriter, writerView, OpCode } from '@rune/core'

const WGSL = `struct Params {
  u_mvp : mat4x4<f32>,
  u_tint : vec4<f32>,
}
@group(0) @binding(0) var<uniform> params : Params;
@group(1) @binding(0) var texSampler : sampler;
@group(1) @binding(1) var texTexture : texture_2d<f32>;

@vertex
fn vsMain(
  @location(0) inPos : vec3<f32>,
  @location(1) inUv : vec2<f32>,
) -> @builtin(position) vec4<f32> {
  return params.u_mvp * vec4<f32>(inPos, 1.0);
}

@fragment
fn fsMain() -> @location(0) vec4<f32> {
  return params.u_tint;
}`

describe('wgsl reflection', () => {
  it('uniforms: std140-style offsets', () => {
    const r = reflectWgsl(WGSL)
    const mvp = r.uniforms.find(u => u.name === 'u_mvp')
    const tint = r.uniforms.find(u => u.name === 'u_tint')
    expect(mvp?.offset).toBe(0)
    expect(tint?.offset).toBe(64)
    expect(r.uniformBytes).toBe(80)
  })

  it('uniforms: a bone-palette array field (array<mat4x4<f32>, 67>)', () => {
    const r = reflectWgsl(WGSL_WITH_BONES)
    const mvp = r.uniforms.find(u => u.name === 'u_mvp')
    const bones = r.uniforms.find(u => u.name === 'u_bones')
    const albedo = r.uniforms.find(u => u.name === 'u_albedo')
    expect(mvp?.offset).toBe(0)
    // mat4x4 aligned at 64, the array starts there, 67 × stride 64 = 4288
    expect(bones?.offset).toBe(64)
    expect(bones?.size).toBe(64 * 67)
    expect(albedo?.offset).toBe(64 + 64 * 67)
    // the struct ends after u_colors (16×3): 64 + 4288 + 16 + 48 = 4416
    expect(r.uniformBytes).toBe(64 + 64 * 67 + 16 + 16 * 3)
  })

  it('uniforms: a vec4 array uses the 16-byte std140 stride', () => {
    const r = reflectWgsl(WGSL_WITH_BONES)
    const colors = r.uniforms.find(u => u.name === 'u_colors')
    expect(colors?.offset).toBe(64 + 64 * 67 + 16)
    expect(colors?.size).toBe(16 * 3)
  })

  it('attributes — only @vertex parameters (not VSOut outputs)', () => {
    const r = reflectWgsl(WGSL)
    expect(r.attributes.map(a => a.name)).toEqual(['inPos', 'inUv'])
    expect(r.attributes[0].size).toBe(3)
  })

  it('group-1 textures: sampler + texture_2d', () => {
    const r = reflectWgsl(WGSL)
    expect(r.textures.map(t => t.name).sort()).toEqual(['texSampler', 'texTexture'])
  })
})


const WGSL_WITH_BONES = `struct Params {
  u_mvp : mat4x4<f32>,
  u_bones : array<mat4x4<f32>, 67>,
  u_albedo : vec4<f32>,
  u_colors : array<vec4<f32>, 3>,
}
@group(0) @binding(0) var<uniform> params : Params;

@vertex
fn vsMain(
  @location(0) inPos : vec3<f32>,
) -> @builtin(position) vec4<f32> {
  let skin = params.u_bones[0] * params.u_bones[1];
  return params.u_mvp * skin * vec4<f32>(inPos, 1.0);
}`

describe('slice arena', () => {
  it('slots are 256-aligned, the cursor grows in multiples of 256', () => {
    const arena = createSliceArena(4096)
    expect(arena.alloc(80)).toBe(0)
    expect(arena.alloc(16)).toBe(256)
    expect(arena.alloc(300)).toBe(512) // 300 → two blocks 256+64 → next 512
  })

  it('reset returns the cursor', () => {
    const arena = createSliceArena(4096)
    arena.alloc(80)
    arena.alloc(80)
    arena.reset()
    expect(arena.alloc(80)).toBe(0)
  })
})

describe('compiler + executor (recorder)', () => {
  it('frame: upload before the pass, dynamic offset passed, draw with count', () => {
    const { gpu, calls } = createRecordingGPU()
    const arena = createSliceArena(1 << 12)
    const ctx = createWgpuContext(arena)
    const executor = createGpuExecutor({ gpu, arena, commands: ctx.commands, clears: [] })
    const command = compileWgslSpec({
      shader: { wgsl: WGSL },
      uniforms: { u_mvp: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], u_tint: [1, 1, 1, 1] },
      attributes: { inPos: { data: new Float32Array(9), size: 3 } },
      count: 3,
    }, ctx)

    const writer = createTapeWriter(8)
    writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
    command.record({}, { time: 0, dt: 0, aspect: 1 }, writer)
    writer.emit(OpCode.EndPass, 0, 0, 0, 0)
    executor.run(writerView(writer))

    const uploadAt = calls.findIndex(call => call.startsWith('uploadUniforms(0,'))
    const beginAt = calls.indexOf('beginPass(0)')
    const drawAt = calls.findIndex(call => call.startsWith('draw(3,1)'))
    expect(uploadAt).toBeGreaterThanOrEqual(0)
    expect(beginAt).toBeGreaterThan(uploadAt)
    expect(drawAt).toBeGreaterThan(beginAt)
    expect(calls[calls.length - 1]).toBe('submit')
  })

  it('bone-palette array: record → the whole palette lands in the slice', () => {
    const NJ = 4 // a tiny palette — the layout math is size-driven
    const WGSL_SKIN = `struct Params {
  u_mvp : mat4x4<f32>,
  u_bones : array<mat4x4<f32>, ${NJ}>,
}
@group(0) @binding(0) var<uniform> params : Params;

@vertex
fn vsMain(
  @location(0) inPos : vec3<f32>,
  @location(1) inJoints : vec4<f32>,
  @location(2) inWeights : vec4<f32>,
) -> @builtin(position) vec4<f32> {
  let skin = params.u_bones[0] * inWeights.x + params.u_bones[1] * inWeights.y;
  return params.u_mvp * (skin * vec4<f32>(inPos, 1.0));
}`
    const { gpu, calls } = createRecordingGPU()
    const arena = createSliceArena(1 << 12)
    const ctx = createWgpuContext(arena)
    const executor = createGpuExecutor({ gpu, arena, commands: ctx.commands, clears: [] })
    const palette = new Float32Array(16 * NJ)
    for (let i = 0; i < palette.length; i++) palette[i] = i
    const command = compileWgslSpec({
      shader: { wgsl: WGSL_SKIN },
      uniforms: {
        u_mvp: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        u_bones: () => palette,
      },
      attributes: {
        inPos: { data: new Float32Array(9), size: 3 },
        inJoints: { data: new Float32Array(12), size: 4 },
        inWeights: { data: new Float32Array(12), size: 4 },
      },
      count: 3,
    }, ctx)

    const writer = createTapeWriter(8)
    writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
    command.record({}, { time: 0, dt: 0, aspect: 1 }, writer)
    writer.emit(OpCode.EndPass, 0, 0, 0, 0)
    executor.run(writerView(writer))

    // the slice carries mvp (64) + palette (4×64): uploadUniforms(<offset>, 320, ...)
    const upload = calls.find(call => call.startsWith('uploadUniforms('))
    expect(upload).toBeDefined()
    expect(upload).toContain('320')
    // the palette bytes are in the slice: bytes 64..384 of the command's slice
    const sliceBase = (command as unknown as { sliceOffset: number }).sliceOffset
    for (let i = 0; i < 16 * NJ; i++) {
      expect(arena.floats[(sliceBase + 64) / 4 + i]).toBe(palette[i])
    }
    // a changed palette marks the command dirty again (per-frame refresh)
    palette[0] = 999
    command.record({}, { time: 1, dt: 0.016, aspect: 1 }, writer)
    expect((command as unknown as { needsUpload: boolean }).needsUpload).toBe(true)
  })
})
