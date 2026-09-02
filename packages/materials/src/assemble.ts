// @rune/materials — the assembler: a feature mask → a minimal source pair.
//
// NOT an uber-shader: each variant contains ONLY the code its features need
// (a skinned-64-joint material and an unlit-textured one share nothing but
// the two mat4s). Assembly is one-shot per variant and cached upstream
// (material.ts); this module is pure — the hot path (a cache hit) never
// lands here.
//
// Naming conventions (unified across GLSL and WGSL):
//   attributes  position | normal | uv | joints | weights  (the same names)
//   uniforms    u_mvp, u_model (always) + feature uniforms
//   WGSL        one Params struct @group(0) @binding(0) (all uniforms);
//               textures @group(1): texSampler@0, texTexture@1, nrmTexture@2

import {
  ALPHA_CUTOFF,
  CATALOG,
  FLAT_ALBEDO,
  LAMBERT,
  NORMALMAP,
  SKIN,
  TEXTURE,
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
  /** Sampler names of the GLSL fragment (u_tex / u_normalMap). */
  readonly samplers: readonly string[]
}

/** Assembles the variant for a mask. Throws on invalid combinations. */
export function assemble(mask: number, jointCount: number): AssembledMaterial {
  validate(mask, jointCount)
  const ctx: AsmCtx = { mask, jointCount }

  // ── collect snippets in catalog order (ascending bit = semantic order) ──
  const vertUniforms: UniformDecl[] = []
  const fragUniforms: UniformDecl[] = []
  const attrs: AttrDecl[] = [{ name: 'position', glslType: 'vec3', wgslType: 'vec3<f32>' }]
  const varyings: VaryingDecl[] = []
  const vertGlsl: string[] = []
  const vertWgslPre: string[] = []
  const vertWgslOut: string[] = []
  const fragGlsl: string[] = []
  const fragWgsl: string[] = []
  let frontFacing = false

  const needsNormal = (mask & LAMBERT) !== 0 && (mask & NORMALMAP) === 0
  if (needsNormal) attrs.push({ name: 'normal', glslType: 'vec3', wgslType: 'vec3<f32>' })
  if ((mask & (TEXTURE | NORMALMAP)) !== 0) attrs.push({ name: 'uv', glslType: 'vec2', wgslType: 'vec2<f32>' })

  for (const feature of CATALOG) {
    if ((mask & feature.bit) === 0) continue
    const v = feature.vert(ctx)
    if (v.uniforms !== undefined) appendUnique(vertUniforms, v.uniforms, byName)
    if (v.attrs !== undefined) appendUnique(attrs, v.attrs, byName)
    if (v.varyings !== undefined) appendUnique(varyings, v.varyings, item => item.glslName)
    if (v.glslBody !== undefined) vertGlsl.push(...v.glslBody)
    if (v.wgslPre !== undefined) vertWgslPre.push(...v.wgslPre)
    if (v.wgslOut !== undefined) vertWgslOut.push(...v.wgslOut)
    const f = feature.frag(ctx)
    if (f.uniforms !== undefined) appendUnique(fragUniforms, f.uniforms, byName)
    if (f.glslBody !== undefined) fragGlsl.push(...f.glslBody)
    if (f.wgslBody !== undefined) fragWgsl.push(...f.wgslBody)
    if (f.frontFacing === true) frontFacing = true
  }

  // No light model → the base color as is (unlit).
  if ((mask & LAMBERT) === 0) {
    fragGlsl.push('o_color = base;')
    fragWgsl.push('return base;')
  }

  // The default position expression: SKIN declares its own position4;
  // every other combination starts from the raw attribute.
  if ((mask & SKIN) === 0) {
    vertGlsl.unshift('vec4 position4 = vec4(position, 1.0);')
    vertWgslPre.unshift('let position4 = vec4<f32>(position, 1.0);')
  }

  // The uniform block order (GLSL declaration order + the WGSL struct):
  // u_mvp, u_model, vertex-stage features, fragment-stage features.
  const uniforms = [...vertUniforms, ...fragUniforms]

  const glsl = buildGlsl(mask, attrs, varyings, vertUniforms, fragUniforms, vertGlsl, fragGlsl)
  const wgsl = buildWgsl(mask, attrs, varyings, uniforms, vertWgslPre, vertWgslOut, fragWgsl, frontFacing)
  const samplers: string[] = []
  if ((mask & TEXTURE) !== 0) samplers.push('u_tex')
  if ((mask & NORMALMAP) !== 0) samplers.push('u_normalMap')

  return { mask, jointCount, glsl, wgsl, attributes: attrs, uniforms, samplers }
}

/** Combination rules — actionable errors at assembly (not at draw time). */
function validate(mask: number, jointCount: number): void {
  if ((mask & (TEXTURE | FLAT_ALBEDO)) === (TEXTURE | FLAT_ALBEDO)) {
    throw new Error('rune/materials: TEXTURE and FLAT_ALBEDO are mutually exclusive (one base color source)')
  }
  if ((mask & SKIN) !== 0 && (!Number.isInteger(jointCount) || jointCount < 1)) {
    throw new Error('rune/materials: SKIN requires jointCount >= 1')
  }
  if ((mask & ALPHA_CUTOFF) !== 0 && (mask & TEXTURE) === 0) {
    // A cutoff without a texture alpha is dead code — refuse silently-wrong builds.
    throw new Error('rune/materials: ALPHA_CUTOFF requires TEXTURE (the alpha comes from the map)')
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

/** GLSL pair: dense locations (0..n), varyings linked by name. */
function buildGlsl(
  mask: number,
  attrs: readonly AttrDecl[],
  varyings: readonly VaryingDecl[],
  vertUniforms: readonly UniformDecl[],
  fragUniforms: readonly UniformDecl[],
  vertBody: readonly string[],
  fragBody: readonly string[],
): { vertex: string; fragment: string } {
  const vert: string[] = ['#version 300 es']
  attrs.forEach((attr, at) => vert.push(`layout(location = ${at}) in ${attr.glslType} ${attr.name};`))
  vert.push('uniform mat4 u_mvp;')
  vert.push('uniform mat4 u_model;')
  for (const uniform of vertUniforms) vert.push(uniform.glsl)
  for (const varying of varyings) vert.push(`out ${varying.glslType} ${varying.glslName};`)
  vert.push('void main() {')
  vert.push(...indent(vertBody))
  vert.push('  gl_Position = u_mvp * position4;')
  vert.push('}')

  const frag: string[] = ['#version 300 es', 'precision mediump float;']
  // NORMALMAP reads u_model in the fragment (object-space → world).
  if ((mask & NORMALMAP) !== 0) frag.push('uniform mat4 u_model;')
  if ((mask & TEXTURE) !== 0) frag.push('uniform sampler2D u_tex;')
  if ((mask & NORMALMAP) !== 0) frag.push('uniform sampler2D u_normalMap;')
  for (const varying of varyings) frag.push(`in ${varying.glslType} ${varying.glslName};`)
  for (const uniform of fragUniforms) frag.push(uniform.glsl)
  frag.push('out vec4 o_color;')
  frag.push('void main() {')
  frag.push(...indent(fragBody))
  frag.push('}')

  return { vertex: vert.join('\n'), fragment: frag.join('\n') }
}

/** WGSL: one Params struct (ALL uniforms), group(1) textures, two entries. */
function buildWgsl(
  mask: number,
  attrs: readonly AttrDecl[],
  varyings: readonly VaryingDecl[],
  uniforms: readonly UniformDecl[],
  vertPre: readonly string[],
  vertOut: readonly string[],
  fragBody: readonly string[],
  frontFacing: boolean,
): string {
  const lines: string[] = ['struct Params {', '  u_mvp : mat4x4<f32>,', '  u_model : mat4x4<f32>,']
  for (const uniform of uniforms) {
    if (uniform.wgsl !== '') lines.push(`  ${uniform.wgsl}`)
  }
  lines.push('}')
  lines.push('@group(0) @binding(0) var<uniform> params : Params;')
  if ((mask & (TEXTURE | NORMALMAP)) !== 0) {
    lines.push('@group(1) @binding(0) var texSampler : sampler;')
  }
  if ((mask & TEXTURE) !== 0) lines.push('@group(1) @binding(1) var texTexture : texture_2d<f32>;')
  if ((mask & NORMALMAP) !== 0) lines.push('@group(1) @binding(2) var nrmTexture : texture_2d<f32>;')

  lines.push('struct VSOut {', '  @builtin(position) pos : vec4<f32>,')
  varyings.forEach((varying, at) => lines.push(`  @location(${at}) ${varying.wgslName} : ${varying.wgslType},`))
  lines.push('}')

  lines.push('@vertex')
  lines.push('fn vsMain(')
  attrs.forEach((attr, at) => lines.push(`  @location(${at}) ${attr.name} : ${attr.wgslType},`))
  lines.push(') -> VSOut {')
  lines.push(...indent(vertPre))
  lines.push('  var out : VSOut;')
  lines.push('  out.pos = params.u_mvp * position4;')
  lines.push(...indent(vertOut))
  lines.push('  return out;')
  lines.push('}')

  if (frontFacing) {
    lines.push('struct FSIn {')
    varyings.forEach((varying, at) => lines.push(`  @location(${at}) ${varying.wgslName} : ${varying.wgslType},`))
    lines.push('  @builtin(front_facing) ff : bool,')
    lines.push('}')
  }
  lines.push('@fragment')
  lines.push(`fn fsMain(frag : ${frontFacing ? 'FSIn' : 'VSOut'}) -> @location(0) vec4<f32> {`)
  lines.push(...indent(fragBody))
  lines.push('}')

  return lines.join('\n')
}

function indent(lines: readonly string[]): string[] {
  return lines.map(line => `  ${line}`)
}
