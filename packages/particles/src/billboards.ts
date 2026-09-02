/**
 * @rune/particles — the billboard soup: the GPU view of the particle store.
 *
 * ════════════════════════════════════════════════════════════════════════
 * One camera-facing quad (6 vertices, 2 triangles) per particle, baked
 * CPU-side into ONE reused Float32Array — the draw command consumes the
 * soup as plain vertex attributes (position, uv, color), no instancing,
 * no geometry shader, no per-pipeline surprises on either backend.
 *
 * Vertex layout (STRIDE = 9 floats):
 *   [0..2] position  — world-space, p + right·ox + up·oy (billboarded)
 *   [3..4] uv        — the sprite atlas corner (0..1)
 *   [5..8] color     — spawn tint × ramp: rgb × rgb, a × a
 *
 * The rotation: each quad spins in its own plane by
 *   angle = seed·τ + age·spinSpeed
 * (seed phases the particles apart; spinSpeed is a scalar of the view).
 *
 * PERFORMANCE: zero allocations — the out array is caller-owned (the
 * facade allocates it once at capacity), the ramp scratch is one shared
 * 5-float array, all locals are hoisted. fillBillboards returns the
 * VERTEX COUNT (6 × live particles).
 * ════════════════════════════════════════════════════════════════════════
 */

import type { ParticleSystem } from './system.ts'
import { sampleRamp, CONSTANT_RAMP, type Ramp } from './ramp.ts'

/** Floats per vertex (position 3, uv 2, color 4). */
export const SOUP_STRIDE = 9
/** Vertices per particle (two triangles). */
export const VERTS_PER_PARTICLE = 6

/** The camera basis for billboarding: two unit world-space vectors
 *  (right, up) — typically column 0 and 1 of the view matrix, negated
 *  appropriately. The quad plane is ⊥ the view direction by construction. */
export interface CameraBasis {
  readonly right: readonly number[]
  readonly up: readonly number[]
}

/** The billboard view options. */
export interface BillboardOptions {
  /** The over-life ramp (size + color); default: the constant identity. */
  readonly ramp?: Ramp
  /** The spin speed, radians/second (the seed phases each particle). */
  readonly spin?: number
}

/** Bakes the live particles into `out` (a Float32Array of at least
 *  capacity × 54 floats). Returns the vertex count. Deterministic:
 *  the same (store state, basis, options) writes the same bytes. */
export function fillBillboards(
  system: ParticleSystem,
  basis: CameraBasis,
  out: Float32Array,
  options: BillboardOptions = {},
): number {
  const ramp = options.ramp ?? CONSTANT_RAMP
  const spin = options.spin ?? 0
  const f = system.fields
  const count = system.count
  const rx = basis.right[0], ry = basis.right[1], rz = basis.right[2]
  const ux = basis.up[0], uy = basis.up[1], uz = basis.up[2]
  // The ramp scratch — ONE array shared by every particle in this pass.
  const s: Float32Array = SCRATCH

  let at = 0
  for (let i = 0; i < count; i++) {
    const age = f.age[i]
    const life = f.life[i]
    const t = life > 0 ? age / life : 0
    sampleRamp(ramp, t, s)
    // The final size: the spawn size × the ramp multiplier; the half-extent.
    const half = f.size[i] * s[0] * 0.5
    if (half <= 0) continue // a zero-size particle emits no quad
    // The color: tint × ramp (rgb × rgb, a × a).
    const cr = f.cr[i] * s[1], cg = f.cg[i] * s[2], cb = f.cb[i] * s[3], ca = f.ca[i] * s[4]
    const px = f.px[i], py = f.py[i], pz = f.pz[i]

    // The in-plane rotation (seed phases, spin advances).
    let c1 = 1, s1 = 0, c2 = 0, s2 = 1
    if (spin !== 0 || f.seed[i] !== 0) {
      const ang = f.seed[i] * 6.283185307179586 + age * spin
      const cos = Math.cos(ang), sin = Math.sin(ang)
      // Corner (a, b) ∈ {(-1,-1),(1,-1),(1,1),(-1,1)} rotated by ang.
      c1 = cos; s1 = sin; c2 = -sin; s2 = cos
    }

    // The four rotated corner offsets (world space), shared by the 2 tris.
    // corners: 0 = (-1,-1), 1 = (1,-1), 2 = (1,1), 3 = (-1,1)
    const o0x = (c1 * -half + c2 * -half), o0y = (s1 * -half + s2 * -half)
    const o1x = (c1 * half + c2 * -half), o1y = (s1 * half + s2 * -half)
    const o2x = (c1 * half + c2 * half), o2y = (s1 * half + s2 * half)
    const o3x = (c1 * -half + c2 * half), o3y = (s1 * -half + s2 * half)

    // Triangle 1: corners 0, 1, 2. Triangle 2: corners 0, 2, 3.
    // (Same winding for both — CCW in the right/up plane.)
    at = vert(out, at, px + o0x * rx + o0y * ux, py + o0x * ry + o0y * uy, pz + o0x * rz + o0y * uz, 0, 0, cr, cg, cb, ca)
    at = vert(out, at, px + o1x * rx + o1y * ux, py + o1x * ry + o1y * uy, pz + o1x * rz + o1y * uz, 1, 0, cr, cg, cb, ca)
    at = vert(out, at, px + o2x * rx + o2y * ux, py + o2x * ry + o2y * uy, pz + o2x * rz + o2y * uz, 1, 1, cr, cg, cb, ca)
    at = vert(out, at, px + o0x * rx + o0y * ux, py + o0x * ry + o0y * uy, pz + o0x * rz + o0y * uz, 0, 0, cr, cg, cb, ca)
    at = vert(out, at, px + o2x * rx + o2y * ux, py + o2x * ry + o2y * uy, pz + o2x * rz + o2y * uz, 1, 1, cr, cg, cb, ca)
    at = vert(out, at, px + o3x * rx + o3y * ux, py + o3x * ry + o3y * uy, pz + o3x * rz + o3y * uz, 0, 1, cr, cg, cb, ca)
  }
  return at / SOUP_STRIDE
}

/** The module-level ramp scratch (the memory contract: no per-call
 *  allocation — one 5-float array serves every fillBillboards call;
 *  the write happens before the read, single-threaded by contract). */
const SCRATCH = new Float32Array(5)

/** Writes one vertex at float offset `at`, returns the next offset. */
function vert(
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
