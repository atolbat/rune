/**
 * Stockham FFT — a kit RECIPE (Task 112).
 *
 * Per the user's decision in Task 112: "FFT must not live in the core. In kit
 * or anywhere else — yes. But there are clearly useful patterns there that
 * can stay in the core".
 * The patterns (halfFloat codec, pingPong, format tiers) moved to @rune/core;
 * the FFT itself is a kit recipe: a pure pass schedule + dual-source chunks
 * (GLSL/WGSL with identical names — see dossier §10.3 "Kit — a library of
 * dual-source chunks and recipes").
 *
 * What lives here:
 *  • fft2dPasses(resolution) — the Stockham 2D-FFT PLAN: 2·log₂N passes
 *    (N/2 horizontal + N/2 vertical), ping-pong parity, subtransform size
 *    2^k. A pure function — backend-agnostic: the caller maps 'a'/'b'/'result'
 *    onto its own textures and binds the shader chunk.
 *  • FFT_GLSL_SUBTRANSFORM / FFT_WGSL_SUBTRANSFORM — the same subtransform
 *    pass in two languages: four complex numbers packed in RGBA
 *    (two sequences transformed simultaneously — as in david.li/waves),
 *    the axis via a uniform (one program for both axes — instead of two
 *    #define variants as in the demo), input via u_input.
 *
 * Pass contract (both backends):
 *   uniforms: u_transformSize (N), u_subtransformSize (2^k), u_horizontal (0|1)
 *   texture:  u_input (RGBA, NEAREST semantics: read at texel centers)
 *   output:   the current render target N×N
 */

/** One FFT pass from the plan. */
export interface FftPass {
  /** Pass index (0 .. 2·log₂N-1). */
  readonly index: number
  /** Axis: the first half — rows (horizontal), the second — columns. */
  readonly axis: 'horizontal' | 'vertical'
  /** Subtransform size 2^k (k = 1..log₂N). */
  readonly subtransformSize: number
  /** Where to READ from: 'a'/'b' — the ping-pong pair, 'spectrum' — the plan input. */
  readonly input: 'spectrum' | 'a' | 'b'
  /** Where to WRITE: 'a'/'b' — the ping-pong pair, 'result' — the final output. */
  readonly output: 'a' | 'b' | 'result'
}

/**
 * Stockham 2D-FFT plan for a resolution×resolution grid (a power of two).
 *
 * Emits the same sequence as the david.li/waves demo loop:
 *   i=0            : spectrum → a
 *   i odd          : a → b
 *   i even (inside): b → a
 *   i=last         : (by parity) a|b → result
 *   at i=iterations/2 the axis switches horizontal → vertical
 *   subtransformSize = 2^((i mod N/2·log₂… see the code) + 1)
 *
 * Example (N=4, 4 passes): [h:2 spec→a] [h:4 a→b] [v:2 b→a] [v:4 a→res].
 */
export function fft2dPasses(resolution: number): readonly FftPass[] {
  if (resolution < 2 || (resolution & (resolution - 1)) !== 0) {
    throw new Error(`fft2dPasses: resolution must be a power of two ≥ 2, got ${resolution}`)
  }
  const logN = Math.round(Math.log2(resolution))
  const iterations = logN * 2
  const half = iterations / 2
  const passes: FftPass[] = []
  for (let i = 0; i < iterations; i++) {
    const axis: FftPass['axis'] = i < half ? 'horizontal' : 'vertical'
    const subtransformSize = Math.pow(2, (i % half) + 1)
    let input: FftPass['input']
    let output: FftPass['output']
    if (i === 0) {
      input = 'spectrum'
      output = 'a'
    } else if (i === iterations - 1) {
      // Parity of (iterations-1) after i=0 (spec→a): odd passes write to b…
      // The last input — by parity: mirrors the demo logic
      // (iterations % 2 === 0 ? PING : PONG) with ping=a, pong=b.
      input = iterations % 2 === 0 ? 'a' : 'b'
      output = 'result'
    } else if (i % 2 === 1) {
      input = 'a'
      output = 'b'
    } else {
      input = 'b'
      output = 'a'
    }
    passes.push({ index: i, axis, subtransformSize, input, output })
  }
  return passes
}

/** GLSL ES 3.00 subtransform pass (fragment). The axis via a uniform:
 *  one program for both axes (the demo uses two #define variants; here —
 *  half the compilations). The fullscreen triangle comes from gl_VertexID
 *  (see fullscreenPass.ts), no vertex buffer needed. */
export const FFT_GLSL_SUBTRANSFORM = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D u_input;
uniform float u_transformSize;
uniform float u_subtransformSize;
uniform float u_horizontal;

out vec4 outColor;

vec2 multiplyComplex(vec2 a, vec2 b) {
  return vec2(a.x * b.x - a.y * b.y, a.y * b.x + a.x * b.y);
}

void main() {
  float index = mix(gl_FragCoord.y, gl_FragCoord.x, u_horizontal) - 0.5;
  float evenIndex = floor(index / u_subtransformSize) * (u_subtransformSize * 0.5)
                  + mod(index, u_subtransformSize * 0.5);

  // transform two complex sequences simultaneously
  float halfN = u_transformSize * 0.5;
  vec2 samplePos = mix(
    vec2(evenIndex + 0.5, gl_FragCoord.y),
    vec2(gl_FragCoord.x, evenIndex + 0.5),
    u_horizontal
  ) / u_transformSize;
  vec4 even = texture(u_input, samplePos);
  vec4 odd = texture(u_input, samplePos + vec2(mix(halfN, 0.0, u_horizontal),
                                               mix(0.0, halfN, u_horizontal)) / u_transformSize);

  float twiddleArgument = -2.0 * 3.14159265359 * (index / u_subtransformSize);
  vec2 twiddle = vec2(cos(twiddleArgument), sin(twiddleArgument));

  outColor = vec4(even.xy + multiplyComplex(twiddle, odd.xy),
                  even.zw + multiplyComplex(twiddle, odd.zw));
}
`

/** WGSL subtransform pass (fragment; the vertex is the fullscreenPass chunk).
 *  textureLoad instead of texture2D: sim passes read exactly at texel
 *  centers (NEAREST semantics bit-for-bit; david.li/waves ports). */
export const FFT_WGSL_SUBTRANSFORM = /* wgsl */ `
struct FftUniforms {
  u: vec4f, // x: transformSize, y: subtransformSize, z: horizontal, w: unused
}

@group(0) @binding(0) var<uniform> uni: FftUniforms;
@group(0) @binding(1) var srcTex: texture_2d<f32>;

fn multiplyComplex(a: vec2f, b: vec2f) -> vec2f {
  return vec2f(a.x * b.x - a.y * b.y, a.y * b.x + a.x * b.y)
}

fn glMod(x: f32, y: f32) -> f32 {
  return x - y * floor(x / y)
}

@fragment
fn fsMain(vout: VsOut) -> @location(0) vec4f {
  let PI = 3.14159265359
  let transformSize = uni.u.x
  let subtransformSize = uni.u.y
  let horizontal = uni.u.z > 0.5

  let index = select(vout.coord.y * transformSize - 0.5, vout.coord.x * transformSize - 0.5, horizontal)
  let evenIndex = floor(index / subtransformSize) * (subtransformSize * 0.5) + glMod(index, subtransformSize * 0.5)

  // transform two complex sequences simultaneously
  let halfN = transformSize * 0.5
  var even: vec4f
  var odd: vec4f
  if (horizontal) {
    even = textureLoad(srcTex, vec2i(evenIndex + 0.5, vout.pos.y), 0)
    odd = textureLoad(srcTex, vec2i(evenIndex + halfN + 0.5, vout.pos.y), 0)
  } else {
    even = textureLoad(srcTex, vec2i(vout.pos.x, evenIndex + 0.5), 0)
    odd = textureLoad(srcTex, vec2i(vout.pos.x, evenIndex + halfN + 0.5), 0)
  }

  let twiddleArgument = -2.0 * PI * (index / subtransformSize)
  let twiddle = vec2f(cos(twiddleArgument), sin(twiddleArgument))

  let outputA = even.xy + multiplyComplex(twiddle, odd.xy)
  let outputB = even.zw + multiplyComplex(twiddle, odd.zw)

  return vec4f(outputA, outputB)
}
`
