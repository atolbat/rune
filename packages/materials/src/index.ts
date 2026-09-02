// @rune/materials — a constructor material library.
//
// NOT an uber-shader: a feature bitmask describes what a surface needs
// (skinning, normal map, texture, light model, alpha mask); the assembler
// stitches minimal GLSL + WGSL variants from a snippet catalog, and a
// numeric-key cache makes repeat lookups a single Map probe. Both backend
// compilers (webgl2's glslReflect path, webgpu's wgslReflect path) consume
// the assembled sources as-is — the attribute names are the same in both
// languages, so one `attributes` record feeds two backends.
//
// Layers:
//   features.ts  — the catalog (bits + GLSL/WGSL snippets)
//   assemble.ts  — the one-shot builder (pure)
//   material.ts  — the variant cache (the hot path)
//
// This package has ZERO dependencies: it only produces strings and lists;
// compiling them into pipelines is the backends' business.

export {
  CATALOG,
  SKIN,
  NORMALMAP,
  TEXTURE,
  FLAT_ALBEDO,
  DOUBLE_SIDED,
  LAMBERT,
  ALPHA_CUTOFF,
} from './features.ts'
export type {
  FeatureBit,
  UniformDecl,
  AttrDecl,
  VaryingDecl,
  AsmCtx,
  VertSnippets,
  FragSnippets,
  FeatureDef,
} from './features.ts'

export { assemble } from './assemble.ts'
export type { AssembledMaterial } from './assemble.ts'

export { materialOf, variantCount, resetMaterials } from './material.ts'
export type { MaterialDesc, Material } from './material.ts'
