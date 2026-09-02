/**
 * frustum.ts — frustum planes and fast sphere tests (Task 81).
 *
 * Extraction — Gribb–Hartmann from the view-projection matrix (column-major,
 * OpenGL clip z∈[-1,1]): the planes are sums/differences of VP rows, normalized
 * to a unit normal. The sphere test is the p-vertex form from the ryg blog
 * (fgiesen.wordpress.com, "Frustum culling tips"): signed distance
 * d = n·c + p; the sphere is fully outside ⟺ d < −r; fully inside all
 * planes ⟺ d ≥ +r — a "trivial accept" for hierarchically culling
 * whole subtrees in one stroke.
 */
import type { SceneViews } from './layout.ts'

/** Plane order in planes[24]: L, R, B, T, N, F. */
export const PLANE_LEFT = 0
export const PLANE_RIGHT = 1
export const PLANE_BOTTOM = 2
export const PLANE_TOP = 3
export const PLANE_NEAR = 4
export const PLANE_FAR = 5

/** Classification of a sphere relative to the frustum. */
export const SPHERE_OUTSIDE = 0
export const SPHERE_INTERSECT = 1
export const SPHERE_INSIDE = 2

/**
 * Extracts 6 normalized planes from a column-major VP.
 * out: 24 floats (a0,b0,c0,d0, a1,b1,c1,d1, …).
 */
export function extractFrustumPlanes(out: Float32Array, vp: Float32Array): Float32Array {
  // Rows of a column-major m: row_i = (m[i], m[4+i], m[8+i], m[12+i]).
  for (let i = 0; i < 6; i++) {
    // i: 0=L(row3+row0) 1=R(row3−row0) 2=B(row3+row1) 3=T(row3−row1) 4=N(row3+row2) 5=F(row3−row2)
    const row = i >> 1
    const sign = (i & 1) === 0 ? 1 : -1
    const o = i * 4
    const a = vp[3] + sign * vp[row]
    const b = vp[7] + sign * vp[4 + row]
    const c = vp[11] + sign * vp[8 + row]
    const d = vp[15] + sign * vp[12 + row]
    const inv = 1 / Math.sqrt(a * a + b * b + c * c)
    out[o] = a * inv
    out[o + 1] = b * inv
    out[o + 2] = c * inv
    out[o + 3] = d * inv
  }
  return out
}

/** Test of a single sphere: OUTSIDE / INTERSECT / INSIDE (all 6 planes). */
export function classifySphere(
  planes: Float32Array,
  cx: number, cy: number, cz: number, radius: number,
): number {
  let insideAll = true
  for (let i = 0; i < 6; i++) {
    const o = i * 4
    const d = planes[o] * cx + planes[o + 1] * cy + planes[o + 2] * cz + planes[o + 3]
    if (d < -radius) return SPHERE_OUTSIDE
    if (d < radius) insideAll = false
  }
  return insideAll ? SPHERE_INSIDE : SPHERE_INTERSECT
}

/**
 * Writes the planes of camera k into the scene layout (for the worker) —
 * planes are copied into views.planes[k*24 …].
 */
export function writeCameraPlanes(views: SceneViews, cameraIndex: number, planes: Float32Array): void {
  views.planes.set(planes.subarray(0, 24), cameraIndex * 24)
}
