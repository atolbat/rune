/**
 * Ground plane (+Y normal): width × height in MILLIMETERS… no, just
 * units, widthSegments × heightSegments cells — INDEPENDENT sizes and
 * resolution per axis (Task 109: like PlaneGeometry in three.js; before —
 * only a square size × size). The base for terrains and scene "floors";
 * CCW viewed from above.
 */

import type { Geometry } from './types.ts'

export interface PlaneParams {
  /** Width along X (default 1). */
  readonly width?: number
  /** Depth along Z (default 1). */
  readonly height?: number
  /** Cells along X (default 1). */
  readonly widthSegments?: number
  /** Cells along Z (default 1). */
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
      // CCW viewed from above: cross((i,j+1)−(i,j), (i+1,j+1)−(i,j)) = +Y.
      // The winding (i,j) → (i+1,j) → … gave −Y — the plane was visible
      // from below
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
