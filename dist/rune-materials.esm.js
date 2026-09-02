// packages/materials/src/features.ts
var SKIN = 1 << 0;
var NORMALMAP = 1 << 1;
var TEXTURE = 1 << 2;
var FLAT_ALBEDO = 1 << 3;
var DOUBLE_SIDED = 1 << 4;
var LAMBERT = 1 << 6;
var ALPHA_CUTOFF = 1 << 5;
var has = (ctx, bit) => (ctx.mask & bit) !== 0;
var CATALOG = [
  {
    id: "skin",
    bit: SKIN,
    vert: (ctx) => ({
      attrs: [
        { name: "joints", glslType: "vec4", wgslType: "vec4<f32>" },
        { name: "weights", glslType: "vec4", wgslType: "vec4<f32>" }
      ],
      uniforms: [{
        name: "u_bones",
        glsl: `uniform mat4 u_bones[${ctx.jointCount}];`,
        wgsl: `u_bones : array<mat4x4<f32>, ${ctx.jointCount}>,`
      }],
      glslBody: [
        "mat4 skin =",
        "    u_bones[int(joints.x + 0.5)] * weights.x",
        "  + u_bones[int(joints.y + 0.5)] * weights.y",
        "  + u_bones[int(joints.z + 0.5)] * weights.z",
        "  + u_bones[int(joints.w + 0.5)] * weights.w;",
        "vec4 position4 = skin * vec4(position, 1.0);"
      ],
      wgslPre: [
        "let skin =",
        "    params.u_bones[u32(joints.x + 0.5)] * weights.x",
        "  + params.u_bones[u32(joints.y + 0.5)] * weights.y",
        "  + params.u_bones[u32(joints.z + 0.5)] * weights.z",
        "  + params.u_bones[u32(joints.w + 0.5)] * weights.w;",
        "let position4 = skin * vec4<f32>(position, 1.0);"
      ]
    }),
    frag: (_ctx) => ({})
  },
  {
    id: "normalmap",
    bit: NORMALMAP,
    vert: (_ctx) => ({
      varyings: [{ glslName: "v_uv", wgslName: "uv", glslType: "vec2", wgslType: "vec2<f32>" }],
      glslBody: ["v_uv = uv;"],
      wgslOut: ["out.uv = uv;"]
    }),
    frag: (ctx) => ({
      glslBody: [
        "vec3 n = normalize(mat3(u_model) * (texture(u_normalMap, v_uv).xyz * 2.0 - 1.0));",
        ...has(ctx, DOUBLE_SIDED) ? ["if (!gl_FrontFacing) n = -n;"] : []
      ],
      wgslBody: [
        "let nObj = textureSample(nrmTexture, texSampler, frag.uv).xyz * 2.0 - 1.0;",
        "var n = normalize((params.u_model * vec4<f32>(nObj, 0.0)).xyz);",
        ...has(ctx, DOUBLE_SIDED) ? ["n = select(-n, n, frag.ff);"] : []
      ]
    })
  },
  {
    id: "texture",
    bit: TEXTURE,
    vert: (_ctx) => ({
      varyings: [{ glslName: "v_uv", wgslName: "uv", glslType: "vec2", wgslType: "vec2<f32>" }],
      glslBody: ["v_uv = uv;"],
      wgslOut: ["out.uv = uv;"]
    }),
    frag: (_ctx) => ({
      glslBody: ["vec4 base = texture(u_tex, v_uv);"],
      wgslBody: ["let base = textureSample(texTexture, texSampler, frag.uv);"]
    })
  },
  {
    id: "flatAlbedo",
    bit: FLAT_ALBEDO,
    vert: (_ctx) => ({}),
    frag: (_ctx) => ({
      uniforms: [
        { name: "u_albedo", glsl: "uniform vec3 u_albedo;", wgsl: "u_albedo : vec4<f32>," }
      ],
      glslBody: ["vec4 base = vec4(u_albedo, 1.0);"],
      wgslBody: ["let base = vec4<f32>(params.u_albedo.rgb, 1.0);"]
    })
  },
  {
    id: "doubleSided",
    bit: DOUBLE_SIDED,
    vert: (_ctx) => ({}),
    frag: (_ctx) => ({ frontFacing: true })
  },
  {
    id: "alphaCutoff",
    bit: ALPHA_CUTOFF,
    vert: (_ctx) => ({}),
    frag: (_ctx) => ({
      uniforms: [
        { name: "u_alphaCutoff", glsl: "uniform float u_alphaCutoff;", wgsl: "u_alphaCutoff : f32," }
      ],
      glslBody: ["if (base.a < u_alphaCutoff) discard;"],
      wgslBody: ["if (base.a < params.u_alphaCutoff) { discard; }"]
    })
  },
  {
    id: "lambert",
    bit: LAMBERT,
    vert: (ctx) => {
      if (has(ctx, NORMALMAP))
        return {};
      return {
        varyings: [{ glslName: "v_normal", wgslName: "worldNormal", glslType: "vec3", wgslType: "vec3<f32>" }],
        glslBody: [`v_normal = mat3(u_model)${has(ctx, SKIN) ? " * mat3(skin)" : ""} * normal;`],
        wgslOut: [
          `out.worldNormal = (params.u_model * ${has(ctx, SKIN) ? "(skin * vec4<f32>(normal, 0.0))" : "vec4<f32>(normal, 0.0)"}).xyz;`
        ]
      };
    },
    frag: (ctx) => ({
      uniforms: [
        { name: "u_lightDir", glsl: "uniform vec3 u_lightDir;", wgsl: "u_lightDir : vec4<f32>," }
      ],
      glslBody: [
        ...has(ctx, NORMALMAP) ? [] : [
          "vec3 n = normalize(v_normal);",
          ...has(ctx, DOUBLE_SIDED) ? ["if (!gl_FrontFacing) n = -n;"] : []
        ],
        "float lambert = max(dot(n, normalize(u_lightDir)), 0.0);",
        has(ctx, TEXTURE) ? "o_color = vec4(base.rgb * (0.35 + 0.65 * lambert), base.a);" : "o_color = vec4(base.rgb * (0.3 + 0.7 * lambert), base.a);"
      ],
      wgslBody: [
        ...has(ctx, NORMALMAP) ? [] : [
          "var n = normalize(frag.worldNormal);",
          ...has(ctx, DOUBLE_SIDED) ? ["n = select(-n, n, frag.ff);"] : []
        ],
        "let lambert = max(dot(normalize(n), normalize(params.u_lightDir.xyz)), 0.0);",
        has(ctx, TEXTURE) ? "return vec4<f32>(base.rgb * (0.35 + 0.65 * lambert), base.a);" : "return vec4<f32>(base.rgb * (0.3 + lambert * 0.7), base.a);"
      ]
    })
  }
];
// packages/materials/src/assemble.ts
function assemble(mask, jointCount) {
  validate(mask, jointCount);
  const ctx = { mask, jointCount };
  const vertUniforms = [];
  const fragUniforms = [];
  const attrs = [{ name: "position", glslType: "vec3", wgslType: "vec3<f32>" }];
  const varyings = [];
  const vertGlsl = [];
  const vertWgslPre = [];
  const vertWgslOut = [];
  const fragGlsl = [];
  const fragWgsl = [];
  let frontFacing = false;
  const needsNormal = (mask & LAMBERT) !== 0 && (mask & NORMALMAP) === 0;
  if (needsNormal)
    attrs.push({ name: "normal", glslType: "vec3", wgslType: "vec3<f32>" });
  if ((mask & (TEXTURE | NORMALMAP)) !== 0)
    attrs.push({ name: "uv", glslType: "vec2", wgslType: "vec2<f32>" });
  for (const feature of CATALOG) {
    if ((mask & feature.bit) === 0)
      continue;
    const v = feature.vert(ctx);
    if (v.uniforms !== undefined)
      appendUnique(vertUniforms, v.uniforms, byName);
    if (v.attrs !== undefined)
      appendUnique(attrs, v.attrs, byName);
    if (v.varyings !== undefined)
      appendUnique(varyings, v.varyings, (item) => item.glslName);
    if (v.glslBody !== undefined)
      vertGlsl.push(...v.glslBody);
    if (v.wgslPre !== undefined)
      vertWgslPre.push(...v.wgslPre);
    if (v.wgslOut !== undefined)
      vertWgslOut.push(...v.wgslOut);
    const f = feature.frag(ctx);
    if (f.uniforms !== undefined)
      appendUnique(fragUniforms, f.uniforms, byName);
    if (f.glslBody !== undefined)
      fragGlsl.push(...f.glslBody);
    if (f.wgslBody !== undefined)
      fragWgsl.push(...f.wgslBody);
    if (f.frontFacing === true)
      frontFacing = true;
  }
  if ((mask & LAMBERT) === 0) {
    fragGlsl.push("o_color = base;");
    fragWgsl.push("return base;");
  }
  if ((mask & SKIN) === 0) {
    vertGlsl.unshift("vec4 position4 = vec4(position, 1.0);");
    vertWgslPre.unshift("let position4 = vec4<f32>(position, 1.0);");
  }
  const uniforms = [...vertUniforms, ...fragUniforms];
  const glsl = buildGlsl(mask, attrs, varyings, vertUniforms, fragUniforms, vertGlsl, fragGlsl);
  const wgsl = buildWgsl(mask, attrs, varyings, uniforms, vertWgslPre, vertWgslOut, fragWgsl, frontFacing);
  const samplers = [];
  if ((mask & TEXTURE) !== 0)
    samplers.push("u_tex");
  if ((mask & NORMALMAP) !== 0)
    samplers.push("u_normalMap");
  return { mask, jointCount, glsl, wgsl, attributes: attrs, uniforms, samplers };
}
function validate(mask, jointCount) {
  if ((mask & (TEXTURE | FLAT_ALBEDO)) === (TEXTURE | FLAT_ALBEDO)) {
    throw new Error("rune/materials: TEXTURE and FLAT_ALBEDO are mutually exclusive (one base color source)");
  }
  if ((mask & SKIN) !== 0 && (!Number.isInteger(jointCount) || jointCount < 1)) {
    throw new Error("rune/materials: SKIN requires jointCount >= 1");
  }
  if ((mask & ALPHA_CUTOFF) !== 0 && (mask & TEXTURE) === 0) {
    throw new Error("rune/materials: ALPHA_CUTOFF requires TEXTURE (the alpha comes from the map)");
  }
}
function byName(item) {
  return item.name;
}
function appendUnique(into, from, keyOf) {
  for (const item of from) {
    const key = keyOf(item);
    if (!into.some((existing) => keyOf(existing) === key))
      into.push(item);
  }
}
function buildGlsl(mask, attrs, varyings, vertUniforms, fragUniforms, vertBody, fragBody) {
  const vert = ["#version 300 es"];
  attrs.forEach((attr, at) => vert.push(`layout(location = ${at}) in ${attr.glslType} ${attr.name};`));
  vert.push("uniform mat4 u_mvp;");
  vert.push("uniform mat4 u_model;");
  for (const uniform of vertUniforms)
    vert.push(uniform.glsl);
  for (const varying of varyings)
    vert.push(`out ${varying.glslType} ${varying.glslName};`);
  vert.push("void main() {");
  vert.push(...indent(vertBody));
  vert.push("  gl_Position = u_mvp * position4;");
  vert.push("}");
  const frag = ["#version 300 es", "precision mediump float;"];
  if ((mask & NORMALMAP) !== 0)
    frag.push("uniform mat4 u_model;");
  if ((mask & TEXTURE) !== 0)
    frag.push("uniform sampler2D u_tex;");
  if ((mask & NORMALMAP) !== 0)
    frag.push("uniform sampler2D u_normalMap;");
  for (const varying of varyings)
    frag.push(`in ${varying.glslType} ${varying.glslName};`);
  for (const uniform of fragUniforms)
    frag.push(uniform.glsl);
  frag.push("out vec4 o_color;");
  frag.push("void main() {");
  frag.push(...indent(fragBody));
  frag.push("}");
  return { vertex: vert.join(`
`), fragment: frag.join(`
`) };
}
function buildWgsl(mask, attrs, varyings, uniforms, vertPre, vertOut, fragBody, frontFacing) {
  const lines = ["struct Params {", "  u_mvp : mat4x4<f32>,", "  u_model : mat4x4<f32>,"];
  for (const uniform of uniforms) {
    if (uniform.wgsl !== "")
      lines.push(`  ${uniform.wgsl}`);
  }
  lines.push("}");
  lines.push("@group(0) @binding(0) var<uniform> params : Params;");
  if ((mask & (TEXTURE | NORMALMAP)) !== 0) {
    lines.push("@group(1) @binding(0) var texSampler : sampler;");
  }
  if ((mask & TEXTURE) !== 0)
    lines.push("@group(1) @binding(1) var texTexture : texture_2d<f32>;");
  if ((mask & NORMALMAP) !== 0)
    lines.push("@group(1) @binding(2) var nrmTexture : texture_2d<f32>;");
  lines.push("struct VSOut {", "  @builtin(position) pos : vec4<f32>,");
  varyings.forEach((varying, at) => lines.push(`  @location(${at}) ${varying.wgslName} : ${varying.wgslType},`));
  lines.push("}");
  lines.push("@vertex");
  lines.push("fn vsMain(");
  attrs.forEach((attr, at) => lines.push(`  @location(${at}) ${attr.name} : ${attr.wgslType},`));
  lines.push(") -> VSOut {");
  lines.push(...indent(vertPre));
  lines.push("  var out : VSOut;");
  lines.push("  out.pos = params.u_mvp * position4;");
  lines.push(...indent(vertOut));
  lines.push("  return out;");
  lines.push("}");
  if (frontFacing) {
    lines.push("struct FSIn {");
    varyings.forEach((varying, at) => lines.push(`  @location(${at}) ${varying.wgslName} : ${varying.wgslType},`));
    lines.push("  @builtin(front_facing) ff : bool,");
    lines.push("}");
  }
  lines.push("@fragment");
  lines.push(`fn fsMain(frag : ${frontFacing ? "FSIn" : "VSOut"}) -> @location(0) vec4<f32> {`);
  lines.push(...indent(fragBody));
  lines.push("}");
  return lines.join(`
`);
}
function indent(lines) {
  return lines.map((line) => `  ${line}`);
}
// packages/materials/src/material.ts
function keyOf(features, jointCount) {
  return features + (jointCount << 20);
}
var cache = new Map;
function materialOf(desc) {
  const joints = (desc.features & SKIN) !== 0 ? desc.jointCount ?? 0 : 0;
  const key = keyOf(desc.features, joints);
  const found = cache.get(key);
  if (found !== undefined)
    return found;
  const material = assemble(desc.features, joints);
  cache.set(key, material);
  return material;
}
function variantCount() {
  return cache.size;
}
function resetMaterials() {
  cache.clear();
}
export {
  variantCount,
  resetMaterials,
  materialOf,
  assemble,
  TEXTURE,
  SKIN,
  NORMALMAP,
  LAMBERT,
  FLAT_ALBEDO,
  DOUBLE_SIDED,
  CATALOG,
  ALPHA_CUTOFF
};
