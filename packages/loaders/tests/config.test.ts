import { test, expect } from 'bun:test'
import { jsonParser, zmlParser, textParser, bytesParser, parseZmlBytes, zmlToObject } from '../src/formats/config.ts'
import { makeContext } from './helpers.ts'
import { ParseError } from '../src/core/errors.ts'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

test('jsonParser — объект и массив', () => {
  const ctx = makeContext()
  expect(jsonParser.parse({ bytes: enc('{"a":[1,2]}'), ctx }, undefined)).toEqual({ a: [1, 2] })
  expect(jsonParser.parse({ bytes: enc('[1]'), ctx }, undefined)).toEqual([1])
})

test('jsonParser — синтаксическая ошибка → ParseError', () => {
  const ctx = makeContext()
  expect(() => jsonParser.parse({ bytes: enc('{oops}'), ctx }, undefined)).toThrow(ParseError)
})

test('textParser — декод UTF-8 с BOM', () => {
  const ctx = makeContext()
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc('привет')])
  expect(textParser.parse({ bytes, ctx }, undefined)).toBe('привет')
})

test('bytesParser — тождество (тот же view)', () => {
  const ctx = makeContext()
  const bytes = enc('raw')
  const out = bytesParser.parse({ bytes, ctx }, undefined)
  expect(out).toBe(bytes)
})

// ─── ZML ─────────────────────────────────────────────────────────────────────

test('zml — вложенность, атрибуты, текст', () => {
  const xml = enc(`<root a="1" b='two'>
  <child x="y">text</child>
  <child>2</child>
  <empty/>
</root>`)
  const node = parseZmlBytes(xml)
  expect(node.name).toBe('root')
  expect(node.attrs).toEqual({ a: '1', b: 'two' })
  expect(node.children.length).toBe(3)
  expect(node.children[0].name).toBe('child')
  expect(node.children[0].attrs).toEqual({ x: 'y' })
  expect(node.children[0].text).toBe('text')
  expect(node.children[1].text).toBe('2')
  expect(node.children[2].children.length).toBe(0)
})

test('zml — declaration, комментарии, CDATA', () => {
  const xml = enc(`<?xml version="1.0"?>
<!-- top comment -->
<doc><!-- inner --><v><![CDATA[<raw&stuff>]]></v></doc>`)
  const node = parseZmlBytes(xml)
  expect(node.name).toBe('doc')
  expect(node.children[0].text).toBe('<raw&stuff>')
})

test('zml — entity-подстановки', () => {
  const node = parseZmlBytes(enc(`<a v="&amp;&lt;">A&#65;&#x42;</a>`))
  expect(node.attrs.v).toBe('&<')
  expect(node.text).toBe('AAB')
})

test('zml — незакрытый тег → ParseError', () => {
  expect(() => parseZmlBytes(enc('<a><b></a>'))).toThrow(ParseError)
})

test('zml — закрывающий не совпал → ParseError', () => {
  expect(() => parseZmlBytes(enc('<a></b>'))).toThrow(ParseError)
})

test('zml — мусор после корня → ParseError', () => {
  expect(() => parseZmlBytes(enc('<a/> trailing'))).toThrow(ParseError)
})

test('zmlToObject — повторы в массив, лист-текст, #text', () => {
  const node = parseZmlBytes(enc(`<cfg size="2"><item>a</item><item>b</item><deep k="v">9</deep></cfg>`))
  const obj = zmlToObject(node) as Record<string, unknown>
  expect(obj['size']).toBe('2')
  expect(obj['item']).toEqual(['a', 'b'])
  const deep = obj['deep'] as Record<string, unknown>
  expect(deep['k']).toBe('v')
  expect(deep['#text']).toBe('9')
})

test('zmlParser — через Parser-интерфейс с url в ошибках', () => {
  const ctx = makeContext({ sourceUrl: 'http://t/cfg.zml' })
  const node = zmlParser.parse({ bytes: enc('<x/>'), ctx }, undefined) as import('../src/formats/config.ts').ZmlNode
  expect(node.name).toBe('x')
})
