/**
 * camera.ts — the scene camera (Task 81).
 *
 * The camera is NOT a scene node: it owns its own view/projection/VP and
 * normalized frustum planes. The typical scenario is a "camera on a
 * node": every frame main takes the node slot's world and calls
 * setViewFromWorld (a fast affine inversion) — parent chains of cameras
 * are free because the node's world is already computed by the scene.
 *
 * All setters immediately recompute VP and planes — the camera changes once
 * per frame, it is not worth accumulating dirt.
 */
import {
  mat4InvertAffine,
  mat4LookAt,
  mat4Ortho,
  mat4Perspective,
  mat4Multiply,
} from '@rune/math'
import { extractFrustumPlanes } from './frustum.ts'

/** The public camera interface. */
export interface Camera {
  /** The view matrix (world → camera), column-major. */
  readonly view: Float32Array
  /** The projection (camera → clip), column-major. */
  readonly projection: Float32Array
  /** view · projection, column-major. */
  readonly viewProjection: Float32Array
  /** 6 normalized frustum planes (L,R,B,T,N,F). */
  readonly planes: Float32Array

  /** Perspective (fovy in radians, aspect = w/h). */
  setPerspective(fovy: number, aspect: number, near: number, far: number): Camera
  /** Orthographic. */
  setOrtho(left: number, right: number, bottom: number, top: number, near: number, far: number): Camera
  /**
   * Oblique near plane (Lengyel, "Oblique View Frustum Depth
   * Projection and Clipping"): the frustum's near plane is replaced with
   * a world plane (nx, ny, nz, d) — the half-space
   * n·x + d ≥ 0 remains. A classic of planar mirrors/water: everything "under" the plane
   * is clipped by the near plane, the depth stays correct.
   *
   * WARNING: depth-buffer precision degrades (the range [−1,1]
   * is squeezed into [−1,1] relative to the oblique volume) — for mirror
   * cameras this is acceptable. Call AFTER setPerspective/setOrtho and
   * setView* — the plane is transformed by the current view matrix.
   */
  setObliqueClipPlane(plane: readonly [number, number, number, number]): Camera
  /**
   * Post-multiplication of the projection from the left (P' = m · P) with VP and plane recomputation.
   * The purpose is backend conventions: WebGPU/D3D expect NDC z ∈ [0,1],
   * GL matrices give [-1,1]; the z' = (z+w)/2 remap matrix fixes clipping
   * (and the oblique plane too) on the WebGPU path.
   */
  postMultiplyProjection(m: ArrayLike<number>): Camera
  /** The view from a node's world transform (an affine inversion). */
  setViewFromWorld(world: ArrayLike<number>): Camera
  /** LookAt (eye → center, up). */
  setViewLookAt(
    eyeX: number, eyeY: number, eyeZ: number,
    centerX: number, centerY: number, centerZ: number,
    upX: number, upY: number, upZ: number,
  ): Camera
}

const tmpInverse = new Float32Array(16)
const tmpProjLeft = new Float32Array(16)

/** Creates a camera (identity view + 60°/1/0.1/100 perspective by default). */
export function createCamera(): Camera {
  const view = new Float32Array(16)
  const projection = new Float32Array(16)
  const viewProjection = new Float32Array(16)
  const planes = new Float32Array(24)
  view[0] = view[5] = view[10] = view[15] = 1

  const camera: Camera = {
    view,
    projection,
    viewProjection,
    planes,
    setPerspective(fovy, aspect, near, far) {
      mat4Perspective(projection, fovy, aspect, near, far)
      refresh()
      return camera
    },
    setOrtho(left, right, bottom, top, near, far) {
      mat4Ortho(projection, left, right, bottom, top, near, far)
      refresh()
      return camera
    },
    setViewFromWorld(world) {
      for (let i = 0; i < 16; i++) tmpInverse[i] = world[i]
      mat4InvertAffine(view, tmpInverse)
      refresh()
      return camera
    },
    setObliqueClipPlane(plane) {
      applyObliqueClipPlane(projection, view, plane)
      refresh()
      return camera
    },
    postMultiplyProjection(m) {
      // P' = m · P (m on the left): copies into scratches — mat4Multiply
      // requires Float32Array and dislikes out coinciding with an input.
      for (let i = 0; i < 16; i++) tmpProjLeft[i] = m[i]!
      for (let i = 0; i < 16; i++) tmpInverse[i] = projection[i]
      mat4Multiply(projection, tmpProjLeft, tmpInverse)
      refresh()
      return camera
    },
    setViewLookAt(eyeX, eyeY, eyeZ, centerX, centerY, centerZ, upX, upY, upZ) {
      mat4LookAt(view, eyeX, eyeY, eyeZ, centerX, centerY, centerZ, upX, upY, upZ)
      refresh()
      return camera
    },
  }

  function refresh(): void {
    mat4Multiply(viewProjection, projection, view)
    extractFrustumPlanes(planes, viewProjection)
  }

  camera.setPerspective(Math.PI / 3, 1, 0.1, 100)
  return camera
}

/**
 * Oblique near plane (Lengyel). Modifies the PROJECTION in-place:
 * the z-row of P (column-major indices 2, 6, 10, 14) is replaced so
 * that the frustum's near plane coincides with the world plane
 * (nx, ny, nz, d) (the half-space n·x + d ≥ 0 remains visible).
 *
 * Step by step:
 *   1. The plane → view space: x_view = R·(x_world − e) for
 *      a rigid view ⇒ n' = R·n, d' = d − n'·t, where t is the view translation
 *      (−R·e in columns 12..14).
 *   2. The standard Lengyel derivation: q — a point on the far plane,
 *      "mirrored" to the intersection of the plane with the main diagonal; the new
 *      z-column = plane·(2/dot(plane, q)); m[10] += 1 preserves
 *      the far plane.
 *
 * Contract: view — rigid (lookAt/fromWorld), projection — GL convention
 * (z_ndc ∈ [−1, 1], m[11] = −1). For WebGPU add the z post-remap
 * (postMultiplyProjection), the clipping by the plane will survive.
 */
export function applyObliqueClipPlane(
  projection: Float32Array,
  view: Float32Array,
  plane: readonly [number, number, number, number],
): void {
  const [nx, ny, nz, d] = plane
  const len = Math.hypot(nx, ny, nz)
  if (len < 1e-9) throw new Error('scene: zero normal of the clip plane')
  // Normalization (the plane may arrive unnormalized).
  const a = nx / len, b = ny / len, c = nz / len, dd = d / len

  // View space: n' = R·n (the 3×3 rows of the view), t = the view translation.
  const tx = view[12], ty = view[13], tz = view[14]
  const va = view[0] * a + view[4] * b + view[8] * c
  const vb = view[1] * a + view[5] * b + view[9] * c
  const vc = view[2] * a + view[6] * b + view[10] * c
  const vd = dd - (va * tx + vb * ty + vc * tz)

  // The sign (Lengyel): the camera must lie on the NEGATIVE side
  // of the plane (the visible half-space is the positive one). In view
  // space the camera is the origin: p·(0,0,0,1) = d_view.
  // A plane "facing" us (d_view > 0) — flip; degeneracy (d_view = 0,
  // the camera on the plane) is not cured by a flip — leave it as is.
  let pa = va, pb = vb, pc = vc, pd = vd
  if (pd > 0) { pa = -pa; pb = -pb; pc = -pc; pd = -pd }

  const p = projection
  // q — the "far corner" vertex answering the plane's signs.
  const qx = (Math.sign(pa) + p[8]) / p[0]
  const qy = (Math.sign(pb) + p[9]) / p[5]
  const qz = -1
  const qw = (1 + p[10]) / p[14]
  const denom = pa * qx + pb * qy + pc * qz + pd * qw
  if (Math.abs(denom) < 1e-12) throw new Error('scene: oblique plane is degenerate (parallel to the view direction)')
  const s = 2 / denom
  p[2] = pa * s
  p[6] = pb * s
  p[10] = pc * s + 1
  p[14] = pd * s
}

