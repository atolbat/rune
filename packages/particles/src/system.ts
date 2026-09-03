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

import { simplex3, type NoiseField } from './noise.ts'
import { sampleRamp, type Ramp } from './ramp.ts'

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
  /** SEEK TARGET, world space (Task 122 — three.quarks' sequencers): the
   *  `seek` force pulls the particle here; defaults to the spawn position
   *  (a particle that holds still). WRITE DIRECTLY to retarget — the
   *  arrays are public views (the composable-core pattern). */
  readonly tx: Float32Array
  readonly ty: Float32Array
  readonly tz: Float32Array
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
  /** Optional seek target (world space). Omitted/NaN → the spawn position
   *  (the default target: a particle that holds still under `seek`). */
  tx: number
  ty: number
  tz: number
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

/** A collision plane (three.quarks' ApplyCollision, declarative): an
 *  infinite plane with restitution + friction. The collision response:
 *  reflect the velocity about the normal, damp the tangential part, snap
 *  the position back to the surface. */
export interface CollisionPlane {
  /** The plane normal, ANY non-zero length (normalized at creation). */
  readonly normal: readonly number[]
  /** A point on the plane (world space). */
  readonly point: readonly number[]
  /** Bounce factor: 0 = a dead stop on contact, 1 = a perfect bounce. */
  readonly restitution: number
  /** Tangential damping on contact: 0 = frictionless, 1 = full stop. */
  readonly friction?: number
}

/** The collision set: up to a few planes (floor, walls). */
export interface Collision {
  readonly planes: readonly CollisionPlane[]
}

/** The seek spring (three.quarks' sequencer pull): a critically-damped-ish
 *  attraction toward the per-particle TARGET (fields.tx/ty/tz).
 *  accel = strength·(target − pos) − damping·v — a particle launched at its
 *  own target with zero velocity stays put; retarget and it glides over. */
export interface SeekForce {
  readonly strength: number
  readonly damping: number
}

/** The force fields of the integrator.
 *  gravity — a constant acceleration [x, y, z] (units/s²);
 *  drag — exponential velocity damping per second (v *= e^(−drag·dt));
 *  turbulence — the strength of the deterministic per-particle wander
 *  (units/s² of hash-phased sine drift — cheap, allocation-free);
 *  attract — an optional point attractor/repulsor (see Attractor);
 *  speedCurve — three.quarks' SpeedOverLife: the speed multiplier curve
 *  over the normalized age (the ramp's size channel is the scalar); the
 *  velocity magnitude tracks v(0)·curve(t) by the per-frame telescoping
 *  rescale v *= c(t)/c(t−dt);
 *  collide — collision planes with restitution/friction (see Collision);
 *  noise — the simplex flow field (see NoiseField);
 *  seek — the target spring (see SeekForce). */
export interface ForceFields {
  readonly gravity: readonly number[]
  readonly drag: number
  readonly turbulence: number
  readonly attract?: Attractor | null
  readonly speedCurve?: Ramp | null
  readonly collide?: Collision | null
  readonly noise?: NoiseField | null
  readonly seek?: SeekForce | null
}

/** The default force fields (all zero — a ballistic void). */
export const NO_FORCES: ForceFields = {
  gravity: [0, 0, 0], drag: 0, turbulence: 0, attract: null,
  speedCurve: null, collide: null, noise: null, seek: null,
}

/** The retired-particle snapshot — a REUSED record handed to onRetire
 *  (sub-emitters: spawn the next generation at the death site). */
export interface RetireRecord {
  x: number; y: number; z: number
  vx: number; vy: number; vz: number
  age: number; life: number
  size: number
  r: number; g: number; b: number; a: number
  seed: number
}

/** Store options (Task 122): the compaction hooks.
 *  onRetire — called per dead particle with its FINAL state in a reused
 *    record (zero allocation; the copy is 14 scalars). Sub-emitters read
 *    it and burst the next system at the death site.
 *  onSwap — called when compaction moves the tail particle into a dead
 *    slot: (to, from). External per-slot state (trail histories) follows
 *    its particle by copying [from] → [to]. Both default to absent — the
 *    hot path skips the branches. */
export interface StoreOptions {
  readonly onRetire?: (record: RetireRecord) => void
  readonly onSwap?: (to: number, from: number) => void
}

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

/** The collision-plane ceiling (validated loudly in the facade; the flat
 *  scratch is sized to this). */
export const MAX_PLANES = 16

/** Creates the store. `capacity` is the hard ceiling (allocation happens
 *  here, once: 16 floats + the counter scalars per particle). */
export function createParticleSystem(capacity: number, options: StoreOptions = {}): ParticleSystem {
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
    tx: new Float32Array(capacity), ty: new Float32Array(capacity), tz: new Float32Array(capacity),
  }
  // The reused spawn record — emission is allocation-free.
  const out: SpawnRecord = {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size: 1,
    r: 1, g: 1, b: 1, a: 1, seed: 0, tx: NaN, ty: NaN, tz: NaN,
  }
  // The reused retire snapshot — onRetire is allocation-free too.
  const retireRec: RetireRecord = {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, life: 0, size: 0,
    r: 0, g: 0, b: 0, a: 0, seed: 0,
  }
  const onRetire = options.onRetire
  const onSwap = options.onSwap
  // The speed-curve scratch: TWO samples per particle when the curve is on
  // (t and t−dt — the telescoping rescale). Two shared 6-float scratches —
  // no subarray views in the hot loop (a view IS an allocation).
  const curveScratch = new Float32Array(6)
  const curvePrev = new Float32Array(6)
  // The flattened collision planes (nx, ny, nz, px, py, pz, keep) — filled
  // once per advance() call; the hot loop reads flat scalars, never arrays.
  const flatPlanes = new Float64Array(MAX_PLANES * 7)

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
        // The seek target: an explicit target wins; NaN → the spawn
        // position (the default “hold still” target of the seek force).
        f.tx[s] = Number.isFinite(out.tx) ? out.tx : out.x
        f.ty[s] = Number.isFinite(out.ty) ? out.ty : out.y
        f.tz[s] = Number.isFinite(out.tz) ? out.tz : out.z
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
      // Task 122 — the new forces, hoisted (absent = a clean loop):
      const speedCurve = forces.speedCurve ?? null
      const hasCurve = speedCurve !== null
      const collide = forces.collide ?? null
      const planeCount = collide !== null ? Math.min(collide.planes.length, MAX_PLANES) : 0
      // The planes, pre-flattened ONCE PER FRAME (normalize + scalars) into
      // the closure scratch — the hot loop reads flat numbers, never arrays.
      if (planeCount > 0) {
        const planes = collide!.planes
        for (let p = 0; p < planeCount; p++) {
          const plane = planes[p]
          let nx = plane.normal[0] ?? 0, ny = plane.normal[1] ?? 0, nz = plane.normal[2] ?? 0
          const nl = Math.hypot(nx, ny, nz)
          if (nl < 1e-12) { nx = 0; ny = 1; nz = 0 } else { nx /= nl; ny /= nl; nz /= nl }
          const b = p * 7
          flatPlanes[b] = nx; flatPlanes[b + 1] = ny; flatPlanes[b + 2] = nz
          flatPlanes[b + 3] = plane.point[0] ?? 0; flatPlanes[b + 4] = plane.point[1] ?? 0; flatPlanes[b + 5] = plane.point[2] ?? 0
          flatPlanes[b + 6] = 1 - (plane.friction ?? 0) // the tangential keep factor
        }
      }
      const noise = forces.noise ?? null
      const hasNoise = noise !== null && noise.strength !== 0
      const nStrength = hasNoise ? noise!.strength : 0
      const nScale = hasNoise ? noise!.scale : 1
      const nSpeed = hasNoise ? noise!.speed : 0
      const seek = forces.seek ?? null
      const hasSeek = seek !== null
      const seekK = hasSeek ? seek!.strength : 0
      const seekC = hasSeek ? seek!.damping : 0

      // Reverse walk + swap-remove from the tail: particles beyond i are
      // already integrated (or dead), so the survivor lands in a slot that
      // is not walked again — no double integration, no skips.
      let i = count - 1
      while (i >= 0) {
        const age = f.age[i] + dt
        const life = f.life[i]
        let vx = f.vx[i], vy = f.vy[i], vz = f.vz[i]
        // The speed governor (three.quarks' SpeedOverLife): the per-frame
        // telescoping rescale — v(t) = v(0)·c(t)/c(0) EXACTLY when applied
        // every frame from birth (the product telescopes). Two ramp samples
        // per particle into two STATIC scratches; the ε floor keeps a zero
        // curve point from NaN-ing the rescale.
        if (hasCurve) {
          const t = life > 0 ? age / life : 0
          sampleRamp(speedCurve!, t, curveScratch)
          const tPrev = life > 0 ? Math.max(0, (age - dt) / life) : 0
          sampleRamp(speedCurve!, tPrev, curvePrev)
          const k = Math.max(1e-6, curveScratch[0]) / Math.max(1e-6, curvePrev[0])
          vx *= k; vy *= k; vz *= k
        }
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
        if (hasNoise) {
          // The simplex flow (three.quarks' TurbulenceField): the field is
          // sampled at position·scale advected by age·speed; the per-axis
          // coordinate offsets (and the seed offset) decorrelate the axes.
          // Three simplex evals per particle — the price of real curl-ish
          // motion; the branch is opt-in.
          const px = f.px[i], py = f.py[i], pz = f.pz[i]
          const adrift = age * nSpeed
          const so = f.seed[i] * 13.7
          const sx = px * nScale + adrift, sy = py * nScale, sz = pz * nScale
          vx += simplex3(sx, sy + so, sz + 5.3) * nStrength * dt
          vy += simplex3(sx + 11.7, sy + adrift, sz + 9.1 + so) * nStrength * dt
          vz += simplex3(sx + 3.1, sy + 7.7 + so, sz + adrift) * nStrength * dt
        }
        if (hasSeek) {
          // The sequencer pull: a spring toward the per-particle target
          // with a velocity damper — glide-in, no overshoot oscillation at
          // damping ≈ 2·√strength (critically damped).
          vx += ((f.tx[i] - f.px[i]) * seekK - vx * seekC) * dt
          vy += ((f.ty[i] - f.py[i]) * seekK - vy * seekC) * dt
          vz += ((f.tz[i] - f.pz[i]) * seekK - vz * seekC) * dt
        }
        f.px[i] += vx * dt; f.py[i] += vy * dt; f.pz[i] += vz * dt
        // The collision response AFTER the integration (three.quarks'
        // ApplyCollision): a penetrating particle snaps to the surface and
        // reflects — only when it is MOVING INTO the plane (a resting or
        // separating particle keeps its velocity). Friction damps the
        // TANGENTIAL part of the reflected velocity only.
        for (let p = 0; p < planeCount; p++) {
          const b = p * 7
          const nx = flatPlanes[b], ny = flatPlanes[b + 1], nz = flatPlanes[b + 2]
          const d = (f.px[i] - flatPlanes[b + 3]) * nx + (f.py[i] - flatPlanes[b + 4]) * ny + (f.pz[i] - flatPlanes[b + 5]) * nz
          if (d >= 0) continue
          const vn = vx * nx + vy * ny + vz * nz
          if (vn >= 0) continue // separating — keep the velocity, no response
          // v' = v − (1+e)·(v·n)n — the normal part flips and scales by e.
          const e = collide!.planes[p].restitution
          const rlx = vx - (1 + e) * vn * nx
          const rly = vy - (1 + e) * vn * ny
          const rlz = vz - (1 + e) * vn * nz
          // The friction: keep (1−friction) of the tangential component.
          const keep = flatPlanes[b + 6]
          const vnn = rlx * nx + rly * ny + rlz * nz
          vx = vnn * nx + keep * (rlx - vnn * nx)
          vy = vnn * ny + keep * (rly - vnn * ny)
          vz = vnn * nz + keep * (rlz - vnn * nz)
          // The snap: back onto the surface + ε (no immediate re-penetration).
          const push = -d + 1e-4
          f.px[i] += push * nx; f.py[i] += push * ny; f.pz[i] += push * nz
        }
        if (age >= f.life[i]) {
          // Dead: retire by swap-with-tail (or plain shrink when i IS the
          // tail). The copy is field-by-field — no per-particle views.
          // Task 122 — the hooks: onRetire sees the FINAL state (before the
          // slot is overwritten); onSwap fires BEFORE the field copy so the
          // external per-slot state (trail histories) follows its particle.
          if (onRetire !== undefined) {
            retireRec.x = f.px[i]; retireRec.y = f.py[i]; retireRec.z = f.pz[i]
            retireRec.vx = vx; retireRec.vy = vy; retireRec.vz = vz
            retireRec.age = age; retireRec.life = life
            retireRec.size = f.size[i]
            retireRec.r = f.cr[i]; retireRec.g = f.cg[i]; retireRec.b = f.cb[i]; retireRec.a = f.ca[i]
            retireRec.seed = f.seed[i]
            onRetire(retireRec)
          }
          const last = count - 1
          if (last !== i) {
            if (onSwap !== undefined) onSwap(i, last)
            f.px[i] = f.px[last]; f.py[i] = f.py[last]; f.pz[i] = f.pz[last]
            f.vx[i] = f.vx[last]; f.vy[i] = f.vy[last]; f.vz[i] = f.vz[last]
            f.age[i] = f.age[last]; f.life[i] = f.life[last]; f.size[i] = f.size[last]
            f.cr[i] = f.cr[last]; f.cg[i] = f.cg[last]; f.cb[i] = f.cb[last]; f.ca[i] = f.ca[last]
            f.seed[i] = f.seed[last]
            f.tx[i] = f.tx[last]; f.ty[i] = f.ty[last]; f.tz[i] = f.tz[last]
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
