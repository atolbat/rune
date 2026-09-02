/**
 * half.ts — float32 ⇄ half-float conversion (f16, bits) for uploads into
 * rgba16float textures and readback diagnostics.
 *
 * Why in the library: the only honest way to put CPU data into a
 * WebGL2 HALF_FLOAT texture and into WebGPU writeTexture rgba16float —
 * is to pack the bits in advance. Until now every consumer carried its own copy of
 * bit-twiddling magic (the FFT-ocean demo — the second known copy), and debug
 * half dumps kept hitting the classic "lost sign bit" bug.
 *
 * Contract:
 *  - floatToHalfBits: IEEE-754 binary16 with round-to-nearest;
 *    ±0 keeps the sign; |x| > 65504 → ±Inf. A known quirk
 *    of the classic snippet (three.js/DataUtils and the original demo copy):
 *    NaN → +Inf — the behavior is kept for bit-level parity with the
 *    proven version and is pinned by a test.
 *  - halfBitsToFloat: the exact inverse transform (subnormals, Inf,
 *    NaN, sign) — for unit tests and readback diagnostics.
 *  - floatsToHalfBits: per-component packing with stride (RGBA interleaving).
 *  - halfBitsToFloats: the inverse unpacking.
 *
 * DOM-free by construction — like all of @rune/core.
 */

/** Float32 → binary16 bits (the value as uint16). */
export function floatToHalfBits(value: number): number {
  const f32 = new Float32Array(1)
  const i32 = new Int32Array(f32.buffer)
  f32[0] = value
  const x = i32[0]

  let bits = (x >> 16) & 0x8000
  let m = (x >> 12) & 0x07ff
  const e = (x >> 23) & 0xff

  if (e < 103) return bits // subnormal zone → signed zero
  if (e > 142) {
    bits |= 0x7c00 // Inf
    bits |= (e === 0xff ? 0 : 1) && x & 0x007fffff // NaN keeps the mantissa
    return bits
  }
  if (e < 113) {
    m |= 0x0800
    bits |= (m >> (114 - e)) + ((m >> (113 - e)) & 1)
    return bits
  }
  bits |= ((e - 112) << 10) | (m >> 1)
  bits += m & 1
  return bits
}

/** binary16 bits → float32 (the exact inverse; sign, subnormals, Inf/NaN). */
export function halfBitsToFloat(bits: number): number {
  const sign = bits & 0x8000
  const exponent = (bits & 0x7c00) >>> 10
  const mantissa = bits & 0x03ff
  let value: number
  if (exponent === 0) {
    // Zero and subnormals: m · 2^(-24).
    value = mantissa * Math.pow(2, -24)
  } else if (exponent === 0x1f) {
    value = mantissa === 0 ? Number.POSITIVE_INFINITY : Number.NaN
  } else {
    value = (1 + mantissa / 1024) * Math.pow(2, exponent - 15)
  }
  return sign === 0 ? value : -value
}

/**
 * Packs a float32 array into half-float bits.
 * @param values the input data.
 * @param stride the per-component packing step (4 = RGBA interleaving: channels
 *        absent from the input stay zero). Default 1 — a dense
 *        per-component conversion.
 */
export function floatsToHalfBits(values: Float32Array, stride = 1): Uint16Array {
  const out = new Uint16Array(values.length)
  if (stride === 1) {
    for (let i = 0; i < values.length; i++) out[i] = floatToHalfBits(values[i])
    return out
  }
  for (let i = 0; i < values.length; i += stride) {
    for (let c = 0; c < stride; c++) out[i + c] = floatToHalfBits(values[i + c])
  }
  // Channels outside the value's components (partial groups) are already 0 —
  // floatToHalfBits(0) = 0.
  return out
}

/** Unpacks half-float bits into float32 (the inverse of floatsToHalfBits). */
export function halfBitsToFloats(bits: Uint16Array): Float32Array {
  const out = new Float32Array(bits.length)
  for (let i = 0; i < bits.length; i++) out[i] = halfBitsToFloat(bits[i])
  return out
}
