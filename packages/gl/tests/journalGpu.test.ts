import { describe, expect, it } from 'bun:test'
import { createJournal } from '@rune/core'
import type { DeclOp } from '@rune/core'
import { createRecordingGPU } from '@rune/webgpu'
import { withJournalGpu, replayJournalOnGpu } from '../src/journalGpu.ts'
import type { GPUImageSource } from '@rune/webgpu'

/**
 * Task 57: WebGPU journal-decorator (withJournalGpu + replayJournalOnGpu).
 *
 * Contract (parity with journalGl.ts for WebGL2):
 *  1. withJournalGpu(gpu, journal) — wraps the GPUFacade with a decorator.
 *  2. create/destroy ops (createTexture, createTarget, createTextureView,
 *     copyExternalImageToTexture as a full-texture upload) are written automatically.
 *  3. Frame ops (usePipeline, bindUniforms, bindTexture, draw, submit etc.)
 *     are NOT journaled (they are per-frame, they go into the Tape, not the Journal).
 *  4. copyExternalImageToTextureMip (mip streaming) — a frame op, not journaled.
 *  5. Sub-region copyExternalImageToTexture (dstX != 0 || dstY != 0) — a frame op
 *     (atlas packing), not journaled.
 *  6. Replay on a fresh facade: replayJournalOnGpu(journal, newGpu, sourceFor?)
 *     — recreates all long-lived resources in the right order.
 *  7. The sourceFor(kind) callback for copyExternalImageToTexture — returns
 *     a ready source by kind ('ImageBitmap', 'HTMLCanvasElement', etc.).
 *     If the callback is not passed or returned null — the op is skipped (the
 *     texture stays empty, the sampler will return zeros).
 *
 * Device-loss recovery scenario:
 *  1. The user created a texture/target/view — the Journal recorded it.
 *  2. The device was lost (the old GPUFacade died).
 *  3. A new GPUFacade is created (via createRealGPU).
 *  4. replayJournalOnGpu(journal, newGpu, sourceFor) — recreates all resources.
 */

function fakeBitmap(w: number, h: number): ImageBitmap {
  return { width: w, height: h, close: () => {} } as unknown as ImageBitmap
}

describe('Task 57 — withJournalGpu decorator', () => {
  it('createTexture is written to the journal automatically (with the default format undefined)', () => {
    const journal = createJournal()
    const { gpu } = createRecordingGPU()
    const decorated = withJournalGpu(gpu, journal)

    decorated.createTexture(128, 128)

    const texOps = journal.entries().filter(op => op.kind === 'createTexture')
    expect(texOps.length).toBe(1)
    const op = texOps[0] as Extract<DeclOp, { kind: 'createTexture' }>
    expect(op.width).toBe(128)
    expect(op.height).toBe(128)
    expect(op.format).toBeUndefined() // format not passed → undefined (replay: default RGBA8)
    expect(op.options).toBeUndefined()
  })

  it('createTexture with format=canvas → format saved in the op', () => {
    const journal = createJournal()
    const { gpu } = createRecordingGPU()
    const decorated = withJournalGpu(gpu, journal)

    decorated.createTexture(800, 600, 'canvas')

    const op = journal.entries()[0] as Extract<DeclOp, { kind: 'createTexture' }>
    expect(op.format).toBe('canvas')
  })

  it('createTexture with mipLevels + maxAnisotropy → options saved', () => {
    const journal = createJournal()
    const { gpu } = createRecordingGPU()
    const decorated = withJournalGpu(gpu, journal)

    decorated.createTexture(256, 256, 'rgba8unorm', { mipLevels: 9, maxAnisotropy: 8 })

    const op = journal.entries()[0] as Extract<DeclOp, { kind: 'createTexture' }>
    expect(op.format).toBe('rgba8unorm')
    expect(op.options?.mipLevels).toBe(9)
    expect(op.options?.maxAnisotropy).toBe(8)
  })

  it('deleteTexture → a destroyTexture op in the journal', () => {
    const journal = createJournal()
    const { gpu } = createRecordingGPU()
    const decorated = withJournalGpu(gpu, journal)

    const id = decorated.createTexture(64, 64)
    decorated.deleteTexture(id)

    const ops = journal.entries()
    expect(ops[0].kind).toBe('createTexture')
    expect(ops[1].kind).toBe('destroyTexture')
    expect((ops[1] as Extract<DeclOp, { kind: 'destroyTexture' }>).id).toBe(id)
  })

  it('createTarget + deleteTarget → journaled', () => {
    const journal = createJournal()
    const { gpu } = createRecordingGPU()
    const decorated = withJournalGpu(gpu, journal)

    const texId = decorated.createTexture(128, 128)
    const targetId = decorated.createTarget(texId, 128, 128, true, [0.1, 0.2, 0.3, 1])
    decorated.deleteTarget(targetId)

    const ops = journal.entries()
    expect(ops[0].kind).toBe('createTexture')
    expect(ops[1].kind).toBe('createTarget')
    expect(ops[2].kind).toBe('destroyTarget')
    const targetOp = ops[1] as Extract<DeclOp, { kind: 'createTarget' }>
    expect(targetOp.textureId).toBe(texId)
    expect(targetOp.width).toBe(128)
    expect(targetOp.height).toBe(128)
    expect(targetOp.depth).toBe(true)
    expect(targetOp.color).toEqual([0.1, 0.2, 0.3, 1])
  })

  it('createTextureView + deleteTextureView → journaled', () => {
    const journal = createJournal()
    const { gpu } = createRecordingGPU()
    const decorated = withJournalGpu(gpu, journal)

    const texId = decorated.createTexture(256, 256, 'rgba8unorm', { mipLevels: 9 })
    const viewId = decorated.createTextureView(texId, { baseMipLevel: 4, mipLevelCount: 2 })
    decorated.deleteTextureView(viewId)

    const ops = journal.entries()
    expect(ops[0].kind).toBe('createTexture')
    expect(ops[1].kind).toBe('createTextureView')
    expect(ops[2].kind).toBe('destroyTextureView')
    const viewOp = ops[1] as Extract<DeclOp, { kind: 'createTextureView' }>
    expect(viewOp.id).toBe(viewId)
    expect(viewOp.textureId).toBe(texId)
    expect(viewOp.baseMipLevel).toBe(4)
    expect(viewOp.mipLevelCount).toBe(2)
  })

  it('copyExternalImageToTexture (full-texture) → a texImage2DFromSource op in the journal', () => {
    const journal = createJournal()
    const { gpu } = createRecordingGPU()
    const decorated = withJournalGpu(gpu, journal)

    const texId = decorated.createTexture(64, 64)
    const src = fakeBitmap(64, 64)
    decorated.copyExternalImageToTexture(texId, src, 0, 0, 64, 64)

    const ops = journal.entries()
    expect(ops[0].kind).toBe('createTexture')
    expect(ops[1].kind).toBe('texImage2DFromSource')
    const uploadOp = ops[1] as Extract<DeclOp, { kind: 'texImage2DFromSource' }>
    expect(uploadOp.textureId).toBe(texId)
    expect(uploadOp.sourceKind).toBe('ImageBitmap')
    expect(uploadOp.flipY).toBe(false) // default
  })

  it('copyExternalImageToTexture with flipY=true → flipY=true in the op', () => {
    const journal = createJournal()
    const { gpu } = createRecordingGPU()
    const decorated = withJournalGpu(gpu, journal)

    const texId = decorated.createTexture(32, 32)
    const src = fakeBitmap(32, 32)
    decorated.copyExternalImageToTexture(texId, src, 0, 0, 32, 32, true)

    const uploadOp = journal.entries()[1] as Extract<DeclOp, { kind: 'texImage2DFromSource' }>
    expect(uploadOp.flipY).toBe(true)
  })

  it('copyExternalImageToTexture sub-region (dstX=8, dstY=8) → NOT journaled (atlas packing = frame-op)', () => {
    const journal = createJournal()
    const { gpu } = createRecordingGPU()
    const decorated = withJournalGpu(gpu, journal)

    const texId = decorated.createTexture(64, 64)
    const src = fakeBitmap(16, 16)
    decorated.copyExternalImageToTexture(texId, src, 8, 8, 16, 16)

    const ops = journal.entries()
    // Only createTexture — a sub-region upload is not journaled
    expect(ops.length).toBe(1)
    expect(ops[0].kind).toBe('createTexture')
  })

  it('Task 61: copyExternalImageToTexture sub-region at (0,0) with a size SMALLER than the texture → NOT journaled', () => {
    // Earlier the heuristic only checked dstX=dstY=0: a sub-region copy in the
    // top-left corner (the first atlas tile, uploadSubImage at the origin) was
    // mistakenly journaled as a full upload — replay would fill the texture
    // with a cropped source. Now — size-aware: only full coverage.
    const journal = createJournal()
    const { gpu } = createRecordingGPU()
    const decorated = withJournalGpu(gpu, journal)

    const texId = decorated.createTexture(64, 64)
    const src = fakeBitmap(32, 32)
    decorated.copyExternalImageToTexture(texId, src, 0, 0, 32, 32)

    const ops = journal.entries()
    expect(ops.length).toBe(1)
    expect(ops[0].kind).toBe('createTexture')
  })

  it('Task 61: copyExternalImageToTexture of full size at (0,0) → journaled (size-aware match)', () => {
    const journal = createJournal()
    const { gpu } = createRecordingGPU()
    const decorated = withJournalGpu(gpu, journal)

    const texId = decorated.createTexture(64, 64, 'rgba8unorm', { mipLevels: 1 })
    const src = fakeBitmap(64, 64)
    decorated.copyExternalImageToTexture(texId, src, 0, 0, 64, 64, true)

    const ops = journal.entries()
    expect(ops.length).toBe(2)
    expect(ops[1].kind).toBe('texImage2DFromSource')
  })

  it('copyExternalImageToTextureMip (mip streaming) → NOT journaled (frame-op)', () => {
    const journal = createJournal()
    const { gpu } = createRecordingGPU()
    const decorated = withJournalGpu(gpu, journal)

    const texId = decorated.createTexture(256, 256, 'rgba8unorm', { mipLevels: 9 })
    const src = fakeBitmap(8, 8)
    decorated.copyExternalImageToTextureMip(texId, 5, src, 0, 0, 8, 8)

    const ops = journal.entries()
    // Only createTexture — a mip upload is not journaled
    expect(ops.length).toBe(1)
    expect(ops[0].kind).toBe('createTexture')
  })

  it('Frame ops are NOT journaled: usePipeline, bindTexture, draw, submit', () => {
    const journal = createJournal()
    const { gpu } = createRecordingGPU()
    const decorated = withJournalGpu(gpu, journal)

    const texId = decorated.createTexture(64, 64)
    decorated.usePipeline(1)
    decorated.bindTexture(texId)
    decorated.draw(6, 1)
    decorated.endPass()
    decorated.submit()

    // Only createTexture
    expect(journal.size).toBe(1)
    expect(journal.entries()[0].kind).toBe('createTexture')
  })

  it('configure/resize/installTimer — NOT journaled (lifecycle, not resources)', () => {
    const journal = createJournal()
    const { gpu } = createRecordingGPU()
    const decorated = withJournalGpu(gpu, journal)

    decorated.configure(800, 600)
    decorated.resize(1024, 768)
    decorated.installTimer(null)

    expect(journal.size).toBe(0)
  })

  it('public getters delegate to the underlying facade (adapter/device/preferredFormat/timer)', () => {
    const journal = createJournal()
    const { gpu } = createRecordingGPU()
    const decorated = withJournalGpu(gpu, journal)

    // recordingGPU: adapter=null, device=null, preferredFormat='bgra8unorm', timer=null
    expect(decorated.adapter).toBeNull()
    expect(decorated.device).toBeNull()
    expect(decorated.preferredFormat).toBe('bgra8unorm')
    expect(decorated.timer).toBeNull()
  })
})

describe('Task 57 — replayJournalOnGpu', () => {
  it('replay recreates resources on a fresh facade in the right order', () => {
    // Phase 1: the first facade created resources, the journal recorded them
    const journal = createJournal()
    const oldRecording = createRecordingGPU()
    const oldGpu = withJournalGpu(oldRecording.gpu, journal)

    const texId = oldGpu.createTexture(64, 64)
    oldGpu.createTarget(texId, 64, 64, true, [0.1, 0.2, 0.3, 1])
    oldGpu.createTextureView(texId, { baseMipLevel: 0, mipLevelCount: 1 })

    // Phase 2: "the device is lost" — we create a NEW facade and replay it
    const newRecording = createRecordingGPU()
    replayJournalOnGpu(journal, newRecording.gpu)

    // All create ops arrived: createTexture(64,64), createTarget, createTextureView.
    // IMPORTANT: a filter with an exact prefix, so as not to catch createTextureView in
    // the createTexture counter (startsWith('createTexture') catches both).
    const newCreateTex = newRecording.calls.filter(c => c.startsWith('createTexture(')).length
    const newCreateTarget = newRecording.calls.filter(c => c.startsWith('createTarget(')).length
    const newCreateView = newRecording.calls.filter(c => c.startsWith('createTextureView(')).length

    expect(newCreateTex).toBe(1)
    expect(newCreateTarget).toBe(1)
    expect(newCreateView).toBe(1)
  })

  it('replay with sourceFor: copyExternalImageToTexture (texImage2DFromSource) is restored', () => {
    const journal = createJournal()
    const oldRecording = createRecordingGPU()
    const oldGpu = withJournalGpu(oldRecording.gpu, journal)

    const texId = oldGpu.createTexture(16, 16)
    const src = fakeBitmap(16, 16)
    oldGpu.copyExternalImageToTexture(texId, src, 0, 0, 16, 16)

    // A fresh facade + a sourceFor callback
    const newRecording = createRecordingGPU()
    const sourceFor = (kind: string): GPUImageSource | null => {
      if (kind === 'ImageBitmap') return fakeBitmap(16, 16) as GPUImageSource
      return null
    }
    expect(() => replayJournalOnGpu(journal, newRecording.gpu, sourceFor)).not.toThrow()

    // copyExternalImageToTexture arrived
    const uploadCalls = newRecording.calls.filter(c => c.startsWith('copyExternalImageToTexture'))
    expect(uploadCalls.length).toBe(1)
    // Check that dstX=0, dstY=0 (full-texture upload, not sub-region)
    expect(uploadCalls[0]).toContain('@0,0')
  })

  it('replay without sourceFor: texImage2DFromSource is skipped (without an exception)', () => {
    const journal = createJournal()
    const oldRecording = createRecordingGPU()
    const oldGpu = withJournalGpu(oldRecording.gpu, journal)

    const texId = oldGpu.createTexture(8, 8)
    const src = fakeBitmap(8, 8)
    oldGpu.copyExternalImageToTexture(texId, src, 0, 0, 8, 8)

    // A fresh facade WITHOUT sourceFor
    const newRecording = createRecordingGPU()
    expect(() => replayJournalOnGpu(journal, newRecording.gpu)).not.toThrow()
    // createTexture arrived, copyExternalImageToTexture — skipped
    expect(newRecording.calls.some(c => c.startsWith('createTexture'))).toBe(true)
    expect(newRecording.calls.some(c => c.startsWith('copyExternalImageToTexture'))).toBe(false)
  })

  it('replay does not mutate the original journal (snapshot semantics via append-only)', () => {
    const journal = createJournal()
    const oldRecording = createRecordingGPU()
    const oldGpu = withJournalGpu(oldRecording.gpu, journal)
    oldGpu.createTexture(32, 32)
    const originalOps = journal.entries().slice()

    const newRecording = createRecordingGPU()
    replayJournalOnGpu(journal, newRecording.gpu)

    // The journal did not mutate during replay
    expect(journal.entries().length).toBe(originalOps.length)
  })

  it('compact removes the createTexture → destroyTexture pair before replay', () => {
    const journal = createJournal()
    const oldRecording = createRecordingGPU()
    const oldGpu = withJournalGpu(oldRecording.gpu, journal)

    const texId = oldGpu.createTexture(64, 64) // createTexture
    oldGpu.deleteTexture(texId) // destroyTexture
    // compaction: a create→destroy pair of the same id removes both ops
    journal.compact()

    expect(journal.size).toBe(0)

    // Replay on a fresh facade — an empty journal → nothing is done
    const newRecording = createRecordingGPU()
    replayJournalOnGpu(journal, newRecording.gpu)
    expect(newRecording.calls.length).toBe(0)
  })

  it('cross-backend replay: WebGL2-only ops (createProgram/createBuffer) are ignored on WebGPU', () => {
    // Simulate a journal recorded on WebGL2 (it has createProgram/createBuffer).
    // These DeclOp variants are not valid for WebGPU (there are no separate programs/
    // buffers as resources — pipelines are lazy, vertex buffers are keyed by
    // Float32Array). applyGpuOp must silently skip them (default case).
    const journal = createJournal()
    journal.record({ kind: 'createProgram', id: 1, vertex: 'V', fragment: 'F' })
    journal.record({ kind: 'createBuffer', id: 1, data: new Float32Array([1, 2, 3]) })
    journal.record({ kind: 'createTexture', id: 1, width: 64, height: 64 })

    const newRecording = createRecordingGPU()
    expect(() => replayJournalOnGpu(journal, newRecording.gpu)).not.toThrow()
    // createTexture arrived, createProgram/createBuffer — ignored
    expect(newRecording.calls.some(c => c.startsWith('createTexture'))).toBe(true)
    expect(newRecording.calls.some(c => c.startsWith('createProgram'))).toBe(false)
    expect(newRecording.calls.some(c => c.startsWith('createBuffer'))).toBe(false)
  })
})
