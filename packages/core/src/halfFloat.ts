/**
 * Полу-плавающие (float16, binary16 IEEE 754) — кодек битов (Task 112).
 *
 * Зачем в ядре: WebGL2 требует HALF_FLOAT-ДАННЫЕ для загрузок в 16F-текстуры
 * (пара (RGBA, HALF_FLOAT) — ES 3.0 Table 3.2), WebGPU пишет rgba16float
 * теми же битами через writeTexture. Демо FFT-океана несло свою копию
 * конвертера — теперь это библиотечная утилита (паттерн «полезное из FFT —
 * в ядро»,.Task 112).
 *
 * Алгоритм — канонический round-to-nearest-even битовый конвертер;
 * корректно обрабатывает нули (±0), денормалы, бесконечности и NaN.
 */

/** Float32 → биты half-float (uint16). */
export function floatToHalfBits(value: number): number {
  const f32 = new Float32Array(1)
  const i32 = new Int32Array(f32.buffer)
  f32[0] = value
  const x = i32[0]

  let bits = (x >> 16) & 0x8000
  let m = (x >> 12) & 0x07ff
  const e = (x >> 23) & 0xff

  if (e < 103) return bits // |x| < 2^-14 → ±0 (денормал при e=103)
  if (e > 142) {
    // Переполнение → ±inf; Inf/NaN (e=255) — честная IEEE-семантика:
    // Inf остаётся Inf (мантисса 0), NaN сохраняет мантиссу (≠0 → NaN).
    // (Отличие от копии демо: там NaN молча становился +inf — для
    // библиотечного кодека это чиним; данных NaN в спектрах океана нет.)
    if (e === 0xff) {
      // Inf (мантисса f32 = 0) остаётся Inf; NaN (мантисса ≠ 0) — NaN:
      // верхние 10 бит мантиссы f32 → мантисса half; если верх нулевой
      // (NaN живёт только в младших битах) — тихий NaN-бит 0x0200.
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
    // денормал half: неявная единица мантиссы + сдвиг
    m |= 0x0800
    bits |= (m >> (114 - e)) + ((m >> (113 - e)) & 1)
    return bits
  }
  bits |= ((e - 112) << 10) | (m >> 1)
  bits += m & 1 // round-to-nearest-even
  return bits
}

/** Биты half-float (uint16) → Float32. */
export function halfBitsToFloat(bits: number): number {
  const s = (bits & 0x8000) >> 15
  const e = (bits & 0x7c00) >> 10
  const m = bits & 0x03ff

  let out: number
  if (e === 0) {
    out = m === 0 ? 0 : Math.pow(2, -24) * m // ноль или денормал
  } else if (e === 0x1f) {
    out = m === 0 ? Infinity : NaN
  } else {
    out = Math.pow(2, e - 15) * (1 + m / 1024)
  }
  return s === 1 ? -out : out
}

/** Массив Float32 → биты half-float (поканально, длина сохраняется). */
export function float32ToHalf16(values: Float32Array): Uint16Array {
  const out = new Uint16Array(values.length)
  for (let i = 0; i < values.length; i++) {
    out[i] = floatToHalfBits(values[i])
  }
  return out
}

/** Биты half-float → массив Float32 (длина сохраняется). */
export function half16ToFloat32(bits: Uint16Array): Float32Array {
  const out = new Float32Array(bits.length)
  for (let i = 0; i < bits.length; i++) {
    out[i] = halfBitsToFloat(bits[i])
  }
  return out
}
