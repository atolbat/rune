/**
 * pose.ts — hierarchy evaluation: local TRS → world → skin palette.
 *
 * Joints are parents-first, so ONE forward pass suffices: world[i] is
 * finished before any child can read it — no topological re-walk, no
 * recursion, no per-frame allocations.
 *
 * The hot kernels (composeTRS, mul4) are offset-based: they read and
 * write the pose's flat SoA buffers directly. The formulas and the float
 * operation ORDER mirror @rune/math exactly (mat4FromQuatPosScale,
 * mat4Multiply) — the parity is pinned by tests, so the numbers are
 * bit-for-bit what the math package would produce.
 */
import type { SkeletonPose } from './skeleton.ts'

/**
 * Evaluates the pose: for every joint (parents-first) —
 *   world[i]   = TRS(localT, localQ, localS)
 *   world[i]   = world[parent] × world[i]        (root joints skip this)
 *   palette[i] = world[i] × invBind[i]
 * The palette is the upload-ready skin matrix array (16 floats per joint,
 * column-major — u_bones on both backends).
 */
export function evaluateSkeleton(pose: SkeletonPose): void {
  const { localT, localQ, localS, world, palette, parents, invBind, jointCount: n } = pose
  for (let i = 0; i < n; i++) {
    const w = i * 16
    composeTRS(world, w, localT, i * 3, localQ, i * 4, localS, i * 3)
    const p = parents[i]
    if (p >= 0) {
      mul4(world, w, world, p * 16, world, w)
    }
    mul4(palette, w, world, w, invBind, w)
  }
}

/**
 * composeTRS(out, o, t, to, q, qo, s, so) — writes the column-major
 * T·R·S matrix at out[o..o+16). Same expression order as @rune/math
 * mat4FromQuatPosScale: scale folded into the rotation's columns,
 * translation into the fourth column.
 */
function composeTRS(
  out: Float32Array,
  o: number,
  t: Float32Array,
  to: number,
  q: Float32Array,
  qo: number,
  s: Float32Array,
  so: number,
): void {
  const x = q[qo]
  const y = q[qo + 1]
  const z = q[qo + 2]
  const w = q[qo + 3]
  const sx = s[so]
  const sy = s[so + 1]
  const sz = s[so + 2]
  const x2 = x + x
  const y2 = y + y
  const z2 = z + z
  const xx = x * x2
  const xy = x * y2
  const xz = x * z2
  const yy = y * y2
  const yz = y * z2
  const zz = z * z2
  const wx = w * x2
  const wy = w * y2
  const wz = w * z2

  out[o] = (1 - (yy + zz)) * sx
  out[o + 1] = (xy + wz) * sx
  out[o + 2] = (xz - wy) * sx
  out[o + 3] = 0
  out[o + 4] = (xy - wz) * sy
  out[o + 5] = (1 - (xx + zz)) * sy
  out[o + 6] = (yz + wx) * sy
  out[o + 7] = 0
  out[o + 8] = (xz + wy) * sz
  out[o + 9] = (yz - wx) * sz
  out[o + 10] = (1 - (xx + yy)) * sz
  out[o + 11] = 0
  out[o + 12] = t[to]
  out[o + 13] = t[to + 1]
  out[o + 14] = t[to + 2]
  out[o + 15] = 1
}

/**
 * mul4(out, o, a, ao, b, bo) — the column-major product a·b written at
 * out[o..o+16). Same accumulation order as @rune/math mat4Multiply.
 *
 * Aliasing contract (the same analysis as mat4Multiply, offset edition):
 * `a` is read across ALL columns while out is written column by column —
 * a must not overlap out. `b` is read strictly before its own column is
 * written — b MAY overlap out exactly. evaluateSkeleton exploits this:
 * world[i] = world[parent] × world[i] is a single in-place multiply,
 * the parent's region never overlaps the child's (parents-first).
 */
function mul4(
  out: Float32Array,
  o: number,
  a: Float32Array,
  ao: number,
  b: Float32Array,
  bo: number,
): void {
  for (let col = 0; col < 4; col++) {
    const bc = bo + col * 4
    const b0 = b[bc]
    const b1 = b[bc + 1]
    const b2 = b[bc + 2]
    const b3 = b[bc + 3]
    const oc = o + col * 4
    out[oc] = a[ao] * b0 + a[ao + 4] * b1 + a[ao + 8] * b2 + a[ao + 12] * b3
    out[oc + 1] = a[ao + 1] * b0 + a[ao + 5] * b1 + a[ao + 9] * b2 + a[ao + 13] * b3
    out[oc + 2] = a[ao + 2] * b0 + a[ao + 6] * b1 + a[ao + 10] * b2 + a[ao + 14] * b3
    out[oc + 3] = a[ao + 3] * b0 + a[ao + 7] * b1 + a[ao + 11] * b2 + a[ao + 15] * b3
  }
}
