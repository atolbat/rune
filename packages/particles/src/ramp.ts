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
 *  ~log(n) per sample. */
export function sampleRamp(ramp: Ramp, t: number, out: Float32Array | number[]): void {
  const pts = ramp.points
  const n = pts.length
  if (n === 1) {
    const p = pts[0]
    out[0] = p.size; out[1] = p.r; out[2] = p.g; out[3] = p.b; out[4] = p.a; out[5] = p.frame ?? 0
    return
  }
  // Clamp outside the table (before the first / after the last point).
  if (t <= pts[0].t) {
    const p = pts[0]
    out[0] = p.size; out[1] = p.r; out[2] = p.g; out[3] = p.b; out[4] = p.a; out[5] = p.frame ?? 0
    return
  }
  if (t >= pts[n - 1].t) {
    const p = pts[n - 1]
    out[0] = p.size; out[1] = p.r; out[2] = p.g; out[3] = p.b; out[4] = p.a; out[5] = p.frame ?? 0
    return
  }
  // Binary search: the interval (i-1, i] brackets t.
  let lo = 0, hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (pts[mid].t <= t) lo = mid
    else hi = mid
  }
  const a = pts[lo], b = pts[hi]
  const span = b.t - a.t
  const k = span > 0 ? (t - a.t) / span : 0
  out[0] = a.size + (b.size - a.size) * k
  out[1] = a.r + (b.r - a.r) * k
  out[2] = a.g + (b.g - a.g) * k
  out[3] = a.b + (b.b - a.b) * k
  out[4] = a.a + (b.a - a.a) * k
  out[5] = (a.frame ?? 0) + ((b.frame ?? 0) - (a.frame ?? 0)) * k
}
