import { test, expect } from 'bun:test'
import {
  parseFastFloat,
  parseFastInt,
  base64Decode,
  parseDataUri,
  GrowableBytes,
  sniffKind,
  asciiFromBytes,
} from '../src/core/util.ts'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

test('parseFastFloat — ordinary numbers', () => {
  const b = enc('1.5 -2.25 0 100')
  expect(parseFastFloat(b, 0, b.length).value).toBe(1.5)
  expect(parseFastFloat(b, 4, b.length).value).toBe(-2.25)
  expect(parseFastFloat(b, 10, b.length).value).toBe(0)
  expect(parseFastFloat(b, 12, b.length).value).toBe(100)
})

test('parseFastFloat — exponent, leading dot, plus', () => {
  expect(parseFastFloat(enc('-2.25e2'), 0, 7).value).toBe(-225)
  expect(parseFastFloat(enc('.5'), 0, 2).value).toBe(0.5)
  expect(parseFastFloat(enc('+3'), 0, 2).value).toBe(3)
  expect(parseFastFloat(enc('1e-3'), 0, 4).value).toBeCloseTo(0.001)
  expect(parseFastFloat(enc('1.'), 0, 2).value).toBe(1)
})

test('parseFastFloat — garbage and the next position', () => {
  const b = enc('x 1.5')
  expect(parseFastFloat(b, 0, 1).value).toBeNaN()
  const r = parseFastFloat(b, 2, b.length)
  expect(r.value).toBe(1.5)
  expect(r.next).toBe(b.length)
  // the number breaks off at a non-digit character
  const c = enc('12abc')
  const rc = parseFastFloat(c, 0, c.length)
  expect(rc.value).toBe(12)
  expect(rc.next).toBe(2)
})

test('parseFastInt — negatives and garbage', () => {
  expect(parseFastInt(enc('-3'), 0, 2).value).toBe(-3)
  expect(parseFastInt(enc('42'), 0, 2).value).toBe(42)
  expect(parseFastInt(enc('zz'), 0, 2).value).toBeNaN()
})

test('base64Decode — roundtrip via Buffer', () => {
  const data = new Uint8Array([0, 1, 2, 250, 251, 252, 255])
  const text = Buffer.from(data).toString('base64')
  expect(base64Decode(text)).toEqual(new Uint8Array(data))
  // without padding and with whitespace
  expect(base64Decode('AAEC')).toEqual(new Uint8Array([0, 1, 2]))
  expect(base64Decode('AAEC AAEC').length).toBe(6) // 8 chars → 6 bytes
})

test('base64Decode — an invalid character', () => {
  expect(() => base64Decode('A!B=')).toThrow()
})

test('parseDataUri — base64 and utf8', () => {
  const b64 = parseDataUri('data:application/octet-stream;base64,AAEC')
  expect(b64).not.toBeNull()
  expect(b64!.mimeType).toBe('application/octet-stream')
  expect(Array.from(b64!.bytes)).toEqual([0, 1, 2])
  const utf8 = parseDataUri('data:text/plain,hello')
  expect(utf8).not.toBeNull()
  expect(asciiFromBytes(utf8!.bytes)).toBe('hello')
  expect(parseDataUri('http://x/')).toBeNull()
})

test('GrowableBytes — growth without data loss', () => {
  const g = new GrowableBytes(4)
  g.push(new Uint8Array([1, 2, 3]))
  g.push(new Uint8Array([4, 5, 6, 7, 8]))
  expect(g.length).toBe(8)
  expect(Array.from(g.view())).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  const taken = g.take()
  expect(taken.length).toBe(8)
  expect(g.length).toBe(0)
  // after take the buffer is reused
  g.push(new Uint8Array([9]))
  expect(Array.from(g.view())).toEqual([9])
})

test('sniffKind — magics and extensions', () => {
  expect(sniffKind(new Uint8Array([0x67, 0x6c, 0x54, 0x46])).kind).toBe('glb') // 'glTF' LE
  expect(sniffKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47])).kind).toBe('image')
  expect(sniffKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])).kind).toBe('image')
  expect(sniffKind(enc('Kaydara FBX Binary  \x00\x1a\x00')).kind).toBe('fbx')
  expect(sniffKind(enc('#?RADIANCE\n')).kind).toBe('hdr')
  // by extension if there is no magic
  expect(sniffKind(new Uint8Array(0), 'http://x/model.OBJ').kind).toBe('obj')
  expect(sniffKind(new Uint8Array(0), 'http://x/cfg.zml?x=1').kind).toBe('zml')
  expect(sniffKind(enc('{"a":1}')).kind).toBeNull()
})
