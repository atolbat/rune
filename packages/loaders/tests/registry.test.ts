import { test, expect } from 'bun:test'
import { FetchScheduler } from '../src/assembler.ts'
import { AssetLoader, defaultFormats, extensionOf, resolveUrl, isBinaryFbx } from '../src/registry.ts'
import type { GltfModel, ObjModel } from '../src/index.ts'
import { buildGlb, triBin, triDocument } from './glb-fixtures.ts'

/** Файловый сервер на fetch-стабе. */
function fileServer(files: Record<string, Uint8Array | string>) {
  const fetchLog: string[] = []
  const fetchImpl = (async (url: string | URL | Request) => {
    const key = String(url)
    fetchLog.push(key)
    const content = files[key]
    if (content === undefined) return new Response('not found', { status: 404 })
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    })
    return new Response(stream, {
      status: 200,
      headers: { 'content-length': String(bytes.length) },
    })
  }) as unknown as typeof fetch
  return { fetchImpl, fetchLog }
}

const OBJ_TEXT = `
v 0 0 0
v 1 0 0
v 0 1 0
f 1 2 3
`
const GLB = buildGlb(triDocument(), triBin())

test('extensionOf / resolveUrl / isBinaryFbx — утилиты реестра', () => {
  expect(extensionOf('https://x/y/model.GLB?raw=1#frag')).toBe('glb')
  expect(extensionOf('https://x/y/noext')).toBe('')
  // dotfile: точка после слэша считается расширением (как в оригинале)
  expect(extensionOf('https://x/.hidden')).toBe('hidden')
  expect(resolveUrl('https://base/dir/a.gltf', 'b.bin')).toBe('https://base/dir/b.bin')
  expect(resolveUrl('https://base/dir/a.gltf', 'https://other/c.bin')).toBe('https://other/c.bin')
  expect(resolveUrl('https://base/dir/a.gltf', 'data:application/octet-stream,AAA')).toMatch(/^data:/)
  const fbxMagic = new TextEncoder().encode('Kaydara FBX Binary  \x1a\x00\x00\x00\x00')
  expect(isBinaryFbx(fbxMagic)).toBe(true)
  expect(isBinaryFbx(new TextEncoder().encode('glTF2\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0'))).toBe(false)
})

test('defaultFormats: полный состав лоадеров', () => {
  const ids = defaultFormats().map((f) => f.id)
  expect(ids).toEqual(['glb', 'gltf', 'obj', 'mtl', 'fbx', 'image', 'config', 'bytes'])
  const extensions = defaultFormats().flatMap((f) => f.extensions)
  for (const required of ['glb', 'gltf', 'obj', 'mtl', 'fbx', 'png', 'jpg', 'json', 'ini', 'zml', 'bin'])
    expect(extensions).toContain(required)
})

test('AssetLoader: obj по расширению', async () => {
  const { fetchImpl, fetchLog } = fileServer({ 'https://x/mesh.obj': OBJ_TEXT })
  const loader = new AssetLoader({ fetchImpl, scheduler: new FetchScheduler({ maxConcurrent: 2 }) })
  const model = (await loader.load('https://x/mesh.obj')) as ObjModel
  expect(model.kind).toBe('obj')
  expect(model.vertexCount).toBe(3)
  expect(fetchLog).toEqual(['https://x/mesh.obj'])
})

test('AssetLoader: glb по расширению и по magic-байтам (без расширения)', async () => {
  const { fetchImpl } = fileServer({ 'https://x/mesh.glb': GLB, 'https://x/binary': GLB })
  const loader = new AssetLoader({ fetchImpl })
  const byExtension = (await loader.load('https://x/mesh.glb')) as GltfModel
  expect(byExtension.kind).toBe('glb')
  expect(byExtension.meshes[0].primitives[0].vertexCount).toBe(3)
  // URL без расширения: сниффинг первых 24 байт → glb-парсер
  const byMagic = (await loader.load('https://x/binary')) as GltfModel
  expect(byMagic.kind).toBe('glb')
  expect(byMagic.meshes[0].primitives[0].vertexCount).toBe(3)
})

test('AssetLoader: неизвестный формат без магики → сырые байты', async () => {
  const raw = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 1, 2, 3])
  const { fetchImpl } = fileServer({ 'https://x/blob': raw })
  const loader = new AssetLoader({ fetchImpl })
  const bytes = await loader.load('https://x/blob')
  expect(bytes).toBeInstanceOf(Uint8Array)
  expect((bytes as Uint8Array).length).toBe(raw.length)
})

test('AssetLoader: дедупликация URL — один fetch, один и тот же handle', async () => {
  const { fetchImpl, fetchLog } = fileServer({ 'https://x/mesh.obj': OBJ_TEXT })
  const loader = new AssetLoader({ fetchImpl })
  const first = loader.load('https://x/mesh.obj')
  const second = loader.load('https://x/mesh.obj')
  expect(second).toBe(first)
  await first
  expect(fetchLog).toEqual(['https://x/mesh.obj'])
})

test('AssetLoader: кэш — второй load мгновенно из кэша', async () => {
  const { fetchImpl, fetchLog } = fileServer({ 'https://x/mesh.obj': OBJ_TEXT })
  const loader = new AssetLoader({ fetchImpl })
  const first = await loader.load('https://x/mesh.obj')
  const progresses: boolean[] = []
  const second = await loader.load('https://x/mesh.obj', {
    onProgress: (p) => progresses.push(p.cached),
  })
  expect(second).toBe(first)
  expect(fetchLog).toHaveLength(1)
  expect(loader.stats().cacheHits).toBe(1)
  expect(loader.stats().cached).toBe(1)
  expect(progresses.every((cached) => cached)).toBe(true)
})

test('AssetLoader: noCache — в кэш не кладётся', async () => {
  const { fetchImpl, fetchLog } = fileServer({ 'https://x/mesh.obj': OBJ_TEXT })
  const loader = new AssetLoader({ fetchImpl })
  await loader.load('https://x/mesh.obj', { noCache: true })
  expect(loader.stats().cached).toBe(0)
  await loader.load('https://x/mesh.obj')
  expect(fetchLog).toHaveLength(2)
})

test('AssetLoader: прогресс фаз и события done', async () => {
  const { fetchImpl } = fileServer({ 'https://x/mesh.glb': GLB })
  const loader = new AssetLoader({ fetchImpl })
  const events: string[] = []
  loader.on('done', () => events.push('done'))
  const phases: string[] = []
  const details: string[] = []
  await loader.load('https://x/mesh.glb', {
    onProgress: (p) => {
      phases.push(p.phase)
      details.push(p.detail)
    },
  })
  // первый коллбэк — уже из start() (fetching); начальный queued-снапшот
  // доступен через handle.progress ДО await — отдельная проверка ниже
  expect(phases[0]).toBe('fetching')
  expect(phases).toContain('parsing')
  expect(phases[phases.length - 1]).toBe('done')
  expect(events).toEqual(['done'])
  expect(details.length).toBeGreaterThan(0)
})

test('AssetLoader: начальный снапшот — queued до старта', async () => {
  const fetchImpl = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]))
        },
      }),
      { status: 200, headers: { 'content-length': '3' } },
    )) as unknown as typeof fetch
  const scheduler = new FetchScheduler({ maxConcurrent: 1 })
  scheduler.pause() // задача остаётся в очереди — старт не случается
  const loader = new AssetLoader({ fetchImpl, scheduler })
  const stalled = loader.load('https://x/slow.bin')
  expect(stalled.progress.phase).toBe('queued')
  expect(stalled.progress.detail).toBe('в очереди')
  expect(stalled.isSettled).toBe(false)
  stalled.cancel()
  await stalled.catch(() => {})
})

test('AssetLoader: transform-хук применяется после парсинга', async () => {
  const { fetchImpl } = fileServer({ 'https://x/mesh.obj': OBJ_TEXT })
  const loader = new AssetLoader({ fetchImpl })
  const result = await loader.load('https://x/mesh.obj', {
    transform: [
      (asset) => ({ wrapped: asset }),
      async (asset) => ({ wrapped: (asset as { wrapped: unknown }).wrapped, stage: 2 }),
    ],
  })
  const model = result as { wrapped: ObjModel; stage: number }
  expect(model.stage).toBe(2)
  expect(model.wrapped.kind).toBe('obj')
})

test('AssetLoader: 404 → reject + событие error', async () => {
  const { fetchImpl } = fileServer({})
  const loader = new AssetLoader({ fetchImpl })
  const errors: unknown[] = []
  loader.on('error', (event) => errors.push(event.error))
  const handle = loader.load('https://x/missing.obj')
  await expect(Promise.resolve(handle)).rejects.toThrow('HTTP 404')
  expect(errors).toHaveLength(1)
  expect(loader.getHandle('https://x/missing.obj')).toBeUndefined()
})

test('AssetLoader: отмена задачи в очереди → cancelled', async () => {
  // Первая загрузка блокируется на потоке, вторая стоит в очереди
  const stalledStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('v 0 0 0\n'))
      // НЕ закрываем: поток висит
    },
  })
  const fetchImpl = (async (url: string | URL | Request) => {
    if (String(url) === 'https://x/stall.obj')
      return new Response(stalledStream, { status: 200, headers: { 'content-length': '1000' } })
    return new Response(new TextEncoder().encode(OBJ_TEXT), { status: 200 })
  }) as unknown as typeof fetch
  const loader = new AssetLoader({
    fetchImpl,
    scheduler: new FetchScheduler({ maxConcurrent: 1 }),
  })
  const stalled = loader.load('https://x/stall.obj')
  const queued = loader.load('https://x/queued.obj')
  const cancelled: unknown[] = []
  loader.on('cancelled', (event) => cancelled.push(event.handle.url))
  expect(queued.cancel('не нужен')).toBe(true)
  await expect(Promise.resolve(queued)).rejects.toThrow('не нужен')
  expect(cancelled).toEqual(['https://x/queued.obj'])
  // прибираемся: отменяем зависшую задачу — реджект уходит в catch
  expect(stalled.cancel()).toBe(true)
  await stalled.catch(() => {})
})

test('AssetLoader: LRU eviction по бюджету байт', async () => {
  const { fetchImpl, fetchLog } = fileServer({
    'https://x/a.obj': OBJ_TEXT,
    'https://x/b.obj': OBJ_TEXT + 'v 2 0 0\n',
    'https://x/c.obj': OBJ_TEXT + 'v 3 0 0\n',
  })
  const loader = new AssetLoader({ fetchImpl, cacheBytesLimit: 1 })
  const evicted: string[] = []
  loader.on('evicted', (event) => evicted.push(event.url))
  await loader.load('https://x/a.obj')
  await loader.load('https://x/b.obj')
  await loader.load('https://x/c.obj')
  expect(evicted).toContain('https://x/a.obj')
  expect(evicted).toContain('https://x/b.obj')
  expect(loader.get('https://x/c.obj')).toBeDefined()
  expect(loader.get('https://x/a.obj')).toBeUndefined()
})

test('AssetLoader: loadGroup — агрегированный прогресс и результат', async () => {
  const { fetchImpl } = fileServer({
    'https://x/a.obj': OBJ_TEXT,
    'https://x/mesh.glb': GLB,
  })
  const loader = new AssetLoader({ fetchImpl })
  const group = loader.loadGroup([
    { url: 'https://x/a.obj' },
    { url: 'https://x/mesh.glb' },
  ])
  const assets = await group.promise
  expect(assets).toHaveLength(2)
  expect(group.progress.phase).toBe('done')
  expect(group.progress.ratio).toBeCloseTo(1)
  expect((assets[0] as ObjModel).kind).toBe('obj')
  expect((assets[1] as GltfModel).kind).toBe('glb')
})

test('AssetLoader: registerFormat — свой формат приоритетнее', async () => {
  const { fetchImpl } = fileServer({ 'https://x/data.zzz': OBJ_TEXT })
  const loader = new AssetLoader({ fetchImpl })
  let called = false
  loader.registerFormat('zzz', ['zzz'], async (ctx) => {
    called = true
    await ctx.assembler.completion
    return { custom: ctx.assembler.watermark }
  })
  const result = (await loader.load('https://x/data.zzz')) as { custom: number }
  expect(called).toBe(true)
  expect(result.custom).toBe(OBJ_TEXT.length)
})

test('AssetLoader: явный parser по id, несуществующий id — ошибка', async () => {
  const { fetchImpl } = fileServer({ 'https://x/data.bin': OBJ_TEXT, 'https://x/data2.bin': OBJ_TEXT })
  const loader = new AssetLoader({ fetchImpl })
  const result = await loader.load('https://x/data.bin', { parser: 'obj' })
  expect((result as ObjModel).kind).toBe('obj')
  await expect(
    Promise.resolve(loader.load('https://x/data2.bin', { parser: 'nope' })),
  ).rejects.toThrow('парсер «nope» не зарегистрирован')
})

test('AssetLoader: configParsers — доступ к реестру конфигов', () => {
  const loader = new AssetLoader({})
  expect(loader.configParsers.of('json')).toBeDefined()
  expect(loader.configParsers.of('zml')).toBeDefined()
  expect(loader.configParsers.of('nope')).toBeUndefined()
})
