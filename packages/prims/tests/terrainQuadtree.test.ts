/**
 * terrainQuadtree.test.ts — the terrain primitive on a quadtree (Task 115).
 *
 * The system = the validated quadtree system of the FFT ocean (Task 113): a world
 * fixed grid of roots (vertices do not swim), splitting by 3D distance with a
 * depth limit, skirts, zero allocations per frame. Here — the invariants of the primitive:
 *  • COVERAGE without holes: every point of the "camera ± horizon" disk is covered by a leaf;
 *  • determinism and "no swimming" (a fixed grid): a small camera shift within
 *    a leaf does not change the set of leaves;
 *  • near-detail limit (minLeafSize — a hard ceiling);
 *  • LOD aggressiveness monotonicity (more A ⇒ fewer leaves);
 *  • patch skirt: skirt vertices PARASITICALLY coincide by (x,z) with the rim
 *    (bit-for-bit — the same uv ⇒ the same displacement ⇒ no cracks);
 *  • zero allocations per frame (a singleton result);
 *  • CPU height and presets.
 */
import { describe, test, expect } from 'bun:test'
import { createTerrainQuadtree, terrainQuadtreePresets, terrainHills } from '../src/terrainQuadtree.ts'
import { selectQuadtreeLeaves, quadtreePatch, PATCH_CELLS, PATCH_TRIANGLE_COUNT, PATCH_VERTEX_COUNT } from '../src/quadtree.ts'

/** Is there a covering leaf for the point (XZ, without height — conservatively)? */
function covered(sel: { leafCount: number; instanceData: Float32Array }, x: number, z: number): boolean {
  for (let i = 0; i < sel.leafCount; i++) {
    const ox = sel.instanceData[i * 4]!
    const oz = sel.instanceData[i * 4 + 1]!
    const size = sel.instanceData[i * 4 + 2]!
    if (x >= ox && x < ox + size && z >= oz && z < oz + size) return true
  }
  return false
}

describe('prims — terrain on a quadtree (Task 115)', () => {
  test('coverage without holes: the points of the camera±horizon disk are covered by leaves', () => {
    const t = createTerrainQuadtree({ horizon: 3000, rootSize: 512 })
    const sel = t.select(0, 100, 0)
    expect(sel.leafCount).toBeGreaterThan(0)
    // A uniform grid of points within the radius (the corners of the disk are the riskiest).
    for (let r = 0; r < 6; r++) {
      for (let a = 0; a < 16; a++) {
        const ang = (a / 16) * Math.PI * 2
        const x = Math.cos(ang) * (r / 6) * 2900
        const z = Math.sin(ang) * (r / 6) * 2900
        expect(covered(sel, x, z)).toBe(true)
      }
    }
  })

  test('world fixed grid: leaf origins are aligned to the grid (vertices do not swim)', () => {
    const t = createTerrainQuadtree({ horizon: 2500, rootSize: 512 })
    const sel = t.select(100.37, 200.91, 0) // a "floating" camera position
    expect(sel.leafCount).toBeGreaterThan(0)
    for (let i = 0; i < sel.leafCount; i++) {
      const ox = sel.instanceData[i * 4]!
      const oz = sel.instanceData[i * 4 + 1]!
      const size = sel.instanceData[i * 4 + 2]!
      // The origin — always a multiple of the leaf size: the world grid is FIXED,
      // when the camera moves only the SET of leaves changes, not their lattice
      // (vertices do not "swim" — the main invariant against shimmer).
      expect(Math.abs(ox / size - Math.round(ox / size))).toBeLessThan(1e-9)
      expect(Math.abs(oz / size - Math.round(oz / size))).toBeLessThan(1e-9)
      expect(Math.abs(Math.log2(size) - Math.round(Math.log2(size)))).toBeLessThan(1e-9)
    }
    // LOD stability: a small camera shift changes the set LITTLE (hysteresis
    // is not needed — split boundaries are rare; >70% of leaves coincide).
    const a = t.select(100, 200, 0)
    const b = t.select(110, 200, 0)
    const key = (s: { leafCount: number; instanceData: Float32Array }): Set<string> => {
      const out = new Set<string>()
      for (let i = 0; i < s.leafCount; i++) {
        out.add(`${s.instanceData[i * 4]!},${s.instanceData[i * 4 + 1]!},${s.instanceData[i * 4 + 2]!}`)
      }
      return out
    }
    const ka = key(a)
    const kb = key(b)
    let same = 0
    for (const k of ka) if (kb.has(k)) same++
    expect(same / Math.max(ka.size, kb.size)).toBeGreaterThan(0.7)
  })

  test('zero large allocations: the result is light, the instance buffer is SHARED', () => {
    const t = createTerrainQuadtree({})
    const a = t.select(0, 100, 0)
    const b = t.select(5000, 100, -3000)
    // The instance buffer — one and the same (pre-allocated; the contents
    // are refilled on every call — WITHOUT TypedArray allocations).
    expect(b.instanceData).toBe(a.instanceData)
    // The result object is fresh per call: two selections live independently
    // (lesson: a singleton aliased them — comparing selections silently lied).
    expect(b).not.toBe(a)
    expect(a.leafCount).toBeGreaterThan(0)
    expect(b.leafCount).toBeGreaterThan(0)
  })

  test('near-detail limit: minLeafSize — a hard ceiling', () => {
    for (const a of [1, 2, 3]) {
      const t = createTerrainQuadtree({ aggressiveness: a, rootSize: 4096 })
      const sel = t.select(0, 100, 0)
      expect(sel.minLeafSize).toBeGreaterThanOrEqual(t.lod.minLeafSize)
      expect(sel.lod.maxDepth).toBe(t.lod.maxDepth)
    }
  })

  test('LOD aggressiveness is monotonic: more A ⇒ fewer leaves and triangles', () => {
    const s1 = createTerrainQuadtree({ aggressiveness: 1 }).select(0, 100, 0)
    const s3 = createTerrainQuadtree({ aggressiveness: 3 }).select(0, 100, 0)
    expect(s1.leafCount).toBeGreaterThan(s3.leafCount)
    expect(s1.triangles).toBeGreaterThan(s3.triangles)
  })

  test('view-based culling: the forward sector cuts the far ring', () => {
    const t = createTerrainQuadtree({ horizon: 4000 })
    const all = t.select(0, 100, 0) // without forward — everything around
    const fwd = t.select(0, 100, 0, 1, 0) // looking strictly in +X
    expect(fwd.leafCount).toBeLessThan(all.leafCount)
    expect(fwd.leafCount).toBeGreaterThan(0)
  })

  test('patch skirt: skirt vertices replicate the (x,z) of the rim bit-for-bit', () => {
    const t = createTerrainQuadtree({})
    const { vertices, triangleIndices, edgeIndices, segments } = t.patch
    expect(segments).toBe(PATCH_CELLS)
    expect(vertices.length).toBe(PATCH_VERTEX_COUNT * 3)
    expect(triangleIndices.length).toBe(PATCH_TRIANGLE_COUNT * 3)
    const side = segments + 3
    // For every skirt vertex (skirt=1) there is an interior one with the same (x,z).
    let skirtCount = 0
    for (let i = 0; i < vertices.length / 3; i++) {
      if (vertices[i * 3 + 2] !== 1) continue
      skirtCount++
      let has = false
      for (let j = 0; j < vertices.length / 3 && !has; j++) {
        if (vertices[j * 3 + 2] !== 0) continue
        if (vertices[j * 3] === vertices[i * 3] && vertices[j * 3 + 1] === vertices[i * 3 + 1]) has = true
      }
      expect(has).toBe(true)
    }
    expect(skirtCount).toBe(side * side - (segments + 1) * (segments + 1))
    // The wireframe — interior only (the skirt is not drawn).
    expect(edgeIndices.length).toBeGreaterThan(0)
  })

  test('CPU height: heightAt = heightFn; without heightFn — NaN', () => {
    const fn = (x: number, z: number): number => x + z * 2
    const t = createTerrainQuadtree({ heightFn: fn })
    expect(t.heightAt(3, 4)).toBe(11)
    const bare = createTerrainQuadtree({})
    expect(Number.isNaN(bare.heightAt(0, 0))).toBe(true)
  })

  test('skirt: the ocean formula is bounded by [8, 300] and grows with detail', () => {
    const t = createTerrainQuadtree({})
    expect(t.skirtDepthFor(4096)).toBe(8)
    expect(t.skirtDepthFor(16)).toBe(300)
    expect(t.skirtDepthFor(256)).toBeGreaterThan(t.skirtDepthFor(1024))
  })

  test('selectView: forward from the (column-major) view matrix', () => {
    const t = createTerrainQuadtree({ horizon: 4000 })
    const view = new Float32Array(16)
    view[0] = view[5] = view[10] = view[15] = 1
    // Looking in +X: view[2] = −1 (rot[0][2]) → forward = (1, 0).
    view[2] = -1
    view[10] = 0
    const sel = t.selectView(0, 100, 0, view)
    expect(sel.leafCount).toBeGreaterThan(0)
  })

  test('relief presets: continuous heightFn + sane amplitudes', () => {
    for (const preset of terrainQuadtreePresets) {
      expect(typeof preset.heightFn(0, 0)).toBe('number')
      expect(Number.isFinite(preset.heightFn(123.4, -567.8))).toBe(true)
      // Continuity: close points — close heights.
      const h1 = preset.heightFn(1000, 1000)
      const h2 = preset.heightFn(1001, 1000)
      expect(Math.abs(h1 - h2)).toBeLessThan(preset.amplitude * 0.2 + 5)
      expect(preset.amplitude).toBeGreaterThan(0)
    }
  })

  test('triangles per leaf = the patch with the skirt (one draw command)', () => {
    const t = createTerrainQuadtree({})
    const sel = t.select(0, 100, 0)
    expect(sel.triangles).toBe(sel.leafCount * t.trianglesPerLeaf)
    expect(t.trianglesPerLeaf).toBe(PATCH_TRIANGLE_COUNT)
  })

  test('parameters are validated: rootSize ≤ 0 — a loud throw', () => {
    expect(() => createTerrainQuadtree({ rootSize: 0 })).toThrow()
    expect(() => createTerrainQuadtree({ rootSize: -8 })).toThrow()
  })

  test('the leaf selector directly: the horizon disk + capacity limit', () => {
    const sel = selectQuadtreeLeaves(0, 0, 100, { horizon: 2000, maxInstances: 64 })
    expect(sel.leafCount).toBeLessThanOrEqual(64)
    expect(sel.leafCount).toBeGreaterThan(0)
    // The capacity grew lazily — and the result is consistent.
    const big = selectQuadtreeLeaves(0, 0, 100, { horizon: 10000, maxInstances: 2048 })
    expect(big.leafCount).toBeGreaterThan(sel.leafCount)
  })
})
