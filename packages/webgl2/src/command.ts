/**
 * DrawSpec → CompiledCommand compiler. Uniforms are spread across arena
 * slots (value-compare happens there); attributes and the program are lazy in the executor.
 * The specification is declarative: shader, pipeline, attributes, uniforms, textures.
 */

import type { UniformArena, UniformSlot } from '@rune/core'
import type { TapeWriter, ReadableSignal } from '@rune/core'
import { OpCode } from '@rune/core'
import { reflectGlsl } from './glslReflect.ts'
import type { GlslReflection, UniformInfo } from './glslReflect.ts'

/** Uniform upload strategy (restored version: per-call by name). */
export type UniformStrategy = 'auto' | 'per-call' | 'coalesced'

/** Uniform value: a scalar, an array of numbers, or a typed array. */
export type UniformValue = number | readonly number[] | Float32Array

/** Dynamic value: number | (props, ctx) => number | signal. */
export type Dynamic<T> = T | ((props: unknown, frameCtx: unknown) => T) | ReadableSignal<T>

/** Command binding: uniform name + arena slot (diagnostics/portability). */
export interface CommandBinding {
  readonly name: string
  readonly type: string
  /** Slot in the arena buffer (byte offsets). */
  readonly slot: { readonly offset: number; readonly size: number }
}

export interface TextureHandle {
  readonly textureId: number
}

/** Command attribute: data + size + optional feed interleaving (M5).
 *  stride/offset — record/field bytes for feed dual-bind (the vertex path);
 *  bufferId — the feed renderer's external GPU buffer (the executor does not create its own);
 *  instance (Task 75) — the attribute is read once per INSTANCE
 *  (star quads: one feed record = one instance, the quad corners come from
 *  gl_VertexID in the shader). */
export interface DrawAttribute {
  readonly data: Float32Array
  readonly size: number
  readonly stride?: number
  readonly offset?: number
  readonly bufferId?: number
  /** Instance step (Task 75): true — the record is read once per instance
   *  (star quads from the feed). Synonym: step='instance' (the binding format
   *  RendererFeed.attribute(field, step) — a single vocabulary shared with WebGPU). */
  readonly instance?: boolean
  readonly step?: 'vertex' | 'instance'
}

export interface DrawSpec {
  readonly shader: { readonly glsl: { readonly vertex: string; readonly fragment: string } }
  readonly pipeline?: {
    /** Task 75: false — depth is disabled entirely (blended sprites).
     *  Parity with GpuPipelineDesc/PipelineDesc (stateProgram). */
    readonly depth?: { readonly test?: 'less' | 'lequal' | 'always'; readonly write?: boolean } | false
    /** Task 75: blending (facade BlendFactor strings). Premultiplied
     *  shader output: additive = {src:'one', dst:'one'}, transparency =
     *  {src:'one', dst:'one-minus-src-alpha'}. */
    readonly blend?: { readonly src: string; readonly dst: string; readonly equation?: string } | false
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
  /** Props cache of the last frame (textures and diagnostics). */
  lastProps: unknown
  /** Uniform binding names + slots (portability: the layout is identical across worlds). */
  readonly bindings: readonly CommandBinding[]
  /** Lazy GL program: the id is assigned by the executor on the first draw. */
  programId?: number
  /** Lazy vertex buffers of attributes (per location). */
  bufferIds?: number[]
}

export interface GLCompileContext {
  readonly arena: UniformArena
  readonly commands: CompiledCommand[]
  readonly mode: 'interpret' | 'codegen'
  /** Reflection cache keyed by source (theory F: hundreds of commands sharing a shader — one parse). */
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
  /** Task 75: pipeline blending (null — off). Task 122: the equation
   *  (absent = 'add' — the classic behavior). */
  readonly blend: { readonly src: string; readonly dst: string; readonly equation: string } | null
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
    // M5 (Task 73): feed dual-bind — interleaving + the feed renderer's external buffer.
    stride: spec.attributes?.[attr.name]?.stride,
    offset: spec.attributes?.[attr.name]?.offset,
    bufferId: spec.attributes?.[attr.name]?.bufferId,
    // Task 75: the attribute's instance step (star quads from the feed) — both vocabularies:
    // instance:boolean (GL style) and step:'instance' (the feed/WebGPU vocabulary).
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

  // The command's flat data is read by the executor (bypassing the tape — an MVP compromise
  // from the original: the tape carries the order, compiled data is looked up by id)
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
  // Task 75: depth === false → test disabled + write forbidden
  // (setDepthMode('always', false) → gl.disable(DEPTH_TEST)).
  const depthOff = depth === false
  return {
    depthTest: depthOff ? 'always' : (depth?.test ?? 'less'),
    depthWrite: depthOff ? false : (depth?.write ?? true),
    cull: raster?.cull ?? 'back',
    blend: blend === undefined || blend === false ? null : { src: blend.src, dst: blend.dst, equation: blend.equation ?? 'add' },
  }
}

/** Uniform value: function (props, ctx) | signal (peek) | array | number. */
function resolve(declared: unknown, props: unknown, frameCtx: { time: number; dt: number; aspect: number }): unknown {
  if (declared === undefined) return undefined
  if (typeof declared === 'function') return (declared as (p: unknown, c: unknown) => unknown)(props, frameCtx)
  if (typeof declared === 'object' && declared !== null && 'peek' in declared) {
    return (declared as ReadableSignal<unknown>).peek()
  }
  return declared
}

/** Numeric field: a static number, a function, or a signal. */
function resolveNumber(declared: Dynamic<number>, props: unknown, frameCtx: unknown): number {
  const value = resolve(declared, props, frameCtx as { time: number; dt: number; aspect: number })
  return typeof value === 'number' ? value : 0
}

/** Reflection with a context cache: one source — one parse (theory F). */
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
