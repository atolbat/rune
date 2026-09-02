// @rune/materials — the feature catalog.
//
// A material is a BIT MASK of features, not a shader. Each feature carries
// GLSL and WGSL snippets; the assembler (assemble.ts) stitches them into a
// minimal source pair, and the variant cache (material.ts) keys the result
// by an INTEGER (the mask + skin size) — the Theory D lesson: numeric
// registry keys beat string keys by ~200x on the lookup path.
//
// The catalog is ORDERED (the array order === the bit order): snippets are
// emitted in ascending bit order, and the order is semantic —
//   SKIN / INSTANCED transform the position first,
//   the normal sources (NORMALMAP) and the base color (TEXTURE /
//   FLAT_ALBEDO / VERTEX_COLOR) come next, ALPHA_CUTOFF discards,
//   a light model (LAMBERT, MATCAP or PBR) computes `lit`,
//   and the post effects (EMISSIVE, FOG) mutate `lit` before the single
//   final color write that the assembler appends at the very end.
// The PBR sub-model bits (11..24) are PARAMETERS of PBR, not features:
// they emit nothing of their own — the PBR entry reads them from the mask
// and inlines the chosen formulas (that is what makes the variant minimal:
// a Kelemen material never carries a Smith term).

/** Feature bit (a material = a union of bits). */
export type FeatureBit = number

/** Uniform declared by a feature. GLSL declares the GLSL type; WGSL gets a
 *  struct field of the WGSL type (std140-safe: vec3 uniforms widen to vec4). */
export interface UniformDecl {
  readonly name: string
  /** GLSL declaration, e.g. 'uniform vec3 u_lightDir;' */
  readonly glsl: string
  /** WGSL struct field, e.g. 'u_lightDir : vec4<f32>,' */
  readonly wgsl: string
}

/** Vertex attribute. The SAME name in GLSL and WGSL — a unified vocabulary
 *  (no inPos/position remapping like the hand-written demo shaders had). */
export interface AttrDecl {
  readonly name: string
  readonly glslType: string
  readonly wgslType: string
  /** Instance-step attribute (INSTANCED): one value per instance, not per vertex. */
  readonly instance?: boolean
}

/** Varying: GLSL v_name pair, WGSL VSOut field (explicit names). */
export interface VaryingDecl {
  /** GLSL name, e.g. 'v_normal'. */
  readonly glslName: string
  /** WGSL field name, e.g. 'worldNormal'. */
  readonly wgslName: string
  readonly glslType: string
  readonly wgslType: string
}

/** Assembly context: which features are on (snippets may react). */
export interface AsmCtx {
  readonly mask: number
  readonly jointCount: number
}

/** Vertex-stage snippets of a feature. */
export interface VertSnippets {
  readonly attrs?: readonly AttrDecl[]
  readonly uniforms?: readonly UniformDecl[]
  readonly varyings?: readonly VaryingDecl[]
  /** Lines inside GLSL main() before gl_Position. */
  readonly glslBody?: readonly string[]
  /** Lines inside WGSL vsMain() before `var out : VSOut;` (skin, position4). */
  readonly wgslPre?: readonly string[]
  /** `out.*` writes after `var out : VSOut;`. */
  readonly wgslOut?: readonly string[]
}

/** Fragment-stage snippets of a feature. */
export interface FragSnippets {
  readonly uniforms?: readonly UniformDecl[]
  /** The fragment needs @builtin(front_facing) — DOUBLE_SIDED. */
  readonly frontFacing?: boolean
  /** Lines inside GLSL main(). */
  readonly glslBody?: readonly string[]
  /** Lines inside WGSL fsMain() (the assembler appends the final return). */
  readonly wgslBody?: readonly string[]
}

/** A feature: a bit + snippet providers for both stages. */
export interface FeatureDef {
  /** Stable id for diagnostics. */
  readonly id: string
  readonly bit: FeatureBit
  vert(ctx: AsmCtx): VertSnippets
  frag(ctx: AsmCtx): FragSnippets
}

/** Skeletal skinning: a u_bones[N] palette, 4 influences per vertex.
 *  Joint indices travel as f32 attributes (the shader rounds them to indices). */
export const SKIN: FeatureBit = 1 << 0

/** Instancing: an instance matrix as 4 per-instance vec4 attributes
 *  (i_col0..3 = the columns of mat4(i_col0, i_col1, i_col2, i_col3)).
 *  The instance transform composes AFTER skinning, BEFORE u_mvp. */
export const INSTANCED: FeatureBit = 1 << 1

/** Object-space normal map: the normal comes from a texture (RGB -> object space). */
export const NORMALMAP: FeatureBit = 1 << 2

/** Base color from a texture (uv required). */
export const TEXTURE: FeatureBit = 1 << 3

/** Base color from the u_albedo uniform (no texture). */
export const FLAT_ALBEDO: FeatureBit = 1 << 4

/** Per-vertex color (a vec4 `color` attribute) modulating the base color —
 *  the glTF COLOR0 semantics. */
export const VERTEX_COLOR: FeatureBit = 1 << 5

/** Back faces flip the normal (open geometries: the bust, Mixamo folds). */
export const DOUBLE_SIDED: FeatureBit = 1 << 6

/** MASK alpha: discards fragments with base.a < u_alphaCutoff (BEFORE the
 *  light model — the discard must precede the final color write). */
export const ALPHA_CUTOFF: FeatureBit = 1 << 7

/** Directional Lambert light: ambient + max(dot(n, l), 0).
 *  A LIGHT MODEL — writes `lit`, mutually exclusive with MATCAP / PBR. */
export const LAMBERT: FeatureBit = 1 << 8

/** Matcap shading: the light comes FROM a texture (a pre-lit sphere sampled
 *  by the view-space normal). A LIGHT MODEL — mutually exclusive with
 *  LAMBERT / PBR. */
export const MATCAP: FeatureBit = 1 << 9

/** Cook-Torrance microfacet light model (direct, one directional light).
 *  A LIGHT MODEL — mutually exclusive with LAMBERT / MATCAP.
 *
 *  PBR is itself a FAMILY of models: the distribution D, the geometry term G,
 *  the Fresnel F and the diffuse lobe are each an assembly-time OPTION (one
 *  bit per choice, exactly one per family — assemble.ts validates). The
 *  variant contains only the chosen formulas, in the visibility form
 *  V = G/(4·nDotL·nDotV) with the algebra folded AT ASSEMBLY (an
 *  uber-shader would compute G and divide it back at runtime; here
 *  IMPLICIT folds to the constant 0.25, KELEMEN to 0.25/(vDotH)²,
 *  NEUMANN to 0.25/max(nDotL, nDotV) — no division at all).
 *
 *  Uniforms: u_lightDir + u_lightColor, the camera position u_camPos (the
 *  view vector), u_roughness / u_metallic (or the glTF metallicRoughness
 *  texture via PBR_MR_TEXTURE, multiplied by the uniform factors). */
export const PBR: FeatureBit = 1 << 10

// ── the PBR sub-model bits: parameters OF PBR, not standalone features ──────

/** N D: GGX / Trowbridge-Reitz (Walter 2007) — the default; no
 *  transcendentals (the rational form), matches the Smith family. */
export const PBR_D_GGX: FeatureBit = 1 << 11

/** N D: Beckmann (Walter 2007) — one exp, the classic specular lobe. */
export const PBR_D_BECKMANN: FeatureBit = 1 << 12

/** N D: Blinn-Phong with the Karis GGX-matched exponent mapping — one pow
 *  with a variable exponent (the reason GGX is the default). */
export const PBR_D_BLINN: FeatureBit = 1 << 13

/** G: the EXACT separable Smith for GGX (Walter 2007) — the honest default.
 *  Requires PBR_D_GGX (Smith terms are distribution-specific). */
export const PBR_G_SMITH: FeatureBit = 1 << 14

/** G: Karis's Smith approximation (UE4): k = (roughness+1)²/8 — no sqrt,
 *  the cheapest Smith-class term; pairs with any distribution. */
export const PBR_G_SMITH_SCHLICK: FeatureBit = 1 << 15

/** G: the height-correlated Smith for GGX (Heitz 2014) — the most accurate
 *  masking-shadowing of the family. Requires PBR_D_GGX. */
export const PBR_G_SMITH_HEIGHT: FeatureBit = 1 << 16

/** G: the implicit term (Heitz's taxonomy) — G = nDotL·nDotV, which CANCELS
 *  the Cook-Torrance denominator: V = 0.25, a compile-time constant. */
export const PBR_G_IMPLICIT: FeatureBit = 1 << 17

/** G: Neumann (Heitz's taxonomy) — G = min(nDotL, nDotV) → V = 0.25/max(). */
export const PBR_G_NEUMANN: FeatureBit = 1 << 18

/** G: Kelemen (Kelemen-Szirmay-Kalos 2001) — approximates the original
 *  Cook-Torrance G; V = 0.25/(vDotH)² after the fold. */
export const PBR_G_KELEMEN: FeatureBit = 1 << 19

/** F: the Schlick approximation (1994) — the default; (1−vDotH)⁵ expanded
 *  into three multiplies (pow lowers to exp+log on the GPU). */
export const PBR_F_SCHLICK: FeatureBit = 1 << 20

/** F: the exact unpolarized dielectric Fresnel (Schlick 1994, eq. 23) with
 *  the material index u_ior (η ≥ 1); the metallic branch stays Schlick-tinted
 *  (exact CONDUCTOR Fresnel needs measured complex IOR — out of catalog). */
export const PBR_F_EXACT: FeatureBit = 1 << 21

/** Diffuse: Lambert — albedo/π, the classic floor. */
export const PBR_DIFF_LAMBERT: FeatureBit = 1 << 22

/** Diffuse: the full Oren-Nayar (1994) qualification — rough diffuse with
 *  the azimuthal cosφ term (the spherical identity, not the dot(l,v)
 *  shortcut), σ = roughness·π/2. */
export const PBR_DIFF_OREN_NAYAR: FeatureBit = 1 << 23

/** Diffuse: Disney/Burley (2012) — the two Schlick weights with FD90; the
 *  industry-standard "better than Lambert" (approximates the
 *  Hanrahan-Krueger retro behavior at a fraction of the cost). */
export const PBR_DIFF_BURLEY: FeatureBit = 1 << 24

/** glTF metallicRoughness data source: u_mrTex (WGSL: mrTexture @binding(4)),
 *  G = roughness, B = metallic, multiplied by the u_roughness / u_metallic
 *  factors (the glTF convention). Requires PBR. */
export const PBR_MR_TEXTURE: FeatureBit = 1 << 25

/** Self-illumination: adds u_emissive to `lit` after the light model
 *  (works unlit too — a glowing unshaded surface). */
export const EMISSIVE: FeatureBit = 1 << 26

/** Distance fog: fades `lit` toward u_fogColor between u_fogNear/u_fogFar
 *  (view-space depth — needs the u_view matrix). */
export const FOG: FeatureBit = 1 << 27

/** The light models — exactly one may be present (or none: unlit). */
export const LIGHT_MODELS: FeatureBit = LAMBERT | MATCAP | PBR

/** The post effects — mutate `lit` after the light model. */
export const POST_EFFECTS: FeatureBit = EMISSIVE | FOG

/** The NDF family — exactly one when PBR is on. */
export const PBR_D_MODELS: FeatureBit = PBR_D_GGX | PBR_D_BECKMANN | PBR_D_BLINN

/** The geometry family — exactly one when PBR is on. */
export const PBR_G_MODELS: FeatureBit =
  PBR_G_SMITH | PBR_G_SMITH_SCHLICK | PBR_G_SMITH_HEIGHT |
  PBR_G_IMPLICIT | PBR_G_NEUMANN | PBR_G_KELEMEN

/** The Fresnel family — exactly one when PBR is on. */
export const PBR_F_MODELS: FeatureBit = PBR_F_SCHLICK | PBR_F_EXACT

/** The diffuse family — exactly one when PBR is on. */
export const PBR_DIFF_MODELS: FeatureBit =
  PBR_DIFF_LAMBERT | PBR_DIFF_OREN_NAYAR | PBR_DIFF_BURLEY

/** Every PBR sub-model bit (they mean nothing without PBR itself). */
export const PBR_SUB_MODELS: FeatureBit =
  PBR_D_MODELS | PBR_G_MODELS | PBR_F_MODELS | PBR_DIFF_MODELS

/** The ergonomic PBR choice — the named routes into the sub-model bits.
 *  pbrMask() applies the defaults (ggx / smith / schlick / lambert); OR the
 *  result into the rest of the feature mask. PBR_MR_TEXTURE stays a plain
 *  bit (it is a data source, not a model choice). */
export interface PbrModelChoice {
  /** Specular distribution (NDF). Default 'ggx'. */
  readonly distribution?: 'ggx' | 'beckmann' | 'blinn-phong'
  /** Geometry / masking-shadowing. Default 'smith' (the exact separable form). */
  readonly geometry?: 'smith' | 'smith-schlick' | 'smith-height' | 'implicit' | 'neumann' | 'kelemen'
  /** Fresnel. Default 'schlick'. */
  readonly fresnel?: 'schlick' | 'exact'
  /** Diffuse lobe. Default 'lambert'. */
  readonly diffuse?: 'lambert' | 'oren-nayar' | 'burley'
}

const DISTRIBUTION_BITS: Record<NonNullable<PbrModelChoice['distribution']>, FeatureBit> = {
  'ggx': PBR_D_GGX,
  'beckmann': PBR_D_BECKMANN,
  'blinn-phong': PBR_D_BLINN,
}

const GEOMETRY_BITS: Record<NonNullable<PbrModelChoice['geometry']>, FeatureBit> = {
  'smith': PBR_G_SMITH,
  'smith-schlick': PBR_G_SMITH_SCHLICK,
  'smith-height': PBR_G_SMITH_HEIGHT,
  'implicit': PBR_G_IMPLICIT,
  'neumann': PBR_G_NEUMANN,
  'kelemen': PBR_G_KELEMEN,
}

const FRESNEL_BITS: Record<NonNullable<PbrModelChoice['fresnel']>, FeatureBit> = {
  'schlick': PBR_F_SCHLICK,
  'exact': PBR_F_EXACT,
}

const DIFFUSE_BITS: Record<NonNullable<PbrModelChoice['diffuse']>, FeatureBit> = {
  'lambert': PBR_DIFF_LAMBERT,
  'oren-nayar': PBR_DIFF_OREN_NAYAR,
  'burley': PBR_DIFF_BURLEY,
}

/** The PBR feature with the chosen internal models (defaults: exact
 *  separable Smith-GGX, Schlick Fresnel, Lambert diffuse). */
export function pbrMask(choice: PbrModelChoice = {}): FeatureBit {
  return PBR
    | DISTRIBUTION_BITS[choice.distribution ?? 'ggx']
    | GEOMETRY_BITS[choice.geometry ?? 'smith']
    | FRESNEL_BITS[choice.fresnel ?? 'schlick']
    | DIFFUSE_BITS[choice.diffuse ?? 'lambert']
}

const has = (ctx: AsmCtx, bit: FeatureBit): boolean => (ctx.mask & bit) !== 0

/** `var` when a post effect mutates the binding later, `let` otherwise. */
const mutKw = (ctx: AsmCtx): string => has(ctx, POST_EFFECTS) ? 'var' : 'let'

// ── the normal chain (shared by the light models) ───────────────────────────
//
// The audit notes (why the emitted code looks the way it does):
//   * GLSL/WGSL `*` is LEFT-associative — `A * B * v` would multiply the two
//     MATRICES first (27 mul for 3x3) and only then the vector. The chain is
//     explicitly parenthesized right: 3 × (mat3×vec3) = 27 mul, not 63.
//   * The WGSL side builds mat3x3 from the mat4 columns (free .xyz swizzles)
//     instead of dragging vec4(normal, 0.0) through three mat4 products:
//     48 mul → 27 for SKIN+INSTANCED, 32 → 18 for one of them, 16 → 9 plain.

const M3_MODEL_WGSL = 'mat3x3<f32>(params.u_model[0].xyz, params.u_model[1].xyz, params.u_model[2].xyz)'
const M3_I_WGSL = 'mat3x3<f32>(i_col0.xyz, i_col1.xyz, i_col2.xyz)'
const M3_SKIN_WGSL = 'mat3x3<f32>(skin[0].xyz, skin[1].xyz, skin[2].xyz)'

/** World normal emission shared by the light models (LAMBERT / MATCAP / PBR).
 *  With NORMALMAP the normal comes from the map in the fragment instead. */
function normalVert(ctx: AsmCtx): VertSnippets {
  if (has(ctx, NORMALMAP)) return {}
  const inst = has(ctx, INSTANCED)
  const skin = has(ctx, SKIN)
  // GLSL: mat3(u_model) * (mat3(i_model) * (mat3(skin) * normal)) — the
  // matrix-matrix product never forms (right association, see the audit).
  const glslInner = skin ? '(mat3(skin) * normal)' : 'normal'
  const glslExpr = inst
    ? `mat3(u_model) * (mat3(i_model) * ${glslInner})`
    : `mat3(u_model) * ${glslInner}`
  const wgslInner = skin ? `(${M3_SKIN_WGSL} * normal)` : 'normal'
  const wgslExpr = inst
    ? `${M3_MODEL_WGSL} * (${M3_I_WGSL} * ${wgslInner})`
    : `${M3_MODEL_WGSL} * ${wgslInner}`
  return {
    varyings: [{ glslName: 'v_normal', wgslName: 'worldNormal', glslType: 'vec3', wgslType: 'vec3<f32>' }],
    glslBody: [`v_normal = ${glslExpr};`],
    wgslOut: [`out.worldNormal = ${wgslExpr};`],
  }
}

/** The final position variable of the vertex stage (after skin + instance). */
function posVar(ctx: AsmCtx): string {
  return has(ctx, INSTANCED) ? 'position4Inst' : 'position4'
}

/** Back-face flip of `n` — emitted by whoever owns the normal. */
function flipGlsl(ctx: AsmCtx): string[] {
  return has(ctx, DOUBLE_SIDED) ? ['if (!gl_FrontFacing) n = -n;'] : []
}
function flipWgsl(ctx: AsmCtx): string[] {
  return has(ctx, DOUBLE_SIDED) ? ['n = select(-n, n, frag.ff);'] : []
}

/** `vec3 n` / `var n` from v_normal (the NORMALMAP case owns it already). */
function nGlsl(ctx: AsmCtx): string[] {
  return has(ctx, NORMALMAP) ? [] : ['vec3 n = normalize(v_normal);', ...flipGlsl(ctx)]
}
function nWgsl(ctx: AsmCtx): string[] {
  return has(ctx, NORMALMAP) ? [] : ['var n = normalize(frag.worldNormal);', ...flipWgsl(ctx)]
}

// ── the PBR fragment: the Cook-Torrance framework + the optionable parts ────
//
// Emission contract (both languages, same statement order):
//   n (from the map or the varying) → v, l, h, the dots → rough/metal
//   (uniforms × the optional MR texture) → α, F0 → D → V (folded G) → F →
//   kd → the diffuse lobe → `lit` = (diffuse + D·V·F)·u_lightColor·nDotL.
// The roughness is clamped to [0.045, 1] (Filament's guard): α = 0 makes
// the Smith/Beckmann denominators degenerate (0/0 NaNs on mirrored surfaces).

function pbrUniforms(ctx: AsmCtx): UniformDecl[] {
  const uniforms: UniformDecl[] = [
    { name: 'u_lightDir', glsl: 'uniform vec3 u_lightDir;', wgsl: 'u_lightDir : vec4<f32>,' },
    { name: 'u_lightColor', glsl: 'uniform vec3 u_lightColor;', wgsl: 'u_lightColor : vec4<f32>,' },
    { name: 'u_camPos', glsl: 'uniform vec3 u_camPos;', wgsl: 'u_camPos : vec4<f32>,' },
    { name: 'u_roughness', glsl: 'uniform float u_roughness;', wgsl: 'u_roughness : f32,' },
    { name: 'u_metallic', glsl: 'uniform float u_metallic;', wgsl: 'u_metallic : f32,' },
  ]
  if (has(ctx, PBR_F_EXACT)) {
    uniforms.push({ name: 'u_ior', glsl: 'uniform float u_ior;', wgsl: 'u_ior : f32,' })
  }
  return uniforms
}

/** The framework preamble + the rough/metal sourcing (GLSL lines). */
function pbrGlslPrologue(ctx: AsmCtx): string[] {
  const lines = [
    'vec3 v = normalize(u_camPos - v_worldPos);',
    'vec3 l = normalize(u_lightDir);',
    'vec3 h = normalize(v + l);',
    'float nDotL = max(dot(n, l), 0.0);',
    'float nDotV = max(dot(n, v), 1e-4);',
    'float nDotH = max(dot(n, h), 0.0);',
    'float vDotH = clamp(dot(v, h), 0.0, 1.0);',
  ]
  if (has(ctx, PBR_MR_TEXTURE)) {
    lines.push(
      // glTF metallicRoughness: G = roughness, B = metallic — ONE sample.
      'vec2 mr = texture(u_mrTex, v_uv).gb;',
      'float rough = clamp(u_roughness * mr.x, 0.045, 1.0);',
      'float metal = clamp(u_metallic * mr.y, 0.0, 1.0);',
    )
  } else {
    lines.push(
      'float rough = clamp(u_roughness, 0.045, 1.0);',
      'float metal = clamp(u_metallic, 0.0, 1.0);',
    )
  }
  lines.push(
    'float a = rough * rough;',
    'float a2 = a * a;',
    'vec3 F0 = mix(vec3(0.04), base.rgb, metal);',
  )
  return lines
}

/** Same prologue in WGSL (let-bindings, params./frag. accesses). */
function pbrWgslPrologue(ctx: AsmCtx): string[] {
  const lines = [
    'let v = normalize(params.u_camPos.xyz - frag.worldPos);',
    'let l = normalize(params.u_lightDir.xyz);',
    'let h = normalize(v + l);',
    'let nDotL = max(dot(n, l), 0.0);',
    'let nDotV = max(dot(n, v), 1e-4);',
    'let nDotH = max(dot(n, h), 0.0);',
    'let vDotH = clamp(dot(v, h), 0.0, 1.0);',
  ]
  if (has(ctx, PBR_MR_TEXTURE)) {
    lines.push(
      'let mr = textureSample(mrTexture, texSampler, frag.uv).gb;',
      'let rough = clamp(params.u_roughness * mr.x, 0.045, 1.0);',
      'let metal = clamp(params.u_metallic * mr.y, 0.0, 1.0);',
    )
  } else {
    lines.push(
      'let rough = clamp(params.u_roughness, 0.045, 1.0);',
      'let metal = clamp(params.u_metallic, 0.0, 1.0);',
    )
  }
  lines.push(
    'let a = rough * rough;',
    'let a2 = a * a;',
    'let F0 = mix(vec3<f32>(0.04), base.rgb, metal);',
  )
  return lines
}

/** D — the normal distribution. α² is a2; 1/π = 0.318309886, 1/(2π) = 0.15915494. */
function pbrDGlsl(ctx: AsmCtx): string[] {
  if (has(ctx, PBR_D_GGX)) {
    return [
      'float dd = nDotH * nDotH * (a2 - 1.0) + 1.0;',
      'float D = a2 / (3.14159265 * dd * dd);',
    ]
  }
  if (has(ctx, PBR_D_BECKMANN)) {
    return [
      'float nh2 = nDotH * nDotH;',
      'float D = exp((nh2 - 1.0) / (a2 * nh2)) / (3.14159265 * a2 * nh2 * nh2);',
    ]
  }
  return [
    // Karis's GGX-matched exponent: e = 2/α² − 2
    'float blinnExp = 2.0 / a2 - 2.0;',
    'float D = (blinnExp + 2.0) * 0.15915494 * pow(nDotH, blinnExp);',
  ]
}

function pbrDWgsl(ctx: AsmCtx): string[] {
  if (has(ctx, PBR_D_GGX)) {
    return [
      'let dd = nDotH * nDotH * (a2 - 1.0) + 1.0;',
      'let D = a2 / (3.14159265 * dd * dd);',
    ]
  }
  if (has(ctx, PBR_D_BECKMANN)) {
    return [
      'let nh2 = nDotH * nDotH;',
      'let D = exp((nh2 - 1.0) / (a2 * nh2)) / (3.14159265 * a2 * nh2 * nh2);',
    ]
  }
  return [
    'let blinnExp = 2.0 / a2 - 2.0;',
    'let D = (blinnExp + 2.0) * 0.15915494 * pow(nDotH, blinnExp);',
  ]
}

/** The two Λ helpers of the exact Smith family (√(1 + α²(1−x²)/x²)). The
 *  nDotL division is floored at 1e-8: at exactly 0 the term must read
 *  "fully masked" (vis → 0), not NaN. */
const SMITH_SQ_GLSL: string[] = [
  'float sqL = sqrt(1.0 + a2 * (1.0 - nDotL * nDotL) / max(nDotL * nDotL, 1e-8));',
  'float sqV = sqrt(1.0 + a2 * (1.0 - nDotV * nDotV) / (nDotV * nDotV));',
]
const SMITH_SQ_WGSL: string[] = [
  'let sqL = sqrt(1.0 + a2 * (1.0 - nDotL * nDotL) / max(nDotL * nDotL, 1e-8));',
  'let sqV = sqrt(1.0 + a2 * (1.0 - nDotV * nDotV) / (nDotV * nDotV));',
]

/** V — the geometry term, emitted in the folded visibility form G/(4·nDotL·nDotV). */
function pbrVGlsl(ctx: AsmCtx): string[] {
  if (has(ctx, PBR_G_SMITH)) {
    // Walter's separable Smith-GGX: G1 = 2x/(1+√(1+α²(1−x²)/x²)) — the
    // 2·nDotL·2·nDotV of G1(l)·G1(v) cancels the 4·nDotL·nDotV denominator
    // EXACTLY; the assembly emits only the folded remainder.
    return [...SMITH_SQ_GLSL, 'float vis = 1.0 / ((1.0 + sqL) * (1.0 + sqV));']
  }
  if (has(ctx, PBR_G_SMITH_HEIGHT)) {
    // Heitz 2014: G = 1/(1+Λ(l)+Λ(v)) — the height-correlated form.
    return [
      ...SMITH_SQ_GLSL,
      'float lamL = (sqL - 1.0) * 0.5;',
      'float lamV = (sqV - 1.0) * 0.5;',
      'float vis = 1.0 / max(4.0 * nDotL * nDotV * (1.0 + lamL + lamV), 1e-8);',
    ]
  }
  if (has(ctx, PBR_G_SMITH_SCHLICK)) {
    // Karis (UE4): k = (roughness+1)²/8; the nDotL·nDotV numerator cancels
    // against the denominator after the fold.
    return [
      'float kk = (rough + 1.0) * (rough + 1.0) * 0.125;',
      'float vis = 0.25 / ((nDotL * (1.0 - kk) + kk) * (nDotV * (1.0 - kk) + kk));',
    ]
  }
  if (has(ctx, PBR_G_IMPLICIT)) {
    // G = nDotL·nDotV — the denominator cancels to the constant 0.25.
    return ['float vis = 0.25;']
  }
  if (has(ctx, PBR_G_NEUMANN)) {
    return ['float vis = 0.25 / max(nDotL, nDotV);']
  }
  // Kelemen: G = nDotL·nDotV/(vDotH)² → V = 1/(4·vDotH²).
  return ['float vis = 0.25 / max(vDotH * vDotH, 1e-8);']
}

function pbrVWgsl(ctx: AsmCtx): string[] {
  if (has(ctx, PBR_G_SMITH)) {
    return [...SMITH_SQ_WGSL, 'let vis = 1.0 / ((1.0 + sqL) * (1.0 + sqV));']
  }
  if (has(ctx, PBR_G_SMITH_HEIGHT)) {
    return [
      ...SMITH_SQ_WGSL,
      'let lamL = (sqL - 1.0) * 0.5;',
      'let lamV = (sqV - 1.0) * 0.5;',
      'let vis = 1.0 / max(4.0 * nDotL * nDotV * (1.0 + lamL + lamV), 1e-8);',
    ]
  }
  if (has(ctx, PBR_G_SMITH_SCHLICK)) {
    return [
      'let kk = (rough + 1.0) * (rough + 1.0) * 0.125;',
      'let vis = 0.25 / ((nDotL * (1.0 - kk) + kk) * (nDotV * (1.0 - kk) + kk));',
    ]
  }
  if (has(ctx, PBR_G_IMPLICIT)) {
    return ['let vis = 0.25;']
  }
  if (has(ctx, PBR_G_NEUMANN)) {
    return ['let vis = 0.25 / max(nDotL, nDotV);']
  }
  return ['let vis = 0.25 / max(vDotH * vDotH, 1e-8);']
}

/** The Schlick weight (1−vDotH)⁵ as three multiplies — pow(x, 5) lowers to
 *  exp+log on every GPU (two transcendentals + rounding); x²·x²·x is three
 *  FMAs. (Desktop drivers make this rewrite for constant exponents
 *  themselves; mobile ones frequently do not.) */
const SCHLICK_GLSL: string[] = [
  'float fT = 1.0 - vDotH;',
  'float fT2 = fT * fT;',
  'float fT4 = fT2 * fT2;',
  'float fT5 = fT4 * fT;',
]
const SCHLICK_WGSL: string[] = [
  'let fT = 1.0 - vDotH;',
  'let fT2 = fT * fT;',
  'let fT4 = fT2 * fT2;',
  'let fT5 = fT4 * fT;',
]

function pbrFGlsl(ctx: AsmCtx): string[] {
  if (has(ctx, PBR_F_EXACT)) {
    return [
      ...SCHLICK_GLSL,
      // The exact unpolarized dielectric Fresnel (η = u_ior ≥ 1; the
      // metallic branch stays Schlick — colored F0 from the albedo).
      'float fC = vDotH;',
      'float fG = sqrt(max(u_ior * u_ior + fC * fC - 1.0, 0.0));',
      'float fQ = (fG - fC) / max(fG + fC, 1e-8);',
      'float fP = (fC * (fG + fC) - 1.0) / (fC * (fG - fC) + 1.0);',
      'float fDia = 0.5 * fQ * fQ * (1.0 + fP * fP);',
      'vec3 F = mix(vec3(fDia), F0 + (vec3(1.0) - F0) * fT5, metal);',
    ]
  }
  return [...SCHLICK_GLSL, 'vec3 F = F0 + (vec3(1.0) - F0) * fT5;']
}

function pbrFWgsl(ctx: AsmCtx): string[] {
  if (has(ctx, PBR_F_EXACT)) {
    return [
      ...SCHLICK_WGSL,
      'let fC = vDotH;',
      'let fG = sqrt(max(params.u_ior * params.u_ior + fC * fC - 1.0, 0.0));',
      'let fQ = (fG - fC) / max(fG + fC, 1e-8);',
      'let fP = (fC * (fG + fC) - 1.0) / (fC * (fG - fC) + 1.0);',
      'let fDia = 0.5 * fQ * fQ * (1.0 + fP * fP);',
      'let F = mix(vec3<f32>(fDia), F0 + (vec3<f32>(1.0) - F0) * fT5, metal);',
    ]
  }
  return [...SCHLICK_WGSL, 'let F = F0 + (vec3<f32>(1.0) - F0) * fT5;']
}

/** The diffuse lobe (kd — the energy-conservation factor — comes first). */
function pbrDiffuseGlsl(ctx: AsmCtx): string[] {
  const kd = 'vec3 kd = (1.0 - metal) * (vec3(1.0) - F);'
  if (has(ctx, PBR_DIFF_OREN_NAYAR)) {
    return [
      kd,
      // Oren-Nayar 1994: σ = roughness·π/2; cosφ via the spherical identity
      // dot(l,v) = nL·nV + sinθl·sinθv·cosφ (NOT the dot(l,v) shortcut);
      // α = the larger polar angle, β = the smaller one.
      'float sigma = rough * 1.57079632;',
      'float s2 = sigma * sigma;',
      'float A = 1.0 - 0.5 * s2 / (s2 + 0.33);',
      'float B = 0.45 * s2 / (s2 + 0.09);',
      'float cosPhi = clamp((dot(l, v) - nDotL * nDotV) * inversesqrt(max((1.0 - nDotL * nDotL) * (1.0 - nDotV * nDotV), 1e-4)), 0.0, 1.0);',
      'float cm = min(nDotL, nDotV);',
      'float cb = max(nDotL, nDotV);',
      'float sa = sqrt(max(1.0 - cm * cm, 0.0));',
      'float tb = sqrt(max(1.0 - cb * cb, 0.0)) / cb;',
      'vec3 diffuse = kd * base.rgb * (A + B * cosPhi * sa * tb) * 0.318309886;',
    ]
  }
  if (has(ctx, PBR_DIFF_BURLEY)) {
    return [
      kd,
      // Disney/Burley 2012: two Schlick weights, FD90 = 0.5 + 2·vDotH²·r.
      'float FD90 = 0.5 + 2.0 * vDotH * vDotH * rough;',
      'float lT = 1.0 - nDotL;',
      'float lT2 = lT * lT;',
      'float lT4 = lT2 * lT2;',
      'float lT5 = lT4 * lT;',
      'float vT = 1.0 - nDotV;',
      'float vT2 = vT * vT;',
      'float vT4 = vT2 * vT2;',
      'float vT5 = vT4 * vT;',
      'vec3 diffuse = kd * base.rgb * (1.0 + (FD90 - 1.0) * lT5) * (1.0 + (FD90 - 1.0) * vT5) * 0.318309886;',
    ]
  }
  return [kd, 'vec3 diffuse = kd * base.rgb * 0.318309886;']
}

function pbrDiffuseWgsl(ctx: AsmCtx): string[] {
  const kd = 'let kd = (1.0 - metal) * (vec3<f32>(1.0) - F);'
  if (has(ctx, PBR_DIFF_OREN_NAYAR)) {
    return [
      kd,
      'let sigma = rough * 1.57079632;',
      'let s2 = sigma * sigma;',
      'let A = 1.0 - 0.5 * s2 / (s2 + 0.33);',
      'let B = 0.45 * s2 / (s2 + 0.09);',
      'let cosPhi = clamp((dot(l, v) - nDotL * nDotV) * inversesqrt(max((1.0 - nDotL * nDotL) * (1.0 - nDotV * nDotV), 1e-4)), 0.0, 1.0);',
      'let cm = min(nDotL, nDotV);',
      'let cb = max(nDotL, nDotV);',
      'let sa = sqrt(max(1.0 - cm * cm, 0.0));',
      'let tb = sqrt(max(1.0 - cb * cb, 0.0)) / cb;',
      'let diffuse = kd * base.rgb * (A + B * cosPhi * sa * tb) * 0.318309886;',
    ]
  }
  if (has(ctx, PBR_DIFF_BURLEY)) {
    return [
      kd,
      'let FD90 = 0.5 + 2.0 * vDotH * vDotH * rough;',
      'let lT = 1.0 - nDotL;',
      'let lT2 = lT * lT;',
      'let lT4 = lT2 * lT2;',
      'let lT5 = lT4 * lT;',
      'let vT = 1.0 - nDotV;',
      'let vT2 = vT * vT;',
      'let vT4 = vT2 * vT2;',
      'let vT5 = vT4 * vT;',
      'let diffuse = kd * base.rgb * (1.0 + (FD90 - 1.0) * lT5) * (1.0 + (FD90 - 1.0) * vT5) * 0.318309886;',
    ]
  }
  return [kd, 'let diffuse = kd * base.rgb * 0.318309886;']
}

/** The catalog: array index === bit index (ascending bit = emission order).
 *  The PBR sub-model bits 11..24 have no entries — they are parameters of
 *  the PBR feature, which reads them from the mask (see the header). */
export const CATALOG: readonly FeatureDef[] = [
  {
    id: 'skin',
    bit: SKIN,
    vert: (ctx: AsmCtx): VertSnippets => ({
      attrs: [
        { name: 'joints', glslType: 'vec4', wgslType: 'vec4<f32>' },
        { name: 'weights', glslType: 'vec4', wgslType: 'vec4<f32>' },
      ],
      uniforms: [{
        name: 'u_bones',
        glsl: `uniform mat4 u_bones[${ctx.jointCount}];`,
        wgsl: `u_bones : array<mat4x4<f32>, ${ctx.jointCount}>,`,
      }],
      glslBody: [
        'mat4 skin =',
        '    u_bones[int(joints.x + 0.5)] * weights.x',
        '  + u_bones[int(joints.y + 0.5)] * weights.y',
        '  + u_bones[int(joints.z + 0.5)] * weights.z',
        '  + u_bones[int(joints.w + 0.5)] * weights.w;',
        'vec4 position4 = skin * vec4(position, 1.0);',
      ],
      wgslPre: [
        'let skin =',
        '    params.u_bones[u32(joints.x + 0.5)] * weights.x',
        '  + params.u_bones[u32(joints.y + 0.5)] * weights.y',
        '  + params.u_bones[u32(joints.z + 0.5)] * weights.z',
        '  + params.u_bones[u32(joints.w + 0.5)] * weights.w;',
        'let position4 = skin * vec4<f32>(position, 1.0);',
      ],
    }),
    frag: (_ctx: AsmCtx): FragSnippets => ({}),
  },
  {
    id: 'instanced',
    bit: INSTANCED,
    vert: (_ctx: AsmCtx): VertSnippets => ({
      attrs: [
        { name: 'i_col0', glslType: 'vec4', wgslType: 'vec4<f32>', instance: true },
        { name: 'i_col1', glslType: 'vec4', wgslType: 'vec4<f32>', instance: true },
        { name: 'i_col2', glslType: 'vec4', wgslType: 'vec4<f32>', instance: true },
        { name: 'i_col3', glslType: 'vec4', wgslType: 'vec4<f32>', instance: true },
      ],
      glslBody: [
        'mat4 i_model = mat4(i_col0, i_col1, i_col2, i_col3);',
        'vec4 position4Inst = i_model * position4;',
      ],
      wgslPre: [
        'let i_model = mat4x4<f32>(i_col0, i_col1, i_col2, i_col3);',
        'let position4Inst = i_model * position4;',
      ],
    }),
    frag: (_ctx: AsmCtx): FragSnippets => ({}),
  },
  {
    id: 'normalmap',
    bit: NORMALMAP,
    vert: (_ctx: AsmCtx): VertSnippets => ({
      varyings: [{ glslName: 'v_uv', wgslName: 'uv', glslType: 'vec2', wgslType: 'vec2<f32>' }],
      glslBody: ['v_uv = uv;'],
      wgslOut: ['out.uv = uv;'],
    }),
    frag: (ctx: AsmCtx): FragSnippets => ({
      glslBody: [
        'vec3 n = normalize(mat3(u_model) * (texture(u_normalMap, v_uv).xyz * 2.0 - 1.0));',
        ...flipGlsl(ctx),
      ],
      wgslBody: [
        'let nObj = textureSample(nrmTexture, texSampler, frag.uv).xyz * 2.0 - 1.0;',
        'var n = normalize((params.u_model * vec4<f32>(nObj, 0.0)).xyz);',
        ...flipWgsl(ctx),
      ],
    }),
  },
  {
    id: 'texture',
    bit: TEXTURE,
    vert: (_ctx: AsmCtx): VertSnippets => ({
      varyings: [{ glslName: 'v_uv', wgslName: 'uv', glslType: 'vec2', wgslType: 'vec2<f32>' }],
      glslBody: ['v_uv = uv;'],
      wgslOut: ['out.uv = uv;'],
    }),
    frag: (ctx: AsmCtx): FragSnippets => ({
      glslBody: [`vec4 base = texture(u_tex, v_uv);`],
      wgslBody: [`${has(ctx, VERTEX_COLOR) ? 'var' : 'let'} base = textureSample(texTexture, texSampler, frag.uv);`],
    }),
  },
  {
    id: 'flatAlbedo',
    bit: FLAT_ALBEDO,
    vert: (_ctx: AsmCtx): VertSnippets => ({}),
    frag: (ctx: AsmCtx): FragSnippets => ({
      uniforms: [
        { name: 'u_albedo', glsl: 'uniform vec3 u_albedo;', wgsl: 'u_albedo : vec4<f32>,' },
      ],
      glslBody: ['vec4 base = vec4(u_albedo, 1.0);'],
      wgslBody: [`${has(ctx, VERTEX_COLOR) ? 'var' : 'let'} base = vec4<f32>(params.u_albedo.rgb, 1.0);`],
    }),
  },
  {
    id: 'vertexColor',
    bit: VERTEX_COLOR,
    vert: (_ctx: AsmCtx): VertSnippets => ({
      attrs: [{ name: 'color', glslType: 'vec4', wgslType: 'vec4<f32>' }],
      varyings: [{ glslName: 'v_color', wgslName: 'color', glslType: 'vec4', wgslType: 'vec4<f32>' }],
      glslBody: ['v_color = color;'],
      wgslOut: ['out.color = color;'],
    }),
    frag: (_ctx: AsmCtx): FragSnippets => ({
      glslBody: ['base *= v_color;'],
      wgslBody: ['base = base * frag.color;'],
    }),
  },
  {
    id: 'doubleSided',
    bit: DOUBLE_SIDED,
    vert: (_ctx: AsmCtx): VertSnippets => ({}),
    // The flip itself is emitted by the normal sources (they own `n`);
    // here we only request @builtin(front_facing) in the fragment input.
    frag: (_ctx: AsmCtx): FragSnippets => ({ frontFacing: true }),
  },
  {
    id: 'alphaCutoff',
    bit: ALPHA_CUTOFF,
    vert: (_ctx: AsmCtx): VertSnippets => ({}),
    frag: (_ctx: AsmCtx): FragSnippets => ({
      uniforms: [
        { name: 'u_alphaCutoff', glsl: 'uniform float u_alphaCutoff;', wgsl: 'u_alphaCutoff : f32,' },
      ],
      glslBody: ['if (base.a < u_alphaCutoff) discard;'],
      wgslBody: ['if (base.a < params.u_alphaCutoff) { discard; }'],
    }),
  },
  {
    id: 'lambert',
    bit: LAMBERT,
    vert: (ctx: AsmCtx): VertSnippets => normalVert(ctx),
    frag: (ctx: AsmCtx): FragSnippets => ({
      uniforms: [
        { name: 'u_lightDir', glsl: 'uniform vec3 u_lightDir;', wgsl: 'u_lightDir : vec4<f32>,' },
      ],
      glslBody: [
        ...nGlsl(ctx),
        'float lambert = max(dot(n, normalize(u_lightDir)), 0.0);',
        // The demo-tuned ambient terms, kept bit-for-bit: the object-space
        // normal-map surface is the deepest (0.22), a plain texture softer
        // (0.35), a flat albedo the brightest floor (0.3).
        has(ctx, NORMALMAP) ? 'vec3 lit = base.rgb * (0.22 + 0.78 * lambert);'
          : has(ctx, TEXTURE) ? 'vec3 lit = base.rgb * (0.35 + 0.65 * lambert);'
            : 'vec3 lit = base.rgb * (0.3 + 0.7 * lambert);',
      ],
      wgslBody: [
        ...nWgsl(ctx),
        // `n` is normalized at its declaration (the DOUBLE_SIDED flip of a
        // unit vector is unit) — no second normalize here (the audit fix).
        'let lambert = max(dot(n, normalize(params.u_lightDir.xyz)), 0.0);',
        has(ctx, NORMALMAP) ? `${mutKw(ctx)} lit = base.rgb * (0.22 + 0.78 * lambert);`
          : has(ctx, TEXTURE) ? `${mutKw(ctx)} lit = base.rgb * (0.35 + 0.65 * lambert);`
            : `${mutKw(ctx)} lit = base.rgb * (0.3 + 0.7 * lambert);`,
      ],
    }),
  },
  {
    id: 'matcap',
    bit: MATCAP,
    vert: (ctx: AsmCtx): VertSnippets => normalVert(ctx),
    frag: (ctx: AsmCtx): FragSnippets => ({
      uniforms: [
        { name: 'u_view', glsl: 'uniform mat4 u_view;', wgsl: 'u_view : mat4x4<f32>,' },
      ],
      glslBody: [
        ...nGlsl(ctx),
        'vec3 nView = normalize(mat3(u_view) * n);',
        'vec2 matcapUv = nView.xy * 0.5 + 0.5;',
        'vec3 lit = base.rgb * texture(u_matcap, matcapUv).rgb;',
      ],
      wgslBody: [
        ...nWgsl(ctx),
        'let nView = normalize((params.u_view * vec4<f32>(n, 0.0)).xyz);',
        'let matcapUv = vec2<f32>(nView.x * 0.5 + 0.5, nView.y * 0.5 + 0.5);',
        'let mc = textureSample(matTexture, texSampler, matcapUv).rgb;',
        `${mutKw(ctx)} lit = base.rgb * mc;`,
      ],
    }),
  },
  {
    id: 'pbr',
    bit: PBR,
    vert: (ctx: AsmCtx): VertSnippets => {
      const nv = normalVert(ctx)
      return {
        ...nv,
        varyings: [
          ...(nv.varyings ?? []),
          { glslName: 'v_worldPos', wgslName: 'worldPos', glslType: 'vec3', wgslType: 'vec3<f32>' },
        ],
        glslBody: [...(nv.glslBody ?? []), `v_worldPos = (u_model * ${posVar(ctx)}).xyz;`],
        wgslOut: [...(nv.wgslOut ?? []), `out.worldPos = (params.u_model * ${posVar(ctx)}).xyz;`],
      }
    },
    frag: (ctx: AsmCtx): FragSnippets => ({
      uniforms: pbrUniforms(ctx),
      glslBody: [
        ...nGlsl(ctx),
        ...pbrGlslPrologue(ctx),
        ...pbrDGlsl(ctx),
        ...pbrVGlsl(ctx),
        ...pbrFGlsl(ctx),
        ...pbrDiffuseGlsl(ctx),
        'vec3 lit = (diffuse + (D * vis) * F) * u_lightColor * nDotL;',
      ],
      wgslBody: [
        ...nWgsl(ctx),
        ...pbrWgslPrologue(ctx),
        ...pbrDWgsl(ctx),
        ...pbrVWgsl(ctx),
        ...pbrFWgsl(ctx),
        ...pbrDiffuseWgsl(ctx),
        `${mutKw(ctx)} lit = (diffuse + (D * vis) * F) * params.u_lightColor.rgb * nDotL;`,
      ],
    }),
  },
  {
    id: 'mrTexture',
    bit: PBR_MR_TEXTURE,
    // The uv varying (TEXTURE / NORMALMAP emit it too — this entry fills the
    // gap for FLAT_ALBEDO + MR combinations); the sampling itself lives in
    // the PBR body, which owns the rough/metal sourcing order.
    vert: (ctx: AsmCtx): VertSnippets =>
      has(ctx, TEXTURE | NORMALMAP) ? {} : {
        varyings: [{ glslName: 'v_uv', wgslName: 'uv', glslType: 'vec2', wgslType: 'vec2<f32>' }],
        glslBody: ['v_uv = uv;'],
        wgslOut: ['out.uv = uv;'],
      },
    frag: (_ctx: AsmCtx): FragSnippets => ({}),
  },
  {
    id: 'emissive',
    bit: EMISSIVE,
    vert: (_ctx: AsmCtx): VertSnippets => ({}),
    frag: (_ctx: AsmCtx): FragSnippets => ({
      uniforms: [
        { name: 'u_emissive', glsl: 'uniform vec3 u_emissive;', wgsl: 'u_emissive : vec4<f32>,' },
      ],
      glslBody: ['lit += u_emissive;'],
      wgslBody: ['lit += params.u_emissive.rgb;'],
    }),
  },
  {
    id: 'fog',
    bit: FOG,
    vert: (ctx: AsmCtx): VertSnippets => ({
      uniforms: [
        { name: 'u_view', glsl: 'uniform mat4 u_view;', wgsl: 'u_view : mat4x4<f32>,' },
      ],
      varyings: [{ glslName: 'v_viewZ', wgslName: 'viewZ', glslType: 'float', wgslType: 'f32' }],
      // Audit: right association — u_view * (u_model * pos) is 32 mults,
      // (u_view * u_model) * pos is 48 (the GLSL/WGSL * is left-assoc and
      // compilers may not reassociate float math). The negation lives here
      // too: one per VERTEX instead of one per fragment.
      glslBody: [`v_viewZ = -(u_view * (u_model * ${posVar(ctx)})).z;`],
      wgslOut: [`out.viewZ = -(params.u_view * (params.u_model * ${posVar(ctx)})).z;`],
    }),
    frag: (_ctx: AsmCtx): FragSnippets => ({
      uniforms: [
        { name: 'u_fogColor', glsl: 'uniform vec3 u_fogColor;', wgsl: 'u_fogColor : vec4<f32>,' },
        { name: 'u_fogNear', glsl: 'uniform float u_fogNear;', wgsl: 'u_fogNear : f32,' },
        { name: 'u_fogFar', glsl: 'uniform float u_fogFar;', wgsl: 'u_fogFar : f32,' },
      ],
      glslBody: [
        'float fogFactor = clamp((v_viewZ - u_fogNear) / (u_fogFar - u_fogNear), 0.0, 1.0);',
        'lit = mix(lit, u_fogColor, fogFactor);',
      ],
      wgslBody: [
        'let fogFactor = clamp((frag.viewZ - params.u_fogNear) / (params.u_fogFar - params.u_fogNear), 0.0, 1.0);',
        'lit = mix(lit, params.u_fogColor.rgb, fogFactor);',
      ],
    }),
  },
]
