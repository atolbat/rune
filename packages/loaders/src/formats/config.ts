/**
 * formats/config.ts — configs: JSON, ZML (an XML subset), text, bytes.
 *
 * bytesParser — the identity parser for "raw bytes": .bin/.mtl are loaded
 * with it via resolveExternal, and loadBytes() uses it.
 *
 * ZML here is a strict XML subset: elements, attributes, text, comments,
 * CDATA, decl skips, entity substitution (5 named + numeric). Namespaces
 * are not parsed (the prefix is part of the tag name). The goal is configs,
 * not XHTML.
 *
 * ZML parsing is byte-based: the scanner walks the Uint8Array, strings are
 * created only for names/values (TextDecoder for UTF-8 values). No split/
 * regex over the whole file.
 */

import type { ParseContext, ParseInput, Parser } from '../core/types.ts'
import { ParseError } from '../core/errors.ts'

// ─── bytes ───────────────────────────────────────────────────────────────────

/** Raw bytes as an asset (the identity parser). */
export const bytesParser: Parser<Uint8Array> = {
  kind: 'bytes',
  extensions: ['.bin'],
  parse(input: ParseInput): Uint8Array {
    return input.bytes
  },
}

// ─── text ────────────────────────────────────────────────────────────────────

const SHARED_DECODER = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null

function decodeUtf8(bytes: Uint8Array): string {
  if (SHARED_DECODER === null) {
    // a headless environment without TextDecoder — ASCII fallback
    let out = ''
    for (let i = 0; i < bytes.length; i += 4096) {
      out += String.fromCharCode(...bytes.subarray(i, Math.min(i + 4096, bytes.length)))
    }
    return out
  }
  return SHARED_DECODER.decode(bytes)
}

/** Text as an asset. */
export const textParser: Parser<string> = {
  kind: 'text',
  extensions: ['.txt'],
  parse(input: ParseInput): string {
    return decodeUtf8(skipBom(input.bytes))
  },
}

function skipBom(bytes: Uint8Array): Uint8Array {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3)
  }
  return bytes
}

// ─── JSON ────────────────────────────────────────────────────────────────────

/** A JSON config. TextDecoder + JSON.parse — the only honest path. */
export const jsonParser: Parser<unknown> = {
  kind: 'json',
  extensions: ['.json'],
  parse(input: ParseInput): unknown {
    const text = decodeUtf8(skipBom(input.bytes))
    try {
      return JSON.parse(text)
    } catch (err) {
      throw new ParseError(`invalid JSON: ${(err as Error).message}`, 0, input.ctx.sourceUrl ?? undefined)
    }
  },
}

// ─── ZML (an XML subset) ──────────────────────────────────────────────────

export interface ZmlNode {
  readonly name: string
  readonly attrs: Readonly<Record<string, string>>
  readonly children: readonly ZmlNode[]
  /** Text inside the tag (trimmed); null if no text/only whitespace. */
  readonly text: string | null
}

const WS = new Uint8Array(256).map((_, i) => (i === 32 || i === 9 || i === 10 || i === 13 ? 1 : 0))
function isWs(c: number): boolean {
  return c < 256 && WS[c] === 1
}
function isNameStart(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 58 || c > 127
}
function isNameChar(c: number): boolean {
  return isNameStart(c) || (c >= 48 && c <= 57) || c === 45 || c === 46
}

/** Parse ZML from bytes. */
export function parseZmlBytes(bytes: Uint8Array, ctx?: ParseContext): ZmlNode {
  const b = skipBom(bytes)
  const decoder = new ZmlScanner(b)
  return decoder.parseDocument(ctx?.sourceUrl ?? null)
}

/** The ZML parser for the manager. */
export const zmlParser: Parser<ZmlNode> = {
  kind: 'zml',
  extensions: ['.zml', '.xml'],
  parse(input: ParseInput): ZmlNode {
    return parseZmlBytes(input.bytes, input.ctx)
  },
}

class ZmlScanner {
  private readonly bytes: Uint8Array
  private pos = 0

  constructor(bytes: Uint8Array) {
    this.bytes = bytes
  }

  parseDocument(url: string | null): ZmlNode {
    this.skipProlog()
    const root = this.parseElement(url)
    this.skipMisc()
    if (this.pos < this.bytes.length) {
      throw new ParseError('ZML: garbage after the root element', this.pos, url)
    }
    return root
  }

  private skipProlog(): void {
    for (;;) {
      this.skipWs()
      if (this.match('<?')) {
        this.skipUntil('?>', 'ZML: unclosed <? ... ?>')
        continue
      }
      if (this.match('<!--')) {
        this.skipUntil('-->', 'ZML: unclosed comment')
        continue
      }
      if (this.match('<!DOCTYPE')) {
        this.skipUntil('>', 'ZML: unclosed DOCTYPE')
        continue
      }
      return
    }
  }

  private skipMisc(): void {
    for (;;) {
      this.skipWs()
      if (this.match('<!--')) {
        this.skipUntil('-->', 'ZML: unclosed comment')
        continue
      }
      return
    }
  }

  private parseElement(url: string | null): ZmlNode {
    if (this.peek() !== 60 /* < */) {
      throw new ParseError('ZML: expected <', this.pos, url)
    }
    this.pos++
    const name = this.parseName(url)
    const attrs = this.parseAttrs(url)
    // self-closing?
    if (this.match('/>')) {
      return { name, attrs, children: [], text: null }
    }
    if (this.peek() !== 62 /* > */) {
      throw new ParseError(`ZML: expected > after <${name}`, this.pos, url)
    }
    this.pos++

    // content: text and nested elements
    let text: string | null = null
    const children: ZmlNode[] = []
    let textStart = -1
    let textEnd = -1
    for (;;) {
      const next = this.indexOfByteFrom(60 /* < */)
      if (next === -1) {
        throw new ParseError(`ZML: missing closing </${name}>`, this.pos, url)
      }
      if (textStart === -1 && next > this.pos) {
        textStart = this.pos
        textEnd = next
      } else if (textStart !== -1 && next > this.pos) {
        // the text has already started — keep accumulating (between children)
        textEnd = next
      }
      this.pos = next
      // </close?
      if (this.match(`</${name}`)) {
        // skip possible ws and >
        this.skipWs()
        if (this.peek() !== 62) {
          throw new ParseError(`ZML: malformed closing tag </${name}`, this.pos, url)
        }
        this.pos++
        const raw = textStart === -1 ? null : this.bytes.subarray(textStart, textEnd)
        if (raw !== null) {
          const decoded = decodeEntities(decodeUtf8(raw), this.pos, url)
          const trimmed = decoded.trim()
          if (trimmed.length > 0) text = (text ?? '') + trimmed
        }
        return { name, attrs, children, text }
      }
      // a comment/CDATA inside?
      if (this.match('<!--')) {
        this.skipUntil('-->', 'ZML: unclosed comment')
        continue
      }
      if (this.match('<![CDATA[')) {
        const end = this.indexOfAscii(']]>')
        if (end === -1) throw new ParseError('ZML: unclosed CDATA', this.pos, url)
        const cdata = decodeUtf8(this.bytes.subarray(this.pos, end))
        text = (text ?? '') + cdata
        this.pos = end + 3
        textStart = -1 // the text starts over after this
        continue
      }
      // a nested element
      const child = this.parseElement(url)
      children.push(child)
      textStart = -1
    }
  }

  private parseName(url: string | null): string {
    const start = this.pos
    if (this.pos >= this.bytes.length || !isNameStart(this.bytes[this.pos])) {
      throw new ParseError('ZML: malformed tag name', this.pos, url)
    }
    this.pos++
    while (this.pos < this.bytes.length && isNameChar(this.bytes[this.pos])) this.pos++
    return String.fromCharCode(...this.bytes.subarray(start, this.pos))
  }

  private parseAttrs(url: string | null): Record<string, string> {
    const attrs: Record<string, string> = {}
    for (;;) {
      this.skipWs()
      const c = this.peek()
      if (c === 62 || c === 47 /* / */) return attrs
      if (c === -1) throw new ParseError('ZML: unexpected end in attributes', this.pos, url)
      const name = this.parseName(url)
      this.skipWs()
      if (this.peek() !== 61 /* = */) {
        throw new ParseError(`ZML: attribute ${name} has no =`, this.pos, url)
      }
      this.pos++
      this.skipWs()
      const quote = this.peek()
      if (quote !== 39 && quote !== 34) {
        throw new ParseError(`ZML: value of ${name} without quotes`, this.pos, url)
      }
      this.pos++
      const end = this.indexOfByteFrom(quote)
      if (end === -1) throw new ParseError(`ZML: value of ${name} not closed`, this.pos, url)
      const value = decodeEntities(decodeUtf8(this.bytes.subarray(this.pos, end)), this.pos, url)
      this.pos = end + 1
      attrs[name] = value
    }
  }

  private skipWs(): void {
    while (this.pos < this.bytes.length && isWs(this.bytes[this.pos])) this.pos++
  }

  private peek(): number {
    return this.pos < this.bytes.length ? this.bytes[this.pos] : -1
  }

  private match(ascii: string): boolean {
    if (this.pos + ascii.length > this.bytes.length) return false
    for (let i = 0; i < ascii.length; i++) {
      if (this.bytes[this.pos + i] !== ascii.charCodeAt(i)) return false
    }
    this.pos += ascii.length
    return true
  }

  private skipUntil(marker: string, err: string): void {
    const at = this.indexOfAscii(marker)
    if (at === -1) throw new ParseError(err, this.pos)
    this.pos = at + marker.length
  }

  private indexOfAscii(needle: string): number {
    const first = needle.charCodeAt(0)
    for (let i = this.pos; i <= this.bytes.length - needle.length; i++) {
      if (this.bytes[i] !== first) continue
      let ok = true
      for (let j = 1; j < needle.length; j++) {
        if (this.bytes[i + j] !== needle.charCodeAt(j)) {
          ok = false
          break
        }
      }
      if (ok) return i
    }
    return -1
  }

  private indexOfByteFrom(c: number): number {
    for (let i = this.pos; i < this.bytes.length; i++) {
      if (this.bytes[i] === c) return i
    }
    return -1
  }
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

function decodeEntities(text: string, offset: number, url: string | null): string {
  if (!text.includes('&')) return text
  let out = ''
  let i = 0
  for (;;) {
    const next = text.indexOf('&', i)
    if (next === -1) break
    out += text.slice(i, next)
    const semi = text.indexOf(';', next + 1)
    if (semi === -1 || semi - next > 12) {
      out += '&'
      i = next + 1
      continue
    }
    const entity = text.slice(next + 1, semi)
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = parseInt(entity.slice(2), 16)
      out += Number.isFinite(code) ? String.fromCodePoint(code) : ''
    } else if (entity.startsWith('#')) {
      const code = parseInt(entity.slice(1), 10)
      out += Number.isFinite(code) ? String.fromCodePoint(code) : ''
    } else {
      const mapped = ENTITIES[entity]
      if (mapped !== undefined) out += mapped
      else throw new ParseError(`ZML: unknown entity &${entity};`, offset + next, url)
    }
    i = semi + 1
  }
  out += text.slice(i)
  return out
}

// ─── ZML → plain object ──────────────────────────────────────────────────────

/**
 * Convert a ZmlNode into a JS object ("xml2js" style):
 *  - attributes → string keys;
 *  - child elements → a key by name (repeats are collected into an array);
 *  - a leaf with text and no attributes → the text itself;
 *  - text when there are children/attributes → the "#text" key.
 */
export function zmlToObject(node: ZmlNode): unknown {
  const attrKeys = Object.keys(node.attrs)
  const hasChildren = node.children.length > 0
  if (!hasChildren && attrKeys.length === 0) {
    return node.text
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node.attrs)) out[k] = v
  for (const child of node.children) {
    const value = zmlToObject(child)
    const existing = out[child.name]
    if (existing === undefined) {
      out[child.name] = value
    } else if (Array.isArray(existing)) {
      ;(existing as unknown[]).push(value)
    } else {
      out[child.name] = [existing, value]
    }
  }
  if (node.text !== null) out['#text'] = node.text
  return out
}
