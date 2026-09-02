import { describe, expect, it } from 'bun:test'
import { createRenderer, createWebGL2Renderer } from '../src/index.ts'
import type { TextureView } from '../src/index.ts'
import { createRecordingGL } from '@rune/webgl2'
import { createRecordingGPU } from '@rune/webgpu'
import { createResourceJournal } from '@rune/core'

/**
 * Task 64: attachView — a handle over an ALREADY existing stable viewId.
 *
 * The problem (user report): the "sub-mip view" / "create view" scenes did not
 * recover after device-loss. The journal replayed view.create correctly
 * (report.viewIds), but:
 *  (a) the demo checked only report.textureIds — the viewId (≥1M) does not get in there;
 *  (b) the library had no API to get a TextureView handle over a restored
 *      view (attachTexture existed, attachView did not).
 *
 * The attachView contract:
 *  - does NOT create a GPU resource and does NOT write to the journal (the view.create op is already there);
 *  - returns TextureView { viewId, textureId, baseMipLevel, mipLevelCount };
 *  - dispose() → deleteTextureView(viewId) on the facade (the session will write
 *    view.destroy — the pair for compact). Idempotent.
 *
 * Parity: WebGL2 (delegate to inner.attachView) and WebGPU (inline
 * makeGpuTextureViewHandle in the unified renderer).
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
  it('attachView over a live view: handle fields are correct, NO GPU resource is created', () => {
    const recording = createRecordingGL()
    const renderer = makeGLRenderer(recording)
    const tex = renderer.texture(256, 256, { mipLevels: 9 })
    const view = tex.createView({ baseMipLevel: 4, mipLevelCount: 3 })
    const createsBefore = recording.calls.filter(c => c.startsWith('createTextureView')).length
    expect(createsBefore).toBe(1)

    const attached = renderer.attachView(view.viewId, tex.textureId, 4, 3)

    // attach does not create a GPU resource: createTextureView was called exactly once
    expect(recording.calls.filter(c => c.startsWith('createTextureView')).length).toBe(1)
    expect(attached.viewId).toBe(view.viewId)
    expect(attached.textureId).toBe(tex.textureId)
    expect(attached.baseMipLevel).toBe(4)
    expect(attached.mipLevelCount).toBe(3)
    renderer.stop()
  })

  it('attachView.dispose() → deleteTextureView(viewId) exactly once; a repeated dispose is a no-op', () => {
    const recording = createRecordingGL()
    const renderer = makeGLRenderer(recording)
    const tex = renderer.texture(256, 256, { mipLevels: 9 })
    const view = tex.createView({ baseMipLevel: 4, mipLevelCount: 3 })
    const attached = renderer.attachView(view.viewId, tex.textureId, 4, 3)

    attached.dispose()
    attached.dispose() // idempotent

    const deletes = recording.calls.filter(c => c.startsWith('deleteTextureView'))
    expect(deletes.length).toBe(1)
    expect(deletes[0]).toContain(String(view.viewId))
    // attach must NOT call createTextureView
    expect(recording.calls.filter(c => c.startsWith('createTextureView')).length).toBe(1)
    renderer.stop()
  })

  it('attachView via the unified Renderer (GL path) — delegates to inner', async () => {
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

  it('FULL recovery cycle of a view scene: loss → restore → the same stable ids → attach → dispose → compact() = 0', () => {
    const journal = createResourceJournal()

    // ── Session A (before the loss): texture + view via the public API ──
    const recA = createRecordingGL()
    const rendererA = makeGLRenderer(recA, journal)
    const tex = rendererA.texture(256, 256, { mipLevels: 9 })
    const view = tex.createView({ baseMipLevel: 4, mipLevelCount: 3 })
    const texId = tex.textureId
    const viewId = view.viewId
    expect(journal.size).toBe(2) // texture.create + view.create
    rendererA.stop()

    // ── Device loss: a new facade, THE SAME journal ──
    const recB = createRecordingGL()
    const rendererB = makeGLRenderer(recB, journal)
    const restoreFn = rendererB.restoreResources
    expect(restoreFn).toBeDefined()
    const report = restoreFn!.call(rendererB)

    // Stable ids match BY CONSTRUCTION — including the VIEW id (the core of Task 64)
    expect(report).not.toBeNull()
    expect(report.textureIds).toContain(texId)
    expect(report.viewIds).toContain(viewId)
    // replay on the fresh facade actually created the resources
    expect(recB.calls.filter(c => c.startsWith('createTexture(')).length).toBe(1)
    expect(recB.calls.filter(c => c.startsWith('createTextureView(')).length).toBe(1)

    // ── Scene return: attachTexture (parent) + attachView (view) ──
    const parentHandle = rendererB.attachTexture(texId, 256, 256, 9)
    const viewHandle = rendererB.attachView(viewId, texId, 4, 3)
    expect(viewHandle.viewId).toBe(viewId)
    // attaches create no new GPU resources and write no ops
    expect(journal.size).toBe(2)
    expect(recB.calls.filter(c => c.startsWith('createTextureView(')).length).toBe(1)

    // ── Scene dispose: view.destroy + texture.destroy go into the journal ──
    viewHandle.dispose()
    parentHandle.dispose()
    expect(recB.calls.filter(c => c.startsWith('deleteTextureView(')).length).toBe(1)
    expect(recB.calls.filter(c => c.startsWith('deleteTexture(')).length).toBe(1)
    expect(journal.size).toBe(4) // + view.destroy + texture.destroy

    // ── compact: create→destroy pairs drop out, the journal is clean ──
    journal.compact()
    expect(journal.size).toBe(0)
    rendererB.stop()
  })

  it('attachView with defaults: baseMipLevel=0, mipLevelCount=undefined', () => {
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

describe('Task 64 — attachView (WebGPU path of the unified renderer)', () => {
  it('attachView → a handle over a stable viewId; dispose → deleteTextureView (no createTextureView)', async () => {
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
      // attach does NOT create a GPU view
      expect(calls.filter(c => c.startsWith('createTextureView')).length).toBe(0)

      attached.dispose()
      attached.dispose() // idempotent
      const deletes = calls.filter(c => c.startsWith('deleteTextureView'))
      expect(deletes.length).toBe(1)
      expect(deletes[0]).toBe('deleteTextureView(1000001)')
      r.stop()
    } finally {
      ;(globalThis as { navigator?: unknown }).navigator = original
    }
  })

  it('createView (GPU path) still creates the view via the facade — regression of the create/attach separation', async () => {
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
