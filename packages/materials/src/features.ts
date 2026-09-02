// @rune/materials — the feature catalog.
//
// A material is a BIT MASK of features, not a shader. Each feature carries
// GLSL and WGSL snippets; the assembler (assemble.ts) stitches them into a
// minimal source pair, and the variant cache (material.ts) keys the result
// by an INTEGER (the mask + skin size) — the Theory D lesson: numeric
// registry keys beat string keys by ~200x on the lookup path.
//
// The catalog is ORDERED: snippets are emitted in ascending bit order, and
// the order is semantic —
//   SKIN / INSTANCED transform the position first,
//   the normal sources (NORMALMAP) and the base color (TEXTURE /
//   FLAT_ALBEDO / VERTEX_COLOR) come next, ALPHA_CUTOFF discards,
//   a light model (LAMBERT or MATCAP) computes `lit`,
//   and the post effects (EMISSIVE, FOG) mutate `lit` before the single
//   final color write that the assembler appends at the very end.

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
 *  A LIGHT MODEL — writes `lit`, mutually exclusive with MATCAP. */
export const LAMBERT: FeatureBit = 1 << 8

/** Matcap shading: the light comes FROM a texture (a pre-lit sphere sampled
 *  by the view-space normal). A LIGHT MODEL — mutually exclusive with LAMBERT. */
export const MATCAP: FeatureBit = 1 << 9

/** Self-illumination: adds u_emissive to `lit` after the light model
 *  (works unlit too — a glowing unshaded surface). */
export const EMISSIVE: FeatureBit = 1 << 10

/** Distance fog: fades `lit` toward u_fogColor between u_fogNear/u_fogFar
 *  (view-space depth — needs the u_view matrix). */
export const FOG: FeatureBit = 1 << 11

/** The light models — exactly one may be present (or none: unlit). */
export const LIGHT_MODELS: FeatureBit = LAMBERT | MATCAP

/** The post effects — mutate `lit` after the light model. */
export const POST_EFFECTS: FeatureBit = EMISSIVE | FOG

const has = (ctx: AsmCtx, bit: FeatureBit): boolean => (ctx.mask & bit) !== 0

/** `var` when a post effect mutates the binding later, `let` otherwise. */
const mutKw = (ctx: AsmCtx): string => has(ctx, POST_EFFECTS) ? 'var' : 'let'

/** World normal emission shared by the light models (LAMBERT / MATCAP).
 *  With NORMALMAP the normal comes from the map in the fragment instead. */
function normalVert(ctx: AsmCtx): VertSnippets {
  if (has(ctx, NORMALMAP)) return {}
  const inst = has(ctx, INSTANCED) ? ' * mat3(i_model)' : ''
  const skin = has(ctx, SKIN) ? ' * mat3(skin)' : ''
  return {
    varyings: [{ glslName: 'v_normal', wgslName: 'worldNormal', glslType: 'vec3', wgslType: 'vec3<f32>' }],
    glslBody: [`v_normal = mat3(u_model)${inst}${skin} * normal;`],
    wgslOut: [
      `out.worldNormal = (params.u_model * ${has(ctx, INSTANCED) ? '(i_model * ' : ''}` +
        `${has(ctx, SKIN) ? '(skin * vec4<f32>(normal, 0.0))' : 'vec4<f32>(normal, 0.0)'}` +
        `${has(ctx, INSTANCED) ? ')' : ''}).xyz;`,
    ],
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

/** The catalog: array index === bit index (ascending emission order). */
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
        ...(has(ctx, NORMALMAP) ? [] : ['vec3 n = normalize(v_normal);', ...flipGlsl(ctx)]),
        'float lambert = max(dot(n, normalize(u_lightDir)), 0.0);',
        // The demo-tuned ambient terms, kept bit-for-bit: the object-space
        // normal-map surface is the deepest (0.22), a plain texture softer
        // (0.35), a flat albedo the brightest floor (0.3).
        has(ctx, NORMALMAP) ? 'vec3 lit = base.rgb * (0.22 + 0.78 * lambert);'
          : has(ctx, TEXTURE) ? 'vec3 lit = base.rgb * (0.35 + 0.65 * lambert);'
            : 'vec3 lit = base.rgb * (0.3 + 0.7 * lambert);',
      ],
      wgslBody: [
        ...(has(ctx, NORMALMAP) ? [] : ['var n = normalize(frag.worldNormal);', ...flipWgsl(ctx)]),
        'let lambert = max(dot(normalize(n), normalize(params.u_lightDir.xyz)), 0.0);',
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
        ...(has(ctx, NORMALMAP) ? [] : ['vec3 n = normalize(v_normal);', ...flipGlsl(ctx)]),
        'vec3 nView = normalize(mat3(u_view) * n);',
        'vec2 matcapUv = nView.xy * 0.5 + 0.5;',
        'vec3 lit = base.rgb * texture(u_matcap, matcapUv).rgb;',
      ],
      wgslBody: [
        ...(has(ctx, NORMALMAP) ? [] : ['var n = normalize(frag.worldNormal);', ...flipWgsl(ctx)]),
        'let nView = normalize((params.u_view * vec4<f32>(n, 0.0)).xyz);',
        'let matcapUv = vec2<f32>(nView.x * 0.5 + 0.5, nView.y * 0.5 + 0.5);',
        'let mc = textureSample(matTexture, texSampler, matcapUv).rgb;',
        `${mutKw(ctx)} lit = base.rgb * mc;`,
      ],
    }),
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
      glslBody: [`v_viewZ = (u_view * u_model * ${posVar(ctx)}).z;`],
      wgslOut: [`out.viewZ = (params.u_view * params.u_model * ${posVar(ctx)}).z;`],
    }),
    frag: (_ctx: AsmCtx): FragSnippets => ({
      uniforms: [
        { name: 'u_fogColor', glsl: 'uniform vec3 u_fogColor;', wgsl: 'u_fogColor : vec4<f32>,' },
        { name: 'u_fogNear', glsl: 'uniform float u_fogNear;', wgsl: 'u_fogNear : f32,' },
        { name: 'u_fogFar', glsl: 'uniform float u_fogFar;', wgsl: 'u_fogFar : f32,' },
      ],
      glslBody: [
        'float fogFactor = clamp((-v_viewZ - u_fogNear) / (u_fogFar - u_fogNear), 0.0, 1.0);',
        'lit = mix(lit, u_fogColor, fogFactor);',
      ],
      wgslBody: [
        'let fogFactor = clamp((-frag.viewZ - params.u_fogNear) / (params.u_fogFar - params.u_fogNear), 0.0, 1.0);',
        'lit = mix(lit, params.u_fogColor.rgb, fogFactor);',
      ],
    }),
  },
]
