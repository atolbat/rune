/**
 * @rune/particles — the facade: the store + the emitter + the soup view
 * behind one chainable object.
 *
 * ════════════════════════════════════════════════════════════════════════
 * MODULE CONTRACT (see the package header in index.ts):
 *   Owns the mechanical core (system.ts) + the GPU view (billboards.ts)
 *   and adds the CONTINUOUS EMISSION (the rate accumulator — the facade
 *   is the only stateful clock piece). The soup buffer and the result
 *   view object are allocated ONCE at creation: advance() + billboards()
 *   never allocate (tests pin the identity across frames).
 * ════════════════════════════════════════════════════════════════════════
 */

import { createParticleSystem, NO_FORCES, type Attractor, type ForceFields, type ParticleSystem } from './system.ts'
import { createSpawner, type Spawner, type SpawnerDesc } from './spawn.ts'
import { CONSTANT_RAMP, type Ramp } from './ramp.ts'
import { fillBillboards, SOUP_STRIDE, VERTS_PER_PARTICLE, type CameraBasis } from './billboards.ts'

/** The facade configuration. */
export interface ParticlesDesc {
  /** The hard particle ceiling (the soup is sized capacity × 6 verts). */
  readonly capacity: number
  /** The over-life appearance ramp (default: constant white, size 1). */
  readonly ramp?: Ramp
  /** The force fields of the integrator (default: no forces). */
  readonly forces?: Partial<ForceFields>
  /** The continuous emission rate, particles/second (0 — bursts only). */
  readonly rate?: number
  /** The spawner used by the rate accumulator and burst() (default:
   *  a white 1-unit sphere burst at the origin — set your own!). */
  readonly spawner?: SpawnerDesc
  /** The billboard spin speed, radians/second (default 0). */
  readonly spin?: number
}

/** The billboard soup view — a REUSED result object (the scene.cull
 *  pattern): the same reference every frame, the vertexCount updated. */
export interface SoupView {
  /** The vertex soup: capacity × 6 verts × 9 floats, valid on [0, vertexCount × 9). */
  readonly vertices: Float32Array
  /** Live vertices this frame (6 per live, non-zero-size particle). */
  vertexCount: number
}

/** The facade. */
export interface Particles {
  /** Live particles. */
  readonly count: number
  /** The hard ceiling. */
  readonly capacity: number

  /** Sets the continuous emission: `rate` particles/second through the
   *  spawner (a spawner argument replaces the current one). Chainable. */
  rate(perSecond: number, spawner?: SpawnerDesc): this
  /** A one-shot emission of `n` particles through the spawner (an
   *  argument replaces the current one). Returns the number spawned
   *  (the capacity clips). */
  burst(n: number, spawner?: SpawnerDesc): number
  /** Integrates the system by dt (seconds) and services the continuous
   *  rate (the fractional remainder carries over — 60/s at 60 Hz spawns
   *  exactly 1/frame). Chainable. */
  advance(dt: number): this
  /** Bakes the billboard soup for the camera basis. Returns the REUSED
   *  view — hold no reference across frames, read it and draw. */
  billboards(basis: CameraBasis): SoupView
  /** Diagnostics (allocates — a cold path by design): the counters. */
  stats(): { count: number; capacity: number; spawned: number; retired: number; dropped: number }
  /** Drops everything (the soup zeros out on the next billboards()). */
  clear(): this
}

/** Creates the particle facade. */
export function createParticles(desc: ParticlesDesc): Particles {
  const capacity = desc.capacity
  const system: ParticleSystem = createParticleSystem(capacity)
  const ramp = desc.ramp ?? CONSTANT_RAMP
  const spin = desc.spin ?? 0
  const forces: ForceFields = {
    gravity: desc.forces?.gravity ?? NO_FORCES.gravity,
    drag: desc.forces?.drag ?? NO_FORCES.drag,
    turbulence: desc.forces?.turbulence ?? NO_FORCES.turbulence,
    attract: validateAttractor(desc.forces?.attract),
  }

  let spawner: Spawner = createSpawner(desc.spawner ?? DEFAULT_SPAWNER)
  let ratePerSecond = desc.rate ?? 0
  let carry = 0 // the fractional emission remainder

  // The GPU view — allocated once, reused forever.
  const vertices = new Float32Array(capacity * VERTS_PER_PARTICLE * SOUP_STRIDE)
  const view: SoupView = { vertices, vertexCount: 0 }

  const facade: Particles = {
    get count() { return system.count },
    get capacity() { return capacity },

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
      return system.emit(n, spawner)
    },

    advance(dt) {
      // The rate first (this frame's newborns see the full dt — no
      // systematic one-frame lag), then the integration + compaction.
      if (ratePerSecond > 0 && dt > 0) {
        carry += ratePerSecond * dt
        const whole = Math.floor(carry)
        if (whole > 0) {
          carry -= whole
          system.emit(whole, spawner)
        }
      }
      system.advance(dt, forces)
      return facade
    },

    billboards(basis) {
      view.vertexCount = fillBillboards(system, basis, vertices, { ramp, spin })
      return view
    },

    stats() {
      const out = { count: system.count, capacity, spawned: system.spawned, retired: system.retired, dropped: system.dropped }
      return out
    },

    clear() {
      system.clear()
      carry = 0
      return facade
    },
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

/** Attractor validation (once, at creation — the hot advance() loop trusts
 *  its inputs). A loud error beats a silent NaN poisoning the whole system. */
function validateAttractor(at: Attractor | null | undefined): Attractor | null {
  if (at === undefined || at === null) return null
  const { point, strength, softening } = at
  if (!Array.isArray(point) || point.length !== 3 || !point.every(v => Number.isFinite(v))) {
    throw new Error(`rune/particles: attract.point must be three finite numbers (got ${JSON.stringify(point)})`)
  }
  if (!Number.isFinite(strength)) {
    throw new Error(`rune/particles: attract.strength must be finite (got ${strength}; negative = repulsion) — NaN is not an infinite attractor`)
  }
  const soft = softening ?? 0.25
  if (!Number.isFinite(soft) || soft <= 0) {
    throw new Error(`rune/particles: attract.softening must be finite > 0 (got ${softening}; it caps the force at the center — without it the integrator NaNs)`)
  }
  return at
}
