import { test, expect } from 'bun:test'
import { fakeFetch } from './helpers.ts'

/**
 * Legacy API (loadImage/loadJSON/loadArrayBuffer) — on top of the general manager.
 * Globals are stubbed BEFORE the dynamic import of the package: the default platform
 * capabilities are read when the manager is created.
 */

const realFetch = globalThis.fetch
const realCreateImageBitmap = (globalThis as { createImageBitmap?: unknown }).createImageBitmap

const IMG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])

async function setup(): Promise<typeof import('../src/index.ts')> {
  globalThis.fetch = fakeFetch({
    'http://t/pic.png': { body: IMG_BYTES },
    'http://t/cfg.json': { body: '{"ok":true,"n":42}' },
    'http://t/blob.bin': { body: new Uint8Array([9, 8, 7]) },
  }) as typeof fetch
  ;(globalThis as { createImageBitmap?: unknown }).createImageBitmap = async (source: Blob) => {
    const bytes = new Uint8Array(await source.arrayBuffer())
    expect(Array.from(bytes)).toEqual(Array.from(IMG_BYTES))
    return { width: 3, height: 2 } as ImageBitmap
  }
  return await import('../src/index.ts')
}

function teardown(): void {
  globalThis.fetch = realFetch
  ;(globalThis as { createImageBitmap?: unknown }).createImageBitmap = realCreateImageBitmap
}

test('loadImage: fetch + createImageBitmap', async () => {
  const mod = await setup()
  try {
    const bitmap = await mod.loadImage('http://t/pic.png')
    expect(bitmap.width).toBe(3)
    expect(bitmap.height).toBe(2)
  } finally {
    teardown()
  }
})

test('loadJSON: parsing a config', async () => {
  const mod = await setup()
  try {
    const cfg = await mod.loadJSON<{ ok: boolean; n: number }>('http://t/cfg.json')
    expect(cfg.ok).toBe(true)
    expect(cfg.n).toBe(42)
  } finally {
    teardown()
  }
})

test('loadArrayBuffer: raw bytes', async () => {
  const mod = await setup()
  try {
    const buffer = await mod.loadArrayBuffer('http://t/blob.bin')
    expect(Array.from(new Uint8Array(buffer))).toEqual([9, 8, 7])
  } finally {
    teardown()
  }
})

test('loadImage: HTTP error → reject', async () => {
  globalThis.fetch = fakeFetch({ 'http://t/missing.png': { status: 404, body: '' } }) as typeof fetch
  const mod = await import('../src/index.ts')
  try {
    await expect(mod.loadImage('http://t/missing.png')).rejects.toThrow('404')
  } finally {
    teardown()
  }
})
