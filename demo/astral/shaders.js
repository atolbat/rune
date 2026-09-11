// "astral" demo — the dual-source shaders (GLSL ES 3.00 + WGSL twins) and
// the 3D camera.
//
// THE CAMERA IS PERSPECTIVE NOW. The old demo drew a flat orthographic map —
// a 3D renderer doing 2D-on-top. This pass moves the whole scene into real
// 3D: a perspective camera hovering over the galaxy plane (world z = 0) at
// a tilt that eases between the galaxy overview (~30°) and the system view
// (~12°), free yaw (the two-finger twist), a 3D star field scattered below
// the plane, camera-facing (billboarded) sprite quads whose apparent size
// is measured in true screen pixels through the perspective divide, and
// eye-space line expansion for the hyperlanes so they stay ~2 CSS px wide
// at any depth. Picking is a ray→plane intersection; labels project through
// the same matrix.
//
// TEXTURES. Every glow comes from a sampled sprite now (the procedural
// kitchen in textures.js): the star sprite (core + halo + diffraction
// spikes — the three.js galaxy-sprite look), the sun's wavering corona, the
// arm-aligned spiral haze lying IN the galaxy plane, nebula puffs floating
// below it, and a planet ATLAS (a 1024×512 texture with 256×128 equirect
// tiles: rock / gas / ice / lava / garden / sun) sampled through sphere
// normals — a flat quad shaded as a lit sphere with a real day/night
// terminator that follows the planet around its orbit. The three REAL
// bitmaps (ESO Milky Way panorama, NASA moon + earth via the three.js
// examples) swap into the same handles asynchronously when they arrive.
//
// Conventions (the repo's dual-source contract):
//   GLSL  — layout(location=N) in/out, uniforms by name, out vec4 o_color;
//   WGSL  — one Params struct @group(0) @binding(0), vsMain(vi, @location
//           inputs) -> VSOut, fsMain(frag) -> @location(0); textures as
//           @group(1) @binding(0) texSampler + @binding(1..N) texTexture.
//           (The WGSL discipline from Task 169: every `discard;` terminated,
//           every statement closed — the phone taught us that lesson.)
//
// Instance records: 64-byte strides, 3D positions — pos vec3@0, meta
// vec2@16, color vec4@32, state vec4@48 (every attribute offset a multiple
// of its format size — the WG vertex-layout rule). Premultiplied output;
// star/nebula/sky passes blend additively ('one','one'), the rest classic
// ('one','one-minus-src-alpha').

// ─── the camera + clock (owned by main.js, read by every resolver) ──────────

export const FOV = 0.803 // ~46° vertical
const TANH = Math.tan(FOV / 2)
const NEAR = 1
const FAR = 40000

export const MVP = new Float32Array(16)      // viewProj (world→clip)
export const VIEW = new Float32Array(16)     // world→eye
export const PROJ = new Float32Array(16)     // eye→clip
export const EYE = new Float32Array(3)       // the camera position (world)
export const RIGHT = new Float32Array(3)     // screen +x in world
export const UP = new Float32Array(3)        // screen +y in world
export const FWD = new Float32Array(3)       // view direction (world)
export const PXK = [1]                       // CSS px per world unit × eyeZ (the perspective px scale)
export const LINEK = [1]                     // world units per CSS px at eyeZ=1 (line expansion)
export const YAW = [0]                       // the camera yaw (radians)
export const CLOCK = [0]                     // the game clock (freezes on pause)
export const FADE = [1]                      // the system-view blend (0 = galaxy, 1 = system)
export const GALAXY_FADE = [0]               // 1 - FADE (the galaxy layer's fade)
export const NEB_FADE = [1]                  // the nebula layer's fade (survives into system view)
export const SHIP_CAP = [240]                // the ships' apparent-size cap (px; the system view shrinks them to markers)
export const SPLIT = new Float32Array(2)     // the ring split axis (eye side of the plane)

// the sky quad (the Milky Way panorama) follows the camera: center + half-extents.
// TASK 172 — THE SKY IS WORLD-LOCKED IN ORIENTATION now: the panorama ROLLS
// with the camera yaw (the old linear u-pan moved the sky one uniform way
// while the galaxy ROTATED — half the field always read "the background
// slides opposite", the field report's «они идут в противоположное
// направление») and drifts a gentle PARALLAX with the pan (a fraction of
// the galaxy's rate, same direction — an infinitely-distant backdrop glued
// to the camera read as "opposite" too). Both are pure UV transforms on
// the camera-glued quad — the geometry still covers the frustum exactly.
export const SKY_CENTER = new Float32Array(3)
export const SKY_HALF = new Float32Array(2)
export const SKY_U0 = [0.06]         // base framing (fixed — the yaw pan is dead)
export const SKY_WIN = [0.3]         // the panorama u-window per screen width
export const SKY_VSPAN = [0.62]      // the panorama v-window per screen height
export const SKY_ROLL = [0]          // the camera yaw — the sky rolls with it
export const SKY_PAR = new Float32Array(2) // the pan parallax (window units)
// the beauty pass: the panorama reads as DEEP SPACE now (the bloom chain
// lifts it further) — the old 0.5 whisper left a dead grey void
export const SKY_GAIN = [0.30]
// the parallax rate: the sky drifts at this fraction of the galaxy's pan
const SKY_PARALLAX = 0.22

/** cam: { x, y, z (CSS px / world unit), yaw, tilt } — fills every matrix + basis. */
export function setCamera3D(cam, aspect, w, h) {
  const yaw = cam.yaw
  const tilt = cam.tilt
  const sinP = Math.sin(tilt), cosP = Math.cos(tilt)
  const sinY = Math.sin(yaw), cosY = Math.cos(yaw)
  // distance from the target so the visible plane height = h / cam.z
  const d = (h / 2) / (cam.z * TANH)

  // the camera basis (see the header: at yaw=0,tilt=0 this is the old
  // top-down ortho view — world +x = screen right, +y = screen up)
  const fx = -sinP * sinY, fy = sinP * cosY, fz = -cosP        // forward
  const rx = cosY, ry = sinY, rz = 0                           // right
  const ux = -sinY * cosP, uy = cosY * cosP, uz = sinP         // up

  EYE[0] = cam.x + sinP * sinY * d
  EYE[1] = cam.y - sinP * cosY * d
  EYE[2] = cosP * d
  FWD[0] = fx; FWD[1] = fy; FWD[2] = fz
  RIGHT[0] = rx; RIGHT[1] = ry; RIGHT[2] = rz
  UP[0] = ux; UP[1] = uy; UP[2] = uz

  // VIEW (column-major): rows = right / up / −fwd, translation = −R·eye
  VIEW[0] = rx; VIEW[1] = ux; VIEW[2] = -fx; VIEW[3] = 0
  VIEW[4] = ry; VIEW[5] = uy; VIEW[6] = -fy; VIEW[7] = 0
  VIEW[8] = rz; VIEW[9] = uz; VIEW[10] = -fz; VIEW[11] = 0
  VIEW[12] = -(rx * EYE[0] + ry * EYE[1] + rz * EYE[2])
  VIEW[13] = -(ux * EYE[0] + uy * EYE[1] + uz * EYE[2])
  VIEW[14] = (fx * EYE[0] + fy * EYE[1] + fz * EYE[2])
  VIEW[15] = 1

  // PROJ (perspective, column-major) — f = cot(fov/2) = 1/tan(fov/2)
  PROJ.fill(0)
  PROJ[0] = 1 / (TANH * aspect)
  PROJ[5] = 1 / TANH
  PROJ[10] = (FAR + NEAR) / (NEAR - FAR)
  PROJ[11] = -1
  PROJ[14] = (2 * FAR * NEAR) / (NEAR - FAR)

  mul4(MVP, PROJ, VIEW)

  // the px scales (CSS px!): pxk converts world size × eyeZ → CSS px;
  // linek is its inverse per-unit form for the eye-space line expansion
  PXK[0] = h / (2 * TANH)
  LINEK[0] = (2 * TANH) / h
  YAW[0] = yaw

  // the sky quad: farther than the camera along the view axis, sized to
  // always cover the frustum (plus margin), panning with the yaw
  const skyD = Math.max(2600, d * 1.2)
  SKY_CENTER[0] = cam.x - fx * skyD
  SKY_CENTER[1] = cam.y - fy * skyD
  SKY_CENTER[2] = -fz * skyD
  SKY_HALF[1] = TANH * skyD * 1.06
  SKY_HALF[0] = SKY_HALF[1] * aspect * 1.06
  // TASK 172: the roll replaces the u-pan — the panorama rotates with the
  // world's yaw exactly like the galaxy does; the parallax drifts the
  // sample center by a fraction of the camera's world pan (window units,
  // aspect-compensated so the drift is isotropic on screen)
  SKY_ROLL[0] = yaw
  const px2win = SKY_PARALLAX * cam.z * SKY_WIN[0] / Math.max(1, w)
  const py2win = SKY_PARALLAX * cam.z * SKY_VSPAN[0] / Math.max(1, h)
  SKY_PAR[0] = cam.x * px2win
  SKY_PAR[1] = cam.y * py2win

  // the ring split axis: the direction from the target toward the eye,
  // projected on the plane (near halves of rings test > 0 against it)
  SPLIT[0] = sinY
  SPLIT[1] = -cosY
}

/** column-major mat4 multiply: out = a · b (out may alias a or b). */
function mul4(out, a, b) {
  const t = new Float32Array(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]
      t[c * 4 + r] = s
    }
  }
  out.set(t)
}

/** Screen (CSS px) → world point on the galaxy plane (ray→plane). Null if the ray misses. */
export function screenToWorld(sx, sy, w, h) {
  const nx = (2 * sx) / w - 1
  const ny = 1 - (2 * sy) / h
  const aspect = w / h
  const dx = FWD[0] + TANH * (nx * aspect * RIGHT[0] + ny * UP[0])
  const dy = FWD[1] + TANH * (nx * aspect * RIGHT[1] + ny * UP[1])
  const dz = FWD[2] + TANH * (nx * aspect * RIGHT[2] + ny * UP[2])
  if (dz >= -1e-4) return null
  const t = -EYE[2] / dz
  if (t < 0) return null
  return [EYE[0] + dx * t, EYE[1] + dy * t]
}

/** World plane point → screen CSS px (through the live MVP). Null if behind. */
export function worldToScreen(wx, wy, w, h, out) {
  const cw = MVP[3] * wx + MVP[7] * wy + MVP[15]
  if (cw <= 0.02) return null
  const cx = (MVP[0] * wx + MVP[4] * wy + MVP[12]) / cw
  const cy = (MVP[1] * wx + MVP[5] * wy + MVP[13]) / cw
  out.x = (cx + 1) * 0.5 * w
  out.y = (1 - cy) * 0.5 * h
  return out
}

/** Finger pan → camera move (the tilt-foreshortened plane mapping). */
export function panBy(cam, dx, dy) {
  const cosP = Math.max(0.25, Math.cos(cam.tilt))
  const cosY = Math.cos(cam.yaw), sinY = Math.sin(cam.yaw)
  // screen right / screen-up projected on the world plane
  const rX = cosY, rY = sinY
  const uX = -sinY * cosP, uY = cosY * cosP
  cam.x += (-rX * dx + (uX * dy) / cosP) / cam.z
  cam.y += (-rY * dx + (uY * dy) / cosP) / cam.z
}

// ─── 1. the sky pass (the Milky Way panorama behind everything) ─────────────

const SKY_GLSL_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;    // the unit quad (±1)
uniform mat4 u_mvp;
uniform vec3 u_center;
uniform vec3 u_right;
uniform vec3 u_up;
uniform vec2 u_half;
out vec2 v_uv;
void main() {
  vec3 world = u_center + u_right * (a_pos.x * u_half.x) + u_up * (a_pos.y * u_half.y);
  gl_Position = u_mvp * vec4(world, 1.0);
  v_uv = a_pos * 0.5 + 0.5;
}`

const SKY_GLSL_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_u0;
uniform float u_win;
uniform float u_vspan;
uniform float u_roll;
uniform vec2 u_par;
uniform float u_gain;
out vec4 o_color;
void main() {
  // TASK 172 — the world-locked sky: rotate the sample coords by the camera
  // yaw (the panorama ROLLS with the galaxy — a camera roll rotates an
  // infinitely-distant sky the same way it rotates the world), then drift
  // by the pan parallax (the sky pans WITH the world at 0.22x its rate)
  vec2 p = v_uv - 0.5;
  float ca = cos(u_roll), sa = sin(u_roll);
  p = vec2(ca * p.x + sa * p.y, -sa * p.x + ca * p.y);
  p -= u_par;
  // both axes wrap: u is the full 360-degree circle, v wraps dark-pole to
  // dark-pole (the seam is invisible at this gain)
  float su = fract(u_u0 + p.x * u_win);
  float sv = fract(0.5 + p.y * u_vspan);
  vec3 rgb = texture(u_tex, vec2(su, sv)).rgb * u_gain;
  // a soft vertical falloff keeps the poles from brightening the corners
  float pole = 1.0 - 0.35 * smoothstep(0.34, 0.5, abs(sv - 0.5));
  o_color = vec4(rgb * pole, 1.0);
}`

const SKY_WGSL = `
struct Params {
  u_mvp : mat4x4<f32>,
  u_center : vec3<f32>,
  u_right : vec3<f32>,
  u_up : vec3<f32>,
  u_half : vec2<f32>,
  u_u0 : f32,
  u_win : f32,
  u_vspan : f32,
  u_roll : f32,
  u_gain : f32,
  u_par : vec2<f32>,
}
@group(0) @binding(0) var<uniform> params : Params;
@group(1) @binding(0) var texSampler : sampler;
@group(1) @binding(1) var texTexture : texture_2d<f32>;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
}

@vertex
fn vsMain(@location(0) a_pos : vec2<f32>) -> VSOut {
  let world = params.u_center + params.u_right * (a_pos.x * params.u_half.x) + params.u_up * (a_pos.y * params.u_half.y);
  var out : VSOut;
  out.pos = params.u_mvp * vec4<f32>(world, 1.0);
  out.uv = a_pos * 0.5 + vec2<f32>(0.5, 0.5);
  return out;
}

@fragment
fn fsMain(frag : VSOut) -> @location(0) vec4<f32> {
  // TASK 172 — the world-locked sky (the GLSL twin's comment, verbatim
  // contract): roll with the yaw, drift with the pan parallax
  var p = frag.uv - vec2<f32>(0.5, 0.5);
  let ca = cos(params.u_roll);
  let sa = sin(params.u_roll);
  p = vec2<f32>(ca * p.x + sa * p.y, -sa * p.x + ca * p.y);
  p = p - params.u_par;
  let su = fract(params.u_u0 + p.x * params.u_win);
  let sv = fract(0.5 + p.y * params.u_vspan);
  let rgb = textureSample(texTexture, texSampler, vec2<f32>(su, sv)).rgb * params.u_gain;
  let pole = 1.0 - 0.35 * smoothstep(0.34, 0.5, abs(sv - 0.5));
  return vec4<f32>(rgb * pole, 1.0);
}`

export const skyShader = {
  glsl: { vertex: SKY_GLSL_VERT, fragment: SKY_GLSL_FRAG },
  wgsl: SKY_WGSL,
}

// ─── 2. the background star field (3D scatter, sprite glows) ────────────────

const BGSTAR_GLSL_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec2 a_meta;   // (worldSize, phase)
layout(location = 2) in vec4 a_color;
layout(location = 3) in vec4 a_state;
uniform mat4 u_mvp;
uniform mat4 u_view;
uniform vec3 u_right;
uniform vec3 u_up;
uniform float u_pxk;
uniform float u_time;
out vec2 v_uv;
out vec4 v_color;

const vec2 CORNERS[6] = vec2[6](vec2(-1,-1), vec2(1,-1), vec2(-1,1), vec2(-1,1), vec2(1,-1), vec2(1,1));

void main() {
  vec2 corner = CORNERS[gl_VertexID];
  float eyeZ = -(u_view * vec4(a_pos, 1.0)).z;
  eyeZ = max(eyeZ, 1.0);
  // true screen size through the perspective divide (CSS px)
  float px = clamp(a_meta.x * u_pxk / eyeZ, 1.3, 56.0);
  float size = px * eyeZ / u_pxk;
  float tw = 0.7 + 0.3 * sin(u_time * (0.5 + a_meta.y * 1.3) + a_meta.y * 61.0);
  vec3 world = a_pos + u_right * (corner.x * size) + u_up * (corner.y * size);
  gl_Position = u_mvp * vec4(world, 1.0);
  v_uv = corner;
  v_color = vec4(a_color.rgb * tw, a_color.a);
}`

const BGSTAR_GLSL_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec4 v_color;
uniform sampler2D u_tex;
out vec4 o_color;
void main() {
  float d = length(v_uv);
  if (d > 1.0) discard;
  vec3 spr = texture(u_tex, v_uv * 0.5 + 0.5).rgb;
  vec3 rgb = spr * v_color.rgb * v_color.a * 1.8;
  o_color = vec4(rgb, v_color.a);
}`

const BGSTAR_WGSL = `
struct Params {
  u_mvp : mat4x4<f32>,
  u_view : mat4x4<f32>,
  u_right : vec3<f32>,
  u_up : vec3<f32>,
  u_pxk : f32,
  u_time : f32,
}
@group(0) @binding(0) var<uniform> params : Params;
@group(1) @binding(0) var texSampler : sampler;
@group(1) @binding(1) var texTexture : texture_2d<f32>;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) color : vec4<f32>,
}

@vertex
fn vsMain(@builtin(vertex_index) vi : u32,
          @location(0) a_pos : vec3<f32>,
          @location(1) a_meta : vec2<f32>,
          @location(2) a_color : vec4<f32>,
          @location(3) a_state : vec4<f32>) -> VSOut {
  var corners = array<vec2<f32>, 6>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
                                     vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0));
  let corner = corners[vi];
  var eyeZ = -(params.u_view * vec4<f32>(a_pos, 1.0)).z;
  eyeZ = max(eyeZ, 1.0);
  let px = clamp(a_meta.x * params.u_pxk / eyeZ, 1.3, 56.0);
  let size = px * eyeZ / params.u_pxk;
  let tw = 0.7 + 0.3 * sin(params.u_time * (0.5 + a_meta.y * 1.3) + a_meta.y * 61.0);
  let world = a_pos + params.u_right * (corner.x * size) + params.u_up * (corner.y * size);
  var out : VSOut;
  out.pos = params.u_mvp * vec4<f32>(world, 1.0);
  out.uv = corner;
  out.color = vec4<f32>(a_color.rgb * tw, a_color.a);
  return out;
}

@fragment
fn fsMain(frag : VSOut) -> @location(0) vec4<f32> {
  let d = length(frag.uv);
  if (d > 1.0) { discard; }
  let spr = textureSample(texTexture, texSampler, frag.uv * 0.5 + vec2<f32>(0.5, 0.5)).rgb;
  let rgb = spr * frag.color.rgb * frag.color.a * 1.8;
  return vec4<f32>(rgb, frag.color.a);
}`

export const bgStarShader = {
  glsl: { vertex: BGSTAR_GLSL_VERT, fragment: BGSTAR_GLSL_FRAG },
  wgsl: BGSTAR_WGSL,
}

// ─── 2b. the galaxy dust (THE PARTICLE GALAXY — TASK 172) ───────────────────
//
// ~26k grains along the world generator's own arm math, drawn as billboard
// sprite quads — the Bruno-Simon galaxy-generator technique the field report
// pointed at («ищи лучше реализации галактик в 3d»): crisp star points riding
// a luminous arm haze, per-particle color from the radial gradient, sizes
// that GROW with the zoom (real galaxy structure, unlike the px-clamped
// point stars). Replaces the blurry stretched haze texture as the carrier
// of the galaxy's visual structure; the haze stays beneath as the smooth
// under-glow.

const DUST_GLSL_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec2 a_meta;   // (worldSize, phase)
layout(location = 2) in vec4 a_color;
layout(location = 3) in vec4 a_state;
uniform mat4 u_mvp;
uniform mat4 u_view;
uniform vec3 u_right;
uniform vec3 u_up;
uniform float u_pxk;
uniform float u_time;
uniform float u_fade;
out vec2 v_uv;
out vec4 v_color;

const vec2 CORNERS[6] = vec2[6](vec2(-1,-1), vec2(1,-1), vec2(-1,1), vec2(-1,1), vec2(1,-1), vec2(1,1));

void main() {
  vec2 corner = CORNERS[gl_VertexID];
  float eyeZ = -(u_view * vec4(a_pos, 1.0)).z;
  eyeZ = max(eyeZ, 1.0);
  // the dust is REAL STRUCTURE: the size scales with the zoom (a floor of
  // 1.1 px keeps the far grains alive; the cap only guards the giant glow
  // motes at deep zoom-in)
  float px = clamp(a_meta.x * u_pxk / eyeZ, 1.1, 240.0);
  float size = px * eyeZ / u_pxk;
  // a lazy twinkle — the dust breathes without boiling
  float tw = 0.86 + 0.14 * sin(u_time * (0.22 + a_meta.y * 0.5) + a_meta.y * 97.0);
  vec3 world = a_pos + u_right * (corner.x * size) + u_up * (corner.y * size);
  gl_Position = u_mvp * vec4(world, 1.0);
  v_uv = corner;
  v_color = vec4(a_color.rgb * tw, a_color.a * u_fade);
}`

const DUST_GLSL_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec4 v_color;
uniform sampler2D u_tex;
out vec4 o_color;
void main() {
  float d = length(v_uv);
  if (d > 1.0) discard;
  vec3 spr = texture(u_tex, v_uv * 0.5 + 0.5).rgb;
  vec3 rgb = spr * v_color.rgb * v_color.a;
  o_color = vec4(rgb, v_color.a);
}`

const DUST_WGSL = `
struct Params {
  u_mvp : mat4x4<f32>,
  u_view : mat4x4<f32>,
  u_right : vec3<f32>,
  u_up : vec3<f32>,
  u_pxk : f32,
  u_time : f32,
  u_fade : f32,
}
@group(0) @binding(0) var<uniform> params : Params;
@group(1) @binding(0) var texSampler : sampler;
@group(1) @binding(1) var texTexture : texture_2d<f32>;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) color : vec4<f32>,
}

@vertex
fn vsMain(@builtin(vertex_index) vi : u32,
          @location(0) a_pos : vec3<f32>,
          @location(1) a_meta : vec2<f32>,
          @location(2) a_color : vec4<f32>,
          @location(3) a_state : vec4<f32>) -> VSOut {
  var corners = array<vec2<f32>, 6>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
                                     vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0));
  let corner = corners[vi];
  var eyeZ = -(params.u_view * vec4<f32>(a_pos, 1.0)).z;
  eyeZ = max(eyeZ, 1.0);
  // real structure: the size scales with the zoom (the GLSL twin's comment)
  let px = clamp(a_meta.x * params.u_pxk / eyeZ, 1.1, 240.0);
  let size = px * eyeZ / params.u_pxk;
  let tw = 0.86 + 0.14 * sin(params.u_time * (0.22 + a_meta.y * 0.5) + a_meta.y * 97.0);
  let world = a_pos + params.u_right * (corner.x * size) + params.u_up * (corner.y * size);
  var out : VSOut;
  out.pos = params.u_mvp * vec4<f32>(world, 1.0);
  out.uv = corner;
  out.color = vec4<f32>(a_color.rgb * tw, a_color.a * params.u_fade);
  return out;
}

@fragment
fn fsMain(frag : VSOut) -> @location(0) vec4<f32> {
  let d = length(frag.uv);
  if (d > 1.0) { discard; }
  let spr = textureSample(texTexture, texSampler, frag.uv * 0.5 + vec2<f32>(0.5, 0.5)).rgb;
  let rgb = spr * frag.color.rgb * frag.color.a;
  return vec4<f32>(rgb, frag.color.a);
}`

export const dustShader = {
  glsl: { vertex: DUST_GLSL_VERT, fragment: DUST_GLSL_FRAG },
  wgsl: DUST_WGSL,
}


// ─── 3. the nebula pass (billboarded fbm puffs, slowly turning) ─────────────

const NEBULA_GLSL_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec2 a_meta;   // (worldSize, baseRot)
layout(location = 2) in vec4 a_color;  // (tint, alpha)
layout(location = 3) in vec4 a_state;  // (spinRate, ...)
uniform mat4 u_mvp;
uniform vec3 u_right;
uniform vec3 u_up;
uniform float u_time;
out vec2 v_uv;
out vec4 v_color;

const vec2 CORNERS[6] = vec2[6](vec2(-1,-1), vec2(1,-1), vec2(-1,1), vec2(-1,1), vec2(1,-1), vec2(1,1));

void main() {
  vec2 corner = CORNERS[gl_VertexID];
  float ang = a_meta.y + u_time * a_state.x;
  float c = cos(ang), s = sin(ang);
  vec2 rc = vec2(corner.x * c - corner.y * s, corner.x * s + corner.y * c);
  vec3 world = a_pos + u_right * (rc.x * a_meta.x) + u_up * (rc.y * a_meta.x);
  gl_Position = u_mvp * vec4(world, 1.0);
  v_uv = rc * 0.5 + 0.5;
  v_color = a_color;
}`

const NEBULA_GLSL_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec4 v_color;
uniform sampler2D u_tex;
uniform float u_fade;
out vec4 o_color;
void main() {
  vec4 t = texture(u_tex, v_uv);
  vec3 rgb = t.rgb * v_color.rgb * v_color.a * u_fade;
  o_color = vec4(rgb, 1.0);
}`

const NEBULA_WGSL = `
struct Params {
  u_mvp : mat4x4<f32>,
  u_right : vec3<f32>,
  u_up : vec3<f32>,
  u_time : f32,
  u_fade : f32,
}
@group(0) @binding(0) var<uniform> params : Params;
@group(1) @binding(0) var texSampler : sampler;
@group(1) @binding(1) var texTexture : texture_2d<f32>;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) color : vec4<f32>,
}

@vertex
fn vsMain(@builtin(vertex_index) vi : u32,
          @location(0) a_pos : vec3<f32>,
          @location(1) a_meta : vec2<f32>,
          @location(2) a_color : vec4<f32>,
          @location(3) a_state : vec4<f32>) -> VSOut {
  var corners = array<vec2<f32>, 6>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
                                     vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0));
  let corner = corners[vi];
  let ang = a_meta.y + params.u_time * a_state.x;
  let c = cos(ang);
  let s = sin(ang);
  let rc = vec2<f32>(corner.x * c - corner.y * s, corner.x * s + corner.y * c);
  let world = a_pos + params.u_right * (rc.x * a_meta.x) + params.u_up * (rc.y * a_meta.x);
  var out : VSOut;
  out.pos = params.u_mvp * vec4<f32>(world, 1.0);
  out.uv = rc * 0.5 + vec2<f32>(0.5, 0.5);
  out.color = a_color;
  return out;
}

@fragment
fn fsMain(frag : VSOut) -> @location(0) vec4<f32> {
  let t = textureSample(texTexture, texSampler, frag.uv);
  let rgb = t.rgb * frag.color.rgb * frag.color.a * params.u_fade;
  return vec4<f32>(rgb, 1.0);
}`

export const nebulaShader = {
  glsl: { vertex: NEBULA_GLSL_VERT, fragment: NEBULA_GLSL_FRAG },
  wgsl: NEBULA_WGSL,
}

// ─── 4. the galaxy haze (an arm-aligned textured quad IN the plane) ─────────

const HAZE_GLSL_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;   // world xy
layout(location = 1) in vec2 a_uv;
uniform mat4 u_mvp;
out vec2 v_uv;
void main() {
  gl_Position = u_mvp * vec4(a_pos, -8.0, 1.0); // just under the plane
  v_uv = a_uv;
}`

const HAZE_GLSL_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_fade;
uniform float u_gain;
out vec4 o_color;
void main() {
  vec3 rgb = texture(u_tex, v_uv).rgb * u_gain * u_fade;
  o_color = vec4(rgb, 1.0);
}`

const HAZE_WGSL = `
struct Params {
  u_mvp : mat4x4<f32>,
  u_fade : f32,
  u_gain : f32,
}
@group(0) @binding(0) var<uniform> params : Params;
@group(1) @binding(0) var texSampler : sampler;
@group(1) @binding(1) var texTexture : texture_2d<f32>;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
}

@vertex
fn vsMain(@location(0) a_pos : vec2<f32>,
          @location(1) a_uv : vec2<f32>) -> VSOut {
  var out : VSOut;
  out.pos = params.u_mvp * vec4<f32>(a_pos, -8.0, 1.0);
  out.uv = a_uv;
  return out;
}

@fragment
fn fsMain(frag : VSOut) -> @location(0) vec4<f32> {
  let rgb = textureSample(texTexture, texSampler, frag.uv).rgb * params.u_gain * params.u_fade;
  return vec4<f32>(rgb, 1.0);
}`

export const hazeShader = {
  glsl: { vertex: HAZE_GLSL_VERT, fragment: HAZE_GLSL_FRAG },
  wgsl: HAZE_WGSL,
}

// ─── 5. the star pass (the 72 systems — sprite glow + gameplay arcs) ────────

const STAR_GLSL_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec2 a_meta;   // (worldSize, phase)
layout(location = 2) in vec4 a_color;
layout(location = 3) in vec4 a_state;  // (owner, selected, colonize, fade)
uniform mat4 u_mvp;
uniform mat4 u_view;
uniform vec3 u_right;
uniform vec3 u_up;
uniform float u_pxk;
uniform float u_time;
uniform float u_fade;
out vec2 v_uv;
out vec4 v_color;
out vec4 v_state;
out vec2 v_extra;   // (type, phase) — 0 star, 1 black hole, 2 neutron

const vec2 CORNERS[6] = vec2[6](vec2(-1,-1), vec2(1,-1), vec2(-1,1), vec2(-1,1), vec2(1,-1), vec2(1,1));

void main() {
  vec2 corner = CORNERS[gl_VertexID];
  float tw = 0.82 + 0.18 * sin(u_time * (0.9 + a_meta.y * 1.7) + a_meta.y * 43.0);
  // apparent size in true screen CSS px (a star is a glow — readable at any zoom)
  float eyeZ = -(u_view * vec4(a_pos, 1.0)).z;
  eyeZ = max(eyeZ, 1.0);
  float px = clamp(a_meta.x * u_pxk / eyeZ, 5.0, 15.0);
  float size = px * eyeZ / u_pxk;
  // the halo quad is 4x the core: the bloom chain carries the long glow,
  // the sprite itself holds the tight luminous core + diffraction spikes
  vec3 world = a_pos + u_right * (corner.x * size * 3.0) + u_up * (corner.y * size * 3.0);
  gl_Position = u_mvp * vec4(world, 1.0);
  v_uv = corner;
  v_color = vec4(a_color.rgb * tw, a_color.a * u_fade * a_state.w);
  v_state = a_state;
  // the class rides in the phase float: phase + type*4 (fract = phase)
  v_extra = vec2(floor(a_meta.y / 4.0), fract(a_meta.y));
}`

const STAR_GLSL_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec4 v_color;
in vec4 v_state;
in vec2 v_extra;
uniform sampler2D u_tex;
uniform float u_fade;
uniform float u_time;   // the neutron beams rotate with the clock
out vec4 o_color;

void main() {
  float d = length(v_uv);
  if (d > 1.0) discard;
  // THE SPIKE HIERARCHY: the fetch stays unconditional (the WGSL twin's
  // uniform-control-flow contract); the SPRITE (with its diffraction
  // spikes) fades in only for heavy stars — v_color.a carries the class
  // weight (0.16 = an M dwarf → a quiet analytic point; 1.0 = an O
  // giant/capital → the full spiked, blooming sprite)
  vec3 tex = texture(u_tex, v_uv * 0.5 + 0.5).rgb;
  float spikeW = smoothstep(0.74, 0.96, v_color.a);
  float analytic = exp(-d * d * 22.0) * 1.7 + exp(-d * d * 3.6) * 0.5;
  vec3 spr = mix(vec3(analytic), tex, spikeW);
  float a = v_color.a;
  vec3 rgb = spr * v_color.rgb * a * 2.0;

  // ownership: a thin tinted ring at the halo's edge
  float ring = exp(-pow((d - 0.62) * 14.0, 2.0)) * 0.85;
  if (v_state.x > 0.5 && v_state.x < 1.5) rgb += vec3(0.28, 0.5, 1.0) * ring * 0.7 * a;
  else if (v_state.x > 1.5) rgb += vec3(1.0, 0.28, 0.24) * ring * 0.8 * a;

  // selection: a dashed rotating ring just outside the halo (fade-aware:
  // the marker must not bleed through the system-view crossfade) — the
  // Stellaris teal selection glow
  if (v_state.y > 0.5) {
    float ang = atan(v_uv.y, v_uv.x);
    float dashes = step(0.45, fract(ang * 2.5465 + v_state.x * 7.0));
    float sel = exp(-pow((d - 0.86) * 18.0, 2.0)) * dashes * u_fade;
    rgb += vec3(0.45, 1.0, 0.88) * sel * 1.15;
    a += sel * 0.6;
  }

  // colonization in progress: an arc that fills with progress
  if (v_state.z > 0.001) {
    float ang = atan(v_uv.y, v_uv.x) + 3.14159265;
    float arc = exp(-pow((d - 0.86) * 16.0, 2.0)) * step(ang, 6.2831853 * v_state.z) * u_fade;
    rgb += vec3(0.45, 1.0, 0.7) * arc * 0.8;
    a += arc * 0.5;
  }

  // the neutron star: a lighthouse — a hard tiny core + two rotating beams
  if (v_extra.x > 1.5) {
    float core = exp(-d * d * 26.0);
    rgb = spr * v_color.rgb * a * (3.0 * core + 0.55);
    float bAng = u_time * 0.9 + v_extra.y * 6.2831853;
    vec2 uDir = vec2(cos(bAng), sin(bAng));
    float across = abs(v_uv.x * uDir.y - v_uv.y * uDir.x);
    float beam = exp(-across * across * 130.0) * smoothstep(1.0, 0.30, d);
    rgb += vec3(0.60, 0.84, 1.0) * beam * a * 1.4;
    a += beam * a * 0.5;
  }

  o_color = vec4(rgb, a);
}`

const STAR_WGSL = `
struct Params {
  u_mvp : mat4x4<f32>,
  u_view : mat4x4<f32>,
  u_right : vec3<f32>,
  u_up : vec3<f32>,
  u_pxk : f32,
  u_time : f32,
  u_fade : f32,
}
@group(0) @binding(0) var<uniform> params : Params;
@group(1) @binding(0) var texSampler : sampler;
@group(1) @binding(1) var texTexture : texture_2d<f32>;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) color : vec4<f32>,
  @location(2) state : vec4<f32>,
  @location(3) extra : vec2<f32>,
}

@vertex
fn vsMain(@builtin(vertex_index) vi : u32,
          @location(0) a_pos : vec3<f32>,
          @location(1) a_meta : vec2<f32>,
          @location(2) a_color : vec4<f32>,
          @location(3) a_state : vec4<f32>) -> VSOut {
  var corners = array<vec2<f32>, 6>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
                                     vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0));
  let corner = corners[vi];
  let tw = 0.82 + 0.18 * sin(params.u_time * (0.9 + a_meta.y * 1.7) + a_meta.y * 43.0);
  var eyeZ = -(params.u_view * vec4<f32>(a_pos, 1.0)).z;
  eyeZ = max(eyeZ, 1.0);
  let px = clamp(a_meta.x * params.u_pxk / eyeZ, 5.0, 15.0);
  let size = px * eyeZ / params.u_pxk;
  let world = a_pos + params.u_right * (corner.x * size * 3.0) + params.u_up * (corner.y * size * 3.0);
  var out : VSOut;
  out.pos = params.u_mvp * vec4<f32>(world, 1.0);
  out.uv = corner;
  out.color = vec4<f32>(a_color.rgb * tw, a_color.a * params.u_fade * a_state.w);
  out.state = a_state;
  out.extra = vec2<f32>(floor(a_meta.y / 4.0), fract(a_meta.y));
  return out;
}

@fragment
fn fsMain(frag : VSOut) -> @location(0) vec4<f32> {
  let d = length(frag.uv);
  if (d > 1.0) { discard; }
  // THE SPIKE HIERARCHY (see the GLSL twin): the fetch stays unconditional
  let tex = textureSample(texTexture, texSampler, frag.uv * 0.5 + vec2<f32>(0.5, 0.5)).rgb;
  let spikeW = smoothstep(0.74, 0.96, frag.color.a);
  let analytic = exp(-d * d * 22.0) * 1.7 + exp(-d * d * 3.6) * 0.5;
  let spr = mix(vec3<f32>(analytic), tex, spikeW);
  var a = frag.color.a;
  var rgb = spr * frag.color.rgb * a * 2.0;

  let ring = exp(-pow((d - 0.62) * 14.0, 2.0)) * 0.85;
  if (frag.state.x > 0.5 && frag.state.x < 1.5) { rgb += vec3<f32>(0.28, 0.5, 1.0) * ring * 0.7 * frag.color.a; }
  else if (frag.state.x > 1.5) { rgb += vec3<f32>(1.0, 0.28, 0.24) * ring * 0.8 * frag.color.a; }

  if (frag.state.y > 0.5) {
    let ang = atan2(frag.uv.y, frag.uv.x);
    let dashes = step(0.45, fract(ang * 2.5465 + frag.state.x * 7.0));
    let sel = exp(-pow((d - 0.86) * 18.0, 2.0)) * dashes * params.u_fade;
    rgb += vec3<f32>(0.45, 1.0, 0.88) * sel * 1.15;
    a += sel * 0.6;
  }

  if (frag.state.z > 0.001) {
    let ang2 = atan2(frag.uv.y, frag.uv.x) + 3.14159265;
    let arc = exp(-pow((d - 0.86) * 16.0, 2.0)) * step(ang2, 6.2831853 * frag.state.z) * params.u_fade;
    rgb += vec3<f32>(0.45, 1.0, 0.7) * arc * 0.8;
    a += arc * 0.5;
  }

  if (frag.extra.x > 1.5) {
    let ncore = exp(-d * d * 26.0);
    rgb = spr * frag.color.rgb * a * (3.0 * ncore + 0.55);
    let bAng = params.u_time * 0.9 + frag.extra.y * 6.2831853;
    let uDir = vec2<f32>(cos(bAng), sin(bAng));
    let across = abs(frag.uv.x * uDir.y - frag.uv.y * uDir.x);
    let beam = exp(-across * across * 130.0) * smoothstep(1.0, 0.30, d);
    rgb += vec3<f32>(0.60, 0.84, 1.0) * beam * a * 1.4;
    a += beam * a * 0.5;
  }

  return vec4<f32>(rgb, a);
}`

export const starShader = {
  glsl: { vertex: STAR_GLSL_VERT, fragment: STAR_GLSL_FRAG },
  wgsl: STAR_WGSL,
}

// ─── 6. the lane pass (lanes + orbits: perspective screen-constant lines) ───
// The quad is baked as CENTERLINE points + the unit perpendicular (times the
// edge side ±1) + the along-lane parameter t (0 at A, 1 at B — the bezier
// bake subdivides real curves, so t is the CURVE parameter, monotone along
// the polyline); the vertex shader expands it in EYE SPACE to a constant
// ~2 CSS px — the world-space size of a pixel varies with depth under
// perspective, so the width is measured against the true projected scale
// (u_linek · |eyeZ| = world units per screen px at that depth). This is the
// Task-166 thin-line-dropout fix, now in 3D.
//
// THE BEAUTY PASS: the fragment now shapes a SOFT GLOW PROFILE across the
// line (|v_dir| interpolates 0 at the centerline → 1 at the baked edges —
// a free cross-lane coordinate, no extra attribute math) and runs an ENERGY
// PULSE along v_t — the Stellaris hyperlane read: quiet teal threads with
// slow traveling brightenings, never flat ruled lines.

const LANE_GLSL_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;   // a centerline point (world)
layout(location = 1) in vec2 a_dir;   // unit perpendicular * edge side (±1)
layout(location = 2) in vec4 a_color; // premultiplied by the bake
layout(location = 3) in float a_t;    // the along-lane parameter (0..1)
uniform mat4 u_view;
uniform mat4 u_proj;
uniform float u_linek;   // 2·tan(fov/2)/h — world units per screen px at eyeZ=1
uniform float u_width;   // the line width in screen px
out vec4 v_color;
out vec2 v_dir;
out float v_t;
void main() {
  vec4 eye = u_view * vec4(a_pos, 0.0, 1.0);
  vec2 eyeDir = (u_view * vec4(a_dir, 0.0, 0.0)).xy; // unit (the view is orthonormal)
  eye.xy += eyeDir * (u_width * (-eye.z) * u_linek);
  gl_Position = u_proj * eye;
  v_color = a_color;
  v_dir = a_dir;
  v_t = a_t;
}`

const LANE_GLSL_FRAG = `#version 300 es
precision highp float;
in vec4 v_color;
in vec2 v_dir;
in float v_t;
uniform float u_fade;
uniform float u_time;
uniform float u_pulse;   // the traveling-pulse speed (lanes fast, orbits slow)
out vec4 o_color;
void main() {
  // the cross-lane coordinate: |v_dir| = 0 at the centerline, 1 at the edges
  float across = length(v_dir);
  float core = exp(-across * across * 7.0);
  float glow = exp(-across * across * 2.1) * 0.75;

  // the traveling energy pulse: a soft dash moving A → B
  float ph = fract(v_t * 3.0 - u_time * u_pulse);
  float pulse = smoothstep(0.04, 0.30, ph) * smoothstep(0.56, 0.30, ph);

  vec3 rgb = v_color.rgb * (core * 1.9 + glow) + v_color.rgb * pulse * 1.4;
  float a = v_color.a * (core * 1.35 + glow + pulse * 0.8);
  o_color = vec4(rgb * u_fade, a * u_fade);
}`

const LANE_WGSL = `
struct Params {
  u_view : mat4x4<f32>,
  u_proj : mat4x4<f32>,
  u_linek : f32,
  u_width : f32,
  u_fade : f32,
  u_time : f32,
  u_pulse : f32,
}
@group(0) @binding(0) var<uniform> params : Params;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) color : vec4<f32>,
  @location(1) dir : vec2<f32>,
  @location(2) t : f32,
}

@vertex
fn vsMain(@location(0) a_pos : vec2<f32>,
          @location(1) a_dir : vec2<f32>,
          @location(2) a_color : vec4<f32>,
          @location(3) a_t : f32) -> VSOut {
  var eye = params.u_view * vec4<f32>(a_pos, 0.0, 1.0);
  let eyeDir = (params.u_view * vec4<f32>(a_dir, 0.0, 0.0)).xy;
  eye = vec4<f32>(eye.xy + eyeDir * (params.u_width * (-eye.z) * params.u_linek), eye.z, eye.w);
  var out : VSOut;
  out.pos = params.u_proj * eye;
  out.color = a_color;
  out.dir = a_dir;
  out.t = a_t;
  return out;
}

@fragment
fn fsMain(frag : VSOut) -> @location(0) vec4<f32> {
  let across = length(frag.dir);
  let core = exp(-across * across * 7.0);
  let glow = exp(-across * across * 2.1) * 0.75;

  let ph = fract(frag.t * 3.0 - params.u_time * params.u_pulse);
  let pulse = smoothstep(0.04, 0.30, ph) * smoothstep(0.56, 0.30, ph);

  let rgb = frag.color.rgb * (core * 1.9 + glow) + frag.color.rgb * pulse * 1.4;
  let a = frag.color.a * (core * 1.35 + glow + pulse * 0.8);
  return vec4<f32>(rgb * params.u_fade, a * params.u_fade);
}`

export const laneShader = {
  glsl: { vertex: LANE_GLSL_VERT, fragment: LANE_GLSL_FRAG },
  wgsl: LANE_WGSL,
}

// ─── 7. the ship pass (billboarded, heading yaw-compensated) ────────────────

const SHIP_GLSL_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec2 a_meta;   // (heading, worldSize)
layout(location = 2) in vec4 a_color;
layout(location = 3) in vec4 a_state;  // (kind, moving, selected, phase)
uniform mat4 u_mvp;
uniform mat4 u_view;
uniform vec3 u_right;
uniform vec3 u_up;
uniform float u_pxk;
uniform float u_time;
uniform float u_yaw;
uniform float u_cap;   // the apparent-size cap (screen px; the system view shrinks ships to markers)
out vec2 v_uv;
out vec4 v_color;
out vec4 v_state;

const vec2 CORNERS[6] = vec2[6](vec2(-1,-1), vec2(1,-1), vec2(-1,1), vec2(-1,1), vec2(1,-1), vec2(1,1));

void main() {
  vec2 corner = CORNERS[gl_VertexID];
  // apparent size in screen px: min 11 (readable zoomed out), capped in the
  // system view (a galaxy-scale ship must not dwarf the planets)
  float eyeZ = -(u_view * vec4(a_pos, 1.0)).z;
  eyeZ = max(eyeZ, 1.0);
  float px = a_meta.y * u_pxk / eyeZ;
  px = clamp(px, 11.0, u_cap);
  float apparent = px * eyeZ / u_pxk;
  // the heading is a world-plane angle; the billboard plane is rotated by the camera yaw
  float ang = a_meta.x - u_yaw;
  float ca = cos(ang), sa = sin(ang);
  vec2 rc = vec2(corner.x * ca - corner.y * sa, corner.x * sa + corner.y * ca);
  vec3 world = a_pos + u_right * (rc.x * apparent) + u_up * (rc.y * apparent);
  gl_Position = u_mvp * vec4(world, 1.0);
  v_uv = corner;
  v_color = a_color;
  v_state = a_state;
}`

const SHIP_GLSL_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec4 v_color;
in vec4 v_state;
uniform float u_time;
out vec4 o_color;

void main() {
  float d = length(v_uv * vec2(1.0, 0.6));
  if (d > 1.25) discard;
  // the soft billboard boundary (the plume must fade, never cut)
  float edge = smoothstep(1.25, 1.02, d);
  // the hull: a tapered dart (wide at the nose, narrowing to the tail)
  float taper = 1.0 - 0.55 * clamp((0.35 - v_uv.y) * 1.6, 0.0, 1.0);
  float dTaper = length(v_uv * vec2(1.0, 0.6) / max(taper, 0.25));
  float hull = smoothstep(1.0, 0.78, dTaper);
  float shade = 0.5 + 0.5 * clamp(v_uv.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 rgb = v_color.rgb * hull * shade;
  float a = hull * 0.95;

  // the cockpit glint (a bright bead just behind the nose)
  float bead = exp(-pow((v_uv.y - 0.42) * 7.0, 2.0)) * exp(-pow(v_uv.x * 5.5, 2.0));
  rgb += mix(v_color.rgb, vec3(1.0), 0.6) * bead * 0.9;
  a += bead * 0.5;

  // the rim light along the hull's edge
  float rim = exp(-pow((dTaper - 0.9) * 9.0, 2.0)) * 0.35;
  rgb += v_color.rgb * rim;

  // the engine plume (moving ships only) — THE BEAUTY PASS: longer,
  // hotter (blue-white core → orange tail), with a soft afterglow
  if (v_state.y > 0.5) {
    float flick = 0.6 + 0.4 * sin(u_time * 34.0 + v_state.w * 19.0);
    float plume = exp(-pow((v_uv.y + 0.92) * 3.4, 2.0)) * exp(-pow(v_uv.x * 1.75, 2.0)) * flick;
    rgb += vec3(0.55, 0.75, 1.0) * plume * 0.55;
    rgb += vec3(1.0, 0.62, 0.25) * plume * 0.75;
    a += plume * 0.72;
  }

  // the selection ring
  if (v_state.z > 0.5) {
    float ang = atan(v_uv.y, v_uv.x);
    float dashes = step(0.5, fract(ang * 3.8 + u_time * 1.2));
    float ring = exp(-pow((d - 1.05) * 9.0, 2.0)) * dashes;
    rgb += vec3(1.0, 0.85, 0.4) * ring;
    a += ring * 0.7;
  }

  // colonizing: a soft green aura
  if (v_state.w > 0.0 && v_state.y > 1.5) {
    float aura = exp(-d * d * 2.2) * (0.5 + 0.5 * sin(u_time * 3.0));
    rgb += vec3(0.35, 1.0, 0.6) * aura * 0.35;
  }

  o_color = vec4(rgb * edge, a * edge);
}`

const SHIP_WGSL = `
struct Params {
  u_mvp : mat4x4<f32>,
  u_view : mat4x4<f32>,
  u_right : vec3<f32>,
  u_up : vec3<f32>,
  u_pxk : f32,
  u_time : f32,
  u_yaw : f32,
  u_cap : f32,
}
@group(0) @binding(0) var<uniform> params : Params;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) color : vec4<f32>,
  @location(2) state : vec4<f32>,
}

@vertex
fn vsMain(@builtin(vertex_index) vi : u32,
          @location(0) a_pos : vec3<f32>,
          @location(1) a_meta : vec2<f32>,
          @location(2) a_color : vec4<f32>,
          @location(3) a_state : vec4<f32>) -> VSOut {
  var corners = array<vec2<f32>, 6>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
                                     vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0));
  let corner = corners[vi];
  var eyeZ = -(params.u_view * vec4<f32>(a_pos, 1.0)).z;
  eyeZ = max(eyeZ, 1.0);
  var px = a_meta.y * params.u_pxk / eyeZ;
  px = clamp(px, 11.0, params.u_cap);
  let apparent = px * eyeZ / params.u_pxk;
  let ang = a_meta.x - params.u_yaw;
  let ca = cos(ang);
  let sa = sin(ang);
  let rc = vec2<f32>(corner.x * ca - corner.y * sa, corner.x * sa + corner.y * ca);
  let world = a_pos + params.u_right * (rc.x * apparent) + params.u_up * (rc.y * apparent);
  var out : VSOut;
  out.pos = params.u_mvp * vec4<f32>(world, 1.0);
  out.uv = corner;
  out.color = a_color;
  out.state = a_state;
  return out;
}

@fragment
fn fsMain(frag : VSOut) -> @location(0) vec4<f32> {
  let d = length(frag.uv * vec2<f32>(1.0, 0.6));
  if (d > 1.25) { discard; }
  let edge = smoothstep(1.25, 1.02, d);
  // the hull: a tapered dart (wide at the nose, narrowing to the tail)
  let taper = 1.0 - 0.55 * clamp((0.35 - frag.uv.y) * 1.6, 0.0, 1.0);
  let dTaper = length(frag.uv * vec2<f32>(1.0, 0.6) / max(taper, 0.25));
  let hull = smoothstep(1.0, 0.78, dTaper);
  let shade = 0.5 + 0.5 * clamp(frag.uv.y * 0.5 + 0.5, 0.0, 1.0);
  var rgb = frag.color.rgb * hull * shade;
  var a = hull * 0.95;

  let bead = exp(-pow((frag.uv.y - 0.42) * 7.0, 2.0)) * exp(-pow(frag.uv.x * 5.5, 2.0));
  rgb += mix(frag.color.rgb, vec3<f32>(1.0), 0.6) * bead * 0.9;
  a += bead * 0.5;

  let rim = exp(-pow((dTaper - 0.9) * 9.0, 2.0)) * 0.35;
  rgb += frag.color.rgb * rim;

  if (frag.state.y > 0.5) {
    let flick = 0.6 + 0.4 * sin(params.u_time * 34.0 + frag.state.w * 19.0);
    let plume = exp(-pow((frag.uv.y + 0.92) * 3.4, 2.0)) * exp(-pow(frag.uv.x * 1.75, 2.0)) * flick;
    rgb = rgb + vec3<f32>(0.55, 0.75, 1.0) * plume * 0.55;
    rgb = rgb + vec3<f32>(1.0, 0.62, 0.25) * plume * 0.75;
    a += plume * 0.72;
  }

  if (frag.state.z > 0.5) {
    let ang = atan2(frag.uv.y, frag.uv.x);
    let dashes = step(0.5, fract(ang * 3.8 + params.u_time * 1.2));
    let ring = exp(-pow((d - 1.05) * 9.0, 2.0)) * dashes;
    rgb += vec3<f32>(1.0, 0.85, 0.4) * ring;
    a += ring * 0.7;
  }

  if (frag.state.w > 0.0 && frag.state.y > 1.5) {
    let aura = exp(-d * d * 2.2) * (0.5 + 0.5 * sin(params.u_time * 3.0));
    rgb += vec3<f32>(0.35, 1.0, 0.6) * aura * 0.35;
  }

  return vec4<f32>(rgb * edge, a * edge);
}`

export const shipShader = {
  glsl: { vertex: SHIP_GLSL_VERT, fragment: SHIP_GLSL_FRAG },
  wgsl: SHIP_WGSL,
}

// ─── 8. the planet pass (a flat quad shaded as a lit sphere + the sun) ──────
// THE SPHERE TRICK: the quad carries v_uv ∈ [−1,1]²; the fragment builds the
// sphere normal N = (uv, √(1−d²)) and samples the equirect atlas tile by
// N's longitude/latitude — the flat quad reads as a rotating globe. The
// light direction is the TRUE sun direction at the planet's current orbit
// angle (computed per instance in the vertex shader), so the terminator
// sweeps around as planets orbit. The lava tile's emissive fissures ride in
// the atlas ALPHA channel and glow on the night side.

const PLANET_GLSL_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_pos;    // the system center (world)
layout(location = 1) in vec2 a_meta;   // (planetRadius, orbitRadius)
layout(location = 2) in vec4 a_color;  // (tint, spinPhase)
layout(location = 3) in vec4 a_state;  // (phase, orbitSpeed, buildProgress, tile)
uniform mat4 u_mvp;
uniform mat4 u_view;
uniform vec3 u_right;
uniform vec3 u_up;
uniform float u_pxk;
uniform float u_time;
uniform float u_fade;
out vec2 v_uv;
out vec4 v_color;
out vec4 v_state;
out vec2 v_light;

const vec2 CORNERS[6] = vec2[6](vec2(-1,-1), vec2(1,-1), vec2(-1,1), vec2(-1,1), vec2(1,-1), vec2(1,1));

void main() {
  vec2 corner = CORNERS[gl_VertexID];
  float ang = a_state.x + u_time * a_state.y;
  vec3 center = a_pos + vec3(cos(ang), sin(ang), 0.0) * a_meta.y;
  float eyeZ = -(u_view * vec4(center, 1.0)).z;
  eyeZ = max(eyeZ, 1.0);
  // THE BEAUTY PASS: the quad is 1.45× the planet radius — the extra ring
  // is the ATMOSPHERE shell (a fresnel halo beyond the limb, computed in
  // the fragment); the sphere math divides the uv back down
  float apparent = max(a_meta.x, 6.0 * eyeZ / u_pxk) * 1.45;
  vec3 world = center + u_right * (corner.x * apparent) + u_up * (corner.y * apparent);
  gl_Position = u_mvp * vec4(world, 1.0);
  // the sun direction AT THIS PLANET: toward the star = −the orbit direction
  vec3 sunDir = -vec3(cos(ang), sin(ang), 0.0);
  v_light = vec2(dot(sunDir, u_right), dot(sunDir, u_up));
  v_uv = corner;
  v_color = a_color;
  v_state = a_state;
}`

const PLANET_GLSL_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec4 v_color;
in vec4 v_state;
in vec2 v_light;
uniform sampler2D u_tex;
uniform float u_time;
uniform float u_fade;
out vec4 o_color;

/** The atlas tile window: 4×2 grid of 256×128 tiles in a 1024×512 atlas. */
vec2 tileUV(float ty, vec2 uv) {
  float col = ty - floor(ty / 4.0) * 4.0;
  float row = floor(ty / 4.0);
  return vec2(col * 0.25 + uv.x * 0.25, row * 0.25 + uv.y * 0.25);
}

void main() {
  // pd — the distance in PLANET RADII (the quad spans 1.45 radii so the
  // atmosphere shell fits inside it: sphere uv = v_uv × 1.45)
  const float PQ = 1.45;
  vec2 suv = v_uv * PQ;
  float pd = length(suv);
  float ty = v_state.w;

  // ONE fetch, UV selected BY VALUE (the WGSL twin requires textureSample in
  // uniform control flow — a branch on the interpolated tile index would be
  // a validation error on real WebGPU hardware)
  float ca = cos(u_time * 0.05), sa = sin(u_time * 0.05);
  vec2 ruv = vec2(suv.x * ca - suv.y * sa, suv.x * sa + suv.y * ca);
  vec2 sunUv = clamp(ruv * 0.5 + 0.5, 0.0, 1.0);
  vec3 N = vec3(suv, sqrt(max(0.0, 1.0 - pd * pd)));
  float lon = atan(N.x, N.z) + v_color.a * 6.2831853;
  float u0 = 0.5 + lon / 6.2831853;
  float v0 = 0.5 - asin(clamp(N.y, -1.0, 1.0)) / 3.14159265;
  vec2 planetUv = vec2(fract(u0), v0);
  vec2 sel = ty > 4.5 ? sunUv : planetUv;
  vec4 t = texture(u_tex, tileUV(ty, sel));

  if (ty > 4.5) {
    // the SUN (tile 5): a blazing analytic core + the rotating flame sprite.
    // rgb runs ABOVE 1.0 — through the premult blend the halo ADDS light over
    // whatever is behind it instead of replacing it with a dark disc. The
    // edge mask guarantees zero at the quad boundary — the sun owns its disc,
    // never its square
    float core = exp(-pd * pd * 18.0) * 3.2;
    float corona = exp(-pd * pd * 3.2) * 1.0;
    vec3 spr = t.rgb;
    float mask = smoothstep(1.0, 0.72, pd);
    float a = clamp(core + corona * 0.65 + spr.r * 0.35, 0.0, 1.0) * mask;
    vec3 rgb = (v_color.rgb * (core + corona * 0.8) + v_color.rgb * spr * (1.55 + corona * 0.8)) * mask;
    o_color = vec4(rgb * u_fade, a * u_fade);
    return;
  }

  // ── the atmosphere shell (the ring beyond the limb) — before the sphere
  // discard so the halo survives it. Additive, tinted blue-ish, brightest
  // at the limb and fading to the quad edge (the bloom chain lifts it)
  vec3 atmoCol = normalize(mix(v_color.rgb, vec3(0.45, 0.75, 1.0), 0.65) + 0.001);
  float ann = exp(-pow((pd - 1.0) * 4.4, 2.0)) * smoothstep(1.45, 1.1, pd);
  vec3 rgb = atmoCol * ann * 0.62;
  float a = ann * 0.3;

  // a planet: sphere shading over the equirect tile
  if (pd > 1.0) {
    o_color = vec4(rgb * u_fade, a * u_fade);
    return;
  }
  vec3 L = normalize(vec3(v_light, 0.42));
  float lam = 0.30 + 0.70 * max(0.0, dot(N, L));
  lam = 0.17 + 0.83 * smoothstep(0.0, 0.55, lam);
  rgb += t.rgb * v_color.rgb * lam;
  // the night side carries a cold ambient (planetshine) — a transiting
  // silhouette stays a readable sphere, never a flat black disc
  rgb += vec3(0.015, 0.025, 0.05) * (1.0 - lam) * 2.0;

  // the specular glint — the ocean/ice sun-catch (view ≈ +z in quad space)
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(N, H), 0.0), 42.0);
  rgb += vec3(0.85, 0.92, 1.0) * spec * 0.38;

  // lava (tile 3): the emissive fissures glow through the night side
  if (ty > 2.5 && ty < 3.5) {
    float pulse = 0.8 + 0.2 * sin(u_time * 1.6 + v_color.a * 31.0);
    rgb += vec3(1.0, 0.36, 0.08) * t.a * 1.6 * pulse;
  }

  // the settled world (tile 4): CITY LIGHTS — golden clusters on the
  // night side's land (land = g > b in the garden tile's palette)
  if (ty > 3.5 && ty < 4.5) {
    float land = clamp((t.g - t.b) * 5.0, 0.0, 1.0);
    float night = 1.0 - smoothstep(0.12, 0.42, lam);
    vec2 cell = floor(vec2(u0, v0) * vec2(96.0, 48.0));
    float cn = fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453);
    float city = smoothstep(0.76, 0.94, cn) * land * night;
    rgb += vec3(1.0, 0.72, 0.35) * city * 0.95;
  }

  // the atmosphere rim (a fresnel-ish limb, in-disc now)
  float fres = pow(1.0 - N.z, 3.0);
  rgb += v_color.rgb * fres * 0.65;

  a += smoothstep(1.0, 0.94, pd);

  // the build progress bar (an underline on the disc)
  if (v_state.z > 0.001) {
    float bar = step(-0.9, suv.y) * step(suv.y, -0.62)
              * step(-0.85, suv.x) * step(suv.x, -0.85 + 1.7 * v_state.z);
    rgb += vec3(0.4, 1.0, 0.6) * bar * 0.8;
    a = max(a, bar * 0.9);
  }
  o_color = vec4(rgb * u_fade, a * u_fade);
}`

const PLANET_WGSL = `
struct Params {
  u_mvp : mat4x4<f32>,
  u_view : mat4x4<f32>,
  u_right : vec3<f32>,
  u_up : vec3<f32>,
  u_pxk : f32,
  u_time : f32,
  u_fade : f32,
}
@group(0) @binding(0) var<uniform> params : Params;
@group(1) @binding(0) var texSampler : sampler;
@group(1) @binding(1) var texTexture : texture_2d<f32>;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) color : vec4<f32>,
  @location(2) state : vec4<f32>,
  @location(3) light : vec2<f32>,
}

fn tileUV(ty : f32, uv : vec2<f32>) -> vec2<f32> {
  let col = ty - floor(ty / 4.0) * 4.0;
  let row = floor(ty / 4.0);
  return vec2<f32>(col * 0.25 + uv.x * 0.25, row * 0.25 + uv.y * 0.25);
}

@vertex
fn vsMain(@builtin(vertex_index) vi : u32,
          @location(0) a_pos : vec3<f32>,
          @location(1) a_meta : vec2<f32>,
          @location(2) a_color : vec4<f32>,
          @location(3) a_state : vec4<f32>) -> VSOut {
  var corners = array<vec2<f32>, 6>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
                                     vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0));
  let corner = corners[vi];
  let ang = a_state.x + params.u_time * a_state.y;
  let center = a_pos + vec3<f32>(cos(ang), sin(ang), 0.0) * a_meta.y;
  var eyeZ = -(params.u_view * vec4<f32>(center, 1.0)).z;
  eyeZ = max(eyeZ, 1.0);
  // THE BEAUTY PASS: the quad is 1.45× the planet radius — the atmosphere
  // shell ring (see the GLSL twin's comment)
  let apparent = max(a_meta.x, 6.0 * eyeZ / params.u_pxk) * 1.45;
  let world = center + params.u_right * (corner.x * apparent) + params.u_up * (corner.y * apparent);
  let sunDir = -vec3<f32>(cos(ang), sin(ang), 0.0);
  var out : VSOut;
  out.pos = params.u_mvp * vec4<f32>(world, 1.0);
  out.light = vec2<f32>(dot(sunDir, params.u_right), dot(sunDir, params.u_up));
  out.uv = corner;
  out.color = a_color;
  out.state = a_state;
  return out;
}

@fragment
fn fsMain(frag : VSOut) -> @location(0) vec4<f32> {
  let PQ = 1.45;
  let suv = frag.uv * PQ;
  let pd = length(suv);
  let ty = frag.state.w;

  // ONE fetch, UV selected BY VALUE — textureSample must live in uniform
  // control flow (a branch on the interpolated tile index is a WebGPU
  // validation error on real hardware)
  let ca = cos(params.u_time * 0.05);
  let sa = sin(params.u_time * 0.05);
  let ruv = vec2<f32>(suv.x * ca - suv.y * sa, suv.x * sa + suv.y * ca);
  let sunUv = clamp(ruv * 0.5 + vec2<f32>(0.5, 0.5), vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0));
  let N = vec3<f32>(suv, sqrt(max(0.0, 1.0 - pd * pd)));
  let lon = atan2(N.x, N.z) + frag.color.a * 6.2831853;
  let u0 = 0.5 + lon / 6.2831853;
  let v0 = 0.5 - asin(clamp(N.y, -1.0, 1.0)) / 3.14159265;
  let planetUv = vec2<f32>(fract(u0), v0);
  let sel = select(planetUv, sunUv, ty > 4.5);
  let t = textureSample(texTexture, texSampler, tileUV(ty, sel));

  if (ty > 4.5) {
    let core = exp(-pd * pd * 18.0) * 3.2;
    let corona = exp(-pd * pd * 3.2) * 1.0;
    let spr = t.rgb;
    let mask = smoothstep(1.0, 0.72, pd);
    let a = clamp(core + corona * 0.65 + spr.r * 0.35, 0.0, 1.0) * mask;
    let rgb = (frag.color.rgb * (core + corona * 0.8) + frag.color.rgb * spr * (1.55 + corona * 0.8)) * mask;
    return vec4<f32>(rgb * params.u_fade, a * params.u_fade);
  }

  // the atmosphere shell (see the GLSL twin)
  let atmoCol = normalize(mix(frag.color.rgb, vec3<f32>(0.45, 0.75, 1.0), 0.65) + vec3<f32>(0.001));
  let ann = exp(-pow((pd - 1.0) * 4.4, 2.0)) * smoothstep(1.45, 1.1, pd);
  var rgb = atmoCol * ann * 0.62;
  var a = ann * 0.3;

  if (pd > 1.0) {
    return vec4<f32>(rgb * params.u_fade, a * params.u_fade);
  }
  let L = normalize(vec3<f32>(frag.light, 0.42));
  var lam = 0.30 + 0.70 * max(0.0, dot(N, L));
  lam = 0.17 + 0.83 * smoothstep(0.0, 0.55, lam);
  rgb = rgb + t.rgb * frag.color.rgb * lam;
  rgb = rgb + vec3<f32>(0.015, 0.025, 0.05) * (1.0 - lam) * 2.0;

  let H = normalize(L + vec3<f32>(0.0, 0.0, 1.0));
  let spec = pow(max(dot(N, H), 0.0), 42.0);
  rgb = rgb + vec3<f32>(0.85, 0.92, 1.0) * spec * 0.38;

  if (ty > 2.5 && ty < 3.5) {
    let pulse = 0.8 + 0.2 * sin(params.u_time * 1.6 + frag.color.a * 31.0);
    rgb = rgb + vec3<f32>(1.0, 0.36, 0.08) * t.a * 1.6 * pulse;
  }

  if (ty > 3.5 && ty < 4.5) {
    let land = clamp((t.g - t.b) * 5.0, 0.0, 1.0);
    let night = 1.0 - smoothstep(0.12, 0.42, lam);
    let cell = floor(vec2<f32>(u0, v0) * vec2<f32>(96.0, 48.0));
    let cn = fract(sin(dot(cell, vec2<f32>(12.9898, 78.233))) * 43758.5453);
    let city = smoothstep(0.76, 0.94, cn) * land * night;
    rgb = rgb + vec3<f32>(1.0, 0.72, 0.35) * city * 0.95;
  }

  let fres = pow(1.0 - N.z, 3.0);
  rgb = rgb + frag.color.rgb * fres * 0.65;

  a = a + smoothstep(1.0, 0.94, pd);

  if (frag.state.z > 0.001) {
    let bar = step(-0.9, suv.y) * step(suv.y, -0.62)
            * step(-0.85, suv.x) * step(suv.x, -0.85 + 1.7 * frag.state.z);
    rgb = rgb + vec3<f32>(0.4, 1.0, 0.6) * bar * 0.8;
    a = max(a, bar * 0.9);
  }
  return vec4<f32>(rgb * params.u_fade, a * params.u_fade);
}`

export const planetShader = {
  glsl: { vertex: PLANET_GLSL_VERT, fragment: PLANET_GLSL_FRAG },
  wgsl: PLANET_WGSL,
}

// ─── 9. the gas-giant ring pass (in-plane annuli, split near/far) ───────────
// One instanced quad per ringed planet, laid flat in the system plane. The
// near/far halves split along u_split (the eye-side direction): the far
// command draws before the planets, the near after — the ring passes behind
// the sphere visually without a depth buffer.

const PRING_GLSL_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_pos;   // the system center
layout(location = 1) in vec2 a_meta;  // (innerR, outerR)
layout(location = 2) in vec4 a_color;
layout(location = 3) in vec4 a_state; // (phase, orbitSpeed, orbitR, —)
uniform mat4 u_mvp;
uniform float u_time;
out vec2 v_local;
out vec2 v_range;
out vec4 v_color;

const vec2 CORNERS[6] = vec2[6](vec2(-1,-1), vec2(1,-1), vec2(-1,1), vec2(-1,1), vec2(1,-1), vec2(1,1));

void main() {
  vec2 corner = CORNERS[gl_VertexID];
  // the ring tracks its planet (the same orbit math as the planet pass)
  float ang = a_state.x + u_time * a_state.y;
  vec3 center = a_pos + vec3(cos(ang), sin(ang), 0.0) * a_state.z;
  vec3 world = center + vec3(corner.x * a_meta.y, corner.y * a_meta.y, 0.0);
  gl_Position = u_mvp * vec4(world, 1.0);
  v_local = corner * a_meta.y;
  v_range = a_meta;
  v_color = a_color;
}`

const PRING_GLSL_FRAG = `#version 300 es
precision highp float;
in vec2 v_local;
in vec2 v_range;
in vec4 v_color;
uniform sampler2D u_tex;
uniform vec2 u_split;
uniform float u_half;
uniform float u_fade;
out vec4 o_color;

void main() {
  float r = length(v_local);
  if (r < v_range.x || r > v_range.y) discard;
  // the near/far half test (near = the eye side of the split axis)
  float side = dot(v_local, u_split);
  if (u_half < 0.5 && side < 0.0) discard;
  if (u_half > 0.5 && side > 0.0) discard;
  float band = (r - v_range.x) / (v_range.y - v_range.x);
  vec4 t = texture(u_tex, vec2(band, 0.5));
  float a = t.a * v_color.a * u_fade;
  vec3 rgb = t.rgb * v_color.rgb * a;
  o_color = vec4(rgb, a);
}`

const PRING_WGSL = `
struct Params {
  u_mvp : mat4x4<f32>,
  u_split : vec2<f32>,
  u_half : f32,
  u_fade : f32,
  u_time : f32,
}
@group(0) @binding(0) var<uniform> params : Params;
@group(1) @binding(0) var texSampler : sampler;
@group(1) @binding(1) var texTexture : texture_2d<f32>;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) local : vec2<f32>,
  @location(1) range : vec2<f32>,
  @location(2) color : vec4<f32>,
}

@vertex
fn vsMain(@builtin(vertex_index) vi : u32,
          @location(0) a_pos : vec3<f32>,
          @location(1) a_meta : vec2<f32>,
          @location(2) a_color : vec4<f32>,
          @location(3) a_state : vec4<f32>) -> VSOut {
  var corners = array<vec2<f32>, 6>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
                                     vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0));
  let corner = corners[vi];
  let ang = a_state.x + params.u_time * a_state.y;
  let center = a_pos + vec3<f32>(cos(ang), sin(ang), 0.0) * a_state.z;
  let world = center + vec3<f32>(corner.x * a_meta.y, corner.y * a_meta.y, 0.0);
  var out : VSOut;
  out.pos = params.u_mvp * vec4<f32>(world, 1.0);
  out.local = corner * a_meta.y;
  out.range = a_meta;
  out.color = a_color;
  return out;
}

@fragment
fn fsMain(frag : VSOut) -> @location(0) vec4<f32> {
  let r = length(frag.local);
  if (r < frag.range.x || r > frag.range.y) { discard; }
  let side = dot(frag.local, params.u_split);
  if (params.u_half < 0.5 && side < 0.0) { discard; }
  if (params.u_half > 0.5 && side > 0.0) { discard; }
  let band = (r - frag.range.x) / (frag.range.y - frag.range.x);
  let t = textureSample(texTexture, texSampler, vec2<f32>(band, 0.5));
  let a = t.a * frag.color.a * params.u_fade;
  let rgb = t.rgb * frag.color.rgb * a;
  return vec4<f32>(rgb, a);
}`

export const pringShader = {
  glsl: { vertex: PRING_GLSL_VERT, fragment: PRING_GLSL_FRAG },
  wgsl: PRING_WGSL,
}

// ─── 10. the effect pass (selection rings, claim flashes, target markers) ───

const RING_GLSL_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec2 a_meta;   // (worldRadius, kind)
layout(location = 2) in vec4 a_color;
layout(location = 3) in vec4 a_state;  // (age, param, fade, phase)
uniform mat4 u_mvp;
uniform mat4 u_view;
uniform vec3 u_right;
uniform vec3 u_up;
uniform float u_pxk;
uniform float u_time;
out vec2 v_uv;
out vec4 v_color;
out vec4 v_state;

const vec2 CORNERS[6] = vec2[6](vec2(-1,-1), vec2(1,-1), vec2(-1,1), vec2(-1,1), vec2(1,-1), vec2(1,1));

void main() {
  vec2 corner = CORNERS[gl_VertexID];
  float eyeZ = -(u_view * vec4(a_pos, 1.0)).z;
  eyeZ = max(eyeZ, 1.0);
  float apparent = max(a_meta.x, 12.0 * eyeZ / u_pxk);
  vec3 world = a_pos + u_right * (corner.x * apparent) + u_up * (corner.y * apparent);
  gl_Position = u_mvp * vec4(world, 1.0);
  v_uv = corner;
  v_color = a_color;
  v_state = a_state;
}`

const RING_GLSL_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec4 v_color;
in vec4 v_state;
out vec4 o_color;

void main() {
  float d = length(v_uv);
  if (d > 1.0) discard;
  float kind = v_state.y;
  float a = 0.0;
  vec3 rgb = vec3(0.0);

  if (kind < 0.5) {
    // a pulsing selection ring
    float pulse = 0.7 + 0.3 * sin(v_state.w * 5.0);
    a = exp(-pow((d - 0.82) * 13.0, 2.0)) * 0.9 * pulse * v_state.z;
    rgb = v_color.rgb;
  } else if (kind < 1.5) {
    // a claim flash: expanding + fading
    float r = 0.25 + 0.75 * v_state.x;
    a = exp(-pow((d - r) * 9.0, 2.0)) * (1.0 - v_state.x) * 0.9;
    rgb = v_color.rgb;
  } else if (kind < 2.5) {
    // a rival claim: the same, red
    float r = 0.3 + 0.8 * v_state.x;
    a = exp(-pow((d - r) * 9.0, 2.0)) * (1.0 - v_state.x) * 0.75;
    rgb = v_color.rgb;
  } else {
    // a move target marker: rotating chevrons
    float ang = atan(v_uv.y, v_uv.x) + v_state.w;
    float seg = step(0.72, abs(fract(ang * 2.5465) - 0.5) * 2.0);
    a = exp(-pow((d - 0.8) * 10.0, 2.0)) * seg * 0.8 * v_state.z;
    rgb = v_color.rgb;
  }
  o_color = vec4(rgb * a, a);
}`

const RING_WGSL = `
struct Params {
  u_mvp : mat4x4<f32>,
  u_view : mat4x4<f32>,
  u_right : vec3<f32>,
  u_up : vec3<f32>,
  u_pxk : f32,
  u_time : f32,
}
@group(0) @binding(0) var<uniform> params : Params;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) color : vec4<f32>,
  @location(2) state : vec4<f32>,
}

@vertex
fn vsMain(@builtin(vertex_index) vi : u32,
          @location(0) a_pos : vec3<f32>,
          @location(1) a_meta : vec2<f32>,
          @location(2) a_color : vec4<f32>,
          @location(3) a_state : vec4<f32>) -> VSOut {
  var corners = array<vec2<f32>, 6>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
                                     vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0));
  let corner = corners[vi];
  var eyeZ = -(params.u_view * vec4<f32>(a_pos, 1.0)).z;
  eyeZ = max(eyeZ, 1.0);
  let apparent = max(a_meta.x, 12.0 * eyeZ / params.u_pxk);
  let world = a_pos + params.u_right * (corner.x * apparent) + params.u_up * (corner.y * apparent);
  var out : VSOut;
  out.pos = params.u_mvp * vec4<f32>(world, 1.0);
  out.uv = corner;
  out.color = a_color;
  out.state = a_state;
  return out;
}

@fragment
fn fsMain(frag : VSOut) -> @location(0) vec4<f32> {
  let d = length(frag.uv);
  if (d > 1.0) { discard; }
  let kind = frag.state.y;
  var a = 0.0;
  var rgb = vec3<f32>(0.0);

  if (kind < 0.5) {
    let pulse = 0.7 + 0.3 * sin(frag.state.w * 5.0);
    a = exp(-pow((d - 0.82) * 13.0, 2.0)) * 0.9 * pulse * frag.state.z;
    rgb = frag.color.rgb;
  } else if (kind < 1.5) {
    let r = 0.25 + 0.75 * frag.state.x;
    a = exp(-pow((d - r) * 9.0, 2.0)) * (1.0 - frag.state.x) * 0.9;
    rgb = frag.color.rgb;
  } else if (kind < 2.5) {
    let r = 0.3 + 0.8 * frag.state.x;
    a = exp(-pow((d - r) * 9.0, 2.0)) * (1.0 - frag.state.x) * 0.75;
    rgb = frag.color.rgb;
  } else {
    let ang = atan2(frag.uv.y, frag.uv.x) + frag.state.w;
    let seg = step(0.72, abs(fract(ang * 2.5465) - 0.5) * 2.0);
    a = exp(-pow((d - 0.8) * 10.0, 2.0)) * seg * 0.8 * frag.state.z;
    rgb = frag.color.rgb;
  }
  return vec4<f32>(rgb * a, a);
}`

export const ringShader = {
  glsl: { vertex: RING_GLSL_VERT, fragment: RING_GLSL_FRAG },
  wgsl: RING_WGSL,
}

// ─── 11. the territory pass (the empire border field) ────────────────────────
// THE STELLARIS SIGNATURE: translucent organic territory bubbles with a soft
// contour where the empires meet. The FIELD is baked on the CPU (a 256×256
// texture over the galaxy plane — R = the player's metaball sum, G = the
// Hegemony's, each bubble's radius wobbled by a per-system angular noise so
// the outlines stay organic) and rebaked ONLY when ownership changes (a claim
// event), never per frame. The shader turns the two fields into a fill, an
// edge sheen at the contour, and a warm contested-frontier glow where both
// fields are nearly equal — the empires' borders grow and push each other
// exactly the way they do on a Stellaris galaxy map.

const TERR_GLSL_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;   // world xy
layout(location = 1) in vec2 a_uv;
uniform mat4 u_mvp;
out vec2 v_uv;
void main() {
  gl_Position = u_mvp * vec4(a_pos, -6.0, 1.0); // above the haze, under the lanes
  v_uv = a_uv;
}`

const TERR_GLSL_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_fade;
out vec4 o_color;
void main() {
  vec2 f = texture(u_tex, v_uv).rg;   // the player / rival metaball fields
  float wp = f.r;
  float wr = f.g;
  float dom = max(wp, wr);
  if (dom < 0.02) discard;             // the cheap empty-space out
  // the winner's color paints the ground (Stellaris: the strongest claim)
  vec3 col = mix(vec3(1.0, 0.32, 0.28), vec3(0.32, 0.55, 1.0), step(wr, wp));
  float fill = smoothstep(0.14, 0.42, dom);
  // THE CLOUD BORDER: the fill reads as the empire's nebula wash (the
  // Stellaris territory cloud), the edge keeps a whisper of contour
  float edge = exp(-pow((dom - 0.44) * 7.5, 2.0)) * smoothstep(0.16, 0.30, dom);
  // the contested frontier: both fields strong and nearly equal
  float front = exp(-pow((wp - wr) * 8.0, 2.0)) * smoothstep(0.24, 0.42, dom);
  vec3 rgb = col * (fill * 0.58 + edge * 1.15) + vec3(1.0, 0.72, 0.45) * front * 0.9;
  float a = fill * 0.34 + edge * 0.42 + front * 0.40;
  o_color = vec4(rgb * u_fade, a * u_fade);
}`

const TERR_WGSL = `
struct Params {
  u_mvp : mat4x4<f32>,
  u_fade : f32,
}
@group(0) @binding(0) var<uniform> params : Params;
@group(1) @binding(0) var texSampler : sampler;
@group(1) @binding(1) var texTexture : texture_2d<f32>;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
}

@vertex
fn vsMain(@location(0) a_pos : vec2<f32>,
          @location(1) a_uv : vec2<f32>) -> VSOut {
  var out : VSOut;
  out.pos = params.u_mvp * vec4<f32>(a_pos, -6.0, 1.0);
  out.uv = a_uv;
  return out;
}

@fragment
fn fsMain(frag : VSOut) -> @location(0) vec4<f32> {
  // the fetch lives FIRST — textureSample in uniform control flow (Task 169)
  let f = textureSample(texTexture, texSampler, frag.uv).rg;
  let wp = f.r;
  let wr = f.g;
  let dom = max(wp, wr);
  if (dom < 0.02) { discard; }
  let col = mix(vec3<f32>(1.0, 0.32, 0.28), vec3<f32>(0.32, 0.55, 1.0), step(wr, wp));
  let fill = smoothstep(0.14, 0.42, dom);
  let edge = exp(-pow((dom - 0.44) * 7.5, 2.0)) * smoothstep(0.16, 0.30, dom);
  let front = exp(-pow((wp - wr) * 8.0, 2.0)) * smoothstep(0.24, 0.42, dom);
  let rgb = col * (fill * 0.58 + edge * 1.15) + vec3<f32>(1.0, 0.72, 0.45) * front * 0.9;
  let a = fill * 0.34 + edge * 0.42 + front * 0.40;
  return vec4<f32>(rgb * params.u_fade, a * params.u_fade);
}`

export const territoryShader = {
  glsl: { vertex: TERR_GLSL_VERT, fragment: TERR_GLSL_FRAG },
  wgsl: TERR_WGSL,
}

// ─── 12. the black hole pass (event horizon + tilted accretion disc) ─────────
// The anti-sprite: an opaque BLACK disc that truly occludes (this is the
// alpha-blend pass the additive star glow cannot be), a lensed photon ring,
// and a tilted accretion disc whose far half passes BEHIND the horizon while
// the near half crosses in front — the Interstellar silhouette in one
// billboard quad. The ownership ring / selection dashes live here too: the
// star pass skips black-hole systems entirely (their records carry fade=0).

const BH_GLSL_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec2 a_meta;   // (worldSize, phase)
layout(location = 2) in vec4 a_color;
layout(location = 3) in vec4 a_state;  // (owner, selected, colonize, fade)
uniform mat4 u_mvp;
uniform mat4 u_view;
uniform vec3 u_right;
uniform vec3 u_up;
uniform float u_pxk;
uniform float u_time;
uniform float u_fade;
out vec2 v_uv;
out vec4 v_state;

const vec2 CORNERS[6] = vec2[6](vec2(-1,-1), vec2(1,-1), vec2(-1,1), vec2(-1,1), vec2(1,-1), vec2(1,1));

void main() {
  vec2 corner = CORNERS[gl_VertexID];
  float eyeZ = -(u_view * vec4(a_pos, 1.0)).z;
  eyeZ = max(eyeZ, 1.0);
  // black holes are BIG (Stellaris renders them as the map's landmarks)
  float px = clamp(a_meta.x * u_pxk / eyeZ, 16.0, 64.0);
  float size = px * eyeZ / u_pxk;
  vec3 world = a_pos + u_right * (corner.x * size * 2.2) + u_up * (corner.y * size * 2.2);
  gl_Position = u_mvp * vec4(world, 1.0);
  v_uv = corner;
  v_state = vec4(a_state.xyz, a_state.w * u_fade);
}`

const BH_GLSL_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec4 v_state;
uniform float u_time;
out vec4 o_color;

void main() {
  float d = length(v_uv);
  if (d > 1.0) discard;
  float fade = v_state.w;
  if (fade < 0.01) discard;

  // the event horizon: an opaque black disc (THIS is why the pass alpha-blends)
  float core = smoothstep(0.30, 0.27, d);
  // the photon ring — the lensed rim just outside the horizon
  float photon = exp(-pow((d - 0.34) * 24.0, 2.0));
  // the accretion disc: a slightly tilted ellipse; its far (upper) half hides
  // behind the horizon, the near half crosses in front of it
  vec2 ruv = vec2(v_uv.x * 0.988 - v_uv.y * 0.155, v_uv.x * 0.155 + v_uv.y * 0.988);
  vec2 euv = vec2(ruv.x, ruv.y * 3.1);
  float de = length(euv);
  float disc = smoothstep(0.50, 0.58, de) * smoothstep(1.06, 0.88, de);
  float dop = 0.60 + 0.55 * clamp(-ruv.x * 1.5, 0.0, 1.0);   // doppler beaming
  float heat = clamp(1.0 - (de - 0.50) * 1.9, 0.0, 1.0);      // white-hot inside
  vec3 discCol = mix(vec3(0.95, 0.55, 0.22), vec3(1.0, 0.92, 0.80), heat);
  float occl = 1.0 - step(0.0, ruv.y) * core;                 // upper half behind
  disc *= occl * dop * (0.85 + 0.15 * sin(u_time * 2.2 + v_uv.x * 10.0));

  float glow = exp(-d * d * 2.4);
  vec3 rgb = vec3(0.006, 0.008, 0.014) * core
           + discCol * disc * 1.7
           + vec3(0.70, 0.85, 1.0) * photon * 1.0
           + vec3(0.28, 0.52, 0.95) * glow * 0.30;
  float a = core * 1.0 + disc * 0.95 + photon * 0.55 + glow * 0.3;

  // ownership: the thin tinted ring (the star-pass markers, mirrored here)
  float ring = exp(-pow((d - 0.74) * 15.0, 2.0)) * 0.85;
  if (v_state.x > 0.5 && v_state.x < 1.5) rgb += vec3(0.28, 0.5, 1.0) * ring * 0.6;
  else if (v_state.x > 1.5) rgb += vec3(1.0, 0.28, 0.24) * ring * 0.65;

  // selection: the teal dashed ring
  if (v_state.y > 0.5) {
    float ang = atan(v_uv.y, v_uv.x);
    float dashes = step(0.45, fract(ang * 2.5465));
    float sel = exp(-pow((d - 0.88) * 18.0, 2.0)) * dashes;
    rgb += vec3(0.45, 1.0, 0.88) * sel * 0.95;
    a += sel * 0.6;
  }

  // colonization: the filling arc
  if (v_state.z > 0.001) {
    float ang2 = atan(v_uv.y, v_uv.x) + 3.14159265;
    float arc = exp(-pow((d - 0.88) * 16.0, 2.0)) * step(ang2, 6.2831853 * v_state.z);
    rgb += vec3(0.45, 1.0, 0.7) * arc * 0.8;
    a += arc * 0.5;
  }

  o_color = vec4(rgb * fade, a * fade);
}`

const BH_WGSL = `
struct Params {
  u_mvp : mat4x4<f32>,
  u_view : mat4x4<f32>,
  u_right : vec3<f32>,
  u_up : vec3<f32>,
  u_pxk : f32,
  u_time : f32,
  u_fade : f32,
}
@group(0) @binding(0) var<uniform> params : Params;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) state : vec4<f32>,
}

@vertex
fn vsMain(@builtin(vertex_index) vi : u32,
          @location(0) a_pos : vec3<f32>,
          @location(1) a_meta : vec2<f32>,
          @location(2) a_color : vec4<f32>,
          @location(3) a_state : vec4<f32>) -> VSOut {
  var corners = array<vec2<f32>, 6>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
                                     vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0));
  let corner = corners[vi];
  var eyeZ = -(params.u_view * vec4<f32>(a_pos, 1.0)).z;
  eyeZ = max(eyeZ, 1.0);
  let px = clamp(a_meta.x * params.u_pxk / eyeZ, 16.0, 64.0);
  let size = px * eyeZ / params.u_pxk;
  let world = a_pos + params.u_right * (corner.x * size * 2.2) + params.u_up * (corner.y * size * 2.2);
  var out : VSOut;
  out.pos = params.u_mvp * vec4<f32>(world, 1.0);
  out.uv = corner;
  out.state = vec4<f32>(a_state.xyz, a_state.w * params.u_fade);
  return out;
}

@fragment
fn fsMain(frag : VSOut) -> @location(0) vec4<f32> {
  let d = length(frag.uv);
  if (d > 1.0) { discard; }
  let fade = frag.state.w;
  if (fade < 0.01) { discard; }

  let core = smoothstep(0.30, 0.27, d);
  let photon = exp(-pow((d - 0.34) * 24.0, 2.0));
  let ruv = vec2<f32>(frag.uv.x * 0.988 - frag.uv.y * 0.155, frag.uv.x * 0.155 + frag.uv.y * 0.988);
  let euv = vec2<f32>(ruv.x, ruv.y * 3.1);
  let de = length(euv);
  var disc = smoothstep(0.50, 0.58, de) * smoothstep(1.06, 0.88, de);
  let dop = 0.60 + 0.55 * clamp(-ruv.x * 1.5, 0.0, 1.0);
  let heat = clamp(1.0 - (de - 0.50) * 1.9, 0.0, 1.0);
  let discCol = mix(vec3<f32>(0.95, 0.55, 0.22), vec3<f32>(1.0, 0.92, 0.80), heat);
  let occl = 1.0 - step(0.0, ruv.y) * core;
  disc = disc * occl * dop * (0.85 + 0.15 * sin(params.u_time * 2.2 + frag.uv.x * 10.0));

  let glow = exp(-d * d * 2.4);
  var rgb = vec3<f32>(0.006, 0.008, 0.014) * core
          + discCol * disc * 1.7
          + vec3<f32>(0.70, 0.85, 1.0) * photon * 1.0
          + vec3<f32>(0.28, 0.52, 0.95) * glow * 0.30;
  var a = core * 1.0 + disc * 0.95 + photon * 0.55 + glow * 0.3;

  let ring = exp(-pow((d - 0.74) * 15.0, 2.0)) * 0.85;
  if (frag.state.x > 0.5 && frag.state.x < 1.5) { rgb += vec3<f32>(0.28, 0.5, 1.0) * ring * 0.6; }
  else if (frag.state.x > 1.5) { rgb += vec3<f32>(1.0, 0.28, 0.24) * ring * 0.65; }

  if (frag.state.y > 0.5) {
    let ang = atan2(frag.uv.y, frag.uv.x);
    let dashes = step(0.45, fract(ang * 2.5465));
    let sel = exp(-pow((d - 0.88) * 18.0, 2.0)) * dashes;
    rgb += vec3<f32>(0.45, 1.0, 0.88) * sel * 0.95;
    a += sel * 0.6;
  }

  if (frag.state.z > 0.001) {
    let ang2 = atan2(frag.uv.y, frag.uv.x) + 3.14159265;
    let arc = exp(-pow((d - 0.88) * 16.0, 2.0)) * step(ang2, 6.2831853 * frag.state.z);
    rgb += vec3<f32>(0.45, 1.0, 0.7) * arc * 0.8;
    a += arc * 0.5;
  }

  return vec4<f32>(rgb * fade, a * fade);
}`

export const blackholeShader = {
  glsl: { vertex: BH_GLSL_VERT, fragment: BH_GLSL_FRAG },
  wgsl: BH_WGSL,
}
