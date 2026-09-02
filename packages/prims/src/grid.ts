/**
 * Grid — a flat mesh with CONTROLLABLE resolution and structure (Task 112).
 *
 * Dossier §10.2: "The @rune/prims package — pure data, generated in a
 * worker too: quad and tri (fullscreen), grid (heightfields and oceans),
 * cube, …; the wireframe option gives line indices for debugging".
 *
 * The answer to the Task 112 remark ("the ocean uses one big quad; we
 * cannot control the quad's resolution and its internal structure"):
 * grid() gives full control over the internal structure —
 *  • segmentsX/segmentsZ — mesh resolution (cell count per axis;
 *    vertices (segmentsX+1)×(segmentsZ+1));
 *  • origin + size — position and size in the world;
 *  • uv — [0..1] over the mesh (for displacement-map sampling);
 *  • indices — triangles; edgeIndices — unique edges (wireframe,
 *    gl.LINES / WebGPU line-list — as in the FFT ocean).
 *
 * Heightfields/oceans are assembled from prims.grid + a vertex shader with
 * a displacement texture (dossier: "heightfields are assembled from
 * prims.grid plus a transform with a height texture"); here — pure data
 * without GL dependencies.
 */

/** Mesh geometry: positions (x, z), UVs, triangle and edge indices. */
export interface GridGeometry {
  /** Positions: (segmentsX+1)·(segmentsZ+1) vertices, interleaved [x, z]. */
  readonly positions: Float32Array
  /** UVs: the same vertices, [u, v]; v grows along +Z. */
  readonly uvs: Float32Array
  /** Triangles: segmentsX·segmentsZ·6 indices (CCW winding from above). */
  readonly indices: Uint32Array
  /** Unique edges (wireframe): index pairs, gl.LINES-compatible. */
  readonly edgeIndices: Uint32Array
  readonly vertexCount: number
  readonly indexCount: number
  /** Resolution (for UI/statistics). */
  readonly segmentsX: number
  readonly segmentsZ: number
}

export interface GridOptions {
  /** Size along X (meters/units). */
  readonly sizeX: number
  /** Size along Z. */
  readonly sizeZ: number
  /** Number of cells along X (vertices along X — segmentsX+1). Default 1. */
  readonly segmentsX?: number
  /** Number of cells along Z. Default = segmentsX. */
  readonly segmentsZ?: number
  /** Mesh center (x, z). Default [0, 0]. */
  readonly origin?: readonly [number, number]
}

/** Flat mesh in the XZ plane (y=0), UV [0..1]. */
export function grid(options: GridOptions): GridGeometry {
  const sizeX = options.sizeX
  const sizeZ = options.sizeZ
  const segmentsX = options.segmentsX ?? 1
  const segmentsZ = options.segmentsZ ?? options.segmentsX ?? 1
  if (!Number.isFinite(sizeX) || !Number.isFinite(sizeZ) || sizeX <= 0 || sizeZ <= 0) {
    throw new Error(`grid: size must be > 0, got ${sizeX}×${sizeZ}`)
  }
  if (!Number.isInteger(segmentsX) || !Number.isInteger(segmentsZ) || segmentsX < 1 || segmentsZ < 1) {
    throw new Error(`grid: segments must be integers ≥ 1, got ${segmentsX}×${segmentsZ}`)
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

  // Triangles: CCW viewed from above (+Y). The cell diagonal — as in
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
