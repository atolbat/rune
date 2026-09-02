/**
 * UV sphere (latitude/longitude): widthSegments × heightSegments quads
 * (Task 109: parameter names — like SphereGeometry in three.js; previously
 * segments/rings), analytical (radial) normals. The bands j=0 (φ=0, north)
 * and j=bands−1 (φ=π, south) are collapsed into a pole: their half-quad
 * with TWO pole vertices (zero area) is discarded, the second one is
 * emitted — pole fans without degenerate triangles.
 *
 * Task 108 BUG (hole at the pole): the loop went to bands−1 — the last
 * band (up to φ=π) was NOT emitted at all. Fix: full loop j < bands, the
 * pole is exactly the extreme bands.
 */

import type { Geometry } from './types.ts'

export interface SphereParams {
  /** Radius (default 1). */
  readonly radius?: number
  /** Segments along longitude (around the Y axis, default 48). */
  readonly widthSegments?: number
  /** Bands along latitude (pole → pole, default 32). */
  readonly heightSegments?: number
}

export function sphere(params: SphereParams = {}): Geometry {
  const radius = params.radius ?? 1
  const radial = Math.max(3, Math.floor(params.widthSegments ?? 48))
  const bands = Math.max(2, Math.floor(params.heightSegments ?? 32))
  // Full bands (bands−2) with 2 triangles each + 2 pole fans of radial —
  // exactly (bands−1)·radial quad equivalents (exact prealloc)
  const quads = (bands - 1) * radial
  const positions = new Float32Array(quads * 6 * 3)
  const normals = new Float32Array(quads * 6 * 3)
  const uvs = new Float32Array(quads * 6 * 2)
  let v = 0
  const emit = (phi: number, theta: number, u: number, vv: number): void => {
    const sinPhi = Math.sin(phi)
    const nx = sinPhi * Math.sin(theta)
    const ny = Math.cos(phi)
    const nz = sinPhi * Math.cos(theta)
    positions[v * 3] = nx * radius
    positions[v * 3 + 1] = ny * radius
    positions[v * 3 + 2] = nz * radius
    normals[v * 3] = nx
    normals[v * 3 + 1] = ny
    normals[v * 3 + 2] = nz
    uvs[v * 2] = u
    uvs[v * 2 + 1] = vv
    v++
  }
  for (let j = 0; j < bands; j++) {
    const phi0 = (j / bands) * Math.PI // 0 = north pole (+Y)
    const phi1 = ((j + 1) / bands) * Math.PI
    const northPole = j === 0 // phi0 = 0: the entire pole row is ONE point
    const southPole = j === bands - 1 // phi1 = π: the bottom row collapses
    for (let i = 0; i < radial; i++) {
      const t0 = (i / radial) * Math.PI * 2
      const t1 = ((i + 1) / radial) * Math.PI * 2
      const u0 = i / radial
      const u1 = (i + 1) / radial
      // CCW from outside; half-quads collapsing into a pole point
      // (both vertices at the pole — zero area) are skipped
      if (!southPole) {
        emit(phi1, t0, u0, (j + 1) / bands)
        emit(phi1, t1, u1, (j + 1) / bands)
        emit(phi0, t1, u1, j / bands)
      }
      if (!northPole) {
        emit(phi1, t0, u0, (j + 1) / bands)
        emit(phi0, t1, u1, j / bands)
        emit(phi0, t0, u0, j / bands)
      }
    }
  }
  return { positions, normals, uvs, vertexCount: v }
}
