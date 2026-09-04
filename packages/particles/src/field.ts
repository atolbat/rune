/**
 * @rune/particles — the VEGETATION FIELD (Task 126): a GPU-static grass
 * field — the one particle class the CPU soup CANNOT scale (40k+ blades
 * × 6 verts re-baked per frame is a non-starter).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE SPLIT (the whole point):
 *   CPU, ONCE at creation  — the field's instance data: per blade the
 *     anchor (pos), the parameters (height, lean, phase, width) and the
 *     tint. Deterministic (the stateless hash01 stream), zero runtime
 *     cost, uploaded to the GPU ONCE as three instanced vertex buffers.
 *   GPU, EVERY FRAME       — the wind. The vertex shader expands a 6-vert
 *     quad from the vertex index (no per-frame CPU geometry), billboards
 *     it CYLINDRICALLY (around world Y — blades always face the camera,
 *     stay anchored at the base), bends it by a gust field sampled at the
 *     blade's own position (two traveling sine waves — the wind reads as
 *     WAVES crossing the field, not a uniform wiggle) plus a per-blade
 *     flutter phase, and fades the far blades out (the density LOD: the
 *     alpha fades with the camera distance; the fragment dissolves the
 *     faded blades STOCHASTICALLY — a screen-door thinning driven by
 *     per-pixel interleaved gradient noise, so the field thins smoothly
 *     into the ground with no sorting and no blending, and the
 *     depth-write stays on — blades keep occluding each other).
 *
 * THE SHADERS ship with the field (a GLSL pair + a WGSL twin — the
 * renderer command compiles both, the executor picks its own backend).
 * Uniform contract: u_mvp (mat4), u_camPos (vec3), u_time (f32),
 * u_wind (vec4: dirX, dirZ, strength, gustiness).
 * Attributes (all step='instance'): i_pos vec3, i_par vec4 (height, lean,
 * phase, width), i_tint vec4 (rgb, brightness). Draw: count 6,
 * instances = count.
 *
 * The caller (the demo) owns the texture: a blade sprite — rgb the
 * vertical gradient (dark base → bright tip), alpha the silhouette. The
 * field bakes its own UVs (u across, v along the blade, v = 0 at the
 * base).
 * ══════════════════════════════════════════════════════════════════════════
 */

import { hash01 } from './spawn.ts'

/** The field description. */
export interface GrassFieldDesc {
  /** The blade count (the instance count of ONE draw call). With a `mask`
   *  this is the CEILING: the bake accepts candidates until `count` blades
   *  pass the mask's rejection (up to 5× `count` tries). */
  readonly count: number
  /** The disc radius the blades scatter over (uniformly in area). */
  readonly radius: number
  /** The blade height range, world units. */
  readonly height: readonly [number, number]
  /** The blade width range, world units (the quad's base extent). */
  readonly width?: readonly [number, number]
  /** The ground height of the anchors (default 0). */
  readonly groundY?: number
  /** The tint palette — a hash-mixed pair (rgb, both endpoints). */
  readonly color?: readonly [readonly number[], readonly number[]]
  /** The RNG stream seed. */
  readonly seed?: number
  /** Task 128 — THE DENSITY MASK: (x, z) → [0, 1]. 0 = no grass grows
   *  here, 1 = full density. A candidate blade at (x, z) survives with
   *  probability w (rejection sampling — the blade SPACING widens in
   *  sparse patches, which is what density reads as), and its HEIGHT is
   *  scaled by (0.55 + 0.45·w) — dense patches are also lusher. Supply
   *  ANY (x, z) source: a procedural noise field, a texture sample, a
   *  hand-painted map. Deterministic (the accept hash is a pure function
   *  of the seed and the try index). */
  readonly mask?: (x: number, z: number) => number
  /** The far-fade distance: blades start dissolving at fade·(1 − fadeBand)
   *  and are fully gone at fade (the stochastic density LOD). Default
   *  radius·0.9. */
  readonly fade?: number
  /** The dissolve band's width as a fraction of `fade` (default 0.35). A
   *  WIDE band reads as a smooth thinning — but PERSPECTIVE compresses it:
   *  at a low camera the band [fade·(1−w) .. fade] can shrink to a dozen
   *  pixels at the horizon and read as a hard line. Raise the camera or
   *  the band; 0.45–0.5 with fade ≈ 3–4× the camera distance reads
   *  smoothly. */
  readonly fadeBand?: number
}

/** The baked field: three instanced attribute arrays + the shader pair. */
export interface GrassField {
  /** The blade anchors, xyz per blade (stride 3). */
  readonly pos: Float32Array
  /** Per blade: (height, lean, phase, width) (stride 4). */
  readonly par: Float32Array
  /** Per blade: (r, g, b, brightness) (stride 4). */
  readonly tint: Float32Array
  /** The blade count. */
  readonly count: number
  /** The far-fade start distance (feeds u_wind.w? — no: baked into the
   *  shaders' constant via the source template). */
  readonly fade: number
  /** The GLSL pair (the renderer command contract). */
  readonly glsl: { readonly vertex: string; readonly fragment: string }
  /** The WGSL twin. */
  readonly wgsl: string
}

/** Bakes the field (CPU, once) + its shader pair. */
export function createGrassField(desc: GrassFieldDesc): GrassField {
  const count = desc.count
  if (!Number.isInteger(count) || count < 1 || count > 2_000_000) {
    throw new Error(`rune/particles: grass count must be an integer in [1, 2M] (got ${count})`)
  }
  const radius = desc.radius
  if (!Number.isFinite(radius) || radius <= 0) {
    throw new Error(`rune/particles: grass radius must be a finite > 0 (got ${radius})`)
  }
  const [hMin, hMax] = desc.height
  if (!Number.isFinite(hMin + hMax) || hMin <= 0 || hMax < hMin) {
    throw new Error(`rune/particles: grass height must be [min > 0 <= max] (got [${hMin}, ${hMax}])`)
  }
  const wRange = desc.width ?? [0.06, 0.12]
  const [wMin, wMax] = wRange
  if (!Number.isFinite(wMin + wMax) || wMin <= 0 || wMax < wMin) {
    throw new Error(`rune/particles: grass width must be [min > 0 <= max] (got [${wMin}, ${wMax}])`)
  }
  const mask = desc.mask
  if (mask !== undefined && typeof mask !== 'function') {
    throw new Error(`rune/particles: grass mask must be a function (x, z) → [0, 1] (got ${typeof mask})`)
  }
  const groundY = desc.groundY ?? 0
  const c0 = desc.color?.[0] ?? [0.16, 0.34, 0.1]
  const c1 = desc.color?.[1] ?? [0.42, 0.55, 0.18]
  const fade = desc.fade ?? radius * 0.9
  if (!Number.isFinite(fade) || fade <= 0) {
    throw new Error(`rune/particles: grass fade must be a finite > 0 (got ${fade})`)
  }
  const fadeBand = desc.fadeBand ?? 0.35
  if (!Number.isFinite(fadeBand) || fadeBand <= 0 || fadeBand >= 1) {
    throw new Error(`rune/particles: grass fadeBand must be in (0, 1) (got ${fadeBand})`)
  }
  const seed = (desc.seed ?? 1) | 0

  // Task 128 — the bake with the DENSITY MASK: candidate blades are drawn
  // uniformly over the disc and REJECTED with probability (1 − w) at their
  // (x, z); the surviving blades fill the buffers (bounded by 5× count
  // tries — a brutally sparse mask still terminates with a partial field).
  // The height and brightness scale with w — dense patches are lusher.
  const cap = Math.min(count, 2_000_000)
  const pos = new Float32Array(cap * 3)
  const par = new Float32Array(cap * 4)
  const tint = new Float32Array(cap * 4)
  let n = 0
  let tries = 0
  const maxTries = cap * 5
  while (n < cap && tries < maxTries) {
    // The uniform-in-area disc: r = R·√u (the sqrt mapping).
    const rr = radius * Math.sqrt(hash01(seed, tries, 21))
    const ang = 6.283185307179586 * hash01(seed, tries, 22)
    const x = Math.cos(ang) * rr
    const z = Math.sin(ang) * rr
    let w = 1
    if (mask !== undefined) {
      w = mask(x, z)
      if (!Number.isFinite(w)) w = 1
      if (w < 0) w = 0
      if (w > 1) w = 1
      if (w < 1 && hash01(seed, tries, 41) >= w) {
        tries++
        continue // rejected — this spot grows nothing
      }
    }
    pos[n * 3] = x
    pos[n * 3 + 1] = groundY
    pos[n * 3 + 2] = z
    par[n * 4] = (hMin + (hMax - hMin) * hash01(seed, tries, 23)) * (0.55 + 0.45 * w)
    par[n * 4 + 1] = 6.283185307179586 * hash01(seed, tries, 24) // the lean azimuth
    par[n * 4 + 2] = hash01(seed, tries, 25) // the flutter phase
    par[n * 4 + 3] = wMin + (wMax - wMin) * hash01(seed, tries, 26)
    const mix = hash01(seed, tries, 27)
    tint[n * 4] = c0[0] + (c1[0] - c0[0]) * mix
    tint[n * 4 + 1] = c0[1] + (c1[1] - c0[1]) * mix
    tint[n * 4 + 2] = c0[2] + (c1[2] - c0[2]) * mix
    tint[n * 4 + 3] = (0.8 + 0.4 * hash01(seed, tries, 28)) * (0.75 + 0.35 * w)
    n++
    tries++
  }

  return { pos, par, tint, count: n, fade, glsl: glslOf(fade, fadeBand), wgsl: wgslOf(fade, fadeBand) }
}

/** The GLSL pair. `fade` is baked into the source (a compile-time constant
 *  — no per-frame uniform traffic for a per-field constant). */
function glslOf(fade: number, band: number): { vertex: string; fragment: string } {
  const F = fade.toFixed(2)
  const B = (fade * band).toFixed(2)
  const vertex = `#version 300 es
// The grass vertex: one quad per blade from gl_VertexID, cylindrical
// billboard, the gust field + the per-blade flutter bend.
layout(location = 0) in vec3 i_pos;
layout(location = 1) in vec4 i_par;
layout(location = 2) in vec4 i_tint;
uniform mat4 u_mvp;
uniform vec3 u_camPos;
uniform float u_time;
uniform vec4 u_wind; // (dirX, dirZ, strength, gustiness)
out vec2 v_uv;
out vec4 v_tint;
out float v_fade;

const vec2 CORNERS[6] = vec2[6](vec2(0.0, 1.0), vec2(1.0, 1.0), vec2(1.0, 0.0), vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(0.0, 0.0));

void main() {
  vec2 cu = CORNERS[gl_VertexID];
  float t = cu.y; // 0 at the base, 1 at the tip
  float h = i_par.x, lean = i_par.y, phase = i_par.z, width = i_par.w;

  // THE GUST FIELD (Task 128 — the "wind as WAVES" upgrade): the wind's
  // bend DIRECTION now SWINGS with a traveling wave (the gust front
  // visibly rolls across the field — not just the amplitude pulsing with
  // every blade leaning the same way). Two waves with SHORT wavelengths
  // (~9.7 and ~11 units — 5+ crests visible at once over a 60-unit field)
  // crossing at an angle, plus a swing term that steers the bend around
  // the wind axis, plus the per-blade flutter.
  float waveA = sin(dot(i_pos.xz, vec2(0.63, 0.44)) - u_time * 2.1);
  float waveB = sin(dot(i_pos.xz, vec2(-0.42, 0.55)) + u_time * 1.4);
  float gust = 0.5 + 0.5 * (waveA + 0.6 * waveB) / 1.6; // 0..1 envelope
  float flutter = sin(u_time * (2.2 + phase * 1.5) + phase * 6.28318);
  // the swing: the bend direction wobbles ±~20° around the wind axis,
  // phase-shifted in space (the wave reads as a rolling front)
  float swing = 0.36 * sin(dot(i_pos.xz, vec2(0.5, -0.33)) - u_time * 1.5);
  vec2 windDir = normalize(u_wind.xy + vec2(1e-4, 0.0));
  vec2 bendDir = normalize(windDir + vec2(-windDir.y, windDir.x) * swing);
  float bendK = u_wind.z * (0.35 + 0.65 * gust) + u_wind.w * flutter;

  // The static lean (a fixed per-blade tilt) and the wind bend, both
  // growing with t^2 (a blade bends at the top, not the base).
  float b = t * t;
  vec2 leanDir = vec2(cos(lean), sin(lean)) * (0.35 * b);
  vec2 windOff = bendDir * (bendK * 0.5 * b);

  // Cylindrical billboard: face the camera around world Y, anchored.
  vec3 toCam = u_camPos - i_pos;
  vec3 right = normalize(vec3(-toCam.z, 0.0, toCam.x));
  vec3 world = i_pos + right * ((cu.x - 0.5) * width)
             + vec3(0.0, t * h, 0.0)
             + vec3(leanDir.x + windOff.x, 0.0, leanDir.y + windOff.y);

  gl_Position = u_mvp * vec4(world, 1.0);
  v_uv = vec2(cu.x, t);
  v_tint = i_tint;
  v_fade = clamp((${F} - length(u_camPos - i_pos)) / ${B}, 0.0, 1.0);
}`
  const fragment = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec4 v_tint;
in float v_fade;
uniform sampler2D u_tex;
out vec4 o_color;
void main() {
  vec4 texel = texture(u_tex, v_uv);
  // The blade gradient: dark base -> bright tip (the texture owns it).
  // THE SMOOTH FAR FADE (the density LOD): near (v_fade = 1) the classic
  // hard silhouette mask; through the fade band each pixel survives with
  // probability ~ v_fade — a screen-door dissolve driven by interleaved
  // gradient noise. At range a blade is a few pixels, so the stochastic
  // holes average into a smooth density falloff — no hard pop at the
  // fade distance, no sorting, no blending, depth-write stays on.
  float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  if (texel.a < 0.5 || n > v_fade) discard;
  o_color = vec4(texel.rgb * v_tint.rgb * v_tint.a, 1.0);
}`
  return { vertex, fragment }
}

/** The WGSL twin (the same math, the WebGPU vocabulary). */
function wgslOf(fade: number, band: number): string {
  const F = fade.toFixed(2)
  const B = (fade * band).toFixed(2)
  return `
struct Params {
  u_mvp : mat4x4<f32>,
  u_camPos : vec4<f32>,
  u_time : f32,
  u_wind : vec4<f32>,
}
@group(0) @binding(0) var<uniform> params : Params;
@group(1) @binding(0) var texSampler : sampler;
@group(1) @binding(1) var texTexture : texture_2d<f32>;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) tint : vec4<f32>,
  @location(2) fade : f32,
}

@vertex
fn vsMain(@builtin(vertex_index) vi : u32,
          @location(0) i_pos : vec3<f32>,
          @location(1) i_par : vec4<f32>,
          @location(2) i_tint : vec4<f32>) -> VSOut {
  var corners = array<vec2<f32>, 6>(vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 1.0), vec2<f32>(1.0, 0.0),
                                     vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 0.0));
  let cu = corners[vi];
  let t = cu.y;
  let h = i_par.x;
  let lean = i_par.y;
  let phase = i_par.z;
  let width = i_par.w;

  // THE GUST FIELD — the WGSL twin of the GLSL wave/swing upgrade (the
  // bend direction rolls with the traveling fronts, ~5 crests at once).
  let waveA = sin(dot(i_pos.xz, vec2<f32>(0.63, 0.44)) - params.u_time * 2.1);
  let waveB = sin(dot(i_pos.xz, vec2<f32>(-0.42, 0.55)) + params.u_time * 1.4);
  let gust = 0.5 + 0.5 * (waveA + 0.6 * waveB) / 1.6;
  let flutter = sin(params.u_time * (2.2 + phase * 1.5) + phase * 6.28318);
  let swing = 0.36 * sin(dot(i_pos.xz, vec2<f32>(0.5, -0.33)) - params.u_time * 1.5);
  let windDir = normalize(params.u_wind.xy + vec2<f32>(1e-4, 0.0));
  let bendDir = normalize(windDir + vec2<f32>(-windDir.y, windDir.x) * swing);
  let bendK = params.u_wind.z * (0.35 + 0.65 * gust) + params.u_wind.w * flutter;

  let b = t * t;
  let leanDir = vec2<f32>(cos(lean), sin(lean)) * (0.35 * b);
  let windOff = bendDir * (bendK * 0.5 * b);

  let toCam = params.u_camPos.xyz - i_pos;
  var right = vec3<f32>(-toCam.z, 0.0, toCam.x);
  let rl = length(right);
  if (rl < 1e-6) { right = vec3<f32>(1.0, 0.0, 0.0); } else { right = right / rl; }
  let world = i_pos + right * ((cu.x - 0.5) * width)
            + vec3<f32>(0.0, t * h, 0.0)
            + vec3<f32>(leanDir.x + windOff.x, 0.0, leanDir.y + windOff.y);

  var out : VSOut;
  out.pos = params.u_mvp * vec4<f32>(world, 1.0);
  out.uv = vec2<f32>(cu.x, t);
  out.tint = i_tint;
  out.fade = clamp((${F} - length(params.u_camPos.xyz - i_pos)) / ${B}, 0.0, 1.0);
  return out;
}

@fragment
fn fsMain(frag : VSOut) -> @location(0) vec4<f32> {
  let texel = textureSample(texTexture, texSampler, frag.uv);
  // THE SMOOTH FAR FADE — the WGSL twin of the GLSL screen-door dissolve
  // (interleaved gradient noise vs. the blade's fade factor; near = the
  // hard silhouette mask, far = stochastic thinning into the ground).
  let n = fract(52.9829189 * fract(dot(frag.pos.xy, vec2<f32>(0.06711056, 0.00583715))));
  if (texel.a < 0.5 || n > frag.fade) { discard; }
  return vec4<f32>(texel.rgb * frag.tint.rgb * frag.tint.a, 1.0);
}`
}
