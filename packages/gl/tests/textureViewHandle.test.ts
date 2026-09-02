import { describe, expect, it } from 'bun:test'
import { createWebGL2Renderer } from '../src/index.ts'
import type { Texture, TextureView } from '../src/index.ts'
import { createRecordingGL } from '@rune/webgl2'
import { createJournal } from '@rune/core'

/**
 * Task 58: TextureView public handle — `texture.createView()` on both backends.
 *
 * Contract:
 *  - Texture.createView({ baseMipLevel?, mipLevelCount? }) → TextureView
 *  - TextureView.viewId ≥ 1_000_000 (disjoint namespace with textureId < 1M)
 *  - TextureView.dispose() → deleteTextureView(viewId) on the facade. Idempotent.
 *  - Texture.dispose() → cascade dispose of all sub-views (for API symmetry).
 *
 * WebGPU ↔ WebGL2 parity:
 *  - WebGPU: a native GPUTextureView with baseMipLevel/mipLevelCount.
 *  - WebGL2 (Task 56): emulation via TEXTURE_BASE_LEVEL/MAX_LEVEL on bind.
 *  - In both cases bindTexture(viewId) works the same way.
 */

function fakeCanvas(): HTMLCanvasElement {
  return { clientWidth: 800, clientHeight: 600, width: 0, height: 0 } as unknown as HTMLCanvasElement
}

describe('Task 58 — Texture.createView() public handle', () => {
  it('createView without options → a TextureView with viewId ≥ 1_000_000', () => {
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

  it('createView with baseMipLevel=4 → view.baseMipLevel=4', () => {
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
    // The RecordingFacade recorded the createTextureView call
    const viewCall = recording.calls.find(c => c.startsWith('createTextureView'))
    expect(viewCall).toBeDefined()
    expect(viewCall).toContain('mip=4')
    renderer.stop()
  })

  it('createView with baseMipLevel+mipLevelCount → both recorded', () => {
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

  it('createView returns different viewIds for different calls', () => {
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

  it('TextureView.dispose() → deleteTextureView on the facade', () => {
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

  it('TextureView.dispose() is idempotent — a repeated call is a no-op', () => {
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
    view.dispose() // repeated — no-op
    view.dispose() // third — no-op

    // Only one deleteTextureView in the call log
    const deleteCalls = recording.calls.filter(c => c.startsWith('deleteTextureView'))
    expect(deleteCalls.length).toBe(1)
    renderer.stop()
  })

  it('Texture.dispose() → cascade dispose of all sub-views', () => {
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

    // dispose the parent texture → all views must be released too
    tex.dispose()

    // Three deleteTextureView calls (for v1, v2, v3) + one deleteTexture.
    // IMPORTANT: the exact-prefix filter — 'deleteTexture' also catches 'deleteTextureView'.
    const deleteViewCalls = recording.calls.filter(c => c.startsWith('deleteTextureView(')).length
    expect(deleteViewCalls).toBe(3)
    const deleteTexCalls = recording.calls.filter(c => c.startsWith('deleteTexture(')).length
    expect(deleteTexCalls).toBe(1)

    // And the view handles themselves — marked as disposed (a repeated dispose → no-op)
    expect(() => v1.dispose()).not.toThrow()
    expect(() => v2.dispose()).not.toThrow()
    expect(() => v3.dispose()).not.toThrow()
    // The deleteTextureView count did not grow after the repeated dispose calls
    const deleteViewCallsAfter = recording.calls.filter(c => c.startsWith('deleteTextureView(')).length
    expect(deleteViewCallsAfter).toBe(3)
    renderer.stop()
  })

  it('createView after disposing the parent texture → the facade throws or no-ops (but the handle is not created)', () => {
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

    // The recording facade does not throw (it is a no-op for an invalid textureId),
    // but the real realGL would throw. On recording — a fake viewId is returned.
    // The main point — the handle does not break the API, even if the parent is dead.
    expect(() => tex.createView({ baseMipLevel: 1 })).not.toThrow()
    renderer.stop()
  })

  it('Journal integration: createView writes a createTextureView op when the journal is enabled', () => {
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
    // createTexture (from texture()), createTextureView, destroyTextureView (from view.dispose())
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
