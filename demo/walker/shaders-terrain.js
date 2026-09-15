// walker/shaders-terrain.js — Task 216 — THE TERRAIN COLUMNS.
//
// The dictionary pattern (the occlusion demo's shaders.js): WGSL and
// GLSL ES 3.00 stay two columns, ONE contract each.
//
//   terrainColor — the lit soup: the height palette (v = the NORMALIZED
//     height the terrain prim bakes into uv.y — sand → grass → rock →
//     snow, the shader never knows the amplitude) + the central-difference
//     normals' lambert + the distance fog into the sky color.
//   terrainZ — the z contract (the tile's own): the SAME vertex transform
//     as the color column (bit-identical positions — the A6 parity law
//     needs the surface's depth and the tile's depth to carry the same
//     values for the same surface), the fragment writes the EXACT depth
//     (WGSL @builtin(position).z / GLSL gl_FragCoord.z).
//
// The uniforms block (both columns, the tier's terrain brick's order):
//   [mvp: 16][misc: 4 (unused/surfaceH/fogNear/fogFar)][light: 4][cam: 4]
// The GL lanes are BY NAME in that word order: u_mvp, u_misc, u_light, u_cam.

export const terrainShaders = {
  color: {
    wg: {
      code: `
struct P { mvp: mat4x4<f32>, misc: vec4<f32>, light: vec4<f32>, cam: vec4<f32> }
@group(0) @binding(0) var<uniform> p: P;
struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) n: vec3<f32>,
  @location(1) h: f32,
  @location(2) dist: f32,
}
@vertex fn vsMain(
  @location(0) a_pos: vec3<f32>,
  @location(1) a_n: vec3<f32>,
  @location(2) a_uv: vec2<f32>
) -> VOut {
  var o: VOut;
  o.pos = p.mvp * vec4<f32>(a_pos, 1.0);
  o.n = a_n;
  o.h = a_uv.y;
  o.dist = distance(a_pos, p.cam.xyz);
  return o;
}
@fragment fn fsMain(v: VOut) -> @location(0) vec4<f32> {
  let t = clamp(v.h, 0.0, 1.0);
  var col = mix(vec3<f32>(0.72, 0.65, 0.46), vec3<f32>(0.30, 0.44, 0.25), smoothstep(0.16, 0.42, t));
  col = mix(col, vec3<f32>(0.44, 0.42, 0.40), smoothstep(0.55, 0.75, t));
  col = mix(col, vec3<f32>(0.88, 0.90, 0.93), smoothstep(0.84, 0.96, t));
  let lam = clamp(dot(normalize(v.n), normalize(p.light.xyz)), 0.0, 1.0);
  var lit = col * (0.38 + 0.62 * lam);
  let fog = clamp((v.dist - p.misc.y) / max(p.misc.z - p.misc.y, 1.0), 0.0, 1.0);
  lit = mix(lit, vec3<f32>(0.56, 0.66, 0.78), fog * 0.92);
  return vec4<f32>(lit, 1.0);
}`,
      attrs: [3, 3, 2],
    },
    gl: {
      vs: `#version 300 es
layout(location=0) in vec3 a_pos;
layout(location=1) in vec3 a_n;
layout(location=2) in vec2 a_uv;
uniform mat4 u_mvp;
uniform vec4 u_cam;
out vec3 v_n;
out float v_h;
out float v_dist;
void main() {
  gl_Position = u_mvp * vec4(a_pos, 1.0);
  v_n = a_n;
  v_h = a_uv.y;
  v_dist = distance(a_pos, u_cam.xyz);
}`,
      fs: `#version 300 es
precision highp float;
in vec3 v_n;
in float v_h;
in float v_dist;
uniform vec4 u_light;
uniform vec4 u_misc;
out vec4 o;
void main() {
  float t = clamp(v_h, 0.0, 1.0);
  vec3 col = mix(vec3(0.72, 0.65, 0.46), vec3(0.30, 0.44, 0.25), smoothstep(0.16, 0.42, t));
  col = mix(col, vec3(0.44, 0.42, 0.40), smoothstep(0.55, 0.75, t));
  col = mix(col, vec3(0.88, 0.90, 0.93), smoothstep(0.84, 0.96, t));
  float lam = clamp(dot(normalize(v_n), normalize(u_light.xyz)), 0.0, 1.0);
  vec3 lit = col * (0.38 + 0.62 * lam);
  float fog = clamp((v_dist - u_misc.y) / max(u_misc.z - u_misc.y, 1.0), 0.0, 1.0);
  lit = mix(lit, vec3(0.56, 0.66, 0.78), fog * 0.92);
  o = vec4(lit, 1.0);
}`,
      attrs: [
        { location: 0, from: 'mesh', mesh: 0, size: 3, stride: 12, offset: 0, divisor: 0 },
        { location: 1, from: 'mesh', mesh: 1, size: 3, stride: 12, offset: 0, divisor: 0 },
        { location: 2, from: 'mesh', mesh: 2, size: 2, stride: 8, offset: 0, divisor: 0 },
      ],
      lanes: [
        { name: 'u_mvp', kind: 'mat4', words: 16 },
        { name: 'u_misc', kind: 'vec4', words: 4 },
        { name: 'u_light', kind: 'vec4', words: 4 },
        { name: 'u_cam', kind: 'vec4', words: 4 },
      ],
    },
  },
  z: {
    wg: {
      code: `
struct P { mvp: mat4x4<f32> }
@group(0) @binding(0) var<uniform> p: P;
struct VOut { @builtin(position) pos: vec4<f32> }
@vertex fn vsMain(
  @location(0) a_pos: vec3<f32>,
  @location(1) a_n: vec3<f32>,
  @location(2) a_uv: vec2<f32>
) -> VOut {
  var o: VOut;
  o.pos = p.mvp * vec4<f32>(a_pos, 1.0);
  return o;
}
@fragment fn fsMain(v: VOut) -> @location(0) vec4<f32> {
  return vec4<f32>(v.pos.z, 0.0, 0.0, 1.0);
}`,
      attrs: [3, 3, 2],
    },
    gl: {
      vs: `#version 300 es
layout(location=0) in vec3 a_pos;
layout(location=1) in vec3 a_n;
layout(location=2) in vec2 a_uv;
uniform mat4 u_mvp;
void main() { gl_Position = u_mvp * vec4(a_pos, 1.0); }`,
      fs: `#version 300 es
precision highp float;
out vec4 o;
void main() { o = vec4(gl_FragCoord.z, 0.0, 0.0, 1.0); }`,
      attrs: [
        { location: 0, from: 'mesh', mesh: 0, size: 3, stride: 12, offset: 0, divisor: 0 },
        { location: 1, from: 'mesh', mesh: 1, size: 3, stride: 12, offset: 0, divisor: 0 },
        { location: 2, from: 'mesh', mesh: 2, size: 2, stride: 8, offset: 0, divisor: 0 },
      ],
      lanes: [{ name: 'u_mvp', kind: 'mat4', words: 16 }],
    },
  },
}
