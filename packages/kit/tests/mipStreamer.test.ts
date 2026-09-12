import { test, expect, afterEach } from 'bun:test'
import { createMipStreamer } from '../src/mipStreamer.ts'
import type { MipTargetTexture } from '../src/mipStreamer.ts'

// ─── The DOM seam, mocked ────────────────────────────────────────────────────
// bun has neither createImageBitmap nor ImageBitmap — the streamer resolves
// them as bare globals at CALL time, so a class + a function on globalThis
// stand in for the browser here.

class FakeImageBitmap {
  readonly width: number
  readonly height: number
  closed = false
  constructor(width: number, height: number) {
    this.width = width
    this.height = height
  }
  close(): void { this.closed = true }
}

const realImageBitmap = (globalThis as { ImageBitmap?: unknown }).ImageBitmap
const realCreateImageBitmap = (globalThis as { createImageBitmap?: unknown }).createImageBitmap
const resizeCalls: Array<{ w: number; h: number; quality: string }> = []

function installFakes(): void {
  ;(globalThis as { ImageBitmap?: unknown }).ImageBitmap = FakeImageBitmap
  ;(globalThis as { createImageBitmap?: unknown }).createImageBitmap = async (
    _source: unknown,
    options: { resizeWidth: number; resizeHeight: number; resizeQuality: string },
  ) => {
    resizeCalls.push({ w: options.resizeWidth, h: options.resizeHeight, quality: options.resizeQuality })
    return new FakeImageBitmap(options.resizeWidth, options.resizeHeight)
  }
}

afterEach(() => {
  ;(globalThis as { ImageBitmap?: unknown }).ImageBitmap = realImageBitmap
  ;(globalThis as { createImageBitmap?: unknown }).createImageBitmap = realCreateImageBitmap
  resizeCalls.length = 0
})

interface Upload {
  level: number
  src: unknown
  width: number
  height: number
  isSource: boolean
}

function fakeTex(width: number, height: number, source: unknown): MipTargetTexture & { uploads: Upload[] } {
  const uploads: Upload[] = []
  return {
    width,
    height,
    uploads,
    uploadMip(level: number, src: FakeImageBitmap | unknown) {
      const bitmap = src as FakeImageBitmap
      uploads.push({
        level,
        src,
        width: bitmap.width,
        height: bitmap.height,
        isSource: src === source,
      })
    },
  }
}

test('levels, floor dims, the coarse-to-fine order, level 0 = the source itself', async () => {
  installFakes()
  const source = new FakeImageBitmap(1920, 1080)
  const tex = fakeTex(1920, 1080, source)
  await createMipStreamer({ minMipSize: 4 }).streamProgressive(tex, source)

  // 1080 halved to 4 → 8 levels; uploads 8..0 coarse→fine
  expect(tex.uploads.map(u => u.level)).toEqual([8, 7, 6, 5, 4, 3, 2, 1, 0])
  // GPU mip dims are FLOOR(d/2^l) — 1920/256 is 7 (round() would say 8 and
  // overshoot the level's storage)
  expect(tex.uploads[0]).toMatchObject({ level: 8, width: 7, height: 4 })
  // the finest level at the source's size: the source itself, no copy
  expect(tex.uploads[8]).toMatchObject({ level: 0, isSource: true, width: 1920, height: 1080 })
  // exactly 8 resizes — the level-0 copy is NOT made anymore
  expect(resizeCalls.length).toBe(8)
})

test('every downsampled bitmap is closed after its upload (the leak)', async () => {
  installFakes()
  const source = new FakeImageBitmap(512, 512)
  const tex = fakeTex(512, 512, source)
  await createMipStreamer({ minMipSize: 4 }).streamProgressive(tex, source)

  // levels 7..1 are fresh bitmaps (512→4 needs 7 halvings)
  const intermediates = tex.uploads.filter(u => !u.isSource)
  expect(intermediates.length).toBe(7)
  for (const up of intermediates) {
    // uploadMip COPIES the pixels; after the stream the bitmap must be
    // closed — before, the decoded memory was held until GC (engines pin
    // ImageBitmaps outside the JS heap)
    expect((up.src as FakeImageBitmap).closed).toBe(true)
  }
  // the SOURCE is never closed — the caller owns it
  expect(source.closed).toBe(false)
})

test('maxLevels caps the chain', async () => {
  installFakes()
  const source = new FakeImageBitmap(1024, 1024)
  const tex = fakeTex(1024, 1024, source)
  await createMipStreamer({ minMipSize: 4, maxLevels: 2 }).streamProgressive(tex, source)
  // levels 2, 1, 0 — not the full 8-level chain
  expect(tex.uploads.map(u => u.level)).toEqual([2, 1, 0])
})

test('minMipSize 1 streams down to 1x1', async () => {
  installFakes()
  const source = new FakeImageBitmap(1024, 1024)
  const tex = fakeTex(1024, 1024, source)
  await createMipStreamer({ minMipSize: 1 }).streamProgressive(tex, source)
  expect(tex.uploads.map(u => u.level)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0])
  expect(tex.uploads[0]).toMatchObject({ width: 1, height: 1 })
})

test('a source SMALLER than the texture still downsamples level 0 (no direct upload)', async () => {
  installFakes()
  const source = new FakeImageBitmap(256, 256)
  const tex = fakeTex(1024, 1024, source)
  await createMipStreamer({ minMipSize: 4, maxLevels: 0 }).streamProgressive(tex, source)
  // level 0 target is 1024×1024 ≠ the 256×256 source → a resize happens
  expect(tex.uploads.length).toBe(1)
  expect(tex.uploads[0]).toMatchObject({ level: 0, isSource: false, width: 1024, height: 1024 })
  expect((tex.uploads[0].src as FakeImageBitmap).closed).toBe(true)
})
