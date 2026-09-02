/**
 * Compiler WgpuDrawSpec → WgpuCommand. Uniforms are written into an arena
 * slice (256-aligned — dynamic offsets), value-compare marks the slice dirty.
 * The pipeline is lazy: the executor calls ensurePipeline on first draw.
 */

import type { TapeWriter, ReadableSignal } from '@rune/core'
import { OpCode } from '@rune/core'
import { reflectWgsl } from './wgslReflect.ts'
import type { WgslReflection, WgslAttributeInfo, WgslUniformInfo } from './wgslReflect.ts'
import type { SliceArena } from './sliceArena.ts'
import type { GpuPipelineDesc } from './pipeline/pipelineCache.ts'
import { createPipelineCache } from './pipeline/pipelineCache.ts'
import type { PipelineCache } from './pipeline/pipelineCache.ts'

export interface TextureHandle {
  readonly textureId: number
}

/** Dynamic value: number | (props, ctx) => number | signal. */
export type WgpuDynamic<T> = T | ((props: unknown, frameCtx: unknown) => T) | ReadableSignal<T>

/** Command binding: struct field name + std140 slot in the slice. */
export interface WgpuBinding {
  readonly name: string
  /** Value shape: m4 / f4 / f3 / f2 / f. */
  readonly shape: string
  /** Slot in the slice (byte offset within the struct). */
  readonly slot: { readonly offset: number; readonly size: number }
}

/** Command slice in the arena (dynamic-offset granularity). */
export interface WgpuSliceRef {
  readonly base: number
  readonly size: number
}

export interface WgpuDrawSpec {
  readonly shader: { readonly wgsl: string }
  readonly pipeline?: GpuPipelineDesc
  readonly uniforms?: Record<string, unknown>
  /** M5 (Task 73): feed attribute — stride/offset of record interleaving
   *  (the pipeline builds arrayStride = stride, attribute offset = offset).
   *  Task 75: step='instance' — the record is read once per instance
   *  (quad-stars from the feed). */
  readonly attributes?: Record<string, { readonly data: Float32Array; readonly size: number; readonly stride?: number; readonly offset?: number; readonly step?: 'vertex' | 'instance' }>
  readonly textures?: Record<string, TextureHandle>
  readonly count: WgpuDynamic<number>
  readonly instances?: WgpuDynamic<number>
}

export interface WgpuCommand {
  readonly id: number
  record(props: unknown, frameCtx: { time: number; dt: number; aspect: number }, writer: TapeWriter): void
  lastProps: unknown
  /** Uniform field bindings: names + std140 slots (portability/diagnostics). */
  readonly bindings: readonly WgpuBinding[]
  /** Slice in the arena: base (dynamic-offset) + aligned size. */
  readonly slice: WgpuSliceRef
  /** Pipeline identifier (structural cache: identical specs — one id). */
  readonly pipelineId: number
}

export interface WgpuCompileContext {
  readonly arena: SliceArena
  readonly commands: WgpuCommand[]
  /** Structural pipeline cache: (descriptor, shader) → stable id. */
  pipelineOf(desc: GpuPipelineDesc | undefined, wgsl: string): number
  nextPipelineId(): number
}

export function createWgpuContext(arena: SliceArena): WgpuCompileContext {
  let nextPipeline = 1
  const cache: PipelineCache = createPipelineCache()
  const shaderIds = new Map<string, number>()
  let nextShaderId = 1
  return {
    arena,
    commands: [],
    pipelineOf(desc: GpuPipelineDesc | undefined, wgsl: string): number {
      let shaderId = shaderIds.get(wgsl)
      if (shaderId === undefined) {
        shaderId = nextShaderId++
        shaderIds.set(wgsl, shaderId)
      }
      return cache.idOf(desc ?? {}, shaderId)
    },
    nextPipelineId: () => nextPipeline++,
  }
}

interface RichCommand extends WgpuCommand {
  readonly wgsl: string
  readonly attrOrder: readonly { readonly data: Float32Array; readonly size: number; readonly stride?: number; readonly offset?: number; readonly step?: 'vertex' | 'instance' }[]
  readonly pipeline: GpuPipelineDesc
  readonly textureIds: readonly number[]
  readonly fields: readonly WgslUniformInfo[]
  readonly sliceOffset: number
  readonly sliceBytes: number
  /** Actual uniform bytes (upload — without trailing padding). */
  readonly uniformBytes: number
  needsUpload: boolean
  pipelineReady: boolean
}

export function compileWgslSpec(spec: WgpuDrawSpec, ctx: WgpuCompileContext): WgpuCommand {
  const reflection: WgslReflection = reflectWgsl(spec.shader.wgsl)
  const id = ctx.commands.length
  const pipelineId = ctx.pipelineOf(spec.pipeline, spec.shader.wgsl)
  const uniformBytes = Math.max(256, reflection.uniformBytes)
  const sliceOffset = ctx.arena.alloc(uniformBytes)
  const sliceBytes = uniformBytes
  const bindings = reflection.uniforms.map(field => ({
    name: field.name,
    shape: shapeOf(field.type ?? ''),
    slot: { offset: field.offset, size: field.size },
  }))
  // Actually used bytes (end of the last field): the upload does not
  // drag the struct's trailing padding up to alignment.
  const usedBytes = reflection.uniforms.length > 0
    ? reflection.uniforms[reflection.uniforms.length - 1].offset + reflection.uniforms[reflection.uniforms.length - 1].size
    : 0

  const command = {
    id,
    pipelineId,
    wgsl: spec.shader.wgsl,
    attrOrder: orderedAttributes(reflection, spec),
    pipeline: spec.pipeline ?? {},
    textureIds: boundTextures(reflection, spec),
    fields: reflection.uniforms,
    bindings,
    slice: { base: sliceOffset, size: sliceBytes },
    sliceOffset,
    sliceBytes,
    uniformBytes: usedBytes,
    needsUpload: true,
    pipelineReady: false,
    lastProps: undefined,
    record(props: unknown, frameCtx: { time: number; dt: number; aspect: number }, writer: TapeWriter): void {
      command.lastProps = props
      writeUniforms(command as RichCommand, ctx.arena, spec, props, frameCtx)
      const count = resolveNumber(spec.count, props, frameCtx)
      const instances = spec.instances === undefined ? 1 : resolveNumber(spec.instances, props, frameCtx)
      writer.emit(OpCode.Draw, id, 0, count, instances)
    },
  } as RichCommand

  ctx.commands.push(command)
  return command
}

/** Value shape from the WGSL type (binding diagnostics). */
function shapeOf(type: string): string {
  if (type.startsWith('mat4x4')) return 'm4'
  if (type.startsWith('mat3x3')) return 'm3'
  if (type.startsWith('mat2x2')) return 'm2'
  if (type.startsWith('vec4')) return 'f4'
  if (type.startsWith('vec3')) return 'f3'
  if (type.startsWith('vec2')) return 'f2'
  return 'f'
}

/** Value: function (props, ctx) | signal (peek) | array | number. */
function resolve(declared: unknown, props: unknown, frameCtx: unknown): unknown {
  if (declared === undefined) return undefined
  if (typeof declared === 'function') return (declared as (p: unknown, c: unknown) => unknown)(props, frameCtx)
  if (typeof declared === 'object' && declared !== null && 'peek' in declared) {
    return (declared as ReadableSignal<unknown>).peek()
  }
  return declared
}

/** Numeric field: static number, function, or signal. */
function resolveNumber(declared: WgpuDynamic<number>, props: unknown, frameCtx: unknown): number {
  const value = resolve(declared, props, frameCtx)
  return typeof value === 'number' ? value : 0
}

/** Attributes in ascending @location order (pipeline buffer order).
 *  M5: the feed's stride/offset are passed through to the pipeline (interleaving).
 *  Task 75: step='instance' → pipeline stepMode (instancing). */
function orderedAttributes(reflection: WgslReflection, spec: WgpuDrawSpec): { data: Float32Array; size: number; stride?: number; offset?: number; step?: 'vertex' | 'instance' }[] {
  return reflection.attributes.map((attr: WgslAttributeInfo) => ({
    data: spec.attributes?.[attr.name]?.data ?? new Float32Array(attr.size),
    size: spec.attributes?.[attr.name]?.size ?? attr.size,
    stride: spec.attributes?.[attr.name]?.stride,
    offset: spec.attributes?.[attr.name]?.offset,
    step: spec.attributes?.[attr.name]?.step,
  }))
}

/** Textures: texture_2d names from reflection → textureId from the spec. */
function boundTextures(reflection: WgslReflection, spec: WgpuDrawSpec): number[] {
  const ids: number[] = []
  for (const texture of reflection.textures) {
    if (texture.kind !== 'texture_2d') continue
    const handle = spec.textures?.[texture.name]
    if (handle !== undefined) ids.push(handle.textureId)
  }
  return ids
}

/** Writes uniforms into the slice with comparison; any change = dirty slice. */
function writeUniforms(
  command: RichCommand,
  arena: SliceArena,
  spec: WgpuDrawSpec,
  props: unknown,
  frameCtx: { time: number; dt: number; aspect: number },
): void {
  for (const field of command.fields) {
    const declared = spec.uniforms?.[field.name]
    if (declared === undefined) continue
    const value = resolve(declared, props, frameCtx)
    if (value === undefined) continue
    // A scalar f32 is also a valid value (parity with the GL arena: write
    // accepts number and ArrayLike; previously number[0] gave undefined → 0)
    const numbers: ArrayLike<number> = typeof value === 'number' ? [value] : (value as ArrayLike<number>)
    const base = (command.sliceOffset + field.offset) / 4
    let changed = false
    for (let at = 0; at < field.size / 4; at++) {
      const next = numbers[at] ?? 0
      if (Math.fround(next) !== arena.floats[base + at]) {
        arena.floats[base + at] = next
        changed = true
      }
    }
    if (changed) command.needsUpload = true
  }
}
