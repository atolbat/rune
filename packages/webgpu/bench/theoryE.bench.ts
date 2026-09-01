import { createWgpuContext, compileWgslSpec, createCountingGPU, createGpuExecutor, createSliceArena } from '../src/index.ts'
import type { WgpuDrawSpec } from '../src/index.ts'
import { createTapeWriter, serializeTape, parseTape, OpCode } from '@rune/core'
import type { TapeView } from '@rune/core'

/**
 * Теория E (архив, обновлён под фасад v2): dynamic-offsets — единственный путь
 * нового GPUFacade (bindUniformSlice), победивший в исходном сравнении
 * (×1.7–2.7, createBindGroup 0 против N). Бенч сохраняет измерение стоимости
 * пути: кадр из 1000 draw через executor.
 */

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

const DRAWS = 1000
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

function makeSpec(): WgpuDrawSpec {
  return {
    shader: { wgsl: WGSL },
    pipeline: { depth: { test: 'less', write: true } },
    uniforms: { u_mvp: () => IDENTITY, u_tint: [1, 0.5, 0.25, 1], u_alpha: 0.8 },
    count: 6,
  }
}

function measure(repeats: number): number {
  const arena = createSliceArena(1 << 20)
  const ctx = createWgpuContext(arena)
  const command = compileWgslSpec(makeSpec(), ctx)
  const gpu = createCountingGPU()
  const executor = createGpuExecutor({ gpu, arena, commands: ctx.commands, clears: [] })

  const writer = createTapeWriter(DRAWS + 4)
  writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
  for (let i = 0; i < DRAWS; i++) command.record({}, {}, writer)
  writer.emit(OpCode.EndPass, 0, 0, 0, 0)
  const tape = parseTape(serializeTape(writer))

  for (let i = 0; i < 60; i++) executor.run(tape)
  return bestOf(repeats, () => executor.run(tape))
}

function bestOf(repeats: number, run: () => void): number {
  let best = Infinity
  for (let i = 0; i < repeats; i++) {
    const startedAt = performance.now()
    run()
    const elapsed = performance.now() - startedAt
    if (elapsed < best) best = elapsed
  }
  return best
}

const ms = measure(9)
console.log('── Теория E (архив, фасад v2): dynamic-offsets, кадр из 1000 draw ──')
console.log(`время кадра: ${ms.toFixed(3)} мс`)
