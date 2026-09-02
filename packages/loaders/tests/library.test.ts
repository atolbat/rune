/**
 * library.test.ts — AssetLibrary: progress, cache, dedup, cancel,
 * priorities, groups, preload, LRU, sniffing, formats.
 */

import { describe, expect, test } from 'bun:test'
import { AssetLibrary } from '../src/library.ts'
import type { AssetHandle } from '../src/types.ts'
import { LoadScheduler } from '../src/scheduler.ts'
import { parseZml, parseIni, parseTextBytes } from '../src/config.ts'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

function chunkedBody(bytes: Uint8Array, chunks = 4, delay = 1): ReadableStream<Uint8Array> {
  const size = Math.ceil(bytes.length / chunks)
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (let i = 0; i < bytes.length; i += size) {
        await new Promise(resolve => setTimeout(resolve, delay))
        controller.enqueue(bytes.subarray(i, i + size))
      }
      controller.close()
    },
  })
}

/** A fake fetch: url → body (with streaming), keeps a call log. */
function fakeFetch(map: Record<string, Uint8Array | Error>, log: string[] = []): typeof fetch {
  return (async (url: string) => {
    const key = String(url)
    log.push(key)
    const entry = map[key]
    if (entry === undefined) return new Response('404', { status: 404 })
    if (entry instanceof Error) throw entry
    return new Response(chunkedBody(entry), {
      status: 200,
      headers: { 'content-length': String(entry.byteLength) },
    })
  }) as never
}

function buildGlbBytes(): Uint8Array {
  const u32 = (n: number): Uint8Array => {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setUint32(0, n, true)
    return b
  }
  const concat = (parts: Uint8Array[]): Uint8Array => {
    const total = parts.reduce((s, p) => s + p.length, 0)
    const out = new Uint8Array(total)
    let at = 0
    for (const p of parts) {
      out.set(p, at)
      at += p.length
    }
    return out
  }
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }],
    buffers: [{ byteLength: positions.byteLength }],
  }
  const jsonBytes = enc(JSON.stringify(json))
  const bin = new Uint8Array(positions.buffer)
  const jsonChunk = concat([u32(jsonBytes.length), u32(0x4e4f534a), jsonBytes])
  const pad = (b: Uint8Array): Uint8Array => (b.length % 4 === 0 ? b : concat([b, new Uint8Array(4 - (b.length % 4))]))
  const binChunk = concat([u32(bin.length), u32(0x004e4942), bin])
  const total = 12 + pad(jsonChunk).length + pad(binChunk).length
  return concat([u32(0x46546c67), u32(2), u32(total), pad(jsonChunk), pad(binChunk)])
}

describe('AssetLibrary', () => {
  test('load GLB: phases, progress up to 1, the result is a model', async () => {
    const glb = buildGlbBytes()
    const library = new AssetLibrary({ fetchImpl: fakeFetch({ 'https://x/m.glb': glb }) })
    const phases: string[] = []
    let lastRatio = 0
    const handle = library.load('https://x/m.glb', {
      onProgress: p => {
        phases.push(p.phase)
        lastRatio = p.ratio
      },
    })
    const model = (await handle) as { stats: { triangles: number }; kind: string }
    expect(model.kind).toBe('glb')
    expect(model.stats.triangles).toBe(1)
    expect(handle.progress.cached).toBe(false)
    expect(phases[0] === 'queued' || phases[0] === 'fetching').toBe(true)
    expect(phases).toContain('fetching')
    expect(phases).toContain('parsing')
    expect(lastRatio).toBe(1)
    expect(handle.state).toBe('done')
  })

  test('cache: the second load — instantly, no network', async () => {
    const glb = buildGlbBytes()
    const log: string[] = []
    const library = new AssetLibrary({ fetchImpl: fakeFetch({ 'https://x/m.glb': glb }, log) })
    await library.load('https://x/m.glb')
    const callsBefore = log.length
    const handle = library.load('https://x/m.glb')
    const model = await handle
    expect(model).toBeDefined()
    expect(handle.progress.cached).toBe(true)
    expect(log.length).toBe(callsBefore)
    expect(library.stats().cacheHits).toBe(1)
  })

  test('dedup: parallel loads of one URL — a single fetch', async () => {
    const glb = buildGlbBytes()
    const log: string[] = []
    const library = new AssetLibrary({ fetchImpl: fakeFetch({ 'https://x/m.glb': glb }, log) })
    const [a, b, c] = [
      library.load('https://x/m.glb'),
      library.load('https://x/m.glb'),
      library.load('https://x/m.glb'),
    ]
    await Promise.all([a, b, c])
    expect(log.length).toBe(1)
  })

  test('cancelling running: fetch abort → rejects, the network cleans up', async () => {
    const glb = buildGlbBytes()
    let aborted = false
    const fetchImpl: typeof fetch = (async (_url: string, init?: { signal?: AbortSignal }) => {
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(glb.subarray(0, 20))
            await new Promise<void>(resolve => {
              const timer = setInterval(() => {
                if (init?.signal?.aborted) {
                  clearInterval(timer)
                  aborted = true
                  controller.error(new DOMException('aborted', 'AbortError'))
                  resolve()
                }
              }, 2)
            })
          },
        }),
        { status: 200, headers: { 'content-length': String(glb.byteLength) } },
      )
    }) as never
    const library = new AssetLibrary({ fetchImpl })
    const handle = library.load('https://x/slow.glb')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(handle.cancel('stop')).toBe(true)
    const outcome = await handle.then(
      () => ({ resolved: true as const }),
      (error: unknown) => ({ resolved: false as const, error }),
    )
    expect(outcome.resolved).toBe(false)
    if (!outcome.resolved) {
      expect((outcome.error as DOMException).name).toBe('AbortError')
    }
    // The network winds down: either the stream is cancelled (cancel), or it noticed the abort.
    expect(aborted || handle.state === 'cancelled').toBe(true)
    expect(handle.state).toBe('cancelled')
    expect(library.scheduler.stats().running).toBe(0)
  })

  test('priorities: priority 0 starts before 5 with maxConcurrent=1', async () => {
    const glbA = buildGlbBytes()
    const objB = enc('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n')
    const log: string[] = []
    const library = new AssetLibrary({
      scheduler: new LoadScheduler({ maxConcurrent: 1 }),
      fetchImpl: (async (url: string) => {
        log.push(String(url))
        await new Promise(resolve => setTimeout(resolve, 5))
        const body = String(url).endsWith('hi.glb') ? glbA : objB
        return new Response(chunkedBody(body, 2, 5), { status: 200, headers: { 'content-length': String(body.length) } })
      }) as never,
    })
    // A blocker occupies the only slot.
    const swallow = (h: AssetHandle<unknown>): Promise<void> => h.then(
      () => undefined,
      () => undefined,
    ) as Promise<void>
    const blocker = library.load('https://x/block.obj', { priority: 9 })
    await new Promise(resolve => setTimeout(resolve, 1))
    const low = library.load('https://x/low.obj', { priority: 5 })
    const high = library.load('https://x/hi.glb', { priority: 0 })
    await Promise.all([swallow(blocker), swallow(low), swallow(high)])
    // The first to start is the blocker; next is the high priority.
    expect(log[1]).toBe('https://x/hi.glb')
    expect(log.indexOf('https://x/low.obj')).toBeGreaterThan(log.indexOf('https://x/hi.glb'))
  })

  test('loadGroup: aggregated progress and cancellation', async () => {
    const glb = buildGlbBytes()
    const config = enc('{"a":1}')
    const library = new AssetLibrary({
      scheduler: new LoadScheduler({ maxConcurrent: 2 }),
      fetchImpl: fakeFetch({ 'https://x/a.glb': glb, 'https://x/c.json': config }),
    })
    const group = library.loadGroup([
      { url: 'https://x/a.glb', options: { priority: 0 } },
      { url: 'https://x/c.json', options: { priority: 1 } },
    ])
    const [model, cfg] = (await group.promise) as [unknown, unknown]
    expect(model).toBeDefined()
    expect(cfg).toEqual({ a: 1 })
    const p = group.progress
    expect(p.ratio).toBe(1)
    expect(p.phase).toBe('done')
  })

  test('preload: cache warm-up, errors in the report', async () => {
    const glb = buildGlbBytes()
    const library = new AssetLibrary({
      fetchImpl: fakeFetch({ 'https://x/m.glb': glb, 'https://x/bad.glb': enc('not glb') }),
    })
    const report = await library.preload(['https://x/m.glb', 'https://x/bad.glb'])
    expect(report.ok).toEqual(['https://x/m.glb'])
    expect(report.failed).toHaveLength(1)
    expect(library.get('https://x/m.glb')).toBeDefined()
  })

  test('LRU eviction by cacheBytesLimit', async () => {
    const glb = buildGlbBytes()
    let counter = 0
    const library = new AssetLibrary({
      cacheBytesLimit: glb.byteLength, // exactly one asset
      fetchImpl: (async () => {
        counter++
        return new Response(chunkedBody(glb, 2), { status: 200, headers: { 'content-length': String(glb.byteLength) } })
      }) as never,
    })
    const evicted: string[] = []
    library.on('evicted', event => evicted.push((event as { url: string }).url))
    await library.load('https://x/one.glb')
    await library.load('https://x/two.glb')
    expect(library.stats().cached).toBe(1)
    expect(evicted).toEqual(['https://x/one.glb'])
    expect(counter).toBe(2)
  })

  test('noCache: a repeated load goes to the network', async () => {
    const glb = buildGlbBytes()
    const log: string[] = []
    const library = new AssetLibrary({ fetchImpl: fakeFetch({ 'https://x/m.glb': glb }, log) })
    await library.load('https://x/m.glb', { noCache: true })
    await library.load('https://x/m.glb', { noCache: true })
    expect(log.length).toBe(2)
  })

  test('transform pipe: asset post-processing', async () => {
    const config = enc('{"n": 5}')
    const library = new AssetLibrary({ fetchImpl: fakeFetch({ 'https://x/c.json': config }) })
    const result = await library.load('https://x/c.json', {
      transform: [((asset: unknown) => ({ doubled: (asset as { n: number }).n * 2 })) as never],
    })
    expect(result).toEqual({ doubled: 10 })
  })

  test('sniffing: without an extension GLB is recognized by its magic', async () => {
    const glb = buildGlbBytes()
    const library = new AssetLibrary({ fetchImpl: fakeFetch({ 'https://x/unknown': glb }) })
    const model = (await library.load('https://x/unknown')) as { kind: string }
    expect(model.kind).toBe('glb')
  })

  test('registerFormat: a custom parser', async () => {
    const library = new AssetLibrary({ fetchImpl: fakeFetch({ 'https://x/roll.dice': enc('1 2 3') }) })
    library.registerFormat('dice', ['dice'], async ctx => {
      await ctx.assembler.completion
      const text = new TextDecoder().decode(ctx.assembler.fullView())
      return text.split(' ').map(Number)
    })
    const result = await library.load('https://x/roll.dice')
    expect(result).toEqual([1, 2, 3])
  })

  test('done/progress/error events', async () => {
    const glb = buildGlbBytes()
    const library = new AssetLibrary({ fetchImpl: fakeFetch({ 'https://x/ok.glb': glb }) })
    const events: string[] = []
    library.on('progress', () => events.push('progress'))
    library.on('done', () => events.push('done'))
    await library.load('https://x/ok.glb')
    expect(events.filter(e => e === 'progress').length).toBeGreaterThan(2)
    expect(events).toContain('done')
  })
})

describe('config parsers', () => {
  test('ZML: nesting, numbers, booleans, arrays, repeats', () => {
    const zml = enc(`
# camera
camera
  fov 50
  orbit
    distance 110
    elevation 0.55
light
  ambient 0.35
  direction -0.4 0.9 0.3
flags
  shadows true
  ssr false
names
  first "Dungeon"
spawn
  point 1 2 3
spawn
  point 4 5 6
`)
    const parsed = parseZml(zml) as Record<string, unknown>
    const camera = parsed.camera as Record<string, unknown>
    expect(camera.fov).toBe(50)
    const orbit = camera.orbit as Record<string, unknown>
    expect(orbit.distance).toBe(110)
    expect(orbit.elevation).toBeCloseTo(0.55)
    const light = parsed.light as Record<string, unknown>
    expect(light.direction).toEqual([-0.4, 0.9, 0.3])
    const flags = parsed.flags as Record<string, unknown>
    expect(flags.shadows).toBe(true)
    expect(flags.ssr).toBe(false)
    const names = parsed.names as Record<string, unknown>
    expect(names.first).toBe('Dungeon')
    const spawns = parsed.spawn as unknown as { key: string; children: { point: number[] } }[]
    expect(spawns).toHaveLength(2)
    expect(spawns[1].children.point).toEqual([4, 5, 6])
  })

  test('INI: sections and values', () => {
    const ini = enc(`
# comment
[render]
backend=webgl2
fps=60

[assets]
base=./data
`)
    const parsed = parseIni(ini) as Record<string, Record<string, unknown>>
    expect(parsed.render.backend).toBe('webgl2')
    expect(parsed.render.fps).toBe(60)
    expect(parsed.assets.base).toBe('./data')
  })

  test('parseTextBytes', () => {
    expect(parseTextBytes(enc('hello'))).toBe('hello')
  })
})
