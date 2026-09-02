/**
 * Capsule: cylinder + two hemispheres (radius r, cylindrical part length
 * height — like CapsuleGeometry in three.js), analytical normals.
 * The profile is a half-ring φ ∈ [0, π] (north pole → equator → south):
 * a ring point = (r·cosθ, y(φ), r·sinθ), normal =
 * (cosθ·sinφ, cosφ, sinθ·sinφ) — at the poles sinφ=0, the normal is
 * honestly (0, ±1, 0).
 *
 * The arrays are an exact prealloc (Task 108): the full triangle count
 * is known in advance — 2·radial·(ringCount−2).
 */

import type { Geometry } from './types.ts'

export interface CapsuleParams {
  /** Body radius (default 0.6). */
  readonly radius?: number
  /** Length of the cylindrical part (default 1.2). */
  readonly height?: number
  /** Segments around the axis (default 32). */
  readonly radialSegments?: number
  /** Bands for EACH hemisphere (default 10). */
  readonly capSegments?: number
}

export function capsule(params: CapsuleParams = {}): Geometry {
  const radius = params.radius ?? 0.6
  const length = params.height ?? 1.2
  const rr = Math.max(3, Math.floor(params.radialSegments ?? 32))
  const halfRings = Math.max(2, Math.floor(params.capSegments ?? 10))
  const half = length / 2
  const ringCount = halfRings * 2 + 1 // pole … seam … equator … seam … pole
  const triCount = 2 * rr * (ringCount - 2)
  const positions = new Float32Array(triCount * 3 * 3)
  const normals = new Float32Array(triCount * 3 * 3)
  const uvs = new Float32Array(triCount * 3 * 2)
  let v = 0
  // Profile ring k → (φ, arc y-center): upper hemisphere center +half,
  // lower −half; y(φ) = arc center ± cosφ·r
  const ring = (k: number): { sinPhi: number; cosPhi: number; y: number } => {
    const phi = (k / (ringCount - 1)) * Math.PI
    const cosPhi = Math.cos(phi)
    const sinPhi = Math.sin(phi)
    const cy = cosPhi > 0 ? half : -half
    return { sinPhi, cosPhi, y: cy + cosPhi * radius }
  }
  for (let k = 0; k < ringCount - 1; k++) {
    const a = ring(k)
    const b = ring(k + 1)
    const northPole = k === 0 // ring a is collapsed into the north pole
    const southPole = k === ringCount - 2 // ring b — into the south
    for (let i = 0; i < rr; i++) {
      const th0 = (i / rr) * Math.PI * 2
      const th1 = ((i + 1) / rr) * Math.PI * 2
      const u0 = i / rr
      const u1 = (i + 1) / rr
      const v0 = k / (ringCount - 1)
      const v1 = (k + 1) / (ringCount - 1)
      const c0 = Math.cos(th0), s0 = Math.sin(th0)
      const c1 = Math.cos(th1), s1 = Math.sin(th1)
      const ra = a.sinPhi * radius
      const rb = b.sinPhi * radius
      // CCW from outside; degenerate pole halves are skipped:
      // k=0 — ring a is collapsed (both a-vertices are the pole) → the triangle (a,a,b) is degenerate;
      // k=ringCount−2 — ring b is collapsed → the triangle (a,b,b) is degenerate
      const emit = (
        px: number, py: number, pz: number,
        nx: number, ny: number, nz: number,
        u: number, vv: number,
      ): void => {
        positions[v * 3] = px
        positions[v * 3 + 1] = py
        positions[v * 3 + 2] = pz
        normals[v * 3] = nx
        normals[v * 3 + 1] = ny
        normals[v * 3 + 2] = nz
        uvs[v * 2] = u
        uvs[v * 2 + 1] = vv
        v++
      }
      if (!northPole) {
        emit(ra * c0, a.y, ra * s0, c0 * a.sinPhi, a.cosPhi, s0 * a.sinPhi, u0, v0)
        emit(ra * c1, a.y, ra * s1, c1 * a.sinPhi, a.cosPhi, s1 * a.sinPhi, u1, v0)
        emit(rb * c1, b.y, rb * s1, c1 * b.sinPhi, b.cosPhi, s1 * b.sinPhi, u1, v1)
      }
      if (!southPole) {
        emit(ra * c0, a.y, ra * s0, c0 * a.sinPhi, a.cosPhi, s0 * a.sinPhi, u0, v0)
        emit(rb * c1, b.y, rb * s1, c1 * b.sinPhi, b.cosPhi, s1 * b.sinPhi, u1, v1)
        emit(rb * c0, b.y, rb * s0, c0 * b.sinPhi, b.cosPhi, s0 * b.sinPhi, u0, v1)
      }
    }
  }
  return { positions, normals, uvs, vertexCount: v }
}
