/**
 * Диск (круг в плоскости XZ, нормаль +Y) и кольцо- annulus (плоская
 * шайба). Веерная триангуляция от центра (диск) / ленты по радиусам
 * (кольцо); UV концентрические — [0,1]² на bbox.
 */

import type { Geometry } from './types.ts'

export interface DiskParams {
  /** Радиус (default 1). */
  readonly radius?: number
  /** Сегментов по окружности (default 48). */
  readonly segments?: number
}

export function disk(params: DiskParams = {}): Geometry {
  const radius = params.radius ?? 1
  const seg = Math.max(3, Math.floor(params.segments ?? 48))
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2
    const a1 = ((i + 1) / seg) * Math.PI * 2
    const c0 = Math.cos(a0), s0 = Math.sin(a0)
    const c1 = Math.cos(a1), s1 = Math.sin(a1)
    // CCW при взгляде сверху (+Y): центр → a1 → a0
    const tri: ReadonlyArray<readonly [number, number, number, number, number]> = [
      [0, 0, 0.5, 0.5, 0],
      [c1 * radius, s1 * radius, 0.5 + 0.5 * c1, 0.5 + 0.5 * s1, 0],
      [c0 * radius, s0 * radius, 0.5 + 0.5 * c0, 0.5 + 0.5 * s0, 0],
    ]
    for (const [x, z, u, v] of tri) {
      positions.push(x, 0, z)
      normals.push(0, 1, 0)
      uvs.push(u, v)
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    vertexCount: positions.length / 3,
  }
}

export interface RingParams {
  /** Внутренний радиус (default 0.5). */
  readonly innerRadius?: number
  /** Внешний радиус (default 1). */
  readonly outerRadius?: number
  /** Сегментов по окружности (default 48). */
  readonly segments?: number
}

export function ring(params: RingParams = {}): Geometry {
  const innerRadius = params.innerRadius ?? 0.5
  const outerRadius = params.outerRadius ?? 1
  const seg = Math.max(3, Math.floor(params.segments ?? 48))
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2
    const a1 = ((i + 1) / seg) * Math.PI * 2
    const c0 = Math.cos(a0), s0 = Math.sin(a0)
    const c1 = Math.cos(a1), s1 = Math.sin(a1)
    // CCW сверху: (in,a0) → (in,a1) → (out,a1) и (in,a0) → (out,a1) → (out,a0)
    const quad: ReadonlyArray<readonly [number, number, number, number]> = [
      [c0 * innerRadius, s0 * innerRadius, i / seg, 0],
      [c1 * innerRadius, s1 * innerRadius, (i + 1) / seg, 0],
      [c1 * outerRadius, s1 * outerRadius, (i + 1) / seg, 1],
      [c0 * outerRadius, s0 * outerRadius, i / seg, 1],
    ]
    for (const k of [0, 1, 2, 0, 2, 3]) {
      const [x, z, u, v] = quad[k]!
      positions.push(x, 0, z)
      normals.push(0, 1, 0)
      uvs.push(u, v)
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    vertexCount: positions.length / 3,
  }
}
