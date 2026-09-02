/**
 * 4×4 matrices, column-major (as in WebGL/WGSL): element[col*4 + row].
 * All functions write into out and return it; inputs are not mutated.
 */

/** Allocates a new 4×4 matrix and fills it with the identity (gl-matrix style). */
export function mat4Create(): Float32Array {
  return mat4Identity(new Float32Array(16))
}

/** Identity matrix. */
export function mat4Identity(out: Float32Array): Float32Array {
  out.fill(0)
  out[0] = out[5] = out[10] = out[15] = 1
  return out
}

/** Translation. */
export function mat4Translation(out: Float32Array, x: number, y: number, z: number): Float32Array {
  mat4Identity(out)
  out[12] = x
  out[13] = y
  out[14] = z
  return out
}

/** Perspective (OpenGL convention, looking down −Z). */
export function mat4Perspective(
  out: Float32Array,
  fovy: number,
  aspect: number,
  near: number,
  far: number,
): Float32Array {
  const f = 1 / Math.tan(fovy / 2)
  out.fill(0)
  out[0] = f / aspect
  out[5] = f
  out[10] = (far + near) / (near - far)
  out[11] = -1
  out[14] = (2 * far * near) / (near - far)
  return out
}

/** Rotation around X. */
export function mat4RotationX(out: Float32Array, angle: number): Float32Array {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  mat4Identity(out)
  out[5] = c
  out[6] = s
  out[9] = -s
  out[10] = c
  return out
}

/** Rotation around Y. */
export function mat4RotationY(out: Float32Array, angle: number): Float32Array {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  mat4Identity(out)
  out[0] = c
  out[2] = -s
  out[8] = s
  out[10] = c
  return out
}

/** Product out = a · b (column-major). Aliasing is safe:
 *  out === a and out === b yield the result of a separate out (the "hypercube"
 *  REGRESSION: the demo wrote the product into the very first operand). */
export function mat4Multiply(out: Float32Array, a: Float32Array, b: Float32Array): Float32Array {
  // a is read across all columns while out is written column by column:
  // with out === a the input would be clobbered on the first write. b is read
  // strictly before its own column is written — aliasing with b is safe without a copy.
  // out === a — the 16 inputs are hoisted into locals (gl-matrix style):
  // no Float32Array copy on the aliased path.
  const a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3]
  const a4 = a[4], a5 = a[5], a6 = a[6], a7 = a[7]
  const a8 = a[8], a9 = a[9], a10 = a[10], a11 = a[11]
  const a12 = a[12], a13 = a[13], a14 = a[14], a15 = a[15]
  for (let col = 0; col < 4; col++) {
    const b0 = b[col * 4]
    const b1 = b[col * 4 + 1]
    const b2 = b[col * 4 + 2]
    const b3 = b[col * 4 + 3]
    out[col * 4] = a0 * b0 + a4 * b1 + a8 * b2 + a12 * b3
    out[col * 4 + 1] = a1 * b0 + a5 * b1 + a9 * b2 + a13 * b3
    out[col * 4 + 2] = a2 * b0 + a6 * b1 + a10 * b2 + a14 * b3
    out[col * 4 + 3] = a3 * b0 + a7 * b1 + a11 * b2 + a15 * b3
  }
  return out
}
