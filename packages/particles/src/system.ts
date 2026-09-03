/**
 * @rune/particles — the particle store: SoA fields, emission, integration,
 * compaction.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * MODULE CONTRACT (see the package header in index.ts):
 *   Pure data + math, zero allocations in the steady state.
 *     IN : spawn records (position, velocity, life, size, tint, seed),
 *          the force fields (gravity, drag, turbulence), dt
 *     OUT: the flat SoA field arrays + the live count — views only,
 *          never copies
 *   The store owns NOTHING about appearance (ramps live in ramp.ts) or
 *   rendering (billboards.ts); it is the mechanical core.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** The SoA field block. Length = capacity; [0, count) is live.
 *  All arrays are allocated ONCE at creation — the store never grows,
 *  never re-allocates, never creates views. */
export interface ParticleFields {
  /** World-space position. */
  readonly px: Float32Array
  readonly py: Float32Array
  readonly pz: Float32Array
  /** Velocity (units/second). */
  readonly vx: Float32Array
  readonly vy: Float32Array
  readonly vz: Float32Array
  /** Age in seconds since spawn (>= 0; dead when age >= life). */
  readonly age: Float32Array
  /** Total lifetime in seconds (> 0, validated at emit). */
  readonly life: Float32Array
  /** Billboard size in world units at t = 0 (the ramp scales it). */
  readonly size: Float32Array
  /** Spawn tint, rgba (the ramp multiplies it). */
  readonly cr: Float32Array
  readonly cg: Float32Array
  readonly cb: Float32Array
  readonly ca: Float32Array
  /** Per-particle variation seed in [0, 1) — spin phase, turbulence phase. */
  readonly seed: Float32Array
}

/** One spawn: filled by a spawner callback into THIS reused record —
 *  emission never allocates. */
export interface SpawnRecord {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  life: number
  size: number
  r: number
  g: number
  b: number
  a: number
  seed: number
}

/** A point attractor — three-nebula's Gravity/Attraction behavior.
 *  accel = strength / (r² + softening²), pointing at `point`; a NEGATIVE
 *  strength repels (a repulsor). `softening` (default 0.25) caps the force
 *  at the center: no singularity, no NaN, no slingshot through the origin. */
export interface Attractor {
  readonly point: readonly number[]
  readonly strength: number
  readonly softening?: number
}

/** The force fields of the integrator.
 *  gravity — a constant acceleration [x, y, z] (units/s²);
 *  drag — exponential velocity damping per second (v *= e^(−drag·dt));
 *  turbulence — the strength of the deterministic per-particle wander
 *  (units/s² of hash-phased sine drift — cheap, allocation-free);
 *  attract — an optional point attractor/repulsor (see Attractor). */
export interface ForceFields {
  readonly gravity: readonly number[]
  readonly drag: number
  readonly turbulence: number
  readonly attract?: Attractor | null
}

/** The default force fields (all zero — a ballistic void). */
export const NO_FORCES: ForceFields = { gravity: [0, 0, 0], drag: 0, turbulence: 0, attract: null }

/** The mechanical particle store. */
export interface ParticleSystem {
  /** Live particles (the field arrays are valid on [0, count)). */
  readonly count: number
  /** The SoA field block (read-write views — the renderer reads them). */
  readonly fields: ParticleFields
  /** Total particles ever spawned (diagnostics; saturates at 2^31). */
  readonly spawned: number
  /** Total particles ever retired (diagnostics). */
  readonly retired: number
  /** Emission dropped by the capacity limit since the last stats()
   *  read (diagnostics; reset by stats()). */
  readonly dropped: number

  /** Spawns up to `n` particles by calling `fill(index, out)` — the
   *  record is reused, index is the particle's slot (RNG salts can use
   *  it). Returns the number actually spawned (the capacity clips).
   *  Invalid records (life <= 0, size < 0, NaN anywhere) are rejected
   *  with a thrown error — the spawner author's bug, not runtime noise. */
  emit(n: number, fill: (index: number, out: SpawnRecord) => void): number
  /** Advances the whole system by dt (seconds): ages, applies the force
   *  fields, integrates, then compacts the dead (swap-remove from the
   *  tail — a reverse walk, so no particle is processed twice and none
   *  is skipped). Deterministic: same state + same dt = same result. */
  advance(dt: number, forces: ForceFields): void
  /** Kills every particle (count = 0; the fields keep their garbage). */
  clear(): void
}

/** Creates the store. `capacity` is the hard ceiling (allocation happens
 *  here, once: 13 floats + the counter scalars per particle). */
export function createParticleSystem(capacity: number): ParticleSystem {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 2 ** 24) {
    throw new Error(`rune/particles: capacity must be an integer in [1, 16777216] (got ${capacity})`)
  }
  const f: ParticleFields = {
    px: new Float32Array(capacity), py: new Float32Array(capacity), pz: new Float32Array(capacity),
    vx: new Float32Array(capacity), vy: new Float32Array(capacity), vz: new Float32Array(capacity),
    age: new Float32Array(capacity), life: new Float32Array(capacity),
    size: new Float32Array(capacity),
    cr: new Float32Array(capacity), cg: new Float32Array(capacity),
    cb: new Float32Array(capacity), ca: new Float32Array(capacity),
    seed: new Float32Array(capacity),
  }
  // The reused spawn record — emission is allocation-free.
  const out: SpawnRecord = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size: 1, r: 1, g: 1, b: 1, a: 1, seed: 0 }

  let count = 0
  let spawned = 0
  let retired = 0
  let dropped = 0

  const system: ParticleSystem = {
    get count() { return count },
    get fields() { return f },
    get spawned() { return spawned },
    get retired() { return retired },
    get dropped() { return dropped },

    emit(n, fill) {
      if (n <= 0) return 0
      const room = capacity - count
      const actual = Math.min(n, room)
      if (n > room) dropped += n - room
      for (let i = 0; i < actual; i++) {
        fill(i, out)
        // Validation: a broken spawner must fail loudly, not poison the
        // soup with NaNs that silently kill the whole draw.
        if (!Number.isFinite(out.life) || out.life <= 0) {
          throw new Error(`rune/particles: spawn record has life <= 0 or NaN (slot ${count})`)
        }
        if (!Number.isFinite(out.size) || out.size < 0) {
          throw new Error(`rune/particles: spawn record has size < 0 or NaN (slot ${count})`)
        }
        if (!Number.isFinite(out.x + out.y + out.z + out.vx + out.vy + out.vz + out.r + out.g + out.b + out.a)) {
          throw new Error(`rune/particles: spawn record has NaN in its vectors (slot ${count})`)
        }
        const s = count
        f.px[s] = out.x; f.py[s] = out.y; f.pz[s] = out.z
        f.vx[s] = out.vx; f.vy[s] = out.vy; f.vz[s] = out.vz
        f.age[s] = 0
        f.life[s] = out.life
        f.size[s] = out.size
        f.cr[s] = out.r; f.cg[s] = out.g; f.cb[s] = out.b; f.ca[s] = out.a
        f.seed[s] = Number.isFinite(out.seed) ? (out.seed - Math.floor(out.seed)) : 0
        count = s + 1
      }
      spawned += actual
      return actual
    },

    advance(dt, forces) {
      if (count === 0) return
      if (!Number.isFinite(dt) || dt <= 0) return
      const { gravity, drag, turbulence } = forces
      const gx = gravity[0] ?? 0, gy = gravity[1] ?? 0, gz = gravity[2] ?? 0
      // One exp per FRAME, not per particle (the drag factor is shared).
      const dragFactor = drag > 0 ? Math.exp(-drag * dt) : 1
      const hasTurb = turbulence !== 0 && Number.isFinite(turbulence)
      // The point attractor, hoisted out of the loop: the accel is
      // strength / (r² + softening²) toward the point — one sqrt per particle.
      // The facade validated the fields once at creation; here we only
      // de-hoist (a missing attract keeps the loop clean).
      const at = forces.attract
      const hasAttract = at !== undefined && at !== null
      const atx = hasAttract ? (at.point[0] ?? 0) : 0
      const aty = hasAttract ? (at.point[1] ?? 0) : 0
      const atz = hasAttract ? (at.point[2] ?? 0) : 0
      const atS = hasAttract ? at.strength : 0
      const soft2 = hasAttract ? (at.softening ?? 0.25) ** 2 : 1

      // Reverse walk + swap-remove from the tail: particles beyond i are
      // already integrated (or dead), so the survivor lands in a slot that
      // is not walked again — no double integration, no skips.
      let i = count - 1
      while (i >= 0) {
        const age = f.age[i] + dt
        let vx = f.vx[i], vy = f.vy[i], vz = f.vz[i]
        if (dragFactor !== 1) { vx *= dragFactor; vy *= dragFactor; vz *= dragFactor }
        vx += gx * dt; vy += gy * dt; vz += gz * dt
        if (hasAttract) {
          // Δv = strength·dt·dir / (r·(r² + soft²)): normalized direction,
          // softened magnitude. r→0 is guarded (the force at the exact
          // point is undefined — we hold the velocity instead of NaN-ing).
          const dx = atx - f.px[i], dy = aty - f.py[i], dz = atz - f.pz[i]
          const r2 = dx * dx + dy * dy + dz * dz
          const r = Math.sqrt(r2)
          if (r > 1e-6) {
            const k = atS * dt / (r * (r2 + soft2))
            vx += dx * k; vy += dy * k; vz += dz * k
          }
        }
        if (hasTurb) {
          // The deterministic wander: three hash-phased sines of the
          // particle's own seed + age. Cheap (3 sin), stable (the phase
          // advances with age — no history needed), zero allocations.
          const ph = f.seed[i] * 37
          const t = age * 5 + ph
          vx += Math.sin(t) * turbulence * dt
          vy += Math.sin(t * 1.7 + 11.3) * turbulence * dt
          vz += Math.cos(t * 0.9 + 4.7) * turbulence * dt
        }
        f.px[i] += vx * dt; f.py[i] += vy * dt; f.pz[i] += vz * dt
        if (age >= f.life[i]) {
          // Dead: retire by swap-with-tail (or plain shrink when i IS the
          // tail). The copy is field-by-field — no per-particle views.
          const last = count - 1
          if (last !== i) {
            f.px[i] = f.px[last]; f.py[i] = f.py[last]; f.pz[i] = f.pz[last]
            f.vx[i] = f.vx[last]; f.vy[i] = f.vy[last]; f.vz[i] = f.vz[last]
            f.age[i] = f.age[last]; f.life[i] = f.life[last]; f.size[i] = f.size[last]
            f.cr[i] = f.cr[last]; f.cg[i] = f.cg[last]; f.cb[i] = f.cb[last]; f.ca[i] = f.ca[last]
            f.seed[i] = f.seed[last]
          }
          count = last
          retired++
          // Do NOT touch vx/vy/vz for the survivor: its own integration
          // already happened (it came from a slot > i... or IS i).
        } else {
          f.age[i] = age
          f.vx[i] = vx; f.vy[i] = vy; f.vz[i] = vz
        }
        i--
      }
    },

    clear() {
      retired += count
      count = 0
    },
  }
  return system
}
