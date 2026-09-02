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
var PBR = 1 << 10;
var PBR_D_GGX = 1 << 11;
var PBR_D_BECKMANN = 1 << 12;
var PBR_D_BLINN = 1 << 13;
var PBR_G_SMITH = 1 << 14;
var PBR_G_SMITH_SCHLICK = 1 << 15;
var PBR_G_SMITH_HEIGHT = 1 << 16;
var PBR_G_IMPLICIT = 1 << 17;
var PBR_G_NEUMANN = 1 << 18;
var PBR_G_KELEMEN = 1 << 19;
var PBR_F_SCHLICK = 1 << 20;
var PBR_F_EXACT = 1 << 21;
var PBR_DIFF_LAMBERT = 1 << 22;
var PBR_DIFF_OREN_NAYAR = 1 << 23;
var PBR_DIFF_BURLEY = 1 << 24;
var PBR_MR_TEXTURE = 1 << 25;
var EMISSIVE = 1 << 26;
var FOG = 1 << 27;
var LIGHT_MODELS = LAMBERT | MATCAP | PBR;
var POST_EFFECTS = EMISSIVE | FOG;
var PBR_D_MODELS = PBR_D_GGX | PBR_D_BECKMANN | PBR_D_BLINN;
var PBR_G_MODELS = PBR_G_SMITH | PBR_G_SMITH_SCHLICK | PBR_G_SMITH_HEIGHT | PBR_G_IMPLICIT | PBR_G_NEUMANN | PBR_G_KELEMEN;
var PBR_F_MODELS = PBR_F_SCHLICK | PBR_F_EXACT;
var PBR_DIFF_MODELS = PBR_DIFF_LAMBERT | PBR_DIFF_OREN_NAYAR | PBR_DIFF_BURLEY;
var PBR_SUB_MODELS = PBR_D_MODELS | PBR_G_MODELS | PBR_F_MODELS | PBR_DIFF_MODELS;
var DISTRIBUTION_BITS = {
  ggx: PBR_D_GGX,
  beckmann: PBR_D_BECKMANN,
  "blinn-phong": PBR_D_BLINN
};
var GEOMETRY_BITS = {
  smith: PBR_G_SMITH,
  "smith-schlick": PBR_G_SMITH_SCHLICK,
  "smith-height": PBR_G_SMITH_HEIGHT,
  implicit: PBR_G_IMPLICIT,
  neumann: PBR_G_NEUMANN,
  kelemen: PBR_G_KELEMEN
};
var FRESNEL_BITS = {
  schlick: PBR_F_SCHLICK,
  exact: PBR_F_EXACT
};
var DIFFUSE_BITS = {
  lambert: PBR_DIFF_LAMBERT,
  "oren-nayar": PBR_DIFF_OREN_NAYAR,
  burley: PBR_DIFF_BURLEY
};
function pbrMask(choice = {}) {
  return PBR | DISTRIBUTION_BITS[choice.distribution ?? "ggx"] | GEOMETRY_BITS[choice.geometry ?? "smith"] | FRESNEL_BITS[choice.fresnel ?? "schlick"] | DIFFUSE_BITS[choice.diffuse ?? "lambert"];
}
var has = (ctx, bit) => (ctx.mask & bit) !== 0;
var mutKw = (ctx) => has(ctx, POST_EFFECTS) ? "var" : "let";
var M3_MODEL_WGSL = "mat3x3<f32>(params.u_model[0].xyz, params.u_model[1].xyz, params.u_model[2].xyz)";
var M3_I_WGSL = "mat3x3<f32>(i_col0.xyz, i_col1.xyz, i_col2.xyz)";
var M3_SKIN_WGSL = "mat3x3<f32>(skin[0].xyz, skin[1].xyz, skin[2].xyz)";
function normalVert(ctx) {
  if (has(ctx, NORMALMAP))
    return {};
  const inst = has(ctx, INSTANCED);
  const skin = has(ctx, SKIN);
  const glslInner = skin ? "(mat3(skin) * normal)" : "normal";
  const glslExpr = inst ? `mat3(u_model) * (mat3(i_model) * ${glslInner})` : `mat3(u_model) * ${glslInner}`;
  const wgslInner = skin ? `(${M3_SKIN_WGSL} * normal)` : "normal";
  const wgslExpr = inst ? `${M3_MODEL_WGSL} * (${M3_I_WGSL} * ${wgslInner})` : `${M3_MODEL_WGSL} * ${wgslInner}`;
  return {
    varyings: [{ glslName: "v_normal", wgslName: "worldNormal", glslType: "vec3", wgslType: "vec3<f32>" }],
    glslBody: [`v_normal = ${glslExpr};`],
    wgslOut: [`out.worldNormal = ${wgslExpr};`]
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
function nGlsl(ctx) {
  return has(ctx, NORMALMAP) ? [] : ["vec3 n = normalize(v_normal);", ...flipGlsl(ctx)];
}
function nWgsl(ctx) {
  return has(ctx, NORMALMAP) ? [] : ["var n = normalize(frag.worldNormal);", ...flipWgsl(ctx)];
}
function pbrUniforms(ctx) {
  const uniforms = [
    { name: "u_lightDir", glsl: "uniform vec3 u_lightDir;", wgsl: "u_lightDir : vec4<f32>," },
    { name: "u_lightColor", glsl: "uniform vec3 u_lightColor;", wgsl: "u_lightColor : vec4<f32>," },
    { name: "u_camPos", glsl: "uniform vec3 u_camPos;", wgsl: "u_camPos : vec4<f32>," },
    { name: "u_roughness", glsl: "uniform float u_roughness;", wgsl: "u_roughness : f32," },
    { name: "u_metallic", glsl: "uniform float u_metallic;", wgsl: "u_metallic : f32," }
  ];
  if (has(ctx, PBR_F_EXACT)) {
    uniforms.push({ name: "u_ior", glsl: "uniform float u_ior;", wgsl: "u_ior : f32," });
  }
  return uniforms;
}
function pbrGlslPrologue(ctx) {
  const lines = [
    "vec3 v = normalize(u_camPos - v_worldPos);",
    "vec3 l = normalize(u_lightDir);",
    "vec3 h = normalize(v + l);",
    "float nDotL = max(dot(n, l), 0.0);",
    "float nDotV = max(dot(n, v), 1e-4);",
    "float nDotH = max(dot(n, h), 0.0);",
    "float vDotH = clamp(dot(v, h), 0.0, 1.0);"
  ];
  if (has(ctx, PBR_MR_TEXTURE)) {
    lines.push("vec2 mr = texture(u_mrTex, v_uv).gb;", "float rough = clamp(u_roughness * mr.x, 0.045, 1.0);", "float metal = clamp(u_metallic * mr.y, 0.0, 1.0);");
  } else {
    lines.push("float rough = clamp(u_roughness, 0.045, 1.0);", "float metal = clamp(u_metallic, 0.0, 1.0);");
  }
  lines.push("float a = rough * rough;", "float a2 = a * a;", "vec3 F0 = mix(vec3(0.04), base.rgb, metal);");
  return lines;
}
function pbrWgslPrologue(ctx) {
  const lines = [
    "let v = normalize(params.u_camPos.xyz - frag.worldPos);",
    "let l = normalize(params.u_lightDir.xyz);",
    "let h = normalize(v + l);",
    "let nDotL = max(dot(n, l), 0.0);",
    "let nDotV = max(dot(n, v), 1e-4);",
    "let nDotH = max(dot(n, h), 0.0);",
    "let vDotH = clamp(dot(v, h), 0.0, 1.0);"
  ];
  if (has(ctx, PBR_MR_TEXTURE)) {
    lines.push("let mr = textureSample(mrTexture, texSampler, frag.uv).gb;", "let rough = clamp(params.u_roughness * mr.x, 0.045, 1.0);", "let metal = clamp(params.u_metallic * mr.y, 0.0, 1.0);");
  } else {
    lines.push("let rough = clamp(params.u_roughness, 0.045, 1.0);", "let metal = clamp(params.u_metallic, 0.0, 1.0);");
  }
  lines.push("let a = rough * rough;", "let a2 = a * a;", "let F0 = mix(vec3<f32>(0.04), base.rgb, metal);");
  return lines;
}
function pbrDGlsl(ctx) {
  if (has(ctx, PBR_D_GGX)) {
    return [
      "float dd = nDotH * nDotH * (a2 - 1.0) + 1.0;",
      "float D = a2 / (3.14159265 * dd * dd);"
    ];
  }
  if (has(ctx, PBR_D_BECKMANN)) {
    return [
      "float nh2 = nDotH * nDotH;",
      "float D = exp((nh2 - 1.0) / (a2 * nh2)) / (3.14159265 * a2 * nh2 * nh2);"
    ];
  }
  return [
    "float blinnExp = 2.0 / a2 - 2.0;",
    "float D = (blinnExp + 2.0) * 0.15915494 * pow(nDotH, blinnExp);"
  ];
}
function pbrDWgsl(ctx) {
  if (has(ctx, PBR_D_GGX)) {
    return [
      "let dd = nDotH * nDotH * (a2 - 1.0) + 1.0;",
      "let D = a2 / (3.14159265 * dd * dd);"
    ];
  }
  if (has(ctx, PBR_D_BECKMANN)) {
    return [
      "let nh2 = nDotH * nDotH;",
      "let D = exp((nh2 - 1.0) / (a2 * nh2)) / (3.14159265 * a2 * nh2 * nh2);"
    ];
  }
  return [
    "let blinnExp = 2.0 / a2 - 2.0;",
    "let D = (blinnExp + 2.0) * 0.15915494 * pow(nDotH, blinnExp);"
  ];
}
var SMITH_SQ_GLSL = [
  "float sqL = sqrt(1.0 + a2 * (1.0 - nDotL * nDotL) / max(nDotL * nDotL, 1e-8));",
  "float sqV = sqrt(1.0 + a2 * (1.0 - nDotV * nDotV) / (nDotV * nDotV));"
];
var SMITH_SQ_WGSL = [
  "let sqL = sqrt(1.0 + a2 * (1.0 - nDotL * nDotL) / max(nDotL * nDotL, 1e-8));",
  "let sqV = sqrt(1.0 + a2 * (1.0 - nDotV * nDotV) / (nDotV * nDotV));"
];
function pbrVGlsl(ctx) {
  if (has(ctx, PBR_G_SMITH)) {
    return [...SMITH_SQ_GLSL, "float vis = 1.0 / ((1.0 + sqL) * (1.0 + sqV));"];
  }
  if (has(ctx, PBR_G_SMITH_HEIGHT)) {
    return [
      ...SMITH_SQ_GLSL,
      "float lamL = (sqL - 1.0) * 0.5;",
      "float lamV = (sqV - 1.0) * 0.5;",
      "float vis = 1.0 / max(4.0 * nDotL * nDotV * (1.0 + lamL + lamV), 1e-8);"
    ];
  }
  if (has(ctx, PBR_G_SMITH_SCHLICK)) {
    return [
      "float kk = (rough + 1.0) * (rough + 1.0) * 0.125;",
      "float vis = 0.25 / ((nDotL * (1.0 - kk) + kk) * (nDotV * (1.0 - kk) + kk));"
    ];
  }
  if (has(ctx, PBR_G_IMPLICIT)) {
    return ["float vis = 0.25;"];
  }
  if (has(ctx, PBR_G_NEUMANN)) {
    return ["float vis = 0.25 / max(nDotL, nDotV);"];
  }
  return ["float vis = 0.25 / max(vDotH * vDotH, 1e-8);"];
}
function pbrVWgsl(ctx) {
  if (has(ctx, PBR_G_SMITH)) {
    return [...SMITH_SQ_WGSL, "let vis = 1.0 / ((1.0 + sqL) * (1.0 + sqV));"];
  }
  if (has(ctx, PBR_G_SMITH_HEIGHT)) {
    return [
      ...SMITH_SQ_WGSL,
      "let lamL = (sqL - 1.0) * 0.5;",
      "let lamV = (sqV - 1.0) * 0.5;",
      "let vis = 1.0 / max(4.0 * nDotL * nDotV * (1.0 + lamL + lamV), 1e-8);"
    ];
  }
  if (has(ctx, PBR_G_SMITH_SCHLICK)) {
    return [
      "let kk = (rough + 1.0) * (rough + 1.0) * 0.125;",
      "let vis = 0.25 / ((nDotL * (1.0 - kk) + kk) * (nDotV * (1.0 - kk) + kk));"
    ];
  }
  if (has(ctx, PBR_G_IMPLICIT)) {
    return ["let vis = 0.25;"];
  }
  if (has(ctx, PBR_G_NEUMANN)) {
    return ["let vis = 0.25 / max(nDotL, nDotV);"];
  }
  return ["let vis = 0.25 / max(vDotH * vDotH, 1e-8);"];
}
var SCHLICK_GLSL = [
  "float fT = 1.0 - vDotH;",
  "float fT2 = fT * fT;",
  "float fT4 = fT2 * fT2;",
  "float fT5 = fT4 * fT;"
];
var SCHLICK_WGSL = [
  "let fT = 1.0 - vDotH;",
  "let fT2 = fT * fT;",
  "let fT4 = fT2 * fT2;",
  "let fT5 = fT4 * fT;"
];
function pbrFGlsl(ctx) {
  if (has(ctx, PBR_F_EXACT)) {
    return [
      ...SCHLICK_GLSL,
      "float fC = vDotH;",
      "float fG = sqrt(max(u_ior * u_ior + fC * fC - 1.0, 0.0));",
      "float fQ = (fG - fC) / max(fG + fC, 1e-8);",
      "float fP = (fC * (fG + fC) - 1.0) / (fC * (fG - fC) + 1.0);",
      "float fDia = 0.5 * fQ * fQ * (1.0 + fP * fP);",
      "vec3 F = mix(vec3(fDia), F0 + (vec3(1.0) - F0) * fT5, metal);"
    ];
  }
  return [...SCHLICK_GLSL, "vec3 F = F0 + (vec3(1.0) - F0) * fT5;"];
}
function pbrFWgsl(ctx) {
  if (has(ctx, PBR_F_EXACT)) {
    return [
      ...SCHLICK_WGSL,
      "let fC = vDotH;",
      "let fG = sqrt(max(params.u_ior * params.u_ior + fC * fC - 1.0, 0.0));",
      "let fQ = (fG - fC) / max(fG + fC, 1e-8);",
      "let fP = (fC * (fG + fC) - 1.0) / (fC * (fG - fC) + 1.0);",
      "let fDia = 0.5 * fQ * fQ * (1.0 + fP * fP);",
      "let F = mix(vec3<f32>(fDia), F0 + (vec3<f32>(1.0) - F0) * fT5, metal);"
    ];
  }
  return [...SCHLICK_WGSL, "let F = F0 + (vec3<f32>(1.0) - F0) * fT5;"];
}
function pbrDiffuseGlsl(ctx) {
  const kd = "vec3 kd = (1.0 - metal) * (vec3(1.0) - F);";
  if (has(ctx, PBR_DIFF_OREN_NAYAR)) {
    return [
      kd,
      "float sigma = rough * 1.57079632;",
      "float s2 = sigma * sigma;",
      "float A = 1.0 - 0.5 * s2 / (s2 + 0.33);",
      "float B = 0.45 * s2 / (s2 + 0.09);",
      "float cosPhi = clamp((dot(l, v) - nDotL * nDotV) * inversesqrt(max((1.0 - nDotL * nDotL) * (1.0 - nDotV * nDotV), 1e-4)), 0.0, 1.0);",
      "float cm = min(nDotL, nDotV);",
      "float cb = max(nDotL, nDotV);",
      "float sa = sqrt(max(1.0 - cm * cm, 0.0));",
      "float tb = sqrt(max(1.0 - cb * cb, 0.0)) / cb;",
      "vec3 diffuse = kd * base.rgb * (A + B * cosPhi * sa * tb) * 0.318309886;"
    ];
  }
  if (has(ctx, PBR_DIFF_BURLEY)) {
    return [
      kd,
      "float FD90 = 0.5 + 2.0 * vDotH * vDotH * rough;",
      "float lT = 1.0 - nDotL;",
      "float lT2 = lT * lT;",
      "float lT4 = lT2 * lT2;",
      "float lT5 = lT4 * lT;",
      "float vT = 1.0 - nDotV;",
      "float vT2 = vT * vT;",
      "float vT4 = vT2 * vT2;",
      "float vT5 = vT4 * vT;",
      "vec3 diffuse = kd * base.rgb * (1.0 + (FD90 - 1.0) * lT5) * (1.0 + (FD90 - 1.0) * vT5) * 0.318309886;"
    ];
  }
  return [kd, "vec3 diffuse = kd * base.rgb * 0.318309886;"];
}
function pbrDiffuseWgsl(ctx) {
  const kd = "let kd = (1.0 - metal) * (vec3<f32>(1.0) - F);";
  if (has(ctx, PBR_DIFF_OREN_NAYAR)) {
    return [
      kd,
      "let sigma = rough * 1.57079632;",
      "let s2 = sigma * sigma;",
      "let A = 1.0 - 0.5 * s2 / (s2 + 0.33);",
      "let B = 0.45 * s2 / (s2 + 0.09);",
      "let cosPhi = clamp((dot(l, v) - nDotL * nDotV) * inversesqrt(max((1.0 - nDotL * nDotL) * (1.0 - nDotV * nDotV), 1e-4)), 0.0, 1.0);",
      "let cm = min(nDotL, nDotV);",
      "let cb = max(nDotL, nDotV);",
      "let sa = sqrt(max(1.0 - cm * cm, 0.0));",
      "let tb = sqrt(max(1.0 - cb * cb, 0.0)) / cb;",
      "let diffuse = kd * base.rgb * (A + B * cosPhi * sa * tb) * 0.318309886;"
    ];
  }
  if (has(ctx, PBR_DIFF_BURLEY)) {
    return [
      kd,
      "let FD90 = 0.5 + 2.0 * vDotH * vDotH * rough;",
      "let lT = 1.0 - nDotL;",
      "let lT2 = lT * lT;",
      "let lT4 = lT2 * lT2;",
      "let lT5 = lT4 * lT;",
      "let vT = 1.0 - nDotV;",
      "let vT2 = vT * vT;",
      "let vT4 = vT2 * vT2;",
      "let vT5 = vT4 * vT;",
      "let diffuse = kd * base.rgb * (1.0 + (FD90 - 1.0) * lT5) * (1.0 + (FD90 - 1.0) * vT5) * 0.318309886;"
    ];
  }
  return [kd, "let diffuse = kd * base.rgb * 0.318309886;"];
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
        ...nGlsl(ctx),
        "float lambert = max(dot(n, normalize(u_lightDir)), 0.0);",
        has(ctx, NORMALMAP) ? "vec3 lit = base.rgb * (0.22 + 0.78 * lambert);" : has(ctx, TEXTURE) ? "vec3 lit = base.rgb * (0.35 + 0.65 * lambert);" : "vec3 lit = base.rgb * (0.3 + 0.7 * lambert);"
      ],
      wgslBody: [
        ...nWgsl(ctx),
        "let lambert = max(dot(n, normalize(params.u_lightDir.xyz)), 0.0);",
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
        ...nGlsl(ctx),
        "vec3 nView = normalize(mat3(u_view) * n);",
        "vec2 matcapUv = nView.xy * 0.5 + 0.5;",
        "vec3 lit = base.rgb * texture(u_matcap, matcapUv).rgb;"
      ],
      wgslBody: [
        ...nWgsl(ctx),
        "let nView = normalize((params.u_view * vec4<f32>(n, 0.0)).xyz);",
        "let matcapUv = vec2<f32>(nView.x * 0.5 + 0.5, nView.y * 0.5 + 0.5);",
        "let mc = textureSample(matTexture, texSampler, matcapUv).rgb;",
        `${mutKw(ctx)} lit = base.rgb * mc;`
      ]
    })
  },
  {
    id: "pbr",
    bit: PBR,
    vert: (ctx) => {
      const nv = normalVert(ctx);
      return {
        ...nv,
        varyings: [
          ...nv.varyings ?? [],
          { glslName: "v_worldPos", wgslName: "worldPos", glslType: "vec3", wgslType: "vec3<f32>" }
        ],
        glslBody: [...nv.glslBody ?? [], `v_worldPos = (u_model * ${posVar(ctx)}).xyz;`],
        wgslOut: [...nv.wgslOut ?? [], `out.worldPos = (params.u_model * ${posVar(ctx)}).xyz;`]
      };
    },
    frag: (ctx) => ({
      uniforms: pbrUniforms(ctx),
      glslBody: [
        ...nGlsl(ctx),
        ...pbrGlslPrologue(ctx),
        ...pbrDGlsl(ctx),
        ...pbrVGlsl(ctx),
        ...pbrFGlsl(ctx),
        ...pbrDiffuseGlsl(ctx),
        "vec3 lit = (diffuse + (D * vis) * F) * u_lightColor * nDotL;"
      ],
      wgslBody: [
        ...nWgsl(ctx),
        ...pbrWgslPrologue(ctx),
        ...pbrDWgsl(ctx),
        ...pbrVWgsl(ctx),
        ...pbrFWgsl(ctx),
        ...pbrDiffuseWgsl(ctx),
        `${mutKw(ctx)} lit = (diffuse + (D * vis) * F) * params.u_lightColor.rgb * nDotL;`
      ]
    })
  },
  {
    id: "mrTexture",
    bit: PBR_MR_TEXTURE,
    vert: (ctx) => has(ctx, TEXTURE | NORMALMAP) ? {} : {
      varyings: [{ glslName: "v_uv", wgslName: "uv", glslType: "vec2", wgslType: "vec2<f32>" }],
      glslBody: ["v_uv = uv;"],
      wgslOut: ["out.uv = uv;"]
    },
    frag: (_ctx) => ({})
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
      glslBody: [`v_viewZ = -(u_view * (u_model * ${posVar(ctx)})).z;`],
      wgslOut: [`out.viewZ = -(params.u_view * (params.u_model * ${posVar(ctx)})).z;`]
    }),
    frag: (_ctx) => ({
      uniforms: [
        { name: "u_fogColor", glsl: "uniform vec3 u_fogColor;", wgsl: "u_fogColor : vec4<f32>," },
        { name: "u_fogNear", glsl: "uniform float u_fogNear;", wgsl: "u_fogNear : f32," },
        { name: "u_fogFar", glsl: "uniform float u_fogFar;", wgsl: "u_fogFar : f32," }
      ],
      glslBody: [
        "float fogFactor = clamp((v_viewZ - u_fogNear) / (u_fogFar - u_fogNear), 0.0, 1.0);",
        "lit = mix(lit, u_fogColor, fogFactor);"
      ],
      wgslBody: [
        "let fogFactor = clamp((frag.viewZ - params.u_fogNear) / (params.u_fogFar - params.u_fogNear), 0.0, 1.0);",
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
  const needsNormal = (mask & (LAMBERT | MATCAP | PBR)) !== 0 && (mask & NORMALMAP) === 0;
  const needsUv = (mask & (TEXTURE | NORMALMAP | PBR_MR_TEXTURE)) !== 0;
  sc.attrs.push({ name: "position", glslType: "vec3", wgslType: "vec3<f32>" });
  if (needsNormal)
    sc.attrs.push({ name: "normal", glslType: "vec3", wgslType: "vec3<f32>" });
  if (needsUv)
    sc.attrs.push({ name: "uv", glslType: "vec2", wgslType: "vec2<f32>" });
  const hasLight = (mask & (LAMBERT | MATCAP | PBR)) !== 0;
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
  if ((mask & PBR_MR_TEXTURE) !== 0)
    sc.samplers.push("u_mrTex");
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
var LIGHT_MODELS_ALL = LAMBERT | MATCAP | PBR;
function popcount(v) {
  let c = 0;
  while (v !== 0) {
    v &= v - 1;
    c++;
  }
  return c;
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
  if (popcount(mask & LIGHT_MODELS_ALL) > 1) {
    throw new Error("rune/materials: LAMBERT, MATCAP and PBR are mutually exclusive light models");
  }
  if ((mask & SKIN) !== 0 && (!Number.isInteger(jointCount) || jointCount < 1)) {
    throw new Error("rune/materials: SKIN requires jointCount >= 1");
  }
  if ((mask & (PBR_SUB_MODELS | PBR_MR_TEXTURE)) !== 0 && (mask & PBR) === 0) {
    throw new Error("rune/materials: the PBR sub-model bits require PBR");
  }
  if ((mask & PBR) !== 0) {
    if (popcount(mask & PBR_D_MODELS) !== 1) {
      throw new Error(`rune/materials: PBR needs exactly one distribution (got ${popcount(mask & PBR_D_MODELS)} of ` + `PBR_D_GGX | PBR_D_BECKMANN | PBR_D_BLINN — pbrMask() defaults to GGX)`);
    }
    if (popcount(mask & PBR_G_MODELS) !== 1) {
      throw new Error(`rune/materials: PBR needs exactly one geometry model (got ${popcount(mask & PBR_G_MODELS)} of ` + `PBR_G_SMITH | PBR_G_SMITH_SCHLICK | PBR_G_SMITH_HEIGHT | PBR_G_IMPLICIT | PBR_G_NEUMANN | PBR_G_KELEMEN)`);
    }
    if (popcount(mask & PBR_F_MODELS) !== 1) {
      throw new Error(`rune/materials: PBR needs exactly one fresnel model (got ${popcount(mask & PBR_F_MODELS)} of ` + `PBR_F_SCHLICK | PBR_F_EXACT)`);
    }
    if (popcount(mask & PBR_DIFF_MODELS) !== 1) {
      throw new Error(`rune/materials: PBR needs exactly one diffuse model (got ${popcount(mask & PBR_DIFF_MODELS)} of ` + `PBR_DIFF_LAMBERT | PBR_DIFF_OREN_NAYAR | PBR_DIFF_BURLEY)`);
    }
    if ((mask & (PBR_G_SMITH | PBR_G_SMITH_HEIGHT)) !== 0 && (mask & PBR_D_GGX) === 0) {
      throw new Error("rune/materials: PBR_G_SMITH and PBR_G_SMITH_HEIGHT are Smith-GGX terms — they require PBR_D_GGX");
    }
  }
  if (jointCount >= 8192) {
    throw new Error("rune/materials: jointCount must be < 8192 (the variant cache key stride)");
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
  frag.push("#version 300 es", (mask & PBR) !== 0 ? "precision highp float;" : "precision mediump float;");
  if ((mask & NORMALMAP) !== 0)
    frag.push("uniform mat4 u_model;");
  if ((mask & TEXTURE) !== 0)
    frag.push("uniform sampler2D u_tex;");
  if ((mask & NORMALMAP) !== 0)
    frag.push("uniform sampler2D u_normalMap;");
  if ((mask & MATCAP) !== 0)
    frag.push("uniform sampler2D u_matcap;");
  if ((mask & PBR_MR_TEXTURE) !== 0)
    frag.push("uniform sampler2D u_mrTex;");
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
  if ((mask & (TEXTURE | NORMALMAP | MATCAP | PBR_MR_TEXTURE)) !== 0) {
    lines.push("@group(1) @binding(0) var texSampler : sampler;");
  }
  if ((mask & TEXTURE) !== 0)
    lines.push("@group(1) @binding(1) var texTexture : texture_2d<f32>;");
  if ((mask & NORMALMAP) !== 0)
    lines.push("@group(1) @binding(2) var nrmTexture : texture_2d<f32>;");
  if ((mask & MATCAP) !== 0)
    lines.push("@group(1) @binding(3) var matTexture : texture_2d<f32>;");
  if ((mask & PBR_MR_TEXTURE) !== 0)
    lines.push("@group(1) @binding(4) var mrTexture : texture_2d<f32>;");
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
var KEY_STRIDE = 8192;
function keyOf(features, jointCount) {
  return features * KEY_STRIDE + jointCount;
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
  pbrMask,
  materialOf,
  assemble,
  VERTEX_COLOR,
  TEXTURE,
  SKIN,
  POST_EFFECTS,
  PBR_SUB_MODELS,
  PBR_MR_TEXTURE,
  PBR_G_SMITH_SCHLICK,
  PBR_G_SMITH_HEIGHT,
  PBR_G_SMITH,
  PBR_G_NEUMANN,
  PBR_G_MODELS,
  PBR_G_KELEMEN,
  PBR_G_IMPLICIT,
  PBR_F_SCHLICK,
  PBR_F_MODELS,
  PBR_F_EXACT,
  PBR_D_MODELS,
  PBR_D_GGX,
  PBR_D_BLINN,
  PBR_D_BECKMANN,
  PBR_DIFF_OREN_NAYAR,
  PBR_DIFF_MODELS,
  PBR_DIFF_LAMBERT,
  PBR_DIFF_BURLEY,
  PBR,
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
