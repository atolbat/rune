/**
 * Config loader — JSON/ZML/INI/TXT + registration of custom formats.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CONTRACT:
 *
 *   parseConfig(assembler, extension, options) → parsed value
 *   registerConfigParser(extension, fn)   — custom format (yaml/toml/…)
 *   configParserOf(extension)             — registry lookup
 *
 * ZML — a compact indentation format of the engine (for scenes/presets):
 *
 *   scene
 *     title "Heading"
 *     gravity -9.81
 *     layers
 *       sky
 *         color 0.1 0.2 0.3
 *       fog on
 *
 * Values: quoted strings, true/false, numbers; a repeated key becomes an
 * array; a repeated "block" becomes an array of {key, values, children} sections.
 *
 * INI: [section] key = value; comments # and ;. Custom formats
 * (yaml/yml/toml) are registered in the loader's format registry, but
 * without a default parser — the error hints at registerConfigParser.
 */

import { CHAR, isWhitespace, parseDecimal } from './bytes.ts'
import type { Assembler } from './assembler.ts'
import type { GltfPhase } from './gltf.ts'

/** A config value: scalar / nested object / array. */
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

/** Register a config parser (yaml/toml/custom format). */
export function registerConfigParser(extension: string, parser: ConfigParser): void {
  configParsers.set(extension.toLowerCase(), parser)
}

/** Current parser for an extension (for introspection). */
export function configParserOf(extension: string): ConfigParser | undefined {
  return configParsers.get(extension.toLowerCase())
}

/** Parse a config by extension; extensions without a parser — an error with a hint. */
export async function parseConfig(
  assembler: Assembler,
  extension: string,
  options: ConfigParseOptions = {},
): Promise<ConfigValue> {
  const parser = configParserOf(extension)
  if (parser === undefined)
    throw new Error(
      `no config parser for "${extension}" — plug in registerConfigParser('${extension}', fn)`,
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

/** Block section marker in an array (repeated same-named blocks). */
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

/** ZML parsing: lines → (indent, key, values) → tree. */
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
    // UTF-8: keys may be non-ASCII (values too, see parseZmlValue)
    const key = decodeUtf8(bytes.subarray(keyStart, cursor))
    const values: ConfigValue[] = []
    while (cursor < contentEnd) {
      while (cursor < contentEnd && isWhitespace(bytes[cursor])) cursor++
      if (cursor >= contentEnd) break
      const valueStart = cursor
      while (cursor < contentEnd && !isWhitespace(bytes[cursor])) cursor++
      values.push(parseZmlValue(bytes, valueStart, cursor))
    }
    // Return to the indent level
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    const siblings = stack[stack.length - 1].children
    const existing = siblings[key]
    if (values.length === 0) {
      // Block: key without values
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

/** Scalar: "string", true/false, number — otherwise the raw string. */
function parseZmlValue(bytes: Uint8Array, start: number, end: number): ConfigValue {
  // UTF-8 decoding: bytes → characters via asciiDecode produce mojibake
  // for non-ASCII values (restored from the minified version, which had a
  // byte→char loop — deliberately fixed)
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

/** INI: [name] sections, key = value pairs, #/; comments. */
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
      // INI spec: spaces around "=" belong neither to the key nor to the value
      // (in the minified version they remained in the key — fixed)
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

// ─── Task 88 bridge: text from bytes (for .gltf/.txt/.zml) ────────────────────

/** Decode UTF-8 text from bytes (AssetLibrary: gltf-json and texts). */
export function parseTextBytes(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}
