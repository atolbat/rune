/**
 * Общий тип геометрии @rune/prims: параллельные атрибуты, triangle soup
 * (без индекса — count = вершин; совместимо с renderer.command attributes).
 *
 * Конвенции пакета:
 *   • обход треугольников CCW при взгляде снаружи (front face);
 *   • нормали — единичные, длины 1 ± 1e-5 (аналитические или центральные
 *     разности — НЕ усреднение по граням, кроме плоско-затенённых тел);
 *   • UV — [0,1]² для параметрических поверхностей; у terrain v = НОРМА-
 *     ЛИЗОВАННАЯ ВЫСОТА (шейдер красит по высоте: вода → песок → трава →
 *     скалы → снег);
 *   • у quad (клип-пространство) и cube свои исторические интерфейсы —
 *     структурно совместимы с Geometry.
 */

/** Атрибутный набор triangle-soup геометрии. */
export interface Geometry {
  readonly positions: Float32Array
  readonly normals: Float32Array
  readonly uvs: Float32Array
  readonly vertexCount: number
}

/** Число треугольников (triangle soup: вершины/3). */
export function triangles(g: Geometry): number {
  return g.vertexCount / 3
}

/** Примерный объём атрибутов, байт (демо-инфо «сколько весит»). */
export function geometryBytes(g: Geometry): number {
  return g.positions.byteLength + g.normals.byteLength + g.uvs.byteLength
}

/** Нормализация вектора на месте (возвращает длину ДО нормализации). */
export function normalizeInPlace(v: Float32Array | number[], at: number): number {
  const x = v[at] as number
  const y = v[at + 1] as number
  const z = v[at + 2] as number
  const len = Math.hypot(x, y, z)
  if (len > 1e-12) {
    v[at] = x / len
    v[at + 1] = y / len
    v[at + 2] = z / len
  }
  return len
}
