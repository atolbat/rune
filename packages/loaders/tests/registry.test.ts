import { test, expect } from 'bun:test'
import { FetchScheduler } from '../src/assembler.ts'
import { AssetLoader, defaultFormats, extensionOf, resolveUrl, isBinaryFbx } from '../src/registry.ts'
import type { GltfModel, ObjModel } from '../src/index.ts'
import { buildGlb, triBin, triDocument } from './glb-fixtures.ts'

/** A file server on a fetch stub. */
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

test('extensionOf / resolveUrl / isBinaryFbx — registry utilities', () => {
  expect(extensionOf('https://x/y/model.GLB?raw=1#frag')).toBe('glb')
  expect(extensionOf('https://x/y/noext')).toBe('')
  // dotfile: a dot after the slash counts as an extension (as in the original)
  expect(extensionOf('https://x/.hidden')).toBe('hidden')
  expect(resolveUrl('https://base/dir/a.gltf', 'b.bin')).toBe('https://base/dir/b.bin')
  expect(resolveUrl('https://base/dir/a.gltf', 'https://other/c.bin')).toBe('https://other/c.bin')
  expect(resolveUrl('https://base/dir/a.gltf', 'data:application/octet-stream,AAA')).toMatch(/^data:/)
  const fbxMagic = new TextEncoder().encode('Kaydara FBX Binary  \x1a\x00\x00\x00\x00')
  expect(isBinaryFbx(fbxMagic)).toBe(true)
  expect(isBinaryFbx(new TextEncoder().encode('glTF2\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0'))).toBe(false)
})

test('defaultFormats: the full set of loaders', () => {
  const ids = defaultFormats().map((f) => f.id)
  expect(ids).toEqual(['glb', 'gltf', 'obj', 'mtl', 'fbx', 'image', 'config', 'bytes'])
  const extensions = defaultFormats().flatMap((f) => f.extensions)
  for (const required of ['glb', 'gltf', 'obj', 'mtl', 'fbx', 'png', 'jpg', 'json', 'ini', 'zml', 'bin'])
    expect(extensions).toContain(required)
})

test('AssetLoader: obj by extension', async () => {
  const { fetchImpl, fetchLog } = fileServer({ 'https://x/mesh.obj': OBJ_TEXT })
  const loader = new AssetLoader({ fetchImpl, scheduler: new FetchScheduler({ maxConcurrent: 2 }) })
  const model = (await loader.load('https://x/mesh.obj')) as ObjModel
  expect(model.kind).toBe('obj')
  expect(model.vertexCount).toBe(3)
  expect(fetchLog).toEqual(['https://x/mesh.obj'])
})

test('AssetLoader: glb by extension and by magic bytes (without an extension)', async () => {
  const { fetchImpl } = fileServer({ 'https://x/mesh.glb': GLB, 'https://x/binary': GLB })
  const loader = new AssetLoader({ fetchImpl })
  const byExtension = (await loader.load('https://x/mesh.glb')) as GltfModel
  expect(byExtension.kind).toBe('glb')
  expect(byExtension.meshes[0].primitives[0].vertexCount).toBe(3)
  // URL without an extension: sniffing the first 24 bytes → glb parser
  const byMagic = (await loader.load('https://x/binary')) as GltfModel
  expect(byMagic.kind).toBe('glb')
  expect(byMagic.meshes[0].primitives[0].vertexCount).toBe(3)
})

test('AssetLoader: an unknown format without magic → raw bytes', async () => {
  const raw = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 1, 2, 3])
  const { fetchImpl } = fileServer({ 'https://x/blob': raw })
  const loader = new AssetLoader({ fetchImpl })
  const bytes = await loader.load('https://x/blob')
  expect(bytes).toBeInstanceOf(Uint8Array)
  expect((bytes as Uint8Array).length).toBe(raw.length)
})

test('AssetLoader: URL deduplication — one fetch, the same handle', async () => {
  const { fetchImpl, fetchLog } = fileServer({ 'https://x/mesh.obj': OBJ_TEXT })
  const loader = new AssetLoader({ fetchImpl })
  const first = loader.load('https://x/mesh.obj')
  const second = loader.load('https://x/mesh.obj')
  expect(second).toBe(first)
  await first
  expect(fetchLog).toEqual(['https://x/mesh.obj'])
})

test('AssetLoader: cache — the second load instantly from the cache', async () => {
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

test('AssetLoader: noCache — not put into the cache', async () => {
  const { fetchImpl, fetchLog } = fileServer({ 'https://x/mesh.obj': OBJ_TEXT })
  const loader = new AssetLoader({ fetchImpl })
  await loader.load('https://x/mesh.obj', { noCache: true })
  expect(loader.stats().cached).toBe(0)
  await loader.load('https://x/mesh.obj')
  expect(fetchLog).toHaveLength(2)
})

test('AssetLoader: phase progress and done events', async () => {
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
  // the first callback is already from start() (fetching); the initial queued snapshot
  // is available via handle.progress BEFORE await — a separate check below
  expect(phases[0]).toBe('fetching')
  expect(phases).toContain('parsing')
  expect(phases[phases.length - 1]).toBe('done')
  expect(events).toEqual(['done'])
  expect(details.length).toBeGreaterThan(0)
})

test('AssetLoader: initial snapshot — queued before start', async () => {
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
  scheduler.pause() // the job stays in the queue — no start happens
  const loader = new AssetLoader({ fetchImpl, scheduler })
  const stalled = loader.load('https://x/slow.bin')
  expect(stalled.progress.phase).toBe('queued')
  expect(stalled.progress.detail).toBe('queued')
  expect(stalled.isSettled).toBe(false)
  stalled.cancel()
  await stalled.catch(() => {})
})

test('AssetLoader: the transform hook is applied after parsing', async () => {
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

test('AssetLoader: 404 → reject + error event', async () => {
  const { fetchImpl } = fileServer({})
  const loader = new AssetLoader({ fetchImpl })
  const errors: unknown[] = []
  loader.on('error', (event) => errors.push(event.error))
  const handle = loader.load('https://x/missing.obj')
  await expect(Promise.resolve(handle)).rejects.toThrow('HTTP 404')
  expect(errors).toHaveLength(1)
  expect(loader.getHandle('https://x/missing.obj')).toBeUndefined()
})

test('AssetLoader: cancelling a queued job → cancelled', async () => {
  // The first load blocks on a stream, the second stands in the queue
  const stalledStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('v 0 0 0\n'))
      // do NOT close: the stream hangs
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
  expect(queued.cancel('not needed')).toBe(true)
  await expect(Promise.resolve(queued)).rejects.toThrow('not needed')
  expect(cancelled).toEqual(['https://x/queued.obj'])
  // clean up: cancel the hanging job — the reject goes into catch
  expect(stalled.cancel()).toBe(true)
  await stalled.catch(() => {})
})

test('AssetLoader: LRU eviction by the byte budget', async () => {
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

test('AssetLoader: loadGroup — aggregated progress and result', async () => {
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

test('AssetLoader: registerFormat — a custom format takes precedence', async () => {
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

test('AssetLoader: an explicit parser by id, a nonexistent id — an error', async () => {
  const { fetchImpl } = fileServer({ 'https://x/data.bin': OBJ_TEXT, 'https://x/data2.bin': OBJ_TEXT })
  const loader = new AssetLoader({ fetchImpl })
  const result = await loader.load('https://x/data.bin', { parser: 'obj' })
  expect((result as ObjModel).kind).toBe('obj')
  await expect(
    Promise.resolve(loader.load('https://x/data2.bin', { parser: 'nope' })),
  ).rejects.toThrow('parser "nope" is not registered')
})

test('AssetLoader: configParsers — access to the config registry', () => {
  const loader = new AssetLoader({})
  expect(loader.configParsers.of('json')).toBeDefined()
  expect(loader.configParsers.of('zml')).toBeDefined()
  expect(loader.configParsers.of('nope')).toBeUndefined()
})
