/**
 * Fullscreen quad: 2 triangles in clip space, CCW winding (survives cull
 * 'back' in both backends).
 *
 * UV — in IMAGE COORDINATES: v=0 is the top row, v grows downward.
 * This matches the layout of uploaded data (texSubImage2D/writeTexture
 * write the first row at v=0) and the WebGPU texture origin. NDC y=+1 is
 * the top of the target in both backends, so a quad with these UVs shows
 * images vertically true without UNPACK_FLIP_Y and without "flip it here"
 * branches.
 */

/** Quad geometry: 2D positions and parallel UVs. */
export interface QuadGeometry {
  readonly positions: Float32Array
  readonly uvs: Float32Array
  readonly vertexCount: number
}

/** Corners: [x, y, u, v] — full clip-space extent, image-space UV. */
const CORNERS: ReadonlyArray<readonly [number, number, number, number]> = [
  [-1, -1, 0, 1],
  [1, -1, 1, 1],
  [1, 1, 1, 0],
  [-1, 1, 0, 0],
]

const ORDER = [0, 1, 2, 0, 2, 3]

/** Fullscreen quad: 6 vertices, covers [-1,1]². */
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
