/**
 * Плоскость-земля (нормаль +Y): width × height МИЛЛИМЕТРОВ… нет, просто
 * единиц, widthSegments × heightSegments ячеек — НЕЗАВИСИМЫЕ размеры и
 * разрешение по осям (Task 109: как PlaneGeometry в three.js; прежде —
 * только квадрат size × size). База для террейнов и «пола» сцен;
 * CCW при взгляде сверху.
 */

import type { Geometry } from './types.ts'

export interface PlaneParams {
  /** Ширина по X (default 1). */
  readonly width?: number
  /** Глубина по Z (default 1). */
  readonly height?: number
  /** Ячеек по X (default 1). */
  readonly widthSegments?: number
  /** Ячеек по Z (default 1). */
  readonly heightSegments?: number
}

export function plane(params: PlaneParams = {}): Geometry {
  const width = params.width ?? 1
  const height = params.height ?? 1
  const cellsX = Math.max(1, Math.floor(params.widthSegments ?? 1))
  const cellsZ = Math.max(1, Math.floor(params.heightSegments ?? 1))
  const halfW = width / 2
  const halfH = height / 2
  const stepX = width / cellsX
  const stepZ = height / cellsZ
  const quads = cellsX * cellsZ
  const positions = new Float32Array(quads * 6 * 3)
  const normals = new Float32Array(quads * 6 * 3)
  const uvs = new Float32Array(quads * 6 * 2)
  let v = 0
  const emit = (i: number, j: number): void => {
    positions[v * 3] = -halfW + i * stepX
    positions[v * 3 + 1] = 0
    positions[v * 3 + 2] = -halfH + j * stepZ
    normals[v * 3] = 0
    normals[v * 3 + 1] = 1
    normals[v * 3 + 2] = 0
    uvs[v * 2] = i / cellsX
    uvs[v * 2 + 1] = j / cellsZ
    v++
  }
  for (let j = 0; j < cellsZ; j++) {
    for (let i = 0; i < cellsX; i++) {
      // CCW при взгляде сверху: cross((i,j+1)−(i,j), (i+1,j+1)−(i,j)) = +Y.
      // Обход (i,j) → (i+1,j) → … давал −Y — плоскость была видна снизу
      emit(i, j)
      emit(i, j + 1)
      emit(i + 1, j + 1)
      emit(i, j)
      emit(i + 1, j + 1)
      emit(i + 1, j)
    }
  }
  return { positions, normals, uvs, vertexCount: v }
}
