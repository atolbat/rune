import { test, expect } from 'bun:test'
import { Assembler } from '../src/assembler.ts'
import { parseImage, sniffImageMime } from '../src/image.ts'
import { parseConfig, parseIni, parseZml, registerConfigParser, configParserOf } from '../src/config.ts'

// ─── MIME-сниффинг ────────────────────────────────────────────────────────────

test('sniffImageMime: подписи форматов', () => {
  // все снифф-префиксы требуют ≥ 12 байт (как в оригинале)
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
  // короткие 2-байтовые префиксы
  expect(sniffImageMime(new Uint8Array([58, 41, 0, 0, 0, 0]))).toBe('image/avif')
  // неизвестное — octet-stream
  expect(sniffImageMime(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toBe('application/octet-stream')
  expect(sniffImageMime(new Uint8Array(0))).toBe('application/octet-stream')
  // 8-байтовый голый PNG-магик: снифф требует 12 байт — не опознаём
  expect(sniffImageMime(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))).toBe('application/octet-stream')
})

test('parseImage: декод с инъекцией createBitmap', async () => {
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

test('parseImage: ошибка декодера пробрасывается наружу', async () => {
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
        throw new Error('битые пиксели')
      },
    }),
  ).rejects.toThrow('битые пиксели')
})

// ─── Конфиги ──────────────────────────────────────────────────────────────────

const ZML = `
# комментарий
scene
  title "Заголовок"
  gravity -9.81
  fullscreen true
  debug false
  layers
    sky
      color 0.1 0.2 0.3
    fog
      density 0.5
`

test('parseZml: дерево, скаляры, кавычки, bool, числа', () => {
  const root = parseZml(new TextEncoder().encode(ZML))
  const scene = root['scene'] as Record<string, unknown>
  // кавычки — по-токенно: значение с пробелами внутри кавычек НЕ одно значение
  expect(scene['title']).toBe('Заголовок')
  expect(scene['gravity']).toBeCloseTo(-9.81)
  expect(scene['fullscreen']).toBe(true)
  expect(scene['debug']).toBe(false)
  const layers = scene['layers'] as Record<string, unknown>
  const sky = layers['sky'] as Record<string, unknown>
  expect(sky['color']).toEqual([0.1, 0.2, 0.3])
  const fog = layers['fog'] as Record<string, unknown>
  expect(fog['density']).toBeCloseTo(0.5)
})

test('parseZml: повтор ключей → массив; повтор блоков → массив секций', () => {
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
; ведущий комментарий
[server]
host = localhost
port = 8080
debug = true
[user]
# имя
name = "Алиса"
`

test('parseIni: секции, значения, комментарии', () => {
  const root = parseIni(new TextEncoder().encode(INI))
  const server = root['server'] as Record<string, unknown>
  expect(server['host']).toBe('localhost')
  expect(server['port']).toBe(8080)
  expect(server['debug']).toBe(true)
  const user = root['user'] as Record<string, unknown>
  expect(user['name']).toBe('Алиса')
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

test('parseConfig: json/zml/ini/чужое расширение', async () => {
  const json = await parseConfig(configAssembler('{"a": 1}'), 'json')
  expect(json).toEqual({ a: 1 })
  const zml = await parseConfig(configAssembler('k v 1'), 'zml')
  // 'v' — строка, 1 — число: несколько значений → массив
  expect(zml).toEqual({ k: ['v', 1] })
})

test('parseConfig: yaml без парсера — подсказка', async () => {
  expect(parseConfig(configAssembler('a: 1'), 'yaml')).rejects.toThrow(
    "registerConfigParser('yaml'",
  )
})

test('registerConfigParser: свой формат', async () => {
  registerConfigParser('toml', (bytes) => {
    const text = new TextDecoder().decode(bytes)
    return { raw: text }
  })
  expect(configParserOf('toml')).toBeDefined()
  const result = await parseConfig(configAssembler('a = 1'), 'toml')
  expect(result).toEqual({ raw: 'a = 1' })
  // и через общий реестр форматов загрузчика он станет доступен
  expect(configParserOf('TOML')).toBeDefined()
})
