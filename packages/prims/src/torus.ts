/**
 * Torus and torus knot (Task 109: options-API, segment names — like
 * TorusGeometry/TorusKnotGeometry in three.js: tubularSegments — around
 * the major axis, radialSegments — around the tube cross-section).
 *
 * Torus: a parametric surface (θ — around the major axis, φ — around
 * the tube), analytical normals. (x,z) lies at radius R+|r·cosφ|:
 * (R + r·cosφ)·(sinθ, cosθ) horizontally, y = r·sinφ.
 *
 * Torus knot (p, q): a tube of radius tube around the curve
 * t ↦ (cos(p·t)·(2+cos(q·t)), sin(p·t)·(2+cos(q·t)), sin(q·t)) — the knot
 * curve on a torus; frames use approximate parallel transport.
 */

import type { Geometry } from './types.ts'

export interface TorusParams {
  /** Radius of the ring (default 1). */
  readonly radius?: number
  /** Radius of the tube (default 0.35). */
  readonly tube?: number
  /** Segments around the tube axis (default 24). */
  readonly radialSegments?: number
  /** Segments around the major axis (default 64). */
  readonly tubularSegments?: number
}

export function torus(params: TorusParams = {}): Geometry {
  const majorRadius = params.radius ?? 1
  const tubeRadius = params.tube ?? 0.35
  const tub = Math.max(3, Math.floor(params.tubularSegments ?? 64))
  const rad = Math.max(3, Math.floor(params.radialSegments ?? 24))
  const positions = new Float32Array(tub * rad * 6 * 3)
  const normals = new Float32Array(tub * rad * 6 * 3)
  const uvs = new Float32Array(tub * rad * 6 * 2)
  let v = 0
  const emit = (theta: number, phi: number, u: number, vv: number): void => {
    const cosPhi = Math.cos(phi)
    const sinPhi = Math.sin(phi)
    positions[v * 3] = Math.cos(theta) * (majorRadius + tubeRadius * cosPhi)
    positions[v * 3 + 1] = tubeRadius * sinPhi
    positions[v * 3 + 2] = Math.sin(theta) * (majorRadius + tubeRadius * cosPhi)
    normals[v * 3] = Math.cos(theta) * cosPhi
    normals[v * 3 + 1] = sinPhi
    normals[v * 3 + 2] = Math.sin(theta) * cosPhi
    uvs[v * 2] = u
    uvs[v * 2 + 1] = vv
    v++
  }
  for (let i = 0; i < tub; i++) {
    const t0 = (i / tub) * Math.PI * 2
    const t1 = ((i + 1) / tub) * Math.PI * 2
    for (let j = 0; j < rad; j++) {
      const p0 = (j / rad) * Math.PI * 2
      const p1 = ((j + 1) / rad) * Math.PI * 2
      const u0 = i / tub
      const u1 = (i + 1) / tub
      const w0 = j / rad
      const w1 = (j + 1) / rad
      // CCW outside the tube
      emit(t0, p0, u0, w0)
      emit(t0, p1, u0, w1)
      emit(t1, p1, u1, w1)
      emit(t0, p0, u0, w0)
      emit(t1, p1, u1, w1)
      emit(t1, p0, u1, w0)
    }
  }
  return { positions, normals, uvs, vertexCount: v }
}

/** A point of the (p,q)-knot curve on a torus of radius 2·scale (t ∈ [0, 2π]). */
function knotPoint(p: number, q: number, t: number, scale: number): [number, number, number] {
  const r = 2 + Math.cos(q * t)
  return [Math.cos(p * t) * r * scale, Math.sin(q * t) * scale, Math.sin(p * t) * r * scale]
}

export interface TorusKnotParams {
  /** Windings p (default 2). */
  readonly p?: number
  /** Loops q (default 3). */
  readonly q?: number
  /** Radius of the tube (default 0.3). */
  readonly tube?: number
  /** Segments along the curve (default 220). */
  readonly tubularSegments?: number
  /** Segments around the tube (default 14). */
  readonly radialSegments?: number
  /** Overall curve scale (default 0.45 — a knot of radius ~2·scale). */
  readonly scale?: number
}

export function torusKnot(params: TorusKnotParams = {}): Geometry {
  const p = params.p ?? 2
  const q = params.q ?? 3
  const tubeRadius = params.tube ?? 0.3
  const seg = Math.max(8, Math.floor(params.tubularSegments ?? 220))
  const rad = Math.max(3, Math.floor(params.radialSegments ?? 14))
  const scale = params.scale ?? 0.45
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  // Parallel transport: the normal is carried along the curve and re-
  // orthogonalized against the tangent each step (stable; closing the seam
  // slightly skews the UVs — visually imperceptible)
  let prevNormal: [number, number, number] | null = null
  const frames: Array<{ tangent: [number, number, number]; normal: [number, number, number]; binormal: [number, number, number] }> = []
  for (let i = 0; i < seg; i++) {
    const t = (i / seg) * Math.PI * 2
    const tNext = ((i + 1) / seg) * Math.PI * 2
    const a = knotPoint(p, q, t, scale)
    const b = knotPoint(p, q, tNext, scale)
    const tangent: [number, number, number] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const tl = Math.hypot(tangent[0], tangent[1], tangent[2]) || 1
    tangent[0] /= tl
    tangent[1] /= tl
    tangent[2] /= tl
    let normal: [number, number, number]
    if (prevNormal === null) {
      // Starting normal: any vector ⊥ the tangent
      const up: [number, number, number] = Math.abs(tangent[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
      const d = up[1] * tangent[2] - up[2] * tangent[1]
      const e = up[2] * tangent[0] - up[0] * tangent[2]
      const f = up[0] * tangent[1] - up[1] * tangent[0]
      const nl = Math.hypot(d, e, f) || 1
      normal = [d / nl, e / nl, f / nl]
    } else {
      // Transport: projection of the previous normal onto the plane ⊥ the tangent
      const dot = prevNormal[0] * tangent[0] + prevNormal[1] * tangent[1] + prevNormal[2] * tangent[2]
      const nx = prevNormal[0] - dot * tangent[0]
      const ny = prevNormal[1] - dot * tangent[1]
      const nz = prevNormal[2] - dot * tangent[2]
      const nl = Math.hypot(nx, ny, nz) || 1
      normal = [nx / nl, ny / nl, nz / nl]
    }
    prevNormal = normal
    const binormal: [number, number, number] = [
      tangent[1] * normal[2] - tangent[2] * normal[1],
      tangent[2] * normal[0] - tangent[0] * normal[2],
      tangent[0] * normal[1] - tangent[1] * normal[0],
    ]
    frames.push({ tangent, normal, binormal })
  }
  const emit = (
    cx: number, cy: number, cz: number,
    nx: number, ny: number, nz: number,
    u: number, vv: number,
  ): void => {
    positions.push(cx, cy, cz)
    normals.push(nx, ny, nz)
    uvs.push(u, vv)
  }
  for (let i = 0; i < seg; i++) {
    const f0 = frames[i]!
    const f1 = frames[(i + 1) % seg]!
    const c0 = knotPoint(p, q, (i / seg) * Math.PI * 2, scale)
    const c1 = knotPoint(p, q, ((i + 1) / seg) * Math.PI * 2, scale)
    for (let j = 0; j < rad; j++) {
      const a0 = (j / rad) * Math.PI * 2
      const a1 = ((j + 1) / rad) * Math.PI * 2
      const u0 = i / seg
      const u1 = (i + 1) / seg
      const w0 = j / rad
      const w1 = (j + 1) / rad
      const ring0 = (f: typeof f0, ang: number, c: readonly number[]): { pos: [number, number, number]; n: [number, number, number] } => ({
        pos: [
          c[0] + (f.normal[0] * Math.cos(ang) + f.binormal[0] * Math.sin(ang)) * tubeRadius,
          c[1] + (f.normal[1] * Math.cos(ang) + f.binormal[1] * Math.sin(ang)) * tubeRadius,
          c[2] + (f.normal[2] * Math.cos(ang) + f.binormal[2] * Math.sin(ang)) * tubeRadius,
        ],
        n: [
          f.normal[0] * Math.cos(ang) + f.binormal[0] * Math.sin(ang),
          f.normal[1] * Math.cos(ang) + f.binormal[1] * Math.sin(ang),
          f.normal[2] * Math.cos(ang) + f.binormal[2] * Math.sin(ang),
        ],
      })
      const v00 = ring0(f0, a0, c0)
      const v01 = ring0(f0, a1, c0)
      const v11 = ring0(f1, a1, c1)
      const v10 = ring0(f1, a0, c1)
      // CCW outside the tube
      emit(v00.pos[0], v00.pos[1], v00.pos[2], v00.n[0], v00.n[1], v00.n[2], u0, w0)
      emit(v01.pos[0], v01.pos[1], v01.pos[2], v01.n[0], v01.n[1], v01.n[2], u0, w1)
      emit(v11.pos[0], v11.pos[1], v11.pos[2], v11.n[0], v11.n[1], v11.n[2], u1, w1)
      emit(v00.pos[0], v00.pos[1], v00.pos[2], v00.n[0], v00.n[1], v00.n[2], u0, w0)
      emit(v11.pos[0], v11.pos[1], v11.pos[2], v11.n[0], v11.n[1], v11.n[2], u1, w1)
      emit(v10.pos[0], v10.pos[1], v10.pos[2], v10.n[0], v10.n[1], v10.n[2], u1, w0)
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    vertexCount: positions.length / 3,
  }
}
