// forest/shaders.js — Task 223 — THE TREE COLUMNS.
//
// The dictionary pattern (the occlusion demo's shaders.js): WGSL and GLSL
// ES 3.00 stay two columns, ONE contract each. The terrain columns are the
// walker's own (imported — the same bricks, the same sky); these are the
// TREE's programs — one per MATERIAL (bark · cull back — a closed tube
// with consistent winding / leaf · cull none — an unshared triangle cloud
// with MIXED winding, no inside/outside), each in TWO passes:
//
//   z    — the tile's own contract: depth-only, the VERDICT COLLAPSE
//          optional (misc.y: 0 = the full band fill, 1 = the visible-set
//          refine), the fragment writes the EXACT depth.
//   color— the lit + textured + fogged image: the leaf/bark texture, the
//          lambert over the smooth normals with THE VIEW-DIR FLIP (the
//          leaf soup's mixed winding — the normal flips to face the eye;
//          bit-identical math on both backends), the fog into the sky.
//
// THE QUANTIZED FEED (Task 223): positions i16×4 snorm decoded over the
// draw's own [posMin, posMax] (per LOD × material — the uniforms carry
// the mesh's bbox); normals i8×4 snorm (direct); uvs i16×2 snorm over
// [uvA.xy, uvA.zw].
//
// THE RECORD LAYOUT (stride 12 words — the occlusion contract, the spare
// words the tree's own):
//   [0..2] center — the AABB's center (the cull kernel's feed)
//   [3..5] half   — the AABB's half extents (yaw-inflated: a disc)
//   [6]    yaw    — the instance's rotation
//   [7]    scale  — the instance's uniform scale (the AABB carries it —
//                   the cull and the draw agree by construction)
//
// THE VERDICT COLLAPSE: WG reads the SMOOTHED verdict (the hist word's
// low byte — 1 visible / 4 straddle pass) from the scene storage at
// HIST_OFF + id; GL reads the 'flags' attribute feed (the hist pair —
// floor() decodes both the raw and the encoded forms). A collapsed
// instance writes z = 2 — past the far plane, zero pixels, zero
// readbacks, no CPU list.
//
// The uniforms block (BOTH passes, one shape — the spare lanes cost
// nothing and the caller packs once):
//   [mvp: 16][misc: 4 — baseInstance / collapseGate / _ / _]
//   [posMin: 4][posScale: 4][uvA: 4 — uvMin.xy, uvMax.xy][light: 4][cam: 4]
// The GL lanes are BY NAME in that word order (the z pass's four first).

export function treeShaders(scene) {
  const { INST_OFF, HIST_OFF, STRIDE } = scene

  // ── WG: the record fetch + decode + collapse (shared by both passes) ──
  const WG_FETCH = `
  let id = u32(params.misc.x) + ii;
  var alive = true;
  if (params.misc.y > 0.5) {
    let verdict = scene[${HIST_OFF}u + id] & 0xFFu;
    if (verdict != 1u && verdict != 4u) { alive = false; }
  }
  let wo = ${INST_OFF}u + id * ${STRIDE}u;
  let c = vec3<f32>(bitcast<f32>(scene[wo]), bitcast<f32>(scene[wo + 1u]), bitcast<f32>(scene[wo + 2u]));
  let h = vec3<f32>(bitcast<f32>(scene[wo + 3u]), bitcast<f32>(scene[wo + 4u]), bitcast<f32>(scene[wo + 5u]));
  let yaw = bitcast<f32>(scene[wo + 6u]);
  let scl = bitcast<f32>(scene[wo + 7u]);
  let local = params.posMin.xyz + (a_pos.xyz * 0.5 + vec3<f32>(0.5)) * params.posScale.xyz;
  let cs = cos(yaw); let sn = sin(yaw);
  let rot = vec3<f32>(local.x * cs + local.z * sn, local.y, -local.x * sn + local.z * cs);
  let world = vec3<f32>(c.x, c.y - h.y, c.z) + rot * scl;
`
  const WG_STRUCT = `
struct Params {
  mvp: mat4x4<f32>,
  misc: vec4<f32>,
  posMin: vec4<f32>,
  posScale: vec4<f32>,
  uvA: vec4<f32>,
  light: vec4<f32>,
  cam: vec4<f32>,
}
@group(0) @binding(0) var<uniform> params: Params;
@group(2) @binding(0) var<storage, read> scene: array<u32>;
`

  const zWg = `${WG_STRUCT}
struct VOut { @builtin(position) pos: vec4<f32> }
@vertex fn vsMain(@location(0) a_pos: vec4<f32>, @builtin(instance_index) ii: u32) -> VOut {
  ${WG_FETCH}
  var o: VOut;
  o.pos = select(vec4<f32>(0.0, 0.0, 2.0, 1.0), params.mvp * vec4<f32>(world, 1.0), alive);
  return o;
}
@fragment fn fsMain(i: VOut) -> @location(0) vec4<f32> {
  return vec4<f32>(i.pos.z, 0.0, 0.0, 1.0);
}`

  const colorWg = `${WG_STRUCT}
@group(1) @binding(0) var samp: sampler;
@group(1) @binding(1) var tex: texture_2d<f32>;
struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) world: vec3<f32>,
  @location(1) n: vec3<f32>,
  @location(2) uv: vec2<f32>,
}
@vertex fn vsMain(
  @location(0) a_pos: vec4<f32>,
  @location(1) a_nrm: vec4<f32>,
  @location(2) a_uv: vec2<f32>,
  @builtin(instance_index) ii: u32,
) -> VOut {
  ${WG_FETCH}
  var o: VOut;
  o.pos = select(vec4<f32>(0.0, 0.0, 2.0, 1.0), params.mvp * vec4<f32>(world, 1.0), alive);
  o.world = world;
  o.n = a_nrm.xyz;
  o.uv = params.uvA.xy + (a_uv * vec2<f32>(0.5) + vec2<f32>(0.5)) * (params.uvA.zw - params.uvA.xy);
  return o;
}
@fragment fn fsMain(v: VOut) -> @location(0) vec4<f32> {
  // THE VIEW-DIR FLIP (the leaf soup's mixed winding): the normal faces
  // the eye — a needle lights from either side; the bark (a closed tube)
  // never flips in practice. The GL twin runs the SAME math (bit-parity).
  let vd = normalize(params.cam.xyz - v.world);
  let n = normalize(select(-v.n, v.n, dot(v.n, vd) >= 0.0));
  let lam = clamp(dot(n, normalize(params.light.xyz)), 0.0, 1.0);
  let texc = textureSample(tex, samp, v.uv);
  var col = texc.rgb * (0.40 + 0.60 * lam);
  let dist = distance(v.world, params.cam.xyz);
  let fog = clamp((dist - 130.0) / 110.0, 0.0, 1.0);
  col = mix(col, vec3<f32>(0.56, 0.66, 0.78), fog * 0.94);
  return vec4<f32>(col, 1.0);
}`

  // ── GL: the columns ─────────────────────────────────────────────────────
  const GL_VS_COMMON = `
  float keep = 1.0;
  if (u_misc.y > 0.5 && floor(a_flag) != 1.0 && floor(a_flag) != 4.0) { keep = 0.0; }
  vec3 local = u_posMin.xyz + (a_pos.xyz * 0.5 + 0.5) * u_posScale.xyz;
  float cs = cos(a_rot.x); float sn = sin(a_rot.x);
  vec3 rot = vec3(local.x * cs + local.z * sn, local.y, -local.x * sn + local.z * cs);
  vec3 world = vec3(a_c.x, a_c.y - a_h.y, a_c.z) + rot * a_rot.y;
  gl_Position = u_mvp * vec4(world, 1.0);
  if (keep < 0.5) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); }
`
  const glHeader = withNrm => `#version 300 es
layout(location=0) in vec4 a_pos;
${withNrm ? 'layout(location=1) in vec4 a_nrm;\nlayout(location=2) in vec2 a_uv;\n' : ''}layout(location=3) in vec3 a_c;
layout(location=4) in vec3 a_h;
layout(location=5) in vec2 a_rot;
layout(location=6) in float a_flag;
uniform mat4 u_mvp;
uniform vec4 u_misc;
uniform vec4 u_posMin;
uniform vec4 u_posScale;`
  const glAttrs = withNrm => {
    const attrs = [{ location: 0, from: 'mesh', mesh: 0, size: 4, stride: 8, offset: 0, divisor: 0 }]
    if (withNrm) {
      attrs.push({ location: 1, from: 'mesh', mesh: 1, size: 4, stride: 4, offset: 0, divisor: 0 })
      attrs.push({ location: 2, from: 'mesh', mesh: 2, size: 2, stride: 4, offset: 0, divisor: 0 })
    }
    attrs.push(
      { location: 3, from: 'records', size: 3, stride: 48, offset: 0, divisor: 1 },
      { location: 4, from: 'records', size: 3, stride: 48, offset: 12, divisor: 1 },
      { location: 5, from: 'records', size: 2, stride: 48, offset: 24, divisor: 1 },
      { location: 6, from: 'flags', size: 1, stride: 4, offset: 0, divisor: 1 },
    )
    return attrs
  }
  const zLanes = [
    { name: 'u_mvp', kind: 'mat4', words: 16 },
    { name: 'u_misc', kind: 'vec4', words: 4 },
    { name: 'u_posMin', kind: 'vec4', words: 4 },
    { name: 'u_posScale', kind: 'vec4', words: 4 },
  ]
  const colorLanes = [...zLanes,
    { name: 'u_uvA', kind: 'vec4', words: 4 },
    { name: 'u_light', kind: 'vec4', words: 4 },
    { name: 'u_cam', kind: 'vec4', words: 4 },
  ]

  const zGl = {
    vs: `${glHeader(false)}\nvoid main() {${GL_VS_COMMON}}`,
    fs: `#version 300 es\nprecision highp float;\nout vec4 o;\nvoid main() { o = vec4(gl_FragCoord.z, 0.0, 0.0, 1.0); }`,
    attrs: glAttrs(false),
    lanes: zLanes,
  }
  const colorGl = {
    vs: `${glHeader(true)}
uniform vec4 u_uvA;
uniform vec4 u_cam;
out vec3 v_world;
out vec3 v_n;
out vec2 v_uv;
void main() {${GL_VS_COMMON}
  v_world = world;
  v_n = a_nrm.xyz;
  v_uv = u_uvA.xy + (a_uv * 0.5 + 0.5) * (u_uvA.zw - u_uvA.xy);
}`,
    fs: `#version 300 es\nprecision highp float;\nin vec3 v_world;\nin vec3 v_n;\nin vec2 v_uv;\nuniform vec4 u_light;\nuniform vec4 u_cam;\nuniform sampler2D u_tex;\nout vec4 o;\nvoid main() {\n  vec3 vd = normalize(u_cam.xyz - v_world);\n  vec3 n = normalize(v_n);\n  n = dot(n, vd) >= 0.0 ? n : -n;\n  float lam = clamp(dot(n, normalize(u_light.xyz)), 0.0, 1.0);\n  vec3 col = texture(u_tex, v_uv).rgb * (0.40 + 0.60 * lam);\n  float dist = distance(v_world, u_cam.xyz);\n  float fog = clamp((dist - 130.0) / 110.0, 0.0, 1.0);\n  col = mix(col, vec3(0.56, 0.66, 0.78), fog * 0.94);\n  o = vec4(col, 1.0);\n}`,
    attrs: glAttrs(true),
    lanes: colorLanes,
  }

  // THE PROGRAM DICTIONARY: material × pass (the cull mode is the
  // material's own — bark 'back' / leaf 'none')
  return {
    barkZ: {
      wg: { code: zWg, attrs: [{ size: 4, format: 'snorm16x4' }], hasTextures: false },
      gl: zGl,
    },
    leafZ: {
      wg: { code: zWg, attrs: [{ size: 4, format: 'snorm16x4' }], hasTextures: false },
      gl: zGl,
    },
    barkColor: {
      wg: {
        code: colorWg,
        attrs: [
          { size: 4, format: 'snorm16x4' },
          { size: 4, format: 'snorm8x4' },
          { size: 2, format: 'snorm16x2' },
        ],
        hasTextures: true,
      },
      gl: colorGl,
    },
    leafColor: {
      wg: {
        code: colorWg,
        attrs: [
          { size: 4, format: 'snorm16x4' },
          { size: 4, format: 'snorm8x4' },
          { size: 2, format: 'snorm16x2' },
        ],
        hasTextures: true,
      },
      gl: colorGl,
    },
  }
}
