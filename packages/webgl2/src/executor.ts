/**
 * Исполнитель ленты WebGL2: интерпретация опкодов поверх фасада.
 * Юниформы — ПО ИМЕНИ (ленивые location-кэши), value-compare в арене
 * подавляет повторные загрузки; state-кэш пропускает бесполезные
 * переключения глубины/куллинга между командами.
 */

import type { SegmentStore, TapeView, UniformArena } from '@rune/core'
import type { CompiledCommand } from './command.ts'
import type { UniformStrategy } from './command.ts'
import type { GLFacade } from './facade.ts'

export interface GLExecutorOptions {
  readonly gl: GLFacade
  readonly arena: UniformArena
  readonly commands: readonly CompiledCommand[]
  readonly clears: ReadonlyArray<{ readonly color: readonly [number, number, number, number]; readonly depth: number | null }>
  readonly segments?: SegmentStore
  readonly uniformStrategy?: UniformStrategy
}

const DEFAULT_CLEAR = { color: [0.07, 0.08, 0.11, 1] as const, depth: 1 }

export interface GLExecutor {
  run(view: TapeView): void
}

export function createExecutor(options: GLExecutorOptions): GLExecutor {
  const gl = options.gl
  const arena = options.arena
  const commands = options.commands
  const clears = options.clears

  let lastProgram = -1
  let lastDepthTest = ''
  let lastCull = ''
  let lastBlend = ''

  function run(view: TapeView): void {
    for (let at = 0; at < view.count; at++) {
      const op = view.op[at]
      if (op === 1) beginPass()
      else if (op === 2) drawCommand(commands[view.a[at]], view.c[at], view.d[at])
      else if (op === 4) gl.bindTarget(view.a[at], view.b[at] === 1)
      // EndPass (3): кадровая скобка, GL-очистки не требует
    }
  }

  function beginPass(): void {
    // Гарантированный возврат на канвас: прошлый кадр мог закончиться
    // на поверхности (skip внутри фасада, если уже канвас)
    gl.bindTarget(0, false)
    const clear = clears[0] ?? DEFAULT_CLEAR
    gl.clear(clear.color, clear.depth)
  }

  function drawCommand(command: CompiledCommand | undefined, count: number, instances: number): void {
    if (command === undefined) return
    const rich = command as CompiledCommand & {
      state: { depthTest: string; depthWrite: boolean; cull: string; blend: { src: string; dst: string } | null }
      fields: Array<{ name: string; type: string; slot: { base: number; size: number; dirty: boolean } }>
      samplers: Array<{ name: string; unit: number; textureId: number }>
      attributes: Array<{ location: number; size: number; data: Float32Array; stride?: number; offset?: number; bufferId?: number; instance?: boolean }>
      glsl: { vertex: string; fragment: string }
      programId?: number
      bufferIds?: number[]
    }
    ensureProgram(rich)
    if (rich.programId !== lastProgram) {
      gl.useProgram(rich.programId!)
      lastProgram = rich.programId!
    }
    applyState(rich)
    uploadUniforms(rich)
    for (const sampler of rich.samplers) {
      gl.bindTexture(sampler.textureId, sampler.unit)
      gl.setUniform1i(rich.programId!, sampler.name, sampler.unit)
    }
    for (const attribute of rich.attributes) {
      // M5 (Task 73): feed dual-bind — внешний буфер рендерера фида с
      // интерливингом (stride/offset); свой буфер — tight-раскладка.
      // Task 75: instance-атрибут — divisor 1 (одна запись фида на инстанс,
      // углы квада разворачиваются из gl_VertexID).
      const divisor = attribute.instance === true ? 1 : 0
      if (attribute.bufferId !== undefined) {
        gl.bindVertexBuffer(attribute.bufferId, attribute.location, attribute.size, attribute.stride, attribute.offset, divisor)
      } else {
        gl.bindVertexBuffer(rich.bufferIds![attribute.location], attribute.location, attribute.size, undefined, undefined, divisor)
      }
    }
    gl.drawArrays('triangles', 0, count, instances)
  }

  function ensureProgram(command: CompiledCommand & { programId?: number; bufferIds?: number[] }): void {
    const rich = command as CompiledCommand & {
      glsl: { vertex: string; fragment: string }
      attributes: Array<{ location: number; size: number; data: Float32Array; bufferId?: number }>
      programId?: number
      bufferIds?: number[]
    }
    if (rich.programId === undefined) {
      rich.programId = gl.createProgram(rich.glsl.vertex, rich.glsl.fragment)
      // M5: атрибут фида живёт во внешнем буфере рендерера — свой не создаём.
      rich.bufferIds = rich.attributes.map(attribute => attribute.bufferId !== undefined ? -1 : gl.createBuffer(attribute.data))
    }
  }

  function applyState(command: CompiledCommand & { state: { depthTest: string; depthWrite: boolean; cull: string; blend: { src: string; dst: string } | null } }): void {
    const state = command.state
    const depthKey = `${state.depthTest}/${state.depthWrite}`
    if (depthKey !== lastDepthTest) {
      gl.setDepthMode(state.depthTest, state.depthWrite)
      lastDepthTest = depthKey
    }
    if (state.cull !== lastCull) {
      gl.setCull(state.cull)
      lastCull = state.cull
    }
    // Task 75: блендинг пайплайна (аддитив/прозрачность для квадов-звёзд).
    const blendKey = state.blend === null ? 'off' : `${state.blend.src}/${state.blend.dst}`
    if (blendKey !== lastBlend) {
      gl.setBlend(state.blend === null ? null : state.blend.src, state.blend === null ? null : state.blend.dst)
      lastBlend = blendKey
    }
  }

  function uploadUniforms(command: CompiledCommand & { programId?: number }): void {
    const rich = command as CompiledCommand & {
      programId?: number
      fields: Array<{ name: string; type: string; slot: { base: number; size: number; dirty: boolean } }>
    }
    for (const field of rich.fields) {
      if (!field.slot.dirty) continue
      const view16 = arena.buffer.subarray(field.slot.base, field.slot.base + field.slot.size)
      setByType(rich.programId!, field.name, field.type, view16)
      field.slot.dirty = false
    }
  }

  function setByType(programId: number, name: string, type: string, values: Float32Array): void {
    if (type === 'mat4') gl.setUniformMatrix4(programId, name, values)
    else if (type === 'vec4') gl.setUniform4fv(programId, name, values)
    else if (type === 'vec3') gl.setUniform3fv(programId, name, values)
    else if (type === 'vec2') gl.setUniform2fv(programId, name, values)
    else gl.setUniform1f(programId, name, values[0])
  }

  return { run }
}
