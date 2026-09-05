// Task 141 — the frustum foundation (@rune/core frustum.ts): ONE
// Gribb–Hartmann for the repo — the extraction and the sphere tests were
// written twice (scene's Task 81 culler and particles' Task 134 GPU render
// tier) before the move.
//
// Pinned here:
//   1. THE EXTRACTION — the six normalized planes from a column-major
//      view-projection (the exact task134 goldens: the visible pass, the
//      off-screen fail, the sphere radius margin, the scratch reuse, the
//      loud wrong-length reject).
//   2. THE DEGENERATE GUARD — a broken matrix writes ZEROS, never NaN
//      (the verdict degrades to "inside" — the conservative direction).
//   3. THE CLASSIFICATIONS — classifySphere's 3-way verdicts (the scene
//      culler's pins: inside/outside/intersect) and sphereOutsideFrustum's
//      boolean gate agree away from the exact boundary.
//   4. THE PARITY — the boolean gate is the GPU render tier's shader test
//      mirrored CPU-side (dot(n, p) + d ≤ −r): the same sphere survives
//      both the scene culler and the particle bakers.

import { describe, expect, it } from 'bun:test'
import {
  frustumPlanes, classifySphere, sphereOutsideFrustum,
  SPHERE_OUTSIDE, SPHERE_INTERSECT, SPHERE_INSIDE, FRUSTUM_PLANE_COUNT,
} from '../src/frustum.ts'

/** Column-major 4×4 product a·b. */
function mul(a: readonly number[], b: readonly number[]): number[] {
  const o = new Array<number>(16).fill(0)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]
      o[c * 4 + r] = s
    }
  }
  return o
}

/** gluPerspective, column-major. */
function perspective(fovy: number, aspect: number, near: number, far: number): number[] {
  const f = 1 / Math.tan(fovy / 2)
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0]
}

// eye (0, 0, 10) looking −Z at the origin, fov 90°, aspect 1, near 1, far 100
const view = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -10, 1]
const vp = mul(perspective(Math.PI / 2, 1, 1, 100), view)
const planes = frustumPlanes(vp)

function inside(x: number, y: number, z: number, r = 0): boolean {
  for (let p = 0; p < 6; p++) {
    if (planes[p * 4] * x + planes[p * 4 + 1] * y + planes[p * 4 + 2] * z + planes[p * 4 + 3] <= -r) return false
  }
  return true
}

describe('Task 141 — frustumPlanes (the extraction)', () => {
  it('the planes are normalized (|n| = 1) and the layout is 24 floats', () => {
    expect(planes).toHaveLength(24)
    expect(FRUSTUM_PLANE_COUNT).toBe(6)
    for (let p = 0; p < 6; p++) {
      const len = Math.hypot(planes[p * 4], planes[p * 4 + 1], planes[p * 4 + 2])
      expect(len).toBeCloseTo(1, 5)
    }
  })
  it('the visible pass, the off-screen and the behind fail', () => {
    expect(inside(0, 0, 0)).toBe(true)      // dead ahead, mid-volume
    expect(inside(2, 2, 2)).toBe(true)      // comfortably inside the fov
    expect(inside(9, 0, 0)).toBe(true)      // near the right edge (half-width 10 at dist 10)
    expect(inside(15, 0, 0)).toBe(false)    // well off the side
    expect(inside(0, 15, 0)).toBe(false)    // well above
    expect(inside(0, 0, 9.5)).toBe(false)   // inside the near slab (dist 0.5 < near 1)
    expect(inside(0, 0, -95)).toBe(false)   // beyond the far plane (dist 105)
  })
  it('the sphere radius: an off-center point passes with the margin, fails without', () => {
    expect(inside(10.5, 0, 0, 1.5)).toBe(true)   // the sphere pokes inside the frustum
    expect(inside(10.5, 0, 0, 0)).toBe(false)    // the bare center is outside
  })
  it('rejects a wrong-length view-projection', () => {
    expect(() => frustumPlanes([1, 2, 3])).toThrow('16 numbers')
  })
  it('writes into the caller scratch (the zero-alloc hot path)', () => {
    const scratch = new Float32Array(24)
    const out = frustumPlanes(vp, scratch)
    expect(out).toBe(scratch)
    expect(out).toEqual(planes)
  })
  it('accepts Float32Array matrices (the scene camera\'s own type — f32 input rounding lands in the planes at f32 precision)', () => {
    const vp32 = new Float32Array(vp)
    const p32 = frustumPlanes(vp32)
    for (let i = 0; i < 24; i++) expect(p32[i]).toBeCloseTo(planes[i], 3)
  })
  it('THE DEGENERATE GUARD — a broken matrix writes zeros, never NaN', () => {
    const broken = new Array<number>(16).fill(0)
    const p = frustumPlanes(broken)
    for (let i = 0; i < 24; i++) {
      expect(Number.isNaN(p[i])).toBe(false)
      expect(p[i]).toBe(0)
    }
    // zeros read as "inside" — the conservative direction (nothing culled).
    expect(sphereOutsideFrustum(p, 1, 2, 3, 0.5)).toBe(false)
  })
})

describe('Task 141 — classifySphere (the 3-way classification)', () => {
  it('sphere at the center of the view — INSIDE', () => {
    expect(classifySphere(planes, 0, 0, 0, 0.5)).toBe(SPHERE_INSIDE)
  })
  it('sphere far to the side — OUTSIDE', () => {
    expect(classifySphere(planes, 1000, 1000, 0, 1)).toBe(SPHERE_OUTSIDE)
  })
  it('sphere on the boundary — INTERSECT', () => {
    // fov 90°, distance along the view 10 → half-width 10 at that depth.
    expect(classifySphere(planes, 10.5, 0, 0, 1.5)).toBe(SPHERE_INTERSECT)
  })
  it('the constants are 0/1/2 (the culler\'s bitmask arithmetic)', () => {
    expect(SPHERE_OUTSIDE).toBe(0)
    expect(SPHERE_INTERSECT).toBe(1)
    expect(SPHERE_INSIDE).toBe(2)
  })
})

describe('Task 141 — sphereOutsideFrustum (the boolean gate)', () => {
  it('THE PARITY — agrees with the raw six-plane walk (the GPU tier\'s test mirrored)', () => {
    const pts = [
      [0, 0, 0], [2, 2, 2], [9, 0, 0], [15, 0, 0], [0, 15, 0],
      [0, 0, 9.5], [0, 0, -95], [10.5, 0, 0], [-10.5, 0, 0], [0, -6, 4],
    ]
    for (const [x, y, z] of pts) {
      for (const r of [0, 0.5, 1.5]) {
        expect(sphereOutsideFrustum(planes, x, y, z, r)).toBe(!inside(x, y, z, r))
      }
    }
  })
  it('agrees with classifySphere away from the exact boundary', () => {
    // (-3, 4, −2): 12 units in front, well inside the fov — INSIDE (the
    // camera sits at (0,0,10) looking −Z; the point is VISIBLE).
    const cases: [number, number, number, number, number][] = [
      [0, 0, 0, 0.5, SPHERE_INSIDE],
      [1000, 1000, 0, 1, SPHERE_OUTSIDE],
      [10.5, 0, 0, 1.5, SPHERE_INTERSECT],
      [0, 0, 9.9, 0.2, SPHERE_OUTSIDE],  // 0.1 in front of the camera — behind the near plane
      [-3, 4, -2, 0.5, SPHERE_INSIDE],  // comfortably visible
      [0, 0, -95, 1, SPHERE_OUTSIDE],   // beyond the far plane
    ]
    for (const [x, y, z, r, verdict] of cases) {
      const three = classifySphere(planes, x, y, z, r)
      const bool = sphereOutsideFrustum(planes, x, y, z, r)
      expect(bool).toBe(three === SPHERE_OUTSIDE)
      expect(three).toBe(verdict)
    }
  })
  it('zero-radius centers: the bare-point verdict', () => {
    expect(sphereOutsideFrustum(planes, 0, 0, 0, 0)).toBe(false)
    expect(sphereOutsideFrustum(planes, 15, 0, 0, 0)).toBe(true)
  })
})
