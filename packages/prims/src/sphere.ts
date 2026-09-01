/**
 * UV-сфера (широта/долгота): widthSegments × heightSegments квадов
 * (Task 109: имена параметров — как SphereGeometry в three.js; прежде
 * segments/rings), нормали аналитические (радиальные). Пояс j=0 (φ=0,
 * север) и j=bands−1 (φ=π, юг) схлопнуты в полюс: их полквада с ДВУМЯ
 * полюсными вершинами (нулевая площадь) отбрасывается, второй эмитится —
 * полюсные веера без вырожденных треугольников.
 *
 * БАГ Task 108 (дыра у полюса): цикл шел до bands−1 — последний пояс
 * (до φ=π) НЕ эмитился вовсе. Фикс: полный цикл j < bands, полюс —
 * ровно крайние пояса.
 */

import type { Geometry } from './types.ts'

export interface SphereParams {
  /** Радиус (default 1). */
  readonly radius?: number
  /** Сегментов по долготе (вокруг оси Y, default 48). */
  readonly widthSegments?: number
  /** Поясов по широте (полюс → полюс, default 32). */
  readonly heightSegments?: number
}

export function sphere(params: SphereParams = {}): Geometry {
  const radius = params.radius ?? 1
  const radial = Math.max(3, Math.floor(params.widthSegments ?? 48))
  const bands = Math.max(2, Math.floor(params.heightSegments ?? 32))
  // Полных поясов (bands−2) по 2 треугольника + 2 полюсных по radial —
  // ровно (bands−1)·radial квад-эквивалентов (prealloc точный)
  const quads = (bands - 1) * radial
  const positions = new Float32Array(quads * 6 * 3)
  const normals = new Float32Array(quads * 6 * 3)
  const uvs = new Float32Array(quads * 6 * 2)
  let v = 0
  const emit = (phi: number, theta: number, u: number, vv: number): void => {
    const sinPhi = Math.sin(phi)
    const nx = sinPhi * Math.sin(theta)
    const ny = Math.cos(phi)
    const nz = sinPhi * Math.cos(theta)
    positions[v * 3] = nx * radius
    positions[v * 3 + 1] = ny * radius
    positions[v * 3 + 2] = nz * radius
    normals[v * 3] = nx
    normals[v * 3 + 1] = ny
    normals[v * 3 + 2] = nz
    uvs[v * 2] = u
    uvs[v * 2 + 1] = vv
    v++
  }
  for (let j = 0; j < bands; j++) {
    const phi0 = (j / bands) * Math.PI // 0 = северный полюс (+Y)
    const phi1 = ((j + 1) / bands) * Math.PI
    const northPole = j === 0 // phi0 = 0: весь полюсный ряд — ОДНА точка
    const southPole = j === bands - 1 // phi1 = π: нижний ряд схлопнут
    for (let i = 0; i < radial; i++) {
      const t0 = (i / radial) * Math.PI * 2
      const t1 = ((i + 1) / radial) * Math.PI * 2
      const u0 = i / radial
      const u1 = (i + 1) / radial
      // CCW снаружи; половины квада, схлопывающиеся в полюсную точку
      // (обе вершины на полюсе — нулевая площадь), пропускаем
      if (!southPole) {
        emit(phi1, t0, u0, (j + 1) / bands)
        emit(phi1, t1, u1, (j + 1) / bands)
        emit(phi0, t1, u1, j / bands)
      }
      if (!northPole) {
        emit(phi1, t0, u0, (j + 1) / bands)
        emit(phi0, t1, u1, j / bands)
        emit(phi0, t0, u0, j / bands)
      }
    }
  }
  return { positions, normals, uvs, vertexCount: v }
}
