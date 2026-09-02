/**
 * terrainQuadtree.ts — a "to the horizon" terrain primitive on a quadtree
 * (Task 115).
 *
 * A system VALIDATED BY THE OCEAN (Task 113): a world fixed grid of roots
 * (vertices do not drift as the camera moves), subdivision by 3D distance
 * with a hard depth limit, skirts against T-cracks, an instanced patch
 * (one draw command), zero allocations per frame. Here it is wrapped into
 * a relief primitive: a CPU height function (camera/collisions) + presets.
 *
 * GPU displacement: the patch (x, z, skirt) is instanced by leaves; the
 * vertices sample the height map in the shader by WORLD position (like
 * the ocean — the FFT map). The skirt repeats the edge's (x,z) ⇒ a
 * bit-identical height ⇒ the seam is invisible.
 *
 * CONTRAST with adaptive.ts: that one — a CPU rebuild of buffers around
 * the camera (LOD rings, ~tens of thousands of vertices, a rebuild on
 * movement); this one — a static patch + instances (NO rebuild, only the
 * set of leaves changes).
 */

import { fbm2D, ridged2D } from './noise.ts'
import type { WorldHeightFn } from './adaptive.ts'
import {
  HORIZON_DISTANCE,
  MAX_INSTANCES,
  PATCH_CELLS,
  PATCH_TRIANGLE_COUNT,
  ROOT_SIZE,
  lodParams,
  quadtreePatch,
  selectQuadtreeLeaves,
  skirtDepthFor,
  viewForwardXZ,
} from './quadtree.ts'
import type { LodParams, QuadtreePatch, QuadtreeLeavesSelection } from './quadtree.ts'

export interface TerrainQuadtreeParams {
  /** Relief in WORLD coordinates (continuous over the whole plane).
   *  Not required when displacement is entirely on the GPU (a height map
   *  in the shader): then heightAt() returns NaN — use only select(). */
  readonly heightFn?: WorldHeightFn
  /** Height amplitude (for skirts and presets; default 30). */
  readonly amplitude?: number
  /** Root tile of the world fixed grid, m — a power of two (default 4096). */
  readonly rootSize?: number
  /** Coverage radius from the camera, m (default 10000 — "to the horizon"). */
  readonly horizon?: number
  /** LOD aggressiveness 1..3 (default 2 — "aggressive by default":
   *  larger ⇒ bigger leaves ⇒ fewer triangles). */
  readonly aggressiveness?: number
  /** Leaf cap — the instance buffer capacity (default 2048). */
  readonly maxInstances?: number
  /** Patch cells per side (default 32; (N+3)² vertices with a skirt). */
  readonly segments?: number
  /** Skirt depth: a number or a function of the leaf size, m.
   *  Default — the ocean formula: clamp(12·period/leaf, 8, 300), where
   *  period = the height map period (for a seamless CPU relief pass
   *  amplitude·2). */
  readonly skirtDepth?: number | ((leafSize: number) => number)
}

export interface TerrainQuadtree {
  /** Leaves per frame (a SINGLETON — zero allocations; instanceData
   *  stride 4: originX, originZ, size, —). */
  select(camX: number, camY: number, camZ: number, forwardX?: number, forwardZ?: number): QuadtreeLeavesSelection
  /** Leaves by view matrix (column-major) — forward is extracted automatically. */
  selectView(camX: number, camY: number, camZ: number, view: Float32Array): QuadtreeLeavesSelection
  /** CPU relief height (camera/collisions); NaN if heightFn is not set. */
  heightAt(x: number, z: number): number
  /** Skirt depth for a leaf, m. */
  skirtDepthFor(leafSize: number): number
  /** A static patch grid with a skirt (upload to the vertex buffer ONCE). */
  readonly patch: QuadtreePatch
  readonly lod: LodParams
  /** Triangles per leaf (the patch with a skirt). */
  readonly trianglesPerLeaf: number
  readonly rootSize: number
  readonly horizon: number
}

export function createTerrainQuadtree(params: TerrainQuadtreeParams = {}): TerrainQuadtree {
  const rootSize = params.rootSize ?? ROOT_SIZE
  if (!Number.isFinite(rootSize) || rootSize <= 0) {
    throw new Error(`terrainQuadtree: rootSize must be > 0, got ${rootSize}`)
  }
  const amplitude = params.amplitude ?? 30
  const heightFn = params.heightFn
  const segments = params.segments ?? PATCH_CELLS
  const patch = quadtreePatch(segments)
  const lod = lodParams(params.aggressiveness ?? 2)
  const skirt =
    params.skirtDepth ??
    ((leafSize: number) => skirtDepthFor(leafSize, Math.max(rootSize / 16, amplitude * 16)))

  const opts = {
    aggressiveness: params.aggressiveness ?? 2,
    rootSize,
    horizon: params.horizon ?? HORIZON_DISTANCE,
    maxInstances: params.maxInstances ?? MAX_INSTANCES,
  }

  return {
    select(camX: number, camY: number, camZ: number, forwardX = 0, forwardZ = 0): QuadtreeLeavesSelection {
      const fwd = { x: forwardX, z: forwardZ }
      return selectQuadtreeLeaves(camX, camZ, camY, { ...opts, forward: fwd })
    },
    selectView(camX: number, camY: number, camZ: number, view: Float32Array): QuadtreeLeavesSelection {
      const f = viewForwardXZ(view)
      return selectQuadtreeLeaves(camX, camZ, camY, { ...opts, forward: f })
    },
    heightAt(x: number, z: number): number {
      return heightFn !== undefined ? heightFn(x, z) : Number.NaN
    },
    skirtDepthFor(leafSize: number): number {
      return typeof skirt === 'number' ? skirt : skirt(leafSize)
    },
    patch,
    lod,
    trianglesPerLeaf: PATCH_TRIANGLE_COUNT,
    rootSize,
    horizon: opts.horizon,
  }
}

// ─── Relief presets (world coordinates, continuous) ─────────────────────

export interface TerrainQuadtreePreset {
  readonly id: string
  readonly label: string
  readonly note: string
  readonly heightFn: WorldHeightFn
  readonly amplitude: number
}

/** Hills: soft fBm. */
export function terrainHills(seed = 7): WorldHeightFn {
  return (x, z) => fbm2D(x / 900, z / 900, seed, 5) * 34
}

/** Ridges: sharp-peaked ridged fBm. */
export function terrainRidges(seed = 11): WorldHeightFn {
  return (x, z) => ridged2D(x / 1100, z / 1100, seed, 5) * 90
}

/** Dunes: anisotropic |sin| ridges + light noise. */
export function terrainDunes(seed = 5): WorldHeightFn {
  return (x, z) => (Math.abs(Math.sin(x / 260 + fbm2D(x / 2000, z / 2000, seed, 2) * 2)) * 14 + fbm2D(x / 700, z / 700, seed + 1, 3) * 5)
}

/** Canyon: terraces with cliffs. */
export function terrainCanyon(seed = 9): WorldHeightFn {
  const terrace = (v: number): number => Math.round(v * 6) / 6
  return (x, z) => terrace(fbm2D(x / 1500, z / 1500, seed, 4)) * 120 + fbm2D(x / 300, z / 300, seed + 2, 3) * 6
}

export const terrainQuadtreePresets: readonly TerrainQuadtreePreset[] = [
  { id: 'hills', label: 'Hills', note: 'fBm 5 octaves, amplitude 34 m', heightFn: terrainHills(), amplitude: 34 },
  { id: 'ridges', label: 'Ridges', note: 'ridged fBm, amplitude 90 m', heightFn: terrainRidges(), amplitude: 90 },
  { id: 'dunes', label: 'Dunes', note: 'anisotropic ridges, amplitude 19 m', heightFn: terrainDunes(), amplitude: 19 },
  { id: 'canyon', label: 'Canyon', note: 'terraces with cliffs', heightFn: terrainCanyon(), amplitude: 126 },
]
