/**
 * Terrains: a height grid → triangle soup with smoothed normals.
 *
 * CONTRACTS:
 *   • height(x, z) — a height function in NORMALIZED coordinates x, z ∈
 *     [-1, 1] (scale-independent relief; the grid itself is size × size
 *     units);
 *   • normals are CENTRAL DIFFERENCES of the height function (step = one
 *     grid cell): more precise than face averaging, without "faceting"
 *     on smooth relief, C² shading for a C² function (quintic noise);
 *   • UV: u — along X, v — the NORMALIZED HEIGHT [0, 1] over the FIELD's
 *     actual min/max (two passes): the shader colors by height without
 *     knowing the amplitude (water/sand/grass/rocks/snow);
 *   • determinism: the same seed → byte-identical geometry.
 *
 * RELIEF PRESETS (see terrainPresets): hills (fBm), ridges (ridged),
 * island (radial falloff), dunes (anisotropic |sin| ridges), canyon
 * (terraces with cliffs), volcano (a cone with a crater).
 */

import type { Geometry } from './types.ts'
import { fbm2D, ridged2D } from './noise.ts'

/** Relief function: x, z ∈ [-1, 1] → height (arbitrary units). */
export type TerrainHeightFn = (x: number, z: number) => number

export interface TerrainOptions {
  /** Relief seed (passed through to the preset function; determinism). */
  readonly seed?: number
  /** Height amplitude, units (default 1). */
  readonly amplitude?: number
}

/**
 * A grid terrain of size × size, segments × segments cells ((segments+1)²
 * grid vertices). Height = height(x̂, ẑ)·amplitude, where x̂, ẑ ∈ [-1, 1].
 */
export function terrain(
  size: number,
  segments: number,
  height: TerrainHeightFn,
  options: TerrainOptions = {},
): Geometry {
  const amp = options.amplitude ?? 1
  const cells = Math.max(1, Math.floor(segments))
  const vertsPerSide = cells + 1
  const n = vertsPerSide * vertsPerSide
  const half = size / 2
  const step = size / cells
  // Pass 1: the height grid (needed in full — for neighbor-based normals and min/max)
  const heights = new Float32Array(n)
  for (let j = 0; j < vertsPerSide; j++) {
    for (let i = 0; i < vertsPerSide; i++) {
      const nx = (i / cells) * 2 - 1
      const nz = (j / cells) * 2 - 1
      heights[j * vertsPerSide + i] = height(nx, nz) * amp
    }
  }
  // min/max — FROM THE ARRAY (Float32 values): computing over doubles
  // before writing, we got hMin ≠ the stored height (0.3 double vs
  // 0.30000001 f32) — and the "normalized height" of a constant field was
  // 0.0119 instead of 0
  let hMin = Infinity
  let hMax = -Infinity
  for (let k = 0; k < n; k++) {
    const h = heights[k]!
    if (h < hMin) hMin = h
    if (h > hMax) hMax = h
  }
  const hSpan = Math.max(hMax - hMin, 1e-6)
  const at = (i: number, j: number): number =>
    heights[Math.min(Math.max(j, 0), cells) * vertsPerSide + Math.min(Math.max(i, 0), cells)]
  // The normal from height differences: central inside (step 2·cell),
  // one-sided at the borders (step cell): otherwise edge normals are twice
  // as "tilted" (field feedback of the "dark slope edge" kind)
  const normalAt = (i: number, j: number, out: Float32Array, o: number): void => {
    const dhdx = i === 0
      ? (at(1, j) - at(0, j)) / step
      : i === cells
        ? (at(cells, j) - at(cells - 1, j)) / step
        : (at(i + 1, j) - at(i - 1, j)) / (2 * step)
    const dhdz = j === 0
      ? (at(i, 1) - at(i, 0)) / step
      : j === cells
        ? (at(i, cells) - at(i, cells - 1)) / step
        : (at(i, j + 1) - at(i, j - 1)) / (2 * step)
    // Surface normal y = h(x, z): (-∂h/∂x, 1, -∂h/∂z), normalized
    const nx = -dhdx
    const ny = 1
    const nz = -dhdz
    const len = Math.hypot(nx, ny, nz)
    out[o] = nx / len
    out[o + 1] = ny / len
    out[o + 2] = nz / len
  }
  // Pass 2: cells → 2 triangles. CCW viewed from above: the winding
  // (i,j) → (i,j+1) → (i+1,j+1) gives cross(B−A, C−A) = (0, +step², 0) —
  // the face normal points UP (+Y). The first version went (i,j) → (i+1,j) → (i+1,j+1)
  // — cross = (0, −step², 0), the relief was visible from BELOW (culled
  // from above)
  const quads = cells * cells
  const positions = new Float32Array(quads * 6 * 3)
  const normals = new Float32Array(quads * 6 * 3)
  const uvs = new Float32Array(quads * 6 * 2)
  let v = 0
  const emit = (i: number, j: number): void => {
    const x = -half + i * step
    const z = -half + j * step
    const h = at(i, j)
    positions[v * 3] = x
    positions[v * 3 + 1] = h
    positions[v * 3 + 2] = z
    normalAt(i, j, normals, v * 3)
    uvs[v * 2] = i / cells
    uvs[v * 2 + 1] = (h - hMin) / hSpan
    v++
  }
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      emit(i, j)
      emit(i, j + 1)
      emit(i + 1, j + 1)
      emit(i, j)
      emit(i + 1, j + 1)
      emit(i + 1, j)
    }
  }
  return { positions, normals, uvs, vertexCount: v }
}

// ─── Relief presets ─────────────────────────────────────────────────────────────

/** Hills: soft fBm — the basic "barrow" landscape. */
export function heightHills(seed = 7): TerrainHeightFn {
  return (x, z) => fbm2D(x * 3, z * 3, seed, 5) - 0.5
}

/** Ridges: a ridged multifractal — sharp mountain ranges (Mashuk style). */
export function heightRidged(seed = 11): TerrainHeightFn {
  return (x, z) => {
    const r = ridged2D(x * 2.2, z * 2.2, seed, 6, 1.4)
    return (r - 0.45) * 1.6
  }
}

/** Island: hills × radial falloff (a beach at the edge, mountains in the center). */
export function heightIsland(seed = 3): TerrainHeightFn {
  return (x, z) => {
    const d = Math.hypot(x, z)
    const falloff = 1 - Math.min(1, Math.pow(d, 2.2)) // flat shores, a sharper center
    const hills = fbm2D(x * 2.5, z * 2.5, seed, 5)
    return (hills * 1.2 - 0.25) * falloff - (1 - falloff) * 0.15 // the ocean slightly lower
  }
}

/** Dunes: anisotropic |sin| ridges, warped by noise (wind-blown sands). */
export function heightDunes(seed = 5): TerrainHeightFn {
  return (x, z) => {
    const warp = fbm2D(x * 2, z * 2, seed, 3) * 0.8
    const ridge = Math.abs(Math.sin((x * 4 + warp * 2.5 + z * 0.6) * Math.PI))
    const soft = fbm2D(x * 5, z * 5, seed + 91, 2) * 0.25
    return (ridge * 0.9 + soft - 0.45)
  }
}

/** Canyon: fBm step terraces (height quantization) — table plateaus. */
export function heightCanyon(seed = 9): TerrainHeightFn {
  return (x, z) => {
    const base = fbm2D(x * 2, z * 2, seed, 4)
    const steps = 6
    const q = Math.floor(base * steps) / steps
    const cliff = base - q // fraction inside a step
    // The step is flat, the cliff is sharp: near the end of a step — a rapid rise
    const terrace = q + Math.pow(cliff * steps, 4) / steps
    return (terrace - 0.45) * 1.3
  }
}

/** Volcano: a cone with a crater (radial profile + noise relief of the rim). */
export function heightVolcano(seed = 13): TerrainHeightFn {
  return (x, z) => {
    const d = Math.hypot(x, z)
    const rim = 0.55
    const rough = fbm2D(x * 4, z * 4, seed, 4) * 0.18
    // A cone from the foot to the rim, then a dip into the crater
    let profile: number
    if (d >= rim) {
      profile = Math.max(0, 1 - (d - rim) / (1 - rim)) // a slope down from the rim
    } else {
      profile = 1 - Math.pow(1 - d / rim, 1.6) * 0.8 // a bowl: the center below the rim
    }
    return profile * 0.9 + rough - 0.12
  }
}

export interface TerrainPreset {
  readonly label: string
  readonly height: (seed?: number) => TerrainHeightFn
  /** Recommended amplitude (reliefs of different scales). */
  readonly amplitude: number
  readonly note: string
}

/** Named reliefs for the UI (the demo's "terrains" selector). */
export const terrainPresets: Readonly<Record<string, TerrainPreset>> = {
  hills: { label: 'Hills', height: heightHills, amplitude: 1, note: 'fBm value noise: soft mounds, 5 octaves' },
  ridged: { label: 'Ridges', height: heightRidged, amplitude: 1, note: 'ridged multifractal: sharp ridges 1−|2n−1|' },
  island: { label: 'Island', height: heightIsland, amplitude: 1.4, note: 'hills × radial falloff: beach → mountains' },
  dunes: { label: 'Dunes', height: heightDunes, amplitude: 0.8, note: 'anisotropic |sin| ridges warped by noise' },
  canyon: { label: 'Canyon', height: heightCanyon, amplitude: 1.2, note: 'fBm step terraces: table plateaus' },
  volcano: { label: 'Volcano', height: heightVolcano, amplitude: 1.5, note: 'a cone with a crater + a noisy rim' },
}

// ─── Convenience wrappers (one line — ready geometry) ─────────────────────

export function terrainHills(size: number, segments: number, options: TerrainOptions = {}): Geometry {
  return terrain(size, segments, heightHills(options.seed), { ...options, amplitude: options.amplitude ?? 1 })
}
export function terrainRidged(size: number, segments: number, options: TerrainOptions = {}): Geometry {
  return terrain(size, segments, heightRidged(options.seed), { ...options, amplitude: options.amplitude ?? 1 })
}
export function terrainIsland(size: number, segments: number, options: TerrainOptions = {}): Geometry {
  return terrain(size, segments, heightIsland(options.seed), { ...options, amplitude: options.amplitude ?? 1.4 })
}
export function terrainDunes(size: number, segments: number, options: TerrainOptions = {}): Geometry {
  return terrain(size, segments, heightDunes(options.seed), { ...options, amplitude: options.amplitude ?? 0.8 })
}
export function terrainCanyon(size: number, segments: number, options: TerrainOptions = {}): Geometry {
  return terrain(size, segments, heightCanyon(options.seed), { ...options, amplitude: options.amplitude ?? 1.2 })
}
export function terrainVolcano(size: number, segments: number, options: TerrainOptions = {}): Geometry {
  return terrain(size, segments, heightVolcano(options.seed), { ...options, amplitude: options.amplitude ?? 1.5 })
}
