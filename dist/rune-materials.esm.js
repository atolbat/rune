// packages/materials/src/features.ts
var SKIN = 1 << 0;
var INSTANCED = 1 << 1;
var NORMALMAP = 1 << 2;
var TEXTURE = 1 << 3;
var FLAT_ALBEDO = 1 << 4;
var VERTEX_COLOR = 1 << 5;
var DOUBLE_SIDED = 1 << 6;
var ALPHA_CUTOFF = 1 << 7;
var LAMBERT = 1 << 8;
var MATCAP = 1 << 9;
var EMISSIVE = 1 << 10;
var FOG = 1 << 11;
var LIGHT_MODELS = LAMBERT | MATCAP;
var POST_EFFECTS = EMISSIVE | FOG;
var has = (ctx, bit) => (ctx.mask & bit) !== 0;
var mutKw = (ctx) => has(ctx, POST_EFFECTS) ? "var" : "let";
function normalVert(ctx) {
  if (has(ctx, NORMALMAP))
    return {};
  const inst = has(ctx, INSTANCED) ? " * mat3(i_model)" : "";
  const skin = has(ctx, SKIN) ? " * mat3(skin)" : "";
  return {
    varyings: [{ glslName: "v_normal", wgslName: "worldNormal", glslType: "vec3", wgslType: "vec3<f32>" }],
    glslBody: [`v_normal = mat3(u_model)${inst}${skin} * normal;`],
    wgslOut: [
      `out.worldNormal = (params.u_model * ${has(ctx, INSTANCED) ? "(i_model * " : ""}` + `${has(ctx, SKIN) ? "(skin * vec4<f32>(normal, 0.0))" : "vec4<f32>(normal, 0.0)"}` + `${has(ctx, INSTANCED) ? ")" : ""}).xyz;`
    ]
  };
}
function posVar(ctx) {
  return has(ctx, INSTANCED) ? "position4Inst" : "position4";
}
function flipGlsl(ctx) {
  return has(ctx, DOUBLE_SIDED) ? ["if (!gl_FrontFacing) n = -n;"] : [];
}
function flipWgsl(ctx) {
  return has(ctx, DOUBLE_SIDED) ? ["n = select(-n, n, frag.ff);"] : [];
}
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
    id: "instanced",
    bit: INSTANCED,
    vert: (_ctx) => ({
      attrs: [
        { name: "i_col0", glslType: "vec4", wgslType: "vec4<f32>", instance: true },
        { name: "i_col1", glslType: "vec4", wgslType: "vec4<f32>", instance: true },
        { name: "i_col2", glslType: "vec4", wgslType: "vec4<f32>", instance: true },
        { name: "i_col3", glslType: "vec4", wgslType: "vec4<f32>", instance: true }
      ],
      glslBody: [
        "mat4 i_model = mat4(i_col0, i_col1, i_col2, i_col3);",
        "vec4 position4Inst = i_model * position4;"
      ],
      wgslPre: [
        "let i_model = mat4x4<f32>(i_col0, i_col1, i_col2, i_col3);",
        "let position4Inst = i_model * position4;"
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
        ...flipGlsl(ctx)
      ],
      wgslBody: [
        "let nObj = textureSample(nrmTexture, texSampler, frag.uv).xyz * 2.0 - 1.0;",
        "var n = normalize((params.u_model * vec4<f32>(nObj, 0.0)).xyz);",
        ...flipWgsl(ctx)
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
    frag: (ctx) => ({
      glslBody: [`vec4 base = texture(u_tex, v_uv);`],
      wgslBody: [`${has(ctx, VERTEX_COLOR) ? "var" : "let"} base = textureSample(texTexture, texSampler, frag.uv);`]
    })
  },
  {
    id: "flatAlbedo",
    bit: FLAT_ALBEDO,
    vert: (_ctx) => ({}),
    frag: (ctx) => ({
      uniforms: [
        { name: "u_albedo", glsl: "uniform vec3 u_albedo;", wgsl: "u_albedo : vec4<f32>," }
      ],
      glslBody: ["vec4 base = vec4(u_albedo, 1.0);"],
      wgslBody: [`${has(ctx, VERTEX_COLOR) ? "var" : "let"} base = vec4<f32>(params.u_albedo.rgb, 1.0);`]
    })
  },
  {
    id: "vertexColor",
    bit: VERTEX_COLOR,
    vert: (_ctx) => ({
      attrs: [{ name: "color", glslType: "vec4", wgslType: "vec4<f32>" }],
      varyings: [{ glslName: "v_color", wgslName: "color", glslType: "vec4", wgslType: "vec4<f32>" }],
      glslBody: ["v_color = color;"],
      wgslOut: ["out.color = color;"]
    }),
    frag: (_ctx) => ({
      glslBody: ["base *= v_color;"],
      wgslBody: ["base = base * frag.color;"]
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
    vert: (ctx) => normalVert(ctx),
    frag: (ctx) => ({
      uniforms: [
        { name: "u_lightDir", glsl: "uniform vec3 u_lightDir;", wgsl: "u_lightDir : vec4<f32>," }
      ],
      glslBody: [
        ...has(ctx, NORMALMAP) ? [] : ["vec3 n = normalize(v_normal);", ...flipGlsl(ctx)],
        "float lambert = max(dot(n, normalize(u_lightDir)), 0.0);",
        has(ctx, NORMALMAP) ? "vec3 lit = base.rgb * (0.22 + 0.78 * lambert);" : has(ctx, TEXTURE) ? "vec3 lit = base.rgb * (0.35 + 0.65 * lambert);" : "vec3 lit = base.rgb * (0.3 + 0.7 * lambert);"
      ],
      wgslBody: [
        ...has(ctx, NORMALMAP) ? [] : ["var n = normalize(frag.worldNormal);", ...flipWgsl(ctx)],
        "let lambert = max(dot(normalize(n), normalize(params.u_lightDir.xyz)), 0.0);",
        has(ctx, NORMALMAP) ? `${mutKw(ctx)} lit = base.rgb * (0.22 + 0.78 * lambert);` : has(ctx, TEXTURE) ? `${mutKw(ctx)} lit = base.rgb * (0.35 + 0.65 * lambert);` : `${mutKw(ctx)} lit = base.rgb * (0.3 + 0.7 * lambert);`
      ]
    })
  },
  {
    id: "matcap",
    bit: MATCAP,
    vert: (ctx) => normalVert(ctx),
    frag: (ctx) => ({
      uniforms: [
        { name: "u_view", glsl: "uniform mat4 u_view;", wgsl: "u_view : mat4x4<f32>," }
      ],
      glslBody: [
        ...has(ctx, NORMALMAP) ? [] : ["vec3 n = normalize(v_normal);", ...flipGlsl(ctx)],
        "vec3 nView = normalize(mat3(u_view) * n);",
        "vec2 matcapUv = nView.xy * 0.5 + 0.5;",
        "vec3 lit = base.rgb * texture(u_matcap, matcapUv).rgb;"
      ],
      wgslBody: [
        ...has(ctx, NORMALMAP) ? [] : ["var n = normalize(frag.worldNormal);", ...flipWgsl(ctx)],
        "let nView = normalize((params.u_view * vec4<f32>(n, 0.0)).xyz);",
        "let matcapUv = vec2<f32>(nView.x * 0.5 + 0.5, nView.y * 0.5 + 0.5);",
        "let mc = textureSample(matTexture, texSampler, matcapUv).rgb;",
        `${mutKw(ctx)} lit = base.rgb * mc;`
      ]
    })
  },
  {
    id: "emissive",
    bit: EMISSIVE,
    vert: (_ctx) => ({}),
    frag: (_ctx) => ({
      uniforms: [
        { name: "u_emissive", glsl: "uniform vec3 u_emissive;", wgsl: "u_emissive : vec4<f32>," }
      ],
      glslBody: ["lit += u_emissive;"],
      wgslBody: ["lit += params.u_emissive.rgb;"]
    })
  },
  {
    id: "fog",
    bit: FOG,
    vert: (ctx) => ({
      uniforms: [
        { name: "u_view", glsl: "uniform mat4 u_view;", wgsl: "u_view : mat4x4<f32>," }
      ],
      varyings: [{ glslName: "v_viewZ", wgslName: "viewZ", glslType: "float", wgslType: "f32" }],
      glslBody: [`v_viewZ = (u_view * u_model * ${posVar(ctx)}).z;`],
      wgslOut: [`out.viewZ = (params.u_view * params.u_model * ${posVar(ctx)}).z;`]
    }),
    frag: (_ctx) => ({
      uniforms: [
        { name: "u_fogColor", glsl: "uniform vec3 u_fogColor;", wgsl: "u_fogColor : vec4<f32>," },
        { name: "u_fogNear", glsl: "uniform float u_fogNear;", wgsl: "u_fogNear : f32," },
        { name: "u_fogFar", glsl: "uniform float u_fogFar;", wgsl: "u_fogFar : f32," }
      ],
      glslBody: [
        "float fogFactor = clamp((-v_viewZ - u_fogNear) / (u_fogFar - u_fogNear), 0.0, 1.0);",
        "lit = mix(lit, u_fogColor, fogFactor);"
      ],
      wgslBody: [
        "let fogFactor = clamp((-frag.viewZ - params.u_fogNear) / (params.u_fogFar - params.u_fogNear), 0.0, 1.0);",
        "lit = mix(lit, params.u_fogColor.rgb, fogFactor);"
      ]
    })
  }
];
// packages/materials/src/assemble.ts
var sc = {
  vertUniforms: [],
  fragUniforms: [],
  attrs: [],
  varyings: [],
  vertGlsl: [],
  vertWgslPre: [],
  vertWgslOut: [],
  fragGlsl: [],
  fragWgsl: [],
  vertBody: [],
  vertParts: [],
  fragParts: [],
  wgslParts: [],
  uniforms: [],
  samplers: []
};
function assemble(mask, jointCount) {
  validate(mask, jointCount);
  const ctx = { mask, jointCount };
  resetScratch();
  const needsNormal = (mask & (LAMBERT | MATCAP)) !== 0 && (mask & NORMALMAP) === 0;
  const needsUv = (mask & (TEXTURE | NORMALMAP)) !== 0;
  sc.attrs.push({ name: "position", glslType: "vec3", wgslType: "vec3<f32>" });
  if (needsNormal)
    sc.attrs.push({ name: "normal", glslType: "vec3", wgslType: "vec3<f32>" });
  if (needsUv)
    sc.attrs.push({ name: "uv", glslType: "vec2", wgslType: "vec2<f32>" });
  const hasLight = (mask & (LAMBERT | MATCAP)) !== 0;
  const hasPost = (mask & (EMISSIVE | FOG)) !== 0;
  let litFallback = false;
  for (const feature of CATALOG) {
    if ((mask & feature.bit) === 0)
      continue;
    if (!hasLight && !litFallback && (feature.bit === EMISSIVE || feature.bit === FOG)) {
      sc.fragGlsl.push("vec3 lit = base.rgb;");
      sc.fragWgsl.push("var lit = base.rgb;");
      litFallback = true;
    }
    const v = feature.vert(ctx);
    if (v.uniforms !== undefined)
      appendUnique(sc.vertUniforms, v.uniforms, byName);
    if (v.attrs !== undefined)
      appendUnique(sc.attrs, v.attrs, byName);
    if (v.varyings !== undefined)
      appendUnique(sc.varyings, v.varyings, (item) => item.glslName);
    if (v.glslBody !== undefined)
      sc.vertGlsl.push(...v.glslBody);
    if (v.wgslPre !== undefined)
      sc.vertWgslPre.push(...v.wgslPre);
    if (v.wgslOut !== undefined)
      sc.vertWgslOut.push(...v.wgslOut);
    const f = feature.frag(ctx);
    if (f.uniforms !== undefined)
      appendUnique(sc.fragUniforms, f.uniforms, byName);
    if (f.glslBody !== undefined)
      sc.fragGlsl.push(...f.glslBody);
    if (f.wgslBody !== undefined)
      sc.fragWgsl.push(...f.wgslBody);
    if (f.frontFacing === true)
      frontFacing = true;
  }
  const pos = (mask & INSTANCED) !== 0 ? "position4Inst" : "position4";
  if ((mask & SKIN) === 0) {
    sc.vertGlsl.unshift("vec4 position4 = vec4(position, 1.0);");
    sc.vertWgslPre.unshift("let position4 = vec4<f32>(position, 1.0);");
  }
  sc.vertGlsl.push(`gl_Position = u_mvp * ${pos};`);
  if (hasLight || hasPost) {
    const alpha = (mask & NORMALMAP) !== 0 ? "1.0" : "base.a";
    sc.fragGlsl.push(`o_color = vec4(lit, ${alpha});`);
    sc.fragWgsl.push(`return vec4<f32>(lit, ${alpha});`);
  } else {
    sc.fragGlsl.push("o_color = base;");
    sc.fragWgsl.push("return base;");
  }
  appendUnique(sc.uniforms, sc.vertUniforms, byName);
  appendUnique(sc.uniforms, sc.fragUniforms, byName);
  if ((mask & TEXTURE) !== 0)
    sc.samplers.push("u_tex");
  if ((mask & NORMALMAP) !== 0)
    sc.samplers.push("u_normalMap");
  if ((mask & MATCAP) !== 0)
    sc.samplers.push("u_matcap");
  const glsl = buildGlsl(mask, sc.vertUniforms, sc.fragUniforms);
  const wgsl = buildWgsl(mask, pos);
  return {
    mask,
    jointCount,
    glsl,
    wgsl,
    attributes: sc.attrs.slice(),
    uniforms: sc.uniforms.slice(),
    samplers: sc.samplers.slice()
  };
}
var frontFacing = false;
function resetScratch() {
  frontFacing = false;
  for (const list of [
    sc.vertUniforms,
    sc.fragUniforms,
    sc.attrs,
    sc.varyings,
    sc.vertGlsl,
    sc.vertWgslPre,
    sc.vertWgslOut,
    sc.fragGlsl,
    sc.fragWgsl,
    sc.vertBody,
    sc.vertParts,
    sc.fragParts,
    sc.wgslParts,
    sc.uniforms,
    sc.samplers
  ])
    list.length = 0;
}
function validate(mask, jointCount) {
  if ((mask & (TEXTURE | FLAT_ALBEDO)) === (TEXTURE | FLAT_ALBEDO)) {
    throw new Error("rune/materials: TEXTURE and FLAT_ALBEDO are mutually exclusive (one base color source)");
  }
  if ((mask & ALPHA_CUTOFF) !== 0 && (mask & TEXTURE) === 0) {
    throw new Error("rune/materials: ALPHA_CUTOFF requires TEXTURE (the alpha comes from the map)");
  }
  if ((mask & (TEXTURE | FLAT_ALBEDO)) === 0) {
    throw new Error("rune/materials: a material needs a base color source (TEXTURE or FLAT_ALBEDO)");
  }
  if ((mask & (LAMBERT | MATCAP)) === (LAMBERT | MATCAP)) {
    throw new Error("rune/materials: LAMBERT and MATCAP are mutually exclusive light models");
  }
  if ((mask & SKIN) !== 0 && (!Number.isInteger(jointCount) || jointCount < 1)) {
    throw new Error("rune/materials: SKIN requires jointCount >= 1");
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
function pushBody(parts, open, lines, close) {
  if (lines.length === 0) {
    parts.push(open, close);
    return;
  }
  parts.push(open, "  " + lines.join(`
  `), close);
}
function buildGlsl(mask, vertUniforms, fragUniforms) {
  const vert = sc.vertParts;
  vert.push("#version 300 es");
  sc.attrs.forEach((attr, at) => vert.push(`layout(location = ${at}) in ${attr.glslType} ${attr.name};`));
  vert.push("uniform mat4 u_mvp;");
  vert.push("uniform mat4 u_model;");
  for (const uniform of vertUniforms)
    vert.push(uniform.glsl);
  for (const varying of sc.varyings)
    vert.push(`out ${varying.glslType} ${varying.glslName};`);
  pushBody(vert, "void main() {", sc.vertGlsl, "}");
  const frag = sc.fragParts;
  frag.push("#version 300 es", "precision mediump float;");
  if ((mask & NORMALMAP) !== 0)
    frag.push("uniform mat4 u_model;");
  if ((mask & TEXTURE) !== 0)
    frag.push("uniform sampler2D u_tex;");
  if ((mask & NORMALMAP) !== 0)
    frag.push("uniform sampler2D u_normalMap;");
  if ((mask & MATCAP) !== 0)
    frag.push("uniform sampler2D u_matcap;");
  for (const varying of sc.varyings)
    frag.push(`in ${varying.glslType} ${varying.glslName};`);
  for (const uniform of fragUniforms)
    frag.push(uniform.glsl);
  frag.push("out vec4 o_color;");
  pushBody(frag, "void main() {", sc.fragGlsl, "}");
  return { vertex: vert.join(`
`), fragment: frag.join(`
`) };
}
function buildWgsl(mask, pos) {
  const lines = sc.wgslParts;
  lines.push("struct Params {", "  u_mvp : mat4x4<f32>,", "  u_model : mat4x4<f32>,");
  for (const uniform of sc.uniforms)
    lines.push(`  ${uniform.wgsl}`);
  lines.push("}");
  lines.push("@group(0) @binding(0) var<uniform> params : Params;");
  if ((mask & (TEXTURE | NORMALMAP | MATCAP)) !== 0) {
    lines.push("@group(1) @binding(0) var texSampler : sampler;");
  }
  if ((mask & TEXTURE) !== 0)
    lines.push("@group(1) @binding(1) var texTexture : texture_2d<f32>;");
  if ((mask & NORMALMAP) !== 0)
    lines.push("@group(1) @binding(2) var nrmTexture : texture_2d<f32>;");
  if ((mask & MATCAP) !== 0)
    lines.push("@group(1) @binding(3) var matTexture : texture_2d<f32>;");
  lines.push("struct VSOut {", "  @builtin(position) pos : vec4<f32>,");
  sc.varyings.forEach((varying, at) => lines.push(`  @location(${at}) ${varying.wgslName} : ${varying.wgslType},`));
  lines.push("}");
  lines.push("@vertex");
  lines.push("fn vsMain(");
  sc.attrs.forEach((attr, at) => lines.push(`  @location(${at}) ${attr.name} : ${attr.wgslType},`));
  const body = sc.vertBody;
  body.push(...sc.vertWgslPre);
  body.push("var out : VSOut;");
  body.push(`out.pos = params.u_mvp * ${pos};`);
  body.push(...sc.vertWgslOut);
  body.push("return out;");
  pushBody(lines, ") -> VSOut {", body, "}");
  if (frontFacing) {
    lines.push("struct FSIn {");
    sc.varyings.forEach((varying, at) => lines.push(`  @location(${at}) ${varying.wgslName} : ${varying.wgslType},`));
    lines.push("  @builtin(front_facing) ff : bool,");
    lines.push("}");
  }
  lines.push("@fragment");
  lines.push(`fn fsMain(frag : ${frontFacing ? "FSIn" : "VSOut"}) -> @location(0) vec4<f32> {`);
  if (sc.fragWgsl.length > 0)
    lines.push("  " + sc.fragWgsl.join(`
  `));
  lines.push("}");
  return lines.join(`
`);
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
  VERTEX_COLOR,
  TEXTURE,
  SKIN,
  POST_EFFECTS,
  NORMALMAP,
  MATCAP,
  LIGHT_MODELS,
  LAMBERT,
  INSTANCED,
  FOG,
  FLAT_ALBEDO,
  EMISSIVE,
  DOUBLE_SIDED,
  CATALOG,
  ALPHA_CUTOFF
};
