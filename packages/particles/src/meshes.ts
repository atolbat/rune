/**
 * @rune/particles — mesh particles: a real 3D geometry per particle
 * (three.quarks' RenderMode.Mesh with instancingGeometry).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Each particle bakes a FULL triangle-soup geometry (a capsule, a platonic
 * solid — anything with positions + normals + uvs) at its position, with
 * its per-particle rotation (the oriented machinery: a fixed or seed-random
 * axis + seed·τ + age·spin) and its ramped scale/tint. The soup carries a
 * NORMAL attribute — the LIT materials (@rune/materials LAMBERT/PBR) shade
 * real mesh particles.
 *
 * THE LAYOUT (STRIDE = 12 floats, 48 B per vertex):
 *   [0..2] position   — world-space: p + R·(g·scale)
 *   [3..5] normal     — R·n (the rotation carries the lighting)
 *   [6..7] uv         — the geometry's uv
 *   [8..11] color     — tint × ramp
 *
 * No instancing, no per-instance buffers — the same "bake the soup CPU-side
 * once per frame" philosophy as the billboards: one interleaved array,
 * plain vertex attributes, identical on WebGL2 and WebGPU. The price: the
 * soup is geometry.vertexCount × capacity verts — keep the geometry SMALL
 * (a 240-vert capsule, not a 3.6k-vert one).
 *
 * The geometry contract: a plain triangle soup (no index) — @rune/prims'
 * Geometry shape {positions, normals, uvs, vertexCount} satisfies it
 * structurally (no dependency — the demo passes prims.capsule()).
 * ══════════════════════════════════════════════════════════════════════════
 */

import type { ParticleSystem } from './system.ts'
import { sampleRamp, CONSTANT_RAMP, type Ramp } from './ramp.ts'

/** Floats per vertex (position 3, normal 3, uv 2, color 4). */
export const MESH_STRIDE = 12

/** The source geometry: a plain triangle soup (the prims Geometry shape). */
export interface MeshGeometry {
  readonly positions: Float32Array
  readonly normals?: Float32Array
  readonly uvs?: Float32Array
  readonly vertexCount: number
}

/** The mesh baker options. */
export interface MeshOptions {
  /** The over-life ramp (size + color). Default: the constant identity. */
  readonly ramp?: Ramp
  /** The rotation axis — [x, y, z] (any length; normalized once) or
   *  'random' (a per-particle axis from the seed). Default 'random'. */
  readonly axis?: readonly number[] | 'random'
  /** The 3D spin speed, radians/second (the seed phases it). */
  readonly spin?: number
}

/** The shared ramp scratch. */
const SCRATCH = new Float32Array(6)

/** Bakes the mesh particles into `out` (a Float32Array of at least
 *  capacity × vertexCount × 12 floats). Returns the vertex count.
 *  Deterministic: the same (store state, options) writes the same bytes. */
export function fillMeshes(
  system: ParticleSystem,
  geometry: MeshGeometry,
  out: Float32Array,
  options: MeshOptions = {},
): number {
  const ramp = options.ramp ?? CONSTANT_RAMP
  const spin = options.spin ?? 0
  const axisOpt = options.axis ?? 'random'
  const f = system.fields
  const count = system.count
  const g = geometry.positions
  const gn = geometry.normals ?? null
  const gu = geometry.uvs ?? null
  const vCount = geometry.vertexCount
  if (g.length < vCount * 3) {
    throw new Error(`rune/particles: mesh geometry positions too short (${g.length} floats for ${vCount} verts)`)
  }
  const s = SCRATCH

  let oax = 0, oay = 0, oaz = 1
  const axisRandom = axisOpt === 'random'
  if (!axisRandom) {
    const a = axisOpt as readonly number[]
    const al = Math.hypot(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0)
    if (al < 1e-12 || !Number.isFinite(al)) {
      throw new Error('rune/particles: the mesh axis must be a finite non-zero vector')
    }
    oax = (a[0] ?? 0) / al; oay = (a[1] ?? 0) / al; oaz = (a[2] ?? 0) / al
  }

  let at = 0
  for (let i = 0; i < count; i++) {
    const t = f.life[i] > 0 ? f.age[i] / f.life[i] : 0
    sampleRamp(ramp, t, s)
    const scale = f.size[i] * s[0]
    if (scale <= 0) continue
    const cr = f.cr[i] * s[1], cg = f.cg[i] * s[2], cb = f.cb[i] * s[3], ca = f.ca[i] * s[4]
    const px = f.px[i], py = f.py[i], pz = f.pz[i]

    // The per-particle axis + angle (the oriented machinery).
    let ax2 = oax, ay2 = oay, az2 = oaz
    if (axisRandom) {
      const sd = f.seed[i]
      const s1 = sd * 7.31 - Math.floor(sd * 7.31)
      const s2 = sd * 3.77 - Math.floor(sd * 3.77)
      const zc = 1 - 2 * s1
      const rc = Math.sqrt(Math.max(0, 1 - zc * zc))
      const phi = 6.283185307179586 * s2
      ax2 = rc * Math.cos(phi); ay2 = rc * Math.sin(phi); az2 = zc
    }
    const ang = f.seed[i] * 6.283185307179586 + f.age[i] * spin
    const c = Math.cos(ang), sn = Math.sin(ang), tt = 1 - c
    // The full rotation matrix R (axis-angle) — the normals need all of it.
    const m00 = tt * ax2 * ax2 + c, m01 = tt * ax2 * ay2 - sn * az2, m02 = tt * ax2 * az2 + sn * ay2
    const m10 = tt * ax2 * ay2 + sn * az2, m11 = tt * ay2 * ay2 + c, m12 = tt * ay2 * az2 - sn * ax2
    const m20 = tt * ax2 * az2 - sn * ay2, m21 = tt * ay2 * az2 + sn * ax2, m22 = tt * az2 * az2 + c

    for (let v = 0; v < vCount; v++) {
      const b3 = v * 3
      const gx = g[b3], gy = g[b3 + 1], gz = g[b3 + 2]
      out[at] = px + (m00 * gx + m01 * gy + m02 * gz) * scale
      out[at + 1] = py + (m10 * gx + m11 * gy + m12 * gz) * scale
      out[at + 2] = pz + (m20 * gx + m21 * gy + m22 * gz) * scale
      if (gn !== null) {
        out[at + 3] = m00 * gn[b3] + m01 * gn[b3 + 1] + m02 * gn[b3 + 2]
        out[at + 4] = m10 * gn[b3] + m11 * gn[b3 + 1] + m12 * gn[b3 + 2]
        out[at + 5] = m20 * gn[b3] + m21 * gn[b3 + 1] + m22 * gn[b3 + 2]
      } else {
        // No normals: the LIT materials require them; emit +Z so the
        // shader compiles (an unlit material ignores the attribute anyway).
        out[at + 3] = 0; out[at + 4] = 0; out[at + 5] = 1
      }
      if (gu !== null) {
        out[at + 6] = gu[v * 2]; out[at + 7] = gu[v * 2 + 1]
      } else {
        out[at + 6] = 0; out[at + 7] = 0
      }
      out[at + 8] = cr; out[at + 9] = cg; out[at + 10] = cb; out[at + 11] = ca
      at += MESH_STRIDE
    }
  }
  return at / MESH_STRIDE
}
