/**
 * Terrains and noise of @rune/prims (Task 107):
 *   • the noise is DETERMINISTIC (seed → byte-identical geometry), in [0,1],
 *     continuous, lattice nodes = hash;
 *   • terrain: a grid of segments² cells, central-difference normals
 *     are unit and CORRECT (checked on a plane and a known slope);
 *   • UV: v = normalized height [0,1] (the field's min/max);
 *   • presets: different seeds → different relief; the relief is in a sane range.
 */

import { describe, test, expect } from 'bun:test'
import {
  terrain, terrainHills, terrainRidged, terrainIsland, terrainDunes, terrainCanyon, terrainVolcano,
  terrainPresets, heightHills,
} from '../src/terrain.ts'
import { hash2i, valueNoise2D, fbm2D, ridged2D } from '../src/noise.ts'

describe('prims/noise — deterministic value-noise', () => {
  test('hash2i is deterministic and in [0,1), different inputs diverge', () => {
    expect(hash2i(3, 7, 11)).toBe(hash2i(3, 7, 11))
    expect(hash2i(3, 7, 11)).not.toBe(hash2i(3, 7, 12))
    expect(hash2i(3, 7, 11)).not.toBe(hash2i(4, 7, 11))
    for (let i = 0; i < 200; i++) {
      const v = hash2i(i, i * 7, 5)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
  test('valueNoise2D: continuous, equal to the hash at lattice nodes, range [0,1]', () => {
    // a lattice node — the exact hash value
    expect(valueNoise2D(4, 2, 9)).toBeCloseTo(hash2i(4, 2, 9), 10)
    // continuity: the midpoint between nodes is close to the average of the neighbors
    const mid = valueNoise2D(4.5, 2, 9)
    const a = valueNoise2D(4, 2, 9)
    const b = valueNoise2D(5, 2, 9)
    expect(mid).toBeGreaterThan(Math.min(a, b) - 1e-6)
    expect(mid).toBeLessThan(Math.max(a, b) + 1e-6)
    for (let i = 0; i < 100; i++) {
      const v = valueNoise2D(i * 0.37, i * 0.61, 3)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })
  test('fbm2D/ridged2D: deterministic, range [0,1]', () => {
    expect(fbm2D(1.3, 2.7, 5)).toBe(fbm2D(1.3, 2.7, 5))
    expect(ridged2D(1.3, 2.7, 5)).toBe(ridged2D(1.3, 2.7, 5))
    for (let i = 0; i < 100; i++) {
      const x = i * 0.41
      const y = i * 0.29
      const f = fbm2D(x, y, 7, 4)
      const r = ridged2D(x, y, 7, 4)
      expect(f).toBeGreaterThanOrEqual(0)
      expect(f).toBeLessThanOrEqual(1)
      expect(r).toBeGreaterThanOrEqual(0)
      expect(r).toBeLessThanOrEqual(1)
    }
  })
})

describe('prims/terrain — grid and normals', () => {
  test('count: segments² cells × 2 triangles × 3 vertices; arrays are consistent', () => {
    const g = terrain(2, 8, () => 0)
    expect(g.vertexCount).toBe(8 * 8 * 6)
    expect(g.positions.length).toBe(g.vertexCount * 3)
    expect(g.normals.length).toBe(g.vertexCount * 3)
    expect(g.uvs.length).toBe(g.vertexCount * 2)
  })
  test('flat relief: all normals +Y, height const, UV.y is degenerate-constant', () => {
    const g = terrain(2, 4, () => 0.3)
    for (let i = 0; i < g.vertexCount; i++) {
      expect(g.positions[i * 3 + 1]!).toBeCloseTo(0.3, 6)
      expect(g.normals[i * 3]!).toBeCloseTo(0, 6)
      expect(g.normals[i * 3 + 1]!).toBeCloseTo(1, 6)
      expect(g.normals[i * 3 + 2]!).toBeCloseTo(0, 6)
      // a single-height field: span → 1e-6, normalized height ≡ 0
      expect(g.uvs[i * 2 + 1]!).toBeCloseTo(0, 6)
    }
  })
  test('linear slope: normals are perpendicular to the gradient (known analytically)', () => {
    // h(x,z) = 0.5·x → ∂h/∂x = 0.5, ∂h/∂z = 0
    const g = terrain(2, 6, (x) => 0.5 * x)
    // Normal ∝ (−0.5, 1, 0)/‖·‖ → ny/nx = −2
    for (let i = 0; i < g.vertexCount; i++) {
      expect(g.normals[i * 3 + 1]! / g.normals[i * 3]!).toBeCloseTo(-2, 3)
      expect(g.normals[i * 3 + 2]!).toBeCloseTo(0, 3)
    }
  })
  test('UV: v = normalized field height [0,1] (min→0, max→1)', () => {
    const g = terrain(2, 6, (x, z) => Math.hypot(x, z)) // a cone: center 0, edge ~√2
    let vMin = 1
    let vMax = 0
    for (let i = 0; i < g.vertexCount; i++) {
      vMin = Math.min(vMin, g.uvs[i * 2 + 1]!)
      vMax = Math.max(vMax, g.uvs[i * 2 + 1]!)
    }
    expect(vMin).toBeCloseTo(0, 5)
    expect(vMax).toBeCloseTo(1, 5)
    // u — along X: left edge 0, right edge 1
    let uMin = 1
    let uMax = 0
    for (let i = 0; i < g.vertexCount; i++) {
      uMin = Math.min(uMin, g.uvs[i * 2]!)
      uMax = Math.max(uMax, g.uvs[i * 2]!)
    }
    expect(uMin).toBeCloseTo(0, 5)
    expect(uMax).toBeCloseTo(1, 5)
  })
  test('normals are unit on steep relief', () => {
    const g = terrain(2, 16, (x, z) => (Math.abs(x) < 0.1 && Math.abs(z) < 0.1 ? 5 : 0))
    for (let i = 0; i < g.vertexCount; i++) {
      const len = Math.hypot(g.normals[i * 3]!, g.normals[i * 3 + 1]!, g.normals[i * 3 + 2]!)
      expect(len).toBeCloseTo(1, 4)
    }
  })
  test('WINDING (Task 108): faces CCW when viewed FROM ABOVE — the Y of the normal cross(b−a, c−a) > 0', () => {
    // The former grid went CW from above (cross = −Y): the relief rendered its
    // UNDERSIDE with cull:back. Winding (i,j) → (i,j+1) → (i+1,j+1) gives +Y.
    for (const g of [terrain(2, 8, (x, z) => x * z), terrainHills(2, 12, { seed: 7 })]) {
      for (let t = 0; t < g.vertexCount / 3; t++) {
        const o = t * 9
        const ax = g.positions[o]!, az = g.positions[o + 2]!
        const e1x = g.positions[o + 3]! - ax, e1z = g.positions[o + 5]! - az
        const e2x = g.positions[o + 6]! - ax, e2z = g.positions[o + 8]! - az
        expect(e1z * e2x - e1x * e2z).toBeGreaterThan(1e-6)
      }
    }
  })
})

describe('prims/terrain — presets', () => {
  test('determinism: the same seed → element-wise equal positions, another seed — another relief', () => {
    const a = terrainHills(2, 12, { seed: 42 })
    const b = terrainHills(2, 12, { seed: 42 })
    // (Buffer.from(Float32Array) truncates values to bytes — we compare
    // element-wise, an honest check of byte-identity)
    let same = true
    for (let i = 0; i < a.positions.length; i++) {
      if (a.positions[i] !== b.positions[i]) { same = false; break }
    }
    expect(same).toBe(true)
    const c = terrainHills(2, 12, { seed: 43 })
    let diff = 0
    for (let i = 0; i < a.positions.length; i++) {
      if (a.positions[i] !== c.positions[i]) diff++
    }
    expect(diff).toBeGreaterThan(0)
  })
  test('all 6 presets: consistency + height range + unit normals', () => {
    const makers = [terrainHills, terrainRidged, terrainIsland, terrainDunes, terrainCanyon, terrainVolcano]
    for (const make of makers) {
      const g = make(2, 10, { seed: 7 })
      expect(g.vertexCount).toBe(10 * 10 * 6)
      let minY = Infinity
      let maxY = -Infinity
      for (let i = 0; i < g.vertexCount; i++) {
        const len = Math.hypot(g.normals[i * 3]!, g.normals[i * 3 + 1]!, g.normals[i * 3 + 2]!)
        expect(len).toBeCloseTo(1, 4)
        minY = Math.min(minY, g.positions[i * 3 + 1]!)
        maxY = Math.max(maxY, g.positions[i * 3 + 1]!)
      }
      // the relief is not degenerate (there is a spread) and not insane (|h| < 3)
      expect(maxY - minY).toBeGreaterThan(0.1)
      expect(Math.abs(minY)).toBeLessThan(3)
      expect(Math.abs(maxY)).toBeLessThan(3)
    }
  })
  test('island: the center is higher than the edge (a mountain in the middle, ocean at the rim)', () => {
    const cells = 24
    const island = terrainIsland(2, cells, { seed: 3 })
    // the height of the GRID vertex closest to (nx,nz): the first vertex of cell (i,j)
    // is its node (i,j) (emit(i,j) comes first in the cell)
    const hAt = (nx: number, nz: number): number => {
      const i = Math.round(((nx + 1) / 2) * cells)
      const j = Math.round(((nz + 1) / 2) * cells)
      const vi = (j * cells + i) * 6
      return island.positions[vi * 3 + 1] ?? 0
    }
    expect(hAt(0, 0)).toBeGreaterThan(hAt(0.9, 0.9) + 0.05)
  })
  test('volcano: the center is lower than the rim (a crater)', () => {
    const cells = 32
    const volcano = terrainVolcano(2, cells, { seed: 13 })
    const hAt = (nx: number): number => {
      const i = Math.round(((nx + 1) / 2) * cells)
      const j = cells / 2
      const vi = (j * cells + i) * 6
      return volcano.positions[vi * 3 + 1] ?? 0
    }
    const rim = hAt(0.55)
    const center = hAt(0)
    expect(rim).toBeGreaterThan(center + 0.1)
  })
  test('preset table: 6 entries with label/amplitude/note', () => {
    const keys = Object.keys(terrainPresets)
    expect(keys.sort()).toEqual(['canyon', 'dunes', 'hills', 'island', 'ridged', 'volcano'])
    for (const key of keys) {
      const p = terrainPresets[key]!
      expect(p.label.length).toBeGreaterThan(0)
      expect(p.amplitude).toBeGreaterThan(0)
      expect(p.note.length).toBeGreaterThan(0)
      expect(typeof p.height(1)).toBe('function')
    }
  })
  test('heightHills — a pure height function (no geometry)', () => {
    const h = heightHills(9)
    const a = h(0.3, -0.7)
    expect(a).toBe(h(0.3, -0.7))
    expect(Math.abs(a)).toBeLessThan(1)
  })
})
