/**
 * Cube: 6 faces × 2 triangles × 3 vertices = 36 vertices.
 * Positional corners — {-1,+1}² (a face spans the full [-half,+half]²),
 * texture UVs — [0,1]². Separate tables: mixing them (the lesson of the
 * "quarter face" incident: corners 0..1 squeezed the face into a quarter
 * and scattered faces across cube corners) broke the geometry while the
 * UVs were correct.
 */

/** Cube geometry: attributes are parallel, one vertex per element. */
export interface CubeGeometry {
  readonly positions: Float32Array
  readonly normals: Float32Array
  readonly uvs: Float32Array
  readonly vertexCount: number
}

/** Face: normal + tangential basis (cross(u, v) = n, CCW front). */
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

/** Positional coordinates of a face corner in units of half: full extent. */
const CORNER_POS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
]

/** Texture coordinates of a corner (order matches CORNER_POS). */
const CORNER_UV: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
]

/** Cube with half side length `half` (cube(1) is unit by side). */
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

/** Box parameters (Task 109, like three.js BoxGeometry): size + segments PER FACE. */
export interface BoxParams {
  /** Size along X. */
  readonly width?: number
  /** Size along Y. */
  readonly height?: number
  /** Size along Z. */
  readonly depth?: number
  /** Segments along X on the ±Z/±Y faces. */
  readonly widthSegments?: number
  /** Segments along Y on the ±Z/±X faces. */
  readonly heightSegments?: number
  /** Segments along Z on the ±X/±Y faces. */
  readonly depthSegments?: number
}

/**
 * Box width×height×depth with a segment grid on each face (Task 109).
 * box() with no arguments = a 1×1×1 cube without segments (36 vertices,
 * cube-compatible). Each face's UV covers [0,1]², normals point outward,
 * CCW winding.
 */
export function box(params: BoxParams = {}): CubeGeometry {
  const width = params.width ?? 1
  const height = params.height ?? 1
  const depth = params.depth ?? 1
  const ws = Math.max(1, Math.floor(params.widthSegments ?? 1))
  const hs = Math.max(1, Math.floor(params.heightSegments ?? 1))
  const ds = Math.max(1, Math.floor(params.depthSegments ?? 1))

  // half-extents along the axes
  const hx = width / 2
  const hy = height / 2
  const hz = depth / 2
  const halfOf = (axis: readonly [number, number, number]): number => {
    const [ax, ay] = axis
    if (ax !== 0) return hx
    if (ay !== 0) return hy
    return hz
  }

  // segment grid for each face: (along u, along v)
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
        // 4 corners of a cell in normalized coordinates [-1,1]²
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

/** Writes 6 vertices of a face (2 triangles 0-1-2 / 0-2-3), returns the new cursor. */
function emitFace(
  face: Face,
  half: number,
  positions: Float32Array,
  normals: Float32Array,
  uvs: Float32Array,
  at: number,
): number {
  // 4 corners: face center ± the full half-face; order matches CORNER_UV
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
