/**
 * Байтовые утилиты для потоковых парсеров @rune/loaders.
 *
 * Все текстовые форматы (OBJ/MTL/ZML/INI, заголовки GLB/FBX) парсятся
 * напрямую из Uint8Array — БЕЗ декодирования всего файла в строку.
 * Причина: лоадеры работают в стриминге (чанк мог прийти частично),
 * а String.fromCharCode на гигабайтных буферах ломает latency кадра.
 *
 * Контракт модуля: чистые функции над Uint8Array, ноль зависимостей.
 */

/** Коды символов, используемые парсерами (без magic-чисел в коде). */
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

/** Пробельный символ для построчных форматов (SPACE/TAB/CR/LF). */
export function isWhitespace(byte: number): boolean {
  return byte === CHAR.SPACE || byte === CHAR.TAB || byte === CHAR.CR || byte === CHAR.LF
}

/**
 * Декодирует ASCII-подстроку [start, start+length) в JS-строку.
 * Чанками по 8 КБ, чтобы не переполнить стек String.fromCharCode.
 * Используется для заголовков (glTF/BIN/FBX-magic) и коротких токенов
 * форматов (имена узлов, ключевые слова OBJ/MTL).
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
 * Быстрый разбор десятичного числа из байтов [start, end).
 *
 * Ручная реализация вместо parseFloat(asciiDecode(...)): не аллоцирует
 * строку, останавливается на первом не-числовом байте, возвращает NaN
 * если цифр нет вовсе. Поддерживает знак, дробную часть и экспоненту
 * (в т.ч. «1e-5»). Диапазон точности — как у Number, т.к. мантисса
 * собирается в целое до 2^53.
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

/** Выравнивание длины чанка GLB вверх до границы 4 байта. */
export function align4(n: number): number {
  const rest = n % 4
  return rest === 0 ? n : n + 4 - rest
}

/** performance.now() там где есть, иначе Date.now() (Node/браузер/Bun). */
export function nowMs(): number {
  return typeof performance < 'u' ? performance.now() : Date.now()
}

/** Ограничение value диапазоном [min, max]. */
export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}
