/**
 * Куб: 6 граней × 2 треугольника × 3 вершины = 36 вершин.
 * Позиционные углы — {-1,+1}² (грань занимает полный [-half,+half]²),
 * текстурные UV — [0,1]². Раздельные таблицы: смешение (урок инцидента
 * «четверть грани»: углы 0..1 сжимали грань в четверть и разносили
 * грани по углам куба) ломало геометрию при корректных UV.
 */

/** Геометрия куба: атрибуты параллельны, по вершине на элемент. */
export interface CubeGeometry {
  readonly positions: Float32Array
  readonly normals: Float32Array
  readonly uvs: Float32Array
  readonly vertexCount: number
}

/** Грань: нормаль + тангенциальный базис (cross(u, v) = n, фронт CCW). */
interface Face {
  readonly n: readonly [number, number, number]
  readonly u: readonly [number, number, number]
  readonly v: readonly [number, number, number]
}

const FACES: readonly Face[] = [
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
  { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
]

/** Позиционные координаты угла грани в единицах half: полный размах. */
const CORNER_POS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
]

/** Текстурные координаты угла (порядок согласован с CORNER_POS). */
const CORNER_UV: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
]

/** Куб половинной стороны `half` (cube(1) — единичный по стороне). */
export function cube(half: number): CubeGeometry {
  const positions = new Float32Array(FACES.length * 6 * 3)
  const normals = new Float32Array(FACES.length * 6 * 3)
  const uvs = new Float32Array(FACES.length * 6 * 2)
  let at = 0
  for (const face of FACES) {
    at = emitFace(face, half, positions, normals, uvs, at)
  }
  return { positions, normals, uvs, vertexCount: FACES.length * 6 }
}

/** Параметры бокса (Task 109, как BoxGeometry three.js): размер + сегменты НА ГРАНЬ. */
export interface BoxParams {
  /** Размер по X. */
  readonly width?: number
  /** Размер по Y. */
  readonly height?: number
  /** Размер по Z. */
  readonly depth?: number
  /** Сегментов вдоль X на гранях ±Z/±Y. */
  readonly widthSegments?: number
  /** Сегментов вдоль Y на гранях ±Z/±X. */
  readonly heightSegments?: number
  /** Сегментов вдоль Z на гранях ±X/±Y. */
  readonly depthSegments?: number
}

/**
 * Бокс width×height×depth с сеткой сегментов на каждую грань (Task 109).
 * box() без аргументов = куб 1×1×1 без сегментов (36 вершин, куб-совместим).
 * UV каждой грани покрывает [0,1]², нормали наружу, winding CCW.
 */
export function box(params: BoxParams = {}): CubeGeometry {
  const width = params.width ?? 1
  const height = params.height ?? 1
  const depth = params.depth ?? 1
  const ws = Math.max(1, Math.floor(params.widthSegments ?? 1))
  const hs = Math.max(1, Math.floor(params.heightSegments ?? 1))
  const ds = Math.max(1, Math.floor(params.depthSegments ?? 1))

  // полугабариты по осям
  const hx = width / 2
  const hy = height / 2
  const hz = depth / 2
  const halfOf = (axis: readonly [number, number, number]): number => {
    const [ax, ay, az] = axis
    if (ax !== 0) return hx
    if (ay !== 0) return hy
    return hz
  }

  // сетка сегментов для каждой грани: (вдоль u, вдоль v)
  const faceSegs: readonly [number, number][] = [
    [ws, hs], [ws, hs], // ±Z: u=X, v=Y
    [ds, hs], [ds, hs], // ±X: u=Z, v=Y
    [ws, ds], [ws, ds], // ±Y: u=X, v=Z
  ]

  const cells = faceSegs.reduce((sum, [su, sv]) => sum + su * sv, 0)
  const vertexCount = cells * 6
  const positions = new Float32Array(vertexCount * 3)
  const normals = new Float32Array(vertexCount * 3)
  const uvs = new Float32Array(vertexCount * 2)

  let at = 0
  for (let f = 0; f < FACES.length; f++) {
    const face = FACES[f]!
    const [su, sv] = faceSegs[f]!
    const hu = halfOf(face.u)
    const hv = halfOf(face.v)
    const hn = halfOf(face.n)
    for (let j = 0; j < sv; j++) {
      for (let i = 0; i < su; i++) {
        // 4 угла ячейки в нормализованных координатах [-1,1]²
        const corners: ReadonlyArray<readonly [number, number, number, number]> = [
          [-1 + (2 * i) / su, -1 + (2 * j) / sv, i / su, j / sv],
          [-1 + (2 * (i + 1)) / su, -1 + (2 * j) / sv, (i + 1) / su, j / sv],
          [-1 + (2 * (i + 1)) / su, -1 + (2 * (j + 1)) / sv, (i + 1) / su, (j + 1) / sv],
          [-1 + (2 * i) / su, -1 + (2 * (j + 1)) / sv, i / su, (j + 1) / sv],
        ]
        const order = [0, 1, 2, 0, 2, 3]
        for (const c of order) {
          const [cp, cq, u, v] = corners[c]!
          positions[at * 3] = face.n[0] * hn + face.u[0] * hu * cp + face.v[0] * hv * cq
          positions[at * 3 + 1] = face.n[1] * hn + face.u[1] * hu * cp + face.v[1] * hv * cq
          positions[at * 3 + 2] = face.n[2] * hn + face.u[2] * hu * cp + face.v[2] * hv * cq
          normals[at * 3] = face.n[0]
          normals[at * 3 + 1] = face.n[1]
          normals[at * 3 + 2] = face.n[2]
          uvs[at * 2] = u
          uvs[at * 2 + 1] = v
          at++
        }
      }
    }
  }
  return { positions, normals, uvs, vertexCount }
}

/** Пишет 6 вершин грани (2 треугольника 0-1-2 / 0-2-3), возвращает новый курсор. */
function emitFace(
  face: Face,
  half: number,
  positions: Float32Array,
  normals: Float32Array,
  uvs: Float32Array,
  at: number,
): number {
  // 4 угла: центр грани ± полная полугарань; порядок согласован с CORNER_UV
  const corners = CORNER_POS.map(([cp, cq]) => [
    (face.n[0] + face.u[0] * cp + face.v[0] * cq) * half,
    (face.n[1] + face.u[1] * cp + face.v[1] * cq) * half,
    (face.n[2] + face.u[2] * cp + face.v[2] * cq) * half,
  ])
  const order = [0, 1, 2, 0, 2, 3]
  for (const corner of order) {
    const [x, y, z] = corners[corner]
    positions[at * 3] = x
    positions[at * 3 + 1] = y
    positions[at * 3 + 2] = z
    normals[at * 3] = face.n[0]
    normals[at * 3 + 1] = face.n[1]
    normals[at * 3 + 2] = face.n[2]
    const [u, v] = CORNER_UV[corner]
    uvs[at * 2] = u
    uvs[at * 2 + 1] = v
    at++
  }
  return at
}
