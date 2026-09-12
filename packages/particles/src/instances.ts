/**
 * @rune/particles — the INSTANCE RECORDS (Task 131, Phase 1 of the
 * optimization program: the instanced draw path — see
 * docs/particles-optimization.md).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE SPLIT (the grass-field pattern, applied to the dynamic soup):
 *   CPU, per frame — packInstances() writes ONE 36-byte record per live
 *     particle (position, velocity, the ramp-resolved color, the size /
 *     age / seed parameters, the atlas frame): the GPU expands the quad —
 *     ONCE per instance, in the vertex shader (the pre-Task-131 CPU bake
 *     paid ~8.5 ms and 21.6 MiB per 100k where the record pack pays ~1 ms
 *     and 3.6 MiB).
 *   GPU, per frame — the BILLBOARD material feature (@rune/materials)
 *     expands the record into the 4 quad corners from
 *     gl_VertexID / @builtin(vertex_index): all five orientation modes
 *     (camera / vertical / horizontal / stretched / oriented), the spin,
 *     the atlas tile. ONE indexed draw: [0,1,2,0,2,3] × N instances.
 *
 * THE RECORD (Task 183 — THE PACKED TIER: INSTANCE_STRIDE = 9 words, 36
 *   bytes — down from 16 floats / 64; the upload, the GPU-tier record
 *   stores and the per-frame staging traffic all shrink 43.75%):
 *   word 0..2  pos.xyz   — f32, NATIVE (the vertex placement never
 *                          quantizes: a world-position ulp is a visible
 *                          shimmer at 10k+ coordinates)
 *   word 3     age       — f32, NATIVE (the spin advance age×rate must not
 *                          walk: an f16 ulp at 60 s is 0.03125 s — a 9°
 *                          drift at rate 5)
 *   word 4     vel.xy    — 2× f16 (the stretched axis: direction-tolerant)
 *   word 5     vel.z (lo) | halfExtent (hi) — 2× f16 (a 0.05% size error
 *                          is sub-pixel on every realistic sprite)
 *   word 6     color.rg  — 2× f16
 *   word 7     color.ba  — 2× f16 (tint × ramp — the most tolerant fields
 *                          in the record)
 *   word 8     seed (lo, f16) | frame (hi, u16)
 *   DERIVED (shader-side, zero bytes): the spin phase angle0 = seed·τ (the
 *     old word 11 was seed·τ — a pure function of the seed that already
 *     rides word 8); the tile origin u0/v0 = (frame%tileU)/tileU,
 *     floor(frame/tileU)/tileV — EXACT from the u16 frame (an f16 uv would
 *     bleed tile seams at 2^-11; the frame index reconstructs the origin
 *     to the ulp).
 *
 * THE F16 QUANTIZATION CONTRACT (all THREE dialects — this JS packer, the
 *   WGSL pack kernel (pack2x16float behind the domain guards), the GLSL TF
 *   twin — produce IDENTICAL bits; pinned by tests):
 *     NaN → +0 · |v| > 65504 → ±65504 (CLAMP, never ±∞: a clamped velocity
 *     is an absurd-but-well-defined stretched quad, an ∞ one is a NaN
 *     soup through the normalize) · |v| < 2^-14 → ±0 (FLUSH: no subnormal
 *     halves ever enter the stream — the decode is then branch-exact in
 *     every dialect) · otherwise IEEE round-to-nearest-even.
 *
 * THE WORD TRANSPORT: the record buffer is a Float32Array end-to-end (the
 *   facade's soup, the SAB feeds, the GPU tiers' TF buffers) — the packed
 *   words ride as f32 BIT PATTERNS. Both backends bind the words as plain
 *   f32 attributes (the gl/webgpu plumbing is untouched: `size` 4/4/1 at
 *   4-aligned offsets, stride 36) and the shader bitcasts to u32 — vertex
 *   fetch moves raw bits, no float op ever touches them.
 *
 * PARITY CONTRACT (pinned by tests): for the same (store, basis, options),
 *   packInstances() returns EXACTLY fillBillboards()/4 records — the same
 *   zero-size skip rule, the same ramp sampling, the same atlas frame
 *   math — and the BILLBOARD shader's corner expansion reproduces the
 *   fillBillboards vertex math within the f16 tolerance (pos EXACT; vel /
 *   color / half / seed within one f16 rounding; uv EXACT — the u16 frame;
 *   the spin phase to the f32 product ulp). The JS twin in the test suite
 *   is the reference for the GLSL/WGSL port. packInstancesPainter ≡
 *   packInstances(…, order) stays BYTE-identical (both bakers quantize
 *   identically — the Task-177 contract survives the packing unchanged).
 *
 * PERFORMANCE: zero allocations — the out array is caller-owned (the
 *  facade allocates it once at capacity), the ramp scratch is one shared
 *  6-float array. The pack is a straight gather: no trigonometry (the
 *  angles move to the shader), no per-vertex writes.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { sphereOutsideFrustum, RADIX_16BIT_MIN } from '@rune/core'
import type { ParticleSource } from './system.ts'
import { flatRamp, CONSTANT_RAMP, type Ramp } from './ramp.ts'

/** 32-bit words per instance record (Task 183 — see the module header:
 * 9 words / 36 bytes — three f32-attribute slots: rec0/rec1/rec2). */
export const INSTANCE_STRIDE = 9

/** One record field: component count + word offset in the record. */
export interface InstanceField {
  readonly size: number
  readonly offset: number
}

/** The record's WORD-ATTRIBUTE layout — the GPU mapping contract (the
 *  BILLBOARD material feature declares the same names/locations; the
 *  layer command binds `view.vertices` with these sizes/offsets — offsets
 *  are in 32-bit WORDS here; multiply by 4 for bytes):
 *    rec0 (vec4 @ 0) — pos.xyz f32 (native) | age f32 (native)
 *    rec1 (vec4 @ 4) — vel.xy | vel.z+halfExtent | color.rg | color.ba
 *                      (each component: TWO f16 halves bit-packed)
 *    rec2 (float @ 8) — seed (f16, lo half) | atlas frame (u16, hi half)
 *  The shader's unpack preamble (BB_VERT_GLSL/BB_VERT_WGSL) decodes the
 *  halves and DERIVES i_pos/i_vel/i_color/i_par/i_uv0 locals — the
 *  corner-expansion body reads the same names as before. */
export const INSTANCE_LAYOUT: {
  readonly rec0: InstanceField
  readonly rec1: InstanceField
  readonly rec2: InstanceField
} = {
  rec0: { size: 4, offset: 0 },
  rec1: { size: 4, offset: 4 },
  rec2: { size: 1, offset: 8 },
}

/** The PACKED record's logical field map (documentation + the test twin's
 *  decode guide): where each semantic field lives inside the 9 words. */
export const INSTANCE_FIELDS: {
  /** words 0..2 — pos.xyz, NATIVE f32 (offset 0, size 3). */
  readonly pos: InstanceField
  /** word 3 — age, NATIVE f32 (offset 3, size 1). */
  readonly age: InstanceField
  /** words 4..5 — vel (x, y, z) + halfExtent as four f16 halves. */
  readonly velHalf: InstanceField
  /** words 6..7 — color rgba as four f16 halves. */
  readonly colorHalf: InstanceField
  /** word 8 — seed (f16, lo) + the atlas frame (u16, hi). */
  readonly seedFrame: InstanceField
} = {
  pos: { size: 3, offset: 0 },
  age: { size: 1, offset: 3 },
  velHalf: { size: 4, offset: 4 },
  colorHalf: { size: 4, offset: 6 },
  seedFrame: { size: 1, offset: 8 },
}

// ══════════════════════════════════════════════════════════════════════════
// Task 183 — THE F16 TIER (the quantizer + the word codec).
//
// The shared bit-cast pair (float ↔ its IEEE-754 bits) — the words ride a
// Float32Array as bit patterns; every write sets U32 then reads F32, every
// decode reads F32 then casts U32. Single-threaded by contract (the pack
// is the only writer, the module pair is not reentrant across workers).
// ══════════════════════════════════════════════════════════════════════════
const F32_VIEW = new Float32Array(1)
const U32_VIEW = new Uint32Array(F32_VIEW.buffer)

/** Quantizes an f64 (already f32-exact by the SoA contract) to the f16 bit
 *  pattern — THE CONTRACT: NaN→+0, |v|>65504→±65504 (clamp), |v|<2^-14→±0
 *  (flush), else RNE. The WGSL/GL twins produce the identical bits (the
 *  shader-side decode is branch-exact: no subnormals, no ∞, no NaN ever
 *  enter the stream). Hot path — kept branch-cheap. */
export function f32ToF16Bits(v: number): number {
  if (v !== v) return 0 // NaN → +0
  F32_VIEW[0] = v as number
  const x = U32_VIEW[0]
  const sign = (x >>> 16) & 0x8000
  if (v > 65504) return sign | 0x7bff // clamp +max (65504 = 0x7BFF)
  if (v < -65504) return 0x8000 | 0x7bff
  // the flush window: |v| < 2^-14 — the f32 exponent field ≤ 112 (the
  // f16 SUBNORMAL range [0, 2^-14) never stores: e32 = 112 is [2^-15,
  // 2^-14) — subnormal territory too, and the RNE bias below assumes the
  // hidden bit — the guard must be ≤, not <)
  if ((x & 0x7f800000) <= 0x38000000) return sign // ±0
  // normal range: e ∈ [113, 142], mantissa RNE to 10 bits
  let m = (x & 0x7fffff) + 0x0fff + ((x & 0x7fffff) >>> 13 & 1)
  let e = ((x >>> 23) & 0xff) - 112 // the f16 exponent, pre-carry
  if (m >= 0x800000) { m -= 0x800000; e++ } // the rounding carry rolled 1.m to 2.0
  return sign | (e << 10) | (m >>> 13)
}

/** Decodes an f16 bit pattern to its exact f64 value (IEEE: subnormals and
 *  ±∞ decode correctly — the defensive READ side; the pack contract only
 *  ever stores normals/zeros, but the decode tolerates anything). */
export function f16BitsToF32(h: number): number {
  const sign = (h & 0x8000) !== 0 ? -1 : 1
  const e = (h >>> 10) & 0x1f
  const m = h & 0x3ff
  if (e === 31) return m === 0 ? sign * Infinity : NaN
  if (e === 0) return sign * m * 5.9604644775390625e-8 // m × 2^-24, exact
  // normal: 2^(e-15) × (1 + m/1024) — 11 significant bits, f32-exact
  return sign * Math.pow(2, e - 15) * (1 + m / 1024)
}

/** Packs TWO f16 halves into one u32 word (lo = the low 16 bits). */
export function packHalfPair(lo: number, hi: number): number {
  return (f32ToF16Bits(lo) | (f32ToF16Bits(hi) << 16)) >>> 0
}

/** The decoded logical record — the test twin's read side (and the debug
 *  surface; the shader derives the same fields from the same words). */
export interface DecodedRecord {
  pos: [number, number, number]
  vel: [number, number, number]
  color: [number, number, number, number]
  /** (halfExtent, angle0 = seed·τ, age, seed) — the material's i_par. */
  par: [number, number, number, number]
  /** The atlas tile origin (u0, v0) — reconstructed from the u16 frame +
   *  the tile split; pass [1,1] for the full sprite. */
  uv0: [number, number]
  /** The raw atlas frame index (word 8's high half). */
  frame: number
}

/** Decodes record `index` of `rec` into `out` (reused — zero allocation at
 *  the call sites that matter). `tiles` reconstructs uv0 exactly the way
 *  the shader does ((frame%tileU)/tileU, floor(frame/tileU)/tileV). */
export function decodeInstanceRecord(
  rec: Float32Array,
  index: number,
  tiles: readonly [number, number],
  out: DecodedRecord,
): void {
  const at = index * INSTANCE_STRIDE
  const w = (k: number) => { F32_VIEW[0] = rec[at + k]; return U32_VIEW[0] }
  const w4 = w(4), w5 = w(5), w6 = w(6), w7 = w(7), w8 = w(8)
  out.pos[0] = rec[at]; out.pos[1] = rec[at + 1]; out.pos[2] = rec[at + 2]
  out.vel[0] = f16BitsToF32(w4 & 0xffff)
  out.vel[1] = f16BitsToF32(w4 >>> 16)
  out.vel[2] = f16BitsToF32(w5 & 0xffff)
  const half = f16BitsToF32(w5 >>> 16)
  out.color[0] = f16BitsToF32(w6 & 0xffff)
  out.color[1] = f16BitsToF32(w6 >>> 16)
  out.color[2] = f16BitsToF32(w7 & 0xffff)
  out.color[3] = f16BitsToF32(w7 >>> 16)
  const seed = f16BitsToF32(w8 & 0xffff)
  out.par[0] = half
  // the shader computes f32(seed) × f32(τ) — the f64 product of two f32s
  // rounds to the identical f32 (Task 183's derived-phase contract)
  out.par[1] = Math.fround(seed * 6.283185307179586)
  out.par[2] = rec[at + 3]
  out.par[3] = seed
  out.frame = w8 >>> 16
  const tileU = tiles[0] >= 1 ? tiles[0] : 1
  const tileV = tiles[1] >= 1 ? tiles[1] : 1
  const frame = out.frame
  out.uv0[0] = (frame % tileU) / tileU
  out.uv0[1] = Math.floor(frame / tileU) / tileV
}

/** The pack options — the subset of BillboardOptions the CPU resolves
 *  (everything else — the mode, the spin, the stretch factors, the axis —
 *  is a shader-side uniform of the BILLBOARD material). */
export interface PackOptions {
  /** The over-life ramp (size + color + frame); default: the identity. */
  readonly ramp?: Ramp
  /** Task 132 — the DRAW ORDER: an index sequence (the output of
   *  sortDepthBackToFront) — the records are packed in this order instead
   *  of slot order. Omitted/null — the natural [0, count) walk. The
   *  parity contract with fillBillboards pins the SAME order in both
   *  bakers (the soup's quad stream and this record stream).
   *  Task 176: ArrayLike — the facade hands the bakers the radix output
   *  as a typed prefix view (Int32Array.subarray) directly; plain arrays
   *  work exactly as before (the composable seam is unchanged). */
  readonly order?: ArrayLike<number> | null
  /** The sprite sheet split [u, v] — the ramp's frame channel picks the
   *  tile (the same contract as fillBillboards). Task 183: the atlas
   *  frame rides the record as a u16 — u×v is capped at 65536 tiles (the
   *  loud guard below rejects a sheet beyond the packed domain). */
  readonly tiles?: readonly [number, number]
  /** The per-particle random tile offset added before the floor:
   *  frame + seed·frameJitter. Default 0. */
  readonly frameJitter?: number
  /** Task 136 — render.cull (the CPU tier): the six frustum planes (24
   *  floats, normalized — gpuRenderFrustum's output; the facade extracts
   *  them once per view()). A particle whose conservative sphere (spawn
   *  size × cullRadiusK) is fully outside ANY plane is skipped — the GPU
   *  render tier's exact test (dot(p.xyz, pos) + p.w <= −radius, all six
   *  planes). Omitted/null — everything packs. */
  readonly frustum?: ReadonlyArray<number> | Float32Array | null
  /** The cull radius factor — rampMax · 0.5 (every drawn half-extent);
   *  the facade computes it from the ramp. Default 0.5 (rampMax = 1). */
  readonly cullRadiusK?: number
}

/** Packs the live particles into `out` (a Float32Array of at least
 *  capacity × INSTANCE_STRIDE words) as packed instance records. Returns
 *  the RECORD count — exactly fillBillboards()/4 for the same options (the
 *  parity contract). Deterministic; zero allocations. */
export function packInstances(
  system: ParticleSource,
  out: Float32Array,
  options: PackOptions = {},
): number {
  const ramp = options.ramp ?? CONSTANT_RAMP
  const tiles = options.tiles
  const tileU = tiles !== undefined ? tiles[0] : 1
  const tileV = tiles !== undefined ? tiles[1] : 1
  const useAtlas = tiles !== undefined
  if (useAtlas && (!Number.isInteger(tileU) || tileU < 1 || !Number.isInteger(tileV) || tileV < 1)) {
    throw new Error(`rune/particles: billboard tiles must be integers >= 1 (got [${tileU}, ${tileV}])`)
  }
  // Task 183 — the u16 frame domain guard: the atlas frame rides word 8's
  // high half; a sheet beyond 65536 tiles would silently wrap (a corrupt
  // tile pick per wrap) — reject it LOUDLY instead.
  if (useAtlas && tileU * tileV > 65536) {
    throw new Error(`rune/particles: the packed record's atlas frame is a u16 — tiles u×v must be <= 65536 (got ${tileU}×${tileV})`)
  }
  const maxFrame = tileU * tileV - 1
  const frameJitter = options.frameJitter ?? 0
  const f = system.fields
  const count = system.count
  const s: Float32Array = SCRATCH
  let n = 0
  // Task 136 — the CPU-tier frustum gate (fillBillboards' exact twin —
  // the parity contract: the same particle set survives both bakers).
  // Task 141 — the walk itself is @rune/core's sphereOutsideFrustum (the
  // same six planes, the same arithmetic shape — ONE gate for the repo).
  const frustum = options.frustum ?? null
  const radiusK = options.cullRadiusK ?? 0.5
  // Task 132 — the draw order: `order` (the sorted index sequence) walks
  // the particles in the given sequence; the default — the slot order.
  const order = options.order
  const ordered = order !== undefined && order !== null
  // Task 142 — the ramp's compiled form hoisted once per pack, the sampler
  // INLINED into the walk (JSC keeps the binary-search call out-of-line —
  // the inline body is sampleFlatRamp's own, verbatim, bit-identical).
  const rampFlat = flatRamp(ramp)
  const rampN = rampFlat.length / 7
  const rampLast = (rampN - 1) * 7
  const total = ordered ? order!.length : count
  for (let j = 0; j < total; j++) {
    const i = ordered ? order![j] : j
    if (frustum !== null && sphereOutsideFrustum(frustum, f.px[i], f.py[i], f.pz[i], f.size[i] * radiusK)) continue
    const age = f.age[i]
    const life = f.life[i]
    const t = life > 0 ? age / life : 0
    // INLINE sampleFlatRamp(rampFlat, t, s) — the sampler's own expressions.
    if (rampN === 1 || t <= rampFlat[0]) {
      s[0] = rampFlat[1]; s[1] = rampFlat[2]; s[2] = rampFlat[3]; s[3] = rampFlat[4]; s[4] = rampFlat[5]; s[5] = rampFlat[6]
    } else if (t >= rampFlat[rampLast]) {
      s[0] = rampFlat[rampLast + 1]; s[1] = rampFlat[rampLast + 2]; s[2] = rampFlat[rampLast + 3]
      s[3] = rampFlat[rampLast + 4]; s[4] = rampFlat[rampLast + 5]; s[5] = rampFlat[rampLast + 6]
    } else {
      let lo = 0, hi = rampN - 1
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1
        if (rampFlat[mid * 7] <= t) lo = mid
        else hi = mid
      }
      const a = lo * 7, b = hi * 7
      const span = rampFlat[b] - rampFlat[a]
      const k = span > 0 ? (t - rampFlat[a]) / span : 0
      s[0] = rampFlat[a + 1] + (rampFlat[b + 1] - rampFlat[a + 1]) * k
      s[1] = rampFlat[a + 2] + (rampFlat[b + 2] - rampFlat[a + 2]) * k
      s[2] = rampFlat[a + 3] + (rampFlat[b + 3] - rampFlat[a + 3]) * k
      s[3] = rampFlat[a + 4] + (rampFlat[b + 4] - rampFlat[a + 4]) * k
      s[4] = rampFlat[a + 5] + (rampFlat[b + 5] - rampFlat[a + 5]) * k
      s[5] = rampFlat[a + 6] + (rampFlat[b + 6] - rampFlat[a + 6]) * k
    }
    // The half extent — the same zero-size skip as fillBillboards (a
    // size-0 particle emits no quad; the packed count excludes it).
    const half = f.size[i] * s[0] * 0.5
    if (half <= 0) continue
    // The atlas frame: the ramp's frame channel, seed-jittered, floored,
    // clamped — the reference math, resolved CPU-side into the FRAME INDEX
    // (the tile ORIGIN is derived shader-side from this index + the tile
    // scales — exact, no f16 seam bleed).
    let frame = 0
    if (useAtlas) {
      let fr = Math.floor(s[5] + (frameJitter > 0 ? f.seed[i] * frameJitter : 0))
      if (!Number.isFinite(fr)) fr = 0
      if (fr < 0) fr = 0
      if (fr > maxFrame) fr = maxFrame
      frame = fr
    }
    // THE PACK (Task 183): words 0..3 native (pos, age — never quantized);
    // words 4..8 the f16 pairs + the u16 frame — f32ToF16Bits' contract
    // (NaN→0, clamp, flush, RNE) applied to every quantized field.
    const at = n * INSTANCE_STRIDE
    out[at] = f.px[i]; out[at + 1] = f.py[i]; out[at + 2] = f.pz[i]
    out[at + 3] = age
    U32_VIEW[0] = packHalfPair(f.vx[i], f.vy[i]); out[at + 4] = F32_VIEW[0]
    U32_VIEW[0] = packHalfPair(f.vz[i], half); out[at + 5] = F32_VIEW[0]
    U32_VIEW[0] = packHalfPair(f.cr[i] * s[1], f.cg[i] * s[2]); out[at + 6] = F32_VIEW[0]
    U32_VIEW[0] = packHalfPair(f.cb[i] * s[3], f.ca[i] * s[4]); out[at + 7] = F32_VIEW[0]
    U32_VIEW[0] = (packHalfPair(f.seed[i], 0) | (frame << 16)) >>> 0; out[at + 8] = F32_VIEW[0]
    n++
  }
  return n
}

/** The module-level ramp scratch (the memory contract: no per-call
 *  allocation — one 6-float array serves every packInstances call; the
 *  write happens before the read, single-threaded by contract). */
const SCRATCH = new Float32Array(6)

// ══════════════════════════════════════════════════════════════════════════
// Task 177 — THE STAGED PAINTER BAKE (the sorted instance layer's frame).
//
// The shipped shape walked the painter's order (the radix output)
// through the baker: a RANDOM gather over ~14 SoA streams — each 4-byte
// read its own cache line at 100k (a 5.6 MiB working set, L3 territory)
// — plus sequential writes. The stage moves the permutation to the
// RECORD level, where it is ONE 36-byte line instead of fourteen
// 4-byte reads:
//
//   1. THE STAGE (sequential, slot-DESCENDING — the walk that makes the
//      stable LSD's tie-break land slot-descending, the comparator's
//      rule): the frustum gate + the ramp sample + the zero-size skip
//      run over SoA in perfect streaming order; each SURVIVOR's record
//      lands sequentially in `records` and its flipped depth key in
//      `k`. The sort input shrinks to the survivors — the shipped shape
//      sorted every live slot, culled and zero-size ones included (the
//      measured field win: a half-culled 100k layer drops 9.5 → 2.5 ms).
//   2. THE RADIX (over the survivors, payload = the compacted stage
//      position — pass 0's payload is the loop index itself, no
//      identity array ever materializes): @rune/core's digit tier
//      discipline — 2×16-bit passes at RADIX_16BIT_MIN and up, 3×11-bit
//      below (same threshold, same parity argument: a stable LSD's
//      digit split cannot change the total order).
//   3. THE PLACEMENT — one gather pass, `out[r] ← records[perm[r]]`:
//      random full-line reads (memory-level parallel, no dependent
//      chain), sequential writes. The scatter form (sequential reads +
//      random full-line writes) measured WITHIN NOISE at 100k and ~7%
//      better at 200k (the records buffer leaves L3 first) — the
//      gather's simplicity won; revisit only if the advertised ceiling
//      doubles.
//
// PARITY CONTRACT (pinned in task177): for the same (system, options,
// forward), packInstancesPainter() returns EXACTLY
// packInstances(system, out, {…same options, order: sortBackToFront(…)})
// — byte-identical words: the record math is packInstances' verbatim
// body (the Task-183 packed form, quantized identically), the key is
// sortBackToFront's verbatim expression, the survivor set is the same
// tests, and the order is the same total order (key DESC, ties slot DESC
// — the slot-descending stage walk + the stable LSD reproduce the
// comparator's rule by construction).
//
// MEMORY: the records buffer is one capacity × INSTANCE_STRIDE words
// (3.6 MiB at 100k — Task 183 shrank it from 6.4) — CALLER-OWNED,
// allocated once (the facade, only for sorted instance layers). Not
// per-frame traffic: the record is staged and gathered within the
// frame; only `out` uploads.
// ══════════════════════════════════════════════════════════════════════════

/** The staged painter bake's scratch (Task 177) — caller-owned, one
 *  set allocated at capacity and reused every frame (the
 *  zero-per-frame-allocation contract). All arrays must be at least
 *  `capacity` long (records: capacity × INSTANCE_STRIDE words). */
export interface PainterScratch {
  /** The staged records — one packed record per SURVIVOR, compacted,
   *  in the stage walk's (slot-descending) order. */
  readonly records: Float32Array
  /** The flipped depth keys of the survivors (the stage walk's
   *  compacted order) — the radix's pass-0 source. */
  readonly k: Uint32Array
  /** The scatter target for the key bits (the ping-pong's far side). */
  readonly kAlt: Uint32Array
  /** The scatter target for the payload (the ping-pong's far side;
   *  also the odd-count copy-out source). */
  readonly iAlt: Int32Array
  /** The final painter permutation — perm[r] = the stage position of
   *  the r-th back-to-front record (the gather's source). */
  readonly perm: Int32Array
}

/** The digit-tier histograms for the staged radix (module consts, the
 *  same discipline as @rune/core's — see sort.ts). */
const PAINTER_HIST16 = new Uint32Array(65536)
const PAINTER_HIST11 = new Uint32Array(2048)

/** The single-word bit-cast view pair (float ↔ its IEEE-754 bits). */
const PAINTER_F32 = new Float32Array(1)
const PAINTER_U32 = new Uint32Array(PAINTER_F32.buffer)

/** Packs the live particles into `out` (a Float32Array of at least
 *  capacity × INSTANCE_STRIDE words) as packed instance records IN THE
 *  PAINTER'S ORDER (back to front by `forward`) — the staged form of
 *  packInstances(…, order: sortBackToFront(…)), byte-identical to it
 *  (the parity contract above). Returns the RECORD count — exactly the
 *  classic path's for the same options. `options.order` is not
 *  consulted (the painter's order IS the output); the type omits it.
 *  Deterministic; zero allocations per frame. */
export function packInstancesPainter(
  system: ParticleSource,
  out: Float32Array,
  options: Omit<PackOptions, 'order'>,
  forward: readonly number[],
  scratch: PainterScratch,
): number {
  const ramp = options.ramp ?? CONSTANT_RAMP
  const tiles = options.tiles
  const tileU = tiles !== undefined ? tiles[0] : 1
  const tileV = tiles !== undefined ? tiles[1] : 1
  const useAtlas = tiles !== undefined
  if (useAtlas && (!Number.isInteger(tileU) || tileU < 1 || !Number.isInteger(tileV) || tileV < 1)) {
    throw new Error(`rune/particles: billboard tiles must be integers >= 1 (got [${tileU}, ${tileV}])`)
  }
  if (useAtlas && tileU * tileV > 65536) {
    throw new Error(`rune/particles: the packed record's atlas frame is a u16 — tiles u×v must be <= 65536 (got ${tileU}×${tileV})`)
  }
  const maxFrame = tileU * tileV - 1
  const frameJitter = options.frameJitter ?? 0
  const f = system.fields
  const count = system.count
  const s: Float32Array = SCRATCH
  const fx = forward[0], fy = forward[1], fz = forward[2]
  const records = scratch.records
  const k = scratch.k
  let n = 0
  const frustum = options.frustum ?? null
  const radiusK = options.cullRadiusK ?? 0.5
  const rampFlat = flatRamp(ramp)
  const rampN = rampFlat.length / 7
  const rampLast = (rampN - 1) * 7

  // 1. THE STAGE — slot-DESCENDING (the tie-break carrier: the stable
  //    LSD keeps this input order within equal keys → slot-descending
  //    ties, the comparator's rule). The record body is packInstances'
  //    verbatim math (the Task-183 packed form); the key is
  //    sortBackToFront's verbatim expression (bit-identical floats),
  //    folded through the descFlip — the flip whose ASCENDING order is
  //    the key's DESCENDING (the painter's).
  for (let i = count - 1; i >= 0; i--) {
    if (frustum !== null && sphereOutsideFrustum(frustum, f.px[i], f.py[i], f.pz[i], f.size[i] * radiusK)) continue
    const age = f.age[i]
    const life = f.life[i]
    const t = life > 0 ? age / life : 0
    // INLINE sampleFlatRamp(rampFlat, t, s) — the sampler's own expressions.
    if (rampN === 1 || t <= rampFlat[0]) {
      s[0] = rampFlat[1]; s[1] = rampFlat[2]; s[2] = rampFlat[3]; s[3] = rampFlat[4]; s[4] = rampFlat[5]; s[5] = rampFlat[6]
    } else if (t >= rampFlat[rampLast]) {
      s[0] = rampFlat[rampLast + 1]; s[1] = rampFlat[rampLast + 2]; s[2] = rampFlat[rampLast + 3]
      s[3] = rampFlat[rampLast + 4]; s[4] = rampFlat[rampLast + 5]; s[5] = rampFlat[rampLast + 6]
    } else {
      let lo = 0, hi = rampN - 1
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1
        if (rampFlat[mid * 7] <= t) lo = mid
        else hi = mid
      }
      const a = lo * 7, b = hi * 7
      const span = rampFlat[b] - rampFlat[a]
      const kk = span > 0 ? (t - rampFlat[a]) / span : 0
      s[0] = rampFlat[a + 1] + (rampFlat[b + 1] - rampFlat[a + 1]) * kk
      s[1] = rampFlat[a + 2] + (rampFlat[b + 2] - rampFlat[a + 2]) * kk
      s[2] = rampFlat[a + 3] + (rampFlat[b + 3] - rampFlat[a + 3]) * kk
      s[3] = rampFlat[a + 4] + (rampFlat[b + 4] - rampFlat[a + 4]) * kk
      s[4] = rampFlat[a + 5] + (rampFlat[b + 5] - rampFlat[a + 5]) * kk
      s[5] = rampFlat[a + 6] + (rampFlat[b + 6] - rampFlat[a + 6]) * kk
    }
    const half = f.size[i] * s[0] * 0.5
    if (half <= 0) continue
    let frame = 0
    if (useAtlas) {
      let fr = Math.floor(s[5] + (frameJitter > 0 ? f.seed[i] * frameJitter : 0))
      if (!Number.isFinite(fr)) fr = 0
      if (fr < 0) fr = 0
      if (fr > maxFrame) fr = maxFrame
      frame = fr
    }
    const at = n * INSTANCE_STRIDE
    records[at] = f.px[i]; records[at + 1] = f.py[i]; records[at + 2] = f.pz[i]
    records[at + 3] = age
    U32_VIEW[0] = packHalfPair(f.vx[i], f.vy[i]); records[at + 4] = F32_VIEW[0]
    U32_VIEW[0] = packHalfPair(f.vz[i], half); records[at + 5] = F32_VIEW[0]
    U32_VIEW[0] = packHalfPair(f.cr[i] * s[1], f.cg[i] * s[2]); records[at + 6] = F32_VIEW[0]
    U32_VIEW[0] = packHalfPair(f.cb[i] * s[3], f.ca[i] * s[4]); records[at + 7] = F32_VIEW[0]
    U32_VIEW[0] = (packHalfPair(f.seed[i], 0) | (frame << 16)) >>> 0; records[at + 8] = F32_VIEW[0]
    // THE KEY — sortBackToFront's expression, folded through the
    // descending flip (−0 → +0 canonicalized: the tie must SURVIVE as a
    // tie and fall to the slot rule, the way JS compares them).
    const d = fx * f.px[i] + fy * f.py[i] + fz * f.pz[i]
    PAINTER_F32[0] = d
    let bits = PAINTER_U32[0]
    if (bits === 0x80000000) bits = 0
    bits = (bits & 0x80000000) !== 0 ? ~bits : (bits | 0x80000000)
    k[n] = ~bits >>> 0
    n++
  }
  if (n <= 1) {
    if (n === 1) {
      for (let c = 0; c < INSTANCE_STRIDE; c++) out[c] = records[c]
    }
    return n
  }

  // 2. THE RADIX — over the survivors; the payload is the compacted
  //    stage position (pass 0's payload is the loop index — no identity
  //    array ever materializes). Even pass counts land the answer in
  //    `perm`; the odd 3-pass branch copies out.
  const kAlt = scratch.kAlt
  const iAlt = scratch.iAlt
  const perm = scratch.perm
  if (n >= RADIX_16BIT_MIN) {
    // two 16-bit passes — even: `perm` holds the answer.
    PAINTER_HIST16.fill(0)
    for (let i = 0; i < n; i++) PAINTER_HIST16[k[i] & 0xffff]++
    let sum = 0
    for (let b = 0; b < 65536; b++) { const h = PAINTER_HIST16[b]; PAINTER_HIST16[b] = sum; sum += h }
    for (let i = 0; i < n; i++) {
      const key = k[i]
      const at = PAINTER_HIST16[key & 0xffff]++
      kAlt[at] = key
      iAlt[at] = i
    }
    PAINTER_HIST16.fill(0)
    for (let i = 0; i < n; i++) PAINTER_HIST16[kAlt[i] >>> 16]++
    sum = 0
    for (let b = 0; b < 65536; b++) { const h = PAINTER_HIST16[b]; PAINTER_HIST16[b] = sum; sum += h }
    for (let i = 0; i < n; i++) {
      const key = kAlt[i]
      const at = PAINTER_HIST16[key >>> 16]++
      k[at] = key
      perm[at] = iAlt[i]
    }
  } else {
    // three 11-bit passes (11/11/10 = 32) — odd: the payload's last
    // scatter target is iAlt; one copy-out restores `perm`. Pass 0's
    // payload is the loop index (the stage position — the identity
    // never materializes); passes 1..2 ping-pong it.
    //   p0: (k, loop-index) → (kAlt, iAlt)
    //   p1: (kAlt, iAlt) → (k, perm)
    //   p2: (k, perm) → (kAlt, iAlt)  → copy iAlt → perm
    PAINTER_HIST11.fill(0)
    for (let i = 0; i < n; i++) PAINTER_HIST11[k[i] & 0x7ff]++
    let sum = 0
    for (let b = 0; b < 2048; b++) { const h = PAINTER_HIST11[b]; PAINTER_HIST11[b] = sum; sum += h }
    for (let i = 0; i < n; i++) {
      const key = k[i]
      const at = PAINTER_HIST11[key & 0x7ff]++
      kAlt[at] = key
      iAlt[at] = i
    }
    let fromK: Uint32Array = kAlt
    let fromI: Int32Array = iAlt
    let toK: Uint32Array = k
    let toI: Int32Array = perm
    for (let pass = 1; pass < 3; pass++) {
      const shift = pass === 1 ? 11 : 22
      const mask = pass === 2 ? 0x3ff : 0x7ff
      PAINTER_HIST11.fill(0)
      for (let i = 0; i < n; i++) PAINTER_HIST11[(fromK[i] >>> shift) & mask]++
      let sum2 = 0
      for (let b = 0; b < 2048; b++) { const h = PAINTER_HIST11[b]; PAINTER_HIST11[b] = sum2; sum2 += h }
      // The stable scatter — the histogram's running cursor keeps the
      // source order within each bucket (the tie-break's carrier).
      for (let i = 0; i < n; i++) {
        const key = fromK[i]
        const at = PAINTER_HIST11[(key >>> shift) & mask]++
        toK[at] = key
        toI[at] = fromI[i]
      }
      const swapK = fromK; fromK = toK; toK = swapK
      const swapI = fromI; fromI = toI; toI = swapI
    }
    if (fromI !== perm) perm.set(fromI.subarray(0, n), 0)
  }

  // 3. THE PLACEMENT — one 36-byte-line gather per record (the random
  //    reads are independent — memory-level parallel; the writes run
  //    sequential).
  for (let r = 0; r < n; r++) {
    const src = perm[r] * INSTANCE_STRIDE
    const dst = r * INSTANCE_STRIDE
    out[dst] = records[src]
    out[dst + 1] = records[src + 1]
    out[dst + 2] = records[src + 2]
    out[dst + 3] = records[src + 3]
    out[dst + 4] = records[src + 4]
    out[dst + 5] = records[src + 5]
    out[dst + 6] = records[src + 6]
    out[dst + 7] = records[src + 7]
    out[dst + 8] = records[src + 8]
  }
  return n
}
