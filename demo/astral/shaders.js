// "astral" demo — the dual-source shaders (GLSL ES 3.00 + WGSL twins).
//
// Conventions (the repo's dual-source contract, same as @rune/particles'
// field/grass and the model-viewer):
//   GLSL  — layout(location=N) in/out, uniforms by name, out vec4 o_color;
//   WGSL  — one Params struct @group(0) @binding(0), vsMain(vi, @location
//           inputs) -> VSOut, fsMain(frag) -> @location(0).
//
// All geometry is screen-facing quads: 6 corners unfolded from the vertex
// index, one instance per record. Instance records are 64-byte strides
// (WG vertex-layout alignment: vec2@0, vec2@8, vec4@16, vec4@32 — every
// attribute offset a multiple of its format size). Premultiplied output;
// star/ring passes blend additively ('one','one'), ships/planets/lanes
// classic ('one','one-minus-src-alpha').
//
// The uniform values live in module-level arrays (the vfx pattern: the
// resolvers read them — zero allocation per frame).

// ─── the camera + clock (owned by main.js, read by every resolver) ──────────

export const MVP = new Float32Array(16)       // the world→clip camera
export const MVP_PARALLAX = new Float32Array(16) // the background layer camera
export const PX = [0.42]                      // pixels per world unit (the zoom)
export const PX_PARALLAX = [0.06]              // the background layer's zoom
export const CLOCK = [0]                      // the game clock (freezes on pause)
export const FADE = [1]                       // the system-view blend (0 = galaxy, 1 = system)
export const GALAXY_FADE = [0]                // 1 - FADE (the galaxy layer's fade)

/** Build an orthographic world→clip matrix into `out` (column-major). */
export function setCamera(out, cx, cy, px, aspect, heightPx) {
  const halfH = heightPx / 2 / px
  const halfW = halfH * aspect
  out.fill(0)
  out[0] = 1 / halfW
  out[5] = 1 / halfH
  out[10] = 1
  out[12] = -cx / halfW
  out[13] = -cy / halfH
  out[15] = 1
  return out
}

// ─── 1. the star pass (galaxy stars, the background field) ──────────────────

const STAR_GLSL_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec2 a_meta;   // (worldSize, phase)
layout(location = 2) in vec4 a_color;
layout(location = 3) in vec4 a_state;  // (owner, selected, colonize, fade)
uniform mat4 u_mvp;
uniform float u_px;
uniform float u_time;
uniform float u_fade;
out vec2 v_uv;
out vec4 v_color;
out vec4 v_state;

const vec2 CORNERS[6] = vec2[6](vec2(-1,-1), vec2(1,-1), vec2(-1,1), vec2(-1,1), vec2(1,-1), vec2(1,1));

void main() {
  vec2 corner = CORNERS[gl_VertexID];
  float tw = 0.82 + 0.18 * sin(u_time * (0.9 + a_meta.y * 1.7) + a_meta.y * 43.0);
  // apparent size: world-size, but capped/min-ed in SCREEN pixels (a star is
  // a glow — readable at any zoom, never a giant disc in the system view)
  float px = a_meta.x * u_px;
  float capped = clamp(px, 6.0, 26.0) / u_px;
  // the halo quad is 3.2x the core so the glow has room
  vec2 world = a_pos + corner * capped * 3.2;
  gl_Position = u_mvp * vec4(world, 0.0, 1.0);
  v_uv = corner;
  v_color = vec4(a_color.rgb * tw, a_color.a * u_fade * a_state.w);
  v_state = a_state;
}`

const STAR_GLSL_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec4 v_color;
in vec4 v_state;
out vec4 o_color;

void main() {
  float d = length(v_uv);
  if (d > 1.0) discard;
  float core = exp(-d * d * 14.0) * 1.25;
  float glow = exp(-d * d * 3.6) * 0.4;
  float a = (core + glow) * v_color.a;
  vec3 rgb = v_color.rgb * a;

  // ownership: a thin tinted ring at the halo's edge
  float ring = exp(-pow((d - 0.62) * 14.0, 2.0)) * 0.85;
  if (v_state.x > 0.5 && v_state.x < 1.5) rgb += vec3(0.28, 0.5, 1.0) * ring * 0.55 * v_color.a;
  else if (v_state.x > 1.5) rgb += vec3(1.0, 0.28, 0.24) * ring * 0.6 * v_color.a;

  // selection: a dashed rotating ring just outside the halo
  if (v_state.y > 0.5) {
    float ang = atan(v_uv.y, v_uv.x);
    float dashes = step(0.45, fract(ang * 2.5465 + v_state.x * 7.0));
    float sel = exp(-pow((d - 0.86) * 18.0, 2.0)) * dashes;
    rgb += vec3(1.0, 0.85, 0.4) * sel * 0.9;
    a += sel * 0.6;
  }

  // colonization in progress: an arc that fills with progress
  if (v_state.z > 0.001) {
    float ang = atan(v_uv.y, v_uv.x) + 3.14159265;
    float arc = exp(-pow((d - 0.86) * 16.0, 2.0)) * step(ang, 6.2831853 * v_state.z);
    rgb += vec3(0.45, 1.0, 0.7) * arc * 0.8;
    a += arc * 0.5;
  }

  o_color = vec4(rgb, a);
}`

const STAR_WGSL = `
struct Params {
  u_mvp : mat4x4<f32>,
  u_px : f32,
  u_time : f32,
  u_fade : f32,
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
          @location(0) a_pos : vec2<f32>,
          @location(1) a_meta : vec2<f32>,
          @location(2) a_color : vec4<f32>,
          @location(3) a_state : vec4<f32>) -> VSOut {
  var corners = array<vec2<f32>, 6>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
                                     vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0));
  let corner = corners[vi];
  let tw = 0.82 + 0.18 * sin(params.u_time * (0.9 + a_meta.y * 1.7) + a_meta.y * 43.0);
  let px = a_meta.x * params.u_px;
  let capped = clamp(px, 6.0, 26.0) / params.u_px;
  let world = a_pos + corner * capped * 3.2;
  var out : VSOut;
  out.pos = params.u_mvp * vec4<f32>(world, 0.0, 1.0);
  out.uv = corner;
  out.color = vec4<f32>(a_color.rgb * tw, a_color.a * params.u_fade * a_state.w);
  out.state = a_state;
  return out;
}

@fragment
fn fsMain(frag : VSOut) -> @location(0) vec4<f32> {
  let d = length(frag.uv);
  if (d > 1.0) { discard; }
  let core = exp(-d * d * 14.0) * 1.25;
  let glow = exp(-d * d * 3.6) * 0.4;
  var a = (core + glow) * frag.color.a;
  var rgb = frag.color.rgb * a;

  let ring = exp(-pow((d - 0.62) * 14.0, 2.0)) * 0.85;
  if (frag.state.x > 0.5 && frag.state.x < 1.5) { rgb += vec3<f32>(0.28, 0.5, 1.0) * ring * 0.55 * frag.color.a; }
  else if (frag.state.x > 1.5) { rgb += vec3<f32>(1.0, 0.28, 0.24) * ring * 0.6 * frag.color.a; }

  if (frag.state.y > 0.5) {
    let ang = atan2(frag.uv.y, frag.uv.x);
    let dashes = step(0.45, fract(ang * 2.5465 + frag.state.x * 7.0));
    let sel = exp(-pow((d - 0.86) * 18.0, 2.0)) * dashes;
    rgb += vec3<f32>(1.0, 0.85, 0.4) * sel * 0.9;
    a += sel * 0.6;
  }

  if (frag.state.z > 0.001) {
    let ang2 = atan2(frag.uv.y, frag.uv.x) + 3.14159265;
    let arc = exp(-pow((d - 0.86) * 16.0, 2.0)) * step(ang2, 6.2831853 * frag.state.z);
    rgb += vec3<f32>(0.45, 1.0, 0.7) * arc * 0.8;
    a += arc * 0.5;
  }

  return vec4<f32>(rgb, a);
}`

export const starShader = {
  glsl: { vertex: STAR_GLSL_VERT, fragment: STAR_GLSL_FRAG },
  wgsl: STAR_WGSL,
}

// ─── 2. the lane pass (screen-constant hyperlane lines) ─────────────────────
// The lane quad is baked as CENTERLINE points + the unit perpendicular (times
// the edge side ±1) in the pad floats; the vertex shader expands it to a
// constant ~2.2 SCREEN pixels — a baked world-space width would drop below
// one pixel at galaxy zoom and the rasterizer would drop the whole quad
// (the thin-line dropout: 0.36px-wide triangles hit no pixel center).

const LANE_GLSL_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;   // a centerline point (world)
layout(location = 1) in vec2 a_dir;   // unit perpendicular * edge side (±1)
layout(location = 2) in vec4 a_color; // premultiplied by the bake
uniform mat4 u_mvp;
uniform float u_px;
out vec4 v_color;
void main() {
  vec2 world = a_pos + a_dir * (1.1 / u_px);
  gl_Position = u_mvp * vec4(world, 0.0, 1.0);
  v_color = a_color;
}`

const LANE_GLSL_FRAG = `#version 300 es
precision highp float;
in vec4 v_color;
uniform float u_fade;
out vec4 o_color;
void main() {
  o_color = vec4(v_color.rgb * u_fade, v_color.a * u_fade); // premultiplied by the builder
}`

const LANE_WGSL = `
struct Params {
  u_mvp : mat4x4<f32>,
  u_px : f32,
  u_fade : f32,
}
@group(0) @binding(0) var<uniform> params : Params;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) color : vec4<f32>,
}

@vertex
fn vsMain(@location(0) a_pos : vec2<f32>,
          @location(1) a_dir : vec2<f32>,
          @location(2) a_color : vec4<f32>) -> VSOut {
  let world = a_pos + a_dir * (1.1 / params.u_px);
  var out : VSOut;
  out.pos = params.u_mvp * vec4<f32>(world, 0.0, 1.0);
  out.color = a_color;
  return out;
}

@fragment
fn fsMain(frag : VSOut) -> @location(0) vec4<f32> {
  return vec4<f32>(frag.color.rgb * params.u_fade, frag.color.a * params.u_fade);
}`

export const laneShader = {
  glsl: { vertex: LANE_GLSL_VERT, fragment: LANE_GLSL_FRAG },
  wgsl: LANE_WGSL,
}

// ─── 2b. the soup pass (the orbit circles) ───────────────────────────────────

const SOUP_GLSL_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec4 a_color;
uniform mat4 u_mvp;
out vec4 v_color;
void main() {
  gl_Position = u_mvp * vec4(a_pos, 0.0, 1.0);
  v_color = a_color;
}`

const SOUP_GLSL_FRAG = `#version 300 es
precision highp float;
in vec4 v_color;
uniform float u_fade;
out vec4 o_color;
void main() {
  o_color = vec4(v_color.rgb * u_fade, v_color.a * u_fade); // premultiplied by the builder
}`

const SOUP_WGSL = `
struct Params {
  u_mvp : mat4x4<f32>,
  u_fade : f32,
}
@group(0) @binding(0) var<uniform> params : Params;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) color : vec4<f32>,
}

@vertex
fn vsMain(@location(0) a_pos : vec2<f32>,
          @location(1) a_color : vec4<f32>) -> VSOut {
  var out : VSOut;
  out.pos = params.u_mvp * vec4<f32>(a_pos, 0.0, 1.0);
  out.color = a_color;
  return out;
}

@fragment
fn fsMain(frag : VSOut) -> @location(0) vec4<f32> {
  return vec4<f32>(frag.color.rgb * params.u_fade, frag.color.a * params.u_fade);
}`

export const soupShader = {
  glsl: { vertex: SOUP_GLSL_VERT, fragment: SOUP_GLSL_FRAG },
  wgsl: SOUP_WGSL,
}

// ─── 3. the ship pass (instanced, galaxy-space) ──────────────────────────────

const SHIP_GLSL_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec2 a_meta;   // (angle, worldSize)
layout(location = 2) in vec4 a_color;
layout(location = 3) in vec4 a_state;  // (kind, moving, selected, phase)
uniform mat4 u_mvp;
uniform float u_px;
uniform float u_time;
out vec2 v_uv;
out vec4 v_color;
out vec4 v_state;

const vec2 CORNERS[6] = vec2[6](vec2(-1,-1), vec2(1,-1), vec2(-1,1), vec2(-1,1), vec2(1,-1), vec2(1,1));

void main() {
  vec2 corner = CORNERS[gl_VertexID];
  // min apparent size in SCREEN pixels (a ship stays readable zoomed out)
  float apparent = max(a_meta.y, 11.0 / u_px);
  float ca = cos(a_meta.x), sa = sin(a_meta.x);
  vec2 rc = vec2(corner.x * ca - corner.y * sa, corner.x * sa + corner.y * ca);
  vec2 world = a_pos + rc * apparent;
  gl_Position = u_mvp * vec4(world, 0.0, 1.0);
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
  // the hull: a stretched diamond
  float hull = smoothstep(1.0, 0.72, d);
  float shade = 0.55 + 0.45 * clamp(v_uv.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 rgb = v_color.rgb * hull * shade;
  float a = hull * 0.92;

  // the nose light
  float nose = exp(-pow((v_uv.y - 0.55) * 5.0, 2.0)) * exp(-pow(v_uv.x * 2.4, 2.0));
  rgb += v_color.rgb * nose * 0.5;
  a += nose * 0.3;

  // the engine plume (moving ships only)
  if (v_state.y > 0.5) {
    float flick = 0.6 + 0.4 * sin(u_time * 34.0 + v_state.w * 19.0);
    float plume = exp(-pow((v_uv.y + 0.78) * 4.4, 2.0)) * exp(-pow(v_uv.x * 2.0, 2.0)) * flick;
    rgb += vec3(1.0, 0.62, 0.25) * plume * 0.9;
    a += plume * 0.6;
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

  o_color = vec4(rgb, a);
}`

const SHIP_WGSL = `
struct Params {
  u_mvp : mat4x4<f32>,
  u_px : f32,
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
          @location(0) a_pos : vec2<f32>,
          @location(1) a_meta : vec2<f32>,
          @location(2) a_color : vec4<f32>,
          @location(3) a_state : vec4<f32>) -> VSOut {
  var corners = array<vec2<f32>, 6>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
                                     vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0));
  let corner = corners[vi];
  let apparent = max(a_meta.y, 11.0 / params.u_px);
  let ca = cos(a_meta.x);
  let sa = sin(a_meta.x);
  let rc = vec2<f32>(corner.x * ca - corner.y * sa, corner.x * sa + corner.y * ca);
  let world = a_pos + rc * apparent;
  var out : VSOut;
  out.pos = params.u_mvp * vec4<f32>(world, 0.0, 1.0);
  out.uv = corner;
  out.color = a_color;
  out.state = a_state;
  return out;
}

@fragment
fn fsMain(frag : VSOut) -> @location(0) vec4<f32> {
  let d = length(frag.uv * vec2<f32>(1.0, 0.6));
  if (d > 1.25) { discard; }
  let hull = smoothstep(1.0, 0.72, d);
  let shade = 0.55 + 0.45 * clamp(frag.uv.y * 0.5 + 0.5, 0.0, 1.0);
  var rgb = frag.color.rgb * hull * shade;
  var a = hull * 0.92;

  let nose = exp(-pow((frag.uv.y - 0.55) * 5.0, 2.0)) * exp(-pow(frag.uv.x * 2.4, 2.0));
  rgb += frag.color.rgb * nose * 0.5;
  a += nose * 0.3;

  if (frag.state.y > 0.5) {
    let flick = 0.6 + 0.4 * sin(params.u_time * 34.0 + frag.state.w * 19.0);
    let plume = exp(-pow((frag.uv.y + 0.78) * 4.4, 2.0)) * exp(-pow(frag.uv.x * 2.0, 2.0)) * flick;
    rgb += vec3<f32>(1.0, 0.62, 0.25) * plume * 0.9;
    a += plume * 0.6;
  }

  if (frag.state.z > 0.5) {
    let ang = atan2(frag.uv.y, frag.uv.x);
    let dashes = step(0.5, fract(ang * 3.8 + params.u_time * 1.2));
    let ring = exp(-pow((d - 1.05) * 9.0, 2.0)) * dashes;
    rgb += vec3<f32>(1.0, 0.85, 0.4) * ring;
    a += ring * 0.7;
  }

  // colonizing: a soft green aura (the GLSL twin's block — the WGSL twin
  // had silently dropped it, ships colonizing showed the aura only on GL)
  if (frag.state.w > 0.0 && frag.state.y > 1.5) {
    let aura = exp(-d * d * 2.2) * (0.5 + 0.5 * sin(params.u_time * 3.0));
    rgb += vec3<f32>(0.35, 1.0, 0.6) * aura * 0.35;
  }

  return vec4<f32>(rgb, a);
}`

export const shipShader = {
  glsl: { vertex: SHIP_GLSL_VERT, fragment: SHIP_GLSL_FRAG },
  wgsl: SHIP_WGSL,
}

// ─── 4. the planet pass (system view: orbiting discs + the sun) ─────────────

const PLANET_GLSL_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;    // the system center (world)
layout(location = 1) in vec2 a_meta;   // (planetRadius, orbitRadius)
layout(location = 2) in vec4 a_color;
layout(location = 3) in vec4 a_state;  // (phase, orbitSpeed, buildProgress, type)
uniform mat4 u_mvp;
uniform float u_time;
out vec2 v_uv;
out vec4 v_color;
out vec4 v_state;

const vec2 CORNERS[6] = vec2[6](vec2(-1,-1), vec2(1,-1), vec2(-1,1), vec2(-1,1), vec2(1,-1), vec2(1,1));

void main() {
  vec2 corner = CORNERS[gl_VertexID];
  float ang = a_state.x + u_time * a_state.y;
  vec2 center = a_pos + vec2(cos(ang), sin(ang)) * a_meta.y;
  vec2 world = center + corner * a_meta.x;
  gl_Position = u_mvp * vec4(world, 0.0, 1.0);
  v_uv = corner;
  v_color = a_color;
  v_state = a_state;
}`

const PLANET_GLSL_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec4 v_color;
in vec4 v_state;
out vec4 o_color;

void main() {
  float d = length(v_uv);
  float type = v_state.w;

  if (type < 3.5) {
    // a planet: a shaded disc
    if (d > 1.0) discard;
    vec2 N = normalize(v_uv + vec2(1e-5));
    vec2 L = normalize(vec2(-0.55, 0.65));
    float lightK = 0.35 + 0.65 * max(0.0, dot(N, L));
    vec3 rgb = v_color.rgb * lightK;

    if (type > 0.5 && type < 1.5) {
      // gas giant: latitude bands
      rgb *= 0.85 + 0.15 * sin(v_uv.y * 16.0 + v_color.x * 9.0);
    } else if (type > 2.5) {
      // lava: hot cracks
      float cracks = step(0.86, sin(v_uv.x * 14.0) * sin(v_uv.y * 14.0));
      rgb = mix(rgb, vec3(1.0, 0.45, 0.1), cracks * 0.55);
    }
    // the rim
    float rim = exp(-pow((d - 0.96) * 10.0, 2.0));
    rgb += v_color.rgb * rim * 0.25;
    float a = smoothstep(1.0, 0.94, d);

    // the build progress bar (an underline on the disc)
    if (v_state.z > 0.001) {
      float bar = step(-0.9, v_uv.y) * step(v_uv.y, -0.62)
                * step(-0.85, v_uv.x) * step(v_uv.x, -0.85 + 1.7 * v_state.z);
      rgb += vec3(0.4, 1.0, 0.6) * bar * 0.8;
      a = max(a, bar * 0.9);
    }
    o_color = vec4(rgb, a);
  } else {
    // the SUN (type 4): a blazing core + corona
    float core = exp(-d * d * 26.0) * 1.5;
    float corona = exp(-d * d * 4.2) * 0.5;
    float a = (core + corona) * 0.95;
    o_color = vec4(v_color.rgb * a, a);
  }
}`

const PLANET_WGSL = `
struct Params {
  u_mvp : mat4x4<f32>,
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
          @location(0) a_pos : vec2<f32>,
          @location(1) a_meta : vec2<f32>,
          @location(2) a_color : vec4<f32>,
          @location(3) a_state : vec4<f32>) -> VSOut {
  var corners = array<vec2<f32>, 6>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
                                     vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0));
  let corner = corners[vi];
  let ang = a_state.x + params.u_time * a_state.y;
  let center = a_pos + vec2<f32>(cos(ang), sin(ang)) * a_meta.y;
  let world = center + corner * a_meta.x;
  var out : VSOut;
  out.pos = params.u_mvp * vec4<f32>(world, 0.0, 1.0);
  out.uv = corner;
  out.color = a_color;
  out.state = a_state;
  return out;
}

@fragment
fn fsMain(frag : VSOut) -> @location(0) vec4<f32> {
  let d = length(frag.uv);
  let ty = frag.state.w;

  if (ty < 3.5) {
    if (d > 1.0) { discard; }
    let N = normalize(frag.uv + vec2<f32>(1e-5, 1e-5));
    let L = normalize(vec2<f32>(-0.55, 0.65));
    let lightK = 0.35 + 0.65 * max(0.0, dot(N, L));
    var rgb = frag.color.rgb * lightK;

    if (ty > 0.5 && ty < 1.5) {
      rgb = rgb * (0.85 + 0.15 * sin(frag.uv.y * 16.0 + frag.color.x * 9.0));
    } else if (ty > 2.5) {
      let cracks = step(0.86, sin(frag.uv.x * 14.0) * sin(frag.uv.y * 14.0));
      rgb = mix(rgb, vec3<f32>(1.0, 0.45, 0.1), cracks * 0.55);
    }
    let rim = exp(-pow((d - 0.96) * 10.0, 2.0));
    rgb += frag.color.rgb * rim * 0.25;
    var a = smoothstep(1.0, 0.94, d);

    if (frag.state.z > 0.001) {
      let bar = step(-0.9, frag.uv.y) * step(frag.uv.y, -0.62)
              * step(-0.85, frag.uv.x) * step(frag.uv.x, -0.85 + 1.7 * frag.state.z);
      rgb += vec3<f32>(0.4, 1.0, 0.6) * bar * 0.8;
      a = max(a, bar * 0.9);
    }
    return vec4<f32>(rgb, a);
  }

  let core = exp(-d * d * 26.0) * 1.5;
  let corona = exp(-d * d * 4.2) * 0.5;
  let a = (core + corona) * 0.95;
  return vec4<f32>(frag.color.rgb * a, a);
}`

export const planetShader = {
  glsl: { vertex: PLANET_GLSL_VERT, fragment: PLANET_GLSL_FRAG },
  wgsl: PLANET_WGSL,
}

// ─── 5. the ring/effect pass (selection, claim flashes, target markers) ─────

const RING_GLSL_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec2 a_meta;   // (worldRadius, kind)
layout(location = 2) in vec4 a_color;
layout(location = 3) in vec4 a_state;  // (age, param, fade, phase)
uniform mat4 u_mvp;
uniform float u_px;
uniform float u_time;
out vec2 v_uv;
out vec4 v_color;
out vec4 v_state;

const vec2 CORNERS[6] = vec2[6](vec2(-1,-1), vec2(1,-1), vec2(-1,1), vec2(-1,1), vec2(1,-1), vec2(1,1));

void main() {
  vec2 corner = CORNERS[gl_VertexID];
  float apparent = max(a_meta.x, 12.0 / u_px);
  vec2 world = a_pos + corner * apparent;
  gl_Position = u_mvp * vec4(world, 0.0, 1.0);
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
  u_px : f32,
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
          @location(0) a_pos : vec2<f32>,
          @location(1) a_meta : vec2<f32>,
          @location(2) a_color : vec4<f32>,
          @location(3) a_state : vec4<f32>) -> VSOut {
  var corners = array<vec2<f32>, 6>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
                                     vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0));
  let corner = corners[vi];
  let apparent = max(a_meta.x, 12.0 / params.u_px);
  let world = a_pos + corner * apparent;
  var out : VSOut;
  out.pos = params.u_mvp * vec4<f32>(world, 0.0, 1.0);
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
