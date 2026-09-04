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
// PBR is a FAMILY, not a single model: the distribution (GGX / Beckmann /
// Blinn-Phong), the geometry term (the exact Smith, Karis's approximation,
// the height-correlated Smith, implicit / Neumann / Kelemen), the Fresnel
// (Schlick / the exact dielectric form) and the diffuse lobe (Lambert /
// Oren-Nayar / Burley) are each an assembly-time option — pbrMask() is the
// ergonomic route, the raw bits the explicit one. A variant carries ONLY
// the chosen formulas, with the Cook-Torrance algebra folded at assembly.
//
// BILLBOARD (Task 131) is the instanced-particle vertex stage: it pairs
// with @rune/particles' INSTANCE_LAYOUT records (packInstances) — one
// quad per instance, the corner expansion on the GPU. See features.ts
// for the attribute/uniform contract.
//
// Layers:
//   features.ts  — the catalog (bits + GLSL/WGSL snippets)
//   assemble.ts  — the one-shot builder (pure, zero ghost allocations)
//   material.ts  — the variant cache (the hot path)
//
// This package has ZERO dependencies: it only produces strings and lists;
// compiling them into pipelines is the backends' business.

export {
  CATALOG,
  SKIN,
  INSTANCED,
  NORMALMAP,
  TEXTURE,
  FLAT_ALBEDO,
  VERTEX_COLOR,
  DOUBLE_SIDED,
  ALPHA_CUTOFF,
  LAMBERT,
  MATCAP,
  PBR,
  PBR_D_GGX,
  PBR_D_BECKMANN,
  PBR_D_BLINN,
  PBR_G_SMITH,
  PBR_G_SMITH_SCHLICK,
  PBR_G_SMITH_HEIGHT,
  PBR_G_IMPLICIT,
  PBR_G_NEUMANN,
  PBR_G_KELEMEN,
  PBR_F_SCHLICK,
  PBR_F_EXACT,
  PBR_DIFF_LAMBERT,
  PBR_DIFF_OREN_NAYAR,
  PBR_DIFF_BURLEY,
  PBR_MR_TEXTURE,
  EMISSIVE,
  FOG,
  SOFT_PARTICLES,
  OUTPUT_DITHER,
  PBR_ENV,
  BILLBOARD,
  BB_VERT_GLSL,
  BB_VERT_WGSL,
  LIGHT_MODELS,
  POST_EFFECTS,
  PBR_D_MODELS,
  PBR_G_MODELS,
  PBR_F_MODELS,
  PBR_DIFF_MODELS,
  PBR_SUB_MODELS,
  pbrMask,
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
  PbrModelChoice,
} from './features.ts'

export { assemble } from './assemble.ts'
export type { AssembledMaterial } from './assemble.ts'

export { materialOf, variantCount, resetMaterials } from './material.ts'
export type { MaterialDesc, Material } from './material.ts'
