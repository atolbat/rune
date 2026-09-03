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
  idOf(desc: GpuPipelineDesc, shaderId: number): number
}

/** Creates a pipeline cache. */
export function createPipelineCache(): PipelineCache {
  const ids = new Map<string, number>()
  // Ids start at 1: 0 is reserved as "no pipeline assigned"
  // (parity with the old nextPipelineId counter of the context).
  let next = 1
  return {
    get size() { return next - 1 },
    idOf(desc, shaderId) {
      const key = structuralKey(desc, shaderId)
      const known = ids.get(key)
      if (known !== undefined) return known
      const id = next++
      ids.set(key, id)
      return id
    },
  }
}

/** Structural key: a canonical string of descriptor fields. */
export function structuralKey(desc: GpuPipelineDesc, shaderId: number): string {
  return [
    shaderId,
    depthKey(desc.depth),
    blendKey(desc.blend),
    rasterKey(desc.raster),
    desc.primitive ?? 'triangles',
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
