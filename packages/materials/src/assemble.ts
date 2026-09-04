// @rune/materials — the assembler: a feature mask → a minimal source pair.
//
// NOT an uber-shader: each variant contains ONLY the code its features need
// (a skinned-64-joint material and an unlit-textured one share nothing but
// the two mat4s). Assembly is one-shot per variant and cached upstream
// (material.ts); this module is pure — the hot path (a cache hit) never
// lands here.
//
// MEMORY CONTRACT — how the sources are glued (the "no ghost blocks" rule):
//   * exactly ONE final string per stage leaves this module (vertex / fragment
//     / wgsl) — produced by a single join, never by `a + b + c` chains that
//     rope-flatten into intermediate blocks;
//   * the line buffers, the parts lists and the declaration registries are
//     MODULE-LEVEL SCRATCH, reset per assembly and shared by every variant —
//     a cold batch of N variants does not churn N × ~100 array objects;
//   * there are NO per-line indent copies: the 2-space indentation comes from
//     the join separator ('\n  '), so the only strings allocated per variant
//     are the ones that end up inside the final sources.
//
// Naming conventions (unified across GLSL and WGSL):
//   attributes  position | normal | uv | color | joints | weights | i_col0..3
//   uniforms    u_mvp, u_model (always) + feature uniforms
//   WGSL        one Params struct @group(0) @binding(0) (all uniforms);
//               textures @group(1): texSampler@0, texTexture@1, nrmTexture@2,
//               matTexture@3, mrTexture@4
//
// The fragment stage computes `lit` (LAMBERT, MATCAP or PBR — or plain
// base.rgb), the post effects (EMISSIVE, FOG) mutate it, and the assembler
// appends the SINGLE final color write. A pure unlit variant keeps the
// direct shape `o_color = base;` / `return base;`.

import {
  ALPHA_CUTOFF,
  BB_VERT_GLSL,
  BB_VERT_WGSL,
  BILLBOARD,
  CATALOG,
  EMISSIVE,
  FLAT_ALBEDO,
  FOG,
  INSTANCED,
  LAMBERT,
  MATCAP,
  NORMALMAP,
  PBR,
  PBR_D_GGX,
  PBR_D_MODELS,
  PBR_DIFF_MODELS,
  PBR_F_MODELS,
  PBR_G_SMITH,
  PBR_G_SMITH_HEIGHT,
  PBR_G_MODELS,
  PBR_MR_TEXTURE,
  PBR_SUB_MODELS,
  PBR_ENV,
  SKIN,
  SOFT_PARTICLES,
  OUTPUT_DITHER,
  TEXTURE,
  VERTEX_COLOR,
  type AsmCtx,
  type AttrDecl,
  type UniformDecl,
  type VaryingDecl,
} from './features.ts'

/** Assembled variant: ready for both compile pipelines. */
export interface AssembledMaterial {
  /** The feature mask (the cache key part). */
  readonly mask: number
  /** Skin palette size (0 — no SKIN feature). */
  readonly jointCount: number
  readonly glsl: { readonly vertex: string; readonly fragment: string }
  readonly wgsl: string
  /** Attributes in binding order (GLSL locations = WGSL @location, dense). */
  readonly attributes: readonly AttrDecl[]
  /** Non-sampler uniforms (name + types); the order = the WGSL struct order. */
  readonly uniforms: readonly UniformDecl[]
  /** Sampler names of the GLSL fragment (u_tex / u_normalMap / u_matcap). */
  readonly samplers: readonly string[]
}

// ── the scratch: reused by every assembly (see the memory contract) ─────────
const sc = {
  vertUniforms: [] as UniformDecl[],
  fragUniforms: [] as UniformDecl[],
  attrs: [] as AttrDecl[],
  varyings: [] as VaryingDecl[],
  vertGlsl: [] as string[],
  vertWgslPre: [] as string[],
  vertWgslOut: [] as string[],
  fragGlsl: [] as string[],
  fragWgsl: [] as string[],
  vertBody: [] as string[],
  vertParts: [] as string[],
  fragParts: [] as string[],
  wgslParts: [] as string[],
  uniforms: [] as UniformDecl[], // the deduped vert+frag order (WGSL struct)
  samplers: [] as string[],
}

/** Assembles the variant for a mask. Throws on invalid combinations. */
export function assemble(mask: number, jointCount: number): AssembledMaterial {
  validate(mask, jointCount)
  const ctx: AsmCtx = { mask, jointCount }
  resetScratch()

  const billboard = (mask & BILLBOARD) !== 0
  const needsNormal = !billboard && (mask & (LAMBERT | MATCAP | PBR)) !== 0 && (mask & NORMALMAP) === 0
  const needsUv = !billboard && (mask & (TEXTURE | NORMALMAP | PBR_MR_TEXTURE)) !== 0
  if (!billboard) {
    sc.attrs.push({ name: 'position', glslType: 'vec3', wgslType: 'vec3<f32>' })
    if (needsNormal) sc.attrs.push({ name: 'normal', glslType: 'vec3', wgslType: 'vec3<f32>' })
    if (needsUv) sc.attrs.push({ name: 'uv', glslType: 'vec2', wgslType: 'vec2<f32>' })
  }

  const hasLight = (mask & (LAMBERT | MATCAP | PBR)) !== 0
  const hasPost = (mask & (EMISSIVE | FOG)) !== 0
  let litFallback = false

  // ── collect snippets in catalog order (ascending bit = semantic order) ──
  for (const feature of CATALOG) {
    if ((mask & feature.bit) === 0) continue
    // The unlit fallback must exist before the first post effect touches `lit`.
    if (!hasLight && !litFallback && (feature.bit === EMISSIVE || feature.bit === FOG)) {
      sc.fragGlsl.push('vec3 lit = base.rgb;')
      sc.fragWgsl.push('var lit = base.rgb;')
      litFallback = true
    }
    const v = feature.vert(ctx)
    if (v.uniforms !== undefined) appendUnique(sc.vertUniforms, v.uniforms, byName)
    if (v.attrs !== undefined) appendUnique(sc.attrs, v.attrs, byName)
    if (v.varyings !== undefined) appendUnique(sc.varyings, v.varyings, item => item.glslName)
    if (v.glslBody !== undefined) sc.vertGlsl.push(...v.glslBody)
    if (v.wgslPre !== undefined) sc.vertWgslPre.push(...v.wgslPre)
    if (v.wgslOut !== undefined) sc.vertWgslOut.push(...v.wgslOut)
    const f = feature.frag(ctx)
    if (f.uniforms !== undefined) appendUnique(sc.fragUniforms, f.uniforms, byName)
    if (f.glslBody !== undefined) sc.fragGlsl.push(...f.glslBody)
    if (f.wgslBody !== undefined) sc.fragWgsl.push(...f.wgslBody)
    if (f.frontFacing === true) frontFacing = true
    if (f.fragPosition === true) fragPosition = true
  }

  // The default position expression: SKIN declares its own position4; every
  // other combination starts from the raw attribute. INSTANCED rewraps it.
  // Task 131 — BILLBOARD REPLACES the position source entirely: the
  // preamble (emitted FIRST, before the features' varying writes — they
  // reference bbUv/i_color) unpacks the instance record, expands the
  // 6-corner quad from gl_VertexID across all five orientation modes and
  // leaves `bbWorld`; the final line multiplies THAT.
  const pos = billboard ? 'vec4(bbWorld, 1.0)' : (mask & INSTANCED) !== 0 ? 'position4Inst' : 'position4'
  const posWgsl = billboard ? 'vec4<f32>(bbWorld, 1.0)' : (mask & INSTANCED) !== 0 ? 'position4Inst' : 'position4'
  if (billboard) {
    sc.vertGlsl.unshift(...BB_VERT_GLSL)
    sc.vertWgslPre.unshift(...BB_VERT_WGSL)
  } else if ((mask & SKIN) === 0) {
    sc.vertGlsl.unshift('vec4 position4 = vec4(position, 1.0);')
    sc.vertWgslPre.unshift('let position4 = vec4<f32>(position, 1.0);')
  }
  // The clip-space position — the LAST vertex body line (after skin/instance).
  sc.vertGlsl.push(`gl_Position = u_mvp * ${pos};`)

  // The single final color write (the light models / post effects own `lit`).
  // Task 127/128 — OUTPUT_DITHER, now TWO-SIDED:
  //   · rgb keeps the ±0.5/255 interleaved-gradient noise (Task 127);
  //   · alpha gains a 4×4 ORDERED (canonical Bayer) dither at ±1.5/255.
  // The alpha half is the one that matters for translucent sprite stacks:
  // each blend rounds the destination to 8 bits, and a smooth alpha ramp
  // crossing the quantization steps prints the "transparency staircase"
  // the haze report called out — jittering the SOURCE alpha decorrelates
  // the per-pixel rounding and the steps average into smooth gradients.
  // The canonical Bayer matrix is built recursively (M4 = 4·M2[low] +
  // M2[high], M2 = 2x + 3y − 4xy on {0,1}²) — no LUT, no bias, 16 levels.
  // The request flips fragPosition (the WGSL fragment input gains
  // @builtin(position); GLSL reads gl_FragCoord directly).
  const hasDither = (mask & OUTPUT_DITHER) !== 0
  if (hasDither) {
    fragPosition = true
    sc.fragGlsl.push(
      'float ditherN = (fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5) * (1.0 / 255.0);',
      'vec2 bayerP = mod(floor(gl_FragCoord.xy), 4.0);',
      'vec2 bayerLo = mod(bayerP, 2.0);',
      'vec2 bayerHi = floor(bayerP * 0.5);',
      'float m2lo = 2.0 * bayerLo.x + 3.0 * bayerLo.y - 4.0 * bayerLo.x * bayerLo.y;',
      'float m2hi = 2.0 * bayerHi.x + 3.0 * bayerHi.y - 4.0 * bayerHi.x * bayerHi.y;',
      'float ditherA = (4.0 * m2lo + m2hi - 7.5) * (3.0 / 255.0 / 16.0);',
    )
    sc.fragWgsl.push(
      'let ditherN = (fract(52.9829189 * fract(dot(frag.pos.xy, vec2<f32>(0.06711056, 0.00583715)))) - 0.5) * (1.0 / 255.0);',
      'let bayerP = (floor(frag.pos.xy) % 4.0);',
      'let bayerLo = (bayerP % 2.0);',
      'let bayerHi = floor(bayerP * 0.5);',
      'let m2lo = 2.0 * bayerLo.x + 3.0 * bayerLo.y - 4.0 * bayerLo.x * bayerLo.y;',
      'let m2hi = 2.0 * bayerHi.x + 3.0 * bayerHi.y - 4.0 * bayerHi.x * bayerHi.y;',
      'let ditherA = (4.0 * m2lo + m2hi - 7.5) * (3.0 / 255.0 / 16.0);',
    )
  }
  const ditherTail = hasDither ? ' + ditherN' : ''
  if (hasLight || hasPost) {
    // Demo-tuned parity: the object-space normal-map materials are opaque.
    const alpha = (mask & NORMALMAP) !== 0 ? '1.0' : 'base.a'
    sc.fragGlsl.push(`o_color = vec4(lit${ditherTail}, ${alpha});`)
    sc.fragWgsl.push(`return vec4<f32>(lit${ditherTail}, ${alpha});`)
  } else if (hasDither) {
    // the unlit (sprite) path — the alpha dither lands HERE (the
    // alpha-blended smokes and haze cards)
    sc.fragGlsl.push('o_color = vec4(base.rgb + ditherN, clamp(base.a + ditherA, 0.0, 1.0));')
    sc.fragWgsl.push('return vec4<f32>(base.rgb + ditherN, clamp(base.a + ditherA, 0.0, 1.0));')
  } else {
    sc.fragGlsl.push('o_color = base;')
    sc.fragWgsl.push('return base;')
  }

  // The uniform block order (GLSL declaration order + the WGSL struct):
  // u_mvp, u_model, vertex-stage features, fragment-stage features —
  // deduped by name (u_view may be wanted by BOTH stages: FOG vert, MATCAP frag).
  appendUnique(sc.uniforms, sc.vertUniforms, byName)
  appendUnique(sc.uniforms, sc.fragUniforms, byName)

  if ((mask & TEXTURE) !== 0) sc.samplers.push('u_tex')
  if ((mask & NORMALMAP) !== 0) sc.samplers.push('u_normalMap')
  if ((mask & MATCAP) !== 0) sc.samplers.push('u_matcap')
  if ((mask & PBR_MR_TEXTURE) !== 0) sc.samplers.push('u_mrTex')

  const glsl = buildGlsl(mask, sc.vertUniforms, sc.fragUniforms)
  const wgsl = buildWgsl(mask, posWgsl, billboard)
  return {
    mask,
    jointCount,
    glsl,
    wgsl,
    attributes: sc.attrs.slice(),
    uniforms: sc.uniforms.slice(),
    samplers: sc.samplers.slice(),
  }
}

/** front-facing request flag (DOUBLE_SIDED) — reset per assembly. */
let frontFacing = false
/** window-position request flag (SOFT_PARTICLES — Task 122) — reset per
 *  assembly: the WGSL fragment input gains @builtin(position). */
let fragPosition = false

function resetScratch(): void {
  frontFacing = false
  fragPosition = false
  for (const list of [
    sc.vertUniforms, sc.fragUniforms, sc.attrs, sc.varyings,
    sc.vertGlsl, sc.vertWgslPre, sc.vertWgslOut, sc.fragGlsl, sc.fragWgsl,
    sc.vertBody, sc.vertParts, sc.fragParts, sc.wgslParts, sc.uniforms, sc.samplers,
  ]) list.length = 0
}

/** Combination rules — actionable errors at assembly (not at draw time). */
const LIGHT_MODELS_ALL = LAMBERT | MATCAP | PBR

/** Number of set bits (family membership counting). */
function popcount(v: number): number {
  let c = 0
  while (v !== 0) { v &= v - 1; c++ }
  return c
}

function validate(mask: number, jointCount: number): void {
  // Task 131 — the BILLBOARD combination rules: the sprite family.
  if ((mask & BILLBOARD) !== 0) {
    if ((mask & TEXTURE) === 0) {
      throw new Error('rune/materials: BILLBOARD requires TEXTURE (a billboard is a sprite — the atlas/tile source)')
    }
    if ((mask & VERTEX_COLOR) === 0) {
      throw new Error('rune/materials: BILLBOARD requires VERTEX_COLOR (the ramp tint/alpha rides the instance record — without it sprites cannot fade)')
    }
    if ((mask & (SKIN | INSTANCED | NORMALMAP)) !== 0) {
      throw new Error('rune/materials: BILLBOARD excludes SKIN, INSTANCED and NORMALMAP (a billboard has no normal and no per-vertex position — the instance record IS the vertex)')
    }
    if ((mask & (LAMBERT | MATCAP | PBR)) !== 0) {
      throw new Error('rune/materials: BILLBOARD excludes the light models (a billboard carries no normal — use the unlit sprite family)')
    }
  }
  if ((mask & (TEXTURE | FLAT_ALBEDO)) === (TEXTURE | FLAT_ALBEDO)) {
    throw new Error('rune/materials: TEXTURE and FLAT_ALBEDO are mutually exclusive (one base color source)')
  }
  if ((mask & ALPHA_CUTOFF) !== 0 && (mask & TEXTURE) === 0) {
    // A cutoff without a texture alpha is dead code — refuse silently-wrong builds.
    throw new Error('rune/materials: ALPHA_CUTOFF requires TEXTURE (the alpha comes from the map)')
  }
  if ((mask & (TEXTURE | FLAT_ALBEDO)) === 0) {
    // Without a base there is no `base` — refuse a silently-broken shader.
    throw new Error('rune/materials: a material needs a base color source (TEXTURE or FLAT_ALBEDO)')
  }
  if (popcount(mask & LIGHT_MODELS_ALL) > 1) {
    throw new Error('rune/materials: LAMBERT, MATCAP and PBR are mutually exclusive light models')
  }
  if ((mask & SKIN) !== 0 && (!Number.isInteger(jointCount) || jointCount < 1)) {
    throw new Error('rune/materials: SKIN requires jointCount >= 1')
  }
  if ((mask & (PBR_SUB_MODELS | PBR_MR_TEXTURE | PBR_ENV)) !== 0 && (mask & PBR) === 0) {
    throw new Error('rune/materials: the PBR sub-model bits require PBR')
  }
  if ((mask & PBR) !== 0) {
    if (popcount(mask & PBR_D_MODELS) !== 1) {
      throw new Error(
        `rune/materials: PBR needs exactly one distribution (got ${popcount(mask & PBR_D_MODELS)} of ` +
        `PBR_D_GGX | PBR_D_BECKMANN | PBR_D_BLINN — pbrMask() defaults to GGX)`,
      )
    }
    if (popcount(mask & PBR_G_MODELS) !== 1) {
      throw new Error(
        `rune/materials: PBR needs exactly one geometry model (got ${popcount(mask & PBR_G_MODELS)} of ` +
        `PBR_G_SMITH | PBR_G_SMITH_SCHLICK | PBR_G_SMITH_HEIGHT | PBR_G_IMPLICIT | PBR_G_NEUMANN | PBR_G_KELEMEN)`,
      )
    }
    if (popcount(mask & PBR_F_MODELS) !== 1) {
      throw new Error(
        `rune/materials: PBR needs exactly one fresnel model (got ${popcount(mask & PBR_F_MODELS)} of ` +
        `PBR_F_SCHLICK | PBR_F_EXACT)`,
      )
    }
    if (popcount(mask & PBR_DIFF_MODELS) !== 1) {
      throw new Error(
        `rune/materials: PBR needs exactly one diffuse model (got ${popcount(mask & PBR_DIFF_MODELS)} of ` +
        `PBR_DIFF_LAMBERT | PBR_DIFF_OREN_NAYAR | PBR_DIFF_BURLEY)`,
      )
    }
    // The exact Smith terms are Smith-GGX: pairing them with Beckmann or
    // Blinn-Phong is silently wrong (a different Λ), so refuse it.
    if ((mask & (PBR_G_SMITH | PBR_G_SMITH_HEIGHT)) !== 0 && (mask & PBR_D_GGX) === 0) {
      throw new Error('rune/materials: PBR_G_SMITH and PBR_G_SMITH_HEIGHT are Smith-GGX terms — they require PBR_D_GGX')
    }
  }
  // The cache key stride (material.ts): jointCount must stay below it or
  // the composite key would not be injective.
  if (jointCount >= 8192) {
    throw new Error('rune/materials: jointCount must be < 8192 (the variant cache key stride)')
  }
}

function byName<T extends { name: string }>(item: T): string {
  return item.name
}

function appendUnique<T>(into: T[], from: readonly T[], keyOf: (item: T) => string): void {
  for (const item of from) {
    const key = keyOf(item)
    if (!into.some(existing => keyOf(existing) === key)) into.push(item)
  }
}

/** A brace block with 2-space-indented lines — the indentation comes from the
 *  join separator, NOT from per-line string copies (the memory contract). */
function pushBody(parts: string[], open: string, lines: readonly string[], close: string): void {
  if (lines.length === 0) {
    parts.push(open, close)
    return
  }
  parts.push(open, '  ' + lines.join('\n  '), close)
}

/** GLSL pair: dense locations (0..n), varyings linked by name. (The
 *  gl_Position line — with the billboard's `vec4(bbWorld, 1.0)` — is
 *  already in sc.vertGlsl; no position expression needed here.) */
function buildGlsl(
  mask: number,
  vertUniforms: readonly UniformDecl[],
  fragUniforms: readonly UniformDecl[],
): { vertex: string; fragment: string } {
  const vert = sc.vertParts
  vert.push('#version 300 es')
  sc.attrs.forEach((attr, at) => vert.push(`layout(location = ${at}) in ${attr.glslType} ${attr.name};`))
  vert.push('uniform mat4 u_mvp;')
  vert.push('uniform mat4 u_model;')
  for (const uniform of vertUniforms) vert.push(uniform.glsl)
  for (const varying of sc.varyings) vert.push(`out ${varying.glslType} ${varying.glslName};`)
  pushBody(vert, 'void main() {', sc.vertGlsl, '}')

  const frag = sc.fragParts
  // PBR fragments run exp/sqrt chains and 4th-power products: mediump (a
  // 10-bit mantissa on mobile GPUs) banding-breaks them — highp costs
  // nothing on desktop. TEXTURE materials (Task 75b): the sprite/particle
  // class feeds the fixed-function blender — a mediump alpha path quantizes
  // the glow ramp (and on some fp16 paths the near-edge falloff collapses
  // to steps that read as a hard rim); fragment highp is mandatory in
  // GLES3/WebGL2, so this is free correctness. The plain light models stay
  // mediump (the mobile win the demo tuning relies on). WGSL has no
  // precision qualifiers (f32 IS highp there), so this is GLSL-only.
  const highp = (mask & (PBR | TEXTURE | SOFT_PARTICLES | OUTPUT_DITHER)) !== 0
  frag.push('#version 300 es', highp ? 'precision highp float;' : 'precision mediump float;')
  // NORMALMAP reads u_model in the fragment (object-space → world).
  if ((mask & NORMALMAP) !== 0) frag.push('uniform mat4 u_model;')
  if ((mask & TEXTURE) !== 0) frag.push('uniform sampler2D u_tex;')
  if ((mask & NORMALMAP) !== 0) frag.push('uniform sampler2D u_normalMap;')
  if ((mask & MATCAP) !== 0) frag.push('uniform sampler2D u_matcap;')
  if ((mask & PBR_MR_TEXTURE) !== 0) frag.push('uniform sampler2D u_mrTex;')
  if ((mask & SOFT_PARTICLES) !== 0) frag.push('uniform sampler2D u_depth;')
  for (const varying of sc.varyings) frag.push(`in ${varying.glslType} ${varying.glslName};`)
  for (const uniform of fragUniforms) frag.push(uniform.glsl)
  frag.push('out vec4 o_color;')
  pushBody(frag, 'void main() {', sc.fragGlsl, '}')

  return { vertex: vert.join('\n'), fragment: frag.join('\n') }
}

/** WGSL: one Params struct (ALL uniforms), group(1) textures, two entries. */
function buildWgsl(mask: number, pos: string, billboard: boolean): string {
  const lines = sc.wgslParts
  lines.push('struct Params {', '  u_mvp : mat4x4<f32>,', '  u_model : mat4x4<f32>,')
  for (const uniform of sc.uniforms) lines.push(`  ${uniform.wgsl}`)
  lines.push('}')
  lines.push('@group(0) @binding(0) var<uniform> params : Params;')
  if ((mask & (TEXTURE | NORMALMAP | MATCAP | PBR_MR_TEXTURE)) !== 0) {
    lines.push('@group(1) @binding(0) var texSampler : sampler;')
  }
  if ((mask & TEXTURE) !== 0) lines.push('@group(1) @binding(1) var texTexture : texture_2d<f32>;')
  if ((mask & NORMALMAP) !== 0) lines.push('@group(1) @binding(2) var nrmTexture : texture_2d<f32>;')
  if ((mask & MATCAP) !== 0) lines.push('@group(1) @binding(3) var matTexture : texture_2d<f32>;')
  if ((mask & PBR_MR_TEXTURE) !== 0) lines.push('@group(1) @binding(4) var mrTexture : texture_2d<f32>;')
  if ((mask & SOFT_PARTICLES) !== 0) lines.push('@group(1) @binding(5) var depthTexture : texture_2d<f32>;')

  lines.push('struct VSOut {', '  @builtin(position) pos : vec4<f32>,')
  sc.varyings.forEach((varying, at) =>
    lines.push(`  @location(${at}) ${varying.wgslName} : ${varying.wgslType},`))
  lines.push('}')

  lines.push('@vertex')
  lines.push('fn vsMain(')
  // Task 131 — BILLBOARD: the corner expansion reads the vertex index
  // (one quad per instance, 6 corners); the reflector skips non-@location
  // params, so the binding contract is unaffected.
  if (billboard) lines.push('  @builtin(vertex_index) vi : u32,')
  sc.attrs.forEach((attr, at) => lines.push(`  @location(${at}) ${attr.name} : ${attr.wgslType},`))
  // one scratch reuse: the vertex body (pre + out + return)
  const body = sc.vertBody
  body.push(...sc.vertWgslPre)
  body.push('var out : VSOut;')
  body.push(`out.pos = params.u_mvp * ${pos};`)
  body.push(...sc.vertWgslOut)
  body.push('return out;')
  pushBody(lines, ') -> VSOut {', body, '}')

  if (frontFacing || fragPosition) {
    lines.push('struct FSIn {')
    sc.varyings.forEach((varying, at) =>
      lines.push(`  @location(${at}) ${varying.wgslName} : ${varying.wgslType},`))
    if (frontFacing) lines.push('  @builtin(front_facing) ff : bool,')
    if (fragPosition) lines.push('  @builtin(position) pos : vec4<f32>,')
    lines.push('}')
  }
  lines.push('@fragment')
  lines.push(`fn fsMain(frag : ${frontFacing || fragPosition ? 'FSIn' : 'VSOut'}) -> @location(0) vec4<f32> {`)
  if (sc.fragWgsl.length > 0) lines.push('  ' + sc.fragWgsl.join('\n  '))
  lines.push('}')

  return lines.join('\n')
}
