// "astral" demo — THE POST-PROCESSING CHAIN (the "way more beautiful" pass).
//
// The whole scene now renders INTO A SURFACE, then a classic bloom chain
// runs at quarter resolution and a final composite draws to the canvas:
//
//   scene ──capture──▶ sceneSurf ──threshold+down──▶ bloomA (¼)
//                        bloomA ──blur H──▶ bloomB ──blur V──▶ bloomA
//                        bloomA ──blur H wide──▶ bloomB ──blur V wide──▶ bloomA
//   sceneSurf + bloomA ──composite──▶ canvas (bloom + vignette + chroma
//                                           aberration + grade + grain)
//
// THE PLUMBING (why it looks the way it does):
//   • renderer.pass() emits BindTarget(targetId) before its quad — the
//     single-input passes (threshold, blurs) use it directly. The pass
//     fragment is SINGLE-SOURCE (GLSL for the GL backend, WGSL for the
//     WebGPU backend) — the renderer re-boots whole on a backend switch,
//     so the branch is taken once at construction.
//   • the COMPOSITE needs TWO textures (scene + bloom) — the WebGPU pass
//     API is single-input by contract, so the composite is a regular
//     dual-source renderer.command() (GL: u_scene/u_bloom samplers; WG:
//     texTexture@binding(1) + texTexture2@binding(2) — the Task-3
//     multi-texture layout), wrapped by hand with the same tape trick
//     the runtime's withTarget() uses: emit BindTarget(0) before the
//     draw — back to the canvas.
//   • THE TAPE OPCODE is a serialized format constant (BindTarget = 4,
//     opcodes.ts — changing it breaks every recorded tape, it cannot
//     move). The demo hardcodes it with this provenance note; the dist
//     bundle does not export OpCode.
//
// PERF (a phone at DPR 3, 360×663 CSS → 1080×1989 buffer):
//   • the scene draw cost is UNCHANGED — it renders into a texture
//     instead of the canvas (same raster work);
//   • the bloom chain runs at ¼ res (~270×497): threshold + 4 blurs ≈
//     5 × 0.13 MP of cheap texture taps;
//   • the composite is ONE full-res pass with 2 fetches + ~60 ALU —
//     negligible on any 2020+ phone GPU, measured comfortably under a
//     millisecond on the SwiftShader smoke too.
//
// The chain is rebuilt on buffer resize (surfaces are fixed-size FBOs);
// the rebuild is lazy — checked once per frame against the live size.

import { CLOCK } from './shaders.js?v=6'

// the serialized tape opcode (BindTarget) — see the header provenance
const OP_BIND_TARGET = 4

// ─── the composite tuning (module state the uniform resolvers read) ─────────
export const BLOOM_GAIN = [0.85]      // bloom add strength
export const VIGNETTE = [0.42]       // edge darkening amount
export const GRAIN = [0.012]         // fine dither amplitude (kills banding)

/** Wrap a command so it draws into targetId (the runtime's withTarget twin). */
function captureInto(command, targetId, clear) {
  const clearFlag = clear ? 1 : 0
  return {
    id: command.id,
    record(props, frameCtx, writer) {
      writer.emit(OP_BIND_TARGET, targetId, clearFlag, 0, 0)
      command.record(props, frameCtx, writer)
    },
  }
}

/** Wrap a command so it draws to the CANVAS (BindTarget 0, no clear —
 *  the executor's BeginPass already cleared it this frame). */
function toCanvas(command) {
  return {
    id: command.id,
    record(props, frameCtx, writer) {
      writer.emit(OP_BIND_TARGET, 0, 0, 0, 0)
      command.record(props, frameCtx, writer)
    },
  }
}

// ─── the pass fragments (GL branch / WG branch) ─────────────────────────────

// threshold + downsample: soft-knee bright-pass, tinted slightly warm so
// the star bloom reads golden like a camera sensor bloom, not white fog
const THRESH_GLSL = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_thresh;
out vec4 o_color;
void main() {
  vec3 c = texture(u_tex, v_uv).rgb;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float knee = u_thresh * 0.6;
  float soft = clamp((lum - u_thresh + knee) / (2.0 * knee + 1e-5), 0.0, 1.0);
  float bright = max(soft * soft * (knee + 1e-5) * 2.0, lum - u_thresh) / max(lum, 1e-5);
  vec3 bloom = c * bright;
  o_color = vec4(bloom * vec3(1.04, 1.0, 0.96), 1.0);
}`

const THRESH_WGSL = `
struct Params {
  u_thresh : f32,
}
@group(0) @binding(0) var<uniform> params : Params;
@group(1) @binding(0) var texSampler : sampler;
@group(1) @binding(1) var texTexture : texture_2d<f32>;

@fragment
fn fsMain(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let c = textureSample(texTexture, texSampler, uv).rgb;
  let lum = dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
  let knee = params.u_thresh * 0.6;
  let soft = clamp((lum - params.u_thresh + knee) / (2.0 * knee + 1e-5), 0.0, 1.0);
  let bright = max(soft * soft * (knee + 1e-5) * 2.0, lum - params.u_thresh) / max(lum, 1e-5);
  let bloom = c * bright;
  return vec4<f32>(bloom * vec3<f32>(1.04, 1.0, 0.96), 1.0);
}`

// separable gaussian blur, 9 taps + linear-sample trick (5 fetches).
// u_dir is pre-scaled by the texel size and the radius.
const BLUR_GLSL = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_dir;
out vec4 o_color;
void main() {
  vec3 sum = texture(u_tex, v_uv).rgb * 0.227027;
  sum += texture(u_tex, v_uv + u_dir * 1.3846).rgb * 0.316216;
  sum += texture(u_tex, v_uv - u_dir * 1.3846).rgb * 0.316216;
  sum += texture(u_tex, v_uv + u_dir * 3.2308).rgb * 0.070270;
  sum += texture(u_tex, v_uv - u_dir * 3.2308).rgb * 0.070270;
  o_color = vec4(sum, 1.0);
}`

const BLUR_WGSL = `
struct Params {
  u_dir : vec2<f32>,
}
@group(0) @binding(0) var<uniform> params : Params;
@group(1) @binding(0) var texSampler : sampler;
@group(1) @binding(1) var texTexture : texture_2d<f32>;

@fragment
fn fsMain(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  var sum = textureSample(texTexture, texSampler, uv).rgb * 0.227027;
  sum += textureSample(texTexture, texSampler, uv + params.u_dir * 1.3846).rgb * 0.316216;
  sum += textureSample(texTexture, texSampler, uv - params.u_dir * 1.3846).rgb * 0.316216;
  sum += textureSample(texTexture, texSampler, uv + params.u_dir * 3.2308).rgb * 0.070270;
  sum += textureSample(texTexture, texSampler, uv - params.u_dir * 3.2308).rgb * 0.070270;
  return vec4<f32>(sum, 1.0);
}`

// THE COMPOSITE — a regular dual-source command (not a pass): two
// samplers, clip-space quad, no blending (BeginPass cleared the canvas).
// bloom add + soft filmic curve + vignette + radial chroma + grain.
const COMPOSITE_GLSL_VERT = `#version 300 es
layout(location = 0) in vec2 a_pos;   // clip-space quad (±1)
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`

const COMPOSITE_GLSL_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_scene;
uniform sampler2D u_bloom;
uniform float u_bloomGain;
uniform float u_vignette;
uniform float u_grain;
uniform float u_time;
out vec4 o_color;

/** hash for the grain — stable, cheap, no texture */
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 uv = v_uv;
  vec2 fromC = uv - 0.5;
  float r2 = dot(fromC, fromC);

  // radial chromatic aberration: the RGB channels sample at slightly
  // different radii toward the edges — the lens feel
  float ca = 0.0022 * r2;
  vec3 scene;
  scene.r = texture(u_scene, uv + fromC * ca).r;
  scene.g = texture(u_scene, uv).g;
  scene.b = texture(u_scene, uv - fromC * ca).b;

  vec3 bloom = texture(u_bloom, uv).rgb * u_bloomGain;
  vec3 col = scene + bloom * (vec3(1.0) - scene * 0.35);

  // a HIGHLIGHT-COMPRESSION curve (1.0 → 0.85, darks untouched — the first
  // draft used x/(x·0.65+0.35), which LIFTS the black end and washed the
  // whole galaxy into milk; this one only softens the star cores' clip)
  col = col / (vec3(1.0) + col * 0.25) * 1.06;

  // vignette — a gentle falloff, never a spotlight
  float vig = 1.0 - u_vignette * smoothstep(0.18, 0.62, r2);
  col *= vig;

  // fine grain — animated, kills the dark-sky banding at DPR 3
  col += (hash12(uv * vec2(1917.0, 2357.0) + fract(u_time) * 7.31) - 0.5) * u_grain;

  o_color = vec4(col, 1.0);
}`

const COMPOSITE_WGSL = `
struct Params {
  u_bloomGain : f32,
  u_vignette : f32,
  u_grain : f32,
  u_time : f32,
}
@group(0) @binding(0) var<uniform> params : Params;
@group(1) @binding(0) var texSampler : sampler;
@group(1) @binding(1) var texTexture : texture_2d<f32>;
@group(1) @binding(2) var texTexture2 : texture_2d<f32>;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
}

@vertex
fn vsMain(@location(0) a_pos : vec2<f32>) -> VSOut {
  var out : VSOut;
  out.pos = vec4<f32>(a_pos, 0.0, 1.0);
  out.uv = a_pos * 0.5 + vec2<f32>(0.5, 0.5);
  return out;
}

fn hash12(p : vec2<f32>) -> f32 {
  var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
  p3 = p3 + vec3<f32>(dot(p3, p3.yzx + vec3<f32>(33.33)));
  return fract((p3.x + p3.y) * p3.z);
}

@fragment
fn fsMain(frag : VSOut) -> @location(0) vec4<f32> {
  let uv = frag.uv;
  let fromC = uv - vec2<f32>(0.5, 0.5);
  let r2 = dot(fromC, fromC);

  let ca = 0.0022 * r2;
  var scene : vec3<f32>;
  scene.r = textureSample(texTexture, texSampler, uv + fromC * ca).r;
  scene.g = textureSample(texTexture, texSampler, uv).g;
  scene.b = textureSample(texTexture, texSampler, uv - fromC * ca).b;

  let bloom = textureSample(texTexture2, texSampler, uv).rgb * params.u_bloomGain;
  var col = scene + bloom * (vec3<f32>(1.0) - scene * 0.35);

  // a HIGHLIGHT-COMPRESSION curve (1.0 → 0.85, darks untouched)
  col = col / (vec3<f32>(1.0) + col * 0.25) * 1.06;

  let vig = 1.0 - params.u_vignette * smoothstep(0.18, 0.62, r2);
  col = col * vig;

  col = col + vec3<f32>((hash12(uv * vec2<f32>(1917.0, 2357.0) + fract(params.u_time) * 7.31) - 0.5) * params.u_grain);

  return vec4<f32>(col, 1.0);
}`

// the clip-space quad (shared by the composite command)
const POST_QUAD = new Float32Array([
  -1, -1, 1, -1, 1, 1,
  -1, -1, 1, 1, -1, 1,
])

// ─── the WGSL sources exposed for THE GATE (task169-wgsl-gate) ───────────────
// The pass fragments are FRAGMENTS (the runtime prepends its own pass
// vertex, packages/gl surface.ts PASS_VERT_WGSL). The gate compiles whole
// modules, so these exports carry a MIRROR of that vertex boilerplate —
// if surface.ts' pass vertex ever changes shape, this mirror must follow
// (it has been stable since Task 112; the composite below is a full module
// of its own and needs no mirror).
const POST_PASS_VERT_WGSL_MIRROR = `
struct RunePassVsOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) coord : vec2<f32>,
}

@vertex
fn vsMain(@location(0) position : vec2<f32>, @location(1) uv : vec2<f32>) -> RunePassVsOut {
  var out : RunePassVsOut;
  out.pos = vec4<f32>(position, 0.0, 1.0);
  out.coord = uv;
  return out;
}
`

/** The gate's compile set: every WGSL module the post chain can build. */
export const postWgslShaders = {
  postThresh: { wgsl: POST_PASS_VERT_WGSL_MIRROR + THRESH_WGSL },
  postBlur: { wgsl: POST_PASS_VERT_WGSL_MIRROR + BLUR_WGSL },
  postComposite: { wgsl: COMPOSITE_WGSL },
}

/**
 * Build the post chain for the ACTIVE backend.
 * @param renderer the booted renderer (after .start())
 * @returns {{ sceneTarget(): {capture: (cmd: any, clear?: boolean) => any, texture: any}, draw(record: any): void, dispose(): void }}
 */
export function createPostChain(renderer) {
  const isGL = renderer.backend === 'webgl2'
  let chain = null
  let builtW = 0
  let builtH = 0

  // the pass-input key: GLSL samplers read u_tex, WGSL vars read
  // texTexture — ONE key per backend (the WG pass API rejects a second)
  const passInputs = (tex) => (isGL ? { u_tex: tex } : { texTexture: tex })

  function build(w, h) {
    builtW = w
    builtH = h
    const qw = Math.max(1, w >> 2)
    const qh = Math.max(1, h >> 2)
    const voidColor = [0.008, 0.011, 0.02, 1] // main.js's renderer clear — matched

    // ── the surfaces ──
    const sceneSurf = renderer.surface({ width: w, height: h, depth: false, color: voidColor })
    const bloomA = renderer.surface({ width: qw, height: qh, depth: false, color: [0, 0, 0, 1] })
    const bloomB = renderer.surface({ width: qw, height: qh, depth: false, color: [0, 0, 0, 1] })

    // ── the single-input passes (backend-branched fragments) ──
    const frag = (glsl, wgsl) => (isGL ? glsl : wgsl)
    const qTexel = [1 / qw, 1 / qh]

    // threshold reads the SCENE, writes bloomA (¼ res) — 0.72: with the
    // Task-172 particle galaxy the disc itself is luminous now; only the
    // star cores / suns / lane pulses / territory sheen ride the bloom —
    // the disc haze, nebulas and the dust arms stay put (the VLM's
    // "blown-out core" read at 0.66: the whole bulge bloomed into a wash)
    const passThresh = bloomA.pass(frag(THRESH_GLSL, THRESH_WGSL), {
      uniforms: { u_thresh: [0.72] },
      inputs: passInputs(sceneSurf.texture),
      clear: true,
    })

    // two blur iterations: tight (×1) then wide (×2.4) — layered glow,
    // alternating targets A → B → A → B → A (the final bloom lives in A)
    const blurH = bloomB.pass(frag(BLUR_GLSL, BLUR_WGSL), {
      uniforms: { u_dir: [qTexel[0], 0] },
      inputs: passInputs(bloomA.texture),
      clear: true,
    })
    const blurV = bloomA.pass(frag(BLUR_GLSL, BLUR_WGSL), {
      uniforms: { u_dir: [0, qTexel[1]] },
      inputs: passInputs(bloomB.texture),
      clear: true,
    })
    const blurH2 = bloomB.pass(frag(BLUR_GLSL, BLUR_WGSL), {
      uniforms: { u_dir: [qTexel[0] * 2.4, 0] },
      inputs: passInputs(bloomA.texture),
      clear: true,
    })
    const blurV2 = bloomA.pass(frag(BLUR_GLSL, BLUR_WGSL), {
      uniforms: { u_dir: [0, qTexel[1] * 2.4] },
      inputs: passInputs(bloomB.texture),
      clear: true,
    })

    // ── the composite: a dual-source command to the canvas ──
    const sceneRef = { textureId: sceneSurf.texture.textureId }
    const bloomRef = { textureId: bloomA.texture.textureId }
    const compositeCmd = renderer.command({
      shader: {
        glsl: { vertex: COMPOSITE_GLSL_VERT, fragment: COMPOSITE_GLSL_FRAG },
        wgsl: COMPOSITE_WGSL,
      },
      pipeline: { depth: false, cull: 'none' },
      attributes: {
        a_pos: { data: POST_QUAD, size: 2, stride: 8, offset: 0 },
      },
      uniforms: {
        u_bloomGain: () => BLOOM_GAIN,
        u_vignette: () => VIGNETTE,
        u_grain: () => GRAIN,
        u_time: () => CLOCK,
      },
      textures: {
        // GL reads by sampler name; WG reads by declared var name
        u_scene: sceneRef,
        u_bloom: bloomRef,
        texTexture: sceneRef,
        texTexture2: bloomRef,
      },
      count: 6,
    })

    return { sceneSurf, bloomA, bloomB, passThresh, blurH, blurV, blurH2, blurV2, composite: toCanvas(compositeCmd) }
  }

  return {
    /** Build/rebuild the chain for a buffer size (idempotent; cheap no-op
     *  when unchanged). Must run BEFORE capture()/recordPost() this frame. */
    ensure(bufW, bufH) {
      if (bufW !== builtW || bufH !== builtH) {
        if (chain !== null) {
          chain.sceneSurf.dispose()
          chain.bloomA.dispose()
          chain.bloomB.dispose()
        }
        chain = build(bufW, bufH)
      }
    },
    /** Capture wrapper: a command re-targeted into the scene surface. */
    capture(command, clear) {
      if (chain === null) throw new Error('astral post: ensure() must run before capture()')
      return captureInto(command, chain.sceneSurf.targetId, clear === true)
    },
    /** Record the post passes (call AFTER the scene records, same frame). */
    recordPost(record) {
      if (chain === null) throw new Error('astral post: ensure() must run before recordPost()')
      record(chain.passThresh, {})
      record(chain.blurH, {})
      record(chain.blurV, {})
      record(chain.blurH2, {})
      record(chain.blurV2, {})
      record(chain.composite, {})
    },
    dispose() {
      if (chain === null) return
      chain.sceneSurf.dispose()
      chain.bloomA.dispose()
      chain.bloomB.dispose()
      chain = null
    },
  }
}
