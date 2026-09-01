/**
 * half.ts — конвертация float32 ⇄ half-float (f16, биты) для загрузок в
 * rgba16float-текстуры и readback-диагностики.
 *
 * Зачем в библиотеке: единственный честный путь положить CPU-данные в
 * HALF_FLOAT-текстуру WebGL2 и в writeTexture rgba16float WebGPU —
 * упаковать биты заранее. До сих пор каждый потребитель носил свою копию
 * побитовой магии (демо FFT-океана — вторая известная копия), а отладочные
 * дампы половинок ловили классический баг «потерян знаковый бит».
 *
 * Контракт:
 *  - floatToHalfBits: IEEE-754 binary16 c округлением к ближайшему;
 *    ±0 сохраняет знак; |x| > 65504 → ±Inf. Известная особенность
 *    классического сниппета (three.js/DataUtils и исходная копия демо):
 *    NaN → +Inf — поведение сохранено ради побитового паритета с
 *    проверенной версией и зафиксировано тестом.
 *  - halfBitsToFloat: точное обратное преобразование (субнормали, Inf,
 *    NaN, знак) — для юнит-тестов и диагностики readback.
 *  - floatsToHalfBits: покомпонентная упаковка со stride (RGBA-инливинг).
 *  - halfBitsToFloats: обратная распаковка.
 *
 * DOM-free по построению — как весь @rune/core.
 */

/** Float32 → биты binary16 (значение как uint16). */
export function floatToHalfBits(value: number): number {
  const f32 = new Float32Array(1)
  const i32 = new Int32Array(f32.buffer)
  f32[0] = value
  const x = i32[0]

  let bits = (x >> 16) & 0x8000
  let m = (x >> 12) & 0x07ff
  const e = (x >> 23) & 0xff

  if (e < 103) return bits // субнормальная зона → ноль со знаком
  if (e > 142) {
    bits |= 0x7c00 // Inf
    bits |= (e === 0xff ? 0 : 1) && x & 0x007fffff // NaN сохраняет мантиссу
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

/** Биты binary16 → float32 (точное обратное; знак, субнормали, Inf/NaN). */
export function halfBitsToFloat(bits: number): number {
  const sign = bits & 0x8000
  const exponent = (bits & 0x7c00) >>> 10
  const mantissa = bits & 0x03ff
  let value: number
  if (exponent === 0) {
    // Ноль и субнормали: m · 2^(-24).
    value = mantissa * Math.pow(2, -24)
  } else if (exponent === 0x1f) {
    value = mantissa === 0 ? Number.POSITIVE_INFINITY : Number.NaN
  } else {
    value = (1 + mantissa / 1024) * Math.pow(2, exponent - 15)
  }
  return sign === 0 ? value : -value
}

/**
 * Упаковка массива float32 в биты half-float.
 * @param values входные данные.
 * @param stride шаг покомпонентной упаковки (4 = RGBA-инливинг: каналы,
 *        которых нет во входе, остаются нулями). По умолчанию 1 — плотный
 *        покомпонентный перевод.
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
  // Каналы вне компонент значения (частичные группы) уже 0 —
  // floatToHalfBits(0) = 0.
  return out
}

/** Распаковка битов half-float в float32 (обратная к floatsToHalfBits). */
export function halfBitsToFloats(bits: Uint16Array): Float32Array {
  const out = new Float32Array(bits.length)
  for (let i = 0; i < bits.length; i++) out[i] = halfBitsToFloat(bits[i])
  return out
}
