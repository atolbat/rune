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
  createParticleSystem, NO_FORCES, MAX_PLANES,
  type Attractor, type ForceFields, type ParticleFields, type ParticleSystem, type RetireRecord, type Collision, type SeekForce, type LimitSpeedForce,
} from './system.ts'
import { createSpawner, type Spawner, type SpawnerDesc } from './spawn.ts'
import { CONSTANT_RAMP, type Ramp } from './ramp.ts'
import { validateNoise, type NoiseField } from './noise.ts'
import {
  fillBillboards, SOUP_STRIDE, VERTS_PER_PARTICLE, type CameraBasis, type BillboardOptions,
} from './billboards.ts'
import { createTrailHistory, fillTrails, type TrailOptions, type TrailBakeOptions, type TrailHistory } from './trails.ts'
import { fillMeshes, MESH_STRIDE, type MeshGeometry, type MeshOptions } from './meshes.ts'
import { hash01 } from './spawn.ts'

/** Task 126 — the WRAP VOLUME: the endless, emitter-anchored field. Each
 *  axis with size > 0 wraps the live positions into a box of that size
 *  centered on the at() origin (the camera, for weather and ambience): a
 *  particle that leaves through one wall re-enters through the opposite
 *  one — the field reads as infinite wherever the emitter goes. */
export interface WrapDesc {
  /** The box size per axis (x, y, z), world units — 0 disables that axis. */
  readonly size: readonly [number, number, number]
}

/** One scheduled burst (three.quarks' emissionBursts): fires `count`
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

/** The render description — which soup the facade bakes. */
export type RenderDesc =
  | ({ readonly kind: 'billboard' } & Omit<BillboardOptions, 'ramp'>)
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
}

/** The attribute layout of a soup — how a draw command binds it. */
export interface SoupLayout {
  readonly position: { readonly size: number; readonly offset: number }
  readonly uv: { readonly size: number; readonly offset: number }
  readonly color: { readonly size: number; readonly offset: number }
  readonly normal?: { readonly size: number; readonly offset: number }
}

/** The soup view — a REUSED result object (the scene.cull pattern): the
 *  same reference every frame, the vertexCount updated. */
export interface SoupView {
  /** The vertex soup, valid on [0, vertexCount × stride). */
  readonly vertices: Float32Array
  /** Live vertices this frame. */
  vertexCount: number
  /** Floats per vertex of THIS view (36 billboard/trail, 48 mesh). */
  readonly stride: number
  /** The attribute layout (byte offsets are stride×4-based: offsets here
   *  are in FLOATS — multiply by 4 for bytes). */
  readonly layout: SoupLayout
}

/** The facade. */
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
  /** Task 126 — the emitter ORIENTATION (three.quarks' worldSpace:false —
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
   *  read it and draw. */
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

  // ── the render kind setup (before the store: trails need onSwap) ──────
  const kind = render.kind
  let history: TrailHistory | null = null
  if (kind === 'trail') {
    history = createTrailHistory(capacity, render as TrailOptions)
  }
  const system: ParticleSystem = createParticleSystem(capacity, {
    onRetire: desc.onRetire,
    onSwap: history !== null ? history.handleSwap : undefined,
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
  // Task 126 — the WRAP VOLUME: flat per-axis sizes (0 = the axis is off).
  const wrap = validateWrap(desc.wrap)
  const wrapX = wrap !== null && wrap[0] > 0 ? wrap[0] : 0
  const wrapY = wrap !== null && wrap[1] > 0 ? wrap[1] : 0
  const wrapZ = wrap !== null && wrap[2] > 0 ? wrap[2] : 0
  const hasWrap = wrapX > 0 || wrapY > 0 || wrapZ > 0
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
    soupFloats = capacity * VERTS_PER_PARTICLE * SOUP_STRIDE
    stride = SOUP_STRIDE
    layout = { position: { size: 3, offset: 0 }, uv: { size: 2, offset: 3 }, color: { size: 4, offset: 5 } }
  }
  const vertices = new Float32Array(soupFloats)
  const view: SoupView = { vertices, vertexCount: 0, stride, layout }

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
        })
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
      return facade
    },
  }

  /** The one advance implementation (the prewarm shares it). */
  function advanceInternal(dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0) return
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

/** Inheritance validation: a finite fraction >= 0 (1 = fully riding the
 *  emitter; > 1 = overshoot — allowed, it reads as a slingshot). */
function validateInherit(k: number | undefined): number {
  if (k === undefined) return 0
  if (!Number.isFinite(k) || k < 0) {
    throw new Error(`rune/particles: inheritVelocity must be a finite >= 0 (got ${k}; the fraction of the emitter's velocity a newborn rides)`)
  }
  return k
}

/** Rate-over-distance validation: particles per world unit, finite >= 0. */
function validateRateOverDistance(r: number | undefined): number {
  if (r === undefined) return 0
  if (!Number.isFinite(r) || r < 0) {
    throw new Error(`rune/particles: rateOverDistance must be a finite >= 0 (got ${r}; particles per world unit the emitter travels)`)
  }
  return r
}

/** Wrap one axis into [-size/2, size/2) around the center: the classic
 *  toroidal modulo (JS % can be negative — re-add the size once). */
function wrapAxis(d: number, size: number): number {
  let m = (d + size * 0.5) % size
  if (m < 0) m += size
  return m - size * 0.5
}

/** Wrap validation: three finite sizes >= 0 (0 disables the axis). */
function validateWrap(wrap: WrapDesc | undefined): [number, number, number] | null {
  if (wrap === undefined || wrap === null) return null
  const size = wrap.size
  if (!Array.isArray(size) || size.length !== 3 || !size.every((v: number) => Number.isFinite(v) && v >= 0)) {
    throw new Error(`rune/particles: wrap.size must be three finite numbers >= 0, 0 disables the axis (got ${JSON.stringify(size)})`)
  }
  return [size[0], size[1], size[2]]
}

/** Attractor validation (once, at creation — the hot advance() loop trusts
 *  its inputs). A loud error beats a silent NaN poisoning the whole system. */
function validateAttractor(at: Attractor | null | undefined): Attractor | null {
  if (at === undefined || at === null) return null
  const { point, strength, softening } = at
  if (!Array.isArray(point) || point.length !== 3 || !point.every((v: number) => Number.isFinite(v))) {
    throw new Error(`rune/particles: attract.point must be three finite numbers (got ${JSON.stringify(point)})`)
  }
  if (!Number.isFinite(strength)) {
    throw new Error(`rune/particles: attract.strength must be finite (got ${strength}; negative = repulsion) — NaN is not an infinite attractor`)
  }
  const soft = softening ?? 0.25
  if (!Number.isFinite(soft) || soft <= 0) {
    throw new Error(`rune/particles: attract.softening must be finite > 0 (got ${softening}; it caps the force at the center — without it the integrator NaNs)`)
  }
  // Task 126 — the sink radius: finite >= 0 (0 — nothing is consumed).
  const kill = at.killRadius ?? 0
  if (!Number.isFinite(kill) || kill < 0) {
    throw new Error(`rune/particles: attract.killRadius must be a finite >= 0 (got ${at.killRadius}; particles inside the sphere are consumed)`)
  }
  return at
}

/** Collision validation (the planes normalize per frame in the store). */
function validateCollision(collide: Collision | null | undefined): Collision | null {
  if (collide === undefined || collide === null) return null
  if (!Array.isArray(collide.planes) || collide.planes.length === 0) {
    throw new Error('rune/particles: collide.planes must be a non-empty array (a collision set with no planes is a silent no-op)')
  }
  if (collide.planes.length > MAX_PLANES) {
    throw new Error(`rune/particles: collide.planes is capped at ${MAX_PLANES} (got ${collide.planes.length}) — the flat scratch is sized to the cap`)
  }
  for (const plane of collide.planes) {
    if (!Array.isArray(plane.normal) || plane.normal.length !== 3 || !plane.normal.every((v: number) => Number.isFinite(v))) {
      throw new Error(`rune/particles: a collision plane normal must be three finite numbers (got ${JSON.stringify(plane.normal)})`)
    }
    if (Math.hypot(plane.normal[0], plane.normal[1], plane.normal[2]) < 1e-12) {
      throw new Error('rune/particles: a collision plane normal must be non-zero')
    }
    if (!Array.isArray(plane.point) || plane.point.length !== 3 || !plane.point.every((v: number) => Number.isFinite(v))) {
      throw new Error(`rune/particles: a collision plane point must be three finite numbers (got ${JSON.stringify(plane.point)})`)
    }
    if (!Number.isFinite(plane.restitution) || plane.restitution < 0 || plane.restitution > 1) {
      throw new Error(`rune/particles: plane restitution must be in [0, 1] (got ${plane.restitution})`)
    }
    const fr = plane.friction ?? 0
    if (!Number.isFinite(fr) || fr < 0 || fr > 1) {
      throw new Error(`rune/particles: plane friction must be in [0, 1] (got ${fr})`)
    }
    // Task 124 — kill on contact + the contact events.
    if (plane.kill !== undefined && typeof plane.kill !== 'boolean') {
      throw new Error(`rune/particles: plane kill must be a boolean (got ${JSON.stringify(plane.kill)}; true = the particle retires on contact)`)
    }
  }
  // Task 124 — the contact-event hook: a function, or absent.
  if (collide.onCollide !== undefined && typeof collide.onCollide !== 'function') {
    throw new Error(`rune/particles: collide.onCollide must be a function (got ${typeof collide.onCollide}; called per contact after the integration walk — the splash hook)`)
  }
  return collide
}

/** Seek validation. */
function validateSeek(seek: SeekForce | null | undefined): SeekForce | null {
  if (seek === undefined || seek === null) return null
  if (!Number.isFinite(seek.strength) || seek.strength <= 0) {
    throw new Error(`rune/particles: seek.strength must be a finite > 0 (got ${seek.strength})`)
  }
  if (!Number.isFinite(seek.damping) || seek.damping < 0) {
    throw new Error(`rune/particles: seek.damping must be a finite >= 0 (got ${seek.damping}; ≈ 2·√strength is critically damped)`)
  }
  return seek
}

/** LimitSpeed validation (three.quarks' LimitSpeedOverLife). */
function validateLimitSpeed(ls: LimitSpeedForce | null | undefined): LimitSpeedForce | null {
  if (ls === undefined || ls === null) return null
  if (!Number.isFinite(ls.limit) || ls.limit < 0) {
    throw new Error(`rune/particles: limitSpeed.limit must be a finite >= 0 (got ${ls.limit})`)
  }
  if (!Number.isFinite(ls.dampen) || ls.dampen < 0 || ls.dampen > 1) {
    throw new Error(`rune/particles: limitSpeed.dampen must be in [0, 1] (got ${ls.dampen}; their dampen)`)
  }
  return ls
}

/** Burst validation. */
function validateBurst(burst: BurstDesc): BurstDesc {
  if (!Number.isFinite(burst.time) || burst.time < 0) {
    throw new Error(`rune/particles: burst time must be a finite >= 0 (got ${burst.time})`)
  }
  if (!Number.isInteger(burst.count) || burst.count < 1) {
    throw new Error(`rune/particles: burst count must be an integer >= 1 (got ${burst.count})`)
  }
  if (!Number.isInteger(burst.cycle) || burst.cycle < 0) {
    throw new Error(`rune/particles: burst cycle must be an integer >= 0 (0 = repeating; got ${burst.cycle})`)
  }
  if (!Number.isFinite(burst.interval) || burst.interval <= 0) {
    throw new Error(`rune/particles: burst interval must be a finite > 0 (got ${burst.interval})`)
  }
  if (!Number.isFinite(burst.probability) || burst.probability < 0 || burst.probability > 1) {
    throw new Error(`rune/particles: burst probability must be in [0, 1] (got ${burst.probability})`)
  }
  return burst
}
