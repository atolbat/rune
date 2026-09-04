/**
 * @rune/particles — the GPGPU SIMULATION TIER, the WebGL2 TRANSFORM-FEEDBACK
 * twin (Task 132 — see docs/particles-optimization.md Phase 3).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE COMMON POINT: the WebGPU tier runs the simulation as compute passes
 * over a storage buffer (gpuSim.ts — "the SSBO"); WebGL2 has no compute —
 * the SAME simulation runs here as TRANSFORM-FEEDBACK vertex passes over a
 * float texture. One orchestrator (@rune/gl createGpuParticles) drives
 * both: it reads the same facade.gpuHandoff, uploads the same emit rows,
 * and produces the SAME 16-float instance records the BILLBOARD material
 * draws. The parity contract is semantic, not bit-exact (f32 both sides,
 * each backend's own transcendentals) — the same constants, the same force
 * order, the same noise table, the same ramp walk.
 *
 * THE STATE (WebGL2 layout — the texture, not the buffer):
 *   ONE rgba32f texture, a flat texel array W × H. Particle p's 17
 *   FIELD_NAMES floats live at texels [p·5, p·5 + 5) (5 texels = 20 slots,
 *   17 used + 3 pad — the pad keeps every TF row 4-float aligned, the
 *   attribute-offset rule). The flat texel index maps to (x = i % W,
 *   y = i / W). A TF pass streams its 5-vec4 rows into ONE interleaved
 *   buffer whose sequential texel order matches the texture EXACTLY —
 *   texSubImage2DBuffer (the PBO upload) round-trips the state
 *   buffer→texture with zero CPU traffic, the WebGL2 twin of the WebGPU
 *   storage-buffer ping-pong.
 *
 * THE FRAME (two passes + one PBO upload, after facade.advance):
 *   1. the EMIT BLOCK — the newborns' 20-float rows (the handoff's 17-float
 *      rows repacked) texSubImage2D'd into their PRE-COMPACTION texel
 *      range [emitBase·5, (emitBase + emitCount)·5);
 *   2. `compactAdvance` — VERTEX i = FINAL slot i: gathers the pre-state
 *      of particle map[i] (a_map — the CPU's provenance, the swap replay
 *      folded into ONE gather), integrates it (the force walk, the exact
 *      WGSL order), writes slot i. The WGSL tier's compact + advance
 *      merged: the compact is a pure permutation of the pre-state and the
 *      advance is per-particle independent — composing them in one gather
 *      pass is the same result, one pass cheaper;
 *   3. the PBO upload — the TF output becomes the new state texture;
 *   4. `pack` — VERTEX i = gl_VertexID: the state of slot i (texelFetch) +
 *      the ramp LUT texture + the tile math → the SAME 16-float instance
 *      records the CPU packer writes. The records buffer is the DRAW's
 *      instance-attribute source (bufferId + stride 64 + divisor 1).
 *
 * THE READBACK-FREE SPLIT: identical to the WebGPU tier — the CPU mirrors
 * age/life only (emission, death, compaction); the positions/velocities
 * are GPU-authoritative. The map (the provenance) is computed CPU-side
 * from the handoff's swap list — the CPU never reads the GPU state.
 *
 * THE MAP (a_map): a float attribute (float32 holds integers exactly to
 * 2^24 — capacity is far below); vertex i gathers pre-slot map[i].
 * ══════════════════════════════════════════════════════════════════════════
 */

import { PERM, GRAD3 } from './noise.ts'

/** The TF state row: 20 floats (17 FIELD_NAMES + 3 pad — vec4-aligned so
 *  the five TF varyings interleave at 4-float attribute offsets). */
export const GPU_GL_STATE_STRIDE = 20

/** Texels per particle in the state texture (20 floats = 5 rgba32f texels). */
export const GPU_GL_TEXELS_PER_PARTICLE = 5

/** The state texture width (a safe power-of-two ≤ the ES3 min MAX_TEXTURE_SIZE
 *  of 2048; the height carries ceil(capacity · 5 / W) rows). */
export const GPU_GL_STATE_TEXTURE_W = 2048

/** The state texture height for a capacity. */
export function gpuGlStateTextureH(capacity: number): number {
  return Math.max(1, Math.ceil((capacity * GPU_GL_TEXELS_PER_PARTICLE) / GPU_GL_STATE_TEXTURE_W))
}

/** The advance pass's uniform declaration (name + component count), packed
 *  in THIS order into the run's uniformData Float32Array. The u_f* gates
 *  are 1.0/0.0 floats (the WGSL forceMask's per-bit twin — GLSL float
 *  uniforms, no int packing). */
export const GPU_GL_ADVANCE_UNIFORMS: readonly { readonly name: string; readonly size: 1 | 2 | 3 | 4 }[] = [
  { name: 'u_dt', size: 1 },
  { name: 'u_gravity', size: 3 },
  { name: 'u_drag', size: 1 },
  { name: 'u_turbulence', size: 1 },
  { name: 'u_attractStrength', size: 1 },
  { name: 'u_softening2', size: 1 },
  { name: 'u_attractPoint', size: 3 },
  { name: 'u_noiseStrength', size: 1 },
  { name: 'u_noiseScale', size: 1 },
  { name: 'u_noiseSpeed', size: 1 },
  { name: 'u_limit', size: 1 },
  { name: 'u_dampen', size: 1 },
  { name: 'u_wrapSize', size: 3 },
  { name: 'u_wrapCenter', size: 3 },
  { name: 'u_fDrag', size: 1 },
  { name: 'u_fLimit', size: 1 },
  { name: 'u_fGravity', size: 1 },
  { name: 'u_fAttract', size: 1 },
  { name: 'u_fTurb', size: 1 },
  { name: 'u_fNoise', size: 1 },
  { name: 'u_fWrap', size: 1 },
]

/** The advance pass's packed-uniform field offsets (FLOAT indices). */
export const GPU_GL_ADVANCE_F: Record<
  'dt' | 'gravity' | 'drag' | 'turbulence' | 'attractStrength' | 'softening2' | 'attractPoint'
  | 'noiseStrength' | 'noiseScale' | 'noiseSpeed' | 'limit' | 'dampen' | 'wrapSize' | 'wrapCenter'
  | 'fDrag' | 'fLimit' | 'fGravity' | 'fAttract' | 'fTurb' | 'fNoise' | 'fWrap', number
> = {
  dt: 0,
  gravity: 1,
  drag: 4,
  turbulence: 5,
  attractStrength: 6,
  softening2: 7,
  attractPoint: 8,
  noiseStrength: 11,
  noiseScale: 12,
  noiseSpeed: 13,
  limit: 14,
  dampen: 15,
  wrapSize: 16,
  wrapCenter: 19,
  fDrag: 22,
  fLimit: 23,
  fGravity: 24,
  fAttract: 25,
  fTurb: 26,
  fNoise: 27,
  fWrap: 28,
}

/** The pack pass's uniform declaration (packed order). */
export const GPU_GL_PACK_UNIFORMS: readonly { readonly name: string; readonly size: 1 | 2 | 3 | 4 }[] = [
  { name: 'u_tileU', size: 1 },
  { name: 'u_tileV', size: 1 },
  { name: 'u_frameJitter', size: 1 },
  { name: 'u_rampN', size: 1 },
]

/** The pack pass's packed-uniform field offsets. */
export const GPU_GL_PACK_F: Record<'tileU' | 'tileV' | 'frameJitter' | 'rampN', number> = {
  tileU: 0,
  tileV: 1,
  frameJitter: 2,
  rampN: 3,
}

/** The TF output declarations: the five 20-float state rows. */
export const GPU_GL_ADVANCE_OUTPUTS = ['v_s0', 'v_s1', 'v_s2', 'v_s3', 'v_s4'] as const

/** The TF output declarations: the four 16-float record rows. */
export const GPU_GL_PACK_OUTPUTS = ['v_r0', 'v_r1', 'v_r2', 'v_r3'] as const

/** The ramp LUT in the GL texture layout: TWO rgba32f texels per control
 *  point — point k's (t, size, r, g) at texel 2k, (b, a, frame, 0) at
 *  texel 2k+1 (a width-2·N, height-1 texture; ≤ 256 points, the same cap
 *  as the WGSL LUT). */
export function gpuRampLUTTexture(points: readonly { t: number; size: number; r: number; g: number; b: number; a: number; frame?: number }[]): Float32Array {
  if (points.length === 0) throw new Error('rune/particles: the GPU sim needs a ramp with at least one point')
  if (points.length > 256) {
    throw new Error(`rune/particles: the GPU sim's ramp is capped at 256 control points (got ${points.length})`)
  }
  const lut = new Float32Array(points.length * 8)
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const b = i * 8
    lut[b] = p.t; lut[b + 1] = p.size
    lut[b + 2] = p.r; lut[b + 3] = p.g
    lut[b + 4] = p.b; lut[b + 5] = p.a
    lut[b + 6] = p.frame ?? 0
  }
  return lut
}

/** The shared GLSL prelude: the precision, the state fetch helpers, the
 *  simplex tables — the SAME PERM/GRAD3 the CPU and the WGSL evaluate. */
function glslPrelude(w: number): string {
  const perm = Array.from(PERM, v => `${v}u`).join(', ')
  const grads: string[] = []
  for (let g = 0; g < 12; g++) {
    grads.push(`vec3(${GRAD3[g * 3]}, ${GRAD3[g * 3 + 1]}, ${GRAD3[g * 3 + 2]})`)
  }
  return `
precision highp float;
uniform highp sampler2D u_state;
const int W = ${w};
ivec2 texelOf(int idx) { return ivec2(idx % W, idx / W); }
vec4 fetchState(int slot, int row) { return texelFetch(u_state, texelOf(slot * 5 + row), 0); }
// ── the simplex noise (the SAME table the CPU/WGSL evaluate — noise.ts) ────
const uint PERM_T[512] = uint[512](${perm});
const vec3 GRAD_T[12] = vec3[12](${grads.join(', ')});
float simplex3(vec3 v) {
  const float F3 = 0.333333333333;
  const float G3 = 0.166666666667;
  float s = (v.x + v.y + v.z) * F3;
  int i = int(floor(v.x + s));
  int j = int(floor(v.y + s));
  int k = int(floor(v.z + s));
  float t = float(i + j + k) * G3;
  float x0 = v.x - (float(i) - t);
  float y0 = v.y - (float(j) - t);
  float z0 = v.z - (float(k) - t);
  int i1 = 0; int j1 = 0; int k1 = 0; int i2 = 0; int j2 = 0; int k2 = 0;
  if (x0 >= y0) {
    if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
    else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
  } else {
    if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
    else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
    else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
  }
  float x1 = x0 - float(i1) + G3; float y1 = y0 - float(j1) + G3; float z1 = z0 - float(k1) + G3;
  float x2 = x0 - float(i2) + 2.0 * G3; float y2 = y0 - float(j2) + 2.0 * G3; float z2 = z0 - float(k2) + 2.0 * G3;
  float x3 = x0 - 1.0 + 3.0 * G3; float y3 = y0 - 1.0 + 3.0 * G3; float z3 = z0 - 1.0 + 3.0 * G3;
  uint ii = uint(i & 255); uint jj = uint(j & 255); uint kk = uint(k & 255);
  float n = 0.0;
  float t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
  if (t0 > 0.0) {
    uint g = PERM_T[ii + PERM_T[jj + PERM_T[kk]]] % 12u;
    t0 = t0 * t0;
    n += t0 * t0 * dot(GRAD_T[g], vec3(x0, y0, z0));
  }
  float t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
  if (t1 > 0.0) {
    uint g = PERM_T[ii + uint(i1) + PERM_T[jj + uint(j1) + PERM_T[kk + uint(k1)]]] % 12u;
    t1 = t1 * t1;
    n += t1 * t1 * dot(GRAD_T[g], vec3(x1, y1, z1));
  }
  float t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
  if (t2 > 0.0) {
    uint g = PERM_T[ii + uint(i2) + PERM_T[jj + uint(j2) + PERM_T[kk + uint(k2)]]] % 12u;
    t2 = t2 * t2;
    n += t2 * t2 * dot(GRAD_T[g], vec3(x2, y2, z2));
  }
  float t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
  if (t3 > 0.0) {
    uint g = PERM_T[ii + 1u + PERM_T[jj + 1u + PERM_T[kk + 1u]]] % 12u;
    t3 = t3 * t3;
    n += t3 * t3 * dot(GRAD_T[g], vec3(x3, y3, z3));
  }
  return 32.0 * n;
}
float wrapAxis(float d, float size) {
  float m = mod(d + size * 0.5, size);
  if (m < 0.0) { m += size; }
  return m - size * 0.5;
}
`
}

/** The compact+advance pass (the WGSL compact + advance merged into one
 *  gather): vertex i = FINAL slot i, the pre-state of particle a_map[i],
 *  the exact WGSL force order (drag → limit → gravity → attract →
 *  turbulence → noise), the integration, age += dt, the wrap. Pure
 *  function of the source — deterministic, cacheable. */
export function gpuSimGlAdvanceGlsl(): string {
  return `#version 300 es
// @rune/particles — the GPGPU TF tier (Task 132): compact+advance, the
// GLSL twin of the WGSL entries. The uniform set mirrors
// GPU_GL_ADVANCE_UNIFORMS (the orchestrator packs them in order).
${glslPrelude(GPU_GL_STATE_TEXTURE_W)}
uniform float u_dt;
uniform vec3 u_gravity;
uniform float u_drag;
uniform float u_turbulence;
uniform float u_attractStrength;
uniform float u_softening2;
uniform vec3 u_attractPoint;
uniform float u_noiseStrength;
uniform float u_noiseScale;
uniform float u_noiseSpeed;
uniform float u_limit;
uniform float u_dampen;
uniform vec3 u_wrapSize;
uniform vec3 u_wrapCenter;
uniform float u_fDrag;
uniform float u_fLimit;
uniform float u_fGravity;
uniform float u_fAttract;
uniform float u_fTurb;
uniform float u_fNoise;
uniform float u_fWrap;
// the provenance: vertex i (the FINAL slot) gathers the pre-state of
// particle a_map[i] (a float — exact for every integer ≤ 2^24).
in float a_map;
// the TF outputs: the 20-float state row (17 fields + 3 pad).
out vec4 v_s0; // px, py, pz, vx
out vec4 v_s1; // vy, vz, age, life
out vec4 v_s2; // size, cr, cg, cb
out vec4 v_s3; // ca, seed, tx, ty
out vec4 v_s4; // tz, pad, pad, pad
void main() {
  int src = int(a_map + 0.5);
  vec4 s0 = fetchState(src, 0);
  vec4 s1 = fetchState(src, 1);
  vec4 s2 = fetchState(src, 2);
  vec4 s3 = fetchState(src, 3);
  vec4 s4 = fetchState(src, 4);
  float px = s0.x; float py = s0.y; float pz = s0.z;
  float vx = s0.w; float vy = s1.x; float vz = s1.y;
  float age = s1.z;
  float seed = s3.y;
  // the force walk — the WGSL advance's exact order
  if (u_fDrag > 0.5) {
    float k = exp(-u_drag * u_dt);
    vx *= k; vy *= k; vz *= k;
  }
  if (u_fLimit > 0.5) {
    float speed = sqrt(vx * vx + vy * vy + vz * vz);
    if (speed > u_limit && speed > 1e-9) {
      float k = 1.0 - ((speed - u_limit) / speed) * u_dampen * u_dt * 20.0;
      if (k < 0.0) { k = 0.0; }
      vx *= k; vy *= k; vz *= k;
    }
  }
  if (u_fGravity > 0.5) {
    vx += u_gravity.x * u_dt;
    vy += u_gravity.y * u_dt;
    vz += u_gravity.z * u_dt;
  }
  if (u_fAttract > 0.5) {
    float dx = u_attractPoint.x - px;
    float dy = u_attractPoint.y - py;
    float dz = u_attractPoint.z - pz;
    float r2 = dx * dx + dy * dy + dz * dz;
    float r = sqrt(r2);
    if (r > 1e-6) {
      float k = u_attractStrength * u_dt / (r * (r2 + u_softening2));
      vx += dx * k; vy += dy * k; vz += dz * k;
    }
  }
  if (u_fTurb > 0.5) {
    float t = age * 5.0 + seed * 37.0;
    vx += sin(t) * u_turbulence * u_dt;
    vy += sin(t * 1.7 + 11.3) * u_turbulence * u_dt;
    vz += cos(t * 0.9 + 4.7) * u_turbulence * u_dt;
  }
  if (u_fNoise > 0.5) {
    // the simplex flow — the CPU/WGSL reference's exact coordinate mapping
    float adrift = age * u_noiseSpeed;
    float so = seed * 13.7;
    float sx = px * u_noiseScale + adrift;
    float sy = py * u_noiseScale;
    float sz = pz * u_noiseScale;
    vx += simplex3(vec3(sx, sy + so, sz + 5.3)) * u_noiseStrength * u_dt;
    vy += simplex3(vec3(sx + 11.7, sy + adrift, sz + 9.1 + so)) * u_noiseStrength * u_dt;
    vz += simplex3(vec3(sx + 3.1, sy + 7.7 + so, sz + adrift)) * u_noiseStrength * u_dt;
  }
  px += vx * u_dt; py += vy * u_dt; pz += vz * u_dt;
  if (u_fWrap > 0.5) {
    if (u_wrapSize.x > 0.0) { px = u_wrapCenter.x + wrapAxis(px - u_wrapCenter.x, u_wrapSize.x); }
    if (u_wrapSize.y > 0.0) { py = u_wrapCenter.y + wrapAxis(py - u_wrapCenter.y, u_wrapSize.y); }
    if (u_wrapSize.z > 0.0) { pz = u_wrapCenter.z + wrapAxis(pz - u_wrapCenter.z, u_wrapSize.z); }
  }
  v_s0 = vec4(px, py, pz, vx);
  v_s1 = vec4(vy, vz, age + u_dt, s1.w);
  v_s2 = s2;
  v_s3 = s3;
  v_s4 = s4;
  gl_Position = vec4(0.0, 0.0, 0.5, 1.0); // never rasterized (discard on)
}
`
}

/** The pack pass: vertex i = gl_VertexID — the state of slot i + the ramp
 *  LUT texture + the tile math → the 16-float instance records (the
 *  INSTANCE_LAYOUT contract, the WGSL pack's twin). */
export function gpuSimGlPackGlsl(): string {
  return `#version 300 es
// @rune/particles — the GPGPU TF tier (Task 132): the record pack, the
// GLSL twin of the WGSL pack entry. The uniform set mirrors
// GPU_GL_PACK_UNIFORMS.
${glslPrelude(GPU_GL_STATE_TEXTURE_W)}
uniform highp sampler2D u_ramp;
uniform float u_tileU;
uniform float u_tileV;
uniform float u_frameJitter;
uniform float u_rampN;
// the TF outputs: the 16-float instance record (INSTANCE_LAYOUT).
out vec4 v_r0; // px, py, pz, vx
out vec4 v_r1; // vy, vz, cr, cg
out vec4 v_r2; // cb, ca, halfExtent, angle0 (seed·tau)
out vec4 v_r3; // age, seed, u0, v0
// the ramp LUT: 2 texels per point k — (t, size, r, g) at 2k, (b, a, frame, 0) at 2k+1.
vec4 rampA(int k) { return texelFetch(u_ramp, ivec2(k * 2, 0), 0); }
vec4 rampB(int k) { return texelFetch(u_ramp, ivec2(k * 2 + 1, 0), 0); }
float rampT(int k) { return rampA(k).x; }
void main() {
  int i = gl_VertexID;
  vec4 s0 = fetchState(i, 0);
  vec4 s1 = fetchState(i, 1);
  vec4 s2 = fetchState(i, 2);
  vec4 s3 = fetchState(i, 3);
  float age = s1.z;
  float life = s1.w;
  float t = life > 0.0 ? age / life : 0.0;
  // the ramp walk — the WGSL pack's exact semantics: clamp → binary
  // search → lerp (sampleRamp's own walk).
  int n = int(u_rampN + 0.5);
  float size = 1.0; float r = 1.0; float g = 1.0; float b = 1.0; float a = 1.0; float frame = 0.0;
  if (n == 1 || t <= rampT(0)) {
    vec4 ra = rampA(0); vec4 rb = rampB(0);
    size = ra.y; r = ra.z; g = ra.w; b = rb.x; a = rb.y; frame = rb.z;
  } else {
    int last = n - 1;
    if (t >= rampT(last)) {
      vec4 ra = rampA(last); vec4 rb = rampB(last);
      size = ra.y; r = ra.z; g = ra.w; b = rb.x; a = rb.y; frame = rb.z;
    } else {
      int lo = 0; int hi = n - 1;
      for (int guard = 0; guard < 32 && hi - lo > 1; guard++) {
        int mid = (lo + hi) / 2;
        if (rampT(mid) <= t) { lo = mid; } else { hi = mid; }
      }
      float span = rampT(hi) - rampT(lo);
      float k = span > 0.0 ? (t - rampT(lo)) / span : 0.0;
      vec4 raLo = rampA(lo); vec4 rbLo = rampB(lo);
      vec4 raHi = rampA(hi); vec4 rbHi = rampB(hi);
      size = mix(raLo.y, raHi.y, k);
      r = mix(raLo.z, raHi.z, k);
      g = mix(raLo.w, raHi.w, k);
      b = mix(rbLo.x, rbHi.x, k);
      a = mix(rbLo.y, rbHi.y, k);
      frame = mix(rbLo.z, rbHi.z, k);
    }
  }
  float halfExtent = s2.x * size * 0.5;
  float seed = s3.y;
  // the tile origin: frame + seed·jitter → floor → clamp → row-major
  // (NaN-safe: every NaN comparison is false — !(fr >= 0.0) catches NaN
  // and the negatives in one branch).
  float fr = floor(frame + seed * u_frameJitter);
  if (!(fr >= 0.0)) { fr = 0.0; }
  float maxFrame = u_tileU * u_tileV - 1.0;
  if (fr > maxFrame) { fr = maxFrame; }
  float u0 = 0.0; float v0 = 0.0;
  if (u_tileU >= 1.0 && u_tileV >= 1.0) {
    u0 = mod(fr, u_tileU) / u_tileU;
    v0 = floor(fr / u_tileU) / u_tileV;
  }
  v_r0 = s0;
  v_r1 = vec4(s1.x, s1.y, s2.y * r, s2.z * g);
  v_r2 = vec4(s2.w * b, s3.x * a, halfExtent, seed * 6.283185307179586);
  v_r3 = vec4(age, seed, u0, v0);
  gl_Position = vec4(0.0, 0.0, 0.5, 1.0); // never rasterized (discard on)
}
`
}
