/**
 * @rune/particles — the GPGPU SIMULATION TIER (Task 131, Phase 2 of the
 * optimization program: see docs/particles-optimization.md).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE ARCHITECTURE (WebGPU compute; WebGL2 keeps the CPU tier — the parity
 * contract: the DEMOS default to sim:'cpu' (bit-identical on both
 * backends); the GPU tier is an opt-in power tier, never a stub):
 *
 *   THE STATE — the SoA fields, INTERLEAVED as FIELD_NAMES rows (17 floats
 *     per particle) in ONE storage buffer (the "SSBO"). The CPU facade
 *     keeps the count/age/life (emission, death, compaction); the
 *     position/velocity live GPU-authoritative (the CPU mirror holds the
 *     emission scratch only).
 *
 *   THE FRAME (the tier controller's step(), after facade.advance —
 *     Task 133: the controller is @rune/core's createGpgpu; @rune/gl's
 *     createGpuParticles binds the particles facade to it):
 *     1. upload the EMIT BLOCK — the new particles' rows at their
 *        PRE-COMPACTION slots [emitBase, emitBase + emitCount);
 *     2. dispatch `compact` — replays the CPU's swap-remove list (to,
 *        from) pairs IN ORDER: the same moves on the same data = the
 *        exact CPU compaction, bit-for-bit in structure;
 *     3. dispatch `advance` — the force walk (gravity/drag/turbulence/
 *        attract/noise/limit — the reference order) + the integration +
 *        age += dt (f32) + the wrap volume;
 *     4. dispatch `pack` — the SAME 16-float instance records the CPU
 *        packer writes (packInstances), GPU-side: the ramp LUT (the 7-
 *        float rows), the tile math, the record fields. The render pass
 *        binds this buffer as the BILLBOARD material's instance source —
 *        ZERO per-frame CPU→GPU particle traffic.
 *
 *   THE READBACK-FREE SPLIT: the CPU never reads the GPU state. Death is
 *     decided by the CPU's own age/life mirror (the CPU integrates age in
 *     f64 — the GPU's f32 age only feeds the ramp's t); the swap list is
 *     collected by the facade's onSwap hook (the existing trails seam).
 *
 * THE WGSL CONTRACT (the fixed five-binding compute layout of
 *   @rune/webgpu's createCompute):
 *     @group(0) @binding(0) — SimParams (uniform, 144 bytes)
 *     @binding(1) — the state  (read_write storage, 17 × capacity floats)
 *     @binding(2) — the swaps  (read storage, vec2<u32> pairs)
 *     @binding(3) — the records (read_write storage, 16 × capacity floats)
 *     @binding(4) — the ramp LUT (read storage, 7-float rows)
 *
 *   forceMask bits: 1 gravity · 2 drag · 4 turbulence · 8 attract ·
 *   16 noise · 32 limitSpeed · 64 wrap.
 *
 * PARITY: the tier is NOT bit-identical to the CPU sim (f32 vs f64, the
 *   GPU's own transcendental implementations) — it is the same SEMANTICS
 *   (the same force order, the same constants, the same noise table). The
 *   raw-device probe (scripts/task131-wgsl-sim.mjs) pins the GPU state
 *   against the CPU reference within f32 tolerance.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { PERM, GRAD3 } from './noise.ts'
import { FIELD_NAMES } from './system.ts'

/** The interleaved state stride (FIELD_NAMES.length — 17 floats/particle). */
export const GPU_STATE_STRIDE = FIELD_NAMES.length

/** The uniform byte layout (SimParams in the WGSL below — the orchestrator
 *  writes through a Float32Array/Uint32Array pair over one buffer). */
export const GPU_SIM_UNIFORM_BYTES = 144
/** The uniform's FLOAT count. */
export const GPU_SIM_UNIFORM_FLOATS = GPU_SIM_UNIFORM_BYTES / 4

/** The u32 fields of SimParams (their FLOAT indices — write via a
 *  Uint32Array view over the same buffer). */
export const GPU_SIM_U32_FIELDS: Record<'count' | 'swapCount' | 'forceMask', number> = {
  // FLOAT indices into the 36-float uniform (byte / 4). forceMask sits
  // AFTER the two trailing vec4s: float 32 = byte 128.
  count: 0,
  swapCount: 2,
  forceMask: 32,
}

/** The f32 fields (their FLOAT indices in the uniform). */
export const GPU_SIM_F32_FIELDS: Record<
  'dt' | 'drag' | 'turbulence' | 'attractStrength' | 'softening2' | 'noiseStrength'
  | 'noiseScale' | 'noiseSpeed' | 'limit' | 'dampen' | 'frameJitter' | 'tileU' | 'tileV', number
> = {
  dt: 1,
  drag: 8,
  turbulence: 9,
  attractStrength: 10,
  softening2: 11,
  noiseStrength: 16,
  noiseScale: 17,
  noiseSpeed: 18,
  limit: 19,
  dampen: 20,
  frameJitter: 21,
  tileU: 22,
  tileV: 23,
}

/** The vec4 fields (their FLOAT base indices — xyz used, w padding). */
export const GPU_SIM_VEC4_FIELDS: Record<'gravity' | 'attractPoint' | 'wrapSize' | 'wrapCenter', number> = {
  gravity: 4,
  attractPoint: 12,
  wrapSize: 24,
  wrapCenter: 28,
}

/** The force-mask bits (the uniform's forceMask field). */
export const GPU_FORCE_MASK = {
  gravity: 1,
  drag: 2,
  turbulence: 4,
  attract: 8,
  noise: 16,
  limitSpeed: 32,
  wrap: 64,
} as const

/** The ramp LUT row (7 floats: t, size, r, g, b, a, frame) — the flat
 *  form of a Ramp, f32-rounded for the GPU. Capped at 256 points (a
 *  longer table is a validation error in the GPU tier). */
export function gpuRampLUT(points: readonly { t: number; size: number; r: number; g: number; b: number; a: number; frame?: number }[]): Float32Array {
  if (points.length === 0) throw new Error('rune/particles: the GPU sim needs a ramp with at least one point')
  if (points.length > 256) {
    throw new Error(`rune/particles: the GPU sim's ramp is capped at 256 control points (got ${points.length})`)
  }
  const lut = new Float32Array(points.length * 7)
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const b = i * 7
    lut[b] = p.t; lut[b + 1] = p.size
    lut[b + 2] = p.r; lut[b + 3] = p.g; lut[b + 4] = p.b; lut[b + 5] = p.a
    lut[b + 6] = p.frame ?? 0
  }
  return lut
}

/** The three compute entries (dispatch names). */
export const GPU_SIM_ENTRIES = ['compact', 'advance', 'pack'] as const

// ─── Task 134 — THE GPU RENDER TIER: the bitonic sort + the frustum cull ───

/** The sort/cull family's uniform FLOAT count (SortParams in the WGSL below
 *  — the family is a SECOND compute kernel over the SAME four buffers; its
 *  uniform is PASS-INVARIANT: count/padN/renderMask, the camera forward,
 *  the six frustum planes, the pack passthrough. The network's (k, j)
 *  rides the RECORDS buffer's head instead of the uniform — the frame's
 *  compute dispatches share ONE encoder, and queue.writeBuffer lands
 *  before every dispatch in it (a per-pass uniform would collapse to the
 *  LAST write — the self-driving network is the fix; see sortStep). */
export const GPU_SORT_UNIFORM_FLOATS = 36

/** The u32 fields of SortParams (their FLOAT indices — write via the u32
 *  view of the same scratch). */
export const GPU_SORT_U32_FIELDS: Record<'count' | 'padN' | 'renderMask', number> = {
  count: 0,
  padN: 1,
  renderMask: 2,
}

/** The f32/vec4 fields of SortParams (their FLOAT base indices). */
export const GPU_SORT_F32_FIELDS: Record<'forward' | 'planes' | 'tileU' | 'tileV' | 'frameJitter' | 'rampMaxSize', number> = {
  forward: 4,
  /** The six planes' base — 24 consecutive floats (p·4 + 0..3 = n.xyz, d). */
  planes: 8,
  tileU: 32,
  tileV: 33,
  frameJitter: 34,
  rampMaxSize: 35,
}

/** The render-mask bit: 1 — the frustum cull is ON in sortKeys. */
export const GPU_SORT_RENDER_MASK = { cull: 1 } as const

/** The pad/cull key: +1e30 — far above any real |dot(forward, p)|, so the
 *  pads AND the frustum-culled slots sort LAST in the ascending network
 *  (behind every drawn particle, in front of nothing). */
export const GPU_SORT_PAD_KEY = 1e30

/** The pad/cull INDEX sentinel: 2^25 — a float-exact integer greater than
 *  any particle index. A slot whose pair carries it packs the ZERO record
 *  (half extent 0 — the degenerate instance draws nothing). */
export const GPU_SORT_SENTINEL = 33554432

/** The four sort-family entries (dispatch names). */
export const GPU_SORT_ENTRIES = ['sortKeys', 'bitonic', 'sortStep', 'pack'] as const

/** The padded network size: the next power of two ≥ count (the bitonic
 *  network's own requirement — the orchestrator dispatches over [0, padN);
 *  the tail [count, padN) is sentinel pads). ≥ 1: a single live particle
 *  sorts trivially (zero network passes). */
export function gpuSortPadCount(count: number): number {
  if (!Number.isFinite(count) || count < 0) {
    throw new Error(`rune/particles: gpuSortPadCount — count must be a finite number ≥ 0 (got ${count})`)
  }
  if (count <= 1) return 1
  return 1 << Math.ceil(Math.log2(count))
}

/** The canonical bitonic (k, j) sequence for a padded network size —
 *  k = 2 → padN (the block being bitonized), j = k/2 → 1 (the compare
 *  distance): log₂(padN)·(log₂(padN)+1)/2 passes, each ONE dispatch/pass
 *  with its (k, j) in the uniforms. Both orchestrators walk THIS sequence
 *  (the WGSL entry and the GLSL pass evaluate the same (k, j) — the test
 *  suite pins the sequence's MODEL against Array.sort). */
export function gpuSortPassSequence(padN: number, run: (k: number, j: number) => void): void {
  for (let k = 2; k <= padN; k <<= 1) {
    for (let j = k >> 1; j > 0; j >>= 1) run(k, j)
  }
}

/** The ramp's largest size sample — the cull radius factor: every drawn
 *  extent is spawnSize · rampSize · 0.5 ≤ spawnSize · rampMax · 0.5, so the
 *  radius `size · rampMaxSize · 0.5` is conservative (a particle never pops
 *  at the screen edge; it stays until its whole sprite clears the plane). */
export function gpuRampMaxSize(points: readonly { size: number }[]): number {
  let max = 1
  for (const p of points) if (p.size > max) max = p.size
  return max
}

/** The six frustum planes from a COLUMN-MAJOR view-projection (Gribb–
 *  Hartmann: the clip matrix's row3 ± row_i, normalized so the shader's
 *  sphere test dot(n, p) + d > −r carries a real radius). Plane order:
 *  +x, −x, +y, −y, +z, −z (left, right, bottom, top, near, far). The
 *  z pair uses the GL [−1, 1] clip convention — on WebGPU's [0, 1] z this
 *  is CONSERVATIVE (a near/far test may keep a WebGPU-clipped particle —
 *  the rasterizer clips it anyway; no visible particle is ever culled).
 *  Writes into `out` (24 floats) when given — the orchestrators pass their
 *  per-frame scratch (the zero-allocation hot-path contract). */
export function gpuRenderFrustum(viewProj: readonly number[], out?: Float32Array): Float32Array {
  if (viewProj.length !== 16) {
    throw new Error(`rune/particles: gpuRenderFrustum — the view-projection is 16 numbers, column-major (got ${viewProj.length})`)
  }
  const o = out ?? new Float32Array(24)
  const m = viewProj
  for (let p = 0; p < 6; p++) {
    const axis = p >> 1                  // the row the plane cuts: 0 = x, 1 = y, 2 = z
    const sign = (p & 1) === 0 ? 1 : -1  // the + plane, then the − plane
    const nx = m[3] + sign * m[axis]
    const ny = m[7] + sign * m[4 + axis]
    const nz = m[11] + sign * m[8 + axis]
    const d = m[15] + sign * m[12 + axis]
    const len = Math.hypot(nx, ny, nz)
    const inv = len > 1e-12 ? 1 / len : 0
    o[p * 4] = nx * inv
    o[p * 4 + 1] = ny * inv
    o[p * 4 + 2] = nz * inv
    o[p * 4 + 3] = d * inv
  }
  return o
}

/** The pack body shared by BOTH families' pack entries (the sim family's
 *  `pack` and the sort family's `pack`): the ramp LUT walk, the tile math,
 *  the 16-float record writes. Receives `b` (the state row base), `o` (the
 *  record base) and `i` (the record slot) from its wrapper — the sort
 *  family's wrapper derives `b` from the sorted pair instead of the slot. */
const PACK_BODY_WGSL = `
  let age = state[b + 6u];
  let life = state[b + 7u];
  var t = 0.0;
  if (life > 0.0) { t = age / life; }
  // the ramp LUT (7-float rows: t, size, r, g, b, a, frame) — sampleRamp's
  // exact walk: clamp → binary search → lerp
  let n = arrayLength(&rampLUT) / 7u;
  var size = 1.0; var r = 1.0; var g = 1.0; var bl = 1.0; var a = 1.0; var frame = 0.0;
  if (n == 1u) {
    size = rampLUT[1]; r = rampLUT[2]; g = rampLUT[3]; bl = rampLUT[4]; a = rampLUT[5]; frame = rampLUT[6];
  } else if (t <= rampLUT[0]) {
    size = rampLUT[1]; r = rampLUT[2]; g = rampLUT[3]; bl = rampLUT[4]; a = rampLUT[5]; frame = rampLUT[6];
  } else {
    let lastR = (n - 1u) * 7u;
    if (t >= rampLUT[lastR]) {
      size = rampLUT[lastR + 1u]; r = rampLUT[lastR + 2u]; g = rampLUT[lastR + 3u];
      bl = rampLUT[lastR + 4u]; a = rampLUT[lastR + 5u]; frame = rampLUT[lastR + 6u];
    } else {
      var lo = 0u; var hi = n - 1u;
      var guard = 0u;
      while (hi - lo > 1u && guard < 32u) {
        let mid = (lo + hi) >> 1u;
        if (rampLUT[mid * 7u] <= t) { lo = mid; } else { hi = mid; }
        guard++;
      }
      let ra = lo * 7u; let rb = hi * 7u;
      let span = rampLUT[rb] - rampLUT[ra];
      var k = 0.0;
      if (span > 0.0) { k = (t - rampLUT[ra]) / span; }
      size = rampLUT[ra + 1u] + (rampLUT[rb + 1u] - rampLUT[ra + 1u]) * k;
      r = rampLUT[ra + 2u] + (rampLUT[rb + 2u] - rampLUT[ra + 2u]) * k;
      g = rampLUT[ra + 3u] + (rampLUT[rb + 3u] - rampLUT[ra + 3u]) * k;
      bl = rampLUT[ra + 4u] + (rampLUT[rb + 4u] - rampLUT[ra + 4u]) * k;
      a = rampLUT[ra + 5u] + (rampLUT[rb + 5u] - rampLUT[ra + 5u]) * k;
      frame = rampLUT[ra + 6u] + (rampLUT[rb + 6u] - rampLUT[ra + 6u]) * k;
    }
  }
  let half = state[b + 8u] * size * 0.5;
  let seed = state[b + 13u];
  // the tile origin: frame + seed·jitter → floor → clamp → row-major
  var fr = floor(frame + seed * P.frameJitter);
  // NaN-safe: every NaN comparison is FALSE — !(fr >= 0) catches NaN and
  // the negatives in one branch (WGSL has no isnan builtin)
  if (!(fr >= 0.0)) { fr = 0.0; }
  let maxFrame = P.tileU * P.tileV - 1.0;
  if (fr > maxFrame) { fr = maxFrame; }
  var u0 = 0.0; var v0 = 0.0;
  if (P.tileU >= 1.0 && P.tileV >= 1.0) {
    u0 = (fr % P.tileU) / P.tileU;
    v0 = floor(fr / P.tileU) / P.tileV;
  }
  records[o] = state[b]; records[o + 1u] = state[b + 1u]; records[o + 2u] = state[b + 2u];
  records[o + 3u] = state[b + 3u]; records[o + 4u] = state[b + 4u]; records[o + 5u] = state[b + 5u];
  records[o + 6u] = state[b + 9u] * r; records[o + 7u] = state[b + 10u] * g;
  records[o + 8u] = state[b + 11u] * bl; records[o + 9u] = state[b + 12u] * a;
  records[o + 10u] = half;
  records[o + 11u] = seed * 6.283185307179586;
  records[o + 12u] = age;
  records[o + 13u] = seed;
  records[o + 14u] = u0; records[o + 15u] = v0;
`

/** The full WGSL module (the three entries + the fixed binding contract).
 *  Pure function — deterministic source, cacheable by the caller. */
export function gpuSimWgsl(): string {
  const perm = Array.from(PERM, v => `${v}u`).join(', ')
  const grads: string[] = []
  for (let g = 0; g < 12; g++) {
    grads.push(`vec3<f32>(${GRAD3[g * 3]}, ${GRAD3[g * 3 + 1]}, ${GRAD3[g * 3 + 2]})`)
  }
  return `
// @rune/particles — the GPGPU sim tier (Task 131). The state: the FIELD_NAMES
// rows interleaved (17 floats). The entries: compact (the swap replay),
// advance (the force walk), pack (the instance records).
// The uniform layout mirrors GPU_SIM_* in gpuSim.ts (144 bytes).

struct SimParams {
  count : u32,
  dt : f32,
  swapCount : u32,
  _pad0 : u32,
  gravity : vec4<f32>,
  drag : f32,
  turbulence : f32,
  attractStrength : f32,
  softening2 : f32,
  attractPoint : vec4<f32>,
  noiseStrength : f32,
  noiseScale : f32,
  noiseSpeed : f32,
  limit : f32,
  dampen : f32,
  frameJitter : f32,
  tileU : f32,
  tileV : f32,
  wrapSize : vec4<f32>,
  wrapCenter : vec4<f32>,
  forceMask : u32,
  _pad1 : u32,
  _pad2 : u32,
  _pad3 : u32,
}

@group(0) @binding(0) var<uniform> P : SimParams;
@group(0) @binding(1) var<storage, read_write> state : array<f32>;
@group(0) @binding(2) var<storage, read> swaps : array<vec2<u32>>;
@group(0) @binding(3) var<storage, read_write> records : array<f32>;
@group(0) @binding(4) var<storage, read> rampLUT : array<f32>;

const FSTRIDE : u32 = ${GPU_STATE_STRIDE}u;
const RSTRIDE : u32 = 16u;

// ── the simplex noise (the SAME table the CPU evaluates — noise.ts) ────────
var<private> SIM_PERM : array<u32, 512> = array<u32, 512>(${perm});
var<private> SIM_GRADS : array<vec3<f32>, 12> = array<vec3<f32>, 12>(${grads.join(', ')});

fn simplex3(v : vec3<f32>) -> f32 {
  let F3 = 0.333333333333;
  let G3 = 0.166666666667;
  let s = (v.x + v.y + v.z) * F3;
  let i = i32(floor(v.x + s));
  let j = i32(floor(v.y + s));
  let k = i32(floor(v.z + s));
  let t = f32(i + j + k) * G3;
  let x0 = v.x - (f32(i) - t);
  let y0 = v.y - (f32(j) - t);
  let z0 = v.z - (f32(k) - t);
  // the simplex containing (x0, y0, z0): the offset ranking
  var i1 = 0; var j1 = 0; var k1 = 0; var i2 = 0; var j2 = 0; var k2 = 0;
  if (x0 >= y0) {
    if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
    else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
  } else {
    if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
    else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
    else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
  }
  let x1 = x0 - f32(i1) + G3; let y1 = y0 - f32(j1) + G3; let z1 = z0 - f32(k1) + G3;
  let x2 = x0 - f32(i2) + 2.0 * G3; let y2 = y0 - f32(j2) + 2.0 * G3; let z2 = z0 - f32(k2) + 2.0 * G3;
  let x3 = x0 - 1.0 + 3.0 * G3; let y3 = y0 - 1.0 + 3.0 * G3; let z3 = z0 - 1.0 + 3.0 * G3;
  let ii = u32(i & 255); let jj = u32(j & 255); let kk = u32(k & 255);
  var n = 0.0;
  var t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
  if (t0 > 0.0) {
    let g = SIM_PERM[ii + SIM_PERM[jj + SIM_PERM[kk]]] % 12u;
    t0 = t0 * t0;
    n += t0 * t0 * dot(SIM_GRADS[g], vec3<f32>(x0, y0, z0));
  }
  var t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
  if (t1 > 0.0) {
    let g = SIM_PERM[ii + u32(i1) + SIM_PERM[jj + u32(j1) + SIM_PERM[kk + u32(k1)]]] % 12u;
    t1 = t1 * t1;
    n += t1 * t1 * dot(SIM_GRADS[g], vec3<f32>(x1, y1, z1));
  }
  var t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
  if (t2 > 0.0) {
    let g = SIM_PERM[ii + u32(i2) + SIM_PERM[jj + u32(j2) + SIM_PERM[kk + u32(k2)]]] % 12u;
    t2 = t2 * t2;
    n += t2 * t2 * dot(SIM_GRADS[g], vec3<f32>(x2, y2, z2));
  }
  var t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
  if (t3 > 0.0) {
    let g = SIM_PERM[ii + 1u + SIM_PERM[jj + 1u + SIM_PERM[kk + 1u]]] % 12u;
    t3 = t3 * t3;
    n += t3 * t3 * dot(SIM_GRADS[g], vec3<f32>(x3, y3, z3));
  }
  return 32.0 * n;
}

fn wrapAxis(d : f32, size : f32) -> f32 {
  var m = (d + size * 0.5) % size;
  if (m < 0.0) { m += size; }
  return m - size * 0.5;
}

// ── compact: the CPU's swap list, replayed IN ORDER (a single thread — the
// list is per-frame deaths, tens; the order is the CPU compaction's own) ────
@compute @workgroup_size(1)
fn compact(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x != 0u) { return; }
  for (var s = 0u; s < P.swapCount; s++) {
    let pair = swaps[s];
    let dstSlot = pair.x * FSTRIDE;
    let srcSlot = pair.y * FSTRIDE; // 'from' is a RESERVED WGSL keyword
    for (var f = 0u; f < FSTRIDE; f++) {
      state[dstSlot + f] = state[srcSlot + f];
    }
  }
}

// ── advance: the force walk (the reference order: drag → limit → gravity →
// attract → turbulence → noise), the integration, age += dt, the wrap ──────
@compute @workgroup_size(64)
fn advance(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= P.count) { return; }
  let b = i * FSTRIDE;
  var px = state[b]; var py = state[b + 1u]; var pz = state[b + 2u];
  var vx = state[b + 3u]; var vy = state[b + 4u]; var vz = state[b + 5u];
  let age = state[b + 6u];
  let seed = state[b + 13u];
  if ((P.forceMask & 2u) != 0u) {
    let k = exp(-P.drag * P.dt);
    vx *= k; vy *= k; vz *= k;
  }
  if ((P.forceMask & 32u) != 0u) {
    let speed = sqrt(vx * vx + vy * vy + vz * vz);
    if (speed > P.limit && speed > 1e-9) {
      var k = 1.0 - ((speed - P.limit) / speed) * P.dampen * P.dt * 20.0;
      if (k < 0.0) { k = 0.0; }
      vx *= k; vy *= k; vz *= k;
    }
  }
  if ((P.forceMask & 1u) != 0u) {
    vx += P.gravity.x * P.dt;
    vy += P.gravity.y * P.dt;
    vz += P.gravity.z * P.dt;
  }
  if ((P.forceMask & 8u) != 0u) {
    let dx = P.attractPoint.x - px;
    let dy = P.attractPoint.y - py;
    let dz = P.attractPoint.z - pz;
    let r2 = dx * dx + dy * dy + dz * dz;
    let r = sqrt(r2);
    if (r > 1e-6) {
      let k = P.attractStrength * P.dt / (r * (r2 + P.softening2));
      vx += dx * k; vy += dy * k; vz += dz * k;
    }
  }
  if ((P.forceMask & 4u) != 0u) {
    let t = age * 5.0 + seed * 37.0;
    vx += sin(t) * P.turbulence * P.dt;
    vy += sin(t * 1.7 + 11.3) * P.turbulence * P.dt;
    vz += cos(t * 0.9 + 4.7) * P.turbulence * P.dt;
  }
  if ((P.forceMask & 16u) != 0u) {
    // the simplex flow — the CPU reference's exact coordinate mapping
    let adrift = age * P.noiseSpeed;
    let so = seed * 13.7;
    let sx = px * P.noiseScale + adrift;
    let sy = py * P.noiseScale;
    let sz = pz * P.noiseScale;
    vx += simplex3(vec3<f32>(sx, sy + so, sz + 5.3)) * P.noiseStrength * P.dt;
    vy += simplex3(vec3<f32>(sx + 11.7, sy + adrift, sz + 9.1 + so)) * P.noiseStrength * P.dt;
    vz += simplex3(vec3<f32>(sx + 3.1, sy + 7.7 + so, sz + adrift)) * P.noiseStrength * P.dt;
  }
  px += vx * P.dt; py += vy * P.dt; pz += vz * P.dt;
  if ((P.forceMask & 64u) != 0u) {
    if (P.wrapSize.x > 0.0) { px = P.wrapCenter.x + wrapAxis(px - P.wrapCenter.x, P.wrapSize.x); }
    if (P.wrapSize.y > 0.0) { py = P.wrapCenter.y + wrapAxis(py - P.wrapCenter.y, P.wrapSize.y); }
    if (P.wrapSize.z > 0.0) { pz = P.wrapCenter.z + wrapAxis(pz - P.wrapCenter.z, P.wrapSize.z); }
  }
  state[b] = px; state[b + 1u] = py; state[b + 2u] = pz;
  state[b + 3u] = vx; state[b + 4u] = vy; state[b + 5u] = vz;
  state[b + 6u] = age + P.dt;
}

// ── pack: the 16-float instance records (packInstances' GPU twin — the
// record layout of the BILLBOARD material / INSTANCE_LAYOUT; the body is
// PACK_BODY_WGSL — SHARED with the sort family's sorted pack entry) ──────
@compute @workgroup_size(64)
fn pack(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= P.count) { return; }
  let b = i * FSTRIDE;
  let o = i * RSTRIDE;
${PACK_BODY_WGSL}}
`
}

/** The SORT/CULL family's WGSL module (Task 134 — the GPU render tier): a
 *  SECOND compute kernel over the SAME four external buffers — the bind ids
 *  shift one slot (1 = the pairs (rw), 2 = the state (ro — the render tier
 *  only READS positions), 3 = the records (rw), 4 = the ramp LUT (ro)).
 *  Pure function — deterministic source, cacheable by the caller.
 *
 *  THE ENTRIES:
 *    sortKeys — the (key, index) pairs for [0, padN): the live [0, count)
 *      get the NEGATED depth key (−dot(forward, position) — an ASCENDING
 *      network draws far-to-near, the painter's order); the frustum-culled
 *      and the pads [count, padN) get (PAD_KEY, SENTINEL);
 *    bitonic — ONE compare-exchange of the network: the (k, j) of THIS
 *      pass read from the RECORDS buffer's head (records[0] = k,
 *      records[1] = j — the SELF-DRIVING state: the frame's compute
 *      dispatches share ONE encoder, and a per-pass uniform would
 *      collapse to the LAST queue.writeBuffer — the state in a bound
 *      buffer travels with the dispatches). The LOW thread of each
 *      (i, i^j) pair owns the exchange (the pairs are disjoint per pass —
 *      in-place on the pairs buffer, no cross-thread hazard);
 *    sortStep — the network's clock: ONE thread advances (k, j) to the
 *      next pass of the canonical sequence (j > 1 → (k, j/2); else →
 *      (2k, k); k > padN → done, (0, 0)). The orchestrator dispatches
 *      [bitonic, sortStep] × passCount(padN) — the count of
 *      gpuSortPassSequence's walk (the SAME sequence the GLSL twin takes
 *      through its per-pass uniforms — the WebGL2 facade sets GL uniforms
 *      at pass EXECUTION time, so it can afford the direct form);
 *    pack — the sorted record pack: slot i gathers the state of
 *      pairs[i].y (a SENTINEL index — the ZERO record, a degenerate
 *      instance that draws nothing; the visible prefix [0, V) lands
 *      far-to-near, the sentinel tail [V, count) draws nothing).
 *
 *  THE DIRECTION: an ascending sort over −depth = the FARTHEST FIRST —
 *  the CPU tier's sortDepthBackToFront contract (the depth key
 *  dot(forward, position), descending). Ties: the network is not stable —
 *  equal keys land in an arbitrary order (the CPU tier's total-order
 *  tie-break is a CPU luxury; the GPU parity contract is the same
 *  SEMANTICS, not the same tie order). */
export function gpuSortWgsl(): string {
  return `
// @rune/particles — Task 134: the GPU render tier (the sort/cull family).
// The SAME four buffers as the sim family, one slot shifted: the pairs ride
// binding 1 (rw), the state drops to binding 2 (ro — read only).

struct SortParams {
  count : u32,
  padN : u32,
  renderMask : u32,
  _pad0 : u32,
  forward : vec4<f32>,
  planes : array<vec4<f32>, 6>,
  tileU : f32,
  tileV : f32,
  frameJitter : f32,
  rampMaxSize : f32,
}

@group(0) @binding(0) var<uniform> P : SortParams;
@group(0) @binding(1) var<storage, read_write> pairs : array<vec2<f32>>;
@group(0) @binding(2) var<storage, read> state : array<f32>;
@group(0) @binding(3) var<storage, read_write> records : array<f32>;
@group(0) @binding(4) var<storage, read> rampLUT : array<f32>;

const FSTRIDE : u32 = ${GPU_STATE_STRIDE}u;
const RSTRIDE : u32 = 16u;
const PAD_KEY : f32 = ${GPU_SORT_PAD_KEY};
const SENTINEL : f32 = ${GPU_SORT_SENTINEL}.0;

// ── sortKeys: the (key, index) pairs — the negated depth for the visible
// live, the sentinel pair for the culled and the pads ───────────────────
@compute @workgroup_size(64)
fn sortKeys(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= P.padN) { return; }
  var key = PAD_KEY;
  var idx = SENTINEL;
  if (i < P.count) {
    let b = i * FSTRIDE;
    let px = state[b]; let py = state[b + 1u]; let pz = state[b + 2u];
    var visible = true;
    if ((P.renderMask & 1u) != 0u) {
      // the conservative sphere: spawnSize · rampMax · 0.5 ≥ every drawn
      // extent — a sprite never pops at the screen edge
      let radius = state[b + 8u] * P.rampMaxSize * 0.5;
      for (var pl = 0u; pl < 6u; pl++) {
        let plane = P.planes[pl];
        if (plane.x * px + plane.y * py + plane.z * pz + plane.w <= -radius) {
          visible = false;
        }
      }
    }
    if (visible) {
      key = -(P.forward.x * px + P.forward.y * py + P.forward.z * pz);
      idx = f32(i);
    }
  }
  pairs[i] = vec2<f32>(key, idx);
  // thread 0 seeds the SELF-DRIVING network state: records[0] = k,
  // records[1] = j (the first canonical pass is (2, 1)). The pack entry
  // overwrites the records AFTER the network — the scratch is safe.
  if (i == 0u) {
    records[0] = 2.0;
    records[1] = 1.0;
  }
}

// ── bitonic: ONE compare-exchange — the (k, j) of this pass read from the
// records head (the self-driving state); the low thread of (i, i^j) swaps
// the pair when it violates the block's direction ((i & k) == 0 →
// ascending). The pairs are disjoint per pass — in-place, no hazard ──────
@compute @workgroup_size(64)
fn bitonic(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= P.padN) { return; }
  let k = u32(records[0]);
  let j = u32(records[1]);
  if (k == 0u || k > P.padN) { return; } // done (a defensive no-op)
  let p = i ^ j;
  if (p <= i) { return; }
  let a = pairs[i];
  let b = pairs[p];
  let asc = (i & k) == 0u;
  if ((a.x > b.x) == asc) {
    pairs[i] = b;
    pairs[p] = a;
  }
}

// ── sortStep: the network's clock — ONE thread advances (k, j) to the
// next pass of the canonical sequence: j > 1 → (k, j/2); j == 1 →
// (2k, k); k > padN → done (0, 0). The GLSL twin walks the SAME sequence
// through per-pass uniforms (the GL facade sets them at pass EXECUTION
// time — the batched-encoder collapse is a WebGPU compute shape) ───────
@compute @workgroup_size(1)
fn sortStep(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x != 0u) { return; }
  var k = u32(records[0]);
  var j = u32(records[1]);
  if (k == 0u || k > P.padN) { return; }
  if (j > 1u) {
    j = j >> 1u;
  } else {
    k = k << 1u;
    j = k >> 1u;
  }
  if (k > P.padN) { k = 0u; j = 0u; }
  records[0] = f32(k);
  records[1] = f32(j);
}

// ── pack (the sorted twin): the record of slot i gathers the state of
// pairs[i].y — a SENTINEL writes the zero record (half extent 0, the
// degenerate instance that draws nothing) ───────────────────────────────
@compute @workgroup_size(64)
fn pack(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= P.count) { return; }
  let o = i * RSTRIDE;
  let m = pairs[i].y;
  if (m >= SENTINEL) {
    for (var f = 0u; f < RSTRIDE; f++) { records[o + f] = 0.0; }
    return;
  }
  let b = u32(m) * FSTRIDE;
${PACK_BODY_WGSL}}
`
}
