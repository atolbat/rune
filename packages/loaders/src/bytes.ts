/**
 * Byte utilities for the streaming parsers of @rune/loaders.
 *
 * All text formats (OBJ/MTL/ZML/INI, GLB/FBX headers) are parsed
 * directly from Uint8Array — WITHOUT decoding the whole file into a string.
 * Reason: loaders work in streaming mode (a chunk may arrive partially),
 * and String.fromCharCode on gigabyte buffers wrecks frame latency.
 *
 * Module contract: pure functions over Uint8Array, zero dependencies.
 */

/** Character codes used by the parsers (no magic numbers in code). */
export const CHAR = {
  CR: 13,
  LF: 10,
  SPACE: 32,
  TAB: 9,
  HASH: 35,
  SLASH: 47,
  MINUS: 45,
  PLUS: 43,
  DOT: 46,
  EXP_E: 101,
  EXP_EU: 69,
  DIGIT_0: 48,
  DIGIT_9: 57,
} as const

/** Whitespace character for line-based formats (SPACE/TAB/CR/LF). */
export function isWhitespace(byte: number): boolean {
  return byte === CHAR.SPACE || byte === CHAR.TAB || byte === CHAR.CR || byte === CHAR.LF
}

/**
 * Decodes an ASCII substring [start, start+length) into a JS string.
 * In chunks of 8 KB so String.fromCharCode does not overflow the stack.
 * Used for headers (glTF/BIN/FBX-magic) and short format tokens
 * (node names, OBJ/MTL keywords).
 */
export function asciiDecode(bytes: Uint8Array, start: number, length: number): string {
  let out = ''
  const CHUNK = 8192
  for (let at = start; at < start + length; at += CHUNK) {
    const end = Math.min(at + CHUNK, start + length)
    out += String.fromCharCode(...bytes.subarray(at, end))
  }
  return out
}

/**
 * Fast decimal number parsing from bytes [start, end).
 *
 * A hand-written implementation instead of parseFloat(asciiDecode(...)):
 * does not allocate a string, stops at the first non-numeric byte, returns
 * NaN if there are no digits at all. Supports sign, fractional part and
 * exponent (including "1e-5"). The precision range is the same as Number,
 * since the mantissa is assembled into an integer up to 2^53.
 */
export function parseDecimal(bytes: Uint8Array, start: number, end: number): number {
  if (start >= end) return NaN
  let at = start
  let negative = false
  const first = bytes[at]
  if (first === CHAR.MINUS) {
    negative = true
    at++
  } else if (first === CHAR.PLUS) {
    at++
  }
  let intPart = 0
  let fracDigits = 0
  let fracCount = 0
  let expDigits = 0
  let expSign = 1
  let sawDigit = false
  let sawDot = false
  let sawExp = false
  for (; at < end; at++) {
    const b = bytes[at]
    if (b >= CHAR.DIGIT_0 && b <= CHAR.DIGIT_9) {
      sawDigit = true
      if (sawExp) {
        expDigits = expDigits * 10 + (b - CHAR.DIGIT_0)
      } else if (sawDot) {
        fracDigits = fracDigits * 10 + (b - CHAR.DIGIT_0)
        fracCount++
      } else {
        intPart = intPart * 10 + (b - CHAR.DIGIT_0)
      }
    } else if (b === CHAR.DOT && !sawDot && !sawExp) {
      sawDot = true
    } else if ((b === CHAR.EXP_E || b === CHAR.EXP_EU) && !sawExp && sawDigit) {
      sawExp = true
      if (at + 1 < end && (bytes[at + 1] === CHAR.MINUS || bytes[at + 1] === CHAR.PLUS)) {
        if (bytes[at + 1] === CHAR.MINUS) expSign = -1
        at++
      }
    } else {
      break
    }
  }
  if (!sawDigit) return NaN
  let value = intPart
  if (fracCount > 0) value += fracDigits / 10 ** fracCount
  const exponent = expSign * expDigits
  if (exponent !== 0) value *= 10 ** exponent
  return negative ? -value : value
}

/** Rounds a GLB chunk length up to a 4-byte boundary. */
export function align4(n: number): number {
  const rest = n % 4
  return rest === 0 ? n : n + 4 - rest
}

/** performance.now() where available, otherwise Date.now() (Node/browser/Bun). */
export function nowMs(): number {
  return typeof performance < 'u' ? performance.now() : Date.now()
}

/** Clamps a value to the [min, max] range. */
export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}
