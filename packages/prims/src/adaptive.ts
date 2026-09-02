/**
 * Adaptive tiled relief (Task 109): a plane stitched together from TILES
 * around the camera — near rings detailed, far rings coarse, a total build
 * radius up to a given one (fog hides the "conditional infinity").
 *
 * SMART STITCHING (user requirement: "vertices match and do not form cutoffs
 * hanging in the air at tile borders under displacement"):
 *   1. RESOLUTIONS are powers of two: adjacent tiles of the SAME level
 *      sample the height at IDENTICAL world points (the tile grid is
 *      snapped to the maxSegments grid) — shared edges match VERTEX FOR
 *      VERTEX, the seam is invisible even under displacement (heightFn is
 *      global).
 *   2. Normals are central differences of heightFn with the tile's world
 *      step: on a shared edge of equal-resolution tiles the formulas give
 *      IDENTICAL normals (the same point, the same step) — no lighting
 *      seam.
 *   3. DIFFERENT neighbor levels (T-junction): the coarse edge is a chord,
 *      the fine one samples more precisely → gaps. A SKIRT closes them —
 *      a wall going down from the tile's edge (the industry standard of
 *      Cesium/geo renderers): under displacement the wall follows the edge
 *      height, no "cutoffs in the air". Skirts can be turned off with a
 *      parameter — and you can SEE the difference.
 *
 * The GeometryFeed contract (feed.ts): update() returns true on a rebuild —
 * the demo re-pushes the command attributes (hot swap) and the dynamic
 * count. Rebuilds are quantized: no more often than camera movement by
 * tileSize/2 (rebuild shimmer during orbiting is excluded).
 */

import type { Geometry } from './types.ts'
import { fbm2D, ridged2D } from './noise.ts'

/** Height in WORLD coordinates (continuous over the whole plane). */
export type WorldHeightFn = (x: number, z: number) => number

export interface AdaptiveTerrainParams {
  /** Relief in world coordinates. */
  readonly heightFn: WorldHeightFn
  /** Height amplitude (default 1). */
  readonly amplitude?: number
  /** Tile size in world units (default 4). */
  readonly tileSize?: number
  /** Build radius from the camera (default 24; fog behind it — "infinity"). */
  readonly radius?: number
  /** Maximum tile resolution — cells per side, a power of two (default 32). */
  readonly maxSegments?: number
  /** Minimum resolution of far tiles (default 4). */
  readonly minSegments?: number
  /** Skirt depth in height units (default 0.4); 0 — no skirts. */
  readonly skirtDepth?: number
  /** LOD aggressiveness: level +1 per lodBias·tileSize of distance (default 2.6). */
  readonly lodBias?: number
}

export interface AdaptiveTerrain {
  readonly geometry: Geometry
  /** true = the geometry has been rebuilt (the camera moved > tileSize/2). */
  update(camX: number, camZ: number): boolean
  readonly rebuilds: number
  readonly tiles: number
  readonly lastMs: number
  readonly center: { readonly x: number; readonly z: number }
  /** Level summary: how many tiles at each (diagnostics/logging). */
  readonly levelCounts: readonly number[]
}

interface TileDesc {
  /** Tile grid indices. */
  readonly ix: number
  readonly iz: number
  /** Cells per side (a power of two). */
  readonly res: number
}

/** Tile resolution by distance to the camera (a power of two, ≥ min). */
function tileResolution(dist: number, p: Required<Pick<AdaptiveTerrainParams, 'maxSegments' | 'minSegments' | 'lodBias' | 'tileSize'>>): number {
  const { maxSegments, minSegments, lodBias, tileSize } = p
  // level 0 while dist < lodBias·tileSize; beyond that — doubling the distance
  const rel = Math.max(dist, 1e-6) / (lodBias * tileSize)
  const level = Math.max(0, Math.ceil(Math.log2(rel)))
  const res = Math.max(minSegments, maxSegments >> level)
  return Math.min(res, maxSegments)
}

export function createAdaptiveTerrain(params: AdaptiveTerrainParams): AdaptiveTerrain {
  const amplitude = params.amplitude ?? 1
  const tileSize = Math.max(0.5, params.tileSize ?? 4)
  const radius = Math.max(tileSize, params.radius ?? 24)
  const maxSegments = clampPow2(params.maxSegments ?? 32)
  const minSegments = clampPow2(Math.min(params.minSegments ?? 4, maxSegments))
  const skirtDepth = params.skirtDepth ?? 0.4
  const lodBias = params.lodBias ?? 2.6
  const heightFn = params.heightFn
  // The palette (uv.y) — a FIXED range by amplitude: stable colors
  // between rebuilds (a local min/max would "breathe" as the camera moves)
  const hNorm = (h: number): number => {
    const t = (h / amplitude + 1) / 2 // h/amp ∈ [−1, 1] → [0, 1]
    return t < 0 ? 0 : t > 1 ? 1 : t
  }

  let geometry: Geometry
  let rebuilds = 1
  let tiles = 0
  let lastMs = 0
  let lastX = 0
  let lastZ = 0
  let levelCounts: number[] = []
  geometry = build(0, 0)
  tiles = countTiles()

  function clampPow2(v: number): number {
    const n = Math.max(2, Math.floor(v))
    let pow = 2
    while (pow < n) pow *= 2
    return pow
  }

  function tilesFor(camX: number, camZ: number): TileDesc[] {
    const span = Math.ceil(radius / tileSize)
    const cx = Math.round(camX / tileSize)
    const cz = Math.round(camZ / tileSize)
    const result: TileDesc[] = []
    for (let iz = cz - span; iz <= cz + span; iz++) {
      for (let ix = cx - span; ix <= cx + span; ix++) {
        const centerX = (ix + 0.5) * tileSize
        const centerZ = (iz + 0.5) * tileSize
        const dist = Math.hypot(centerX - camX, centerZ - camZ)
        if (dist > radius) continue
        result.push({ ix, iz, res: tileResolution(dist, { maxSegments, minSegments, lodBias, tileSize }) })
      }
    }
    return result
  }

  function countTiles(camX = 0, camZ = 0): number {
    return tilesFor(camX, camZ).length
  }

  function build(camX: number, camZ: number): Geometry {
    const t0 = performance.now()
    const tileList = tilesFor(camX, camZ)
    // Exact prealloc: grid + skirts (4 sides each)
    let quadCount = 0
    for (const tile of tileList) {
      quadCount += tile.res * tile.res + (skirtDepth > 0 ? 4 * tile.res : 0)
    }
    const positions = new Float32Array(quadCount * 6 * 3)
    const normals = new Float32Array(quadCount * 6 * 3)
    const uvs = new Float32Array(quadCount * 6 * 2)
    const cursor = { v: 0 }
    levelCounts = []
    // Task 110: normalized LOD level for uv.x (0 = max detail,
    // 1 = minSegments). The ocean shader colors tiles by LOD rings —
    // adaptivity is VISIBLE without a wireframe.
    const maxLevel = Math.max(1, Math.log2(maxSegments / minSegments))
    for (const tile of tileList) {
      const level = Math.round(Math.log2(maxSegments / tile.res))
      while (levelCounts.length <= level) levelCounts.push(0)
      levelCounts[level] = (levelCounts[level] ?? 0) + 1
      emitTile(tile, positions, normals, uvs, cursor, level / maxLevel)
    }
    lastMs = performance.now() - t0
    tiles = tileList.length
    lastX = camX
    lastZ = camZ
    return { positions, normals, uvs, vertexCount: cursor.v }
  }

  /** One tile: a height grid with an apron (±1 cell) → quads + skirts.
   *  Task 110: lodNorm — the tile's normalized level (uv.x; 0 = max detail)
   *  for LOD ring coloring in the shader (the relief palette — uv.y, untouched). */
  function emitTile(
    tile: TileDesc,
    positions: Float32Array,
    normals: Float32Array,
    uvs: Float32Array,
    cursor: { v: number },
    lodNorm: number,
  ): void {
    const res = tile.res
    const step = tileSize / res
    const x0 = tile.ix * tileSize
    const z0 = tile.iz * tileSize
    // Heights with an apron: (res+3)² — for central differences at the edges
    const dim = res + 3
    const heights = new Float32Array(dim * dim)
    for (let j = 0; j < dim; j++) {
      const wz = z0 + (j - 1) * step
      for (let i = 0; i < dim; i++) {
        const wx = x0 + (i - 1) * step
        heights[j * dim + i] = heightFn(wx, wz) * amplitude
      }
    }
    // The grid (inside the apron): indices [1..res+1]
    const at = (i: number, j: number): number => heights[(j + 1) * dim + (i + 1)]
    const emit = (i: number, j: number, yOverride?: number, nOverride?: readonly [number, number, number]): void => {
      const v = cursor.v
      const h = yOverride ?? at(i, j)
      positions[v * 3] = x0 + i * step
      positions[v * 3 + 1] = h
      positions[v * 3 + 2] = z0 + j * step
      if (nOverride !== undefined) {
        normals[v * 3] = nOverride[0]
        normals[v * 3 + 1] = nOverride[1]
        normals[v * 3 + 2] = nOverride[2]
      } else {
        // Central differences over the apron (at the tile's edge — also central:
        // the adjacent tile of the same resolution computes THE SAME normal)
        const dhdx = (at(i + 1, j) - at(i - 1, j)) / (2 * step)
        const dhdz = (at(i, j + 1) - at(i, j - 1)) / (2 * step)
        let nx = -dhdx
        const ny = 1
        let nz = -dhdz
        const len = Math.hypot(nx, ny, nz)
        nx /= len
        nz /= len
        normals[v * 3] = nx
        normals[v * 3 + 1] = ny / len
        normals[v * 3 + 2] = nz
      }
      uvs[v * 2] = lodNorm // Task 110: the tile's LOD level (0 = max detail)
      uvs[v * 2 + 1] = hNorm(h)
      cursor.v = v + 1
    }
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        // CCW from above (as in plane/terrain)
        emit(i, j)
        emit(i, j + 1)
        emit(i + 1, j + 1)
        emit(i, j)
        emit(i + 1, j + 1)
        emit(i + 1, j)
      }
    }
    if (skirtDepth <= 0) return
    // Skirts: a wall going down from each edge. The normal — horizontal OUTWARD
    // from the tile (cull:back hides the neighbor's counter-facing skirt). The
    // skirt is below the edge by skirtDepth·amplitude — under displacement it
    // follows the edge, the gap is closed.
    // Winding: quads (A_k, A_{k+1}, B_{k+1}) + (A_k, B_{k+1}, B_k) — outward
    // when the parameter advances to the RIGHT of an OUTSIDE viewer; sides
    // where the parameter goes left are traversed in reverse order (reverse)
    const drop = skirtDepth * amplitude
    const down = (i: number, j: number, n: readonly [number, number, number]): void => {
      emit(i, j, at(i, j) - drop, n)
    }
    /** A strip of res segments: A — the edge, B — the skirt; reverse — the outward normal. */
    const skirt = (
      count: number,
      edgeA: (k: number) => void,
      edgeB: (k: number) => void,
      reverse: boolean,
    ): void => {
      for (let k = 0; k < count; k++) {
        const k0 = reverse ? k + 1 : k
        const k1 = reverse ? k : k + 1
        edgeA(k0)
        edgeA(k1)
        edgeB(k1)
        edgeA(k0)
        edgeB(k1)
        edgeB(k0)
      }
    }
    // West (i=0, outward −X): viewed from outside, the parameter j goes left — reverse
    skirt(
      res,
      k => emit(0, k),
      k => down(0, k, [-1, 0, 0]),
      true,
    )
    // East (i=res, outward +X): j to the right — direct
    skirt(
      res,
      k => emit(res, k),
      k => down(res, k, [1, 0, 0]),
      false,
    )
    // North (j=0, outward −Z): i to the right — direct
    skirt(
      res,
      k => emit(k, 0),
      k => down(k, 0, [0, 0, -1]),
      false,
    )
    // South (j=res, outward +Z): i to the left — reverse
    skirt(
      res,
      k => emit(k, res),
      k => down(k, res, [0, 0, 1]),
      true,
    )
  }

  return {
    get geometry(): Geometry {
      return geometry
    },
    update(camX: number, camZ: number): boolean {
      // A quantized trigger: rebuild when moving ≥ tileSize/2
      // (exactly on the boundary — also time: "no more often", not "strictly
      // greater")
      if (Math.hypot(camX - lastX, camZ - lastZ) < tileSize / 2) return false
      geometry = build(camX, camZ)
      rebuilds++
      return true
    },
    get rebuilds(): number {
      return rebuilds
    },
    get tiles(): number {
      return tiles
    },
    get lastMs(): number {
      return lastMs
    },
    get center(): { readonly x: number; readonly z: number } {
      return { x: lastX, z: lastZ }
    },
    get levelCounts(): readonly number[] {
      return levelCounts
    },
  }
}

// ─── Relief presets in WORLD coordinates ───────────────────────────────────

/** Hills: soft fBm over world coordinates (frequency ~0.3/unit). */
export function worldHills(seed = 7): WorldHeightFn {
  return (x, z) => fbm2D(x * 0.3, z * 0.3, seed, 5) - 0.5
}

/** Ridges: sharp ridges of a ridged multifractal. */
export function worldRidged(seed = 11): WorldHeightFn {
  return (x, z) => (ridged2D(x * 0.22, z * 0.22, seed, 6, 1.4) - 0.45) * 1.2
}

/** Dunes: anisotropic |sin| ridges, warped by noise. */
export function worldDunes(seed = 5): WorldHeightFn {
  return (x, z) => {
    const warp = fbm2D(x * 0.2, z * 0.2, seed, 3) * 0.8
    const ridge = Math.abs(Math.sin((x * 0.55 + warp * 1.8 + z * 0.18) * Math.PI))
    const soft = fbm2D(x * 0.6, z * 0.6, seed + 91, 2) * 0.25
    return ridge * 0.7 + soft - 0.35
  }
}

/** Canyon: step terraces (table plateaus) over the world. */
export function worldCanyon(seed = 9): WorldHeightFn {
  return (x, z) => {
    const base = fbm2D(x * 0.18, z * 0.18, seed, 4)
    const steps = 6
    const q = Math.floor(base * steps) / steps
    const cliff = base - q
    const terrace = q + Math.pow(cliff * steps, 4) / steps
    return (terrace - 0.45) * 1.1
  }
}

/** Island: hills × radial falloff around (0, 0) — an ocean to the horizon. */
export function worldIsland(seed = 3): WorldHeightFn {
  return (x, z) => {
    const d = Math.hypot(x, z)
    const falloff = 1 - Math.min(1, Math.pow(d / 10, 2.2))
    const hills = fbm2D(x * 0.3, z * 0.3, seed, 5)
    return (hills * 1.2 - 0.25) * falloff - (1 - falloff) * 0.35
  }
}

export interface AdaptivePreset {
  readonly label: string
  readonly height: (seed?: number) => WorldHeightFn
  readonly amplitude: number
  readonly note: string
}

/** Named adaptive reliefs for the UI. */
export const adaptivePresets: Readonly<Record<string, AdaptivePreset>> = {
  hills: { label: 'Hills', height: worldHills, amplitude: 1, note: 'fBm over the world: LOD rings around the camera, skirts at seams' },
  ridged: { label: 'Ridges', height: worldRidged, amplitude: 1.1, note: 'ridged ridges: sharp peaks fade into coarse far rings' },
  island: { label: 'Island', height: worldIsland, amplitude: 1.3, note: 'radial falloff: an ocean up to the fog — you can see LOD muting the distance' },
  dunes: { label: 'Dunes', height: worldDunes, amplitude: 0.6, note: 'anisotropic ridges: skirts hold the seams under displace' },
  canyon: { label: 'Canyon', height: worldCanyon, amplitude: 1, note: 'step terraces: flat plateaus read at any LOD' },
}
