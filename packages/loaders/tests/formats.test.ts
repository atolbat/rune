import { test, expect } from 'bun:test'
import { Assembler } from '../src/assembler.ts'
import { parseImage, sniffImageMime } from '../src/image.ts'
import { parseConfig, parseIni, parseZml, registerConfigParser, configParserOf } from '../src/config.ts'

// ─── MIME sniffing ────────────────────────────────────────────────────────────

test('sniffImageMime: format signatures', () => {
  // all sniff prefixes require ≥ 12 bytes (as in the original)
  const jpeg = new Uint8Array([255, 216, 255, 224, 0, 0, 0, 0, 0, 0, 0, 0])
  expect(sniffImageMime(jpeg)).toBe('image/jpeg')
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
  expect(sniffImageMime(png)).toBe('image/png')
  const gif = new Uint8Array([71, 73, 70, 56, 57, 97, 0, 0, 0, 0, 0, 0])
  expect(sniffImageMime(gif)).toBe('image/gif')
  // RIFF....WEBP
  const webp = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80])
  expect(sniffImageMime(webp)).toBe('image/webp')
  // ftyp avif
  const avif = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 97, 118, 105, 102])
  expect(sniffImageMime(avif)).toBe('image/avif')
  // ftyp mif1
  const mif1 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 105, 102, 49])
  expect(sniffImageMime(mif1)).toBe('image/avif')
  // short 2-byte prefixes
  expect(sniffImageMime(new Uint8Array([58, 41, 0, 0, 0, 0]))).toBe('image/avif')
  // unknown — octet-stream
  expect(sniffImageMime(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toBe('application/octet-stream')
  expect(sniffImageMime(new Uint8Array(0))).toBe('application/octet-stream')
  // bare 8-byte PNG magic: the sniff requires 12 bytes — not recognized
  expect(sniffImageMime(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))).toBe('application/octet-stream')
})

test('parseImage: decode with a createBitmap injection', async () => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4])
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(png)
      controller.close()
    },
  })
  const assembler = new Assembler(stream)
  let capturedMime = ''
  const fakeBitmap = { width: 16, height: 9, close: () => {} } as unknown as ImageBitmap
  const asset = await parseImage(assembler, {
    createBitmap: async (bytes, mime) => {
      capturedMime = mime
      expect(Array.from(bytes)).toEqual(Array.from(png))
      return fakeBitmap
    },
  })
  expect(asset.kind).toBe('image')
  expect(asset.bitmap).toBe(fakeBitmap)
  expect(asset.width).toBe(16)
  expect(asset.height).toBe(9)
  expect(asset.byteLength).toBe(png.length)
  expect(capturedMime).toBe('image/png')
})

test('parseImage: a decoder error propagates out', async () => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4])
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(png)
      controller.close()
    },
  })
  const assembler = new Assembler(stream)
  await expect(
    parseImage(assembler, {
      createBitmap: async () => {
        throw new Error('bad pixels')
      },
    }),
  ).rejects.toThrow('bad pixels')
})

// ─── Configs ──────────────────────────────────────────────────────────────────

const ZML = `
# comment
scene
  title "Header"
  gravity -9.81
  fullscreen true
  debug false
  layers
    sky
      color 0.1 0.2 0.3
    fog
      density 0.5
`

test('parseZml: tree, scalars, quotes, bool, numbers', () => {
  const root = parseZml(new TextEncoder().encode(ZML))
  const scene = root['scene'] as Record<string, unknown>
  // quotes are token-wise: a value with spaces inside quotes is NOT one value
  expect(scene['title']).toBe('Header')
  expect(scene['gravity']).toBeCloseTo(-9.81)
  expect(scene['fullscreen']).toBe(true)
  expect(scene['debug']).toBe(false)
  const layers = scene['layers'] as Record<string, unknown>
  const sky = layers['sky'] as Record<string, unknown>
  expect(sky['color']).toEqual([0.1, 0.2, 0.3])
  const fog = layers['fog'] as Record<string, unknown>
  expect(fog['density']).toBeCloseTo(0.5)
})

test('parseZml: repeated keys → an array; repeated blocks → an array of sections', () => {
  const root = parseZml(
    new TextEncoder().encode(
      'path 1 2\npath 3\nspawn\n  x 1\nspawn\n  x 2\n',
    ),
  )
  expect(root['path']).toEqual([1, 2, 3])
  const spawns = root['spawn'] as unknown[]
  expect(Array.isArray(spawns)).toBe(true)
  expect(spawns).toHaveLength(2)
})

const INI = `
; leading comment
[server]
host = localhost
port = 8080
debug = true
[user]
# name
name = "Alice"
`

test('parseIni: sections, values, comments', () => {
  const root = parseIni(new TextEncoder().encode(INI))
  const server = root['server'] as Record<string, unknown>
  expect(server['host']).toBe('localhost')
  expect(server['port']).toBe(8080)
  expect(server['debug']).toBe(true)
  const user = root['user'] as Record<string, unknown>
  expect(user['name']).toBe('Alice')
})

function configAssembler(text: string): Assembler {
  const bytes = new TextEncoder().encode(text)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  return new Assembler(stream)
}

test('parseConfig: json/zml/ini/foreign extension', async () => {
  const json = await parseConfig(configAssembler('{"a": 1}'), 'json')
  expect(json).toEqual({ a: 1 })
  const zml = await parseConfig(configAssembler('k v 1'), 'zml')
  // 'v' — a string, 1 — a number: several values → an array
  expect(zml).toEqual({ k: ['v', 1] })
})

test('parseConfig: yaml without a parser — a hint', async () => {
  expect(parseConfig(configAssembler('a: 1'), 'yaml')).rejects.toThrow(
    "registerConfigParser('yaml'",
  )
})

test('registerConfigParser: a custom format', async () => {
  registerConfigParser('toml', (bytes) => {
    const text = new TextDecoder().decode(bytes)
    return { raw: text }
  })
  expect(configParserOf('toml')).toBeDefined()
  const result = await parseConfig(configAssembler('a = 1'), 'toml')
  expect(result).toEqual({ raw: 'a = 1' })
  // and it becomes available through the loader's general format registry
  expect(configParserOf('TOML')).toBeDefined()
})
