import { createRecordingGPU, createSliceArena, createWgpuContext, compileWgslSpec, createGpuExecutor } from '../src/index.ts'
import type { WgpuDrawSpec, GPUFacade, WgpuCommand } from '../src/index.ts'
import { createTapeWriter, serializeTape, parseTape, writerView, OpCode } from '@rune/core'
import type { TapeView } from '@rune/core'

/**
 * Теория I: путь кадра на WebGPU — прямые вызовы фасада (как в демо-3)
 * против tape-пути (лента → executor). Гипотеза: лента добавляет копейку
 * записи на команду, но executor выигрывает на батчинге загрузок UBO.
 */

const WGSL = `
struct Params {
  u_mvp : mat4x4<f32>,
  u_model : mat4x4<f32>,
  u_lightDir : vec4<f32>,
  u_albedo : vec4<f32>,
}
@group(0) @binding(0) var<uniform> params : Params;

@vertex
fn vsMain(@location(0) inPos : vec3<f32>, @location(1) inNormal : vec3<f32>) -> @builtin(position) vec4<f32> {
  return params.u_mvp * vec4<f32>(inPos, 1.0);
}

@fragment
fn fsMain() -> @location(0) vec4<f32> {
  return params.u_albedo;
}`

const DRAWS = 100
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

function makeSpec(): WgpuDrawSpec {
  return {
    shader: { wgsl: WGSL },
    pipeline: { depth: { test: 'less', write: true } },
    uniforms: {
      u_mvp: () => IDENTITY,
      u_model: () => IDENTITY,
      u_lightDir: [0.5, 0.8, 0.6, 0],
      u_albedo: [0.35, 0.6, 0.95, 1],
    },
    count: 36,
  }
}

/** Путь A: прямые вызовы фасада для КАЖДОЙ команды (честно: та же работа). */
function measureDirect(gpu: GPUFacade, repeats: number): number {
  const arena = createSliceArena(1 << 16)
  const ctx = createWgpuContext(arena)
  const commands: WgpuCommand[] = []
  for (let i = 0; i < DRAWS; i++) commands.push(compileWgslSpec(makeSpec(), ctx))
  const uniforms = new Float32Array(40)
  return bestOf(repeats, () => {
    gpu.beginPass(0)
    for (const command of commands) {
      gpu.uploadUniforms(0, uniforms)
      gpu.usePipeline(command.pipelineId)
      gpu.bindUniforms(command.slice.base)
      const rich = command as unknown as { attrOrder: { data: Float32Array; size: number }[] }
      rich.attrOrder.forEach((attribute, slot) => gpu.bindVertexBuffer(slot, attribute.data, attribute.size))
      gpu.draw(36, 1)
    }
    gpu.endPass()
    gpu.submit()
  })
}

/** Путь B: лента → executor (единая архитектура). */
function measureTape(gpu: GPUFacade, repeats: number): number {
  const arena = createSliceArena(1 << 16)
  const ctx = createWgpuContext(arena)
  const commands: WgpuCommand[] = []
  for (let i = 0; i < DRAWS; i++) commands.push(compileWgslSpec(makeSpec(), ctx))
  const executor = createGpuExecutor({ gpu, arena, commands: ctx.commands, clears: [] })
  const writer = createTapeWriter(DRAWS + 4)

  return bestOf(repeats, () => {
    writer.reset()
    writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
    for (const command of commands) command.record({}, {}, writer)
    writer.emit(OpCode.EndPass, 0, 0, 0, 0)
    executor.run(writerView(writer))
  })
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

const { gpu } = createRecordingGPU()
for (let i = 0; i < 30; i++) { measureDirect(gpu, 1); measureTape(gpu, 1) } // прогрев

const directMs = measureDirect(gpu, 15)
const tapeMs = measureTape(gpu, 15)

console.log('── Теория I: путь кадра WebGPU (100 команд, мок-фасад) ──')
console.log(`прямой путь  : ${directMs.toFixed(4)} мс/кадр`)
console.log(`tape-путь    : ${tapeMs.toFixed(4)} мс/кадр`)
console.log(`разница      : ×${(directMs / tapeMs).toFixed(2)} ${directMs < tapeMs ? '(прямой быстрее)' : '(tape быстрее)'}`)
console.log('вывод: tape-путь добавляет стоимость записи ленты, но даёт воркеры/детерминизм/rewind')
console.log(`цена лент: +${((tapeMs - directMs) * 1000).toFixed(1)} мкс на ${DRAWS} команд (${((tapeMs - directMs) / DRAWS * 1000).toFixed(2)} мкс/команда)`)
