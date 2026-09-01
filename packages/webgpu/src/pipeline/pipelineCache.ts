import type { DepthFunc, BlendFactor, CullFace, FrontFace, PrimitiveKind } from '../gpu/facadeTypes.ts'

/** Растеризационное состояние пайплайна WebGPU (M3-подмножество). */
export interface GpuPipelineDesc {
  readonly depth?: { readonly test?: DepthFunc; readonly write?: boolean } | false
  readonly blend?: { readonly src: BlendFactor; readonly dst: BlendFactor } | false
  readonly raster?: { readonly cull?: CullFace | 'none'; readonly frontFace?: FrontFace }
  readonly primitive?: PrimitiveKind
}

/** Кэш пайплайнов: структурный ключ → устойчивый id. */
export interface PipelineCache {
  readonly size: number
  idOf(desc: GpuPipelineDesc, shaderId: number): number
}

/** Создаёт кэш пайплайнов. */
export function createPipelineCache(): PipelineCache {
  const ids = new Map<string, number>()
  // Id начинаются с 1: 0 зарезервирован как «pipeline не назначен»
  // (паритет со старым nextPipelineId-счётчиком контекста).
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

/** Структурный ключ: каноническая строка полей дескриптора. */
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
  return `${blend.src}/${blend.dst}`
}

function rasterKey(raster: GpuPipelineDesc['raster']): string {
  if (raster === undefined) return 'off'
  return `${raster.cull ?? 'none'}/${raster.frontFace ?? 'ccw'}`
}
