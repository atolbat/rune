import { describe, expect, it } from 'bun:test'
import { createWebGL2Renderer } from '../src/index.ts'
import type { Texture, TextureView } from '../src/index.ts'
import { createRecordingGL } from '@rune/webgl2'
import { createJournal } from '@rune/core'

/**
 * Task 58: TextureView public handle — `texture.createView()` на обоих бэкендах.
 *
 * Контракт:
 *  - Texture.createView({ baseMipLevel?, mipLevelCount? }) → TextureView
 *  - TextureView.viewId ≥ 1_000_000 (disjoint namespace с textureId < 1M)
 *  - TextureView.dispose() → deleteTextureView(viewId) на facade. Идемпотентно.
 *  - Texture.dispose() → cascade dispose всех sub-views (для симметрии API).
 *
 * Паритет WebGPU ↔ WebGL2:
 *  - WebGPU: нативный GPUTextureView с baseMipLevel/mipLevelCount.
 *  - WebGL2 (Task 56): эмуляция через TEXTURE_BASE_LEVEL/MAX_LEVEL при bind.
 *  - В обоих случаях bindTexture(viewId) работает одинаково.
 */

function fakeCanvas(): HTMLCanvasElement {
  return { clientWidth: 800, clientHeight: 600, width: 0, height: 0 } as unknown as HTMLCanvasElement
}

describe('Task 58 — Texture.createView() public handle', () => {
  it('createView без опций → TextureView с viewId ≥ 1_000_000', () => {
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    const tex = renderer.texture(256, 256, { mipLevels: 9 })
    const view = tex.createView()

    expect(view).toBeDefined()
    expect(view.viewId).toBeGreaterThanOrEqual(1_000_000)
    expect(view.textureId).toBe(tex.textureId)
    expect(view.baseMipLevel).toBe(0) // default
    expect(view.mipLevelCount).toBeUndefined() // default = all remaining
    renderer.stop()
  })

  it('createView с baseMipLevel=4 → view.baseMipLevel=4', () => {
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    const tex = renderer.texture(256, 256, { mipLevels: 9 })
    const view = tex.createView({ baseMipLevel: 4 })

    expect(view.baseMipLevel).toBe(4)
    // RecordingFacade записала вызов createTextureView
    const viewCall = recording.calls.find(c => c.startsWith('createTextureView'))
    expect(viewCall).toBeDefined()
    expect(viewCall).toContain('mip=4')
    renderer.stop()
  })

  it('createView с baseMipLevel+mipLevelCount → оба записаны', () => {
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    const tex = renderer.texture(256, 256, { mipLevels: 9 })
    const view = tex.createView({ baseMipLevel: 2, mipLevelCount: 3 })

    expect(view.baseMipLevel).toBe(2)
    expect(view.mipLevelCount).toBe(3)
    const viewCall = recording.calls.find(c => c.startsWith('createTextureView'))
    expect(viewCall).toContain('mip=2+3')
    renderer.stop()
  })

  it('createView возвращает разные viewId для разных вызовов', () => {
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    const tex = renderer.texture(256, 256, { mipLevels: 9 })
    const v1 = tex.createView({ baseMipLevel: 1 })
    const v2 = tex.createView({ baseMipLevel: 4 })

    expect(v1.viewId).not.toBe(v2.viewId)
    expect(v2.viewId).toBeGreaterThan(v1.viewId)
    renderer.stop()
  })

  it('TextureView.dispose() → deleteTextureView на facade', () => {
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    const tex = renderer.texture(256, 256, { mipLevels: 9 })
    const view = tex.createView({ baseMipLevel: 4 })

    view.dispose()

    const deleteViewCall = recording.calls.find(c => c.startsWith('deleteTextureView'))
    expect(deleteViewCall).toBeDefined()
    expect(deleteViewCall).toContain(String(view.viewId))
    renderer.stop()
  })

  it('TextureView.dispose() идемпотентно — повторный вызов no-op', () => {
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    const tex = renderer.texture(256, 256, { mipLevels: 9 })
    const view = tex.createView({ baseMipLevel: 4 })

    view.dispose()
    view.dispose() // повторный — no-op
    view.dispose() // третий — no-op

    // Только один deleteTextureView в журнале вызовов
    const deleteCalls = recording.calls.filter(c => c.startsWith('deleteTextureView'))
    expect(deleteCalls.length).toBe(1)
    renderer.stop()
  })

  it('Texture.dispose() → cascade dispose всех sub-views', () => {
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    const tex = renderer.texture(256, 256, { mipLevels: 9 })
    const v1 = tex.createView({ baseMipLevel: 1 })
    const v2 = tex.createView({ baseMipLevel: 4 })
    const v3 = tex.createView({ baseMipLevel: 8 })

    // dispose parent texture → должны освободиться и все views
    tex.dispose()

    // Три deleteTextureView (для v1, v2, v3) + один deleteTexture.
    // ВАЖНО: фильтр с exact prefix — 'deleteTexture' ловит и 'deleteTextureView'.
    const deleteViewCalls = recording.calls.filter(c => c.startsWith('deleteTextureView(')).length
    expect(deleteViewCalls).toBe(3)
    const deleteTexCalls = recording.calls.filter(c => c.startsWith('deleteTexture(')).length
    expect(deleteTexCalls).toBe(1)

    // И сами view handles — помечены как disposed (повторный dispose → no-op)
    expect(() => v1.dispose()).not.toThrow()
    expect(() => v2.dispose()).not.toThrow()
    expect(() => v3.dispose()).not.toThrow()
    // Количество deleteTextureView не выросло после повторных dispose
    const deleteViewCallsAfter = recording.calls.filter(c => c.startsWith('deleteTextureView(')).length
    expect(deleteViewCallsAfter).toBe(3)
    renderer.stop()
  })

  it('createView после dispose parent texture → facade бросает или no-op (но handle не создаётся)', () => {
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    const tex = renderer.texture(256, 256, { mipLevels: 9 })
    tex.dispose()

    // Recording facade не бросает (она no-op для невалидного textureId),
    // но реальный realGL бросил бы. На recording — возвращается фейковый viewId.
    // Главное — handle не ломает API, даже если parent умер.
    expect(() => tex.createView({ baseMipLevel: 1 })).not.toThrow()
    renderer.stop()
  })

  it('Journal-интеграция: createView пишет createTextureView опс при включённом journal', () => {
    const journal = createJournal()
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
      journal,
    })
    const tex = renderer.texture(256, 256, { mipLevels: 9 })
    const view = tex.createView({ baseMipLevel: 4, mipLevelCount: 2 })
    view.dispose()

    const ops = journal.entries()
    // createTexture (от texture()), createTextureView, destroyTextureView (от view.dispose())
    const createTexOps = ops.filter(op => op.kind === 'createTexture')
    const createViewOps = ops.filter(op => op.kind === 'createTextureView')
    const destroyViewOps = ops.filter(op => op.kind === 'destroyTextureView')
    expect(createTexOps.length).toBe(1)
    expect(createViewOps.length).toBe(1)
    expect(destroyViewOps.length).toBe(1)
    const cv = createViewOps[0] as Extract<typeof createViewOps[number], { kind: 'createTextureView' }>
    expect(cv.textureId).toBe(tex.textureId)
    expect(cv.baseMipLevel).toBe(4)
    expect(cv.mipLevelCount).toBe(2)
    renderer.stop()
  })
})
