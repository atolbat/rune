/**
 * Half-floats (float16, binary16 IEEE 754) — a bit codec (Task 112).
 *
 * Why in core: WebGL2 requires HALF_FLOAT DATA for uploads into 16F textures
 * (the (RGBA, HALF_FLOAT) pair — ES 3.0 Table 3.2), WebGPU writes rgba16float
 * with the same bits via writeTexture. The FFT-ocean demo carried its own copy of
 * the converter — now it is a library utility (the "useful bits of FFT —
 * into core" pattern, Task 112).
 *
 * The algorithm — a canonical round-to-nearest-even bit converter;
 * it correctly handles zeros (±0), denormals, infinities and NaN.
 */

/** Float32 → half-float bits (uint16). */
export function floatToHalfBits(value: number): number {
  const f32 = new Float32Array(1)
  const i32 = new Int32Array(f32.buffer)
  f32[0] = value
  const x = i32[0]

  let bits = (x >> 16) & 0x8000
  let m = (x >> 12) & 0x07ff
  const e = (x >> 23) & 0xff

  if (e < 103) return bits // |x| < 2^-14 → ±0 (denormal at e=103)
  if (e > 142) {
    // Overflow → ±inf; Inf/NaN (e=255) — honest IEEE semantics:
    // Inf stays Inf (mantissa 0), NaN keeps the mantissa (≠0 → NaN).
    // (Difference from the demo copy: there NaN silently became +inf — for
    // a library codec we fix this; there are no NaN in ocean spectra.)
    if (e === 0xff) {
      // Inf (f32 mantissa = 0) stays Inf; NaN (mantissa ≠ 0) — NaN:
      // the top 10 bits of the f32 mantissa → the half mantissa; if the top is zero
      // (NaN lives only in the low bits) — the quiet NaN bit 0x0200.
      const fullMantissa = x & 0x007fffff
      if (fullMantissa !== 0) {
        const top = (x >> 13) & 0x03ff
        bits |= 0x7c00 | (top !== 0 ? top : 0x0200)
      } else {
        bits |= 0x7c00 // ±Inf
      }
    } else {
      bits |= 0x7c00
    }
    return bits
  }
  if (e < 113) {
    // half denormal: implicit mantissa unit + shift
    m |= 0x0800
    bits |= (m >> (114 - e)) + ((m >> (113 - e)) & 1)
    return bits
  }
  bits |= ((e - 112) << 10) | (m >> 1)
  bits += m & 1 // round-to-nearest-even
  return bits
}

/** Half-float bits (uint16) → Float32. */
export function halfBitsToFloat(bits: number): number {
  const s = (bits & 0x8000) >> 15
  const e = (bits & 0x7c00) >> 10
  const m = bits & 0x03ff

  let out: number
  if (e === 0) {
    out = m === 0 ? 0 : Math.pow(2, -24) * m // zero or denormal
  } else if (e === 0x1f) {
    out = m === 0 ? Infinity : NaN
  } else {
    out = Math.pow(2, e - 15) * (1 + m / 1024)
  }
  return s === 1 ? -out : out
}

/** Float32 array → half-float bits (per channel, length preserved). */
export function float32ToHalf16(values: Float32Array): Uint16Array {
  const out = new Uint16Array(values.length)
  for (let i = 0; i < values.length; i++) {
    out[i] = floatToHalfBits(values[i])
  }
  return out
}

/** Half-float bits → Float32 array (length preserved). */
export function half16ToFloat32(bits: Uint16Array): Float32Array {
  const out = new Float32Array(bits.length)
  for (let i = 0; i < bits.length; i++) {
    out[i] = halfBitsToFloat(bits[i])
  }
  return out
}
