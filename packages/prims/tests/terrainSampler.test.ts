// terrainSampler.test.ts — Task 216 — THE EXACT-MESH SAMPLER LAWS.
//
// The walker demo's ground oracle reads heightAt(x, z); the renderer draws
// the soup terrain() built. If the sampler interpolated anything but the
// soup's OWN triangles (bilinear over the cell, the analytic height
// function, a different diagonal), the feet would visibly leave the
// ground between vertices on any real relief. The laws:
//
//   1. VERTEX LAW — at every grid vertex the sampler answers the stored
//      height BIT-EXACTLY (the interpolation is exact at corners).
//   2. SOUP LAW — the sampler ≡ the soup's own barycentric triangle
//      interpolation at scattered in-cell points (an independent oracle
//      walks the soup triangles; a diagonal mismatch or a swapped B/D
//      side answers a different PLANE — meter-scale errors on real relief,
//      caught loudly). Tolerance 1e-4: the oracle's own corner coordinates
//      are the soup's f32-ROUNDED positions (a ~1e-6 quantization the
//      sampler does not pay — it reads the grid's f32 heights at exact
//      f64 cell coordinates; the sampler is the MORE accurate of the two,
//      the tolerance is the oracle's honest noise floor).
//   3. CONTINUITY LAW — across the diagonal the two triangles meet: the
//      limit from both sides is the same value (the shared edge).
//   4. CLAMP LAW — beyond the grid the border cell's plane answers (a
//      bounded world, no NaN, no falling off the map).
//   5. DETERMINISM — the same seed → the same grid bytes.
import { describe, expect, test } from 'bun:test'
import { terrain, terrainGrid, gridHeightSampler, heightHills, heightRidged } from '../src/terrain.ts'
import type { TerrainGrid } from '../src/terrain.ts'

/** An independent oracle: walk the SOUP's triangles, find the one whose
 *  2D footprint contains (x, z), barycentric-interpolate its 3 heights.
 *  Deliberately dumb (a full scan) — it must not share a single line with
 *  the sampler under test. */
function soupHeight(g: Geometry2, x: number, z: number): number {
  for (let t = 0; t < g.vertexCount; t += 3) {
    const ax = g.positions[t * 3]!, az = g.positions[t * 3 + 2]!
    const bx = g.positions[t * 3 + 3]!, bz = g.positions[t * 3 + 5]!
    const cx = g.positions[t * 3 + 6]!, cz = g.positions[t * 3 + 8]!
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
    if (d === 0) continue
    const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d
    const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d
    const l3 = 1 - l1 - l2
    if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue
    const h = l1 * g.positions[t * 3 + 1]! + l2 * g.positions[t * 3 + 4]! + l3 * g.positions[t * 3 + 7]!
    return h
  }
  return NaN
}

interface Geometry2 { positions: Float32Array; vertexCount: number }

// a deterministic scattered-point stream (xorshift32 — the demo world's own)
function points(seed: number, count: number, half: number): number[][] {
  let s = seed | 0
  const out: number[][] = []
  for (let k = 0; k < count; k++) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    const x = ((s >>> 0) / 4294967296) * 2 - 1
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    const z = ((s >>> 0) / 4294967296) * 2 - 1
    out.push([x * half * 0.999, z * half * 0.999])
  }
  return out
}

describe('Task 216 — the exact-mesh height sampler', () => {
  // SEG = 32 → step = 2.0 exactly: the (x + half)/step round trip lands on
  // INTEGER grid coordinates bit-exactly, so the vertex law can demand
  // bit equality (a non-power-of-two step rounds to 1.0000000000000004 and
  // the clamp answers the NEIGHBOR cell's plane at 1e-16 off — the demo's
  // world uses power-of-two steps for exactly this reason)
  const SIZE = 64, SEG = 32
  const relief = heightHills(7)
  const grid: TerrainGrid = terrainGrid(SIZE, SEG, relief, { amplitude: 9 })
  const soup = terrain(SIZE, SEG, relief, { amplitude: 9 }) as unknown as Geometry2
  const h = gridHeightSampler(grid)

  test('the vertex law — bit-exact at every grid vertex', () => {
    const V = grid.vertsPerSide
    const step = SIZE / (V - 1)
    for (let j = 0; j < V; j++) {
      for (let i = 0; i < V; i++) {
        const x = -SIZE / 2 + i * step
        const z = -SIZE / 2 + j * step
        expect(h(x, z)).toBe(grid.heights[j * V + i])
      }
    }
  })

  test('the soup law — the sampler IS the mesh at scattered in-cell points', () => {
    for (const [x, z] of points(0x1234, 400, SIZE / 2)) {
      const a = h(x, z)
      const b = soupHeight(soup, x, z)
      expect(Number.isNaN(b)).toBe(false)
      // 1e-4 absolute — the oracle's f32-corner noise floor (see the law
      // list above); a wrong triangle on this relief errs by METERS
      expect(Math.abs(a - b)).toBeLessThanOrEqual(1e-4)
    }
  })

  test('the soup law — the diagonal split itself (points engineered near the diagonal)', () => {
    const V = grid.vertsPerSide
    const step = SIZE / (V - 1)
    for (let j = 0; j < V - 1; j++) {
      for (let i = 0; i < V - 1; i++) {
        const x0 = -SIZE / 2 + i * step, z0 = -SIZE / 2 + j * step
        // just above the diagonal (B side), just below (D side), exactly on it
        for (const d of [-1e-4, 0, 1e-4]) {
          const fx = 0.37, fz = 0.37 + d
          const x = x0 + fx * step, z = z0 + fz * step
          const a = h(x, z)
          const b = soupHeight(soup, x, z)
          expect(Math.abs(a - b)).toBeLessThanOrEqual(1e-4)
        }
      }
    }
  })

  test('the continuity law — the two triangles meet on the shared diagonal', () => {
    const V = grid.vertsPerSide
    const step = SIZE / (V - 1)
    for (let j = 0; j < V - 1; j += 3) {
      for (let i = 0; i < V - 1; i += 3) {
        const x0 = -SIZE / 2 + i * step, z0 = -SIZE / 2 + j * step
        for (const f of [0.2, 0.5, 0.8]) {
          const on = h(x0 + f * step, z0 + f * step)
          const above = h(x0 + f * step, z0 + (f - 1e-6) * step)
          const below = h(x0 + (f - 1e-6) * step, z0 + f * step)
          expect(Math.abs(on - above)).toBeLessThan(1e-4)
          expect(Math.abs(on - below)).toBeLessThan(1e-4)
        }
      }
    }
  })

  test('the clamp law — beyond the grid the border plane answers, no NaN', () => {
    const edge = SIZE / 2
    const far = SIZE * 4
    for (const [x, z] of [[edge + 30, 0], [-edge - 30, 0], [0, edge + 30], [0, -edge - 30], [far, far], [-far, -far]] as const) {
      const v = h(x, z)
      expect(Number.isFinite(v)).toBe(true)
      // the border plane extends: equal to the border-point height at the
      // clamped coordinate (the same triangle, fx/fz clamped)
      const cx = Math.min(Math.max(x, -edge), edge)
      const cz = Math.min(Math.max(z, -edge), edge)
      expect(v).toBe(h(cx, cz))
    }
  })

  test('determinism — the same seed → the same grid bytes', () => {
    const a = terrainGrid(96, 16, heightRidged(11), { amplitude: 5 })
    const b = terrainGrid(96, 16, heightRidged(11), { amplitude: 5 })
    expect(a.heights.length).toBe(b.heights.length)
    for (let k = 0; k < a.heights.length; k++) expect(a.heights[k]).toBe(b.heights[k])
    expect(a.hMin).toBe(b.hMin)
    expect(a.hMax).toBe(b.hMax)
  })

  test('the anchor — terrain() and terrainGrid() are the same bytes (the mesh/sampler contract)', () => {
    // the soup's FIRST triangle's three corner heights ARE grid vertices
    const V = grid.vertsPerSide
    const step = SIZE / (V - 1)
    // first emitted cell is (i=0, j=0): A=(0,0), B=(0,1), C=(1,1)
    const ax = soup.positions[0]!, ay = soup.positions[1]!, az = soup.positions[2]!
    expect(ax).toBeCloseTo(-SIZE / 2, 10)
    expect(az).toBeCloseTo(-SIZE / 2, 10)
    expect(ay).toBe(grid.heights[0])
    const bx = soup.positions[3]!, by = soup.positions[4]!
    expect(bx).toBeCloseTo(-SIZE / 2, 10)
    expect(by).toBe(grid.heights[V])
    void step
  })
})
