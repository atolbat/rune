import { describe, expect, it } from 'bun:test'
import { createRenderer, createWebGL2Renderer } from '../src/index.ts'
import type { TextureView } from '../src/index.ts'
import { createRecordingGL } from '@rune/webgl2'
import { createRecordingGPU } from '@rune/webgpu'
import { createResourceJournal } from '@rune/core'

/**
 * Task 64: attachView — handle над УЖЕ существующим стабильным viewId.
 *
 * Проблема (репорт пользователя): сцены «sub-mip view» / «create view» не
 * восстанавливались после device-loss. Журнал replay-ил view.create корректно
 * (report.viewIds), но:
 *  (а) демо проверяло только report.textureIds — viewId (≥1M) туда не попадает;
 *  (б) в library не было API получить TextureView-handle над восстановленным
 *      view (attachTexture есть, attachView — не было).
 *
 * Контракт attachView:
 *  - НЕ создаёт GPU-ресурс и НЕ пишет в журнал (view.create-опс уже там);
 *  - возвращает TextureView { viewId, textureId, baseMipLevel, mipLevelCount };
 *  - dispose() → deleteTextureView(viewId) на фасаде (сессия запишет
 *    view.destroy — пара для compact). Идемпотентно.
 *
 * Паритет: WebGL2 (delegate на inner.attachView) и WebGPU (inline
 * makeGpuTextureViewHandle в unified renderer).
 */

function fakeCanvas(): HTMLCanvasElement {
  return { clientWidth: 800, clientHeight: 600, width: 0, height: 0 } as unknown as HTMLCanvasElement
}

const COMMON = { observeResize: false, requestFrame: () => () => {}, now: () => 0 }

function makeGLRenderer(recording: ReturnType<typeof createRecordingGL>, resources?: ReturnType<typeof createResourceJournal>) {
  return createWebGL2Renderer({
    canvas: fakeCanvas(),
    createGL: () => recording.gl,
    ...COMMON,
    ...(resources !== undefined ? { resources } : {}),
  })
}

describe('Task 64 — attachView (WebGL2)', () => {
  it('attachView над живым view: поля handle корректны, GPU-ресурс НЕ создаётся', () => {
    const recording = createRecordingGL()
    const renderer = makeGLRenderer(recording)
    const tex = renderer.texture(256, 256, { mipLevels: 9 })
    const view = tex.createView({ baseMipLevel: 4, mipLevelCount: 3 })
    const createsBefore = recording.calls.filter(c => c.startsWith('createTextureView')).length
    expect(createsBefore).toBe(1)

    const attached = renderer.attachView(view.viewId, tex.textureId, 4, 3)

    // attach не создаёт GPU-ресурс: createTextureView вызывался ровно один раз
    expect(recording.calls.filter(c => c.startsWith('createTextureView')).length).toBe(1)
    expect(attached.viewId).toBe(view.viewId)
    expect(attached.textureId).toBe(tex.textureId)
    expect(attached.baseMipLevel).toBe(4)
    expect(attached.mipLevelCount).toBe(3)
    renderer.stop()
  })

  it('attachView.dispose() → deleteTextureView(viewId) ровно один раз; повторный dispose — no-op', () => {
    const recording = createRecordingGL()
    const renderer = makeGLRenderer(recording)
    const tex = renderer.texture(256, 256, { mipLevels: 9 })
    const view = tex.createView({ baseMipLevel: 4, mipLevelCount: 3 })
    const attached = renderer.attachView(view.viewId, tex.textureId, 4, 3)

    attached.dispose()
    attached.dispose() // идемпотентно

    const deletes = recording.calls.filter(c => c.startsWith('deleteTextureView'))
    expect(deletes.length).toBe(1)
    expect(deletes[0]).toContain(String(view.viewId))
    // attach НЕ должен вызвать createTextureView
    expect(recording.calls.filter(c => c.startsWith('createTextureView')).length).toBe(1)
    renderer.stop()
  })

  it('attachView через unified Renderer (GL-путь) — делегирует на inner', async () => {
    const recording = createRecordingGL()
    const r = createRenderer({
      canvas: fakeCanvas(),
      backend: 'webgl2',
      createGL: () => recording.gl,
      ...COMMON,
    })
    await r.start()
    const tex = r.texture(256, 256, { mipLevels: 9 })
    const view = tex.createView({ baseMipLevel: 2, mipLevelCount: 5 })
    const attached = r.attachView(view.viewId, tex.textureId, 2, 5)
    expect(attached.viewId).toBe(view.viewId)
    attached.dispose()
    expect(recording.calls.filter(c => c.startsWith('deleteTextureView')).length).toBe(1)
    r.stop()
  })

  it('ПОЛНЫЙ recovery-цикл view-сцены: loss → restore → те же стабильные id → attach → dispose → compact() = 0', () => {
    const journal = createResourceJournal()

    // ── Сессия A (до потери): texture + view через public API ──
    const recA = createRecordingGL()
    const rendererA = makeGLRenderer(recA, journal)
    const tex = rendererA.texture(256, 256, { mipLevels: 9 })
    const view = tex.createView({ baseMipLevel: 4, mipLevelCount: 3 })
    const texId = tex.textureId
    const viewId = view.viewId
    expect(journal.size).toBe(2) // texture.create + view.create
    rendererA.stop()

    // ── Потеря устройства: новый фасад, ТОТ ЖЕ журнал ──
    const recB = createRecordingGL()
    const rendererB = makeGLRenderer(recB, journal)
    const restoreFn = rendererB.restoreResources
    expect(restoreFn).toBeDefined()
    const report = restoreFn!.call(rendererB)

    // Стабильные id совпадают ПО ПОСТРОЕНИЮ — включая VIEW id (ядро Task 64)
    expect(report).not.toBeNull()
    expect(report.textureIds).toContain(texId)
    expect(report.viewIds).toContain(viewId)
    // replay на свежем фасаде реально создал ресурсы
    expect(recB.calls.filter(c => c.startsWith('createTexture(')).length).toBe(1)
    expect(recB.calls.filter(c => c.startsWith('createTextureView(')).length).toBe(1)

    // ── Возврат сцены: attachTexture (parent) + attachView (view) ──
    const parentHandle = rendererB.attachTexture(texId, 256, 256, 9)
    const viewHandle = rendererB.attachView(viewId, texId, 4, 3)
    expect(viewHandle.viewId).toBe(viewId)
    // attach'и не создают новых GPU-ресурсов и не пишут опсы
    expect(journal.size).toBe(2)
    expect(recB.calls.filter(c => c.startsWith('createTextureView(')).length).toBe(1)

    // ── Dispose сцены: view.destroy + texture.destroy попадают в журнал ──
    viewHandle.dispose()
    parentHandle.dispose()
    expect(recB.calls.filter(c => c.startsWith('deleteTextureView(')).length).toBe(1)
    expect(recB.calls.filter(c => c.startsWith('deleteTexture(')).length).toBe(1)
    expect(journal.size).toBe(4) // + view.destroy + texture.destroy

    // ── compact: пары create→destroy вылетают, журнал чист ──
    journal.compact()
    expect(journal.size).toBe(0)
    rendererB.stop()
  })

  it('attachView с defaults: baseMipLevel=0, mipLevelCount=undefined', () => {
    const recording = createRecordingGL()
    const renderer = makeGLRenderer(recording)
    const tex = renderer.texture(64, 64, { mipLevels: 7 })
    const attached: TextureView = renderer.attachView(1_000_000, tex.textureId)
    expect(attached.baseMipLevel).toBe(0)
    expect(attached.mipLevelCount).toBeUndefined()
    attached.dispose()
    expect(recording.calls.filter(c => c.startsWith('deleteTextureView')).length).toBe(1)
    renderer.stop()
  })
})

describe('Task 64 — attachView (WebGPU-путь unified renderer)', () => {
  it('attachView → handle над стабильным viewId; dispose → deleteTextureView (без createTextureView)', async () => {
    const original = (globalThis as { navigator?: unknown }).navigator
    ;(globalThis as { navigator?: unknown }).navigator = { gpu: { requestAdapter: async () => ({}) } }
    try {
      const { gpu, calls } = createRecordingGPU()
      const r = createRenderer({
        canvas: fakeCanvas(),
        backend: 'webgpu',
        createGPU: async () => gpu,
        ...COMMON,
      })
      await r.start()

      const attached = r.attachView(1_000_001, 1, 2, 5)
      expect(attached.viewId).toBe(1_000_001)
      expect(attached.textureId).toBe(1)
      expect(attached.baseMipLevel).toBe(2)
      expect(attached.mipLevelCount).toBe(5)
      // attach НЕ создаёт GPU-view
      expect(calls.filter(c => c.startsWith('createTextureView')).length).toBe(0)

      attached.dispose()
      attached.dispose() // идемпотентно
      const deletes = calls.filter(c => c.startsWith('deleteTextureView'))
      expect(deletes.length).toBe(1)
      expect(deletes[0]).toBe('deleteTextureView(1000001)')
      r.stop()
    } finally {
      ;(globalThis as { navigator?: unknown }).navigator = original
    }
  })

  it('createView (GPU-путь) по-прежнему создаёт view через фасад — regression create/attach разделения', async () => {
    const original = (globalThis as { navigator?: unknown }).navigator
    ;(globalThis as { navigator?: unknown }).navigator = { gpu: { requestAdapter: async () => ({}) } }
    try {
      const { gpu, calls } = createRecordingGPU()
      const r = createRenderer({
        canvas: fakeCanvas(),
        backend: 'webgpu',
        createGPU: async () => gpu,
        ...COMMON,
      })
      await r.start()
      const tex = r.texture(256, 256, { mipLevels: 9 })
      const view = tex.createView({ baseMipLevel: 4, mipLevelCount: 2 })
      expect(view.viewId).toBeGreaterThanOrEqual(1_000_000)
      expect(view.textureId).toBe(tex.textureId)
      expect(calls.filter(c => c.startsWith('createTextureView(')).length).toBe(1)
      view.dispose()
      expect(calls.filter(c => c.startsWith('deleteTextureView(')).length).toBe(1)
      r.stop()
    } finally {
      ;(globalThis as { navigator?: unknown }).navigator = original
    }
  })
})
