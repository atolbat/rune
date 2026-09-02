/**
 * Invariants of all @rune/prims generators (Task 107→109):
 *   • array consistency (positions/normals/UVs — per vertexCount);
 *   • normals are UNIT;
 *   • DEGENERATE triangles are forbidden;
 *   • WINDING BY POSITIONS (Task 108): cross(b−a, c−a) · the average attribute
 *     normal > 0 — inside-out halves of quads are caught here;
 *   • exact counts for the options-API (Task 109): box with segments per face,
 *     plane rectangular, cone with heightSegments>1 (degenerate ring —
 *     only the extreme row), platonic solids with detail subdivision.
 *
 * The SHAPES catalog is run in FULL (the registry is the point of truth):
 * for terrains, instead of a winding harness — "faces up" (smooth normals
 * on cliffs legitimately diverge from the face — a shading question, not
 * a winding one).
 */

import { describe, test, expect } from 'bun:test'
import {
  box, cube, sphere, plane, cylinder, cone, capsule, torus, torusKnot,
  tetrahedron, octahedron, icosahedron, dodecahedron, disk, ring,
  SHAPES, defaultValues, segmentValue, createAdaptiveTerrain, worldHills,
} from '../src/index.ts'
import type { Geometry } from '../src/index.ts'

const EPS = 1e-5

function expectConsistent(g: Geometry): void {
  expect(g.vertexCount % 3).toBe(0)
  expect(g.positions.length).toBe(g.vertexCount * 3)
  expect(g.normals.length).toBe(g.vertexCount * 3)
  expect(g.uvs.length).toBe(g.vertexCount * 2)
  expect(g.vertexCount).toBeGreaterThan(0)
}

function expectUnitNormals(g: Geometry): void {
  for (let i = 0; i < g.vertexCount; i++) {
    const len = Math.hypot(g.normals[i * 3]!, g.normals[i * 3 + 1]!, g.normals[i * 3 + 2]!)
    expect(len).toBeCloseTo(1, 4)
  }
}

/** Convex body: the normal of every triangle points away from the origin. */
function expectOutward(g: Geometry): void {
  for (let t = 0; t < g.vertexCount / 3; t++) {
    const cx = (g.positions[t * 9]! + g.positions[t * 9 + 3]! + g.positions[t * 9 + 6]!) / 3
    const cy = (g.positions[t * 9 + 1]! + g.positions[t * 9 + 4]! + g.positions[t * 9 + 7]!) / 3
    const cz = (g.positions[t * 9 + 2]! + g.positions[t * 9 + 5]! + g.positions[t * 9 + 8]!) / 3
    const nx = g.normals[t * 9]!
    const ny = g.normals[t * 9 + 1]!
    const nz = g.normals[t * 9 + 2]!
    expect(nx * cx + ny * cy + nz * cz).toBeGreaterThan(1e-4)
  }
}

/** Non-zero area of every triangle (degenerate ones are forbidden). */
function expectNoDegenerate(g: Geometry): void {
  for (let t = 0; t < g.vertexCount / 3; t++) {
    const ax = g.positions[t * 9]!, ay = g.positions[t * 9 + 1]!, az = g.positions[t * 9 + 2]!
    const bx = g.positions[t * 9 + 3]!, by = g.positions[t * 9 + 4]!, bz = g.positions[t * 9 + 5]!
    const cx = g.positions[t * 9 + 6]!, cy = g.positions[t * 9 + 7]!, cz = g.positions[t * 9 + 8]!
    const area = Math.hypot(
      (by - ay) * (cz - az) - (bz - az) * (cy - ay),
      (bz - az) * (cx - ax) - (bx - ax) * (cz - az),
      (bx - ax) * (cy - ay) - (by - ay) * (cx - ax),
    ) / 2
    expect(area).toBeGreaterThan(1e-7)
  }
}

/**
 * WINDING BY POSITIONS (Task 108): the geometric normal of the face
 * cross(b−a, c−a) must point the same way as the average
 * ATTRIBUTE normal of the triangle's vertices.
 */
function expectWindingMatchesNormals(g: Geometry): void {
  for (let t = 0; t < g.vertexCount / 3; t++) {
    const o = t * 9
    const ax = g.positions[o]!, ay = g.positions[o + 1]!, az = g.positions[o + 2]!
    const e1x = g.positions[o + 3]! - ax, e1y = g.positions[o + 4]! - ay, e1z = g.positions[o + 5]! - az
    const e2x = g.positions[o + 6]! - ax, e2y = g.positions[o + 7]! - ay, e2z = g.positions[o + 8]! - az
    const fx = e1y * e2z - e1z * e2y
    const fy = e1z * e2x - e1x * e2z
    const fz = e1x * e2y - e1y * e2x
    const nx = g.normals[o]! + g.normals[o + 3]! + g.normals[o + 6]!
    const ny = g.normals[o + 1]! + g.normals[o + 4]! + g.normals[o + 7]!
    const nz = g.normals[o + 2]! + g.normals[o + 5]! + g.normals[o + 8]!
    expect(fx * nx + fy * ny + fz * nz).toBeGreaterThan(1e-6)
  }
}

/** The face points UP: the Y component of cross(b−a, c−a) > 0. */
function expectFaceUp(g: Geometry): void {
  for (let t = 0; t < g.vertexCount / 3; t++) {
    const o = t * 9
    const ax = g.positions[o]!, az = g.positions[o + 2]!
    const e1x = g.positions[o + 3]! - ax, e1z = g.positions[o + 5]! - az
    const e2x = g.positions[o + 6]! - ax, e2z = g.positions[o + 8]! - az
    expect(e1z * e2x - e1x * e2z).toBeGreaterThan(1e-6)
  }
}

// ─── Catalog (registry — the point of truth) ─────────────────────────────────────────

describe('prims — SHAPES catalog (Task 109)', () => {
  test('no superellipsoids in the catalog, groups are in place', () => {
    const groups = new Set(SHAPES.map(s => s.group))
    expect(groups.has('Basic')).toBe(true)
    expect(groups.has('Platonic')).toBe(true)
    expect(groups.has('Adaptive relief')).toBe(true)
    expect(SHAPES.some(s => s.id.startsWith('squircle') || s.id.startsWith('super'))).toBe(false)
    expect(SHAPES.length).toBeGreaterThanOrEqual(24)
  })

  test('every shape: catalog invariants (terrains/adaptive — only k=1: segments change the build time, not the invariants)', () => {
    for (const shape of SHAPES) {
      const heavy = shape.group === 'Terrains' || shape.group === 'Adaptive relief'
      const factors = heavy ? [1] : [0.5, 1, 2]
      for (const k of factors) {
        const g = shape.make(defaultValues(shape), k)
        expectConsistent(g)
        expectUnitNormals(g)
        expectNoDegenerate(g)
        if (shape.group === 'Terrains') {
          expectFaceUp(g)
        } else if (shape.group !== 'Adaptive relief') {
          expectWindingMatchesNormals(g)
        }
        for (let i = 0; i < g.vertexCount * 3; i++) {
          expect(Number.isNaN(g.positions[i]!)).toBe(false)
        }
      }
    }
  })

  test('detail ×2 changes the count for SEGMENTED shapes (icosahedron/dodecahedron — via detail? no: via segments)', () => {
    // The platonic solids are NOT segmented (detail is a separate parameter):
    // detail does not change them; parametric shapes do. We check the contrast.
    const icosa = SHAPES.find(s => s.id === 'icosa')!
    const v1 = icosa.make(defaultValues(icosa), 1).vertexCount
    const v2 = icosa.make(defaultValues(icosa), 2).vertexCount
    expect(v1).toBe(v2) // detail=0 — no subdivision
    const sphereShape = SHAPES.find(s => s.id === 'sphere')!
    const s1 = sphereShape.make(defaultValues(sphereShape), 1).vertexCount
    const s2 = sphereShape.make(defaultValues(sphereShape), 2).vertexCount
    expect(s2).toBeGreaterThan(s1 * 3)
  })

  test('adaptive entries: make() builds the static geometry, adaptive() returns the feed config', () => {
    const adaptive = SHAPES.filter(s => s.group === 'Adaptive relief')
    expect(adaptive.length).toBeGreaterThanOrEqual(4)
    for (const shape of adaptive) {
      expect(shape.adaptive).toBeDefined()
      const values = defaultValues(shape)
      const g = shape.make(values, 1)
      expectConsistent(g)
      const cfg = shape.adaptive!(values)
      expect(typeof cfg.heightFn).toBe('function')
      expect(cfg.radius).toBeGreaterThan(0)
    }
  })

  test('segmentValue: multiplier with clamping', () => {
    expect(segmentValue(48, 1, 8, 256)).toBe(48)
    expect(segmentValue(48, 0.5, 8, 256)).toBe(24)
    expect(segmentValue(48, 4, 8, 256)).toBe(192)
    expect(segmentValue(300, 4, 8, 256)).toBe(256) // clamped from above
    expect(segmentValue(20, 0.1, 8, 256)).toBe(8) // clamped from below
  })
})

// ─── Box (Task 109: segments per face) ─────────────────────────────────────

describe('prims — box/cube', () => {
  test('1×1×1 without segments = 36 vertices (cube compatibility)', () => {
    const g = box()
    expect(g.vertexCount).toBe(36)
    expectConsistent(g)
    expectWindingMatchesNormals(g)
    expectOutward(g)
    expect(cube(1).vertexCount).toBe(36)
    // cube(half) — a 2h×2h×2h box: the same geometry
    const c = cube(1.25)
    expect(c.vertexCount).toBe(36)
    expect(Math.max(...c.positions)).toBeCloseTo(1.25, 5)
  })

  test('non-cube: different sizes per axis — exact bbox', () => {
    const g = box({ width: 2, height: 3, depth: 4 })
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (let i = 0; i < g.vertexCount; i++) {
      minX = Math.min(minX, g.positions[i * 3]!); maxX = Math.max(maxX, g.positions[i * 3]!)
      minY = Math.min(minY, g.positions[i * 3 + 1]!); maxY = Math.max(maxY, g.positions[i * 3 + 1]!)
      minZ = Math.min(minZ, g.positions[i * 3 + 2]!); maxZ = Math.max(maxZ, g.positions[i * 3 + 2]!)
    }
    expect(maxX - minX).toBeCloseTo(2, 5)
    expect(maxY - minY).toBeCloseTo(3, 5)
    expect(maxZ - minZ).toBeCloseTo(4, 5)
  })

  test('SEGMENTS PER FACE: count 2·(ws·hs + ws·ds + hs·ds)·2·3', () => {
    const g = box({ widthSegments: 2, heightSegments: 3, depthSegments: 4 })
    const expected = 4 * (2 * 3 + 2 * 4 + 3 * 4) * 3
    expect(g.vertexCount).toBe(expected)
    expectConsistent(g)
    expectNoDegenerate(g)
    expectWindingMatchesNormals(g)
    expectOutward(g)
    // each face's UVs cover [0,1]²
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity
    for (let i = 0; i < g.vertexCount; i++) {
      uMin = Math.min(uMin, g.uvs[i * 2]!); uMax = Math.max(uMax, g.uvs[i * 2]!)
      vMin = Math.min(vMin, g.uvs[i * 2 + 1]!); vMax = Math.max(vMax, g.uvs[i * 2 + 1]!)
    }
    expect(uMin).toBeCloseTo(0, 5)
    expect(uMax).toBeCloseTo(1, 5)
    expect(vMin).toBeCloseTo(0, 5)
    expect(vMax).toBeCloseTo(1, 5)
  })
})

// ─── Plane (Task 109: rectangle + independent segments) ─────────────

describe('prims — plane', () => {
  test('a width×height rectangle, independent segments, CCW from above', () => {
    const g = plane({ width: 2, height: 3, widthSegments: 2, heightSegments: 5 })
    expect(g.vertexCount).toBe(2 * 5 * 6)
    expectConsistent(g)
    expectFaceUp(g)
    expectUnitNormals(g)
    // all normals are +Y
    for (let i = 0; i < g.vertexCount; i++) {
      expect(g.normals[i * 3]!).toBeCloseTo(0, 5)
      expect(g.normals[i * 3 + 1]!).toBeCloseTo(1, 5)
      expect(g.normals[i * 3 + 2]!).toBeCloseTo(0, 5)
    }
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (let i = 0; i < g.vertexCount; i++) {
      minX = Math.min(minX, g.positions[i * 3]!); maxX = Math.max(maxX, g.positions[i * 3]!)
      minZ = Math.min(minZ, g.positions[i * 3 + 2]!); maxZ = Math.max(maxZ, g.positions[i * 3 + 2]!)
    }
    expect(maxX - minX).toBeCloseTo(2, 5)
    expect(maxZ - minZ).toBeCloseTo(3, 5)
    // UV grid: u = i/cellsX along X
    expect(g.uvs[0]!).toBeCloseTo(0, 5)
    expect(g.uvs[2]!).toBeCloseTo(0, 5) // the first vertex of the second triangle
  })

  test('default — a unit square of 6 vertices', () => {
    const g = plane()
    expect(g.vertexCount).toBe(6)
  })
})

// ─── Sphere ─────────────────────────────────────────────────────────────────

describe('prims — sphere (options-API)', () => {
  test('all vertices at the radius, normals = positions/R, CCW outside, poles', () => {
    const R = 1.7
    const g = sphere({ radius: R, widthSegments: 24, heightSegments: 16 })
    expectConsistent(g)
    expectWindingMatchesNormals(g)
    expectNoDegenerate(g)
    for (let i = 0; i < g.vertexCount; i++) {
      const d = Math.hypot(g.positions[i * 3]!, g.positions[i * 3 + 1]!, g.positions[i * 3 + 2]!)
      expect(d).toBeCloseTo(R, 5)
      expect(g.positions[i * 3]! / R).toBeCloseTo(g.normals[i * 3]!, 5)
    }
    // count: 6·radial·(bands−1) — the full set of bands with polar fans
    expect(g.vertexCount).toBe(6 * 24 * (16 - 1))
    let mn = Infinity, mx = -Infinity
    for (let i = 0; i < g.vertexCount; i++) {
      mn = Math.min(mn, g.positions[i * 3 + 1]!)
      mx = Math.max(mx, g.positions[i * 3 + 1]!)
    }
    expect(mn).toBeCloseTo(-R, 5)
    expect(mx).toBeCloseTo(R, 5)
  })
})

// ─── Cylinder/cone (options-API + openEnded + heightSegments) ───────────────

describe('prims — cylinder/cone', () => {
  test('counts: full / openEnded / cone with heightSegments>1', () => {
    // full cylinder: side 2·hSeg·radial + 2 caps
    const full = cylinder({ radialSegments: 8, heightSegments: 2 })
    expect(full.vertexCount).toBe((8 * 2 * 2 + 8 * 2) * 3)
    // open: side only
    const open = cylinder({ radialSegments: 8, heightSegments: 2, openEnded: true })
    expect(open.vertexCount).toBe(8 * 2 * 2 * 3)
    // A CONE with heightSegments=2: the degenerate ring — only the LAST row
    // (Task 109 bug trap: previously the count treated ALL rows as degenerate)
    const cone2 = cylinder({ radiusTop: 0, radialSegments: 8, heightSegments: 2, openEnded: true })
    expect(cone2.vertexCount).toBe(8 * (2 * 2 - 1) * 3)
    expectConsistent(cone2)
    expectNoDegenerate(cone2)
    expectWindingMatchesNormals(cone2)
    // inverted cone (radiusBottom=0): the FIRST row is degenerate
    const inv = cylinder({ radiusTop: 1, radiusBottom: 0, radialSegments: 8, heightSegments: 2, openEnded: true })
    expect(inv.vertexCount).toBe(8 * (2 * 2 - 1) * 3)
    expectNoDegenerate(inv)
    // cone() — a wrapper
    const c = cone({ radius: 1, height: 2, radialSegments: 8 })
    expect(c.vertexCount).toBe((8 * 1 + 8) * 3)
  })

  test('side normals are inclined along the profile (the cone looks sideways)', () => {
    const g = cone({ radius: 1, height: 2, radialSegments: 16, openEnded: true })
    let sumNy = 0
    for (let i = 0; i < g.vertexCount; i++) sumNy += g.normals[i * 3 + 1]!
    const avgNy = sumNy / g.vertexCount
    expect(avgNy).toBeGreaterThan(0.1) // inclined outward, not vertical
    expect(avgNy).toBeLessThan(0.9) // and not up — specifically inclined
    expectWindingMatchesNormals(g)
  })
})

// ─── Capsule ────────────────────────────────────────────────────────────────

describe('prims — capsule', () => {
  test('count 2·radial·(ringCount−2), honest poles', () => {
    const g = capsule({ radius: 0.6, height: 1.2, radialSegments: 12, capSegments: 3 })
    expect(g.vertexCount).toBe(2 * 12 * (3 * 2 + 1 - 2) * 3)
    expectConsistent(g)
    expectWindingMatchesNormals(g)
    expectNoDegenerate(g)
    // poles: maxY = half + r, minY = −half − r
    let mn = Infinity, mx = -Infinity
    for (let i = 0; i < g.vertexCount; i++) {
      mn = Math.min(mn, g.positions[i * 3 + 1]!)
      mx = Math.max(mx, g.positions[i * 3 + 1]!)
    }
    expect(mx).toBeCloseTo(0.6 + 0.6, 5)
    expect(mn).toBeCloseTo(-0.6 - 0.6, 5)
  })
})

// ─── Torus and knot ─────────────────────────────────────────────────────────

describe('prims — torus/knot (options-API)', () => {
  test('torus: points on the tube of radius tube around the ring radius', () => {
    const R = 1.1, r = 0.32
    const g = torus({ radius: R, tube: r, tubularSegments: 24, radialSegments: 12 })
    expect(g.vertexCount).toBe(24 * 12 * 6)
    expectConsistent(g)
    expectWindingMatchesNormals(g)
    for (let i = 0; i < g.vertexCount; i++) {
      const x = g.positions[i * 3]!, y = g.positions[i * 3 + 1]!, z = g.positions[i * 3 + 2]!
      // distance to the circle R in the XZ plane
      const d = Math.hypot(Math.hypot(x, z) - R, y)
      expect(d).toBeCloseTo(r, 4)
    }
  })

  test('knot: determinism + p/q from options', () => {
    const a = torusKnot({ p: 3, q: 4, tube: 0.2, tubularSegments: 96, radialSegments: 6 })
    const b = torusKnot({ p: 3, q: 4, tube: 0.2, tubularSegments: 96, radialSegments: 6 })
    expect(a.vertexCount).toBe(96 * 6 * 6)
    expect(a.positions.length).toBe(b.positions.length)
    for (let i = 0; i < a.positions.length; i++) {
      expect(a.positions[i]!).toBe(b.positions[i]!)
    }
    expectConsistent(a)
    expectWindingMatchesNormals(a)
  })
})

// ─── Platonic solids: detail subdivision (Task 109) ────────────────────────

describe('prims — platonic solids with detail', () => {
  test('detail changes the resolution: counts (d+1)² per face triangle', () => {
    expect(tetrahedron({ detail: 0 }).vertexCount).toBe(4 * 3)
    expect(tetrahedron({ detail: 2 }).vertexCount).toBe(4 * 9 * 3)
    expect(octahedron({ detail: 1 }).vertexCount).toBe(8 * 4 * 3)
    expect(icosahedron({ detail: 1 }).vertexCount).toBe(20 * 4 * 3)
    expect(icosahedron({ detail: 2 }).vertexCount).toBe(20 * 9 * 3) // (d+1)² = 9
    // dodecahedron: 12 pentagons × 3 fan triangles
    expect(dodecahedron({ detail: 0 }).vertexCount).toBe(12 * 3 * 3)
    expect(dodecahedron({ detail: 1 }).vertexCount).toBe(12 * 3 * 4 * 3)
  })

  test('detail ≥ 1: ALL vertices on the sphere of the given radius (geodesic projection)', () => {
    for (const g of [
      tetrahedron({ radius: 1.3, detail: 1 }),
      octahedron({ radius: 1.3, detail: 2 }),
      icosahedron({ radius: 1.3, detail: 2 }),
      dodecahedron({ radius: 1.3, detail: 1 }),
    ]) {
      expectConsistent(g)
      expectNoDegenerate(g)
      expectWindingMatchesNormals(g)
      expectOutward(g)
      for (let i = 0; i < g.vertexCount; i++) {
        const d = Math.hypot(g.positions[i * 3]!, g.positions[i * 3 + 1]!, g.positions[i * 3 + 2]!)
        expect(d).toBeCloseTo(1.3, 5)
      }
    }
  })

  test('detail = 0: dodecahedron — honest FLAT pentagons (coplanarity)', () => {
    const g = dodecahedron({ radius: 1 })
    expectConsistent(g)
    // every triple of face triangles is coplanar: the same normal
    for (let f = 0; f < 12; f++) {
      const base = f * 3 * 9
      const nx = g.normals[base]!, ny = g.normals[base + 1]!, nz = g.normals[base + 2]!
      for (let t = 1; t < 3; t++) {
        expect(g.normals[base + t * 9]!).toBeCloseTo(nx, 5)
        expect(g.normals[base + t * 9 + 1]!).toBeCloseTo(ny, 5)
        expect(g.normals[base + t * 9 + 2]!).toBeCloseTo(nz, 5)
      }
    }
  })

  test('UVs are continuous within a face with detail (barycentric interpolation)', () => {
    const g = dodecahedron({ detail: 1 })
    // within a single face a lattice point belongs to several subtriangles —
    // we check: the extreme UVs cover [0,1] and there are no NaNs
    let uMin = Infinity, uMax = -Infinity
    for (let i = 0; i < g.vertexCount; i++) {
      const u = g.uvs[i * 2]!, v = g.uvs[i * 2 + 1]!
      expect(Number.isNaN(u)).toBe(false)
      expect(Number.isNaN(v)).toBe(false)
      uMin = Math.min(uMin, u); uMax = Math.max(uMax, u)
    }
    expect(uMin).toBeCloseTo(0, 3)
    expect(uMax).toBeCloseTo(1, 3)
  })
})

// ─── Disk/ring (options-API) ──────────────────────────────────────────────

describe('prims — disk/ring', () => {
  test('disk: a CCW fan from above, count = segments·3', () => {
    const g = disk({ radius: 1.2, segments: 16 })
    expect(g.vertexCount).toBe(16 * 3)
    expectConsistent(g)
    expectFaceUp(g)
    expectNoDegenerate(g)
  })

  test('ring: strips, count = segments·6', () => {
    const g = ring({ innerRadius: 0.4, outerRadius: 0.9, segments: 12 })
    expect(g.vertexCount).toBe(12 * 6)
    expectConsistent(g)
    expectFaceUp(g)
    expectNoDegenerate(g)
  })
})

// ─── Superellipsoid removed (Task 109) ───────────────────────────────────

describe('prims — superellipsoids removed', () => {
  test('no superellipsoid in the public API', async () => {
    const mod = await import('../src/index.ts')
    expect('superellipsoid' in mod).toBe(false)
  })
})
