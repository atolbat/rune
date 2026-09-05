/**
 * @rune/particles — the facade: the store + the emitter + the soup view
 * behind one chainable object.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * MODULE CONTRACT (see the package header in index.ts):
 *   Owns the mechanical core (system.ts) + the GPU views (billboards.ts /
 *   trails.ts / meshes.ts) and adds the CONTINUOUS EMISSION (the rate
 *   accumulator) + the declarative BURST SCHEDULE (Task 122) + the emitter
 *   origin offset (at — the follow/prefab story) + the render kind. The
 *   soup buffer and the result view object are allocated ONCE at creation:
 *   advance() + view() never allocate (tests pin the identity across
 *   frames).
 *
 * THE RENDER KINDS (Task 122):
 *   billboard — the classic soup (mode: camera/vertical/horizontal/
 *               stretched/oriented + the atlas tiles)
 *   trail     — the ribbon view (the position history + fillTrails)
 *   mesh      — a real 3D geometry per particle (fillMeshes — normals,
 *               the LIT materials)
 * ══════════════════════════════════════════════════════════════════════════
 */

import {
  createParticleSystem, NO_FORCES,
  type ForceFields, type ParticleFields, type ParticleSystem, type RetireRecord,
} from './system.ts'
import {
  validateAttractor, validateCollision, validateSeek, validateLimitSpeed,
  validateInherit, validateRateOverDistance, validateWrap, validateBurst,
} from './validate.ts'
import { createSpawner, type Spawner, type SpawnerDesc } from './spawn.ts'
import { CONSTANT_RAMP, type Ramp } from './ramp.ts'
import { validateNoise, type NoiseField } from './noise.ts'
import { packInstances, INSTANCE_STRIDE, INSTANCE_LAYOUT, type PackOptions } from './instances.ts'
import { GPU_STATE_STRIDE } from './gpuSim.ts'
import {
  fillBillboards, SOUP_STRIDE, VERTS_PER_PARTICLE, type CameraBasis, type BillboardOptions,
} from './billboards.ts'
import { createTrailHistory, fillTrails, type TrailOptions, type TrailBakeOptions, type TrailHistory } from './trails.ts'
import { fillMeshes, MESH_STRIDE, type MeshGeometry, type MeshOptions } from './meshes.ts'
import { hash01 } from './spawn.ts'
import { sortDepthBackToFront } from './sort.ts'

/** Task 126 — the WRAP VOLUME: the endless, emitter-anchored field. Each
 *  axis with size > 0 wraps the live positions into a box of that size
 *  centered on the at() origin (the camera, for weather and ambience): a
 *  particle that leaves through one wall re-enters through the opposite
 *  one — the field reads as infinite wherever the emitter goes. */
export interface WrapDesc {
  /** The box size per axis (x, y, z), world units — 0 disables that axis. */
  readonly size: readonly [number, number, number]
}

/** One scheduled burst (the emission-burst schedule): fires `count`
 *  particles at `time`, then every `interval` seconds, `cycle` times
 *  (0 = forever). Each firing passes a `probability` gate (deterministic:
 *  hash01(seed, burst index, cycle index)). */
export interface BurstDesc {
  readonly time: number
  readonly count: number
  readonly cycle: number
  readonly interval: number
  readonly probability: number
}

/** The render description — which soup the facade bakes.
 *  Task 131 — the billboard kind's `draw` picks the record format:
 *  'soup' (the classic 6-vertex expansion, the LCD of every draw path) or
 *  'instance' (16-float records + the BILLBOARD material's GPU expansion —
 *  the optimization program's Phase 1; see instances.ts).
 *  Task 132 — the billboard kind's `sort`: the painter's order for
 *  alpha-blended layers (back to front, far first — see sort.ts).
 *  Task 134 — the billboard kind's `cull`: the GPU tier's per-particle
 *  frustum gate (sim:"gpu" only — the off-screen slots pack the zero
 *  record; see gpuSim's sort family). */
export type RenderDesc =
  | ({ readonly kind: 'billboard'; readonly draw?: 'soup' | 'instance'; readonly sort?: boolean; readonly cull?: boolean } & Omit<BillboardOptions, 'ramp'>)
  | ({ readonly kind: 'trail' } & TrailOptions & Omit<TrailBakeOptions, 'ramp'>)
  | ({ readonly kind: 'mesh'; readonly geometry: MeshGeometry } & Omit<MeshOptions, 'ramp'>)

/** The facade configuration. */
export interface ParticlesDesc {
  /** The hard particle ceiling (the soup is sized by the render kind). */
  readonly capacity: number
  /** The over-life appearance ramp (default: constant white, size 1). */
  readonly ramp?: Ramp
  /** The force fields of the integrator (default: no forces). */
  readonly forces?: Partial<ForceFields>
  /** The continuous emission rate, particles/second (0 — bursts only). */
  readonly rate?: number
  /** Task 124 — VELOCITY INHERITANCE: the fraction of the EMITTER's own
   *  velocity (the at() origin's movement, sampled per advance) added to
   *  every newborn. 0 (the default) = the ballistic void; 0.8 = a rocket's
   *  smoke DRAGS behind the flight instead of blooming in place — the
   *  classic game-engine "inherit velocity" knob. A teleport (an at() jump
   *  larger than 25 units in one advance) contributes NOTHING that frame
   *  (a repositioning is not a launch). The velocity is the LAST advance()'s
   *  sample: rate/burst emission inside advance() sees the current frame,
   *  a burst() called between advances sees the previous one. */
  readonly inheritVelocity?: number
  /** Task 124 — RATE OVER DISTANCE: particles per WORLD UNIT the emitter
   *  (the at() origin) travels, on top of the time rate. The emission tracks
   *  the SWING, not the clock: a sword edge at rest emits nothing, a fast
   *  arc emits a dense trail (tire dust, speed lines, weapon trails). A
   *  teleport (> 25 units in one advance) emits nothing. Default 0 (off). */
  readonly rateOverDistance?: number
  /** The spawner used by the rate accumulator and burst() (default:
   *  a white 1-unit sphere burst at the origin — set your own!). */
  readonly spawner?: SpawnerDesc
  /** Task 126 — the WRAP VOLUME (the endless field): after every
   *  integration the live positions wrap into a box of `size` centered on
   *  the at() ORIGIN — rain and dust that follow the camera read as an
   *  infinite field (a particle leaving through one wall re-enters through
   *  the opposite one). Per-axis: a size of 0 disables that axis. Do NOT
   *  combine with the trail render kind — a wrap teleport cuts a long
   *  segment straight through the ribbon. Default: off. */
  readonly wrap?: WrapDesc
  /** The billboard spin speed, radians/second (default 0). */
  readonly spin?: number
  /** The declarative burst schedule (Task 122) — fired by advance(). */
  readonly bursts?: readonly BurstDesc[]
  /** Simulate this many seconds at creation (Task 122 — their prewarm:
   *  a looping effect opens in its steady state, not empty). Default 0. */
  readonly prewarm?: number
  /** The render kind (default: the classic billboard soup). */
  readonly render?: RenderDesc
  /** The retire hook (Task 122 — sub-emitters): called per dead particle
   *  with its final state (a REUSED record — copy what you need). */
  readonly onRetire?: (record: RetireRecord) => void
  /** Task 131/132 — THE SIMULATION TIER: 'cpu' (the default — the
   *  reference, bit-identical on both backends) or 'gpu' (the GPGPU tier —
   *  the state lives GPU-side, the forces/aging and the record pack run
   *  ON THE GPU; the CPU keeps emission + death + compaction; see
   *  docs/particles-optimization.md Phases 2–3). Runs on BOTH backends:
   *  WebGPU compute over a storage buffer, WebGL2 transform feedback over
   *  a float texture — attach the orchestrator (@rune/gl
   *  createGpuParticles(facade, inner.gpu | inner.gl)) or the first
   *  advance() fails LOUDLY. Requires render.draw:'instance'; rejects the
   *  CPU-coupled features (onRetire, collide, seek, speedCurve,
   *  attract.killRadius, prewarm — the death site and the contact events
   *  are CPU-blind on the GPU tier). Task 134: render.sort and render.cull
   *  are the GPU render tier's own options here (the bitonic sort + the
   *  frustum gate — the orchestrator's step() takes the camera). */
  readonly sim?: 'cpu' | 'gpu'
}

/** Task 131 — sim:'gpu' — the per-frame CPU→GPU handoff (read by the
 *  orchestrator between advance() and the draw; reset at the next
 *  advance). The emit rows are the NEW particles at their
 *  PRE-COMPACTION slots — upload them FIRST, then replay the swaps: the
 *  GPU state ends up matching the CPU's post-compaction structure
 *  exactly (the same moves in the same order on the same data). */
export interface GpuHandoff {
  /** True once the orchestrator attached (createGpuParticles). The
   *  facade's first advance() without it throws (a loud misconfiguration
   *  — WebGL2 must pass sim:'cpu'). */
  attached: boolean
  /** The interleaved FIELD_NAMES rows of this advance's newborns, at
   *  their pre-compaction slots [emitBase, emitBase + emitCount). */
  readonly emitRows: Float32Array
  emitBase: number
  emitCount: number
  /** The compaction swaps of this advance: (to, from) u32 pairs in the
   *  CPU walk's exact order. */
  readonly swaps: Uint32Array
  swapCount: number
  /** The at() origin at this advance (the WRAP CENTER the GPU wraps
   *  around — the same origin the CPU tier's wrap block uses). */
  readonly emitOrigin: readonly number[]
  /** The resolved wrap sizes (per-axis, 0 = off; null — no wrap). Static:
   *  the desc's wrap. */
  readonly wrapSize: readonly [number, number, number] | null
}

/** The attribute layout of a soup — how a draw command binds it. */
export interface SoupLayout {
  readonly position: { readonly size: number; readonly offset: number }
  readonly uv: { readonly size: number; readonly offset: number }
  readonly color: { readonly size: number; readonly offset: number }
  readonly normal?: { readonly size: number; readonly offset: number }
}

/** The soup view — a REUSED result object (the scene.cull pattern): the
 *  same reference every frame, the counts updated. Task 131 — the view
 *  carries BOTH record formats: `draw` says which one `vertices` holds.
 *  'soup'     — vertices = the 6-vertex expansion (stride 9), vertexCount
 *               counts VERTICES (a plain drawArrays).
 *  'instance' — vertices = the 16-float records (stride 16), vertexCount
 *               === instanceCount counts INSTANCES (draw 6 vertices ×
 *               instanceCount through the BILLBOARD material). */
export interface SoupView {
  /** The vertex soup or the instance records, valid on
   *  [0, vertexCount × stride). */
  readonly vertices: Float32Array
  /** Live vertices (soup) or instances (instance) this frame. */
  vertexCount: number
  /** Floats per record of THIS view (36 billboard/trail, 48 mesh, 16 the
   *  instance records). */
  readonly stride: number
  /** The attribute layout (byte offsets are stride×4-based: offsets here
   *  are in FLOATS — multiply by 4 for bytes). In instance mode: position =
   *  i_pos, uv = i_uv0 (the tile origin), color = i_color. */
  readonly layout: SoupLayout
  /** Task 131 — which record format `vertices` holds. */
  readonly draw: 'soup' | 'instance'
  /** Task 131 — the live instance count (instance mode; 0 in soup mode). */
  instanceCount: number
  /** Task 131 — the instance record field offsets (instance mode; null
   *  in soup mode). The GPU-mapping contract of the BILLBOARD material. */
  readonly instanceLayout: typeof INSTANCE_LAYOUT | null
}

/** The facade. */
export interface Particles {
  /** Live particles. */
  readonly count: number
  /** The hard ceiling. */
  readonly capacity: number
  /** The SoA fields (Task 122 — the composable-core escape hatch):
   *  READ the live state, WRITE the seek targets (fields.tx/ty/tz = the
   *  sequencer retarget) or the positions (a custom behavior between
   *  advance() calls — the "custom plugin" story). The store owns the
   *  compaction; never reorder the [0, count) range yourself. */
  readonly fields: ParticleFields
  /** Task 131 — the resolved render description (read-only): which soup
   *  the facade bakes + the billboard options (the mode, the tiles, the
   *  stretch factors — what a renderer derives the BILLBOARD material's
   *  uniforms from). */
  readonly render: RenderDesc
  /** The billboard spin speed, radians/second (the desc's spin). */
  readonly spin: number
  /** Task 131 — the resolved force fields (read-only): the GPGPU
   *  orchestrator reads them (the GPU tier runs the same forces). */
  readonly forces: ForceFields
  /** Task 131 — the over-life ramp (read-only): the GPGPU orchestrator
   *  uploads it as the pack's LUT. */
  readonly ramp: Ramp
  /** Task 131 — sim:'gpu' — the per-frame GPU handoff (null on the CPU
   *  tier). Read it between advance() and the draw, then run the
   *  orchestrator's step(). */
  readonly gpuHandoff: GpuHandoff | null

  /** Sets the continuous emission: `rate` particles/second through the
   *  spawner (a spawner argument replaces the current one). Chainable. */
  rate(perSecond: number, spawner?: SpawnerDesc): this
  /** A one-shot emission of `n` particles through the spawner (an
   *  argument replaces the current one). Returns the number spawned
   *  (the capacity clips). */
  burst(n: number, spawner?: SpawnerDesc): number
  /** The live emitter origin offset (Task 122 — the follow/prefab story):
   *  every spawn position (rate, burst, the schedule) is translated by
   *  (x, y, z). The VELOCITY is untouched — a moving emitter leaves a
   *  trail of its spawn cloud. Chainable. */
  at(x: number, y: number, z: number): this
  /** Task 126 — the emitter ORIENTATION (the local-space emission —
   *  a RIGID attachment): a rotation applied to every spawn CLOUD and
   *  VELOCITY before the at() translation. A column-major 3×3 or 4×4
   *  matrix (the upper-left 3×3 is read — the translation column is
   *  ignored, use at() for it), or null to reset to identity. The exhaust
   *  cone of an attached emitter follows the OBJECT's heading, not the
   *  world axes. Chainable. Zero cost until the first call. */
  orient(m: ArrayLike<number> | null): this
  /** Integrates the system by dt (seconds), services the continuous rate
   *  and the burst schedule, and records the trail history (the trail
   *  render kind). Chainable. */
  advance(dt: number): this
  /** Bakes the soup for the camera basis (the render kind chooses the
   *  baker). Returns the REUSED view — hold no reference across frames,
   *  read it and draw. Task 131: a billboard desc with draw:'instance'
   *  packs the 16-float records instead (see SoupView.draw). */
  view(basis: CameraBasis, options?: RenderBakeOverride): SoupView
  /** The billboard alias of view() (the classic API — back-compat). */
  billboards(basis: CameraBasis): SoupView
  /** Diagnostics (allocates — a cold path by design): the counters. */
  stats(): { count: number; capacity: number; spawned: number; retired: number; dropped: number }
  /** Drops everything (the soup zeros out on the next view()). */
  clear(): this
}

/** Per-call overrides of the render options (rare: a demo switching the
 *  stretched factors on the fly). */
export interface RenderBakeOverride {
  readonly billboard?: Partial<BillboardOptions>
  readonly trail?: Partial<TrailBakeOptions>
  readonly mesh?: Partial<MeshOptions>
}

/** The integration substep ceiling: one advance() never integrates a step
 *  longer than this. A stall — a hidden tab, a debugger break, a screenshot
 *  pause — produces dt spikes of SECONDS, and explicit Euler on the STIFF
 *  springs (the seek force: unstable past dt ≈ 2/√strength ≈ 0.4 s)
 *  explodes the positions to 1e9+ (the sequencer demo shipped with exactly
 *  this: a stall returned a dead, frozen formation of off-screen
 *  particles). Larger dt integrates in substeps — the total time is always
 *  preserved (age/retirement stay honest), only the step is bounded. */
const MAX_STEP = 1 / 20

/** Creates the particle facade. */
export function createParticles(desc: ParticlesDesc): Particles {
  const capacity = desc.capacity
  const render: RenderDesc = desc.render ?? { kind: 'billboard' }
  const ramp = desc.ramp ?? CONSTANT_RAMP
  const spin = desc.spin ?? 0
  const forces: ForceFields = {
    gravity: desc.forces?.gravity ?? NO_FORCES.gravity,
    drag: desc.forces?.drag ?? NO_FORCES.drag,
    turbulence: desc.forces?.turbulence ?? NO_FORCES.turbulence,
    attract: validateAttractor(desc.forces?.attract),
    speedCurve: desc.forces?.speedCurve ?? null,
    collide: validateCollision(desc.forces?.collide),
    noise: desc.forces?.noise !== undefined && desc.forces?.noise !== null ? validateNoise(desc.forces!.noise as NoiseField) : null,
    seek: validateSeek(desc.forces?.seek),
    limitSpeed: validateLimitSpeed(desc.forces?.limitSpeed),
  }

  // Task 126 — the WRAP VOLUME: flat per-axis sizes (0 = the axis is off).
  const wrap = validateWrap(desc.wrap)
  const wrapX = wrap !== null && wrap[0] > 0 ? wrap[0] : 0
  const wrapY = wrap !== null && wrap[1] > 0 ? wrap[1] : 0
  const wrapZ = wrap !== null && wrap[2] > 0 ? wrap[2] : 0
  const hasWrap = wrapX > 0 || wrapY > 0 || wrapZ > 0

  // ── the render kind setup (before the store: trails need onSwap) ──────
  const kind = render.kind
  let history: TrailHistory | null = null
  if (kind === 'trail') {
    history = createTrailHistory(capacity, render as TrailOptions)
  }
  // Task 132 — THE PAINTER'S ORDER: render.sort on the billboard kinds.
  // The trail kind is one continuous ribbon (a per-particle order makes no
  // sense there); the mesh kind is opaque/lit (the depth buffer already
  // resolves it). Both reject sort loudly rather than ignore it. Task 134 —
  // render.cull is the same billboard-kind family (the frustum gate is a
  // per-particle record decision).
  const sortOn = (render as { sort?: boolean }).sort === true
  if (sortOn && kind !== 'billboard') {
    throw new Error(`rune/particles: render.sort is a billboard-kind option (a ${kind} layer cannot take a painter's order — trails are one continuous ribbon, meshes resolve through the depth buffer)`)
  }
  const cullOn = (render as { cull?: boolean }).cull === true
  if (cullOn && kind !== 'billboard') {
    throw new Error(`rune/particles: render.cull is a billboard-kind option (a ${kind} layer's records are not per-particle gates — the frustum test lives in the GPU render tier)`)
  }
  // Task 131 — THE SIMULATION TIER. 'gpu': the WebGPU compute advance (the
  // CPU keeps emission/death/compaction; the state lives in a storage
  // buffer). Validated loudly against the CPU-coupled features.
  const sim = desc.sim ?? 'cpu'
  const gpuMode = sim === 'gpu'
  let gpuHandoff: GpuHandoff | null = null
  let gpuSwaps: Uint32Array | null = null
  let gpuSwapCount = 0
  // Task 132 — the CPU/GPU slot-sync mark: the state on the GPU is live
  // through THIS slot (the previous advance's post-compaction count). The
  // next advance's emit gather starts HERE, not at the current count — a
  // MANUAL burst() between advances would otherwise never be uploaded
  // (the handoff saw emitBase = the count that already includes it, and
  // silently lost the newborns on the GPU — the catch-up closes it).
  let gpuSynced = 0
  if (gpuMode) {
    if (kind !== 'billboard' || (render as { draw?: string }).draw !== 'instance') {
      throw new Error('rune/particles: sim:"gpu" requires render { kind: "billboard", draw: "instance" } (the GPU tier packs the instance records itself — the soup/trail/mesh kinds are CPU-baked)')
    }
    if (desc.onRetire !== undefined) {
      throw new Error('rune/particles: sim:"gpu" rejects onRetire (the death site lives on the GPU — the sub-emitter family stays on the CPU tier)')
    }
    if (forces.collide !== null) {
      throw new Error('rune/particles: sim:"gpu" rejects collide (the bounce response needs the CPU positions; the contact events are CPU-blind — the rain/splash family stays on the CPU tier)')
    }
    if (forces.seek !== null) {
      throw new Error('rune/particles: sim:"gpu" rejects seek (the targets are dynamic CPU writes — retargeting would need strided per-frame uploads; the sequencer family stays on the CPU tier)')
    }
    if (forces.speedCurve !== null) {
      throw new Error('rune/particles: sim:"gpu" rejects forces.speedCurve (the telescoping rescale stays CPU-side in v1 — the rocket class keeps sim:"cpu")')
    }
    if ((forces.attract ?? null) !== null && ((forces.attract as { killRadius?: number } | null)?.killRadius ?? 0) > 0) {
      throw new Error('rune/particles: sim:"gpu" rejects attract.killRadius (the sink retires via positions — CPU-blind on the GPU tier; the vortex drain stays on the CPU tier)')
    }
    if ((desc.prewarm ?? 0) > 0) {
      throw new Error('rune/particles: sim:"gpu" rejects prewarm (the GPU state cannot be fast-forwarded synchronously — emit a burst and let a few frames pass instead)')
    }
    // Task 134 — render.sort + sim:'gpu' is the GPU render tier now (the
    // bitonic sort over the pairs buffer — see gpuSim's sort family); the
    // Task 132 reject is retired.
    gpuSwaps = new Uint32Array(2 * capacity) // the pairs ≤ the deaths ≤ capacity
    gpuHandoff = {
      attached: false,
      emitRows: new Float32Array(GPU_STATE_STRIDE * capacity),
      emitBase: 0, emitCount: 0,
      swaps: gpuSwaps, swapCount: 0,
      emitOrigin: [0, 0, 0],
      wrapSize: hasWrap ? [wrapX, wrapY, wrapZ] : null,
    }
  }
  // Task 134 — render.cull is the GPU tier's frustum gate: the CPU tier
  // bakes EVERY live particle (its packers have no camera planes to test —
  // the zero-record trick belongs to the GPU render tier's sorted pack).
  if (cullOn && !gpuMode) {
    throw new Error('rune/particles: render.cull is the GPU tier\'s frustum gate (the CPU tier bakes every live particle — take sim:"gpu" + createGpuParticles; see gpuSim\'s sort family)')
  }
  const system: ParticleSystem = createParticleSystem(capacity, {
    onRetire: desc.onRetire,
    onSwap: gpuSwaps !== null
      ? (to, from) => {
        // the GPU compaction replay: the exact CPU moves in exact order
        if (gpuSwapCount < gpuSwaps!.length / 2) {
          const at = gpuSwapCount * 2
          gpuSwaps![at] = to; gpuSwaps![at + 1] = from
          gpuSwapCount++
        }
      }
      : history !== null ? history.handleSwap : undefined,
  })

  let spawner: Spawner = createSpawner(desc.spawner ?? DEFAULT_SPAWNER)
  let ratePerSecond = desc.rate ?? 0
  let carry = 0 // the fractional emission remainder (the time rate)
  // Task 124 — the emitter-motion knobs: the velocity inheritance and the
  // rate-over-distance. The emitter velocity is resampled EVERY advance from
  // the at() origin's movement; a jump beyond MAX_EMITTER_STEP units in one
  // advance is a TELEPORT — it contributes neither velocity nor distance.
  const inheritK = validateInherit(desc.inheritVelocity)
  const rateOverDist = validateRateOverDistance(desc.rateOverDistance)
  let distCarry = 0 // the fractional emission remainder (the distance rate)
  let lastOx = 0, lastOy = 0, lastOz = 0 // the origin at the last advance
  let emitterVx = 0, emitterVy = 0, emitterVz = 0
  // The live emitter origin (at) — read by the emit wrapper, never rebuilt.
  const origin = [0, 0, 0]
  // Task 126 — the emitter ORIENTATION: row-major scalars, identity until
  // the first orient() call (the `oriented` flag keeps the emit path free).
  let r00 = 1, r01 = 0, r02 = 0
  let r10 = 0, r11 = 1, r12 = 0
  let r20 = 0, r21 = 0, r22 = 1
  let oriented = false
  // The GLOBAL spawn stream index (the anti-"jet" fix): the store's emit
  // always numbers particles 0..n-1 PER CALL, and the spawners hash their
  // randomness by that index — a rate stream or repeated bursts would
  // re-spawn THE SAME particle (one position, one velocity — a thin jet)
  // forever. The facade translates every call-local index into a
  // facade-global monotonic counter, so every particle ever emitted is
  // unique (until the 2^31 wrap — four orders beyond any demo).
  let streamIndex = 0
  const emitWrap: Spawner = (index, out) => {
    spawner(streamIndex + index, out)
    // Task 126 — the rigid attachment: the spawn cloud AND its velocity
    // rotate by the emitter orientation BEFORE the at() translation (the
    // exhaust cone follows the object's heading, not the world axes).
    if (oriented) {
      const x = out.x, y = out.y, z = out.z
      out.x = x * r00 + y * r01 + z * r02
      out.y = x * r10 + y * r11 + z * r12
      out.z = x * r20 + y * r21 + z * r22
      const vx = out.vx, vy = out.vy, vz = out.vz
      out.vx = vx * r00 + vy * r01 + vz * r02
      out.vy = vx * r10 + vy * r11 + vz * r12
      out.vz = vx * r20 + vy * r21 + vz * r22
    }
    out.x += origin[0]; out.y += origin[1]; out.z += origin[2]
    // Task 124 — the velocity inheritance: the newborn rides the emitter's
    // own motion (the rocket's smoke drags behind the flight path).
    if (inheritK > 0) {
      out.vx += emitterVx * inheritK
      out.vy += emitterVy * inheritK
      out.vz += emitterVz * inheritK
    }
  }
  /** emit + stream advance (both call sites use the actual returned count). */
  const emitStream = (n: number): number => {
    const spawnedCount = system.emit(n, emitWrap)
    streamIndex += spawnedCount
    return spawnedCount
  }

  // ── the soup: one array, sized by the render kind ──────────────────────
  let soupFloats: number
  let stride: number
  let layout: SoupLayout
  let drawFormat: 'soup' | 'instance' = 'soup'
  if (kind === 'mesh') {
    const geo = (render as { geometry: MeshGeometry }).geometry
    const vertsPer = geo.vertexCount
    if (!Number.isInteger(vertsPer) || vertsPer < 3) {
      throw new Error(`rune/particles: mesh geometry needs >= 3 vertices (got ${vertsPer})`)
    }
    soupFloats = capacity * vertsPer * MESH_STRIDE
    stride = MESH_STRIDE
    layout = { position: { size: 3, offset: 0 }, normal: { size: 3, offset: 3 }, uv: { size: 2, offset: 6 }, color: { size: 4, offset: 8 } }
  } else if (kind === 'trail') {
    const points = history!.points
    soupFloats = capacity * points * VERTS_PER_PARTICLE * SOUP_STRIDE
    stride = SOUP_STRIDE
    layout = { position: { size: 3, offset: 0 }, uv: { size: 2, offset: 3 }, color: { size: 4, offset: 5 } }
  } else {
    // Task 131 — the DRAW FORMAT: 'instance' packs 16-float records (the
    // GPU expands the quad — the Phase-1 path); 'soup' (the default, the
    // classic LCD) bakes the 6-vertex expansion CPU-side.
    const draw = (render as { draw?: 'soup' | 'instance' }).draw === 'instance' ? 'instance' : 'soup'
    drawFormat = draw
    if (draw === 'instance') {
      soupFloats = capacity * INSTANCE_STRIDE
      stride = INSTANCE_STRIDE
      layout = { position: { size: 3, offset: INSTANCE_LAYOUT.pos.offset }, uv: { size: 2, offset: INSTANCE_LAYOUT.uv0.offset }, color: { size: 4, offset: INSTANCE_LAYOUT.color.offset } }
    } else {
      soupFloats = capacity * VERTS_PER_PARTICLE * SOUP_STRIDE
      stride = SOUP_STRIDE
      layout = { position: { size: 3, offset: 0 }, uv: { size: 2, offset: 3 }, color: { size: 4, offset: 5 } }
    }
  }
  const vertices = new Float32Array(soupFloats)
  const view: SoupView = {
    vertices, vertexCount: 0, stride, layout,
    draw: drawFormat,
    instanceCount: 0,
    instanceLayout: drawFormat === 'instance' ? INSTANCE_LAYOUT : null,
  }
  // Task 132 — the painter's-order scratch (allocated ONCE, only for sorted
  // billboard layers; the sort runs in-place on these arrays — zero
  // per-frame allocation, the package's hot-path contract). `sortOrder` is
  // a plain array REUSED via in-place truncation (length = count): its
  // backing store survives the truncation, so the per-frame regrow to the
  // live count allocates nothing.
  const sortIndices = sortOn ? new Int32Array(capacity) : null
  const sortKeys = sortOn ? new Float32Array(capacity) : null
  const sortOrder: number[] | null = sortOn ? new Array<number>(capacity).fill(0) : null

  // ── the burst schedule state (Task 122) ────────────────────────────────
  let time = 0 // the facade's own clock (per-facade closure state; the prewarm shares it)
  const bursts = (desc.bursts ?? []).map(burst => validateBurst(burst))
  const burstState = bursts.map((burst, index) => ({
    next: burst.time,
    firesLeft: burst.cycle === 0 ? Infinity : burst.cycle,
    cycle: 0,
    index,
  }))
  const scheduleSeed = (desc.spawner?.seed ?? 1) | 0

  // ── the prewarm (Task 122): fixed 1/60 steps before the first frame ────
  const prewarm = desc.prewarm ?? 0
  if (prewarm > 0) {
    if (!Number.isFinite(prewarm) || prewarm > 3600) {
      throw new Error(`rune/particles: prewarm must be a finite seconds count <= 3600 (got ${prewarm})`)
    }
    const steps = Math.ceil(prewarm * 60)
    for (let i = 0; i < steps; i++) advanceInternal(1 / 60)
  }

  const facade: Particles = {
    get count() { return system.count },
    get capacity() { return capacity },
    get fields() { return system.fields },
    get render() { return render },
    get spin() { return spin },
    get forces() { return forces },
    get ramp() { return ramp },
    get gpuHandoff() { return gpuHandoff },

    rate(perSecond, sp) {
      if (!Number.isFinite(perSecond) || perSecond < 0) {
        throw new Error(`rune/particles: rate must be a finite >= 0 (got ${perSecond})`)
      }
      ratePerSecond = perSecond
      if (sp !== undefined) spawner = createSpawner(sp)
      return facade
    },

    burst(n, sp) {
      if (sp !== undefined) spawner = createSpawner(sp)
      return emitStream(n)
    },

    at(x, y, z) {
      if (!Number.isFinite(x + y + z)) {
        throw new Error(`rune/particles: at() needs three finite numbers (got ${x}, ${y}, ${z})`)
      }
      origin[0] = x; origin[1] = y; origin[2] = z
      return facade
    },

    orient(m) {
      if (m === null) {
        r00 = 1; r01 = 0; r02 = 0
        r10 = 0; r11 = 1; r12 = 0
        r20 = 0; r21 = 0; r22 = 1
        oriented = false
        return facade
      }
      const n = m.length
      if (n !== 9 && n !== 16) {
        throw new Error(`rune/particles: orient() takes a column-major 3×3 or 4×4 matrix, or null (got ${n} numbers)`)
      }
      // The upper-left 3×3, column-major input → row-major scalars (the
      // emit multiply reads rows). 3×3: columns at 0/3/6; 4×4: at 0/4/8.
      const c = n === 16 ? 4 : 3
      const v00 = m[0], v10 = m[1], v20 = m[2]
      const v01 = m[c], v11 = m[c + 1], v21 = m[c + 2]
      const v02 = m[c * 2], v12 = m[c * 2 + 1], v22 = m[c * 2 + 2]
      if (![v00, v10, v20, v01, v11, v21, v02, v12, v22].every(Number.isFinite)) {
        throw new Error('rune/particles: orient() matrix entries must all be finite')
      }
      r00 = v00; r01 = v01; r02 = v02
      r10 = v10; r11 = v11; r12 = v12
      r20 = v20; r21 = v21; r22 = v22
      oriented = true
      return facade
    },

    advance(dt) {
      advanceInternal(dt)
      return facade
    },

    view(basis, options) {
      if (kind === 'mesh') {
        const renderOpts = render as MeshOptions
        const o = options?.mesh ?? {}
        view.vertexCount = fillMeshes(system, (render as { geometry: MeshGeometry }).geometry, vertices, {
          ramp, axis: o.axis ?? renderOpts.axis, spin: o.spin ?? renderOpts.spin,
        })
      } else if (kind === 'trail') {
        const renderOpts = render as TrailBakeOptions
        const o = options?.trail ?? {}
        view.vertexCount = fillTrails(system, history!, withForward(basis), vertices, {
          ramp, length: o.length ?? renderOpts.length, width: o.width ?? renderOpts.width,
        })
      } else {
        const renderOpts = render as Omit<BillboardOptions, 'ramp'>
        const o = options?.billboard ?? {}
        // Task 132 — THE PAINTER'S ORDER: the back-to-front index sequence
        // (far first — the alpha layers composite correctly, the near sprite
        // blending over everything behind it). The SAME sequence feeds BOTH
        // bakers: the soup's quad stream and the instance-record stream get
        // the identical order (the draw-format parity contract).
        let order: readonly number[] | null = null
        if (sortOn) {
          const forward = basis.forward
          if (forward === undefined) {
            throw new Error('rune/particles: render.sort needs the camera basis forward (the depth key is dot(forward, position) — pass a full CameraBasis)')
          }
          const n = sortDepthBackToFront(system.fields, system.count, forward, sortIndices!, sortKeys!)
          // The bakers walk order.length entries — hand them the exact LIVE
          // prefix, not the capacity-sized scratch (the tail is stale zeros
          // that would bake duplicate quads).
          for (let i = 0; i < n; i++) sortOrder![i] = sortIndices![i]
          sortOrder!.length = n
          order = sortOrder!
        }
        if (gpuMode) {
          // Task 131 — the GPU tier: the records are PACKED ON THE GPU (the
          // pack dispatch of the orchestrator's step()); view() reports the
          // COUNT ONLY (the CPU buffer stays zero — never uploaded, the
          // draw binds the external records buffer through bufferId).
          view.vertexCount = system.count
          view.instanceCount = system.count
        } else if (drawFormat === 'instance') {
          // Task 131 — the instanced path: the 16-float records (the CPU
          // resolves the ramp/tint/tile; the BILLBOARD material's vertex
          // stage expands the quad on the GPU). The counts alias: the
          // records ARE the draw's instances.
          const packOpts: PackOptions = {
            ramp,
            tiles: o.tiles ?? renderOpts.tiles,
            frameJitter: o.frameJitter ?? renderOpts.frameJitter,
            order,
          }
          view.vertexCount = packInstances(system, vertices, packOpts)
          view.instanceCount = view.vertexCount
        } else {
          view.vertexCount = fillBillboards(system, basis, vertices, {
            ramp,
            spin,
            mode: o.mode ?? renderOpts.mode ?? 'camera',
            tiles: o.tiles ?? renderOpts.tiles,
            speedFactor: o.speedFactor ?? renderOpts.speedFactor,
            lengthFactor: o.lengthFactor ?? renderOpts.lengthFactor,
            axis: o.axis ?? renderOpts.axis,
            spin3d: o.spin3d ?? renderOpts.spin3d,
            frameJitter: o.frameJitter ?? renderOpts.frameJitter,
            order,
          })
          view.instanceCount = 0
        }
      }
      return view
    },

    billboards(basis) {
      return facade.view(basis)
    },

    stats() {
      const out = { count: system.count, capacity, spawned: system.spawned, retired: system.retired, dropped: system.dropped }
      return out
    },

    clear() {
      system.clear()
      carry = 0
      distCarry = 0
      if (gpuHandoff !== null) {
        gpuHandoff.emitBase = 0
        gpuHandoff.emitCount = 0
        gpuHandoff.swapCount = 0
        gpuSwapCount = 0
        gpuSynced = 0
      }
      return facade
    },
  }

  /** Task 131 — the GPU-tier advance: emission CPU-side (the SoA as the
   *  scratch), the emit rows gathered PRE-COMPACTION, then the aging walk
   *  (NO forces — the GPU owns them), the compaction swap list collected,
   *  and NO wrap (the GPU's positions are authoritative). The orchestrator
   *  reads facade.gpuHandoff between this call and the draw. Task 132: the
   *  GPU tier runs on BOTH backends — WebGPU compute (the SSBO tier) or
   *  WebGL2 transform feedback (the TF tier — the same handoff). */
  function advanceGpu(dt: number): void {
    const handoff = gpuHandoff!
    if (!handoff.attached) {
      throw new Error('rune/particles: sim:"gpu" needs the GPU backend — createGpuParticles(facade, gpuOrGlFacade) from @rune/gl (WebGPU: the compute tier; WebGL2: the transform-feedback tier)')
    }
    const emitBase = gpuSynced
    handoff.emitBase = emitBase
    handoff.emitCount = 0
    gpuSwapCount = 0
    ;(handoff.emitOrigin as unknown as number[])[0] = origin[0]
    ;(handoff.emitOrigin as unknown as number[])[1] = origin[1]
    ;(handoff.emitOrigin as unknown as number[])[2] = origin[2]
    // Task 124 — the emitter motion FIRST (this frame's newborns inherit
    // the CURRENT frame's emitter velocity; the distance emission precedes
    // the rate so a swing's trail starts at the swing).
    if (inheritK > 0 || rateOverDist > 0) {
      const mdx = origin[0] - lastOx, mdy = origin[1] - lastOy, mdz = origin[2] - lastOz
      const moved = Math.hypot(mdx, mdy, mdz)
      if (moved > MAX_EMITTER_STEP) {
        emitterVx = 0; emitterVy = 0; emitterVz = 0
      } else {
        emitterVx = mdx / dt; emitterVy = mdy / dt; emitterVz = mdz / dt
        if (rateOverDist > 0 && moved > 0) {
          distCarry += moved * rateOverDist
          const whole = Math.floor(distCarry)
          if (whole > 0) {
            distCarry -= whole
            emitStream(whole)
          }
        }
      }
      lastOx = origin[0]; lastOy = origin[1]; lastOz = origin[2]
    }
    if (ratePerSecond > 0) {
      carry += ratePerSecond * dt
      const whole = Math.floor(carry)
      if (whole > 0) {
        carry -= whole
        emitStream(whole)
      }
    }
    for (const state of burstState) {
      const burst = bursts[state.index]
      // A while, not an if: a long stall (a hidden tab) fires the missed
      // bursts — the schedule is time-anchored, not frame-anchored.
      let guard = 0
      while (time >= state.next && state.firesLeft > 0 && guard++ < 64) {
        if (hash01(scheduleSeed, state.index * 7919 + 13, state.cycle) < burst.probability) {
          emitStream(burst.count)
        }
        state.firesLeft--
        state.cycle++
        state.next += burst.interval
      }
    }
    // THE EMIT GATHER (pre-compaction): the rows at their slots — the
    // catch-up [synced, count-at-advance-start) PLUS the fresh in-advance
    // emissions [count-at-start, count). The upload lands BEFORE the swap
    // replay, so the GPU state ends up matching the CPU's post-compaction
    // structure exactly.
    const n = system.count - emitBase
    if (n > 0) {
      const f = system.fields
      const rows = handoff.emitRows
      for (let i = 0; i < n; i++) {
        const s = emitBase + i
        const at = i * GPU_STATE_STRIDE
        rows[at] = f.px[s]; rows[at + 1] = f.py[s]; rows[at + 2] = f.pz[s]
        rows[at + 3] = f.vx[s]; rows[at + 4] = f.vy[s]; rows[at + 5] = f.vz[s]
        rows[at + 6] = f.age[s]; rows[at + 7] = f.life[s]; rows[at + 8] = f.size[s]
        rows[at + 9] = f.cr[s]; rows[at + 10] = f.cg[s]; rows[at + 11] = f.cb[s]; rows[at + 12] = f.ca[s]
        rows[at + 13] = f.seed[s]
        rows[at + 14] = f.tx[s]; rows[at + 15] = f.ty[s]; rows[at + 16] = f.tz[s]
      }
      handoff.emitCount = n
    }
    // The aging walk: NO forces (the GPU runs them), retirement + the
    // compaction (the collector fills the swap list). The stall guard's
    // substeps preserve the age/retirement honesty.
    if (dt > MAX_STEP) {
      const steps = Math.min(600, Math.ceil(dt / MAX_STEP))
      const h = dt / steps
      for (let s = 0; s < steps; s++) system.advance(h, NO_FORCES)
    } else {
      system.advance(dt, NO_FORCES)
    }
    handoff.swapCount = gpuSwapCount
    gpuSynced = system.count
    time += dt
  }

  /** The one advance implementation (the prewarm shares it). */
  function advanceInternal(dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0) return
    if (gpuMode) {
      advanceGpu(dt)
      return
    }
    // Task 124 — the emitter motion FIRST (this frame's newborns inherit the
    // CURRENT frame's emitter velocity; the distance emission precedes the
    // rate so a swing's trail starts at the swing). A teleport (> the step
    // cap) zeroes the velocity and skips the distance — repositioning is not
    // launching.
    if (inheritK > 0 || rateOverDist > 0) {
      const mdx = origin[0] - lastOx, mdy = origin[1] - lastOy, mdz = origin[2] - lastOz
      const moved = Math.hypot(mdx, mdy, mdz)
      if (moved > MAX_EMITTER_STEP) {
        emitterVx = 0; emitterVy = 0; emitterVz = 0
      } else {
        emitterVx = mdx / dt; emitterVy = mdy / dt; emitterVz = mdz / dt
        if (rateOverDist > 0 && moved > 0) {
          distCarry += moved * rateOverDist
          const whole = Math.floor(distCarry)
          if (whole > 0) {
            distCarry -= whole
            emitStream(whole)
          }
        }
      }
      lastOx = origin[0]; lastOy = origin[1]; lastOz = origin[2]
    }
    // The rate first (this frame's newborns see the full dt — no
    // systematic one-frame lag), then the burst schedule, then the
    // integration + compaction, then the trail history.
    if (ratePerSecond > 0) {
      carry += ratePerSecond * dt
      const whole = Math.floor(carry)
      if (whole > 0) {
        carry -= whole
        emitStream(whole)
      }
    }
    for (const state of burstState) {
      const burst = bursts[state.index]
      // A while, not an if: a long stall (a hidden tab) fires the missed
      // bursts — the schedule is time-anchored, not frame-anchored.
      let guard = 0
      while (time >= state.next && state.firesLeft > 0 && guard++ < 64) {
        if (hash01(scheduleSeed, state.index * 7919 + 13, state.cycle) < burst.probability) {
          emitStream(burst.count)
        }
        state.firesLeft--
        state.cycle++
        state.next += burst.interval
      }
    }
    // The stall guard: dt spikes (a hidden tab, a screenshot pause) would
    // blow up the stiff springs (explicit Euler is unstable past
    // dt ≈ 2/√strength) — integrate in SUBSTEPS of at most MAX_STEP each.
    // Age, retirement and the trails all see the FULL dt (a life of 0.1 s
    // ends after 0.1 s of simulation, spikes included); only the per-step
    // integration is bounded. The rate accumulator and the burst schedule
    // run ONCE per advance on the real dt (emission catches up).
    if (dt > MAX_STEP) {
      const steps = Math.min(600, Math.ceil(dt / MAX_STEP))
      const h = dt / steps
      for (let s = 0; s < steps; s++) system.advance(h, forces)
    } else {
      system.advance(dt, forces)
    }
    // Task 126 — the WRAP VOLUME: the endless field. The live positions wrap
    // into the box around the CURRENT origin (the camera), AFTER the
    // integration — a drop/dust mote that left through one wall re-enters
    // through the opposite one. One modulo per axis per particle; skipped
    // entirely when no axis is set.
    if (hasWrap) {
      const f = system.fields
      const n = system.count
      const cx = origin[0], cy = origin[1], cz = origin[2]
      for (let i = 0; i < n; i++) {
        if (wrapX > 0) f.px[i] = cx + wrapAxis(f.px[i] - cx, wrapX)
        if (wrapY > 0) f.py[i] = cy + wrapAxis(f.py[i] - cy, wrapY)
        if (wrapZ > 0) f.pz[i] = cz + wrapAxis(f.pz[i] - cz, wrapZ)
      }
    }
    time += dt
    if (history !== null) history.record(system, dt)
  }

  function withForward(basis: CameraBasis): { right: readonly number[]; up: readonly number[]; forward: readonly number[] } {
    // fillTrails needs the look direction; derive it from right × up when
    // the caller (the classic two-vector basis) did not supply it:
    // forward = −(right × up) — the rows of a view matrix form the axes
    // with z pointing AT the camera, so the negated cross is the look.
    if (basis.forward !== undefined) {
      return { right: basis.right, up: basis.up, forward: basis.forward }
    }
    const r = basis.right, u = basis.up
    const cx = r[1] * u[2] - r[2] * u[1]
    const cy = r[2] * u[0] - r[0] * u[2]
    const cz = r[0] * u[1] - r[1] * u[0]
    return { right: r, up: u, forward: [-cx, -cy, -cz] }
  }

  return facade
}

/** The default spawner (a deliberate placeholder — loud in the visuals,
 *  replaced by the first rate()/burst() argument). */
const DEFAULT_SPAWNER: SpawnerDesc = {
  shape: { kind: 'sphere', origin: [0, 0, 0], radius: [0.2, 0.6] },
  velocity: { mode: 'radial' },
  speed: [1, 2],
  life: [1, 2],
  size: [0.1, 0.2],
  color: [[1, 1, 1, 1], [0.8, 0.9, 1, 0.6]],
}

/** The teleport threshold: an at() jump larger than this in ONE advance is a
 *  repositioning, not motion — it contributes neither inherited velocity nor
 *  distance emission (25 units/frame is far beyond any real emitter's speed:
 *  a 60 fps rocket at 10 u/s moves 0.17). */
const MAX_EMITTER_STEP = 25

/** Wrap one axis into [-size/2, size/2) around the center: the classic
 *  toroidal modulo (JS % can be negative — re-add the size once). */
function wrapAxis(d: number, size: number): number {
  let m = (d + size * 0.5) % size
  if (m < 0) m += size
  return m - size * 0.5
}
