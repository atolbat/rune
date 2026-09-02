/**
 * binary.ts — buffer parsing primitives: DataView-reader, ASCII scanner,
 * fast parseFloat from bytes (without substring allocations).
 *
 * The principle is "parse with buffers, not text": all token boundaries are
 * found by byte codes (charCode), numbers are assembled digit by digit into
 * a number. Strings (names/word values) are materialized only where
 * unavoidable (JSON keys, node names) — via a Latin-1 decoder, once.
 */

/** Reader over a Uint8Array with a cursor; all reads are little-endian by default. */
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
    // The FBX/GLB range is far below 2^53 — safe.
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

  /** Reads N bytes as a subarray (copy). */
  raw(length: number): Uint8Array {
    const out = this.bytes.subarray(this.pos, this.pos + length)
    this.pos += length
    return out
  }

  /** ASCII/UTF-8 string of the given length. */
  str(length: number): string {
    const out = latin1(this.bytes, this.pos, length)
    this.pos += length
    return out
  }

  /** Skip to a boundary alignment (GLB is 4-byte). */
  align(boundary: number): void {
    const rem = this.pos % boundary
    if (rem !== 0) this.pos += boundary - rem
  }

  skip(n: number): void {
    this.pos += n
  }
}

/** Latin-1 (byte) string — for magics, names, binary headers. */
export function latin1(bytes: Uint8Array, start: number, length: number): string {
  // String.fromCharCode.apply in chunks of 8192 — fast and without stack overflow.
  let out = ''
  const CHUNK = 8192
  for (let at = start; at < start + length; at += CHUNK) {
    const end = Math.min(at + CHUNK, start + length)
    out += String.fromCharCode(...bytes.subarray(at, end))
  }
  return out
}

// ─── ASCII scanner over bytes ─────────────────────────────────────────────────

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
 * Fast parseFloat from bytes [start, end): digits, sign, dot, exponent.
 * Returns NaN on empty/garbage input. Allocates a substring ONLY for the
 * exponent (a rare case in 3D data); regular numbers are handled digit by digit.
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
 * Tokenizer for OBJ/config lines directly over bytes: finds "word"
 * boundaries (by whitespace), returns [start, end) pairs without allocations.
 */
export class AsciiTokenScanner {
  pos = 0

  constructor(readonly bytes: Uint8Array, readonly length = bytes.length) {}

  /** Next token as a [start, end) range; null at the end. */
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

  /** Token as a string (copy; for keys). */
  nextWord(): string | null {
    const token = this.nextToken()
    return token === null ? null : latin1(this.bytes, token[0], token[1] - token[0])
  }

  /** Token as a number (NaN if not a number). */
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

/** Inflate zlib via DecompressionStream (FBX arrays, encoding=1). */
export async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream unavailable — binary FBX with zlib compression is not supported in this environment')
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
