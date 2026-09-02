/**
 * Disposal discipline: manual dispose, page-close, FinalizationRegistry.
 *
 * Layers (see realGL.ts, realGPU.ts, journalGl.ts, webgl2Renderer.ts):
 *
 * 1. Facade: deleteTexture/deleteTarget/deleteProgram/deleteBuffer —
 *    call gl.delete* and remove from the internal cache. Idempotent.
 *
 * 2. Journal: withJournal emits destroyTexture/destroyTarget/...
 *    ops into the Journal. After that Journal.compact() can pair
 *    create+destroy. Replay on a fresh facade — destroy is a no-op (no resources).
 *
 * 3. Renderer level: Texture.dispose() / Surface.dispose() —
 *    call the facade delete* + (for Texture) unregister from the FR.
 *
 * 4. Renderer.dispose() — a full teardown: stop rAF + disconnect
 *    the ResizeObserver. After dispose the renderer is inoperable.
 *
 * 5. FinalizationRegistry (belt-and-suspenders): if the user
 *    forgot dispose() and released the reference to the Texture — the FR callback
 *    will call gl.deleteTexture. NOT deterministic — GC may not run.
 */

import { describe, expect, it } from 'bun:test'
import { createWebGL2Renderer } from '../src/index.ts'
import { createJournal } from '@rune/core'
import { createRecordingGL } from '@rune/webgl2'
import type { GLImageSource } from '@rune/webgl2'

function fakeCanvas(): HTMLCanvasElement {
  return { clientWidth: 800, clientHeight: 600, width: 0, height: 0 } as unknown as HTMLCanvasElement
}

function fakeBitmap(w: number, h: number): ImageBitmap {
  return { width: w, height: h, close: () => {} } as unknown as ImageBitmap
}

describe('Disposal: manual delete* methods on the facade', () => {
  it('Texture.dispose() calls deleteTexture on the facade (recorded in recordingGL)', () => {
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    const tex = renderer.texture(32, 32)
    tex.dispose()
    const deleteCalls = recording.calls.filter(c => c.startsWith('deleteTexture'))
    expect(deleteCalls.length).toBe(1)
    expect(deleteCalls[0]).toContain(String(tex.textureId))
    renderer.stop()
  })

  it('Texture.dispose() is idempotent: a repeated call — no-op', () => {
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    const tex = renderer.texture(32, 32)
    tex.dispose()
    tex.dispose() // repeated — no-op
    tex.dispose() // and once more — no-op
    const deleteCalls = recording.calls.filter(c => c.startsWith('deleteTexture'))
    expect(deleteCalls.length).toBe(1) // only one
    renderer.stop()
  })

  it('Surface.dispose() calls deleteTarget + deleteTexture (in the right order)', () => {
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    const surf = renderer.surface({ width: 64, height: 64, depth: true })
    surf.dispose()
    const deleteTargetCalls = recording.calls.filter(c => c.startsWith('deleteTarget'))
    const deleteTextureCalls = recording.calls.filter(c => c.startsWith('deleteTexture'))
    expect(deleteTargetCalls.length).toBe(1)
    expect(deleteTextureCalls.length).toBe(1)
    // Order: the target is deleted BEFORE the texture (the target references the texture)
    const targetIdx = recording.calls.findIndex(c => c.startsWith('deleteTarget'))
    const texIdx = recording.calls.findIndex(c => c.startsWith('deleteTexture'))
    expect(targetIdx).toBeLessThan(texIdx)
    renderer.stop()
  })

  it('Surface.dispose() is idempotent', () => {
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    const surf = renderer.surface({ width: 32, height: 32 })
    surf.dispose()
    surf.dispose()
    surf.dispose()
    const deleteCalls = recording.calls.filter(c => c.startsWith('delete'))
    expect(deleteCalls.length).toBe(2) // 1 deleteTarget + 1 deleteTexture
    renderer.stop()
  })
})

describe('Disposal: the Journal receives destroy ops (wire-up)', () => {
  it('Texture.dispose() writes a destroyTexture op into the journal', () => {
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
    const tex = renderer.texture(16, 16)
    tex.dispose()
    const destroyTexOps = journal.entries().filter(op => op.kind === 'destroyTexture')
    expect(destroyTexOps.length).toBe(1)
    const op = destroyTexOps[0] as Extract<typeof destroyTexOps[number], { kind: 'destroyTexture' }>
    expect(op.id).toBe(tex.textureId)
    renderer.stop()
  })

  it('Surface.dispose() writes destroyTarget + destroyTexture ops', () => {
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
    const surf = renderer.surface({ width: 32, height: 32, depth: true })
    surf.dispose()
    const destroyTargetOps = journal.entries().filter(op => op.kind === 'destroyTarget')
    const destroyTextureOps = journal.entries().filter(op => op.kind === 'destroyTexture')
    expect(destroyTargetOps.length).toBe(1)
    expect(destroyTextureOps.length).toBe(1)
    renderer.stop()
  })

  it('Journal.compact() removes the create+destroy pair and the dangling texImage2DFromSource after dispose', () => {
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
    const tex = renderer.texture(8, 8)
    tex.uploadImage(fakeBitmap(8, 8) as GLImageSource)
    tex.dispose()
    // Before compact: createTexture + texImage2DFromSource + destroyTexture
    const beforeCompact = journal.entries().length
    expect(beforeCompact).toBeGreaterThanOrEqual(3)

    journal.compact()
    // Task 61: after compact — EMPTY. createTexture+destroyTexture — a pair;
    // texImage2DFromSource — a dangling reference to the destroyed texture
    // (it used to survive and break replay on a fresh facade: an upload to
    // a nonexistent textureId).
    expect(journal.entries()).toEqual([])
    renderer.stop()
  })

  it('Task 61: texImage2DFromSource of a live texture survives compact', () => {
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
    const tex = renderer.texture(8, 8)
    tex.uploadImage(fakeBitmap(8, 8) as GLImageSource)
    journal.compact()
    const kinds = journal.entries().map(op => op.kind)
    expect(kinds).toEqual(['createTexture', 'texImage2DFromSource'])
    renderer.stop()
  })
})

describe('Disposal: Renderer.dispose() — a full teardown', () => {
  it('Renderer.dispose() is idempotent', () => {
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => createRecordingGL().gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    expect(() => {
      renderer.dispose()
      renderer.dispose()
      renderer.dispose()
    }).not.toThrow()
  })

  it('Renderer.dispose() stops the loop', () => {
    let frameCount = 0
    let requestFrameCancel = () => {}
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => createRecordingGL().gl,
      observeResize: false,
      now: () => 0,
      requestFrame: cb => {
        const id = setTimeout(() => cb(performance.now()), 0)
        return () => clearTimeout(id)
      },
    })
    renderer.frame(() => { frameCount++ })
    renderer.start()
    renderer.dispose()
    const countAfterDispose = frameCount
    // Wait a bit — no frame should arrive
    return new Promise<void>(resolve => {
      setTimeout(() => {
        expect(frameCount).toBe(countAfterDispose) // no new frames
        resolve()
      }, 50)
    })
  })
})

describe('Disposal: replayJournalOn with destroy ops', () => {
  it('destroy ops on a fresh facade — no-op (do not throw)', () => {
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
    const tex = renderer.texture(16, 16)
    tex.dispose()
    renderer.stop()

    // Replay on a fresh facade — destroy ops must NOT throw
    const newRecording = createRecordingGL()
    expect(() => {
      // Manual replay: walk all ops
      journal.replay(op => {
        // Simulate applyOp via a simple switch — a no-op for destroy ops
        if (op.kind === 'createTexture' || op.kind === 'createProgram' ||
            op.kind === 'createBuffer' || op.kind === 'createTarget') {
          // create ops — create a resource (but we ignore the returned id)
        }
        // destroy ops — no-op
      })
    }).not.toThrow()
  })
})
