import { describe, expect, test } from 'bun:test'
import {
  quadtreeTileMesh,
  selectQuadtreeTiles,
} from '../src/quadtree.ts'

// ─── Selection: coverage invariants ─────────────────────────────────────────

describe('selectQuadtreeTiles', () => {
  test('level 1 = only the root', () => {
    const sel = selectQuadtreeTiles({ centerX: 0, centerZ: 0, rootSize: 100, levels: 1 })
    expect(sel.count).toBe(1)
    expect(sel.instances[0]).toBe(0) // cx
    expect(sel.instances[1]).toBe(0) // cz
    expect(sel.instances[2]).toBe(100) // size
    expect(sel.instances[3]).toBe(0) // level
    expect(sel.minLevel).toBe(0)
    expect(sel.maxLevel).toBe(0)
  })

  test('full coverage without overlaps: the sum of areas == the root area', () => {
    // The center is OUTSIDE the root's center — the worst case for overlaps/holes.
    for (const [cx, cz] of [[0, 0], [37.3, -11.9], [500, 500]] as const) {
      const sel = selectQuadtreeTiles({
        centerX: cx,
        centerZ: cz,
        rootSize: 1024,
        levels: 6,
        splitFactor: 0.5,
      })
      let area = 0
      for (let i = 0; i < sel.count; i++) {
        const size = sel.instances[i * 4 + 2]
        area += size * size
      }
      expect(area).toBeCloseTo(1024 * 1024, 6)
    }
  })

  test('tile sizes — only powers of two of rootSize', () => {
    const sel = selectQuadtreeTiles({
      centerX: 12, centerZ: -5, rootSize: 512, levels: 8, splitFactor: 0.25,
    })
    expect(sel.count).toBeGreaterThan(1)
    for (let i = 0; i < sel.count; i++) {
      const size = sel.instances[i * 4 + 2]
      const level = sel.instances[i * 4 + 3]
      expect(size).toBeCloseTo(512 / Math.pow(2, level), 10)
      expect(Number.isInteger(level)).toBe(true)
      expect(level).toBeGreaterThanOrEqual(0)
      expect(level).toBeLessThan(8)
    }
  })

  test('near the center — small tiles, far — large (LOD)', () => {
    const sel = selectQuadtreeTiles({
      centerX: 0, centerZ: 0, rootSize: 2048, levels: 8, splitFactor: 0.2,
    })
    expect(sel.maxLevel).toBe(7) // under the camera — the maximum level
    let nearSize = Infinity
    let farSize = 0
    for (let i = 0; i < sel.count; i++) {
      const d = Math.hypot(sel.instances[i * 4], sel.instances[i * 4 + 1])
      if (d < 100) nearSize = Math.min(nearSize, sel.instances[i * 4 + 2])
      if (d > 800) farSize = Math.max(farSize, sel.instances[i * 4 + 2])
    }
    expect(nearSize).toBe(2048 / 128) // 16 — the smallest
    expect(farSize).toBeGreaterThan(nearSize * 4)
  })

  test('the tile count is bounded: a dense factor does not blow up the count', () => {
    const sel = selectQuadtreeTiles({
      centerX: 0, centerZ: 0, rootSize: 16384, levels: 10,
      splitFactor: 0.17, maxTiles: 512,
    })
    expect(sel.count).toBeLessThanOrEqual(512)
    expect(sel.count).toBeGreaterThan(16)
    // WITHOUT the cap the dense factor yields ~2K tiles (a Task 113 measurement —
    // demo parameter tuning): the fuse is mandatory for cheap devices.
    const uncapped = selectQuadtreeTiles({
      centerX: 0, centerZ: 0, rootSize: 16384, levels: 10, splitFactor: 0.17,
    })
    expect(uncapped.count).toBeGreaterThan(512)
  })

  test('out reuse: no allocations on a warm frame', () => {
    const out = selectQuadtreeTiles({ centerX: 0, centerZ: 0, rootSize: 256, levels: 4 })
    const first = out.instances
    const again = selectQuadtreeTiles({
      centerX: 3, centerZ: 4, rootSize: 256, levels: 4, out,
    })
    expect(again).toBe(out)
    expect(again.instances).toBe(first) // the same buffer (no growth was needed)
    expect(again.count).toBeGreaterThan(0)
    // The tail past count is not read as garbage — count is honest
    expect(again.instances.length).toBeGreaterThanOrEqual(again.count * 4)
  })

  test('frustum culling: a root entirely outside a plane is cut away', () => {
    // Inside = the half-space x ≥ -100. The root [-350..-250] is entirely to the left.
    const planes = new Float32Array([
      0, 0, 1, 16384,
      0, 0, -1, 16384,
      0, 1, 0, 16384,
      0, -1, 0, 16384,
      1, 0, 0, 100, // x ≥ -100
      -1, 0, 0, 16384,
    ])
    const sel = selectQuadtreeTiles({
      centerX: -300, centerZ: 0, rootSize: 100, levels: 4, splitFactor: 0.5,
      frustum: planes,
    })
    expect(sel.count).toBe(0)

    // The same root, but straddling the boundary — stays (conservativeness).
    const straddling = selectQuadtreeTiles({
      centerX: -60, centerZ: 0, rootSize: 100, levels: 4, splitFactor: 0.5,
      frustum: planes,
    })
    expect(straddling.count).toBeGreaterThan(0)
  })

  test('frustum culling: a narrow corridor leaves a strip of tiles', () => {
    // Inside = a narrow strip |x| ≤ 50 around the center.
    const planes = new Float32Array([
      0, 0, 1, 16384,
      0, 0, -1, 16384,
      0, 1, 0, 16384,
      0, -1, 0, 16384,
      1, 0, 0, 50,
      -1, 0, 0, 50,
    ])
    const sel = selectQuadtreeTiles({
      centerX: 0, centerZ: 0, rootSize: 512, levels: 3, splitFactor: 1,
      frustum: planes,
    })
    expect(sel.count).toBeGreaterThan(0)
    // Every remaining tile is either inside the strip or touches it
    // (conservativeness: there must be no tiles entirely outside).
    for (let i = 0; i < sel.count; i++) {
      const cx = sel.instances[i * 4]
      const size = sel.instances[i * 4 + 2]
      expect(cx + size / 2).toBeGreaterThan(-50)
      expect(cx - size / 2).toBeLessThan(50)
    }
  })

  test('center snapping does not break the invariants (tessellation stability)', () => {
    // Snap to 2·(rootSize/2^levels): the selection on the snapped grid changes
    // only when crossing a boundary — we check that the coverage stays full.
    for (let s = 0; s < 8; s++) {
      const snap = (2 * 1024) / 128
      const cx = s * snap - 3.5 * snap
      const sel = selectQuadtreeTiles({
        centerX: Math.round(cx / snap) * snap,
        centerZ: 0,
        rootSize: 1024,
        levels: 7,
        splitFactor: 0.3,
      })
      let area = 0
      for (let i = 0; i < sel.count; i++) area += sel.instances[i * 4 + 2] ** 2
      expect(area).toBeCloseTo(1024 * 1024, 6)
    }
  })

  test('argument validation errors', () => {
    expect(() =>
      selectQuadtreeTiles({ centerX: 0, centerZ: 0, rootSize: -1, levels: 4 }),
    ).toThrow()
    expect(() =>
      selectQuadtreeTiles({ centerX: 0, centerZ: 0, rootSize: 100, levels: 0 }),
    ).toThrow()
    expect(() =>
      selectQuadtreeTiles({ centerX: 0, centerZ: 0, rootSize: 100, levels: 2, splitFactor: 0 }),
    ).toThrow()
    expect(() =>
      selectQuadtreeTiles({
        centerX: 0, centerZ: 0, rootSize: 100, levels: 2,
        frustum: new Float32Array(12),
      }),
    ).toThrow()
  })
})

// ─── Tile mesh ─────────────────────────────────────────────────────────────

describe('quadtreeTileMesh', () => {
  test('a 4×4 grid: sizes and counters', () => {
    const mesh = quadtreeTileMesh({ segments: 4, skirt: false })
    expect(mesh.vertexCount).toBe(25)
    expect(mesh.skirtVertexCount).toBe(0)
    expect(mesh.indices.length).toBe(4 * 4 * 6)
    // edge grid 4×4: 5·4·2 (horiz+vert) + 16 (diagonals) = 56 edges
    expect(mesh.edgeIndices.length).toBe(56 * 2)
    expect(mesh.positions.length).toBe(25 * 3)
    expect(mesh.uvs.length).toBe(25 * 2)
  })

  test('skirt: +4·(segments+1) vertices and walls along the perimeter', () => {
    const segments = 8
    const mesh = quadtreeTileMesh({ segments, skirt: true })
    expect(mesh.vertexCount).toBe(9 * 9 + 4 * 9)
    expect(mesh.skirtVertexCount).toBe(4 * 9)
    // triangles: grid + 4 walls × segments quads × 2
    expect(mesh.indices.length).toBe((8 * 8 * 2 + 8 * 8) * 3)
    // skirt vertices: the same UVs, flag 1
    let skirtVerts = 0
    for (let i = 0; i < mesh.vertexCount; i++) {
      const skirt = mesh.positions[i * 3 + 2]
      expect(skirt === 0 || skirt === 1).toBe(true)
      if (skirt === 1) {
        skirtVerts++
        // a skirt vertex lies on the rim [0..1]
        const u = mesh.positions[i * 3]
        const v = mesh.positions[i * 3 + 1]
        const onEdge = u === 0 || u === 1 || v === 0 || v === 1
        expect(onEdge).toBe(true)
      }
    }
    expect(skirtVerts).toBe(4 * 9)
    // all indices in range
    for (const idx of mesh.indices) expect(idx).toBeLessThan(mesh.vertexCount)
  })

  test('default: 32 segments, skirt enabled', () => {
    const mesh = quadtreeTileMesh()
    expect(mesh.segments).toBe(32)
    expect(mesh.skirtVertexCount).toBe(4 * 33)
    expect(mesh.vertexCount).toBe(33 * 33 + 4 * 33)
    // performance: ~1.1K vertices, ~2.6K triangles — peanuts
    expect(mesh.indices.length).toBe((32 * 32 * 2 + 32 * 8) * 3)
  })

  test('edge indices do not include the skirt (the LOD structure reads cleanly)', () => {
    const mesh = quadtreeTileMesh({ segments: 4 })
    const gridCount = 25
    for (const idx of mesh.edgeIndices) expect(idx).toBeLessThan(gridCount)
  })

  test('grid triangles are CCW when viewed from above (+Y)', () => {
    const mesh = quadtreeTileMesh({ segments: 2, skirt: false })
    // (topLeft, bottomLeft, bottomRight): the right-hand-rule normal
    // points UP (+Y) — the same orientation as prims/grid and david.li/waves.
    const [a, b, c] = [mesh.indices[0], mesh.indices[1], mesh.indices[2]]
    const ax = mesh.positions[a * 3], az = mesh.positions[a * 3 + 1]
    const bx = mesh.positions[b * 3], bz = mesh.positions[b * 3 + 1]
    const cx2 = mesh.positions[c * 3], cz2 = mesh.positions[c * 3 + 1]
    // the y component of the 3D cross (b−a)×(c−a) for vectors in the y=0 plane.
    const uy = (bz - az) * (cx2 - ax) - (bx - ax) * (cz2 - az)
    expect(uy).toBeGreaterThan(0)
  })

  test('validation errors', () => {
    expect(() => quadtreeTileMesh({ segments: 0 })).toThrow()
    expect(() => quadtreeTileMesh({ segments: 1.5 })).toThrow()
    expect(() => quadtreeTileMesh({ segments: 1000 })).toThrow()
  })
})
