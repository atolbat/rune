/**
 * @rune/particles — the description validators (the facade's cold path).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * MODULE CONTRACT: every value the HOT advance()/view() loops trust is
 * checked HERE, exactly once, at createParticles() time. A loud error at
 * creation beats a silent NaN poisoning the whole system at frame 57.
 *
 * Extracted from facade.ts (Task 131 — the structure pass): the facade
 * module now owns ONLY the facade itself (emission, scheduling, the soup/
 * instance views); the validation grammar lives here as pure functions.
 * ══════════════════════════════════════════════════════════════════════════
 */

import {
  MAX_PLANES, MAX_SPHERES, MAX_BOXES,
  type Attractor, type Collision, type SeekForce, type LimitSpeedForce,
} from './system.ts'
import type { WrapDesc, BurstDesc } from './facade.ts'

/** Attractor validation (once, at creation — the hot advance() loop trusts
 *  its inputs). A loud error beats a silent NaN poisoning the whole system. */
export function validateAttractor(at: Attractor | null | undefined): Attractor | null {
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
export function validateCollision(collide: Collision | null | undefined): Collision | null {
  if (collide === undefined || collide === null) return null
  // Task 128 — the planes are optional now, but AT LEAST ONE shape must
  // exist (an empty collision set is a silent no-op).
  const shapeCount = (collide.planes?.length ?? 0) + (collide.spheres?.length ?? 0) + (collide.boxes?.length ?? 0)
  if (shapeCount === 0) {
    throw new Error('rune/particles: collide needs at least one plane, sphere or box (a collision set with no shapes is a silent no-op)')
  }
  if (collide.planes !== undefined && !Array.isArray(collide.planes)) {
    throw new Error(`rune/particles: collide.planes must be an array (got ${typeof collide.planes})`)
  }
  if (collide.spheres !== undefined && !Array.isArray(collide.spheres)) {
    throw new Error(`rune/particles: collide.spheres must be an array (got ${typeof collide.spheres})`)
  }
  if (collide.boxes !== undefined && !Array.isArray(collide.boxes)) {
    throw new Error(`rune/particles: collide.boxes must be an array (got ${typeof collide.boxes})`)
  }
  if ((collide.planes?.length ?? 0) > MAX_PLANES) {
    throw new Error(`rune/particles: collide.planes is capped at ${MAX_PLANES} (got ${collide.planes!.length}) — the flat scratch is sized to the cap`)
  }
  if ((collide.spheres?.length ?? 0) > MAX_SPHERES) {
    throw new Error(`rune/particles: collide.spheres is capped at ${MAX_SPHERES} (got ${collide.spheres!.length}) — the flat scratch is sized to the cap`)
  }
  if ((collide.boxes?.length ?? 0) > MAX_BOXES) {
    throw new Error(`rune/particles: collide.boxes is capped at ${MAX_BOXES} (got ${collide.boxes!.length}) — the flat scratch is sized to the cap`)
  }
  for (const plane of collide.planes ?? []) {
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
  // Task 128 — the spheres: center/radius/restitution/friction/kill.
  for (const sphere of collide.spheres ?? []) {
    if (!Array.isArray(sphere.center) || sphere.center.length !== 3 || !sphere.center.every((v: number) => Number.isFinite(v))) {
      throw new Error(`rune/particles: a collision sphere center must be three finite numbers (got ${JSON.stringify(sphere.center)})`)
    }
    if (!Number.isFinite(sphere.radius) || sphere.radius <= 0) {
      throw new Error(`rune/particles: a collision sphere radius must be a finite > 0 (got ${sphere.radius})`)
    }
    if (!Number.isFinite(sphere.restitution) || sphere.restitution < 0 || sphere.restitution > 1) {
      throw new Error(`rune/particles: sphere restitution must be in [0, 1] (got ${sphere.restitution})`)
    }
    const fr = sphere.friction ?? 0
    if (!Number.isFinite(fr) || fr < 0 || fr > 1) {
      throw new Error(`rune/particles: sphere friction must be in [0, 1] (got ${fr})`)
    }
    if (sphere.kill !== undefined && typeof sphere.kill !== 'boolean') {
      throw new Error(`rune/particles: sphere kill must be a boolean (got ${JSON.stringify(sphere.kill)})`)
    }
  }
  // Task 128 — the boxes: center/half/restitution/friction/kill.
  for (const box of collide.boxes ?? []) {
    if (!Array.isArray(box.center) || box.center.length !== 3 || !box.center.every((v: number) => Number.isFinite(v))) {
      throw new Error(`rune/particles: a collision box center must be three finite numbers (got ${JSON.stringify(box.center)})`)
    }
    if (!Array.isArray(box.half) || box.half.length !== 3 || !box.half.every((v: number) => Number.isFinite(v) && v > 0)) {
      throw new Error(`rune/particles: a collision box half must be three finite numbers > 0 (got ${JSON.stringify(box.half)}; [1.6, 0.9, 1.6] = a 3.2×1.8×3.2 crate)`)
    }
    if (!Number.isFinite(box.restitution) || box.restitution < 0 || box.restitution > 1) {
      throw new Error(`rune/particles: box restitution must be in [0, 1] (got ${box.restitution})`)
    }
    const fr = box.friction ?? 0
    if (!Number.isFinite(fr) || fr < 0 || fr > 1) {
      throw new Error(`rune/particles: box friction must be in [0, 1] (got ${fr})`)
    }
    if (box.kill !== undefined && typeof box.kill !== 'boolean') {
      throw new Error(`rune/particles: box kill must be a boolean (got ${JSON.stringify(box.kill)})`)
    }
  }
  // Task 124 — the contact-event hook: a function, or absent.
  if (collide.onCollide !== undefined && typeof collide.onCollide !== 'function') {
    throw new Error(`rune/particles: collide.onCollide must be a function (got ${typeof collide.onCollide}; called per contact after the integration walk — the splash hook)`)
  }
  return collide
}

/** Seek validation. */
export function validateSeek(seek: SeekForce | null | undefined): SeekForce | null {
  if (seek === undefined || seek === null) return null
  if (!Number.isFinite(seek.strength) || seek.strength <= 0) {
    throw new Error(`rune/particles: seek.strength must be a finite > 0 (got ${seek.strength})`)
  }
  if (!Number.isFinite(seek.damping) || seek.damping < 0) {
    throw new Error(`rune/particles: seek.damping must be a finite >= 0 (got ${seek.damping}; ≈ 2·√strength is critically damped)`)
  }
  return seek
}

/** LimitSpeed validation (the over-life speed limiter). */
export function validateLimitSpeed(ls: LimitSpeedForce | null | undefined): LimitSpeedForce | null {
  if (ls === undefined || ls === null) return null
  if (!Number.isFinite(ls.limit) || ls.limit < 0) {
    throw new Error(`rune/particles: limitSpeed.limit must be a finite >= 0 (got ${ls.limit})`)
  }
  if (!Number.isFinite(ls.dampen) || ls.dampen < 0 || ls.dampen > 1) {
    throw new Error(`rune/particles: limitSpeed.dampen must be in [0, 1] (got ${ls.dampen}; their dampen)`)
  }
  return ls
}

/** Inheritance validation: a finite fraction >= 0 (1 = fully riding the
 *  emitter; > 1 = overshoot — allowed, it reads as a slingshot). */
export function validateInherit(k: number | undefined): number {
  if (k === undefined) return 0
  if (!Number.isFinite(k) || k < 0) {
    throw new Error(`rune/particles: inheritVelocity must be a finite >= 0 (got ${k}; the fraction of the emitter's velocity a newborn rides)`)
  }
  return k
}

/** Rate-over-distance validation: particles per world unit, finite >= 0. */
export function validateRateOverDistance(r: number | undefined): number {
  if (r === undefined) return 0
  if (!Number.isFinite(r) || r < 0) {
    throw new Error(`rune/particles: rateOverDistance must be a finite >= 0 (got ${r}; particles per world unit the emitter travels)`)
  }
  return r
}

/** Wrap validation: three finite sizes >= 0 (0 disables the axis). */
export function validateWrap(wrap: WrapDesc | undefined): [number, number, number] | null {
  if (wrap === undefined || wrap === null) return null
  const size = wrap.size
  if (!Array.isArray(size) || size.length !== 3 || !size.every((v: number) => Number.isFinite(v) && v >= 0)) {
    throw new Error(`rune/particles: wrap.size must be three finite numbers >= 0, 0 disables the axis (got ${JSON.stringify(size)})`)
  }
  return [size[0], size[1], size[2]]
}

/** Burst validation. */
export function validateBurst(burst: BurstDesc): BurstDesc {
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
