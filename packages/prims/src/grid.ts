/**
 * Grid — плоская сетка с УПРАВЛЯЕМЫМ разрешением и структурой (Task 112).
 *
 * Досье §10.2: «Пакет @rune/prims — чистые данные, генерируемые и в
 * воркере: quad и tri (фуллскрин), grid (высотки и океаны), cube, …;
 * опция wireframe даёт line-индексы для отладки».
 *
 * Ответ на замечание Task 112 («для океана используется один большой квад,
 * разрешением квада и его внутренней структурой мы не можем управлять»):
 * grid() даёт полный контроль внутренней структуры —
 *  • segmentsX/segmentsZ — разрешение сетки (число ячеек по осям;
 *    вершины (segmentsX+1)×(segmentsZ+1));
 *  • origin + size — положение и размер в мире;
 *  • uv — [0..1] по сетке (для сэмплинга дисплейс-карт);
 *  • indices — треугольники; edgeIndices — уникальные рёбра (wireframe,
 *    gl.LINES / WebGPU line-list — как в FFT-океане).
 *
 * Высотки/океаны собираются связкой prims.grid + вершинный шейдер с
 * дисплейс-текстурой (досье: «высотки собираются из связки prims.grid,
 * transform с текстурой высот»); здесь — чистые данные без GL-зависимостей.
 */

/** Геометрия сетки: позиции (x, z), UV, индексы треугольников и рёбер. */
export interface GridGeometry {
  /** Позиции: (segmentsX+1)·(segmentsZ+1) вершин, интерливинг [x, z]. */
  readonly positions: Float32Array
  /** UV: те же вершины, [u, v]; v растёт по +Z. */
  readonly uvs: Float32Array
  /** Треугольники: segmentsX·segmentsZ·6 индексов (обвод CCW сверху). */
  readonly indices: Uint32Array
  /** Уникальные рёбра (wireframe): пары индексов, gl.LINES-совместимо. */
  readonly edgeIndices: Uint32Array
  readonly vertexCount: number
  readonly indexCount: number
  /** Разрешение (для UI/статистики). */
  readonly segmentsX: number
  readonly segmentsZ: number
}

export interface GridOptions {
  /** Размер по X (метры/юниты). */
  readonly sizeX: number
  /** Размер по Z. */
  readonly sizeZ: number
  /** Число ячеек по X (вершин по X — segmentsX+1). Default 1. */
  readonly segmentsX?: number
  /** Число ячеек по Z. Default = segmentsX. */
  readonly segmentsZ?: number
  /** Центр сетки (x, z). Default [0, 0]. */
  readonly origin?: readonly [number, number]
}

/** Плоская сетка в плоскости XZ (y=0), UV [0..1]. */
export function grid(options: GridOptions): GridGeometry {
  const sizeX = options.sizeX
  const sizeZ = options.sizeZ
  const segmentsX = options.segmentsX ?? 1
  const segmentsZ = options.segmentsZ ?? options.segmentsX ?? 1
  if (!Number.isFinite(sizeX) || !Number.isFinite(sizeZ) || sizeX <= 0 || sizeZ <= 0) {
    throw new Error(`grid: размер должен быть > 0, получено ${sizeX}×${sizeZ}`)
  }
  if (!Number.isInteger(segmentsX) || !Number.isInteger(segmentsZ) || segmentsX < 1 || segmentsZ < 1) {
    throw new Error(`grid: сегменты — целые ≥ 1, получено ${segmentsX}×${segmentsZ}`)
  }
  const [cx, cz] = options.origin ?? [0, 0]
  const halfX = sizeX / 2
  const halfZ = sizeZ / 2

  const cols = segmentsX + 1
  const rows = segmentsZ + 1
  const vertexCount = cols * rows

  const positions = new Float32Array(vertexCount * 2)
  const uvs = new Float32Array(vertexCount * 2)
  let at = 0
  for (let z = 0; z < rows; z++) {
    for (let x = 0; x < cols; x++) {
      const u = x / segmentsX
      const v = z / segmentsZ
      positions[at] = cx - halfX + u * sizeX
      positions[at + 1] = cz - halfZ + v * sizeZ
      uvs[at] = u
      uvs[at + 1] = v
      at += 2
    }
  }

  // Треугольники: CCW при взгляде сверху (+Y). Диагональ ячейки — как в
  // david.li/waves (topLeft→bottomLeft→bottomRight, bottomRight→topRight→topLeft).
  const indices = new Uint32Array(segmentsX * segmentsZ * 6)
  let t = 0
  const edgeSet = new Set<number>()
  const edges: number[] = []
  const addEdge = (a: number, b: number): void => {
    const key = a < b ? a * vertexCount + b : b * vertexCount + a
    if (edgeSet.has(key)) return
    edgeSet.add(key)
    edges.push(a, b)
  }
  for (let z = 0; z < segmentsZ; z++) {
    for (let x = 0; x < segmentsX; x++) {
      const topLeft = z * cols + x
      const topRight = topLeft + 1
      const bottomLeft = topLeft + cols
      const bottomRight = bottomLeft + 1
      indices[t++] = topLeft
      indices[t++] = bottomLeft
      indices[t++] = bottomRight
      indices[t++] = bottomRight
      indices[t++] = topRight
      indices[t++] = topLeft
      addEdge(topLeft, bottomLeft)
      addEdge(bottomLeft, bottomRight)
      addEdge(bottomRight, topRight)
      addEdge(topRight, topLeft)
      addEdge(topLeft, bottomRight)
    }
  }

  return {
    positions,
    uvs,
    indices,
    edgeIndices: new Uint32Array(edges),
    vertexCount,
    indexCount: indices.length,
    segmentsX,
    segmentsZ,
  }
}
