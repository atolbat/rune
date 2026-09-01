/**
 * Капсула: цилиндр + две полусферы (радиус r, длина цилиндрической части
 * height — как CapsuleGeometry в three.js), нормали аналитические.
 * Профиль — полукольцо φ ∈ [0, π] (верхний полюс → экватор → нижний):
 * точка кольца = (r·cosθ, y(φ), r·sinθ), нормаль =
 * (cosθ·sinφ, cosφ, sinθ·sinφ) — на полюсах sinφ=0, нормаль честно (0, ±1, 0).
 *
 * Массивы — точный prealloc (Task 108): полный счёт треугольников
 * известен заранее — 2·radial·(ringCount−2).
 */

import type { Geometry } from './types.ts'

export interface CapsuleParams {
  /** Радиус тела (default 0.6). */
  readonly radius?: number
  /** Длина цилиндрической части (default 1.2). */
  readonly height?: number
  /** Сегментов вокруг оси (default 32). */
  readonly radialSegments?: number
  /** Поясов на КАЖДУЮ полусферу (default 10). */
  readonly capSegments?: number
}

export function capsule(params: CapsuleParams = {}): Geometry {
  const radius = params.radius ?? 0.6
  const length = params.height ?? 1.2
  const rr = Math.max(3, Math.floor(params.radialSegments ?? 32))
  const halfRings = Math.max(2, Math.floor(params.capSegments ?? 10))
  const half = length / 2
  const ringCount = halfRings * 2 + 1 // полюс … стык … экватор … стык … полюс
  const triCount = 2 * rr * (ringCount - 2)
  const positions = new Float32Array(triCount * 3 * 3)
  const normals = new Float32Array(triCount * 3 * 3)
  const uvs = new Float32Array(triCount * 3 * 2)
  let v = 0
  // Кольцо профиля k → (φ, y-центр дуги): верхняя полусфера центр +half,
  // нижняя −half; y(φ) = центр дуги ± cosφ·r
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
    const northPole = k === 0 // кольцо a схлопнуто в верхний полюс
    const southPole = k === ringCount - 2 // кольцо b — в нижний
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
      // CCW снаружи; вырожденные полюсные половины пропускаем:
      // k=0 — кольцо a схлопнуто (обе a-вершины — полюс) → треугольник (a,a,b) вырожден;
      // k=ringCount−2 — кольцо b схлопнуто → треугольник (a,b,b) вырожден
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
