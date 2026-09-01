/**
 * Config loader — JSON/ZML/INI/TXT + регистрация своих форматов.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * КОНТРАКТ:
 *
 *   parseConfig(assembler, extension, options) → распарсенное значение
 *   registerConfigParser(extension, fn)   — свой формат (yaml/toml/…)
 *   configParserOf(extension)             — чтение реестра
 *
 * ZML — компактный indentation-формат движка (для сцен/пресетов):
 *
 *   scene
 *     title "Заголовок"
 *     gravity -9.81
 *     layers
 *       sky
 *         color 0.1 0.2 0.3
 *       fog on
 *
 * Значения: строки в кавычках, true/false, числа; повтор ключей —
 * массив; повтор «блока» — массив секций {key, values, children}.
 *
 * INI: [section] key = value; комментарии # и ;. Кастомные форматы
 * (yaml/yml/toml) зарегистрированы в реестре форматов загрузчика,
 * но без парсера по умолчанию — ошибка подсказывает registerConfigParser.
 */

import { CHAR, isWhitespace, parseDecimal } from './bytes.ts'
import type { Assembler } from './assembler.ts'
import type { GltfPhase } from './gltf.ts'

/** Значение конфига: скаляр / вложенный объект / массив. */
export type ConfigValue = string | number | boolean | ConfigSection | ConfigValue[]
export type ConfigSection = { [key: string]: ConfigValue }

export type ConfigParser = (bytes: Uint8Array) => ConfigValue | Promise<ConfigValue>

export interface ConfigParseOptions {
  readonly onPhase?: (phase: GltfPhase) => void
}

const configParsers = new Map<string, ConfigParser>([
  ['json', (bytes) => JSON.parse(decodeUtf8(bytes)) as ConfigValue],
  ['zml', parseZml],
  ['txt', (bytes) => decodeUtf8(bytes)],
  ['ini', parseIni],
])

/** Регистрация парсера конфига (yaml/toml/свой формат). */
export function registerConfigParser(extension: string, parser: ConfigParser): void {
  configParsers.set(extension.toLowerCase(), parser)
}

/** Текущий парсер расширения (для интроспекции). */
export function configParserOf(extension: string): ConfigParser | undefined {
  return configParsers.get(extension.toLowerCase())
}

/** Парсинг конфига по расширению; extensions без парсера — ошибка с подсказкой. */
export async function parseConfig(
  assembler: Assembler,
  extension: string,
  options: ConfigParseOptions = {},
): Promise<ConfigValue> {
  const parser = configParserOf(extension)
  if (parser === undefined)
    throw new Error(
      `нет парсера конфигов «${extension}» — подключите registerConfigParser('${extension}', fn)`,
    )
  await assembler.completion
  options.onPhase?.({ stage: 'parse', ratio: 0.5, detail: extension })
  const result = await parser(assembler.fullView())
  options.onPhase?.({ stage: 'parse', ratio: 1, detail: extension })
  return result
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes)
}

// ─── ZML ─────────────────────────────────────────────────────────────────────

/** Маркер блочной секции в массиве (повтор одноимённых блоков). */
interface ZmlSectionMarker {
  readonly key: string
  readonly values: ConfigValue[]
  readonly children: ConfigSection
}

function isSectionArray(value: unknown): value is ZmlSectionMarker[] {
  if (!Array.isArray(value) || value.length === 0) return false
  const first = value[0]
  return typeof first === 'object' && first !== null && 'key' in first
}

function isPlainObject(value: unknown): value is ConfigSection {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Разбор ZML: строки → (indent, key, values) → дерево. */
export function parseZml(bytes: Uint8Array): ConfigSection {
  const root: ConfigSection = {}
  const stack: Array<{ indent: number; children: ConfigSection }> = [{ indent: -1, children: root }]
  let at = 0
  const length = bytes.length
  while (at < length) {
    let lineEnd = at
    while (lineEnd < length && bytes[lineEnd] !== CHAR.LF) lineEnd++
    let contentEnd = lineEnd
    if (contentEnd > at && bytes[contentEnd - 1] === CHAR.CR) contentEnd--
    let indent = 0
    let cursor = at
    while (cursor < contentEnd && bytes[cursor] === CHAR.SPACE) {
      indent++
      cursor++
    }
    if (cursor >= contentEnd || bytes[cursor] === CHAR.HASH) {
      at = lineEnd + 1
      continue
    }
    const keyStart = cursor
    while (cursor < contentEnd && !isWhitespace(bytes[cursor])) cursor++
    // UTF-8: ключи могут быть не-ASCII (значения — тоже, см. parseZmlValue)
    const key = decodeUtf8(bytes.subarray(keyStart, cursor))
    const values: ConfigValue[] = []
    while (cursor < contentEnd) {
      while (cursor < contentEnd && isWhitespace(bytes[cursor])) cursor++
      if (cursor >= contentEnd) break
      const valueStart = cursor
      while (cursor < contentEnd && !isWhitespace(bytes[cursor])) cursor++
      values.push(parseZmlValue(bytes, valueStart, cursor))
    }
    // Возврат на уровень отступа
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    const siblings = stack[stack.length - 1].children
    const existing = siblings[key]
    if (values.length === 0) {
      // Блок: key без значений
      const section: ConfigSection = {}
      if (existing === undefined) siblings[key] = section
      else if (isPlainObject(existing))
        siblings[key] = [existing, { key, values: [], children: section }]
      else if (isSectionArray(existing)) existing.push({ key, values: [], children: section })
      else siblings[key] = section
      stack.push({ indent, children: section })
    } else if (values.length === 1) {
      const value = values[0]
      if (existing === undefined) siblings[key] = value
      else if (Array.isArray(existing) && !isSectionArray(existing))
        (existing as ConfigValue[]).push(value)
      else if (typeof existing === 'number' && typeof value === 'number')
        siblings[key] = [existing, value]
      else siblings[key] = value
    } else {
      siblings[key] = values.map((v) => v)
    }
    at = lineEnd + 1
  }
  return root
}

/** Скаляр: «строка», true/false, число — иначе сырая строка. */
function parseZmlValue(bytes: Uint8Array, start: number, end: number): ConfigValue {
  // UTF-8-декодирование: байты → символы через asciiDecode дают mojibake
  // для не-ASCII значений (восстановлено из минифицированной версии, где
  // стоял byte→char цикл — починено осознанно)
  const raw = decodeUtf8(bytes.subarray(start, end))
  if (raw.length >= 2 && raw.charCodeAt(0) === 34 && raw.charCodeAt(raw.length - 1) === 34)
    return raw.slice(1, -1)
  if (raw === 'true') return true
  if (raw === 'false') return false
  const numeric = parseDecimal(bytes, start, end)
  if (Number.isFinite(numeric)) return numeric
  return raw
}

// ─── INI ─────────────────────────────────────────────────────────────────────

/** INI: секции [name], пары key = value, комментарии #/;. */
export function parseIni(bytes: Uint8Array): ConfigSection {
  const root: Record<string, ConfigSection> = { '': {} }
  let section = ''
  let at = 0
  const length = bytes.length
  while (at < length) {
    let lineEnd = at
    while (lineEnd < length && bytes[lineEnd] !== CHAR.LF) lineEnd++
    let contentEnd = lineEnd
    if (contentEnd > at && bytes[contentEnd - 1] === CHAR.CR) contentEnd--
    let cursor = at
    while (cursor < contentEnd && isWhitespace(bytes[cursor])) cursor++
    if (cursor >= contentEnd || bytes[cursor] === CHAR.HASH || bytes[cursor] === 59 /* ';' */) {
      at = lineEnd + 1
      continue
    }
    if (bytes[cursor] === 91 /* '[' */) {
      const start = cursor + 1
      let end = start
      while (end < contentEnd && bytes[end] !== 93 /* ']' */) end++
      section = decodeUtf8(bytes.subarray(start, end))
      root[section] ??= {}
    } else {
      const keyStart = cursor
      let keyEnd = cursor
      while (keyEnd < contentEnd && bytes[keyEnd] !== 61 /* '=' */) keyEnd++
      // INI-спека: пробелы вокруг «=» не входят ни в ключ, ни в значение
      // (в минифицированной версии они оставались в ключе — починено)
      let keyEndTrimmed = keyEnd
      while (keyEndTrimmed > keyStart && isWhitespace(bytes[keyEndTrimmed - 1])) keyEndTrimmed--
      const key = decodeUtf8(bytes.subarray(keyStart, keyEndTrimmed))
      let valueStart = keyEnd < contentEnd ? keyEnd + 1 : contentEnd
      while (valueStart < contentEnd && isWhitespace(bytes[valueStart])) valueStart++
      let valueEnd = contentEnd
      while (valueEnd > valueStart && isWhitespace(bytes[valueEnd - 1])) valueEnd--
      ;(root[section] ??= {})[key] = parseZmlValue(bytes, valueStart, valueEnd)
    }
    at = lineEnd + 1
  }
  return root
}

// ─── Мост Task 88: текст из байтов (для .gltf/.txt/.zml) ────────────────────

/** Декодировать UTF-8 текст из байтов (AssetLibrary: gltf-json и тексты). */
export function parseTextBytes(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}
