/**
 * formats/config.ts — конфиги: JSON, ZML (XML-подмножество), text, bytes.
 *
 * bytesParser — тождественный парсер «сырых байтов»: им грузят .bin/.mtl
 * через resolveExternal и используют loadBytes().
 *
 * ZML здесь — строгий XML-подмножество: элементы, атрибуты, текст, комменты,
 * CDATA,Decl-скипы, entity-подстановки (5 именных + числовые). Пространства
 * имён не разбираются (префикс — часть имени тега). Цель — конфиги, не XHTML.
 *
 * Разбор ZML — по байтам: сканер ходит по Uint8Array, строки создаются только
 * для имён/значений (TextDecoder для UTF-8 значений). Никаких split/regex по
 * всему файлу.
 */

import type { ParseContext, ParseInput, Parser } from '../core/types.ts'
import { ParseError } from '../core/errors.ts'

// ─── bytes ───────────────────────────────────────────────────────────────────

/** Сырые байты как ассет (identity-парсер). */
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
    // headless-окружение без TextDecoder — ASCII fallback
    let out = ''
    for (let i = 0; i < bytes.length; i += 4096) {
      out += String.fromCharCode(...bytes.subarray(i, Math.min(i + 4096, bytes.length)))
    }
    return out
  }
  return SHARED_DECODER.decode(bytes)
}

/** Текст как ассет. */
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

/** JSON-конфиг. TextDecoder + JSON.parse — единственный честный путь. */
export const jsonParser: Parser<unknown> = {
  kind: 'json',
  extensions: ['.json'],
  parse(input: ParseInput): unknown {
    const text = decodeUtf8(skipBom(input.bytes))
    try {
      return JSON.parse(text)
    } catch (err) {
      throw new ParseError(`невалидный JSON: ${(err as Error).message}`, 0, input.ctx.sourceUrl ?? undefined)
    }
  },
}

// ─── ZML (XML-подмножество) ──────────────────────────────────────────────────

export interface ZmlNode {
  readonly name: string
  readonly attrs: Readonly<Record<string, string>>
  readonly children: readonly ZmlNode[]
  /** Текст внутри тега (trimmed); null — если текста/только пробелы. */
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

/** Разбор ZML из байтов. */
export function parseZmlBytes(bytes: Uint8Array, ctx?: ParseContext): ZmlNode {
  const b = skipBom(bytes)
  const decoder = new ZmlScanner(b)
  return decoder.parseDocument(ctx?.sourceUrl ?? null)
}

/** ZML-парсер для менеджера. */
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
      throw new ParseError('ZML: мусор после корневого элемента', this.pos, url)
    }
    return root
  }

  private skipProlog(): void {
    for (;;) {
      this.skipWs()
      if (this.match('<?')) {
        this.skipUntil('?>', 'ZML: незакрытый <? ... ?>')
        continue
      }
      if (this.match('<!--')) {
        this.skipUntil('-->', 'ZML: незакрытый комментарий')
        continue
      }
      if (this.match('<!DOCTYPE')) {
        this.skipUntil('>', 'ZML: незакрытый DOCTYPE')
        continue
      }
      return
    }
  }

  private skipMisc(): void {
    for (;;) {
      this.skipWs()
      if (this.match('<!--')) {
        this.skipUntil('-->', 'ZML: незакрытый комментарий')
        continue
      }
      return
    }
  }

  private parseElement(url: string | null): ZmlNode {
    if (this.peek() !== 60 /* < */) {
      throw new ParseError('ZML: ожидался <', this.pos, url)
    }
    this.pos++
    const name = this.parseName(url)
    const attrs = this.parseAttrs(url)
    // self-closing?
    if (this.match('/>')) {
      return { name, attrs, children: [], text: null }
    }
    if (this.peek() !== 62 /* > */) {
      throw new ParseError(`ZML: ожидался > после <${name}`, this.pos, url)
    }
    this.pos++

    // содержимое: текст и вложенные элементы
    let text: string | null = null
    const children: ZmlNode[] = []
    let textStart = -1
    let textEnd = -1
    for (;;) {
      const next = this.indexOfByteFrom(60 /* < */)
      if (next === -1) {
        throw new ParseError(`ZML: нет закрывающего </${name}>`, this.pos, url)
      }
      if (textStart === -1 && next > this.pos) {
        textStart = this.pos
        textEnd = next
      } else if (textStart !== -1 && next > this.pos) {
        // текст уже начат — продолжаем накапливать (между детьми)
        textEnd = next
      }
      this.pos = next
      // </close?
      if (this.match(`</${name}`)) {
        // пропустить возможный ws и >
        this.skipWs()
        if (this.peek() !== 62) {
          throw new ParseError(`ZML: кривой закрывающий тег </${name}`, this.pos, url)
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
      // комментарий/CDATA внутри?
      if (this.match('<!--')) {
        this.skipUntil('-->', 'ZML: незакрытый комментарий')
        continue
      }
      if (this.match('<![CDATA[')) {
        const end = this.indexOfAscii(']]>')
        if (end === -1) throw new ParseError('ZML: незакрытый CDATA', this.pos, url)
        const cdata = decodeUtf8(this.bytes.subarray(this.pos, end))
        text = (text ?? '') + cdata
        this.pos = end + 3
        textStart = -1 // дальше текст считается заново
        continue
      }
      // вложенный элемент
      const child = this.parseElement(url)
      children.push(child)
      textStart = -1
    }
  }

  private parseName(url: string | null): string {
    const start = this.pos
    if (this.pos >= this.bytes.length || !isNameStart(this.bytes[this.pos])) {
      throw new ParseError('ZML: кривое имя тега', this.pos, url)
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
      if (c === -1) throw new ParseError('ZML: внезапный конец в атрибутах', this.pos, url)
      const name = this.parseName(url)
      this.skipWs()
      if (this.peek() !== 61 /* = */) {
        throw new ParseError(`ZML: у атрибута ${name} нет =`, this.pos, url)
      }
      this.pos++
      this.skipWs()
      const quote = this.peek()
      if (quote !== 39 && quote !== 34) {
        throw new ParseError(`ZML: значение ${name} без кавычек`, this.pos, url)
      }
      this.pos++
      const end = this.indexOfByteFrom(quote)
      if (end === -1) throw new ParseError(`ZML: значение ${name} не закрыто`, this.pos, url)
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
      else throw new ParseError(`ZML: неизвестная entity &${entity};`, offset + next, url)
    }
    i = semi + 1
  }
  out += text.slice(i)
  return out
}

// ─── ZML → plain object ──────────────────────────────────────────────────────

/**
 * Конвертация ZmlNode в JS-объект (стиль «xml2js»):
 *  - атрибуты → строковые ключи;
 *  - дочерние элементы → ключ по имени (повторы собираются в массив);
 *  - лист с текстом без атрибутов → сам текст;
 *  - текст при наличии детей/атрибутов → ключ "#text".
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
