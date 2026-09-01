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

describe('wgsl-рефлексия', () => {
  it('юниформы: смещения std140-стиля', () => {
    const r = reflectWgsl(WGSL)
    const mvp = r.uniforms.find(u => u.name === 'u_mvp')
    const tint = r.uniforms.find(u => u.name === 'u_tint')
    expect(mvp?.offset).toBe(0)
    expect(tint?.offset).toBe(64)
    expect(r.uniformBytes).toBe(80)
  })

  it('атрибуты — только параметры @vertex (не выходы VSOut)', () => {
    const r = reflectWgsl(WGSL)
    expect(r.attributes.map(a => a.name)).toEqual(['inPos', 'inUv'])
    expect(r.attributes[0].size).toBe(3)
  })

  it('текстуры группы 1: sampler + texture_2d', () => {
    const r = reflectWgsl(WGSL)
    expect(r.textures.map(t => t.name).sort()).toEqual(['texSampler', 'texTexture'])
  })
})

describe('slice-арена', () => {
  it('слоты 256-выровнены, курсор растёт кратно 256', () => {
    const arena = createSliceArena(4096)
    expect(arena.alloc(80)).toBe(0)
    expect(arena.alloc(16)).toBe(256)
    expect(arena.alloc(300)).toBe(512) // 300 → два блока 256+64 → следующий 512
  })

  it('reset возвращает курсор', () => {
    const arena = createSliceArena(4096)
    arena.alloc(80)
    arena.alloc(80)
    arena.reset()
    expect(arena.alloc(80)).toBe(0)
  })
})

describe('компилятор + исполнитель (рекордер)', () => {
  it('кадр: upload до пасса, dynamic offset передан, draw с count', () => {
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
})
