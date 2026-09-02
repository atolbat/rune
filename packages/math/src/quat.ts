/**
 * Quaternions (x, y, z, w), Hamilton product — like gl-matrix.
 * All functions write into out and return it; inputs are not mutated.
 * Rotation convention — right-handed triple, a positive angle is counterclockwise
 * when viewed from the end of the axis (the same as mat4RotationX/Y in mat4.ts).
 */

/** Allocates an identity quaternion. */
export function quatCreate(): Float32Array {
  const out = new Float32Array(4)
  out[3] = 1
  return out
}

/** Identity quaternion (no rotation). */
export function quatIdentity(out: Float32Array): Float32Array {
  out[0] = 0
  out[1] = 0
  out[2] = 0
  out[3] = 1
  return out
}

/** Normalization (_len²=0 → identity, no NaN). */
export function quatNormalize(out: Float32Array, q: Float32Array): Float32Array {
  const x = q[0], y = q[1], z = q[2], w = q[3]
  const len = Math.sqrt(x * x + y * y + z * z + w * w)
  if (len < 1e-12) return quatIdentity(out)
  const inv = 1 / len
  out[0] = x * inv
  out[1] = y * inv
  out[2] = z * inv
  out[3] = w * inv
  return out
}

/** out = a · b (applies b, then a — like the matrix composition a·b). */
export function quatMultiply(out: Float32Array, a: Float32Array, b: Float32Array): Float32Array {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3]
  const bx = b[0], by = b[1], bz = b[2], bw = b[3]
  out[0] = ax * bw + aw * bx + ay * bz - az * by
  out[1] = ay * bw + aw * by + az * bx - ax * bz
  out[2] = az * bw + aw * bz + ax * by - ay * bx
  out[3] = aw * bw - ax * bx - ay * by - az * bz
  return out
}

/** Rotation around an axis (normalized from the input values). */
export function quatAxisAngle(
  out: Float32Array,
  x: number, y: number, z: number,
  angle: number,
): Float32Array {
  let len = Math.sqrt(x * x + y * y + z * z)
  if (len < 1e-12) return quatIdentity(out)
  len = 1 / len
  const half = angle / 2
  const s = Math.sin(half)
  out[0] = x * len * s
  out[1] = y * len * s
  out[2] = z * len * s
  out[3] = Math.cos(half)
  return out
}

/** YXZ Euler angles (yaw-Y, pitch-X, roll-Z) — the FPS/orbit camera convention:
 *  rotate first around Y, then around the LOCAL X, then the local Z. */
export function quatFromEulerYXZ(
  out: Float32Array,
  yawY: number, pitchX: number, rollZ: number,
): Float32Array {
  const cy = Math.cos(yawY / 2), sy = Math.sin(yawY / 2)
  const cp = Math.cos(pitchX / 2), sp = Math.sin(pitchX / 2)
  const cr = Math.cos(rollZ / 2), sr = Math.sin(rollZ / 2)
  // q = qY · qX · qZ (derived by expanding the Hamilton product)
  out[0] = cy * sp * cr + sy * cp * sr
  out[1] = sy * cp * cr - cy * sp * sr
  out[2] = cy * cp * sr - sy * sp * cr
  out[3] = cy * cp * cr + sy * sp * sr
  return out
}

/** Spherical interpolation (the shortest arc). */
export function quatSlerp(out: Float32Array, a: Float32Array, b: Float32Array, t: number): Float32Array {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3]
  let bx = b[0], by = b[1], bz = b[2], bw = b[3]
  let cosTheta = ax * bx + ay * by + az * bz + aw * bw
  if (cosTheta < 0) {
    bx = -bx; by = -by; bz = -bz; bw = -bw
    cosTheta = -cosTheta
  }
  let s0: number, s1: number
  if (cosTheta > 0.9995) {
    // Close — linear interpolation + normalization.
    s0 = 1 - t
    s1 = t
  } else {
    const theta = Math.acos(cosTheta)
    const sinTheta = Math.sin(theta)
    s0 = Math.sin((1 - t) * theta) / sinTheta
    s1 = Math.sin(t * theta) / sinTheta
  }
  out[0] = ax * s0 + bx * s1
  out[1] = ay * s0 + by * s1
  out[2] = az * s0 + bz * s1
  out[3] = aw * s0 + bw * s1
  return quatNormalize(out, out)
}
