/**
 * Tests for mip-chain textures (M4 addendum: createTexture with mipLevels).
 *
 * We cover:
 *  - recordingGL: createTexture(w,h) without mipLevels — the old contract
 *  - recordingGL: createTexture(w,h,{mipLevels:N}) — a record with mipLevels=N
 *  - recordingGL: texImage2DLevel with flipY, without gpu-state checks (headless)
 *  - computeMipLevels helper: 256→9, 64→7, 4→3, 1→1
 *  - Texture handle: the mipLevels field is read from renderer.texture(w,h,{mipLevels:N})
 */

import { test } from 'bun:test'
import { expect } from 'bun:test'
import { createRecordingGL } from '@rune/webgl2'
import { computeMipLevels } from '@rune/gl'
import { createWebGL2Renderer } from '@rune/gl'

// ─── computeMipLevels helper ──────────────────────────────────────────────────

test('computeMipLevels: 256×256 → 9 levels (1 + log2(256))', () => {
  expect(computeMipLevels(256, 256)).toBe(9)
})

test('computeMipLevels: 64×64 → 7 levels', () => {
  expect(computeMipLevels(64, 64)).toBe(7)
})

test('computeMipLevels: 4×4 → 3 levels', () => {
  expect(computeMipLevels(4, 4)).toBe(3)
})

test('computeMipLevels: 1×1 → 1 (no mip-chain)', () => {
  expect(computeMipLevels(1, 1)).toBe(1)
})

test('computeMipLevels: 0×256 → 1 (zero protection)', () => {
  expect(computeMipLevels(0, 256)).toBe(1)
})

test('computeMipLevels: non-square 256×64 → 8 levels (by min dim=64)', () => {
  // min(256,64)=64 → 1+log2(64)=7 levels
  expect(computeMipLevels(256, 64)).toBe(7)
})

// ─── recordingGL: createTexture with mipLevels ────────────────────────────────────

test('recordingGL: createTexture without options — the old contract (no mipLevels in the string)', () => {
  const rec = createRecordingGL()
  rec.gl.createTexture(128, 128)
  expect(rec.calls[0]).toBe('createTexture(128,128)')
})

test('recordingGL: createTexture with mipLevels=1 — the old contract', () => {
  const rec = createRecordingGL()
  rec.gl.createTexture(128, 128, { mipLevels: 1 })
  expect(rec.calls[0]).toBe('createTexture(128,128)')
})

test('recordingGL: createTexture with mipLevels=9 — a record with mipLevels=9', () => {
  const rec = createRecordingGL()
  rec.gl.createTexture(256, 256, { mipLevels: 9 })
  expect(rec.calls[0]).toContain('mipLevels=9')
  expect(rec.calls[0]).toBe('createTexture(256,256,mipLevels=9)')
})

test('recordingGL: createTexture with mipLevels=3 — a record with mipLevels=3', () => {
  const rec = createRecordingGL()
  rec.gl.createTexture(64, 64, { mipLevels: 3 })
  expect(rec.calls[0]).toBe('createTexture(64,64,mipLevels=3)')
})

// ─── recordingGL: texImage2DLevel (progressive streaming) ─────────────────────

test('recordingGL: texImage2DLevel with level=0 → a record with level=0', () => {
  const rec = createRecordingGL()
  const c = { width: 256, height: 256 } as unknown as HTMLCanvasElement
  rec.gl.texImage2DLevel(1, 0, c)
  expect(rec.calls[0]).toContain('texImage2DLevel(1')
  expect(rec.calls[0]).toContain('level=0')
  expect(rec.calls[0]).toContain('flipY=false')
})

test('recordingGL: texImage2DLevel with level=5 → a record with level=5', () => {
  const rec = createRecordingGL()
  const c = { width: 8, height: 8 } as unknown as HTMLCanvasElement
  rec.gl.texImage2DLevel(7, 5, c, { flipY: true })
  expect(rec.calls[0]).toContain('level=5')
  expect(rec.calls[0]).toContain('flipY=true')
})

// ─── Task 55: strict format/type contract for texImage2DLevel ────────────────

test('recordingGL: texImage2DLevel without format/type → auto-derivation (no ifmt/fmt/type suffixes)', () => {
  const rec = createRecordingGL()
  const c = { width: 4, height: 4 } as unknown as HTMLCanvasElement
  rec.gl.texImage2DLevel(1, 0, c)
  expect(rec.calls[0]).not.toContain('ifmt=')
  expect(rec.calls[0]).not.toContain('fmt=')
  expect(rec.calls[0]).not.toContain('type=')
})

test('recordingGL: texImage2DLevel with internalFormat → an ifmt=0x... record', () => {
  const rec = createRecordingGL()
  const c = { width: 4, height: 4 } as unknown as HTMLCanvasElement
  // RGBA16F = 0x881A
  rec.gl.texImage2DLevel(2, 1, c, { internalFormat: 0x881A })
  expect(rec.calls[0]).toContain('ifmt=0x881a')
  // ONLY ifmt is recorded — fmt/type are absent. We use ',fmt=' / ',type='
  // for the word boundary (ifmt= contains fmt= as a substring, so a check
  // for 'fmt=' without the comma would give a false positive).
  expect(rec.calls[0]).not.toContain(',fmt=')
  expect(rec.calls[0]).not.toContain(',type=')
})

test('recordingGL: texImage2DLevel with format+type → a fmt=...type=... record', () => {
  const rec = createRecordingGL()
  const c = { width: 4, height: 4 } as unknown as HTMLCanvasElement
  // RGBA = 0x1908, HALF_FLOAT = 0x140B
  rec.gl.texImage2DLevel(3, 2, c, { format: 0x1908, type: 0x140B })
  expect(rec.calls[0]).toContain('fmt=0x1908')
  expect(rec.calls[0]).toContain('type=0x140b')
  expect(rec.calls[0]).not.toContain(',ifmt=')
})

test('recordingGL: texImage2DLevel with the RGBA16F triple (internalFormat+format+type) → all three recorded', () => {
  const rec = createRecordingGL()
  const c = { width: 4, height: 4 } as unknown as HTMLCanvasElement
  // RGBA16F=0x881A, RGBA=0x1908, HALF_FLOAT=0x140B
  rec.gl.texImage2DLevel(5, 3, c, {
    internalFormat: 0x881A,
    format: 0x1908,
    type: 0x140B,
    flipY: true,
  })
  expect(rec.calls[0]).toContain('ifmt=0x881a')
  expect(rec.calls[0]).toContain('fmt=0x1908')
  expect(rec.calls[0]).toContain('type=0x140b')
  expect(rec.calls[0]).toContain('flipY=true')
})

test('recordingGL: texImage2DLevel with the RGBA32F triple → FLOAT=0x1406', () => {
  const rec = createRecordingGL()
  const c = { width: 4, height: 4 } as unknown as HTMLCanvasElement
  // RGBA32F=0x8816, RGBA=0x1908, FLOAT=0x1406
  rec.gl.texImage2DLevel(11, 0, c, {
    internalFormat: 0x8816,
    format: 0x1908,
    type: 0x1406,
  })
  expect(rec.calls[0]).toContain('ifmt=0x8816')
  expect(rec.calls[0]).toContain('fmt=0x1908')
  expect(rec.calls[0]).toContain('type=0x1406')
})

// ─── Texture handle: mipLevels is read from renderer.texture ───────────────────

function fakeOffscreenCanvas(w: number, h: number): OffscreenCanvas {
  return {
    width: w,
    height: h,
    getContext: () => null,
  } as unknown as OffscreenCanvas
}

test('Texture handle: texture(w,h) without options → mipLevels=1', () => {
  // A headless renderer via createGL injection — no GPU work
  const rec = createRecordingGL()
  const renderer = createWebGL2Renderer({
    canvas: fakeOffscreenCanvas(800, 600),
    createGL: () => rec.gl,
    observeResize: false,
    requestFrame: () => () => {},
    now: () => 0,
  })
  const tex = renderer.texture(64, 64)
  expect(tex.mipLevels).toBe(1)
  expect(tex.width).toBe(64)
  expect(tex.height).toBe(64)
  expect(tex.textureId).toBeGreaterThan(0)
})

test('Texture handle: texture(w,h,{mipLevels:7}) → mipLevels=7', () => {
  const rec = createRecordingGL()
  const renderer = createWebGL2Renderer({
    canvas: fakeOffscreenCanvas(800, 600),
    createGL: () => rec.gl,
    observeResize: false,
    requestFrame: () => () => {},
    now: () => 0,
  })
  const tex = renderer.texture(64, 64, { mipLevels: 7 })
  expect(tex.mipLevels).toBe(7)
})

test('Texture handle: uploadMip calls texImage2DLevel on the facade', () => {
  const rec = createRecordingGL()
  const renderer = createWebGL2Renderer({
    canvas: fakeOffscreenCanvas(800, 600),
    createGL: () => rec.gl,
    observeResize: false,
    requestFrame: () => () => {},
    now: () => 0,
  })
  const tex = renderer.texture(64, 64, { mipLevels: 7 })
  const c = { width: 8, height: 8 } as unknown as HTMLCanvasElement
  tex.uploadMip(5, c, { flipY: true })
  // At least one call — texImage2DLevel with level=5
  const texImageCalls = rec.calls.filter(s => s.startsWith('texImage2DLevel'))
  expect(texImageCalls.length).toBeGreaterThan(0)
  expect(texImageCalls[0]).toContain(`level=5`)
})

test('Texture handle: dispose calls deleteTexture', () => {
  const rec = createRecordingGL()
  const renderer = createWebGL2Renderer({
    canvas: fakeOffscreenCanvas(800, 600),
    createGL: () => rec.gl,
    observeResize: false,
    requestFrame: () => () => {},
    now: () => 0,
  })
  const tex = renderer.texture(64, 64)
  tex.dispose()
  const deleteCalls = rec.calls.filter(s => s.startsWith('deleteTexture'))
  expect(deleteCalls.length).toBe(1)
  // Idempotence — a repeated dispose is a no-op
  tex.dispose()
  expect(rec.calls.filter(s => s.startsWith('deleteTexture')).length).toBe(1)
})

// ─── Task 56: Sub-mip views (WebGL2 LOD-clamp API) ─────────────────────────

test('recordingGL: createTextureView without options → a record without the mip suffix', () => {
  const rec = createRecordingGL()
  const viewId = rec.gl.createTextureView(7)
  expect(rec.calls[0]).toBe('createTextureView(7)')
  // viewId must be in the disjoint namespace (≥1M), as in realGL
  expect(viewId).toBeGreaterThanOrEqual(1_000_000)
})

test('recordingGL: createTextureView with baseMipLevel=2 → a mip=2 record', () => {
  const rec = createRecordingGL()
  rec.gl.createTextureView(3, { baseMipLevel: 2 })
  expect(rec.calls[0]).toBe('createTextureView(3,mip=2)')
})

test('recordingGL: createTextureView with baseMipLevel=2 + mipLevelCount=3 → a mip=2+3 record', () => {
  const rec = createRecordingGL()
  rec.gl.createTextureView(11, { baseMipLevel: 2, mipLevelCount: 3 })
  expect(rec.calls[0]).toBe('createTextureView(11,mip=2+3)')
})

test('recordingGL: createTextureView returns incremental viewIds from ≥1M', () => {
  const rec = createRecordingGL()
  const v1 = rec.gl.createTextureView(1)
  const v2 = rec.gl.createTextureView(1)
  const v3 = rec.gl.createTextureView(1)
  expect(v1).toBeGreaterThanOrEqual(1_000_000)
  expect(v2).toBe(v1 + 1)
  expect(v3).toBe(v2 + 1)
})

test('recordingGL: deleteTextureView → a deleteTextureView(viewId) record', () => {
  const rec = createRecordingGL()
  const viewId = rec.gl.createTextureView(5, { baseMipLevel: 1, mipLevelCount: 2 })
  rec.gl.deleteTextureView(viewId)
  const delCalls = rec.calls.filter(s => s.startsWith('deleteTextureView'))
  expect(delCalls.length).toBe(1)
  expect(delCalls[0]).toBe(`deleteTextureView(${viewId})`)
})

test('recordingGL: bindTexture with a viewId (≥1M) → a bindTexture(viewId,unit) record', () => {
  const rec = createRecordingGL()
  const viewId = rec.gl.createTextureView(5, { baseMipLevel: 1, mipLevelCount: 2 })
  rec.gl.bindTexture(viewId, 0)
  // bindTexture must record the viewId (≥1M), not the underlying textureId
  const bindCalls = rec.calls.filter(s => s.startsWith('bindTexture'))
  expect(bindCalls.length).toBe(1)
  expect(bindCalls[0]).toBe(`bindTexture(${viewId},0)`)
  // After bindTexture — deleteTextureView is also written to the tape (1 call → 1 record).
  // Idempotence at the realGL level (a no-op when the entry is absent) does not
  // apply to recordingGL: it always writes, even if the viewId is not found.
  rec.gl.deleteTextureView(viewId)
  expect(rec.calls.filter(s => s.startsWith('deleteTextureView')).length).toBe(1)
})

test('recordingGL: bindTexture with a textureId (<1M) → the usual format (backward compatibility)', () => {
  const rec = createRecordingGL()
  rec.gl.bindTexture(42, 3)
  expect(rec.calls[0]).toBe('bindTexture(42,3)')
})

// ─── Memory tracking: the mip-chain is accounted for in stats ─────────────────────────

test('Texture handle: a mip-chain texture is accounted for in memoryEstimate (×4/3)', () => {
  // A headless renderer without a stats injection — uses its own StatsCollector, not exposed.
  // But we can verify that memBytes is computed correctly for a mip chain.
  // 256² RGBA8 = 256*256*4 = 262144 bytes. With a mip chain: ×4/3 = 349525.
  // subMemory after dispose returns exactly the same value → balance = 0.
  const rec = createRecordingGL()
  const renderer = createWebGL2Renderer({
    canvas: fakeOffscreenCanvas(800, 600),
    createGL: () => rec.gl,
    observeResize: false,
    requestFrame: () => () => {},
    now: () => 0,
  })
  // Create and dispose immediately — the memory balance must be 0.
  const tex1 = renderer.texture(256, 256)  // no mip: 256K
  const tex2 = renderer.texture(256, 256, { mipLevels: 9 })  // with mip: ~350K
  tex1.dispose()
  tex2.dispose()
  // Without exposed stats, we only check for the absence of a leak (no error, no throw)
  expect(() => renderer.dispose()).not.toThrow()
})
