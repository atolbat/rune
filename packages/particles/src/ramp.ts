/**
 * @rune/particles — the over-life appearance ramps.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * A ramp is a small table of control points sorted by t = age/life; the
 * sampler lerps between the neighbors (binary search — the clip-sampling
 * pattern of @rune/animation). The sampled tuple is (size, r, g, b, a)
 * written into the CALLER's scratch — sampling allocates nothing.
 *
 * The particle's spawn tint multiplies the ramp color; the spawn size
 * multiplies the ramp size. A one-point ramp is a constant (the default).
 * ══════════════════════════════════════════════════════════════════════════
 */

/** One control point: everything the billboard needs at normalized age t. */
export interface RampPoint {
  readonly t: number
  /** Size multiplier at t (the spawn size scales it). */
  readonly size: number
  /** Color multiplier at t, rgba (the spawn tint scales it). */
  readonly r: number
  readonly g: number
  readonly b: number
  readonly a: number
  /** ATLAS FRAME index at t (the sprite sheet tile — the
   *  FrameOverLife). Interpolated linearly between the points, floored
   *  by the baker. Omitted points interpolate from the neighbors (0 when
   *  no point carries a frame). Default: no frames — the full sprite. */
  readonly frame?: number
}

/** The compiled ramp: points sorted by t, at least one. */
export interface Ramp {
  readonly points: readonly RampPoint[]
}

/** The identity ramp (a constant 1 × white — a one-point table). */
export const CONSTANT_RAMP: Ramp = { points: [{ t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 }] }

/** Floats the sampler writes: size, rgba, frame (Task 122 — the atlas
 *  channel). Every caller's scratch is AT LEAST this long. */
export const RAMP_STRIDE = 6

/** Task 131 — the compiled flat form: one Float64Array of N rows
 *  [t, size, r, g, b, a, frame], cached per Ramp OBJECT (the hot
 *  per-particle loops read flat doubles, not property chains — the
 *  ramp costs ~40% less in the pack/bake walks). The values are the
 *  points' own (read once); the sampler's expressions are unchanged —
 *  bit-identical results. */
const COMPILED = new WeakMap<Ramp, Float64Array>()
export function flatRamp(ramp: Ramp): Float64Array {
  let flat = COMPILED.get(ramp)
  if (flat === undefined) {
    const pts = ramp.points
    flat = new Float64Array(pts.length * 7)
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]
      const b = i * 7
      flat[b] = p.t; flat[b + 1] = p.size
      flat[b + 2] = p.r; flat[b + 3] = p.g; flat[b + 4] = p.b; flat[b + 5] = p.a
      flat[b + 6] = p.frame ?? 0
    }
    COMPILED.set(ramp, flat)
  }
  return flat
}

/** Validates (finite, t ascending within [0, 1] after clamping, at least
 *  one point) and returns the compiled ramp. The input is NOT copied:
 *  treat the points as immutable from here on. */
export function createRamp(points: readonly RampPoint[]): Ramp {
  if (points.length === 0) throw new Error('rune/particles: a ramp needs at least one control point')
  let prev = -Infinity
  for (const p of points) {
    const t = p.t
    if (!Number.isFinite(t + p.size + p.r + p.g + p.b + p.a)) {
      throw new Error('rune/particles: ramp control points must be finite')
    }
    if (p.frame !== undefined && !Number.isFinite(p.frame)) {
      throw new Error('rune/particles: ramp frame must be finite (the atlas tile index)')
    }
    if (t < 0 || t > 1) throw new Error(`rune/particles: ramp t must be in [0, 1] (got ${t})`)
    if (t <= prev) throw new Error('rune/particles: ramp control points must be sorted by ascending t')
    prev = t
  }
  return { points }
}

/** Samples the ramp at t (clamped to [first.t, last.t]): linear
 *  interpolation between the neighbors, exact at the points. Writes
 *  out[0]=size, out[1..4]=rgba, out[5]=frame. `out` is the caller's
 *  6-float scratch (RAMP_STRIDE) — no allocation. Zero allocations;
 *  ~log(n) per sample (the flat cached form: no property loads). */
export function sampleRamp(ramp: Ramp, t: number, out: Float32Array | number[]): void {
  const flat = flatRamp(ramp)
  const n = flat.length / 7
  if (n === 1) {
    out[0] = flat[1]; out[1] = flat[2]; out[2] = flat[3]; out[3] = flat[4]; out[4] = flat[5]; out[5] = flat[6]
    return
  }
  // Clamp outside the table (before the first / after the last point).
  if (t <= flat[0]) {
    out[0] = flat[1]; out[1] = flat[2]; out[2] = flat[3]; out[3] = flat[4]; out[4] = flat[5]; out[5] = flat[6]
    return
  }
  const last = (n - 1) * 7
  if (t >= flat[last]) {
    out[0] = flat[last + 1]; out[1] = flat[last + 2]; out[2] = flat[last + 3]; out[3] = flat[last + 4]; out[4] = flat[last + 5]; out[5] = flat[last + 6]
    return
  }
  // Binary search: the interval (i-1, i] brackets t.
  let lo = 0, hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (flat[mid * 7] <= t) lo = mid
    else hi = mid
  }
  const a = lo * 7, b = hi * 7
  const span = flat[b] - flat[a]
  const k = span > 0 ? (t - flat[a]) / span : 0
  out[0] = flat[a + 1] + (flat[b + 1] - flat[a + 1]) * k
  out[1] = flat[a + 2] + (flat[b + 2] - flat[a + 2]) * k
  out[2] = flat[a + 3] + (flat[b + 3] - flat[a + 3]) * k
  out[3] = flat[a + 4] + (flat[b + 4] - flat[a + 4]) * k
  out[4] = flat[a + 5] + (flat[b + 5] - flat[a + 5]) * k
  out[5] = flat[a + 6] + (flat[b + 6] - flat[a + 6]) * k
}
