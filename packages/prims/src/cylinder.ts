/**
 * Цилиндр / конус / усечённый конус: боковая поверхность (радиус может
 * плавно меняться по высоте) + опциональные крышки (Task 109: openEnded —
 * как CylinderGeometry в three.js). Нормали боковой — аналитические с
 * учётом наклона профиля (не радиальные!) — на конусе смотрят в стороны
 * от оси, как положено.
 *
 * radiusTop = 0 — конус (верхнее кольцо вырождается в вершину; треугольники
 * с двумя совпадающими точками отбрасываются — апекс эмитится один раз на
 * сегмент с корректным UV).
 *
 * БАГ Task 108 («бочка зубчатая»): вторая половина каждого бокового квада
 * шла (P00, P11, P10) — cross(B−A, C−A) смотрел ВНУТРЬ. Фикс: (P00, P10, P11).
 *
 * Массивы — точный prealloc: счёт треугольников известен заранее.
 */

import type { Geometry } from './types.ts'

export interface CylinderParams {
  /** Радиус верхнего кольца (default 1); 0 — конус. */
  readonly radiusTop?: number
  /** Радиус нижнего кольца (default 1). */
  readonly radiusBottom?: number
  /** Высота по Y (default 2). */
  readonly height?: number
  /** Сегментов вокруг оси (default 48). */
  readonly radialSegments?: number
  /** Поясов по высоте (default 1). */
  readonly heightSegments?: number
  /** Без крышек (default false — с крышками). */
  readonly openEnded?: boolean
}

export function cylinder(params: CylinderParams = {}): Geometry {
  const rTop = params.radiusTop ?? 1
  const rBottom = params.radiusBottom ?? 1
  const height = params.height ?? 2
  const radial = Math.max(3, Math.floor(params.radialSegments ?? 48))
  const hSegs = Math.max(1, Math.floor(params.heightSegments ?? 1))
  const caps = params.openEnded !== true
  const apex = rTop <= 1e-9
  const bottomApex = rBottom <= 1e-9
  // Точный счёт: бок + верхняя крышка + нижняя крышка.
  // Вырожденные кольца: r0=0 — только ПЕРВЫЙ ряд (первая половина квада
  // вырождена), r1=0 — только ПОСЛЕДНИЙ (вторая). Оба нуля — вырожденный
  // вход, бок пуст.
  const sideTris = apex && bottomApex
    ? 0
    : radial * (2 * hSegs - (apex ? 1 : 0) - (bottomApex ? 1 : 0))
  const capTris = (caps && !apex ? radial : 0) + (caps && !bottomApex ? radial : 0)
  const vertexCount = (sideTris + capTris) * 3
  const positions = new Float32Array(vertexCount * 3)
  const normals = new Float32Array(vertexCount * 3)
  const uvs = new Float32Array(vertexCount * 2)
  let v = 0
  // Наклон профиля: dr/dy → нормаль боковой наклонена
  const dr = (rBottom - rTop) / height
  const slopeLen = Math.hypot(1, dr)
  const nySide = dr / slopeLen
  const nrSide = 1 / slopeLen
  const emit = (
    x: number, y: number, z: number,
    nx: number, nyy: number, nz: number,
    u: number, vv: number,
  ): void => {
    positions[v * 3] = x
    positions[v * 3 + 1] = y
    positions[v * 3 + 2] = z
    normals[v * 3] = nx
    normals[v * 3 + 1] = nyy
    normals[v * 3 + 2] = nz
    uvs[v * 2] = u
    uvs[v * 2 + 1] = vv
    v++
  }
  // Боковая: кольца по высоте; вырожденное кольцо (радиус 0) схлопывается
  // в апекс: эмитится ОДИН треугольник на сегмент. Условия — ПО РЯДУ
  // (r0/r1 ряда), а не глобальные: при heightSegments>1 нулевой радиус
  // только в крайнем ряду
  for (let j = 0; j < hSegs; j++) {
    const v0 = j / hSegs
    const v1 = (j + 1) / hSegs
    const y0 = -height / 2 + v0 * height
    const y1 = -height / 2 + v1 * height
    const r0 = rBottom + (rTop - rBottom) * v0
    const r1 = rBottom + (rTop - rBottom) * v1
    for (let i = 0; i < radial; i++) {
      const a0 = (i / radial) * Math.PI * 2
      const a1 = ((i + 1) / radial) * Math.PI * 2
      const u0 = i / radial
      const u1 = (i + 1) / radial
      const c0 = Math.cos(a0), s0 = Math.sin(a0)
      const c1 = Math.cos(a1), s1 = Math.sin(a1)
      // CCW снаружи: обе половины квада (P00→P11→P01) и (P00→P10→P11);
      // половина с нулевым кольцом ряда вырождена — пропускаем
      if (r0 > 1e-9) {
        emit(r0 * c0, y0, r0 * s0, c0 * nrSide, nySide, s0 * nrSide, u0, v0)
        emit(r1 * c1, y1, r1 * s1, c1 * nrSide, nySide, s1 * nrSide, u1, v1)
        emit(r0 * c1, y0, r0 * s1, c1 * nrSide, nySide, s1 * nrSide, u1, v0)
      }
      if (r1 > 1e-9) {
        emit(r0 * c0, y0, r0 * s0, c0 * nrSide, nySide, s0 * nrSide, u0, v0)
        emit(r1 * c0, y1, r1 * s0, c0 * nrSide, nySide, s0 * nrSide, u0, v1)
        emit(r1 * c1, y1, r1 * s1, c1 * nrSide, nySide, s1 * nrSide, u1, v1)
      }
    }
  }
  if (caps) {
    const yTop = height / 2
    const yBot = -height / 2
    if (!apex) {
      // Верхняя крышка (+Y): веер, CCW при взгляде сверху
      for (let i = 0; i < radial; i++) {
        const a0 = (i / radial) * Math.PI * 2
        const a1 = ((i + 1) / radial) * Math.PI * 2
        emit(0, yTop, 0, 0, 1, 0, 0.5, 0.5)
        emit(rTop * Math.cos(a1), yTop, rTop * Math.sin(a1), 0, 1, 0, 0.5 + 0.5 * Math.cos(a1), 0.5 + 0.5 * Math.sin(a1))
        emit(rTop * Math.cos(a0), yTop, rTop * Math.sin(a0), 0, 1, 0, 0.5 + 0.5 * Math.cos(a0), 0.5 + 0.5 * Math.sin(a0))
      }
    }
    if (!bottomApex) {
      // Нижняя крышка (−Y): обратный обход
      for (let i = 0; i < radial; i++) {
        const a0 = (i / radial) * Math.PI * 2
        const a1 = ((i + 1) / radial) * Math.PI * 2
        emit(0, yBot, 0, 0, -1, 0, 0.5, 0.5)
        emit(rBottom * Math.cos(a0), yBot, rBottom * Math.sin(a0), 0, -1, 0, 0.5 + 0.5 * Math.cos(a0), 0.5 + 0.5 * Math.sin(a0))
        emit(rBottom * Math.cos(a1), yBot, rBottom * Math.sin(a1), 0, -1, 0, 0.5 + 0.5 * Math.cos(a1), 0.5 + 0.5 * Math.sin(a1))
      }
    }
  }
  return { positions, normals, uvs, vertexCount: v }
}

export interface ConeParams {
  /** Радиус основания (default 1). */
  readonly radius?: number
  /** Высота по Y (default 2). */
  readonly height?: number
  /** Сегментов вокруг оси (default 48). */
  readonly radialSegments?: number
  /** Поясов по высоте (default 1). */
  readonly heightSegments?: number
  /** Без основания (default false). */
  readonly openEnded?: boolean
}

/** Конус: cylinder с radiusTop = 0. */
export function cone(params: ConeParams = {}): Geometry {
  return cylinder({
    radiusTop: 0,
    radiusBottom: params.radius ?? 1,
    height: params.height ?? 2,
    radialSegments: params.radialSegments ?? 48,
    heightSegments: params.heightSegments ?? 1,
    openEnded: params.openEnded ?? false,
  })
}
