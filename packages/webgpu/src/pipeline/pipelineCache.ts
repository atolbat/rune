import type { DepthFunc, BlendEquation, BlendFactor, CullFace, FrontFace, PrimitiveKind } from '../gpu/facadeTypes.ts'

/** WebGPU pipeline rasterization state (M3 subset). */
export interface GpuPipelineDesc {
  readonly depth?: { readonly test?: DepthFunc; readonly write?: boolean } | false
  readonly blend?: { readonly src: BlendFactor; readonly dst: BlendFactor; readonly equation?: BlendEquation } | false
  readonly raster?: { readonly cull?: CullFace | 'none'; readonly frontFace?: FrontFace }
  readonly primitive?: PrimitiveKind
}

/** Pipeline cache: structural key → stable id. */
export interface PipelineCache {
  readonly size: number
  /** Task 132 — layoutKey: the VERTEX BUFFER LAYOUT signature (per-slot
   *  stride/offset/step, see vertexLayoutKey in command.ts). WebGPU bakes
   *  the vertex layout INTO the pipeline object: two commands sharing a
   *  shader+desc but binding different strides (a soup stride 36 vs an
   *  instance stride 64) are DIFFERENT pipelines — without the layout in
   *  the key the first command's layout silently rules them all (the
   *  Sword Slash WebGPU crash: the ribbon's soup draw validated against
   *  the glints' instance pipeline). Backward compatible: no layoutKey —
   *  the pre-Task-132 key. */
  idOf(desc: GpuPipelineDesc, shaderId: number, layoutKey?: string): number
}

/** Creates a pipeline cache. */
export function createPipelineCache(): PipelineCache {
  const ids = new Map<string, number>()
  // Ids start at 1: 0 is reserved as "no pipeline assigned"
  // (parity with the old nextPipelineId counter of the context).
  let next = 1
  return {
    get size() { return next - 1 },
    idOf(desc, shaderId, layoutKey) {
      const key = structuralKey(desc, shaderId, layoutKey)
      const known = ids.get(key)
      if (known !== undefined) return known
      const id = next++
      ids.set(key, id)
      return id
    },
  }
}

/** Structural key: a canonical string of descriptor fields (+ the Task 132
 *  vertex layout signature when the command declares one). */
export function structuralKey(desc: GpuPipelineDesc, shaderId: number, layoutKey?: string): string {
  return [
    shaderId,
    depthKey(desc.depth),
    blendKey(desc.blend),
    rasterKey(desc.raster),
    desc.primitive ?? 'triangles',
    layoutKey ?? 'layout:default',
  ].join('|')
}

function depthKey(depth: GpuPipelineDesc['depth']): string {
  if (depth === false) return 'off'
  return `${depth?.test ?? 'less'}:${depth?.write === false ? 0 : 1}`
}

function blendKey(blend: GpuPipelineDesc['blend']): string {
  if (blend === false || blend === undefined) return 'off'
  // Task 122: the equation is part of the identity — same factors with a
  // different equation is a DIFFERENT pipeline.
  return `${blend.src}/${blend.dst}/${blend.equation ?? 'add'}`
}

function rasterKey(raster: GpuPipelineDesc['raster']): string {
  if (raster === undefined) return 'off'
  return `${raster.cull ?? 'none'}/${raster.frontFace ?? 'ccw'}`
}
