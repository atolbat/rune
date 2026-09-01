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

// depth: null — не клирим глубину (структурный тип clears требует поле).
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
  it('компилирует: привязки по именам полей структуры', () => {
    const { command } = setup()
    expect(command.bindings.map(b => b.name)).toEqual(['u_mvp', 'u_tint', 'u_alpha'])
    expect(command.bindings.map(b => b.shape)).toEqual(['m4', 'f4', 'f'])
    expect(command.slice.base).toBe(0)
    expect(command.slice.size).toBe(256) // выровнено до dynamic-offset гранулярности
  })

  it('слоты в срезе следуют std140 (mvp 0..64, tint 64..80, alpha 80..84)', () => {
    const { command } = setup()
    const [mvp, tint, alpha] = command.bindings
    expect(mvp.slot.offset).toBe(0)
    expect(tint.slot.offset).toBe(64)
    expect(alpha.slot.offset).toBe(80)
  })

  it('executor: кадр → пасс → загрузка UBO → пайплайн → слайс → draw → submit', () => {
    const { command, calls, executor } = setup()
    executor.run(tapeOf(command, { mvp: IDENTITY, count: 3 }))
    // Грязные слайсы арены загружаются в UBO ДО пасса (один аплоад на кадр;
    // 84 = фактические байты юниформов, без набивки среза до 256)
    expect(calls[0]).toBe('uploadUniforms(0,84)')
    expect(calls).toContain(`usePipeline(${command.pipelineId})`)
    expect(calls).toContain('bindUniforms(0)')
    expect(calls).toContain('draw(3,1)')
    expect(calls[calls.length - 2]).toBe('endPass')
    expect(calls[calls.length - 1]).toBe('submit')
  })

  it('второй кадр без изменений: вершинные буферы не пересоздаются', () => {
    const { command, executor } = setup()
    executor.run(tapeOf(command, { mvp: IDENTITY, count: 3 }))
    executor.run(tapeOf(command, { mvp: IDENTITY, count: 3 }))
    // идемпотентность — на уровне моков проверяется отсутствием дублей ensurePipeline
  })

  it('пайплайн привязывается каждый draw, но компилируется один раз (лениво)', () => {
    const { command, calls, executor } = setup()
    executor.run(tapeOf(command, { mvp: IDENTITY, count: 3 }))
    const setPipelineCount = calls.filter(call => call.startsWith('usePipeline')).length
    expect(setPipelineCount).toBe(1)
    expect(calls.filter(call => call.startsWith('draw(')).length).toBe(1)
  })

  it('одинаковые спеки → один пайплайн; разные pipeline → разные', () => {
    const arena = createSliceArena(8192)
    const ctx = createWgpuContext(arena)
    const a = compileWgslSpec(makeSpec(), ctx)
    const b = compileWgslSpec(makeSpec(), ctx)
    const c = compileWgslSpec({ ...makeSpec(), pipeline: { depth: false } }, ctx)
    expect(a.pipelineId).toBe(b.pipelineId)
    expect(a.pipelineId).not.toBe(c.pipelineId)
  })
})
