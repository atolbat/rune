/**
 * @rune/particles — trails: the ribbon view (three.quarks' RenderMode.Trail).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * A trail is a RIBBON following each particle: a decimated history of past
 * positions (one point every `step` seconds — not every frame: 24 points
 * at 30 Hz cover ~0.8 s of motion) + the current position as the head.
 * The baker walks the history back, stops at `length` world units behind
 * the head (their startLength), tapers the width and the alpha to zero at
 * the tail, and emits two verts per point (± side·width) — the same
 * pos3/uv2/color4 soup as the billboards, the same material and pipelines.
 *
 * SLOT IDENTITY: the store compacts by swap-remove, so a slot's particle
 * CHANGES identity on every death. The trails follow via the store's
 * onSwap hook (history follows its particle), and a newborn (age ≤ dt) or
 * an age regression resets the slot to a single point. The facade wires
 * the hook automatically for render kind 'trail'; the composable core
 * passes { onSwap: trails.handleSwap } to createParticleSystem.
 *
 * MEMORY: the history is capacity × points × 3 floats, allocated ONCE;
 * the per-frame record walk is branch-light, allocation-free. The ribbon
 * soup is caller-owned (the facade allocates capacity × points × 6 verts
 * — the worst case: every particle with a full history).
 * ══════════════════════════════════════════════════════════════════════════
 */

import type { ParticleSystem } from './system.ts'
import { SOUP_STRIDE } from './billboards.ts'
import { sampleRamp, CONSTANT_RAMP, type Ramp } from './ramp.ts'

/** The trail history options. */
export interface TrailOptions {
  /** History points per particle (default 24). The ribbon shows at most
   *  points + 1 positions (the recorded history + the live head). */
  readonly points?: number
  /** The sampling step, seconds (default 1/30). One history point per step
   *  — the decimation that keeps the memory flat and the ribbon smooth. */
  readonly step?: number
}

/** The trail history: per-slot ring buffers of past positions. */
export interface TrailHistory {
  readonly points: number
  readonly step: number
  /** Flat capacity × points × 3 (x, y, z per point). Read by fillTrails. */
  readonly hx: Float32Array
  /** Per-slot ring head (0..points-1) and live point count. */
  readonly heads: Uint16Array
  readonly counts: Uint16Array
  /** Records the live particles' positions (call after system.advance). */
  record(system: ParticleSystem, dt: number): void
  /** The store's onSwap handler — the history follows its particle. */
  handleSwap(to: number, from: number): void
}

/** Creates the history. `capacity` must match the particle store's. */
export function createTrailHistory(capacity: number, options: TrailOptions = {}): TrailHistory {
  const points = options.points ?? 24
  const step = options.step ?? 1 / 30
  if (!Number.isInteger(points) || points < 2 || points > 1024) {
    throw new Error(`rune/particles: trail points must be an integer in [2, 1024] (got ${points})`)
  }
  if (!Number.isFinite(step) || step <= 0) {
    throw new Error(`rune/particles: trail step must be a finite > 0 (got ${step})`)
  }
  const hx = new Float32Array(capacity * points * 3)
  const heads = new Uint16Array(capacity)
  const counts = new Uint16Array(capacity)
  const lastAge = new Float32Array(capacity)
  let acc = 0 // the shared sampling accumulator

  const stride = points * 3

  return {
    points,
    step,
    hx,
    heads,
    counts,

    record(system, dt) {
      const f = system.fields
      const n = system.count
      // The sampling cadence: one record per step, at most one per frame
      // (dt > step decimates to the frame rate — a slow machine shows
      // shorter trails, never a lag explosion).
      acc += dt
      let doRecord = false
      if (acc >= step) {
        acc = acc > step * 4 ? step : acc // a long stall re-anchors the phase
        doRecord = true
        acc -= step
      }
      for (let i = 0; i < n; i++) {
        const age = f.age[i]
        // The slot identity guards: a newborn (its FIRST advance — the age
        // is exactly one dt) or an age regression (a recycled slot the
        // swap hook could not catch, e.g. a fresh spawn into a stale slot).
        if (age <= dt + 1e-6 || age < lastAge[i] - 1e-6) {
          heads[i] = 0
          counts[i] = 1
          const b = i * stride
          hx[b] = f.px[i]; hx[b + 1] = f.py[i]; hx[b + 2] = f.pz[i]
          lastAge[i] = age
          continue
        }
        lastAge[i] = age
        if (counts[i] === 0) {
          // A particle that predates the history (attached mid-flight):
          // seed the head so the trail starts HERE.
          heads[i] = 0
          counts[i] = 1
          const b = i * stride
          hx[b] = f.px[i]; hx[b + 1] = f.py[i]; hx[b + 2] = f.pz[i]
        }
        if (doRecord) {
          const head = (heads[i] + 1) % points
          heads[i] = head
          if (counts[i] < points) counts[i]++
          const b = i * stride + head * 3
          hx[b] = f.px[i]; hx[b + 1] = f.py[i]; hx[b + 2] = f.pz[i]
        }
      }
    },

    handleSwap(to, from) {
      if (to === from) return
      // The whole ring follows its particle: positions, head, count, age.
      const src = from * stride
      const dst = to * stride
      for (let k = 0; k < stride; k++) hx[dst + k] = hx[src + k]
      heads[to] = heads[from]
      counts[to] = counts[from]
      lastAge[to] = lastAge[from]
    },
  }
}

/** The trail baker options. */
export interface TrailBakeOptions {
  /** The over-life ramp (the color story of the trail; the size channel
   *  scales the head width). Default: the constant identity. */
  readonly ramp?: Ramp
  /** The trail length cap, world units behind the head (their
   *  startLength). The ribbon never extends past it. Default Infinity. */
  readonly length?: number
  /** The head width = size · rampSize · width (tapers to 0 at the tail).
   *  Default 1. */
  readonly width?: number
}

/** The shared ramp scratch (the module's allocation-free contract). */
const SCRATCH = new Float32Array(6)

/** Bakes the trails into `out` (a Float32Array of at least
 *  capacity × points × 6 × 9 floats). Returns the vertex count.
 *  `basis.forward` (the unit look direction) is REQUIRED — the ribbon
 *  sides are perpendicular to the motion AND the view. */
export function fillTrails(
  system: ParticleSystem,
  history: TrailHistory,
  basis: { forward: readonly number[] },
  out: Float32Array,
  options: TrailBakeOptions = {},
): number {
  const ramp = options.ramp ?? CONSTANT_RAMP
  const lengthCap = options.length ?? Infinity
  const widthK = options.width ?? 1
  const f = system.fields
  const count = system.count
  const points = history.points
  const { hx, heads, counts } = history
  const stride = points * 3
  const fx = basis.forward[0], fy = basis.forward[1], fz = basis.forward[2]
  const s = SCRATCH

  let at = 0
  for (let i = 0; i < count; i++) {
    const histCount = counts[i]
    if (histCount < 1) continue // 1 recorded point + the live head = the
    // minimum 2-point ribbon; 0 points = nothing to span
    const t = f.life[i] > 0 ? f.age[i] / f.life[i] : 0
    sampleRamp(ramp, t, s)
    const halfW = Math.max(0, f.size[i] * s[0] * widthK * 0.5)
    if (halfW <= 0) continue
    const headX = f.px[i], headY = f.py[i], headZ = f.pz[i]
    const cr = f.cr[i] * s[1], cg = f.cg[i] * s[2], cb = f.cb[i] * s[3], ca = f.ca[i] * s[4]

    // Walk the history newest → oldest, collecting the ribbon points
    // within the length cap. point 0 = the live head; point k = the k-th
    // recorded position back.
    // The K bound: histCount recorded + the head, but never more than
    // points + 1 points total.
    const maxK = Math.min(histCount, points)
    let K = 0
    for (let k = 1; k <= maxK; k++) {
      const idx = (heads[i] - (k - 1) + points * 2) % points
      const b = i * stride + idx * 3
      const dxx = hx[b] - headX, dyy = hx[b + 1] - headY, dzz = hx[b + 2] - headZ
      if (Math.hypot(dxx, dyy, dzz) > lengthCap) break
      K = k
    }
    if (K < 1) continue // only the head is within the cap — nothing to span

    // The ribbon points: PX[k] for k = 0..K (0 = the live head).
    // The side vector per SEGMENT (k → k+1) — but consecutive segments
    // share verts, so we evaluate the side per POINT (the average
    // direction around it) for a smooth ribbon: dir(k) = normalize(p[k+1]
    // − p[k−1]) (the central difference; the ends use one-sided).
    // Emission: for each segment, two triangles between the ±side verts.
    // PREV point tracking (the flat scratch — no allocations):
    let prevX = headX, prevY = headY, prevZ = headZ
    let prevSX = 0, prevSY = 0, prevSZ = 0, prevW = 0
    let prevValid = false
    for (let k = 1; k <= K; k++) {
      const idx = (heads[i] - (k - 1) + points * 2) % points
      const b = i * stride + idx * 3
      const curX = hx[b], curY = hx[b + 1], curZ = hx[b + 2]
      // The next point (for the central difference) — k+1 or the curve end.
      let nextX = curX, nextY = curY, nextZ = curZ
      if (k < K) {
        const nIdx = (heads[i] - k + points * 2) % points
        const nb = i * stride + nIdx * 3
        nextX = hx[nb]; nextY = hx[nb + 1]; nextZ = hx[nb + 2]
      }
      // dir ≈ next − prev (a chord through the current point).
      let dirX = nextX - prevX, dirY = nextY - prevY, dirZ = nextZ - prevZ
      const dl = Math.hypot(dirX, dirY, dirZ)
      if (dl < 1e-9) { dirX = fx; dirY = fy; dirZ = fz }
      else { dirX /= dl; dirY /= dl; dirZ /= dl }
      // side = cross(forward, dir) — ⊥ the motion AND the view.
      let sx = fy * dirZ - fz * dirY, sy = fz * dirX - fx * dirZ, sz = fx * dirY - fy * dirX
      let sl = Math.hypot(sx, sy, sz)
      if (sl < 1e-6) { sx = dirY; sy = -dirX; sz = 0; sl = Math.hypot(sx, sy, sz) || 1 }
      sx /= sl; sy /= sl; sz /= sl
      // The taper: k/K → 0 at the tail (the k = K point vanishes).
      const w = halfW * (1 - k / K)
      // The segment between (prev, cur): emit once BOTH ends are valid.
      if (prevValid) {
        const u0 = (k - 1) / K, u1 = k / K
        const a = ca * (1 - u0 * 0.85) // the alpha fades toward the tail
        const bA = ca * (1 - u1 * 0.85)
        // L/R of the prev point and the cur point:
        const pLx = prevX - prevSX * prevW, pLy = prevY - prevSY * prevW, pLz = prevZ - prevSZ * prevW
        const pRx = prevX + prevSX * prevW, pRy = prevY + prevSY * prevW, pRz = prevZ + prevSZ * prevW
        const cLx = curX - sx * w, cLy = curY - sy * w, cLz = curZ - sz * w
        const cRx = curX + sx * w, cRy = curY + sy * w, cRz = curZ + sz * w
        // Two triangles: (pL, pR, cL) and (cL, pR, cR). cull: 'none'.
        at = tv(out, at, pLx, pLy, pLz, u0, 0, cr, cg, cb, a)
        at = tv(out, at, pRx, pRy, pRz, u0, 1, cr, cg, cb, a)
        at = tv(out, at, cLx, cLy, cLz, u1, 0, cr, cg, cb, bA)
        at = tv(out, at, cLx, cLy, cLz, u1, 0, cr, cg, cb, bA)
        at = tv(out, at, pRx, pRy, pRz, u0, 1, cr, cg, cb, a)
        at = tv(out, at, cRx, cRy, cRz, u1, 1, cr, cg, cb, bA)
      }
      prevX = curX; prevY = curY; prevZ = curZ
      prevSX = sx; prevSY = sy; prevSZ = sz
      prevW = w
      prevValid = true
    }
  }
  return at / SOUP_STRIDE
}

/** Writes one trail vertex at float offset `at`, returns the next offset. */
function tv(
  out: Float32Array,
  at: number,
  x: number, y: number, z: number,
  u: number, v: number,
  cr: number, cg: number, cb: number, ca: number,
): number {
  out[at] = x; out[at + 1] = y; out[at + 2] = z
  out[at + 3] = u; out[at + 4] = v
  out[at + 5] = cr; out[at + 6] = cg; out[at + 7] = cb; out[at + 8] = ca
  return at + SOUP_STRIDE
}
