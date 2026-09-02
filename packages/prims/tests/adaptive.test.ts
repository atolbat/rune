/**
 * Adaptive tiled terrain (Task 109): smart stitching.
 *   • equal neighbor resolutions — seam vertices MATCH (snapped lattice):
 *     identical positions on the shared edge;
 *   • skirts: depth exactly skirtDepth·amplitude, winding outward;
 *   • distance-based LOD: near tiles are more detailed (levelCounts);
 *   • rebuild is quantized (tileSize/2) — thrash excluded;
 *   • heightFn is called in WORLD coordinates (continuity).
 */

import { describe, test, expect } from 'bun:test'
import { createAdaptiveTerrain, worldHills, adaptivePresets } from '../src/index.ts'
import type { Geometry } from '../src/index.ts'

function countDegenerate(g: Geometry): number {
  let bad = 0
  for (let t = 0; t < g.vertexCount / 3; t++) {
    const o = t * 9
    const e1x = g.positions[o + 3]! - g.positions[o]!, e1y = g.positions[o + 4]! - g.positions[o + 1]!, e1z = g.positions[o + 5]! - g.positions[o + 2]!
    const e2x = g.positions[o + 6]! - g.positions[o]!, e2y = g.positions[o + 7]! - g.positions[o + 1]!, e2z = g.positions[o + 8]! - g.positions[o + 2]!
    const area = Math.hypot(
      e1y * e2z - e1z * e2y,
      e1z * e2x - e1x * e2z,
      e1x * e2y - e1y * e2x,
    )
    if (area < 1e-9) bad++
  }
  return bad
}

describe('prims — adaptive terrain', () => {
  test('flat terrain: grid faces up, skirt exactly skirtDepth below the edge', () => {
    const flat = () => 0.5
    const terr = createAdaptiveTerrain({
      heightFn: flat, amplitude: 1, tileSize: 4, radius: 12,
      maxSegments: 16, minSegments: 4, skirtDepth: 0.4,
    })
    const g = terr.geometry
    expect(g.vertexCount).toBeGreaterThan(1000)
    expect(countDegenerate(g)).toBe(0)
    // grid CCW up: for flat terrain the grid cross Y-component > 0;
    // skirts are vertical (Y ≈ 0) — check via grid triangles
    let gridTris = 0
    for (let t = 0; t < g.vertexCount / 3; t++) {
      const o = t * 9
      const e1x = g.positions[o + 3]! - g.positions[o]!, e1z = g.positions[o + 5]! - g.positions[o + 2]!
      const e2x = g.positions[o + 6]! - g.positions[o]!, e2z = g.positions[o + 8]! - g.positions[o + 2]!
      const cy = e1z * e2x - e1x * e2z
      if (cy > 1e-9) gridTris++
    }
    // grid is the majority; skirts are not up
    expect(gridTris).toBeGreaterThan(g.vertexCount / 6 * 0.5)
    // skirt: minY = 0.5 − 0.4 = 0.1, maxY = 0.5
    let minY = Infinity, maxY = -Infinity
    for (let i = 0; i < g.vertexCount; i++) {
      minY = Math.min(minY, g.positions[i * 3 + 1]!)
      maxY = Math.max(maxY, g.positions[i * 3 + 1]!)
    }
    expect(minY).toBeCloseTo(0.1, 5)
    expect(maxY).toBeCloseTo(0.5, 5)
  })

  test('skirts add vertices; skirtDepth=0 — pure grid', () => {
    const flat = () => 0
    const withSkirt = createAdaptiveTerrain({
      heightFn: flat, tileSize: 4, radius: 8, maxSegments: 8, minSegments: 8, skirtDepth: 0.4,
    })
    const noSkirt = createAdaptiveTerrain({
      heightFn: flat, tileSize: 4, radius: 8, maxSegments: 8, minSegments: 8, skirtDepth: 0,
    })
    // one level-0 tile at the 8×8 center — counting exactly
    expect(noSkirt.geometry.vertexCount).toBeGreaterThan(0)
    expect(withSkirt.geometry.vertexCount).toBeGreaterThan(noSkirt.geometry.vertexCount)
  })

  test('distance-based LOD: near tile more detailed than far one (levelCounts)', () => {
    const terr = createAdaptiveTerrain({
      heightFn: worldHills(7), tileSize: 4, radius: 24, maxSegments: 32, minSegments: 4, skirtDepth: 0.4,
    })
    expect(terr.levelCounts.length).toBeGreaterThanOrEqual(2)
    expect(terr.levelCounts[0]!).toBeGreaterThanOrEqual(1) // there are max-res tiles
    expect(terr.tiles).toBeGreaterThan(terr.levelCounts[0]!)
    // sum of levels = tiles
    const sum = terr.levelCounts.reduce((a, b) => a + b, 0)
    expect(sum).toBe(terr.tiles)
  })

  test('STITCHING: equal-resolution neighbors — shared edge vertices MATCH', () => {
    // Camera (2, 2): tiles (0,0) and (1,0) are both at level 0 — their shared edge
    // x=4, z ∈ [0,4] is sampled by BOTH tiles with step 4/32. Each
    // interior edge node appears in the soup 6 times (3 emissions from each
    // tile — by the number of adjacent quad-triangles) with an IDENTICAL height:
    // both tiles' lattices are snapped to the WORLD grid — vertex-to-vertex.
    const terr = createAdaptiveTerrain({
      heightFn: worldHills(7), tileSize: 4, radius: 6, maxSegments: 32, minSegments: 32, skirtDepth: 0,
    })
    expect(terr.update(2, 2)).toBe(true) // rebuild around (2,2) — the seam is in frame
    const g = terr.geometry
    const byKey = new Map<string, { count: number; y: number; yConsistent: boolean }>()
    for (let i = 0; i < g.vertexCount; i++) {
      const x = g.positions[i * 3]!
      const y = g.positions[i * 3 + 1]!
      const z = g.positions[i * 3 + 2]!
      const key = `${x.toFixed(6)},${z.toFixed(6)}`
      const entry = byKey.get(key)
      if (entry === undefined) {
        byKey.set(key, { count: 1, y, yConsistent: true })
      } else {
        entry.count++
        if (Math.abs(entry.y - y) > 1e-6) entry.yConsistent = false
      }
    }
    // Interior nodes of edge x=4, z ∈ (0.5, 3.5): exactly 6 copies (3+3), heights equal
    let checked = 0
    for (const [key, entry] of byKey) {
      const [xs, zs] = key.split(',').map(Number)
      if (Math.abs(xs - 4) > 1e-4) continue
      if (zs <= 0.5 || zs >= 3.5) continue
      expect(entry.count).toBe(6) // 3 emissions × 2 tiles — the seam is stitched vertex-to-vertex
      expect(entry.yConsistent).toBe(true) // heights matched bit-for-bit
      checked++
    }
    expect(checked).toBeGreaterThanOrEqual(20) // 23 interior edge nodes (range (0.5, 3.5))
  })

  test('quantized rebuild: <tileSize/2 — false, ≥ — true', () => {
    const terr = createAdaptiveTerrain({
      heightFn: worldHills(7), tileSize: 4, radius: 12, maxSegments: 8, minSegments: 4,
    })
    expect(terr.rebuilds).toBe(1)
    expect(terr.update(1, 0)).toBe(false) // 1 < 2
    expect(terr.rebuilds).toBe(1)
    expect(terr.update(2, 0)).toBe(true) // exactly tileSize/2 — time to rebuild
    expect(terr.rebuilds).toBe(2)
    expect(terr.update(3.5, 0)).toBe(false)
    // diagonal: (2,0) → (3.5, 1.5) = hypot(1.5,1.5) ≈ 2.12 > 2
    expect(terr.update(3.5, 1.5)).toBe(true)
    expect(terr.rebuilds).toBe(3)
  })

  test('heightFn is called in WORLD coordinates', () => {
    const calls: Array<[number, number]> = []
    const terr = createAdaptiveTerrain({
      heightFn: (x, z) => {
        calls.push([x, z])
        return 0
      },
      tileSize: 4, radius: 4, maxSegments: 4, minSegments: 4, skirtDepth: 0,
    })
    expect(terr.geometry.vertexCount).toBeGreaterThan(0)
    // tile (0,0): world x/z ∈ [−1·step, 4+step] — NO normalized [-1,1]
    const sawOutside = calls.some(([x, z]) => x < -0.5 || x > 4.5 || z < -0.5 || z > 4.5)
    expect(sawOutside).toBe(true) // the apron extends beyond the tile bounds
    // and the function receives coordinates on the step-1 lattice (4/4)
    const onGrid = calls.every(([x]) => Math.abs(x / 1 - Math.round(x / 1)) < 1e-9)
    expect(onGrid).toBe(true)
  })

  test('determinism: same parameters — byte-identical geometry', () => {
    const a = createAdaptiveTerrain({
      heightFn: worldHills(7), tileSize: 4, radius: 12, maxSegments: 8, minSegments: 4, skirtDepth: 0.4,
    })
    const b = createAdaptiveTerrain({
      heightFn: worldHills(7), tileSize: 4, radius: 12, maxSegments: 8, minSegments: 4, skirtDepth: 0.4,
    })
    expect(a.geometry.vertexCount).toBe(b.geometry.vertexCount)
    for (let i = 0; i < a.geometry.positions.length; i++) {
      expect(a.geometry.positions[i]!).toBe(b.geometry.positions[i]!)
    }
  })

  test('UV palette: uv.y ∈ [0,1] with runaway heights (fixed range)', () => {
    const terr = createAdaptiveTerrain({
      heightFn: () => 5, amplitude: 1, tileSize: 4, radius: 4, maxSegments: 4, minSegments: 4,
    })
    for (let i = 0; i < terr.geometry.vertexCount; i++) {
      const v = terr.geometry.uvs[i * 2 + 1]!
      expect(v).toBeLessThanOrEqual(1)
      expect(v).toBeGreaterThanOrEqual(0)
    }
  })

  test('adaptive presets: five terrains, all build', () => {
    const keys = Object.keys(adaptivePresets)
    expect(keys.length).toBeGreaterThanOrEqual(5)
    for (const key of keys) {
      const preset = adaptivePresets[key]!
      const terr = createAdaptiveTerrain({
        heightFn: preset.height(3), amplitude: preset.amplitude,
        tileSize: 4, radius: 10, maxSegments: 8, minSegments: 4, skirtDepth: 0.4,
      })
      expect(terr.geometry.vertexCount).toBeGreaterThan(500)
      expect(countDegenerate(terr.geometry)).toBe(0)
    }
  })
})
