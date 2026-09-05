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

import type { ParticleSystem } from './system.ts'
import { sampleRamp, CONSTANT_RAMP, type Ramp } from './ramp.ts'

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
   *  bakers (the soup's quad stream and this record stream). */
  readonly order?: readonly number[] | null
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
  system: ParticleSystem,
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
  const frustum = options.frustum ?? null
  const radiusK = options.cullRadiusK ?? 0.5
  // Task 132 — the draw order: `order` (the sorted index sequence) walks
  // the particles in the given sequence; the default — the slot order.
  const order = options.order
  const ordered = order !== undefined && order !== null
  const total = ordered ? order!.length : count
  for (let j = 0; j < total; j++) {
    const i = ordered ? order![j] : j
    if (frustum !== null) {
      const F = frustum // narrowed: the six-plane walk is assertion-free
      const cx = f.px[i], cy = f.py[i], cz = f.pz[i]
      const radius = f.size[i] * radiusK
      if (cx * F[0] + cy * F[1] + cz * F[2] + F[3] <= -radius) continue
      if (cx * F[4] + cy * F[5] + cz * F[6] + F[7] <= -radius) continue
      if (cx * F[8] + cy * F[9] + cz * F[10] + F[11] <= -radius) continue
      if (cx * F[12] + cy * F[13] + cz * F[14] + F[15] <= -radius) continue
      if (cx * F[16] + cy * F[17] + cz * F[18] + F[19] <= -radius) continue
      if (cx * F[20] + cy * F[21] + cz * F[22] + F[23] <= -radius) continue
    }
    const age = f.age[i]
    const life = f.life[i]
    const t = life > 0 ? age / life : 0
    sampleRamp(ramp, t, s)
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
