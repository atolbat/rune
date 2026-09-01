/**
 * Полноэкранный квад: 2 треугольника в клип-пространстве, обвод CCW
 * (переживает cull 'back' в обоих бэкендах).
 *
 * UV — в КООРДИНАТАХ ИЗОБРАЖЕНИЯ: v=0 — верхняя строка, v растёт вниз.
 * Это совпадает с раскладкой загружаемых данных (texSubImage2D/writeTexture
 * пишут первую строку в v=0) и с origin текстур WebGPU. NDC y=+1 — верх
 * цели в обоих бэкендах, поэтому квад с такими UV показывает картинки
 * вертикально честно без UNPACK_FLIP_Y и без веток «а тут переверни».
 */

/** Геометрия квада: 2D-позиции и параллельные UV. */
export interface QuadGeometry {
  readonly positions: Float32Array
  readonly uvs: Float32Array
  readonly vertexCount: number
}

/** Углы: [x, y, u, v] — полный размах клип-пространства, UV image-space. */
const CORNERS: ReadonlyArray<readonly [number, number, number, number]> = [
  [-1, -1, 0, 1],
  [1, -1, 1, 1],
  [1, 1, 1, 0],
  [-1, 1, 0, 0],
]

const ORDER = [0, 1, 2, 0, 2, 3]

/** Полноэкранный квад: 6 вершин, покрывает [-1,1]². */
export function quad(): QuadGeometry {
  const positions = new Float32Array(ORDER.length * 2)
  const uvs = new Float32Array(ORDER.length * 2)
  let at = 0
  for (const corner of ORDER) {
    const [x, y, u, v] = CORNERS[corner]
    positions[at * 2] = x
    positions[at * 2 + 1] = y
    uvs[at * 2] = u
    uvs[at * 2 + 1] = v
    at++
  }
  return { positions, uvs, vertexCount: ORDER.length }
}
