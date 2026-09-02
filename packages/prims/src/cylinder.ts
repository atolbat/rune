/**
 * Cylinder / cone / truncated cone: lateral surface (the radius can vary
 * smoothly along the height) + optional caps (Task 109: openEnded —
 * like CylinderGeometry in three.js). Lateral normals are analytical,
 * accounting for the profile slope (not radial!) — on a cone they point
 * away from the axis, as they should.
 *
 * radiusTop = 0 — a cone (the top ring degenerates into an apex; triangles
 * with two coincident points are discarded — the apex is emitted once per
 * segment with a correct UV).
 *
 * Task 108 BUG ("jagged barrel"): the second half of each lateral quad
 * went (P00, P11, P10) — cross(B−A, C−A) pointed INWARD. Fix: (P00, P10, P11).
 *
 * Arrays are an exact prealloc: the triangle count is known in advance.
 */

import type { Geometry } from './types.ts'

export interface CylinderParams {
  /** Radius of the top ring (default 1); 0 — a cone. */
  readonly radiusTop?: number
  /** Radius of the bottom ring (default 1). */
  readonly radiusBottom?: number
  /** Height along Y (default 2). */
  readonly height?: number
  /** Segments around the axis (default 48). */
  readonly radialSegments?: number
  /** Bands along the height (default 1). */
  readonly heightSegments?: number
  /** Without caps (default false — with caps). */
  readonly openEnded?: boolean
}

export function cylinder(params: CylinderParams = {}): Geometry {
  const rTop = params.radiusTop ?? 1
  const rBottom = params.radiusBottom ?? 1
  const height = params.height ?? 2
  const radial = Math.max(3, Math.floor(params.radialSegments ?? 48))
  const hSegs = Math.max(1, Math.floor(params.heightSegments ?? 1))
  const caps = params.openEnded !== true
  const apex = rTop <= 1e-9
  const bottomApex = rBottom <= 1e-9
  // Exact count: side + top cap + bottom cap.
  // Degenerate rings: r0=0 — only the FIRST row (the first half-quad is
  // degenerate), r1=0 — only the LAST (the second). Both zero — degenerate
  // input, an empty side.
  const sideTris = apex && bottomApex
    ? 0
    : radial * (2 * hSegs - (apex ? 1 : 0) - (bottomApex ? 1 : 0))
  const capTris = (caps && !apex ? radial : 0) + (caps && !bottomApex ? radial : 0)
  const vertexCount = (sideTris + capTris) * 3
  const positions = new Float32Array(vertexCount * 3)
  const normals = new Float32Array(vertexCount * 3)
  const uvs = new Float32Array(vertexCount * 2)
  let v = 0
  // Profile slope: dr/dy → the side normal is tilted
  const dr = (rBottom - rTop) / height
  const slopeLen = Math.hypot(1, dr)
  const nySide = dr / slopeLen
  const nrSide = 1 / slopeLen
  const emit = (
    x: number, y: number, z: number,
    nx: number, nyy: number, nz: number,
    u: number, vv: number,
  ): void => {
    positions[v * 3] = x
    positions[v * 3 + 1] = y
    positions[v * 3 + 2] = z
    normals[v * 3] = nx
    normals[v * 3 + 1] = nyy
    normals[v * 3 + 2] = nz
    uvs[v * 2] = u
    uvs[v * 2 + 1] = vv
    v++
  }
  // Side: rings along the height; a degenerate ring (radius 0) collapses
  // into an apex: ONE triangle is emitted per segment. The conditions are
  // PER ROW (the row's r0/r1), not global: with heightSegments>1 the zero
  // radius is only in the extreme row
  for (let j = 0; j < hSegs; j++) {
    const v0 = j / hSegs
    const v1 = (j + 1) / hSegs
    const y0 = -height / 2 + v0 * height
    const y1 = -height / 2 + v1 * height
    const r0 = rBottom + (rTop - rBottom) * v0
    const r1 = rBottom + (rTop - rBottom) * v1
    for (let i = 0; i < radial; i++) {
      const a0 = (i / radial) * Math.PI * 2
      const a1 = ((i + 1) / radial) * Math.PI * 2
      const u0 = i / radial
      const u1 = (i + 1) / radial
      const c0 = Math.cos(a0), s0 = Math.sin(a0)
      const c1 = Math.cos(a1), s1 = Math.sin(a1)
      // CCW from outside: both half-quads (P00→P11→P01) and (P00→P10→P11);
      // the half with the row's zero ring is degenerate — skipped
      if (r0 > 1e-9) {
        emit(r0 * c0, y0, r0 * s0, c0 * nrSide, nySide, s0 * nrSide, u0, v0)
        emit(r1 * c1, y1, r1 * s1, c1 * nrSide, nySide, s1 * nrSide, u1, v1)
        emit(r0 * c1, y0, r0 * s1, c1 * nrSide, nySide, s1 * nrSide, u1, v0)
      }
      if (r1 > 1e-9) {
        emit(r0 * c0, y0, r0 * s0, c0 * nrSide, nySide, s0 * nrSide, u0, v0)
        emit(r1 * c0, y1, r1 * s0, c0 * nrSide, nySide, s0 * nrSide, u0, v1)
        emit(r1 * c1, y1, r1 * s1, c1 * nrSide, nySide, s1 * nrSide, u1, v1)
      }
    }
  }
  if (caps) {
    const yTop = height / 2
    const yBot = -height / 2
    if (!apex) {
      // Top cap (+Y): a fan, CCW viewed from above
      for (let i = 0; i < radial; i++) {
        const a0 = (i / radial) * Math.PI * 2
        const a1 = ((i + 1) / radial) * Math.PI * 2
        emit(0, yTop, 0, 0, 1, 0, 0.5, 0.5)
        emit(rTop * Math.cos(a1), yTop, rTop * Math.sin(a1), 0, 1, 0, 0.5 + 0.5 * Math.cos(a1), 0.5 + 0.5 * Math.sin(a1))
        emit(rTop * Math.cos(a0), yTop, rTop * Math.sin(a0), 0, 1, 0, 0.5 + 0.5 * Math.cos(a0), 0.5 + 0.5 * Math.sin(a0))
      }
    }
    if (!bottomApex) {
      // Bottom cap (−Y): reversed winding
      for (let i = 0; i < radial; i++) {
        const a0 = (i / radial) * Math.PI * 2
        const a1 = ((i + 1) / radial) * Math.PI * 2
        emit(0, yBot, 0, 0, -1, 0, 0.5, 0.5)
        emit(rBottom * Math.cos(a0), yBot, rBottom * Math.sin(a0), 0, -1, 0, 0.5 + 0.5 * Math.cos(a0), 0.5 + 0.5 * Math.sin(a0))
        emit(rBottom * Math.cos(a1), yBot, rBottom * Math.sin(a1), 0, -1, 0, 0.5 + 0.5 * Math.cos(a1), 0.5 + 0.5 * Math.sin(a1))
      }
    }
  }
  return { positions, normals, uvs, vertexCount: v }
}

export interface ConeParams {
  /** Base radius (default 1). */
  readonly radius?: number
  /** Height along Y (default 2). */
  readonly height?: number
  /** Segments around the axis (default 48). */
  readonly radialSegments?: number
  /** Bands along the height (default 1). */
  readonly heightSegments?: number
  /** Without the base (default false). */
  readonly openEnded?: boolean
}

/** Cone: cylinder with radiusTop = 0. */
export function cone(params: ConeParams = {}): Geometry {
  return cylinder({
    radiusTop: 0,
    radiusBottom: params.radius ?? 1,
    height: params.height ?? 2,
    radialSegments: params.radialSegments ?? 48,
    heightSegments: params.heightSegments ?? 1,
    openEnded: params.openEnded ?? false,
  })
}
