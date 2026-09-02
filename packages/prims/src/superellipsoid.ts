/**
 * Superellipsoid (superquadric): |x/a|^m + |y/b|^m + |z/c|^m = 1 with the
 * parameterization
 *   x = a·sign(cosη)|cosη|^(2/m)·sign(cosω)|cosω|^(2/n)
 *   y = b·sign(sinη)|sinη|^(2/m)
 *   z = c·sign(cosη)|cosη|^(2/m)·sign(sinω)|sinω|^(2/n)
 * m, n = 2 → an ellipsoid; larger → a rounded "box";
 * m, n → 1 → an octahedron-like rhombus. Normals are the cross product of
 * the parametric tangents (∂/∂η × ∂/∂ω), stable for any m, n > 0.
 *
 * Task 108 BUG (hole at the TOP pole): the loop went to bands−1 — the band
 * bands−1 (η: π/2−π/bands → +π/2) was NOT emitted AT ALL, while the band
 * bands−2 was treated as the "pole" one (its top is NOT the pole — it ate
 * half of it too). Fix: full loop j < bands; the poles are exactly the
 * extreme bands (j=0 — the bottom η=−π/2, j=bands−1 — the top η=+π/2),
 * each skips only its own degenerate half-quad. The arrays are an exact
 * prealloc (6·segments·(bands−1) vertices), without number[] intermediates.
 */

import type { Geometry } from './types.ts'

function spow(v: number, e: number): number {
  // sign(v)·|v|^e — preserves the sign for a fractional exponent
  return v < 0 ? -Math.pow(-v, e) : Math.pow(v, e)
}

export function superellipsoid(
  rx = 1,
  ry = 1,
  rz = 1,
  m = 2,
  n = 2,
  segments = 48,
  rings = 32,
): Geometry {
  const seg = Math.max(4, Math.floor(segments))
  const bands = Math.max(3, Math.floor(rings))
  const em = 2 / Math.max(m, 0.05)
  const en = 2 / Math.max(n, 0.05)
  // Full bands (bands−2) with 2 triangles each + 2 pole fans of seg
  const triCount = 2 * seg * (bands - 1)
  const positions = new Float32Array(triCount * 3 * 3)
  const normals = new Float32Array(triCount * 3 * 3)
  const uvs = new Float32Array(triCount * 3 * 2)
  let v = 0
  const rawPoint = (eta: number, omega: number): [number, number, number] => [
    rx * spow(Math.cos(eta), em) * spow(Math.cos(omega), en),
    ry * spow(Math.sin(eta), em),
    rz * spow(Math.cos(eta), em) * spow(Math.sin(omega), en),
  ]
  const emit = (eta: number, omega: number, u: number, vv: number): void => {
    const p = rawPoint(eta, omega)
    // Tangents along η and ω (numerically, with a small step — stable near
    // the degenerate poles, where the analytical derivative vanishes)
    const h = 1e-3
    const p1 = rawPoint(eta + h, omega)
    const p2 = rawPoint(eta, omega + h)
    const t1x = p1[0] - p[0], t1y = p1[1] - p[1], t1z = p1[2] - p[2]
    const t2x = p2[0] - p[0], t2y = p2[1] - p[1], t2z = p2[2] - p[2]
    let nx = t1y * t2z - t1z * t2y
    let ny = t1z * t2x - t1x * t2z
    let nz = t1x * t2y - t1y * t2x
    const len = Math.hypot(nx, ny, nz)
    if (len > 1e-9) {
      nx /= len
      ny /= len
      nz /= len
    } else {
      // degenerate point (a pole): the normal ≈ radial
      const rl = Math.hypot(p[0], p[1], p[2]) || 1
      nx = p[0] / rl
      ny = p[1] / rl
      nz = p[2] / rl
    }
    positions[v * 3] = p[0]
    positions[v * 3 + 1] = p[1]
    positions[v * 3 + 2] = p[2]
    normals[v * 3] = nx
    normals[v * 3 + 1] = ny
    normals[v * 3 + 2] = nz
    uvs[v * 2] = u
    uvs[v * 2 + 1] = vv
    v++
  }
  // η ∈ [−π/2, π/2] (latitude, −π/2 = the BOTTOM pole), ω ∈ [−π, π] (longitude)
  for (let j = 0; j < bands; j++) {
    const e0 = -Math.PI / 2 + (j / bands) * Math.PI
    const e1 = -Math.PI / 2 + ((j + 1) / bands) * Math.PI
    const bottomPole = j === 0 // e0 = −π/2: the bottom row collapses into a point
    const topPole = j === bands - 1 // e1 = +π/2: the top row collapses
    for (let i = 0; i < seg; i++) {
      const o0 = -Math.PI + (i / seg) * Math.PI * 2
      const o1 = -Math.PI + ((i + 1) / seg) * Math.PI * 2
      const u0 = i / seg
      const u1 = (i + 1) / seg
      const v0 = j / bands
      const v1 = (j + 1) / bands
      // CCW from outside; degenerate pole halves are skipped
      if (!topPole) {
        emit(e1, o0, u0, v1)
        emit(e1, o1, u1, v1)
        emit(e0, o1, u1, v0)
      }
      if (!bottomPole) {
        emit(e1, o0, u0, v1)
        emit(e0, o1, u1, v0)
        emit(e0, o0, u0, v0)
      }
    }
  }
  return { positions, normals, uvs, vertexCount: v }
}
