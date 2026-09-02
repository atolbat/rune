/**
 * Common geometry type of @rune/prims: parallel attributes, triangle soup
 * (no index — count = vertices; compatible with renderer.command attributes).
 *
 * Package conventions:
 *   • CCW triangle winding when viewed from outside (front face);
 *   • normals are unit-length, 1 ± 1e-5 (analytical or central differences —
 *     NOT face averaging, except for flat-shaded solids);
 *   • UV — [0,1]² for parametric surfaces; for terrain v = NORMALIZED
 *     HEIGHT (the shader colors by height: water → sand → grass → rocks →
 *     snow);
 *   • quad (clip space) and cube have their own legacy interfaces —
 *     structurally compatible with Geometry.
 */

/** Attribute set of triangle-soup geometry. */
export interface Geometry {
  readonly positions: Float32Array
  readonly normals: Float32Array
  readonly uvs: Float32Array
  readonly vertexCount: number
}

/** Number of triangles (triangle soup: vertices/3). */
export function triangles(g: Geometry): number {
  return g.vertexCount / 3
}

/** Approximate attribute size in bytes (demo info: "how much it weighs"). */
export function geometryBytes(g: Geometry): number {
  return g.positions.byteLength + g.normals.byteLength + g.uvs.byteLength
}

/** In-place vector normalization (returns the length BEFORE normalization). */
export function normalizeInPlace(v: Float32Array | number[], at: number): number {
  const x = v[at] as number
  const y = v[at + 1] as number
  const z = v[at + 2] as number
  const len = Math.hypot(x, y, z)
  if (len > 1e-12) {
    v[at] = x / len
    v[at + 1] = y / len
    v[at + 2] = z / len
  }
  return len
}
