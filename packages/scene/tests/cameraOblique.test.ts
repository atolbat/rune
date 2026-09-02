/**
 * cameraOblique.test.ts — Task 86: oblique near plane (Lengyel)
 * for planar mirrors + projection post-multiply (GL→D3D z-remap).
 *
 * Properties are verified NUMERICALLY on clip coordinates: a point on the
 * plane gets NDC z = −1 (near), a point "between the camera and the plane"
 * gets z < −1 (near clip), a point behind the plane gets z ∈ (−1, 1].
 *
 * Sign semantics (Lengyel): the CAMERA MUST lie on the negative side of the
 * plane; the visible half-space is the positive one. A plane passed
 * "facing" the camera (camera on the positive side) is flipped
 * automatically — the side AWAY from the camera becomes visible.
 */
import { describe, expect, test } from 'bun:test'
import { createCamera, applyObliqueClipPlane } from '../src/camera.ts'

const camera = createCamera()

/** NDC of a world point → clip via VP (homogeneous division). */
function ndc(vp: Float32Array, x: number, y: number, z: number): { z: number; w: number } {
  const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12]
  const cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13]
  const cz = vp[2] * x + vp[6] * y + vp[10] * z + vp[14]
  const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15]
  expect(Number.isFinite(cx + cy + cz + cw)).toBe(true)
  return { z: cz / cw, w: cw }
}

describe('setObliqueClipPlane', () => {
  test('mirror camera UNDER the plane (canonical reflection scenario)', () => {
    // reflected camera under the "mirror" y = 2, looking up; keep y ≥ 2
    const cam = createCamera()
    cam.setPerspective((60 * Math.PI) / 180, 1, 0.5, 200)
    cam.setViewLookAt(0, -8, 6, 0, 10, 0, 0, 0, 1)
    cam.setObliqueClipPlane([0, 1, 0, -2]) // y − 2 = 0, keep y ≥ 2
    const vp = cam.viewProjection
    expect(ndc(vp, 0, 2, 3).z).toBeCloseTo(-1, 5) // on the plane — near
    expect(ndc(vp, 0, 7, 3).z).toBeGreaterThan(-1) // behind the plane — visible
    expect(ndc(vp, 0, 7, 3).z).toBeLessThanOrEqual(1)
    expect(ndc(vp, 0, -6, 3).z).toBeLessThan(-1) // between camera and plane — clipped
    expect(ndc(vp, 0, 7, 3).w).toBeGreaterThan(0) // w not flipped
  })

  test('a plane "facing" the camera auto-flips (the side AWAY from the camera is visible)', () => {
    // camera ABOVE the plane y = −5 looks down; the plane is passed such
    // that the camera is on the positive side → flip → y ≤ −5 is visible
    const cam = createCamera()
    cam.setPerspective((60 * Math.PI) / 180, 1, 0.5, 200)
    cam.setViewLookAt(0, 12, 6, 0, 0, 0, 0, 0, 1)
    cam.setObliqueClipPlane([0, 1, 0, 5]) // y + 5 = 0 → plane y = −5
    const vp = cam.viewProjection
    expect(ndc(vp, 0, -5, 3).z).toBeCloseTo(-1, 5) // on the plane — near
    expect(ndc(vp, 0, -9, 3).z).toBeGreaterThan(-1) // below the plane (away from the camera) — visible
    expect(ndc(vp, 0, -2, 3).z).toBeLessThan(-1) // between camera and plane — clipped
  })

  test('camera frustum planes are consistent: near = clip plane', () => {
    const cam = createCamera()
    cam.setPerspective((60 * Math.PI) / 180, 1, 0.5, 200)
    cam.setViewLookAt(0, -8, 6, 0, 10, 0, 0, 0, 1)
    cam.setObliqueClipPlane([0, 1, 0, -2]) // plane y = 2
    const n = cam.planes
    // PLANE_NEAR=4 → slots 16..19; the plane is normalized (|n|=1)
    const len = Math.hypot(n[16], n[17], n[18])
    expect(len).toBeCloseTo(1, 5)
    // a point of the plane y=2 lies on the frustum's near plane
    const dist = (n[16]! * 0 + n[17]! * 2 + n[18]! * 3) / len + n[19]! / len
    expect(Math.abs(dist)).toBeLessThan(1e-4)
  })

  test('oblique plane (not axis-aligned) — the general case', () => {
    const cam = createCamera()
    cam.setPerspective((70 * Math.PI) / 180, 1.6, 0.5, 300)
    cam.setViewLookAt(10, 8, 12, 0, 2, 0, 0, 1, 0)
    const plane: [number, number, number, number] = [0.3, 0.8, 0.52, -3.0]
    cam.setObliqueClipPlane(plane)
    const vp = cam.viewProjection
    // a point on the plane (x=z=1 → y = (3 − 0.3 − 0.52)/0.8 = 2.725)
    const py = (3 - 0.3 - 0.52) / 0.8
    const onPlane = ndc(vp, 1, py, 1)
    // the point may lie outside the xy-frustum, but the z property must hold:
    // it is on the near plane ⇒ z_ndc = −1 (if it projects at all)
    if (onPlane.w > 0) expect(onPlane.z).toBeCloseTo(-1, 4)
    // camera: 0.3·10 + 0.8·8 + 0.52·12 − 3 = 12.64 > 0 — on the positive
    // side ⇒ auto-flip: the side AWAY from the camera is visible (smaller
    // values of 0.3x+0.8y+0.52z−3).
    const below = ndc(vp, 1, py - 3, 1)
    expect(below.z).toBeGreaterThan(-1 - 1e-6)
    const above = ndc(vp, 1, py + 3, 1)
    expect(above.z).toBeLessThan(-1 + 1e-6)
  })

  test('degenerate normal — honest error', () => {
    const cam = createCamera()
    expect(() => cam.setObliqueClipPlane([0, 0, 0, 1])).toThrow(/zero normal/)
  })

  test('applyObliqueClipPlane is exported for direct use', () => {
    const cam = createCamera()
    cam.setPerspective(1, 1, 0.5, 100)
    cam.setViewLookAt(0, 5, 0, 0, 0, 0, 0, 0, 1)
    const before = Float32Array.from(cam.projection)
    applyObliqueClipPlane(cam.projection, cam.view, [0, 1, 0, 1])
    expect(Array.from(cam.projection)).not.toEqual(Array.from(before))
  })
})

describe('postMultiplyProjection', () => {
  /** GL→D3D remap: z' = (z + w)/2 (near −1 → 0, far +1 → 1). */
  const REMAP = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 1])

  test('GL→D3D z-remap maps the oblique near to 0 (WebGPU convention)', () => {
    const cam = createCamera()
    cam.setPerspective(1, 1, 0.5, 100)
    // mirror camera under the plane y=2, looking up
    cam.setViewLookAt(0, -8, 6, 0, 10, 0, 0, 0, 1)
    cam.setObliqueClipPlane([0, 1, 0, -2]) // near = plane y = 2
    cam.postMultiplyProjection(REMAP)
    const vp = cam.viewProjection
    // a point on the mirror plane → NDC z = 0 (WebGPU near)
    expect(ndc(vp, 0, 2, 3).z).toBeCloseTo(0, 5)
    // a visible point (behind the plane) → z ∈ (0, 1)
    const vis = ndc(vp, 0, 6, 3)
    expect(vis.z).toBeGreaterThan(0)
    expect(vis.z).toBeLessThanOrEqual(1)
    // between camera and plane → z < 0 (clipped in WebGPU)
    expect(ndc(vp, 0, -4, 3).z).toBeLessThan(0)
  })

  test('x/y/w are untouched by the remap', () => {
    const cam = createCamera()
    cam.setPerspective(1, 1, 0.5, 100)
    cam.setViewLookAt(0, 0, 10, 0, 0, 0, 0, 1, 0)
    const vp0 = Float32Array.from(cam.viewProjection)
    cam.postMultiplyProjection(REMAP)
    const vp = cam.viewProjection
    const p = [0.3, 1.0, -2.0]
    const px0 = vp0[0]! * p[0]! + vp0[4]! * p[1]! + vp0[8]! * p[2]! + vp0[12]!
    const py0 = vp0[1]! * p[0]! + vp0[5]! * p[1]! + vp0[9]! * p[2]! + vp0[13]!
    const w0 = vp0[3]! * p[0]! + vp0[7]! * p[1]! + vp0[11]! * p[2]! + vp0[15]!
    const px = vp[0]! * p[0]! + vp[4]! * p[1]! + vp[8]! * p[2]! + vp[12]!
    const py = vp[1]! * p[0]! + vp[5]! * p[1]! + vp[9]! * p[2]! + vp[13]!
    const w = vp[3]! * p[0]! + vp[7]! * p[1]! + vp[11]! * p[2]! + vp[15]!
    expect(px).toBeCloseTo(px0, 6)
    expect(py).toBeCloseTo(py0, 6)
    expect(w).toBeCloseTo(w0, 6)
  })
})
