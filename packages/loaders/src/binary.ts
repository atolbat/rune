/**
 * binary.ts — буферные примитивы парсинга: DataView-reader, ASCII-сканер,
 * быстрый parseFloat из байтов (без аллокации подстрок).
 *
 * Принцип «парсить буферами, а не текстом»: все границы токенов ищутся
 * по кодам байтов (charCode), числа собираются поразрядно в number.
 * Строки (имена/значения-слова) материализуются только там, где без них
 * нельзя (ключи JSON, имена узлов) — через Latin-1 декодер один раз.
 */

/** Reader над Uint8Array с курсором; все чтения — little-endian по умолчанию. */
export class ByteReader {
  readonly view: DataView
  pos = 0

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  get remaining(): number {
    return this.bytes.byteLength - this.pos
  }

  u8(): number {
    return this.view.getUint8(this.pos++)
  }

  i8(): number {
    return this.view.getInt8(this.pos++)
  }

  u16(): number {
    const v = this.view.getUint16(this.pos, true)
    this.pos += 2
    return v
  }

  i16(): number {
    const v = this.view.getInt16(this.pos, true)
    this.pos += 2
    return v
  }

  u32(): number {
    const v = this.view.getUint32(this.pos, true)
    this.pos += 4
    return v
  }

  i32(): number {
    const v = this.view.getInt32(this.pos, true)
    this.pos += 4
    return v
  }

  u64(): number {
    const v = this.view.getBigUint64(this.pos, true)
    this.pos += 8
    // Диапазон FBX/GLB далёк от 2^53 — safe.
    return Number(v)
  }

  i64(): number {
    const v = this.view.getBigInt64(this.pos, true)
    this.pos += 8
    return Number(v)
  }

  f32(): number {
    const v = this.view.getFloat32(this.pos, true)
    this.pos += 4
    return v
  }

  f64(): number {
    const v = this.view.getFloat64(this.pos, true)
    this.pos += 8
    return v
  }

  /** Чтение N байт как подстрока (копия). */
  raw(length: number): Uint8Array {
    const out = this.bytes.subarray(this.pos, this.pos + length)
    this.pos += length
    return out
  }

  /** ASCII/UTF-8 строка длиной length. */
  str(length: number): string {
    const out = latin1(this.bytes, this.pos, length)
    this.pos += length
    return out
  }

  /** Пропустить до выравнивания boundary (GLB 4-байтовое). */
  align(boundary: number): void {
    const rem = this.pos % boundary
    if (rem !== 0) this.pos += boundary - rem
  }

  skip(n: number): void {
    this.pos += n
  }
}

/** Latin-1 (байтовая) строка — для магиков, имён, бинарных заголовков. */
export function latin1(bytes: Uint8Array, start: number, length: number): string {
  // String.fromCharCode.apply чанками по 8192 — быстро и без переполнения стека.
  let out = ''
  const CHUNK = 8192
  for (let at = start; at < start + length; at += CHUNK) {
    const end = Math.min(at + CHUNK, start + length)
    out += String.fromCharCode(...bytes.subarray(at, end))
  }
  return out
}

// ─── ASCII-сканер по байтам ─────────────────────────────────────────────────

export const BYTE = {
  CR: 13,
  LF: 10,
  SPACE: 32,
  TAB: 9,
  HASH: 35,   // '#'
  SLASH: 47,  // '/'
  MINUS: 45,  // '-'
  PLUS: 43,   // '+'
  DOT: 46,    // '.'
  EXP_E: 101, // 'e'
  EXP_EU: 69, // 'E'
  DIGIT_0: 48,
  DIGIT_9: 57,
} as const

export function isWhitespace(byte: number): boolean {
  return byte === BYTE.SPACE || byte === BYTE.TAB || byte === BYTE.CR || byte === BYTE.LF
}

export function isDigit(byte: number): boolean {
  return byte >= BYTE.DIGIT_0 && byte <= BYTE.DIGIT_9
}

/**
 * Быстрый parseFloat из байтов [start, end): цифры, знак, точка, экспонента.
 * Возвращает NaN при пустом/мусорном вводе. Выделяет подстроку ТОЛЬКО
 * для экспоненты (редкий случай в 3D-данных); обычные числа — поразрядно.
 */
export function parseByteFloat(bytes: Uint8Array, start: number, end: number): number {
  if (start >= end) return NaN
  let i = start
  let negative = false
  const first = bytes[i]
  if (first === BYTE.MINUS) {
    negative = true
    i++
  } else if (first === BYTE.PLUS) {
    i++
  }
  let mantissa = 0
  let fraction = 0
  let fractionDigits = 0
  let expSign = 1
  let exponent = 0
  let sawDigit = false
  let sawDot = false
  let sawExp = false
  for (; i < end; i++) {
    const b = bytes[i]
    if (b >= BYTE.DIGIT_0 && b <= BYTE.DIGIT_9) {
      sawDigit = true
      if (sawExp) {
        exponent = exponent * 10 + (b - BYTE.DIGIT_0)
      } else if (sawDot) {
        fraction = fraction * 10 + (b - BYTE.DIGIT_0)
        fractionDigits++
      } else {
        mantissa = mantissa * 10 + (b - BYTE.DIGIT_0)
      }
    } else if (b === BYTE.DOT && !sawDot && !sawExp) {
      sawDot = true
    } else if ((b === BYTE.EXP_E || b === BYTE.EXP_EU) && !sawExp && sawDigit) {
      sawExp = true
      if (i + 1 < end && (bytes[i + 1] === BYTE.MINUS || bytes[i + 1] === BYTE.PLUS)) {
        if (bytes[i + 1] === BYTE.MINUS) expSign = -1
        i++
      }
    } else {
      break
    }
  }
  if (!sawDigit) return NaN
  let value = mantissa
  if (fractionDigits > 0) value += fraction / 10 ** fractionDigits
  const exp = expSign * exponent
  if (exp !== 0) value *= 10 ** exp
  return negative ? -value : value
}

/**
 * Токенайзер строк OBJ/конфигов прямо по байтам: находит границы
 * «слова» (по whitespace), возвращает [start, end) пары без аллокаций.
 */
export class AsciiTokenScanner {
  pos = 0

  constructor(readonly bytes: Uint8Array, readonly length = bytes.length) {}

  /** Следующий токен как диапазон [start, end); null в конце. */
  nextToken(): [number, number] | null {
    let i = this.pos
    while (i < this.length && isWhitespace(this.bytes[i])) i++
    if (i >= this.length) {
      this.pos = i
      return null
    }
    const start = i
    while (i < this.length && !isWhitespace(this.bytes[i])) i++
    this.pos = i
    return [start, i]
  }

  /** Токен строкой (копия; для ключей). */
  nextWord(): string | null {
    const token = this.nextToken()
    return token === null ? null : latin1(this.bytes, token[0], token[1] - token[0])
  }

  /** Токен числом (NaN, если не число). */
  nextFloat(): number {
    const token = this.nextToken()
    return token === null ? NaN : parseByteFloat(this.bytes, token[0], token[1])
  }

  nextInt(): number {
    const token = this.nextToken()
    if (token === null) return NaN
    const v = parseByteFloat(this.bytes, token[0], token[1])
    return Number.isFinite(v) ? Math.trunc(v) : v
  }
}

/** Инфлейт zlib через DecompressionStream (FBX-массивы, encoding=1). */
export async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream недоступен — бинарный FBX с zlib-сжатием не поддерживается в этой среде')
  }
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'))
  const reader = stream.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (value !== undefined) {
      parts.push(value)
      total += value.byteLength
    }
    if (done) break
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.byteLength
  }
  return out
}
