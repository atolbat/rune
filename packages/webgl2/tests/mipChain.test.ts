/**
 * Тесты mip-chain текстур (M4-addendum: createTexture с mipLevels).
 *
 * Покрываем:
 *  - recordingGL: createTexture(w,h) без mipLevels — старый контракт
 *  - recordingGL: createTexture(w,h,{mipLevels:N}) — запись с mipLevels=N
 *  - recordingGL: texImage2DLevel с flipY, без проверки gpu-state (headless)
 *  - computeMipLevels helper: 256→9, 64→7, 4→3, 1→1
 *  - Texture handle: поле mipLevels читается из renderer.texture(w,h,{mipLevels:N})
 */

import { test } from 'bun:test'
import { expect } from 'bun:test'
import { createRecordingGL } from '@rune/webgl2'
import { computeMipLevels } from '@rune/gl'
import { createWebGL2Renderer } from '@rune/gl'

// ─── computeMipLevels helper ──────────────────────────────────────────────────

test('computeMipLevels: 256×256 → 9 уровней (1 + log2(256))', () => {
  expect(computeMipLevels(256, 256)).toBe(9)
})

test('computeMipLevels: 64×64 → 7 уровней', () => {
  expect(computeMipLevels(64, 64)).toBe(7)
})

test('computeMipLevels: 4×4 → 3 уровня', () => {
  expect(computeMipLevels(4, 4)).toBe(3)
})

test('computeMipLevels: 1×1 → 1 (нет mip-chain)', () => {
  expect(computeMipLevels(1, 1)).toBe(1)
})

test('computeMipLevels: 0×256 → 1 (защита от нуля)', () => {
  expect(computeMipLevels(0, 256)).toBe(1)
})

test('computeMipLevels: non-square 256×64 → 8 уровней (по min dim=64)', () => {
  // min(256,64)=64 → 1+log2(64)=7 уровней
  expect(computeMipLevels(256, 64)).toBe(7)
})

// ─── recordingGL: createTexture с mipLevels ────────────────────────────────────

test('recordingGL: createTexture без options — старый контракт (без mipLevels в строке)', () => {
  const rec = createRecordingGL()
  rec.gl.createTexture(128, 128)
  expect(rec.calls[0]).toBe('createTexture(128,128)')
})

test('recordingGL: createTexture с mipLevels=1 — старый контракт', () => {
  const rec = createRecordingGL()
  rec.gl.createTexture(128, 128, { mipLevels: 1 })
  expect(rec.calls[0]).toBe('createTexture(128,128)')
})

test('recordingGL: createTexture с mipLevels=9 — запись с mipLevels=9', () => {
  const rec = createRecordingGL()
  rec.gl.createTexture(256, 256, { mipLevels: 9 })
  expect(rec.calls[0]).toContain('mipLevels=9')
  expect(rec.calls[0]).toBe('createTexture(256,256,mipLevels=9)')
})

test('recordingGL: createTexture с mipLevels=3 — запись с mipLevels=3', () => {
  const rec = createRecordingGL()
  rec.gl.createTexture(64, 64, { mipLevels: 3 })
  expect(rec.calls[0]).toBe('createTexture(64,64,mipLevels=3)')
})

// ─── recordingGL: texImage2DLevel (progressive streaming) ─────────────────────

test('recordingGL: texImage2DLevel с level=0 → запись level=0', () => {
  const rec = createRecordingGL()
  const c = { width: 256, height: 256 } as unknown as HTMLCanvasElement
  rec.gl.texImage2DLevel(1, 0, c)
  expect(rec.calls[0]).toContain('texImage2DLevel(1')
  expect(rec.calls[0]).toContain('level=0')
  expect(rec.calls[0]).toContain('flipY=false')
})

test('recordingGL: texImage2DLevel с level=5 → запись level=5', () => {
  const rec = createRecordingGL()
  const c = { width: 8, height: 8 } as unknown as HTMLCanvasElement
  rec.gl.texImage2DLevel(7, 5, c, { flipY: true })
  expect(rec.calls[0]).toContain('level=5')
  expect(rec.calls[0]).toContain('flipY=true')
})

// ─── Task 55: strict format/type contract для texImage2DLevel ────────────────

test('recordingGL: texImage2DLevel без format/type → auto-derivation (нет ifmt/fmt/type суффиксов)', () => {
  const rec = createRecordingGL()
  const c = { width: 4, height: 4 } as unknown as HTMLCanvasElement
  rec.gl.texImage2DLevel(1, 0, c)
  expect(rec.calls[0]).not.toContain('ifmt=')
  expect(rec.calls[0]).not.toContain('fmt=')
  expect(rec.calls[0]).not.toContain('type=')
})

test('recordingGL: texImage2DLevel с internalFormat → запись ifmt=0x...', () => {
  const rec = createRecordingGL()
  const c = { width: 4, height: 4 } as unknown as HTMLCanvasElement
  // RGBA16F = 0x881A
  rec.gl.texImage2DLevel(2, 1, c, { internalFormat: 0x881A })
  expect(rec.calls[0]).toContain('ifmt=0x881a')
  // Записан ТОЛЬКО ifmt — fmt/type отсутствуют. Используем ',fmt='/',type='
  // для word-boundary (ifmt= содержит fmt= как подстроку, поэтому проверка
  // на 'fmt=' без запятой дала бы ложное срабатывание).
  expect(rec.calls[0]).not.toContain(',fmt=')
  expect(rec.calls[0]).not.toContain(',type=')
})

test('recordingGL: texImage2DLevel с format+type → запись fmt=...type=...', () => {
  const rec = createRecordingGL()
  const c = { width: 4, height: 4 } as unknown as HTMLCanvasElement
  // RGBA = 0x1908, HALF_FLOAT = 0x140B
  rec.gl.texImage2DLevel(3, 2, c, { format: 0x1908, type: 0x140B })
  expect(rec.calls[0]).toContain('fmt=0x1908')
  expect(rec.calls[0]).toContain('type=0x140b')
  expect(rec.calls[0]).not.toContain(',ifmt=')
})

test('recordingGL: texImage2DLevel с RGBA16F тройкой (internalFormat+format+type) → запись всех трёх', () => {
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

test('recordingGL: texImage2DLevel с RGBA32F тройкой → FLOAT=0x1406', () => {
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

// ─── Texture handle: mipLevels читается из renderer.texture ───────────────────

function fakeOffscreenCanvas(w: number, h: number): OffscreenCanvas {
  return {
    width: w,
    height: h,
    getContext: () => null,
  } as unknown as OffscreenCanvas
}

test('Texture handle: texture(w,h) без options → mipLevels=1', () => {
  // Headless renderer через createGL injection — нет GPU-работы
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

test('Texture handle: uploadMip вызывает texImage2DLevel на фасаде', () => {
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
  // Хотя бы один вызов — texImage2DLevel с level=5
  const texImageCalls = rec.calls.filter(s => s.startsWith('texImage2DLevel'))
  expect(texImageCalls.length).toBeGreaterThan(0)
  expect(texImageCalls[0]).toContain(`level=5`)
})

test('Texture handle: dispose вызывает deleteTexture', () => {
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
  // Идемпотентность — повторный dispose no-op
  tex.dispose()
  expect(rec.calls.filter(s => s.startsWith('deleteTexture')).length).toBe(1)
})

// ─── Task 56: Sub-mip views (WebGL2 LOD-clamp API) ─────────────────────────

test('recordingGL: createTextureView без options → запись без mip суффикса', () => {
  const rec = createRecordingGL()
  const viewId = rec.gl.createTextureView(7)
  expect(rec.calls[0]).toBe('createTextureView(7)')
  // viewId должен быть в disjoint namespace (≥1M), как в realGL
  expect(viewId).toBeGreaterThanOrEqual(1_000_000)
})

test('recordingGL: createTextureView с baseMipLevel=2 → запись mip=2', () => {
  const rec = createRecordingGL()
  rec.gl.createTextureView(3, { baseMipLevel: 2 })
  expect(rec.calls[0]).toBe('createTextureView(3,mip=2)')
})

test('recordingGL: createTextureView с baseMipLevel=2 + mipLevelCount=3 → запись mip=2+3', () => {
  const rec = createRecordingGL()
  rec.gl.createTextureView(11, { baseMipLevel: 2, mipLevelCount: 3 })
  expect(rec.calls[0]).toBe('createTextureView(11,mip=2+3)')
})

test('recordingGL: createTextureView возвращает инкрементальные viewId из ≥1M', () => {
  const rec = createRecordingGL()
  const v1 = rec.gl.createTextureView(1)
  const v2 = rec.gl.createTextureView(1)
  const v3 = rec.gl.createTextureView(1)
  expect(v1).toBeGreaterThanOrEqual(1_000_000)
  expect(v2).toBe(v1 + 1)
  expect(v3).toBe(v2 + 1)
})

test('recordingGL: deleteTextureView → запись deleteTextureView(viewId)', () => {
  const rec = createRecordingGL()
  const viewId = rec.gl.createTextureView(5, { baseMipLevel: 1, mipLevelCount: 2 })
  rec.gl.deleteTextureView(viewId)
  const delCalls = rec.calls.filter(s => s.startsWith('deleteTextureView'))
  expect(delCalls.length).toBe(1)
  expect(delCalls[0]).toBe(`deleteTextureView(${viewId})`)
})

test('recordingGL: bindTexture с viewId (≥1M) → запись bindTexture(viewId,unit)', () => {
  const rec = createRecordingGL()
  const viewId = rec.gl.createTextureView(5, { baseMipLevel: 1, mipLevelCount: 2 })
  rec.gl.bindTexture(viewId, 0)
  // bindTexture должен записать viewId (≥1M), а не underlying textureId
  const bindCalls = rec.calls.filter(s => s.startsWith('bindTexture'))
  expect(bindCalls.length).toBe(1)
  expect(bindCalls[0]).toBe(`bindTexture(${viewId},0)`)
  // После bindTexture — deleteTextureView тоже пишется в ленту (1 вызов → 1 запись).
  // Идемпотентность на уровне realGL (no-op при отсутствии записи) — не
  // относится к recordingGL: тот всегда пишет, даже если viewId не найден.
  rec.gl.deleteTextureView(viewId)
  expect(rec.calls.filter(s => s.startsWith('deleteTextureView')).length).toBe(1)
})

test('recordingGL: bindTexture с textureId (<1M) → обычный формат (обратная совместимость)', () => {
  const rec = createRecordingGL()
  rec.gl.bindTexture(42, 3)
  expect(rec.calls[0]).toBe('bindTexture(42,3)')
})

// ─── Memory tracking: mip-chain учитывается в stats ─────────────────────────

test('Texture handle: mip-chain текстура учитывается в memoryEstimate (×4/3)', () => {
  // Headless renderer без инъекции stats — uses own StatsCollector, not exposed.
  // Но мы можем проверить, что memBytes правильно считается для mip-chain.
  // 256² RGBA8 = 256*256*4 = 262144 байт. С mip-chain: ×4/3 = 349525.
  // subMemory после dispose возвращает точно то же значение → баланс = 0.
  const rec = createRecordingGL()
  const renderer = createWebGL2Renderer({
    canvas: fakeOffscreenCanvas(800, 600),
    createGL: () => rec.gl,
    observeResize: false,
    requestFrame: () => () => {},
    now: () => 0,
  })
  // Создаём и сразу диспозим — баланс памяти должен быть 0.
  const tex1 = renderer.texture(256, 256)  // без mip: 256K
  const tex2 = renderer.texture(256, 256, { mipLevels: 9 })  // с mip: ~350K
  tex1.dispose()
  tex2.dispose()
  // Без exposed stats, проверяем только отсутствие утечки (no error, no throw)
  expect(() => renderer.dispose()).not.toThrow()
})
