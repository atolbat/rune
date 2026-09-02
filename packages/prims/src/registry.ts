/**
 * Primitive registry (Task 109): the single @rune/prims catalog — parameter
 * metadata (the UI builds the sliders ITSELF from this table) + a generator
 * from values and a detail multiplier. A single source of truth for demos
 * and tests: invariants (winding/normals/counts) are run ACROSS THE CATALOG.
 *
 * Parameters come in kinds:
 *   • numeric — a min..max..step slider;
 *   • segment (integer) — tessellation: multiplied by the detail k
 *     (×0.5 Economy … ×4 Ultra) clamped into [min, max];
 *   • bool — a toggle (openEnded on the cylinder/cone).
 */

import type { Geometry } from './types.ts'
import { box } from './cube.ts'
import { plane } from './plane.ts'
import { sphere } from './sphere.ts'
import { cylinder, cone } from './cylinder.ts'
import { capsule } from './capsule.ts'
import { torus, torusKnot } from './torus.ts'
import { disk, ring } from './disk.ts'
import { tetrahedron, octahedron, icosahedron, dodecahedron } from './platonic.ts'
import { terrain, terrainPresets } from './terrain.ts'
import { createAdaptiveTerrain, adaptivePresets } from './adaptive.ts'
import type { AdaptiveTerrainParams, WorldHeightFn } from './adaptive.ts'
import type { TerrainHeightFn } from './terrain.ts'

export interface ParamMeta {
  readonly key: string
  readonly label: string
  readonly min: number
  readonly max: number
  readonly step: number
  readonly def: number
  /** A segment parameter: integer + multiplied by the detail k. */
  readonly segment?: boolean
  /** Integer (without the detail multiplier). */
  readonly integer?: boolean
  /** A boolean toggle (min/max/step are unused). */
  readonly bool?: boolean
}

export interface ShapeMeta {
  readonly id: string
  readonly label: string
  readonly group: string
  readonly note: string
  /** Model offset along Y (the camera looks here). */
  readonly offsetY?: number
  /** Default camera distance. */
  readonly dist?: number
  readonly params: readonly ParamMeta[]
  /** Geometry from parameter values and the detail multiplier k. */
  readonly make: (values: Record<string, number>, k: number) => Geometry
  /** For adaptive shapes: the live feed config (demo). */
  readonly adaptive?: (values: Record<string, number>) => AdaptiveTerrainParams
}

/** The segment parameter value accounting for detail: base·k, clamped. */
export function segmentValue(base: number, k: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(base * k)))
}

const TERRAIN_SIZE = 2.4

function terrainEntry(
  id: string, presetKey: string, note: string,
): ShapeMeta {
  const preset = terrainPresets[presetKey]!
  return {
    id, label: preset.label, group: 'Terrains', note, offsetY: -0.25, dist: 3.4,
    params: [
      { key: 'seed', label: 'Relief seed', min: 1, max: 999, step: 1, def: 7, integer: true },
      { key: 'amp', label: 'Amplitude', min: 0.4, max: 2.5, step: 0.1, def: preset.amplitude },
      { key: 'segs', label: 'Segments', min: 16, max: 256, step: 8, def: 96, segment: true },
    ],
    make: (v, _k) => terrain(
      TERRAIN_SIZE,
      v.segs ?? 96,
      preset.height(v.seed ?? 7) as TerrainHeightFn,
      { amplitude: v.amp ?? preset.amplitude },
    ),
  }
}

function adaptiveEntry(
  id: string, presetKey: string, note: string,
): ShapeMeta {
  const preset = adaptivePresets[presetKey]!
  return {
    id, label: preset.label, group: 'Adaptive relief', note, offsetY: -0.2, dist: 7.5,
    params: [
      { key: 'seed', label: 'Relief seed', min: 1, max: 999, step: 1, def: 7, integer: true },
      { key: 'amp', label: 'Amplitude', min: 0.3, max: 2.5, step: 0.1, def: preset.amplitude },
      { key: 'radius', label: 'Build radius', min: 8, max: 48, step: 4, def: 20, integer: true },
      { key: 'tile', label: 'Tile size', min: 2, max: 8, step: 1, def: 4, integer: true },
      { key: 'maxSeg', label: 'Max segments', min: 8, max: 64, step: 8, def: 24, segment: true },
      { key: 'skirt', label: 'Skirts at seams', min: 0, max: 1, step: 1, def: 1, bool: true },
    ],
    make: (v, k) => {
      void k
      return createAdaptiveTerrain({
        heightFn: preset.height(v.seed ?? 7),
        amplitude: v.amp ?? preset.amplitude,
        radius: v.radius ?? 20,
        tileSize: v.tile ?? 4,
        maxSegments: v.maxSeg ?? 24,
        skirtDepth: (v.skirt ?? 1) > 0.5 ? 0.4 : 0,
      }).geometry
    },
    adaptive: v => ({
      heightFn: preset.height(v.seed ?? 7) as WorldHeightFn,
      amplitude: v.amp ?? preset.amplitude,
      radius: v.radius ?? 20,
      tileSize: v.tile ?? 4,
      maxSegments: v.maxSeg ?? 24,
      skirtDepth: (v.skirt ?? 1) > 0.5 ? 0.4 : 0,
    }),
  }
}

/** The primitive catalog (before the detail wrapper). */
const RAW_SHAPES: readonly ShapeMeta[] = [
  {
    id: 'box', label: 'Box', group: 'Basic',
    note: 'width×height×depth, SEGMENTS PER FACE (like three.js BoxGeometry)',
    params: [
      { key: 'width', label: 'Width X', min: 0.4, max: 2.5, step: 0.05, def: 1.4 },
      { key: 'height', label: 'Height Y', min: 0.4, max: 2.5, step: 0.05, def: 1.4 },
      { key: 'depth', label: 'Depth Z', min: 0.4, max: 2.5, step: 0.05, def: 1.4 },
      { key: 'segX', label: 'Segments X', min: 1, max: 24, step: 1, def: 6, segment: true },
      { key: 'segY', label: 'Segments Y', min: 1, max: 24, step: 1, def: 6, segment: true },
      { key: 'segZ', label: 'Segments Z', min: 1, max: 24, step: 1, def: 6, segment: true },
    ],
    make: v => box({
      width: v.width, height: v.height, depth: v.depth,
      widthSegments: v.segX, heightSegments: v.segY, depthSegments: v.segZ,
    }),
  },
  {
    id: 'plane', label: 'Plane', group: 'Basic',
    note: 'A width×height rectangle with INDEPENDENT segments per axis, +Y normal',
    params: [
      { key: 'width', label: 'Width X', min: 0.5, max: 4, step: 0.1, def: 2.2 },
      { key: 'height', label: 'Depth Z', min: 0.5, max: 4, step: 0.1, def: 1.6 },
      { key: 'segX', label: 'Segments X', min: 1, max: 96, step: 1, def: 24, segment: true },
      { key: 'segY', label: 'Segments Z', min: 1, max: 96, step: 1, def: 16, segment: true },
    ],
    make: v => plane({
      width: v.width, height: v.height,
      widthSegments: v.segX, heightSegments: v.segY,
    }),
  },
  {
    id: 'sphere', label: 'Sphere', group: 'Basic',
    note: 'UV sphere: widthSegments × heightSegments (like SphereGeometry), poles without holes',
    params: [
      { key: 'radius', label: 'Radius', min: 0.5, max: 2, step: 0.05, def: 1 },
      { key: 'segW', label: 'Segments (longitude)', min: 8, max: 256, step: 4, def: 48, segment: true },
      { key: 'segH', label: 'Bands (latitude)', min: 4, max: 128, step: 2, def: 32, segment: true },
    ],
    make: v => sphere({
      radius: v.radius,
      widthSegments: v.segW,
      heightSegments: v.segH,
    }),
  },
  {
    id: 'cylinder', label: 'Cylinder', group: 'Basic',
    note: 'A truncated cone with caps; rTop=0 — a cone; openEnded — without caps',
    params: [
      { key: 'rTop', label: 'Top radius', min: 0, max: 1.2, step: 0.05, def: 0.7 },
      { key: 'rBot', label: 'Bottom radius', min: 0.3, max: 1.2, step: 0.05, def: 0.9 },
      { key: 'height', label: 'Height', min: 0.6, max: 2.6, step: 0.1, def: 1.8 },
      { key: 'segR', label: 'Segments (around)', min: 3, max: 256, step: 1, def: 48, segment: true },
      { key: 'segH', label: 'Bands (height)', min: 1, max: 32, step: 1, def: 1, segment: true },
      { key: 'open', label: 'No caps (openEnded)', min: 0, max: 1, step: 1, def: 0, bool: true },
    ],
    make: v => cylinder({
      radiusTop: v.rTop, radiusBottom: v.rBot, height: v.height,
      radialSegments: v.segR, heightSegments: v.segH,
      openEnded: (v.open ?? 0) > 0.5,
    }),
  },
  {
    id: 'cone', label: 'Cone', group: 'Basic',
    note: 'An apex without degenerate triangles; openEnded — without the base',
    params: [
      { key: 'radius', label: 'Radius', min: 0.4, max: 1.2, step: 0.05, def: 0.9 },
      { key: 'height', label: 'Height', min: 0.8, max: 2.6, step: 0.1, def: 1.8 },
      { key: 'segR', label: 'Segments (around)', min: 3, max: 256, step: 1, def: 48, segment: true },
      { key: 'segH', label: 'Bands (height)', min: 1, max: 32, step: 1, def: 1, segment: true },
      { key: 'open', label: 'Without the base', min: 0, max: 1, step: 1, def: 0, bool: true },
    ],
    make: v => cone({
      radius: v.radius, height: v.height,
      radialSegments: v.segR, heightSegments: v.segH,
      openEnded: (v.open ?? 0) > 0.5,
    }),
  },
  {
    id: 'capsule', label: 'Capsule', group: 'Basic',
    note: 'Cylinder + hemispheres (height — the cylindrical part, as in three.js)',
    params: [
      { key: 'radius', label: 'Radius', min: 0.25, max: 0.9, step: 0.05, def: 0.55 },
      { key: 'height', label: 'Body length', min: 0.4, max: 1.8, step: 0.05, def: 1.1 },
      { key: 'segR', label: 'Segments (around)', min: 3, max: 128, step: 1, def: 40, segment: true },
      { key: 'segH', label: 'Bands per hemisphere', min: 2, max: 64, step: 1, def: 12, segment: true },
    ],
    make: v => capsule({
      radius: v.radius, height: v.height,
      radialSegments: v.segR, capSegments: v.segH,
    }),
  },
  {
    id: 'torus', label: 'Torus', group: 'Curves',
    note: 'A tube of tube around a radius ring; radial — around the tube, tubular — around the axis',
    params: [
      { key: 'radius', label: 'Ring radius', min: 0.6, max: 1.5, step: 0.05, def: 1 },
      { key: 'tube', label: 'Tube radius', min: 0.12, max: 0.6, step: 0.02, def: 0.38 },
      { key: 'segR', label: 'Tube segments', min: 3, max: 96, step: 1, def: 28, segment: true },
      { key: 'segT', label: 'Ring segments', min: 8, max: 256, step: 4, def: 64, segment: true },
    ],
    make: v => torus({
      radius: v.radius, tube: v.tube,
      radialSegments: v.segR, tubularSegments: v.segT,
    }),
  },
  {
    id: 'knot', label: 'Knot (p,q)', group: 'Curves',
    note: 'A torus knot: p windings × q loops; change p/q — the knot reconfigures',
    dist: 4.6,
    params: [
      { key: 'p', label: 'p (windings)', min: 1, max: 5, step: 1, def: 2, integer: true },
      { key: 'q', label: 'q (loops)', min: 2, max: 7, step: 1, def: 3, integer: true },
      { key: 'tube', label: 'Tube radius', min: 0.08, max: 0.4, step: 0.02, def: 0.26 },
      { key: 'scale', label: 'Scale', min: 0.25, max: 0.8, step: 0.05, def: 0.45 },
      { key: 'segT', label: 'Curve segments', min: 16, max: 640, step: 8, def: 220, segment: true },
      { key: 'segR', label: 'Tube segments', min: 3, max: 32, step: 1, def: 14, segment: true },
    ],
    make: v => torusKnot({
      p: Math.round(v.p ?? 2), q: Math.round(v.q ?? 3),
      tube: v.tube, scale: v.scale,
      tubularSegments: v.segT, radialSegments: v.segR,
    }),
  },
  {
    id: 'tetra', label: 'Tetrahedron', group: 'Platonic',
    note: '4 faces, flat shading; detail — subdivision with projection onto the sphere',
    params: [
      { key: 'radius', label: 'Radius', min: 0.6, max: 1.6, step: 0.05, def: 1.1 },
      { key: 'detail', label: 'Detail (subdivision)', min: 0, max: 4, step: 1, def: 0, integer: true },
    ],
    make: v => tetrahedron({ radius: v.radius, detail: v.detail }),
  },
  {
    id: 'octa', label: 'Octahedron', group: 'Platonic',
    note: '8 faces; detail ≥ 1 — a geodesic sphere from the octahedron',
    params: [
      { key: 'radius', label: 'Radius', min: 0.6, max: 1.6, step: 0.05, def: 1.1 },
      { key: 'detail', label: 'Detail (subdivision)', min: 0, max: 4, step: 1, def: 0, integer: true },
    ],
    make: v => octahedron({ radius: v.radius, detail: v.detail }),
  },
  {
    id: 'icosa', label: 'Icosahedron', group: 'Platonic',
    note: '20 faces; detail 1/2/3 — geodesic spheres with 80/320/1280 faces',
    params: [
      { key: 'radius', label: 'Radius', min: 0.6, max: 1.6, step: 0.05, def: 1.1 },
      { key: 'detail', label: 'Detail (subdivision)', min: 0, max: 4, step: 1, def: 0, integer: true },
    ],
    make: v => icosahedron({ radius: v.radius, detail: v.detail }),
  },
  {
    id: 'dodeca', label: 'Dodecahedron', group: 'Platonic',
    note: '12 pentagonal faces (dual to the icosahedron); detail — a sphere-dodeca',
    params: [
      { key: 'radius', label: 'Radius', min: 0.6, max: 1.6, step: 0.05, def: 1.1 },
      { key: 'detail', label: 'Detail (subdivision)', min: 0, max: 3, step: 1, def: 0, integer: true },
    ],
    make: v => dodecahedron({ radius: v.radius, detail: v.detail }),
  },
  {
    id: 'disk', label: 'Disk', group: 'Other',
    note: 'A circle in the XZ plane, +Y normal (CircleGeometry)',
    params: [
      { key: 'radius', label: 'Radius', min: 0.5, max: 1.6, step: 0.05, def: 1.1 },
      { key: 'segs', label: 'Segments', min: 3, max: 256, step: 1, def: 64, segment: true },
    ],
    make: v => disk({ radius: v.radius, segments: v.segs }),
  },
  {
    id: 'ring', label: 'Ring', group: 'Other',
    note: 'Annulus — a flat washer (RingGeometry)',
    params: [
      { key: 'inner', label: 'Inner R', min: 0.2, max: 0.9, step: 0.05, def: 0.55 },
      { key: 'outer', label: 'Outer R', min: 0.8, max: 1.6, step: 0.05, def: 1.1 },
      { key: 'segs', label: 'Segments', min: 3, max: 256, step: 1, def: 64, segment: true },
    ],
    make: v => ring({ innerRadius: v.inner, outerRadius: v.outer, segments: v.segs }),
  },
  terrainEntry('t-hills', 'hills', 'A single plane with a heightmap (fBm): the base of the adaptive relief'),
  terrainEntry('t-ridged', 'ridged', 'Ridged multifractal: sharp ridges'),
  terrainEntry('t-island', 'island', 'Hills × radial falloff: beach → mountains'),
  terrainEntry('t-dunes', 'dunes', 'Anisotropic |sin| ridges, wind-blown sands'),
  terrainEntry('t-canyon', 'canyon', 'Step terraces: table plateaus'),
  terrainEntry('t-volcano', 'volcano', 'A cone with a crater + a noisy rim'),
  adaptiveEntry('a-hills', 'hills', 'LOD tiles around the camera: near ones detailed, far ones coarse; skirts at seams'),
  adaptiveEntry('a-ridged', 'ridged', 'Ridges in LOD rings — sharp ridges fade in the distance'),
  adaptiveEntry('a-island', 'island', 'An island in an ocean up to the fog: you can see the distance being muted by LOD'),
  adaptiveEntry('a-dunes', 'dunes', 'Dunes: tile seams keep their skirts under displacement'),
  adaptiveEntry('a-canyon', 'canyon', 'Canyon: flat plateaus read at any LOD level'),
]

/** The primitive catalog for UI and tests (after the detail wrapper). */
export const SHAPES: readonly ShapeMeta[] = RAW_SHAPES.map(withDetail)

/**
 * The DETAIL wrapper: segment parameters (segment: true) are multiplied
 * by k clamped into [min, max] BEFORE being passed to make — one mechanism
 * for the whole catalog (previously every make had to remember k — the
 * sphere ×2 silently ignored the multiplier, caught by the test "detail
 * changes the count").
 */
function withDetail(shape: ShapeMeta): ShapeMeta {
  const segParams = shape.params.filter(p => p.segment === true)
  if (segParams.length === 0) return shape
  const baseMake = shape.make
  return {
    ...shape,
    make: (values, k) => {
      if (k === 1) return baseMake(values, k)
      const scaled = { ...values }
      for (const p of segParams) {
        scaled[p.key] = segmentValue(values[p.key] ?? p.def, k, p.min, p.max)
      }
      return baseMake(scaled, 1)
    },
  }
}

// ─── Lookup and defaults ─────────────────────────────────────────────────────────

/** Find a shape by id (demo hook). */
export function shapeById(id: string): ShapeMeta | undefined {
  return SHAPES.find(s => s.id === id)
}

/** Default parameter values of a shape. */
export function defaultValues(shape: ShapeMeta): Record<string, number> {
  const values: Record<string, number> = {}
  for (const p of shape.params) values[p.key] = p.def
  return values
}
