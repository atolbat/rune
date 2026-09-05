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
 *
 * Task 141: THE MOVE — the extraction and the classification were the
 * SECOND copy of @rune/particles' Task 134 cull machinery (the same
 * Gribb–Hartmann, the same p-vertex test, written twice). Both now live
 * in @rune/core's frustum.ts — ONE contract for the scene culler, the
 * particle bakers and the GPU render tier's shader test. This module is
 * the scene binding: the public names and signatures are unchanged
 * (extractFrustumPlanes' out-first order, the PLANE_* index constants,
 * writeCameraPlanes into the worker views).
 */
import {
  frustumPlanes,
  classifySphere,
  SPHERE_OUTSIDE,
  SPHERE_INTERSECT,
  SPHERE_INSIDE,
} from '@rune/core'
import type { SceneViews } from './layout.ts'

export { classifySphere, SPHERE_OUTSIDE, SPHERE_INTERSECT, SPHERE_INSIDE }

/** Plane order in planes[24]: L, R, B, T, N, F. */
export const PLANE_LEFT = 0
export const PLANE_RIGHT = 1
export const PLANE_BOTTOM = 2
export const PLANE_TOP = 3
export const PLANE_NEAR = 4
export const PLANE_FAR = 5

/**
 * Extracts 6 normalized planes from a column-major VP.
 * out: 24 floats (a0,b0,c0,d0, a1,b1,c1,d1, …).
 */
export function extractFrustumPlanes(out: Float32Array, vp: Float32Array): Float32Array {
  return frustumPlanes(vp, out)
}

/**
 * Writes the planes of camera k into the scene layout (for the worker) —
 * planes are copied into views.planes[k*24 …].
 */
export function writeCameraPlanes(views: SceneViews, cameraIndex: number, planes: Float32Array): void {
  views.planes.set(planes.subarray(0, 24), cameraIndex * 24)
}
