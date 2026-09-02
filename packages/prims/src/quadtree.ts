/**
 * Quadtree LOD — a tile grid with adaptive resolution "to the horizon"
 * (Task 113; user report: "one quad… create a quadtree-like structure so
 * that many small quads form an ocean to the horizon (or a distance
 * limit)").
 *
 * SOLUTION: this primitive REPLACES the planned terrain primitive of
 * dossier §10.2 — a universal "quadtree around the observer" system covers
 * both the ocean (an FFT displacement texture) and heightfields (a height
 * map): the same tile geometry, the same splitting criterion.
 *
 * Design modeled on industry examples (Task 113 research):
 *  • Crest Ocean System (SIGGRAPH 2017/2019, wave-harmonic) — "the surface
 *    is composed of concentric rings of geometry tiles, each ring a
 *    power of two"; a quadtree around the observer gives the same structure;
 *  • Geometry Clipmaps (GPU Gems 2, ch. 2) — static geometry, adaptation
 *    by position/scale, not by rebuilding buffers;
 *  • GPU Gems 2, ch. 18 (Pacific Fighters) — vertex-reads-texture.
 *
 * OPTIMIZATION (the key idea): NOT A SINGLE vertex/index buffer is rebuilt
 * in a frame. The unit tile mesh is static; per frame the CPU only picks
 * the visible tiles (hundreds of nodes, microseconds) and packs them into
 * the instance buffer [cx, cz, size, level]×N → ONE instanced draw for the
 * whole ocean. World-position expansion — in the vertex shader.
 *
 * Cracks between levels (T-junction) are closed by a "skirt" — a vertical
 * wall along the tile perimeter (the caisson technique of Cesium and
 * landscape renderers): simpler and more robust than Crest's morphing,
 * +6% vertices.
 *
 * Pure data without GL dependencies — generated in a worker too.
 */

/** Tiles selected by selectQuadtreeTiles (camera-centered variant). */
export interface QuadtreeTilesSelection {
  /** Packed instances: [cx, cz, size, level] × count (stride 4). */
  readonly instances: Float32Array
  /** Number of tiles (instances.length === 4·count). */
  count: number
  /** Minimum/maximum level of the selected tiles (for statistics). */
  minLevel: number
  maxLevel: number
  /** Capacity of instances (in floats; not to be confused with count). */
  readonly capacity: number
}

export interface QuadtreeSelectOptions {
  /** Quadtree center X (the observer's position, preferably snapped — see below). */
  readonly centerX: number
  /** Quadtree center Z. */
  readonly centerZ: number
  /** Size of the ROOT quad (the world's edge; a power of two). */
  readonly rootSize: number
  /** Number of levels: 1 = root only; level L-1 — the smallest tiles
   *  (size = rootSize / 2^(levels-1)). */
  readonly levels: number
  /** Split a node while size > splitFactor · dist(node center, center).
   *  Smaller — denser near the camera (each cell ≈ splitFactor/N radians). */
  readonly splitFactor?: number
  /** A safety limit on the number of tiles (default 4096). */
  readonly maxTiles?: number
  /** Frustum culling: 6 normalized planes (a,b,c,d)×6 — 24 floats,
   *  "inside" = a·x+b·y+c·z+d ≥ 0. Without the field — draw all tiles. */
  readonly frustum?: Float32Array
  /** Vertical half-extent of tiles for culling (waves/skirt/heights). */
  readonly yRadius?: number
  /** A reusable selection (capacity grows when insufficient). */
  readonly out?: QuadtreeTilesSelection
}

/**
 * Selection of quadtree tiles around a center: recursion from the root,
 * splitting by distance, frustum culling (a conservative sphere).
 * Stability: pass a center snapped to the 2·(rootSize/2^levels) grid —
 * then the tessellation changes only when crossing boundaries, without
 * "drifting".
 */
export function selectQuadtreeTiles(options: QuadtreeSelectOptions): QuadtreeTilesSelection {
  const {
    centerX,
    centerZ,
    rootSize,
    levels,
    frustum,
  } = options
  const splitFactor = options.splitFactor ?? 1
  const maxTiles = options.maxTiles ?? 4096
  const yRadius = options.yRadius ?? 0

  if (!Number.isFinite(rootSize) || rootSize <= 0) {
    throw new Error(`quadtree: rootSize must be > 0, got ${rootSize}`)
  }
  if (!Number.isInteger(levels) || levels < 1 || levels > 24) {
    throw new Error(`quadtree: levels must be an integer 1..24, got ${levels}`)
  }
  if (!Number.isFinite(splitFactor) || splitFactor <= 0) {
    throw new Error(`quadtree: splitFactor must be > 0, got ${splitFactor}`)
  }
  if (frustum !== undefined && frustum.length !== 24) {
    throw new Error(`quadtree: frustum must be 24 floats (6 planes), got ${frustum.length}`)
  }

  const out = options.out ?? {
    instances: new Float32Array(4 * 64),
    count: 0,
    minLevel: 0,
    maxLevel: 0,
    capacity: 4 * 64,
  }
  out.count = 0
  out.minLevel = levels - 1
  out.maxLevel = 0

  // An explicit node stack (no recursion): [cx, cz, size, level]×depth-bounded.
  // Every visited node either lands in the selection or splits into 4 —
  // in total ≤ (4/3)·maxTiles nodes are visited.
  const stack: number[] = [centerX, centerZ, rootSize, 0]
  let minLevelSeen = levels - 1
  let maxLevelSeen = 0

  while (stack.length > 0) {
    const level = stack.pop() as number
    const size = stack.pop() as number
    const cz = stack.pop() as number
    const cx = stack.pop() as number

    // Frustum: a conservative sphere (center y=0, radius = half-diagonal + y).
    if (frustum !== undefined && quadtreeSphereOutside(frustum, cx, cz, size, yRadius)) {
      continue
    }

    // Splitting: a tile keeps a constant ANGULAR size ~splitFactor/N —
    // the Crest/GPU-Gems criterion (screen-space error via distance).
    const dx = cx - centerX
    const dz = cz - centerZ
    const dist = Math.sqrt(dx * dx + dz * dz)
    const halfSide = size * 0.5 // the tile's closest point to the center
    if (level + 1 < levels && size > splitFactor * Math.max(dist - halfSide, 0) && out.count + 4 <= maxTiles) {
      const q = size * 0.25
      stack.push(cx - q, cz - q, size * 0.5, level + 1)
      stack.push(cx + q, cz - q, size * 0.5, level + 1)
      stack.push(cx - q, cz + q, size * 0.5, level + 1)
      stack.push(cx + q, cz + q, size * 0.5, level + 1)
      continue
    }
    // A HARD cap: the instance buffer holds exactly maxTiles records (the
    // stack tail is discarded — in real scenes the count ≪ the cap, this is
    // a safety limit).
    if (out.count >= maxTiles) break

    if (out.count * 4 + 4 > out.instances.length) {
      // Lazy capacity growth (a typical frame — no growth: the buffer is
      // already warm).
      const grown = new Float32Array(out.instances.length * 2)
      grown.set(out.instances)
      const mutable = out as { instances: Float32Array; capacity: number }
      mutable.instances = grown
      mutable.capacity = grown.length
    }
    const o = out.count * 4
    out.instances[o] = cx
    out.instances[o + 1] = cz
    out.instances[o + 2] = size
    out.instances[o + 3] = level
    out.count++
    if (level < minLevelSeen) minLevelSeen = level
    if (level > maxLevelSeen) maxLevelSeen = level
  }

  out.minLevel = out.count === 0 ? 0 : minLevelSeen
  out.maxLevel = out.count === 0 ? 0 : maxLevelSeen
  return out
}

/** The tile's sphere fully outside one of the planes → cull. */
function quadtreeSphereOutside(
  planes: Float32Array,
  cx: number,
  cz: number,
  size: number,
  yRadius: number,
): boolean {
  // Radius over XZ: the square's half-diagonal; over Y — yRadius (a sphere).
  const r = Math.sqrt(0.5 * size * 0.5 * size * 2 + yRadius * yRadius)
  for (let p = 0; p < 6; p++) {
    const o = p * 4
    const d = planes[o] * cx + planes[o + 2] * cz + planes[o + 3]
    if (d < -r) return true
  }
  return false
}

/** Unit tile geometry: a [0..1]² grid + a skirt around the perimeter. */
export interface QuadtreeTileMesh {
  /** Positions: stride 3 — (u, v, skirt), u/v ∈ [0..1], the skirt repeats
   *  the edge UVs with skirt=1 (the wall goes DOWN in the shader:
   *  y -= skirt·depth). */
  readonly positions: Float32Array
  /** UV = (u, v) — the same grid coordinates (stride 2). */
  readonly uvs: Float32Array
  /** Triangles: grid + skirt (4·segments walls). */
  readonly indices: Uint32Array
  /** Unique GRID edges (without the skirt) — wireframe/LOD inspection. */
  readonly edgeIndices: Uint32Array
  readonly vertexCount: number
  /** Number of skirt vertices (for statistics). */
  readonly skirtVertexCount: number
  readonly segments: number
}

export interface QuadtreeTileMeshOptions {
  /** Cells per side (default 32; (N+1)² vertices). */
  readonly segments?: number
  /** A skirt wall around the perimeter (default true). */
  readonly skirt?: boolean
}

/**
 * A unit tile [0..1]² — STATIC geometry for instanced rendering:
 * world position = instance.xy + (uv − 0.5)·instance.size (shader).
 *
 * Skirt: duplicated edge vertices (the same u/v, skirt=1) + vertical wall
 * quads; closes T-cracks between neighbors of different levels.
 * Edge indices (wireframe) do NOT include the skirt — the LOD structure
 * reads cleanly.
 */
export function quadtreeTileMesh(options: QuadtreeTileMeshOptions = {}): QuadtreeTileMesh {
  const segments = options.segments ?? 32
  const withSkirt = options.skirt ?? true
  if (!Number.isInteger(segments) || segments < 1 || segments > 256) {
    throw new Error(`quadtreeTileMesh: segments must be an integer 1..256, got ${segments}`)
  }

  const cols = segments + 1
  const gridCount = cols * cols
  // Skirt: 4 edges × (segments+1) vertices (corners are duplicated — simplicity).
  const skirtCount = withSkirt ? 4 * cols : 0
  const vertexCount = gridCount + skirtCount

  const positions = new Float32Array(vertexCount * 3)
  const uvs = new Float32Array(vertexCount * 2)

  let at = 0
  let uvAt = 0
  for (let z = 0; z < cols; z++) {
    for (let x = 0; x < cols; x++) {
      const u = x / segments
      const v = z / segments
      positions[at++] = u
      positions[at++] = v
      positions[at++] = 0
      uvs[uvAt++] = u
      uvs[uvAt++] = v
    }
  }

  // Skirt: edge vertex index → a duplicate with skirt=1.
  const skirtIndexOf = new Int32Array(gridCount).fill(-1)
  if (withSkirt) {
    let s = gridCount
    // top (v=0) and bottom (v=1) edges
    for (let x = 0; x < cols; x++) {
      const top = x
      const bottom = segments * cols + x
      skirtIndexOf[top] = s
      positions[s * 3] = positions[top * 3]
      positions[s * 3 + 1] = positions[top * 3 + 1]
      positions[s * 3 + 2] = 1
      uvs[s * 2] = positions[top * 3]
      uvs[s * 2 + 1] = positions[top * 3 + 1]
      s++
      skirtIndexOf[bottom] = s
      positions[s * 3] = positions[bottom * 3]
      positions[s * 3 + 1] = positions[bottom * 3 + 1]
      positions[s * 3 + 2] = 1
      uvs[s * 2] = positions[bottom * 3]
      uvs[s * 2 + 1] = positions[bottom * 3 + 1]
      s++
    }
    // left (u=0) and right (u=1) edges (the corners already exist — we
    // duplicate them too: the walls of adjacent edges overlap at the
    // corners, which is harmless)
    for (let z = 0; z < cols; z++) {
      const left = z * cols
      const right = z * cols + segments
      skirtIndexOf[left] = s
      positions[s * 3] = positions[left * 3]
      positions[s * 3 + 1] = positions[left * 3 + 1]
      positions[s * 3 + 2] = 1
      uvs[s * 2] = positions[left * 3]
      uvs[s * 2 + 1] = positions[left * 3 + 1]
      s++
      skirtIndexOf[right] = s
      positions[s * 3] = positions[right * 3]
      positions[s * 3 + 1] = positions[right * 3 + 1]
      positions[s * 3 + 2] = 1
      uvs[s * 2] = positions[right * 3]
      uvs[s * 2 + 1] = positions[right * 3 + 1]
      s++
    }
  }

  // Grid triangles — CCW from above (the same orientation as prims/grid).
  const triCount = segments * segments * 2 + (withSkirt ? segments * 8 : 0)
  const indices = new Uint32Array(triCount * 3)
  let t = 0
  for (let z = 0; z < segments; z++) {
    for (let x = 0; x < segments; x++) {
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
    }
  }

  // Skirt walls: a quad (edge vertex, its skirt duplicate, the next pair).
  if (withSkirt) {
    const wall = (a: number, b: number): void => {
      // a → b along the edge; sa/sb — the skirts of a/b. Two triangles, any
      // orientation (the wall is vertical, visible from both sides — usually
      // rendered with cull off or the orientation alternates; the ocean is
      // not culled).
      const sa = skirtIndexOf[a]
      const sb = skirtIndexOf[b]
      if (sa < 0 || sb < 0) return
      indices[t++] = a
      indices[t++] = sa
      indices[t++] = sb
      indices[t++] = sb
      indices[t++] = b
      indices[t++] = a
    }
    for (let x = 0; x < segments; x++) {
      wall(x, x + 1) // top edge
      wall(segments * cols + x, segments * cols + x + 1) // bottom
    }
    for (let z = 0; z < segments; z++) {
      wall(z * cols, (z + 1) * cols) // left
      wall(z * cols + segments, (z + 1) * cols + segments) // right
    }
  }

  // Grid edges (unique, with diagonals — as in prims/grid): the skirt is
  // not included.
  const edgeSet = new Set<number>()
  const edges: number[] = []
  const addEdge = (a: number, b: number): void => {
    const key = a < b ? a * vertexCount + b : b * vertexCount + a
    if (edgeSet.has(key)) return
    edgeSet.add(key)
    edges.push(a, b)
  }
  for (let z = 0; z < segments; z++) {
    for (let x = 0; x < segments; x++) {
      const topLeft = z * cols + x
      const topRight = topLeft + 1
      const bottomLeft = topLeft + cols
      const bottomRight = bottomLeft + 1
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
    skirtVertexCount: skirtCount,
    segments,
  }
}

// ════════════════════════════════════════════════════════════════════════════
// The "OCEAN-EXACT" API pair (Task 113 → library, Task 115): a world fixed
// grid of roots, culling by view direction, zero allocations per frame,
// skirts of bit-continuous displacement. Ported 1:1 from the validated FFT
// ocean demo (a quadtree up to 10 km, 300K+ tris, UI LOD aggressiveness).
// ════════════════════════════════════════════════════════════════════════════

/** Default patch cells per side (33×33 vertices inside + the skirt ring). */
export const PATCH_CELLS = 32
/** Patch vertices: (PATCH_CELLS+3)² — the inner grid + the skirt. */
export const PATCH_VERTEX_COUNT = (PATCH_CELLS + 3) * (PATCH_CELLS + 3)
/** Triangles per leaf: the whole 35×35-cell grid (interior + skirt walls). */
export const PATCH_TRIANGLE_COUNT = (PATCH_CELLS + 2) * (PATCH_CELLS + 2) * 2
/** Wireframe edges: only the inner grid (the skirt is not drawn — a cleaner look). */
export const PATCH_WIRE_EDGE_COUNT = PATCH_CELLS * (PATCH_CELLS + 1) * 2

/** Default quadtree root tile, m (the world fixed grid). */
export const ROOT_SIZE = 4096
/** Default coverage distance, m. */
export const HORIZON_DISTANCE = 10000
/** Default leaf cap (the instance buffer capacity). */
export const MAX_INSTANCES = 2048

/** LOD parameters from aggressiveness (one setting: falloff + near limit). */
export interface LodParams {
  /** A node splits while dist < size·K. Smaller K ⇒ more aggressive simplification. */
  K: number
  /** A hard depth cap (the near-field detail limit). */
  maxDepth: number
  /** Minimum leaf, m. */
  minLeafSize: number
}

/**
 * Aggressiveness → LOD parameters (user report: "aggressive by default,
 * with a setting for both the detail of the nearest quads (a limit) and
 * the falloff speed"):
 *  - A ∈ [1..3], default 2 (aggressive);
 *  - K = 4.5/A — the speed of detail falloff with distance;
 *  - minLeafSize 64/128/256 m by A steps — a hard near-field detail limit
 *    ("not to infinity").
 */
export function lodParams(aggressiveness: number): LodParams {
  const a = Math.max(1, Math.min(3, aggressiveness))
  const K = 4.5 / a
  const minLeafSize = a < 1.5 ? 64 : a < 2.5 ? 128 : 256
  const maxDepth = Math.round(Math.log2(ROOT_SIZE / minLeafSize))
  return { K, maxDepth, minLeafSize }
}

/**
 * The quadtree patch grid: (segments+3)² vertices (x, z, skirt) — local
 * coordinates in CELLS [0..segments]; the skirt ring's position is SNAPPED
 * to the edge (the same (x,z) ⇒ the same world XZ ⇒ the same uv ⇒ a
 * bit-identical edge displacement — no cracks at T-junctions), the skirt=1
 * flag (the wall goes down in the shader). Indices: the whole grid's
 * triangles + the inner part's edges (wireframe without the skirt — a
 * clean LOD structure is visible).
 */
export interface QuadtreePatch {
  /** (x, z, skirt)×N, stride 3. */
  readonly vertices: Float32Array
  readonly triangleIndices: Uint16Array
  readonly edgeIndices: Uint16Array
  readonly segments: number
}

/** Vertex index in the grid −1..segments+1. */
function patchCellIndex(gx: number, gy: number, segments: number): number {
  return (gy + 1) * (segments + 3) + (gx + 1)
}

export function quadtreePatch(segments = PATCH_CELLS): QuadtreePatch {
  if (!Number.isInteger(segments) || segments < 1 || segments > 253) {
    throw new Error(`quadtreePatch: segments must be an integer 1..253, got ${segments}`)
  }
  const side = segments + 3 // the grid from −1 to segments+1 inclusive
  const verts = new Float32Array(side * side * 3)
  let v = 0
  for (let gy = -1; gy <= segments + 1; gy++) {
    for (let gx = -1; gx <= segments + 1; gx++) {
      const skirt = gx < 0 || gy < 0 || gx > segments || gy > segments ? 1 : 0
      verts[v++] = Math.max(0, Math.min(segments, gx))
      verts[v++] = Math.max(0, Math.min(segments, gy))
      verts[v++] = skirt
    }
  }

  // Triangles: the whole grid (side−1)² cells — interior + skirt walls; the
  // corner cells degenerate into zero area (harmless, but the indexing is
  // uniform).
  const tris = new Uint16Array((side - 1) * (side - 1) * 6)
  let t = 0
  for (let gy = -1; gy < segments + 1; gy++) {
    for (let gx = -1; gx < segments + 1; gx++) {
      const a = patchCellIndex(gx, gy, segments)
      const b = patchCellIndex(gx + 1, gy, segments)
      const c = patchCellIndex(gx, gy + 1, segments)
      const d = patchCellIndex(gx + 1, gy + 1, segments)
      tris[t++] = a
      tris[t++] = b
      tris[t++] = c
      tris[t++] = b
      tris[t++] = d
      tris[t++] = c
    }
  }

  // Wireframe: lines of the inner grid (segments+1)² (without the skirt).
  const wireCount = segments * (segments + 1) * 2
  const edges = new Uint16Array(wireCount * 2)
  let e = 0
  for (let y = 0; y <= segments; y++) {
    for (let x = 0; x < segments; x++) {
      edges[e++] = patchCellIndex(x, y, segments)
      edges[e++] = patchCellIndex(x + 1, y, segments)
    }
  }
  for (let x = 0; x <= segments; x++) {
    for (let y = 0; y < segments; y++) {
      edges[e++] = patchCellIndex(x, y, segments)
      edges[e++] = patchCellIndex(x, y + 1, segments)
    }
  }

  return { vertices: verts, triangleIndices: tris, edgeIndices: edges, segments }
}

/** The leaf selection result. A fresh lightweight object per call
 *  (~100 bytes — no algorithmic allocation); instanceData is a SHARED
 *  pre-allocated buffer: its content is valid UNTIL THE NEXT
 *  selectQuadtreeLeaves call (upload it to the GPU in the same frame). Two
 *  results can be held simultaneously (the numbers are honest); the
 *  buffers are the same one. */
export interface QuadtreeLeavesSelection {
  /** Number of leaves = number of patch instances. */
  leafCount: number
  /** (originX, originZ, size, 0) × leafCount — instance buffer data. */
  instanceData: Float32Array
  /** Total triangles (with skirts). */
  triangles: number
  minLeafSize: number
  maxLeafSize: number
  /** LOD parameters of this pass (for the HUD). */
  lod: LodParams
}

export interface QuadtreeLeavesOptions {
  /** LOD aggressiveness 1..3 (default 2 — "aggressive by default"). */
  readonly aggressiveness?: number
  /** Root tile size of the world fixed grid, m (default 4096). */
  readonly rootSize?: number
  /** Coverage radius from the camera, m (default 10000). */
  readonly horizon?: number
  /** Leaf cap = the instance buffer capacity (default 2048). */
  readonly maxInstances?: number
  /** Horizontal view direction (no need to normalize):
   *  leaves outside the "65° + leaf angular radius" sector are culled.
   *  Zero/NaN — culling disabled (looking straight down). */
  readonly forward?: { readonly x: number; readonly z: number }
}

// Pre-allocated module state: traversal stack + instances + result.
// Stack: (originX, originZ, depth); DFS ⇒ depth ≤ 3·maxDepth+4 (with a
// margin).
const LEAF_STACK_CAP = 320
const leafStack = new Float64Array(LEAF_STACK_CAP * 3)
let leafInstances = new Float32Array(MAX_INSTANCES * 4)
let leafCapacity = MAX_INSTANCES

/**
 * The set of quadtree leaves for the current frame — the OCEAN SYSTEM
 * (validated by the FFT ocean demo, Task 113):
 *  - roots are rootSize tiles of the world FIXED GRID (vertices do not
 *    "drift" as the camera moves — only the set of leaves changes);
 *  - subdivision: 3D distance to the node's nearest point (with camera
 *    height) < size·K and depth < maxDepth (a hard near-field detail
 *    limit);
 *  - culling by view direction (a 65° sector + the leaf's angular radius);
 *  - ZERO allocations per frame (the stack, instances and result are
 *    pre-allocated).
 */
export function selectQuadtreeLeaves(
  camX: number,
  camZ: number,
  camY: number,
  options: QuadtreeLeavesOptions = {},
): QuadtreeLeavesSelection {
  const rootSize = options.rootSize ?? ROOT_SIZE
  const horizon = options.horizon ?? HORIZON_DISTANCE
  const maxInstances = Math.max(16, options.maxInstances ?? MAX_INSTANCES)
  if (maxInstances > leafCapacity) {
    // Lazy capacity growth ONCE (a typical frame — no allocations).
    leafInstances = new Float32Array(maxInstances * 4)
    leafCapacity = maxInstances
  }
  const lod = lodParams(options.aggressiveness ?? 2)
  const maxDepth = Math.min(24, Math.max(1, Math.round(Math.log2(rootSize / lod.minLeafSize))))
  const needBase = lod.K
  const fwdX = options.forward?.x ?? 0
  const fwdZ = options.forward?.z ?? 0
  const hasForward =
    Number.isFinite(fwdX) && Number.isFinite(fwdZ) && fwdX * fwdX + fwdZ * fwdZ > 1e-6

  let leafCount = 0
  let minLeaf = Infinity
  let maxLeaf = 0

  const r0 = Math.floor((camX - horizon) / rootSize)
  const r1 = Math.floor((camX + horizon) / rootSize)
  const z0 = Math.floor((camZ - horizon) / rootSize)
  const z1 = Math.floor((camZ + horizon) / rootSize)
  const h2 = horizon * horizon

  for (let rz = z0; rz <= z1; rz++) {
    for (let rx = r0; rx <= r1; rx++) {
      const ox = rx * rootSize
      const oz = rz * rootSize
      // XZ distance to the root's nearest point (a quick reject).
      const dxr = Math.max(Math.abs(camX - (ox + rootSize / 2)) - rootSize / 2, 0)
      const dzr = Math.max(Math.abs(camZ - (oz + rootSize / 2)) - rootSize / 2, 0)
      if (dxr * dxr + dzr * dzr > h2) continue

      // DFS over the root's subtree (an explicit stack — no recursion or
      // allocations).
      let sp = 0
      leafStack[sp * 3] = ox
      leafStack[sp * 3 + 1] = oz
      leafStack[sp * 3 + 2] = 0
      sp++
      while (sp > 0) {
        sp--
        const x = leafStack[sp * 3]
        const z = leafStack[sp * 3 + 1]
        const depth = leafStack[sp * 3 + 2]
        const size = rootSize / (1 << depth)
        const half = size / 2

        // 3D distance to the square's nearest point (with camera height).
        const dx = Math.max(Math.abs(camX - (x + half)) - half, 0)
        const dz = Math.max(Math.abs(camZ - (z + half)) - half, 0)
        const distSq = dx * dx + dz * dz + camY * camY
        const need = size * needBase

        if (hasForward && distSq > camY * camY) {
          // Culling by view direction: the angle from forward to the leaf
          // center minus the leaf's angular radius must fit into the view
          // sector.
          const cx = x + half - camX
          const cz = z + half - camZ
          const len = Math.sqrt(cx * cx + cz * cz)
          const angular = Math.atan2(half * Math.SQRT2, len)
          const cosKeep = Math.cos(((60 + 5) * Math.PI) / 180 + angular)
          if ((cx * fwdX + cz * fwdZ) / (len || 1) < cosKeep) continue
        }

        if (depth < maxDepth && leafCount < maxInstances - 4 && distSq < need * need) {
          const q = size / 2
          leafStack[sp * 3] = x
          leafStack[sp * 3 + 1] = z
          leafStack[sp * 3 + 2] = depth + 1
          leafStack[(sp + 1) * 3] = x + q
          leafStack[(sp + 1) * 3 + 1] = z
          leafStack[(sp + 1) * 3 + 2] = depth + 1
          leafStack[(sp + 2) * 3] = x
          leafStack[(sp + 2) * 3 + 1] = z + q
          leafStack[(sp + 2) * 3 + 2] = depth + 1
          leafStack[(sp + 3) * 3] = x + q
          leafStack[(sp + 3) * 3 + 1] = z + q
          leafStack[(sp + 3) * 3 + 2] = depth + 1
          sp += 4
        } else {
          if (leafCount >= maxInstances) {
            // A HARD cap (Task 115 lesson: emission without a cap
            // overflowed the contract with small maxInstances — the DFS
            // tail silently wrote out of bounds).
            break
          }
          const o = leafCount * 4
          leafInstances[o] = x
          leafInstances[o + 1] = z
          leafInstances[o + 2] = size
          leafInstances[o + 3] = 0
          leafCount++
          if (size < minLeaf) minLeaf = size
          if (size > maxLeaf) maxLeaf = size
        }
      }
      if (leafCount >= maxInstances) break
    }
  }

  // ⚠️ A fresh result object: holding TWO selections simultaneously is
  // legal (Task 115 lesson: a singleton aliased the selections,
  // tests/comparisons silently lied).
  // The instance buffer is shared (zero large allocations per frame).
  return {
    leafCount,
    instanceData: leafInstances,
    triangles: leafCount * PATCH_TRIANGLE_COUNT,
    minLeafSize: leafCount === 0 ? 0 : minLeaf,
    maxLeafSize: leafCount === 0 ? 0 : maxLeaf,
    lod,
  }
}

/**
 * Skirt depth, m: covers the relief height difference at an LOD seam.
 * The formula is validated by the ocean (the displacement amplitude grows
 * with the leaf's "resolution" relative to the height map period).
 */
export function skirtDepthFor(leafSize: number, periodSize: number): number {
  return Math.max(8, Math.min(300, (periodSize / leafSize) * 12))
}

// Horizontal forward from the view matrix (column-major): the view
// direction = −the third row of the rotational part. Returns a SINGLETON —
// no allocations; a zero vector (looking straight down) disables culling.
const forwardScratch = { x: 0, z: 0 }
export function viewForwardXZ(view: Float32Array): { x: number; z: number } {
  const x = -view[2]
  const z = -view[10]
  const len = Math.sqrt(x * x + z * z)
  if (!(len > 1e-6) || !Number.isFinite(len)) {
    forwardScratch.x = 0
    forwardScratch.z = 0
    return forwardScratch
  }
  forwardScratch.x = x / len
  forwardScratch.z = z / len
  return forwardScratch
}
