// @rune/materials — the feature catalog.
//
// A material is a BIT MASK of features, not a shader. Each feature carries
// GLSL and WGSL snippets; the assembler (assemble.ts) stitches them into a
// minimal source pair, and the variant cache (material.ts) keys the result
// by an INTEGER (the mask + skin size) — the Theory D lesson: numeric
// registry keys beat string keys by ~200x on the lookup path.
//
// The catalog is ORDERED: snippets are emitted in ascending bit order, and
// the order is semantic — skinning and normal sources come before the base
// color (TEXTURE / FLAT_ALBEDO), the light model (LAMBERT) consumes both,
// ALPHA_CUTOFF discards at the very end.

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
  /** Lines inside WGSL fsMain() (the last line returns). */
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

/** Object-space normal map: the normal comes from a texture (RGB -> object space). */
export const NORMALMAP: FeatureBit = 1 << 1

/** Base color from a texture (uv required). */
export const TEXTURE: FeatureBit = 1 << 2

/** Base color from the u_albedo uniform (no texture). */
export const FLAT_ALBEDO: FeatureBit = 1 << 3

/** Back faces flip the normal (open geometries: the bust, Mixamo folds). */
export const DOUBLE_SIDED: FeatureBit = 1 << 4

/** Directional Lambert light: ambient + max(dot(n, l), 0).
 *  The FINAL feature in emission order — writes the output color. */
export const LAMBERT: FeatureBit = 1 << 6

/** MASK alpha: discards fragments with base.a < u_alphaCutoff (BEFORE the
 *  light model — the discard must precede the final color write). */
export const ALPHA_CUTOFF: FeatureBit = 1 << 5

const has = (ctx: AsmCtx, bit: FeatureBit): boolean => (ctx.mask & bit) !== 0

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
        ...(has(ctx, DOUBLE_SIDED) ? ['if (!gl_FrontFacing) n = -n;'] : []),
      ],
      wgslBody: [
        'let nObj = textureSample(nrmTexture, texSampler, frag.uv).xyz * 2.0 - 1.0;',
        'var n = normalize((params.u_model * vec4<f32>(nObj, 0.0)).xyz);',
        ...(has(ctx, DOUBLE_SIDED) ? ['n = select(-n, n, frag.ff);'] : []),
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
    frag: (_ctx: AsmCtx): FragSnippets => ({
      glslBody: ['vec4 base = texture(u_tex, v_uv);'],
      wgslBody: ['let base = textureSample(texTexture, texSampler, frag.uv);'],
    }),
  },
  {
    id: 'flatAlbedo',
    bit: FLAT_ALBEDO,
    vert: (_ctx: AsmCtx): VertSnippets => ({}),
    frag: (_ctx: AsmCtx): FragSnippets => ({
      uniforms: [
        { name: 'u_albedo', glsl: 'uniform vec3 u_albedo;', wgsl: 'u_albedo : vec4<f32>,' },
      ],
      glslBody: ['vec4 base = vec4(u_albedo, 1.0);'],
      wgslBody: ['let base = vec4<f32>(params.u_albedo.rgb, 1.0);'],
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
    vert: (ctx: AsmCtx): VertSnippets => {
      if (has(ctx, NORMALMAP)) return {}
      return {
        varyings: [{ glslName: 'v_normal', wgslName: 'worldNormal', glslType: 'vec3', wgslType: 'vec3<f32>' }],
        glslBody: [`v_normal = mat3(u_model)${has(ctx, SKIN) ? ' * mat3(skin)' : ''} * normal;`],
        wgslOut: [
          `out.worldNormal = (params.u_model * ${has(ctx, SKIN) ? '(skin * vec4<f32>(normal, 0.0))' : 'vec4<f32>(normal, 0.0)'}).xyz;`,
        ],
      }
    },
    frag: (ctx: AsmCtx): FragSnippets => ({
      uniforms: [
        { name: 'u_lightDir', glsl: 'uniform vec3 u_lightDir;', wgsl: 'u_lightDir : vec4<f32>,' },
      ],
      glslBody: [
        ...(has(ctx, NORMALMAP) ? [] : [
          'vec3 n = normalize(v_normal);',
          ...(has(ctx, DOUBLE_SIDED) ? ['if (!gl_FrontFacing) n = -n;'] : []),
        ]),
        'float lambert = max(dot(n, normalize(u_lightDir)), 0.0);',
        // The ambient term of a textured surface (0.35) is softer than the
        // flat one (0.3) — the demo-tuned constants, kept bit-for-bit.
        has(ctx, TEXTURE)
          ? 'o_color = vec4(base.rgb * (0.35 + 0.65 * lambert), base.a);'
          : 'o_color = vec4(base.rgb * (0.3 + 0.7 * lambert), base.a);',
      ],
      wgslBody: [
        ...(has(ctx, NORMALMAP) ? [] : [
          'var n = normalize(frag.worldNormal);',
          ...(has(ctx, DOUBLE_SIDED) ? ['n = select(-n, n, frag.ff);'] : []),
        ]),
        'let lambert = max(dot(normalize(n), normalize(params.u_lightDir.xyz)), 0.0);',
        has(ctx, TEXTURE)
          ? 'return vec4<f32>(base.rgb * (0.35 + 0.65 * lambert), base.a);'
          : 'return vec4<f32>(base.rgb * (0.3 + lambert * 0.7), base.a);',
      ],
    }),
  },
]
