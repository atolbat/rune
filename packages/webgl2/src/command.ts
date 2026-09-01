/**
 * Компилятор DrawSpec → CompiledCommand. Юниформы расходятся по слотам
 * арены (value-compare там), атрибуты и программа — лениво в executor.
 * Спецификация декларативна: шейдер, пайплайн, атрибуты, юниформы, текстуры.
 */

import type { UniformArena, UniformSlot } from '@rune/core'
import type { TapeWriter, ReadableSignal } from '@rune/core'
import { OpCode } from '@rune/core'
import { reflectGlsl } from './glslReflect.ts'
import type { GlslReflection, UniformInfo } from './glslReflect.ts'

/** Стратегия загрузки юниформов (восстановленная версия: per-call по имени). */
export type UniformStrategy = 'auto' | 'per-call' | 'coalesced'

/** Значение юниформа: скаляр, массив чисел или типизированный массив. */
export type UniformValue = number | readonly number[] | Float32Array

/** Динамическое значение: число | (props, ctx) => число | сигнал. */
export type Dynamic<T> = T | ((props: unknown, frameCtx: unknown) => T) | ReadableSignal<T>

/** Привязка команды: имя uniform-а + слот в арене (диагностика/портативность). */
export interface CommandBinding {
  readonly name: string
  readonly type: string
  /** Слот в буфере арены (байтовые смещения). */
  readonly slot: { readonly offset: number; readonly size: number }
}

export interface TextureHandle {
  readonly textureId: number
}

/** Атрибут команды: данные + размер + опциональный интерливинг фида (M5).
 *  stride/offset — байты записи/поля для feed dual-bind (vertex-путь);
 *  bufferId — внешний GPU-буфер рендерера фида (executor не создаёт свой);
 *  instance (Task 75) — атрибут читается один раз на ИНСТАНС
 *  (квады-звёзды: одна запись фида = один инстанс, углы квада — из
 *  gl_VertexID в шейдере). */
export interface DrawAttribute {
  readonly data: Float32Array
  readonly size: number
  readonly stride?: number
  readonly offset?: number
  readonly bufferId?: number
  /** Инстанс-шаг (Task 75): true — запись читается один раз на инстанс
   *  (квады-звёзды из фида). Синоним: step='instance' (формат привязки
   *  RendererFeed.attribute(field, step) — единый словарь с WebGPU). */
  readonly instance?: boolean
  readonly step?: 'vertex' | 'instance'
}

export interface DrawSpec {
  readonly shader: { readonly glsl: { readonly vertex: string; readonly fragment: string } }
  readonly pipeline?: {
    /** Task 75: false — глубина выключена целиком (бленднутые спрайты).
     *  Паритет с GpuPipelineDesc/PipelineDesc (stateProgram). */
    readonly depth?: { readonly test?: 'less' | 'lequal' | 'always'; readonly write?: boolean } | false
    /** Task 75: блендинг (BlendFactor-строки фасада). Премультиплицированный
     *  вывод шейдера: аддитив = {src:'one', dst:'one'}, прозрачность =
     *  {src:'one', dst:'one-minus-src-alpha'}. */
    readonly blend?: { readonly src: string; readonly dst: string } | false
    readonly raster?: { readonly cull?: 'none' | 'back' | 'front' }
  }
  readonly attributes?: Record<string, DrawAttribute>
  readonly uniforms?: Record<string, unknown>
  readonly textures?: Record<string, TextureHandle>
  readonly count: Dynamic<number>
  readonly instances?: Dynamic<number>
}

export interface CompiledCommand {
  readonly id: number
  record(props: unknown, frameCtx: { time: number; dt: number; aspect: number }, writer: TapeWriter): void
  /** Кэш props последнего кадра (текстуры и диагностика). */
  lastProps: unknown
  /** Имена uniform-привязок + слоты (портативность: layout идентичен между мирами). */
  readonly bindings: readonly CommandBinding[]
  /** Ленивая GL-программа: id назначается executor'ом при первом draw. */
  programId?: number
  /** Ленивые вершинные буферы атрибутов (по location). */
  bufferIds?: number[]
}

export interface GLCompileContext {
  readonly arena: UniformArena
  readonly commands: CompiledCommand[]
  readonly mode: 'interpret' | 'codegen'
  /** Кэш рефлексий по исходнику (теория F: сотни команд с общим шейдером — один разбор). */
  readonly programs: Map<string, GlslReflection>
}

export function createCompileContext(arena: UniformArena, mode: 'interpret' | 'codegen' = 'codegen'): GLCompileContext {
  return { arena, commands: [], mode, programs: new Map() }
}

interface UniformField {
  readonly name: string
  readonly type: UniformInfo['type']
  readonly slot: UniformSlot
}

interface SamplerField {
  readonly name: string
  readonly unit: number
  readonly textureId: number
}

interface CompiledState {
  readonly depthTest: 'less' | 'lequal' | 'always'
  readonly depthWrite: boolean
  readonly cull: 'none' | 'back' | 'front'
  /** Task 75: блендинг пайплайна (null — выкл). */
  readonly blend: { readonly src: string; readonly dst: string } | null
}

export function compileDrawSpec(spec: DrawSpec, ctx: GLCompileContext): CompiledCommand {
  const reflection = reflectCached(spec, ctx)
  const fields = reflection.uniforms.filter(u => u.type !== 'sampler2D').map(toField)
  const samplers = bindSamplers(reflection, spec)
  const state = readState(spec)
  const attributes = reflection.attributes.map(attr => ({
    location: attr.location,
    size: spec.attributes?.[attr.name]?.size ?? attr.size,
    data: spec.attributes?.[attr.name]?.data ?? empty(attr.size),
    // M5 (Task 73): feed dual-bind — интерливинг + внешний буфер рендерера фида.
    stride: spec.attributes?.[attr.name]?.stride,
    offset: spec.attributes?.[attr.name]?.offset,
    bufferId: spec.attributes?.[attr.name]?.bufferId,
    // Task 75: инстанс-шаг атрибута (квады-звёзды из фида) — оба словаря:
    // instance:boolean (GL-стиль) и step:'instance' (словарь фида/WebGPU).
    instance: (spec.attributes?.[attr.name] as { instance?: boolean; step?: string } | undefined)?.instance
      ?? (spec.attributes?.[attr.name] as { step?: string } | undefined)?.step === 'instance',
  }))
  const id = ctx.commands.length
  const bindings = fields.map(field => ({
    name: field.name,
    type: field.type,
    slot: { offset: field.slot.base * 4, size: field.slot.size * 4 },
  }))

  function toField(info: UniformInfo): UniformField {
    return { name: info.name, type: info.type, slot: ctx.arena.alloc(info.size) }
  }

  function record(props: unknown, frameCtx: { time: number; dt: number; aspect: number }, writer: TapeWriter): void {
    command.lastProps = props
    for (const field of fields) {
      const value = resolve(spec.uniforms?.[field.name], props, frameCtx)
      if (value !== undefined) ctx.arena.write(field.slot, value as ArrayLike<number>)
    }
    const count = resolveNumber(spec.count, props, frameCtx)
    const instances = spec.instances === undefined ? 1 : resolveNumber(spec.instances, props, frameCtx)
    writer.emit(OpCode.Draw, id, 0, count, instances)
  }

  const command: CompiledCommand = {
    id,
    record,
    lastProps: undefined,
    bindings,
  } as never as CompiledCommand & { state: CompiledState; fields: UniformField[]; samplers: SamplerField[]; attributes: typeof attributes; glsl: DrawSpec['shader']['glsl'] }

  // Плоские данные команды читает executor (мимо ленты — MVP-компромисс
  // из оригинала: лента несёт порядок, компилированные данные — по id)
  const rich = command as never as {
    state: CompiledState; fields: UniformField[]; samplers: SamplerField[]
    attributes: typeof attributes; glsl: DrawSpec['shader']['glsl']
  }
  rich.state = state
  rich.fields = fields
  rich.samplers = samplers
  rich.attributes = attributes
  rich.glsl = spec.shader.glsl

  ctx.commands.push(command)
  return command
}

function bindSamplers(reflection: GlslReflection, spec: DrawSpec): SamplerField[] {
  const bound: SamplerField[] = []
  let unit = 0
  for (const name of reflection.samplers) {
    const handle = spec.textures?.[name]
    if (handle === undefined) continue
    bound.push({ name, unit: unit++, textureId: handle.textureId })
  }
  return bound
}

function readState(spec: DrawSpec): CompiledState {
  const depth = spec.pipeline?.depth
  const raster = spec.pipeline?.raster
  const blend = spec.pipeline?.blend
  // Task 75: depth === false → тест выключен + запись запрещена
  // (setDepthMode('always', false) → gl.disable(DEPTH_TEST)).
  const depthOff = depth === false
  return {
    depthTest: depthOff ? 'always' : (depth?.test ?? 'less'),
    depthWrite: depthOff ? false : (depth?.write ?? true),
    cull: raster?.cull ?? 'back',
    blend: blend === undefined || blend === false ? null : { src: blend.src, dst: blend.dst },
  }
}

/** Значение юниформа: функция (props, ctx) | сигнал (peek) | массив | число. */
function resolve(declared: unknown, props: unknown, frameCtx: { time: number; dt: number; aspect: number }): unknown {
  if (declared === undefined) return undefined
  if (typeof declared === 'function') return (declared as (p: unknown, c: unknown) => unknown)(props, frameCtx)
  if (typeof declared === 'object' && declared !== null && 'peek' in declared) {
    return (declared as ReadableSignal<unknown>).peek()
  }
  return declared
}

/** Числовое поле: статическое число, функция или сигнал. */
function resolveNumber(declared: Dynamic<number>, props: unknown, frameCtx: unknown): number {
  const value = resolve(declared, props, frameCtx as { time: number; dt: number; aspect: number })
  return typeof value === 'number' ? value : 0
}

/** Рефлексия с кэшем контекста: один исходник — один разбор (теория F). */
function reflectCached(spec: DrawSpec, ctx: GLCompileContext): GlslReflection {
  const key = `${spec.shader.glsl.vertex}\u0000${spec.shader.glsl.fragment}`
  const known = ctx.programs.get(key)
  if (known !== undefined) return known
  const reflection = reflectGlsl(spec.shader.glsl.vertex, spec.shader.glsl.fragment)
  ctx.programs.set(key, reflection)
  return reflection
}

function empty(size: number): Float32Array {
  return new Float32Array(size)
}
