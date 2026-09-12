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
  readonly attributes?: Record<string, { readonly data: Float32Array; readonly size: number; readonly stride?: number; readonly offset?: number; readonly step?: 'vertex' | 'instance'; readonly bufferId?: number }>
  /** Task 180 — THE INDEX TIER: the static index array (Uint16Array or
   *  Uint32Array). When present, the command draws INDEXED — the facade
   *  creates the index buffer once (data-keyed, uploaded once — the array
   *  is the shared static pattern) and `count` in the Draw op IS THE INDEX
   *  COUNT (pass.drawIndexed). Absent — the classic non-indexed draw,
   *  byte-identical to the pre-180 stream (every existing command
   *  unchanged). The array's constructor decides the format: 'uint16' |
   *  'uint32'. */
  readonly indices?: { readonly data: Uint16Array | Uint32Array }
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
  /** Task 145: the pending-upload queue shared with the executor — the
   *  mark bus that replaces the executor's O(ops) tape walk with an
   *  O(dirty) drain. null until the executor attaches it via
   *  activateUploadQueue(); commands compiled before activation are caught
   *  by the seed, commands compiled after — pushed at compile (born-dirty)
   *  and on every false→true needsUpload transition (writeUniforms). */
  readonly pendingUploads: WgpuCommand[] | null
  /** Activates the queue (idempotent): the first call creates it and seeds
   *  every already-compiled command whose needsUpload is true. Returns the
   *  live queue — the executor drains it at every run(). */
  activateUploadQueue(): WgpuCommand[]
  /** Structural pipeline cache: (descriptor, shader, VERTEX LAYOUT) → a
   *  stable id. Task 132: the layout — the per-slot stride/offset/step —
   *  is part of the pipeline's identity on WebGPU (it is baked into the
   *  GPURenderPipeline); omitting it let a soup command and an instance
   *  command sharing one shader+desc collide on one pipeline (the Sword
   *  Slash crash). */
  pipelineOf(desc: GpuPipelineDesc | undefined, wgsl: string, layoutKey?: string): number
  nextPipelineId(): number
}

export function createWgpuContext(arena: SliceArena): WgpuCompileContext {
  let nextPipeline = 1
  const cache: PipelineCache = createPipelineCache()
  const shaderIds = new Map<string, number>()
  let nextShaderId = 1
  let pendingUploads: WgpuCommand[] | null = null
  const commands: WgpuCommand[] = []
  return {
    arena,
    commands,
    get pendingUploads() { return pendingUploads },
    activateUploadQueue(): WgpuCommand[] {
      if (pendingUploads === null) {
        pendingUploads = []
        // the seed: every already-compiled born-dirty command (the
        // compile-before-executor shape — the benches; the renderer creates
        // its executor before the first compile, so its seed is empty).
        for (const command of commands) {
          if ((command as RichCommand).needsUpload) pendingUploads.push(command)
        }
      }
      return pendingUploads
    },
    pipelineOf(desc: GpuPipelineDesc | undefined, wgsl: string, layoutKey?: string): number {
      let shaderId = shaderIds.get(wgsl)
      if (shaderId === undefined) {
        shaderId = nextShaderId++
        shaderIds.set(wgsl, shaderId)
      }
      return cache.idOf(desc ?? {}, shaderId, layoutKey)
    },
    nextPipelineId: () => nextPipeline++,
  }
}

interface RichCommand extends WgpuCommand {
  readonly wgsl: string
  readonly attrOrder: readonly { readonly data: Float32Array; readonly size: number; readonly stride?: number; readonly offset?: number; readonly step?: 'vertex' | 'instance'; readonly bufferId?: number }[]
  /** Task 180 — the static index array (undefined = the classic draw). */
  readonly indices?: { readonly data: Uint16Array | Uint32Array }
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
  const attrOrder = orderedAttributes(reflection, spec)
  const pipelineId = ctx.pipelineOf(spec.pipeline, spec.shader.wgsl, vertexLayoutKey(attrOrder))
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
    attrOrder,
    indices: spec.indices,
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
      writeUniforms(command as RichCommand, ctx.arena, spec, props, frameCtx, ctx.pendingUploads)
      const count = resolveNumber(spec.count, props, frameCtx)
      const instances = spec.instances === undefined ? 1 : resolveNumber(spec.instances, props, frameCtx)
      writer.emit(OpCode.Draw, id, 0, count, instances)
    },
  } as RichCommand

  ctx.commands.push(command)
  // Task 145: born-dirty registration on the queue (it exists only after the
  // executor activated it — the renderer compiles lazily, after activation).
  const queue = ctx.pendingUploads
  if (queue !== null) queue.push(command)
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
function orderedAttributes(reflection: WgslReflection, spec: WgpuDrawSpec): { data: Float32Array; size: number; stride?: number; offset?: number; step?: 'vertex' | 'instance'; bufferId?: number }[] {
  return reflection.attributes.map((attr: WgslAttributeInfo) => ({
    data: spec.attributes?.[attr.name]?.data ?? new Float32Array(attr.size),
    size: spec.attributes?.[attr.name]?.size ?? attr.size,
    stride: spec.attributes?.[attr.name]?.stride,
    offset: spec.attributes?.[attr.name]?.offset,
    step: spec.attributes?.[attr.name]?.step,
    bufferId: spec.attributes?.[attr.name]?.bufferId,
  }))
}

/** Task 132 — the VERTEX BUFFER LAYOUT signature: one `size:stride:offset:
 *  step` token per pipeline slot, in @location order. This is exactly the
 *  part of a command that WebGPU bakes into the GPURenderPipeline — the
 *  pipeline cache key must include it or the first command to draw with a
 *  given (shader, desc) dictates the vertex layout for EVERY command
 *  sharing them (the Sword Slash crash: an instance-record command and a
 *  soup command both used the bbSprite shader + the additive pipeline;
 *  whichever drew first baked a 64-byte instance layout, and the other's
 *  draw then validated — or misread — against it). The bufferId is
 *  deliberately NOT part of the signature: it names a buffer, not a
 *  layout. */
export function vertexLayoutKey(attrOrder: readonly { readonly size: number; readonly stride?: number; readonly offset?: number; readonly step?: 'vertex' | 'instance' }[]): string {
  return attrOrder.map(a => `${a.size}:${a.stride ?? a.size * 4}:${a.offset ?? 0}:${a.step === 'instance' ? 'i' : 'v'}`).join(',')
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

/** Writes uniforms into the slice with comparison; any change = dirty slice.
 *  Task 145: the field walk is INDEXED with hoisted uniforms/floats/lanes and
 *  resolve INLINED (the Task-142/143 lesson: JSC keeps the small out-of-line
 *  call out-of-line; per-field resolve cost a call per field per frame). The
 *  semantics are bit-identical to the resolve() form — the spec.uniforms
 *  record reference is captured once per write and the field values are
 *  still read live from it (functions re-invoked, signals re-peeked, an
 *  in-place-mutated array re-read every frame). The false→true needsUpload
 *  transition pushes onto the pending queue (the executor's O(dirty)
 *  upload drain); queue === null — the legacy O(ops) walk executor. */
function writeUniforms(
  command: RichCommand,
  arena: SliceArena,
  spec: WgpuDrawSpec,
  props: unknown,
  frameCtx: { time: number; dt: number; aspect: number },
  queue: WgpuCommand[] | null,
): void {
  const fields = command.fields
  const uniforms = spec.uniforms
  if (uniforms === undefined) return
  const floats = arena.floats
  const sliceOffset = command.sliceOffset
  const fieldCount = fields.length
  for (let f = 0; f < fieldCount; f++) {
    const field = fields[f]
    const declared = uniforms[field.name]
    if (declared === undefined) continue
    // resolve inlined: function → call, signal → peek, else — the value.
    // (a `const` value: the `typeof value === 'number'` alias below must
    // narrow through it — with a `let` TS drops the aliased-condition
    // narrowing and the lane write stops type-checking)
    let resolved: unknown
    if (typeof declared === 'function') resolved = (declared as (p: unknown, c: unknown) => unknown)(props, frameCtx)
    else if (typeof declared === 'object' && declared !== null && 'peek' in declared) {
      resolved = (declared as ReadableSignal<unknown>).peek()
    } else resolved = declared
    if (resolved === undefined) continue
    const value: unknown = resolved
    // A scalar f32 is also a valid value (parity with the GL arena: write
    // accepts number and ArrayLike). The scalar path reads the number
    // directly — no [value] array allocation per field per frame.
    const scalar = typeof value === 'number'
    const numbers: ArrayLike<number> = scalar ? EMPTY : (value as ArrayLike<number>)
    const base = (sliceOffset + field.offset) / 4
    const lanes = field.size / 4
    let changed = false
    // Task 185 — THE NESTED CONTRACT (the arena's twin): a value whose
    // first element is an Array/TypedArray row (the natural spelling of
    // array<vec4<f32>> — "u_bones: [[x,y,z,w], …]") used to flatten into
    // pure NaN lanes (numbers[at] ?? 0 handed the ROW OBJECT to the
    // Float32Array store; ToNumber(row) = NaN — the Task-178 audit's
    // "array-of-arrays writes NaN lanes" trap; the Task-179 guard stopped
    // the per-frame re-dirty, the NaN garbage still shipped). Rows now
    // flatten ROW-MAJOR; a non-row element is ONE lane with the flat-path
    // semantics (null/undefined → 0, objects → NaN), byte-identical to
    // the pre-185 flat behavior for degenerate shapes.
    const first = scalar ? undefined : numbers[0]
    if (first !== null && first !== undefined && typeof first === 'object'
      && (Array.isArray(first) || ArrayBuffer.isView(first))) {
      const rows = numbers as ArrayLike<unknown>
      let lane = 0
      for (let row = 0; row < rows.length && lane < lanes; row++) {
        const r = rows[row]
        if (r !== null && r !== undefined && typeof r === 'object'
          && (Array.isArray(r) || ArrayBuffer.isView(r))) {
          const entries = r as ArrayLike<number>
          for (let j = 0; j < entries.length && lane < lanes; j++) {
            const next = entries[j] ?? 0
            const cur = floats[base + lane]
            if (!(next !== next && cur !== cur) && Math.fround(next) !== cur) {
              floats[base + lane] = next
              changed = true
            }
            lane++
          }
        } else {
          const next = (typeof r === 'number' ? r : (r ?? 0)) as number
          const cur = floats[base + lane]
          if (!(next !== next && cur !== cur) && Math.fround(next) !== cur) {
            floats[base + lane] = next
            changed = true
          }
          lane++
        }
      }
      // The trailing pad — rows ran out before the lanes did: zero-fill the
      // rest (the flat loop's own "missing → 0" rule; a [[1,2]] into a
      // vec4 must not leave lanes 2..3 stale).
      for (; lane < lanes; lane++) {
        if (floats[base + lane] !== 0) {
          floats[base + lane] = 0
          changed = true
        }
      }
      if (changed && queue !== null && !command.needsUpload) {
        command.needsUpload = true
        queue.push(command)
      } else if (changed) command.needsUpload = true
      continue
    }
    for (let at = 0; at < lanes; at++) {
      const next = scalar ? (at === 0 ? value : 0) : (numbers[at] ?? 0)
      // Task 179 — THE NaN GUARD: fround(NaN) !== NaN is ALWAYS true, so a
      // field whose resolved value is NaN (an upstream math bug — e.g. an
      // array-of-arrays uniform) re-dirtied the slice EVERY frame, a silent
      // per-frame re-upload leak that the Task-178 audit documented. A NaN
      // lane now writes ONCE (the first time the slot was not NaN) and
      // stays stable; NaN → number and number → NaN transitions still count
      // as changes. The GPU keeps receiving the NaN — this is the upload
      // leak fix, not a value sanitizer.
      const cur = floats[base + at]
      if (next !== next && cur !== cur) continue
      if (Math.fround(next) !== cur) {
        floats[base + at] = next
        changed = true
      }
    }
    if (changed && queue !== null && !command.needsUpload) {
      command.needsUpload = true
      queue.push(command)
    } else if (changed) command.needsUpload = true
  }
}

/** Placeholder for the scalar path (the loop reads the number itself). */
const EMPTY: ArrayLike<number> = [0]
