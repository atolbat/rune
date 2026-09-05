/**
 * frustum.ts — the view-projection frustum as pure data (Task 141).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY HERE: the Gribb–Hartmann plane extraction was written TWICE in this
 * repo — @rune/scene's frustum.ts (Task 81, the culling walk) and
 * @rune/particles' gpuRenderFrustum (Task 134, the GPU render tier's cull
 * gate) — the same six planes, the same normalization, two homes. The
 * frustum-from-a-matrix is an abstract, consumer-agnostic entity: a scene
 * graph culls subtrees with it, a particle packer skips off-screen sprites
 * with it, a GPU shader walks its planes against a conservative sphere.
 * One contract, one home — this module. The consumers keep their public
 * names as thin re-exports (the Task 133 noise precedent).
 *
 * THE EXTRACTION (Gribb–Hartmann): the six planes of a view-projection are
 * the sums/differences of the matrix's clip rows — row3 ± row_i. The plane
 * (n.xyz, d) is NORMALIZED (|n| = 1) so the sphere test dot(n, c) + d
 * carries a real radius in world units. Column-major, the GL clip z∈[−1,1]
 * convention; on WebGPU's [0,1] z the near/far pair is CONSERVATIVE (a
 * clipped particle may survive the test — the rasterizer clips it anyway;
 * no visible particle is ever culled).
 *
 * PLANE ORDER: +x, −x, +y, −y, +z, −z (left, right, bottom, top, near,
 * far) — plane p lives at floats [p·4, p·4+3]. @rune/scene's PLANE_LEFT..
 * PLANE_FAR index constants name the same order.
 *
 * THE SPHERE TESTS: a sphere is fully OUTSIDE ⟺ dot(n, c) + d < −r for
 * ANY plane (the p-vertex form, fgiesen.wordpress.com "Frustum culling
 * tips"); fully INSIDE all six ⟺ dot ≥ +r — a trivial accept for whole
 * subtrees. `sphereOutsideFrustum` is the fast boolean form (the particle
 * bakers' skip gate); `classifySphere` is the 3-way form (the hierarchical
 * culler). Both walk the planes in the SAME order with the SAME arithmetic
 * shape — bit-identical verdicts across every consumer, CPU and GPU (the
 * WGSL/GLSL twins mirror the boolean form exactly).
 *
 * DOM-free by construction — like all of @rune/core.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** The sphere is fully outside at least one plane (the cull verdict). */
export const SPHERE_OUTSIDE = 0
/** The sphere crosses a plane boundary (the conservative verdict). */
export const SPHERE_INTERSECT = 1
/** The sphere is fully inside all six planes (the trivial accept). */
export const SPHERE_INSIDE = 2

/** The frustum plane count (the 24-float layout's stride basis). */
export const FRUSTUM_PLANE_COUNT = 6

/**
 * Extracts the six normalized frustum planes from a COLUMN-MAJOR
 * view-projection. Writes `out` (24 floats: p·4 + 0..3 = n.xyz, d) when
 * given — the callers pass their per-frame scratch (the zero-allocation
 * hot-path contract) — and returns it; without `out` a fresh Float32Array
 * is allocated (the cold path). A degenerate plane (a zero normal — a
 * broken matrix, not a camera) writes ZEROS, never NaN: the verdict
 * degrades to "inside" (the conservative direction), loud at the source
 * where the matrix came from.
 */
export function frustumPlanes(viewProj: ArrayLike<number>, out?: Float32Array): Float32Array {
  if (viewProj.length !== 16) {
    throw new Error(`rune/core: frustumPlanes — the view-projection is 16 numbers, column-major (got ${viewProj.length})`)
  }
  const o = out ?? new Float32Array(24)
  for (let p = 0; p < 6; p++) {
    const axis = p >> 1                  // the row the plane cuts: 0 = x, 1 = y, 2 = z
    const sign = (p & 1) === 0 ? 1 : -1  // the + plane, then the − plane
    const nx = viewProj[3] + sign * viewProj[axis]
    const ny = viewProj[7] + sign * viewProj[4 + axis]
    const nz = viewProj[11] + sign * viewProj[8 + axis]
    const d = viewProj[15] + sign * viewProj[12 + axis]
    const len = Math.hypot(nx, ny, nz)
    const inv = len > 1e-12 ? 1 / len : 0
    o[p * 4] = nx * inv
    o[p * 4 + 1] = ny * inv
    o[p * 4 + 2] = nz * inv
    o[p * 4 + 3] = d * inv
  }
  return o
}

/**
 * The 3-way sphere classification: OUTSIDE / INTERSECT / INSIDE. The walk
 * early-returns OUTSIDE on the first failing plane (the common case for a
 * culled subtree costs one dot product); INTERSECT and INSIDE differ only
 * in the trivial-accept bookkeeping (every plane's |distance| ≥ r).
 */
export function classifySphere(
  planes: ArrayLike<number>,
  cx: number, cy: number, cz: number, radius: number,
): number {
  let insideAll = true
  for (let i = 0; i < 6; i++) {
    const o = i * 4
    const d = planes[o] * cx + planes[o + 1] * cy + planes[o + 2] * cz + planes[o + 3]
    if (d < -radius) return SPHERE_OUTSIDE
    if (d < radius) insideAll = false
  }
  return insideAll ? SPHERE_INSIDE : SPHERE_INTERSECT
}

/**
 * The fast boolean gate — TRUE ⟺ the sphere is fully outside any plane
 * (the skip verdict: `if (sphereOutsideFrustum(...)) continue`). The exact
 * arithmetic of the GPU render tier's shader test (dot(n, p) + d ≤ −r),
 * mirrored CPU-side — the parity contract: the same particle survives both
 * tiers, the same subtree survives both cullers. The boundary form is ≤
 * (the bakers'/shaders' mirror); classifySphere uses the strict < of the
 * hierarchical culler — the exact-boundary sphere reads INTERSECT there,
 * outside here, both conservative directions.
 */
export function sphereOutsideFrustum(
  planes: ArrayLike<number>,
  cx: number, cy: number, cz: number, radius: number,
): boolean {
  for (let i = 0; i < 6; i++) {
    const o = i * 4
    if (planes[o] * cx + planes[o + 1] * cy + planes[o + 2] * cz + planes[o + 3] <= -radius) {
      return true
    }
  }
  return false
}
