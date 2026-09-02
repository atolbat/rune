import { describe, test, expect } from 'bun:test'
import { cube } from '../src/cube.ts'

/**
 * Regression for the "quarter face" incident: CORNER_UV was used for
 * positions too → faces collapsed to 1×1 (instead of 2×2) and diverged at the corners.
 * The test locks in full extent, connectivity, and UV consistency.
 */

const EPS = 1e-6

function faceAt(g: ReturnType<typeof cube>, face: number) {
  const verts: Array<{ p: [number, number, number]; n: [number, number, number]; uv: [number, number] }> = []
  for (let v = 0; v < 6; v++) {
    const at = (face * 6 + v) * 3
    const at2 = (face * 6 + v) * 2
    verts.push({
      p: [g.positions[at], g.positions[at + 1], g.positions[at + 2]],
      n: [g.normals[at], g.normals[at + 1], g.normals[at + 2]],
      uv: [g.uvs[at2], g.uvs[at2 + 1]],
    })
  }
  return verts
}

describe('prims/cube — full face extent', () => {
  test('36 vertices, arrays consistent', () => {
    const g = cube(1)
    expect(g.vertexCount).toBe(36)
    expect(g.positions.length).toBe(36 * 3)
    expect(g.normals.length).toBe(36 * 3)
    expect(g.uvs.length).toBe(36 * 2)
  })

  test('bbox = ±half on all axes ("quarter face" regression)', () => {
    for (const half of [1, 0.5, 2]) {
      const g = cube(half)
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity
      for (let i = 0; i < g.positions.length; i += 3) {
        const x = g.positions[i], y = g.positions[i + 1], z = g.positions[i + 2]
        minX = Math.min(minX, x); maxX = Math.max(maxX, x)
        minY = Math.min(minY, y); maxY = Math.max(maxY, y)
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z)
      }
      expect(minX).toBeCloseTo(-half, 6)
      expect(maxX).toBeCloseTo(half, 6)
      expect(minY).toBeCloseTo(-half, 6)
      expect(maxY).toBeCloseTo(half, 6)
      expect(minZ).toBeCloseTo(-half, 6)
      expect(maxZ).toBeCloseTo(half, 6)
    }
  })

  test('all 8 cube corners present', () => {
    const g = cube(1)
    const seen = new Set<string>()
    for (let i = 0; i < g.positions.length; i += 3) {
      seen.add(`${g.positions[i]},${g.positions[i + 1]},${g.positions[i + 2]}`)
    }
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
      expect(seen.has(`${x},${y},${z}`)).toBe(true)
    }
    expect(seen.size).toBe(8) // exactly 8 unique cube vertices
  })

  test('each face — a planar 2half×2half square with outward normal', () => {
    const g = cube(1)
    for (let f = 0; f < 6; f++) {
      const verts = faceAt(g, f)
      const [a, b, c, , , d] = verts // 4 corners: v0,v1,v2,v5
      // edges from corner a
      const e1: [number, number, number] = [b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]]
      const e2: [number, number, number] = [d.p[0] - a.p[0], d.p[1] - a.p[1], d.p[2] - a.p[2]]
      // normal = cross(e1, e2), must match the attribute
      const n: [number, number, number] = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ]
      const len = Math.hypot(n[0], n[1], n[2])
      expect(Math.abs(len - 4)).toBeLessThan(EPS) // |e1|=|e2|=2, perpendicular
      for (let k = 0; k < 3; k++) {
        expect(n[k] / len).toBeCloseTo(a.n[k], 6)
      }
      // all face vertices at the same distance from the center along the normal axis
      for (const v of verts) {
        expect(v.p[0] * a.n[0] + v.p[1] * a.n[1] + v.p[2] * a.n[2]).toBeCloseTo(1, 6)
      }
    }
  })

  test('each face\'s UVs cover [0,1]² at the square corners', () => {
    const g = cube(1)
    for (let f = 0; f < 6; f++) {
      const verts = faceAt(g, f)
      const corners = [verts[0], verts[1], verts[2], verts[5]]
      const uvs = corners.map(v => `${v.uv[0]},${v.uv[1]}`)
      for (const expected of ['0,0', '1,0', '1,1', '0,1']) {
        expect(uvs).toContain(expected)
      }
      // regression: on the quarter face the (0,0) corner sat in the cube CENTER
      const origin = corners.find(v => v.uv[0] === 0 && v.uv[1] === 0)
      const dist = Math.hypot(origin!.p[0], origin!.p[1], origin!.p[2])
      expect(dist).toBeCloseTo(Math.sqrt(3), 6) // cube corner, not face center
    }
  })

  test('faces are connected: each face shares edges with neighbors (a cube, not 6 isolates)', () => {
    const g = cube(1)
    const edgeMidpoints = new Map<string, number>()
    for (let f = 0; f < 6; f++) {
      const verts = faceAt(g, f)
      const corners = [verts[0].p, verts[1].p, verts[2].p, verts[5].p]
      for (let i = 0; i < 4; i++) {
        const a = corners[i], b = corners[(i + 1) % 4]
        const mid = `${(a[0] + b[0]) / 2},${(a[1] + b[1]) / 2},${(a[2] + b[2]) / 2}`
        edgeMidpoints.set(mid, (edgeMidpoints.get(mid) ?? 0) + 1)
      }
    }
    expect(edgeMidpoints.size).toBe(12) // 12 cube edges
    for (const [mid, count] of edgeMidpoints) {
      expect(count).toBe(2) // each edge belongs to exactly two faces
      const [x, y, z] = mid.split(',').map(Number)
      // edge midpoint at distance √2 from the center (neither inside nor outside)
      expect(Math.hypot(x, y, z)).toBeCloseTo(Math.SQRT2, 6)
    }
  })
})
