/**
 * @rune/particles — the INSTANCE RECORDS (Task 131, Phase 1 of the
 * optimization program: the instanced draw path — see
 * docs/particles-optimization.md).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE SPLIT (the grass-field pattern, applied to the dynamic soup):
 *   CPU, per frame — packInstances() writes ONE 16-float record per live
 *     particle (position, velocity, the ramp-resolved color, the size /
 *     spin / seed parameters, the atlas tile origin): ~1 ms per 100k
 *     particles and 6.4 MiB of frame traffic where fillBillboards() pays
 *     ~8.5 ms and 21.6 MiB (the 6-vertex expansion × 9 floats happened on
 *     the CPU; now the GPU does it — ONCE per instance, in the vertex
 *     shader).
 *   GPU, per frame — the BILLBOARD material feature (@rune/materials)
 *     expands the record into the 6 quad vertices from
 *     gl_VertexID / @builtin(vertex_index): all five orientation modes
 *     (camera / vertical / horizontal / stretched / oriented), the spin,
 *     the atlas tile scale. ONE draw call: 6 vertices × N instances.
 *
 * THE RECORD (INSTANCE_STRIDE = 16 floats, 64 bytes):
 *   [ 0.. 2] i_pos   vec3 — the world position
 *   [ 3.. 5] i_vel   vec3 — the velocity (the stretched mode's axis)
 *   [ 6.. 9] i_color vec4 — the tint × the ramp (rgb × rgb, a × a)
 *   [10..13] i_par   vec4 — (halfExtent, angle0, age, seed)
 *              halfExtent — size × rampSize × 0.5 (the quad's half edge)
 *              angle0     — seed·τ (the spin's phase at birth)
 *              age        — seconds since spawn (advances the spin)
 *              seed       — the per-particle variation source (the oriented
 *                           random axis, the atlas frame jitter)
 *   [14..15] i_uv0   vec2 — the atlas tile origin (u0, v0); (0,0) — the
 *                           full sprite
 *
 * PARITY CONTRACT (pinned by tests): for the same (store, basis, options),
 *   packInstances() returns EXACTLY fillBillboards()/6 — the same
 *   zero-size skip rule, the same ramp sampling, the same atlas frame
 *   math — and the BILLBOARD shader's corner expansion reproduces the
 *   fillBillboards vertex math (the JS twin in the test suite is the
 *   bit-exact reference for the GLSL/WGSL port).
 *
 * PERFORMANCE: zero allocations — the out array is caller-owned (the
 * facade allocates it once at capacity), the ramp scratch is one shared
 * 6-float array. The pack is a straight gather: no trigonometry (the
 * angles move to the shader), no per-vertex writes.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { sphereOutsideFrustum, RADIX_16BIT_MIN } from '@rune/core'
import type { ParticleSource } from './system.ts'
import { flatRamp, CONSTANT_RAMP, type Ramp } from './ramp.ts'

/** Floats per instance record (see the module header). */
export const INSTANCE_STRIDE = 16

/** One record field: component count + float offset in the record. */
export interface InstanceField {
  readonly size: number
  readonly offset: number
}

/** The record field offsets — the GPU mapping contract (the BILLBOARD
 *  material feature declares the same names/locations; the demo binds
 *  `view.vertices` with these strides). Offsets are in FLOATS — multiply
 *  by 4 for bytes. */
export const INSTANCE_LAYOUT: {
  readonly pos: InstanceField
  readonly vel: InstanceField
  readonly color: InstanceField
  readonly par: InstanceField
  readonly uv0: InstanceField
} = {
  pos: { size: 3, offset: 0 },
  vel: { size: 3, offset: 3 },
  color: { size: 4, offset: 6 },
  par: { size: 4, offset: 10 },
  uv0: { size: 2, offset: 14 },
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
   *  tile (the same contract as fillBillboards). */
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
 *  capacity × 16 floats) as instance records. Returns the RECORD count —
 *  exactly fillBillboards()/6 for the same options (the parity contract).
 *  Deterministic; zero allocations. */
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
    // The atlas tile: the ramp's frame channel, seed-jittered, floored,
    // clamped — the reference math, resolved CPU-side into the tile ORIGIN
    // (the tile SCALE is a shader uniform: uS = 1/tileU, vS = 1/tileV).
    let u0 = 0, v0 = 0
    if (useAtlas) {
      let frame = Math.floor(s[5] + (frameJitter > 0 ? f.seed[i] * frameJitter : 0))
      if (!Number.isFinite(frame)) frame = 0
      if (frame < 0) frame = 0
      if (frame > maxFrame) frame = maxFrame
      u0 = (frame % tileU) / tileU
      v0 = Math.floor(frame / tileU) / tileV
    }
    const at = n * INSTANCE_STRIDE
    out[at] = f.px[i]; out[at + 1] = f.py[i]; out[at + 2] = f.pz[i]
    out[at + 3] = f.vx[i]; out[at + 4] = f.vy[i]; out[at + 5] = f.vz[i]
    out[at + 6] = f.cr[i] * s[1]; out[at + 7] = f.cg[i] * s[2]
    out[at + 8] = f.cb[i] * s[3]; out[at + 9] = f.ca[i] * s[4]
    out[at + 10] = half
    out[at + 11] = f.seed[i] * 6.283185307179586
    out[at + 12] = age
    out[at + 13] = f.seed[i]
    out[at + 14] = u0; out[at + 15] = v0
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
// RECORD level, where it is ONE 64-byte line instead of fourteen
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
// — byte-identical floats: the record math is packInstances' verbatim
// body, the key is sortBackToFront's verbatim expression, the
// survivor set is the same tests, and the order is the same total
// order (key DESC, ties slot DESC — the slot-descending stage walk +
// the stable LSD reproduce the comparator's rule by construction).
//
// MEMORY: the records buffer is one capacity × 16 floats (6.4 MiB at
// 100k) — CALLER-OWNED, allocated once (the facade, only for sorted
// instance layers). Not per-frame traffic: the record is staged and
// gathered within the frame; only `out` uploads.
// ══════════════════════════════════════════════════════════════════════════

/** The staged painter bake's scratch (Task 177) — caller-owned, one
 *  set allocated at capacity and reused every frame (the
 *  zero-per-frame-allocation contract). All arrays must be at least
 *  `capacity` long (records: capacity × INSTANCE_STRIDE floats). */
export interface PainterScratch {
  /** The staged records — one 16-float record per SURVIVOR, compacted,
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
 *  capacity × 16 floats) as instance records IN THE PAINTER'S ORDER
 *  (back to front by `forward`) — the staged form of
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
  //    verbatim math; the key is sortBackToFront's verbatim expression
  //    (bit-identical floats), folded through the descFlip — the flip
  //    whose ASCENDING order is the key's DESCENDING (the painter's).
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
    let u0 = 0, v0 = 0
    if (useAtlas) {
      let frame = Math.floor(s[5] + (frameJitter > 0 ? f.seed[i] * frameJitter : 0))
      if (!Number.isFinite(frame)) frame = 0
      if (frame < 0) frame = 0
      if (frame > maxFrame) frame = maxFrame
      u0 = (frame % tileU) / tileU
      v0 = Math.floor(frame / tileU) / tileV
    }
    const at = n * INSTANCE_STRIDE
    records[at] = f.px[i]; records[at + 1] = f.py[i]; records[at + 2] = f.pz[i]
    records[at + 3] = f.vx[i]; records[at + 4] = f.vy[i]; records[at + 5] = f.vz[i]
    records[at + 6] = f.cr[i] * s[1]; records[at + 7] = f.cg[i] * s[2]
    records[at + 8] = f.cb[i] * s[3]; records[at + 9] = f.ca[i] * s[4]
    records[at + 10] = half
    records[at + 11] = f.seed[i] * 6.283185307179586
    records[at + 12] = age
    records[at + 13] = f.seed[i]
    records[at + 14] = u0; records[at + 15] = v0
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

  // 3. THE PLACEMENT — one 64-byte-line gather per record (the random
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
    out[dst + 9] = records[src + 9]
    out[dst + 10] = records[src + 10]
    out[dst + 11] = records[src + 11]
    out[dst + 12] = records[src + 12]
    out[dst + 13] = records[src + 13]
    out[dst + 14] = records[src + 14]
    out[dst + 15] = records[src + 15]
  }
  return n
}
