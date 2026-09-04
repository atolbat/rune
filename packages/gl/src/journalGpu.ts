/**
 * withJournalGpu — a GPUFacade decorator: writes create/destroy ops to the Journal.
 *
 * Contract §9.5 P3 (the same as for WebGL2): the journal makes switchBackend =
 * device-loss recovery = worker migration one replay mechanism.
 *
 * This is the WebGPU twin of journalGl.ts. The principles are the same:
 *   • Long-lived create/destroy ops are journaled automatically.
 *   • Frame ops (usePipeline, bindUniforms, bindVertexBuffer, bindTexture,
 *     beginPass, draw, endPass, submit, bindTarget, uploadUniforms,
 *     texSubImage2D, copyExternalImageToTextureMip) — NOT journaled
 *     (these are per-frame, they go to the Tape, not the Journal).
 *   • The copyExternalImageToTexture source is not serialized (an ImageBitmap may
 *     be closed, HTMLVideoElement is DOM-dependent). The journal stores only
 *     kind+flipY; on replay the user provides the source via
 *     sourceFor(kind).
 *
 * How the WebGPU journal DIFFERS from the WebGL2 journal:
 *   1. createTexture — GPUFacade has a format parameter ('rgba8unorm' | 'canvas').
 *      The journal stores format in the DeclOp (see journal.ts — Task 57). On replay
 *      on a new WebGPU facade format is passed as is. On cross-backend
 *      replay (WebGPU → WebGL2) format is silently ignored (WebGL2 is always RGBA8).
 *   2. createProgram/createBuffer — GPUFacade does NOT have them. Pipelines ( WGSL
 *      shaders) are lazy: created on the first draw via ensurePipeline.
 *      The WGSL source is stored in WgpuCommand (compiled), so for device-loss
 *      recovery it is enough to replay only textures/targets/views — pipelines
 *      will be recreated automatically on the first draw on the new device.
 *   3. copyExternalImageToTexture — the WebGPU analog of texImage2DFromSource
 *      (a full upload into mip 0). Recorded as { kind:'texImage2DFromSource',
 *      textureId, sourceKind, flipY }. sub-region (atlas packing) and
 *      mip upload (copyExternalImageToTextureMip) — frame ops, not journaled.
 *
 * Replay on a new facade: replayJournalOnGpu(journal, targetGpu, sourceFor?)
 *   — see below. All create ops are executed in record order; destroy ops are
 *   a no-op on a new facade (the resources do not exist yet).
 */

import type { Journal, DeclOp, ClearColor } from '@rune/core'
import type { GPUFacade, GPUImageSource } from '@rune/webgpu'
import { externalImageSize } from '@rune/webgpu'

/** Decorates GPUFacade so that create/destroy ops are written to the Journal. */
export function withJournalGpu(gpu: GPUFacade, journal: Journal): GPUFacade {
  // Task 61: sizes of created textures — for the "full upload" heuristic.
  // copyExternalImageToTexture is journaled as texImage2DFromSource ONLY
  // if the copy covers the WHOLE texture (dstX=dstY=0 and copyWidth/copyHeight
  // match the sizes from createTexture). Previously only
  // dstX/dstY were checked — a sub-region copy at (0,0) (e.g. the first atlas tile or
  // uploadSubImage into the top-left corner) was erroneously journaled as a
  // full upload, and replay would have filled the texture with a cropped source.
  const texSizes = new Map<number, { w: number; h: number }>()
  return {
    configure: (w, h) => gpu.configure(w, h),
    resize: (w, h) => gpu.resize(w, h),
    // Task 116: renderer init state (NOT journaled — the new renderer's
    // createWebGpuRenderer re-applies it on the fresh facade after recovery;
    // the clear is policy, not a resource declaration).
    setCanvasClearColor: (color, depth) => gpu.setCanvasClearColor(color, depth),
    createTexture: (width, height, format, options) => {
      const id = gpu.createTexture(width, height, format, options)
      // Task 57: format is saved in the op — on replay on WebGPU it is passed as
      // is. On cross-backend replay on WebGL2 — ignored (it is always RGBA8 there).
      texSizes.set(id, { w: width, h: height })
      journal.record({ kind: 'createTexture', id, width, height, format, options })
      return id
    },
    texSubImage2D: (textureId, x, y, w, h, bytes) =>
      gpu.texSubImage2D(textureId, x, y, w, h, bytes),
    // copyExternalImageToTexture — an atomic full upload into mip 0 (the analog
    // of texImage2DFromSource in WebGL2). Journaled as a long-lived declaration:
    // on replay on a new backend via sourceFor(kind) the user
    // provides the source and we call copyExternalImageToTexture(textureId,
    // source, 0, 0, sw, sh, flipY) — full-texture upload.
    copyExternalImageToTexture: (textureId, source, dstX, dstY, copyWidth, copyHeight, flipY) => {
      gpu.copyExternalImageToTexture(textureId, source, dstX, dstY, copyWidth, copyHeight, flipY)
      // We journal only a FULL texture upload: dstX=dstY=0 AND the copy
      // covers the whole size from createTexture (Task 61 — size-aware).
      // Sub-region upload (atlas packing) — a frame op, goes to the Tape, not the Journal.
      const size = texSizes.get(textureId)
      const isFullTexture = size !== undefined
        && dstX === 0 && dstY === 0
        && copyWidth === size.w && copyHeight === size.h
      if (isFullTexture) {
        journal.record({
          kind: 'texImage2DFromSource',
          textureId,
          sourceKind: describeGpuSourceKind(source),
          flipY: flipY === true,
        })
      }
    },
    // Frame ops (progressive mip upload): copyExternalImageToTextureMip —
    // progressive mip streaming, a frame op. Not journaled (contract §9.5 P3:
    // frame ops go to the Tape). Pass-through without journal.record().
    copyExternalImageToTextureMip: (textureId, mipLevel, source, dstX, dstY, copyWidth, copyHeight, flipY) =>
      gpu.copyExternalImageToTextureMip(textureId, mipLevel, source, dstX, dstY, copyWidth, copyHeight, flipY),
    // Frame ops: uploadUniforms — writeBuffer into the UBO, per-frame.
    uploadUniforms: (offset, data) => gpu.uploadUniforms(offset, data),
    // ensurePipeline — lazy compilation of WGSL → GPURenderPipeline. Not
    // journaled: the WGSL source is stored in WgpuCommand (compiled), so for
    // device-loss recovery it is enough to replay only textures/targets/views —
    // pipelines will be recreated automatically on the first draw on the new device.
    ensurePipeline: (pipelineId, wgsl, attrSizes, hasTextures) =>
      gpu.ensurePipeline(pipelineId, wgsl, attrSizes, hasTextures),
    usePipeline: pipelineId => gpu.usePipeline(pipelineId),
    bindUniforms: dynamicOffset => gpu.bindUniforms(dynamicOffset),
    bindVertexBuffer: (slot, data, size) => gpu.bindVertexBuffer(slot, data, size),
    // M5 (Task 73): feed dual-bind — a frame op (per-frame dirty range), not journaled.
    syncVertexBuffer: (data, byteLength) => gpu.syncVertexBuffer(data, byteLength),
    bindExternalVertexBuffer: (slot, bufferId) => gpu.bindExternalVertexBuffer(slot, bufferId),
    createExternalBuffer: (byteLength, usage) => gpu.createExternalBuffer(byteLength, usage),
    writeExternalBuffer: (id, data, byteOffset, byteLength) => gpu.writeExternalBuffer(id, data, byteOffset, byteLength),
    readExternalBuffer: (id, byteLength) => gpu.readExternalBuffer(id, byteLength),
    deleteExternalBuffer: id => gpu.deleteExternalBuffer(id),
    externalBufferOf: id => gpu.externalBufferOf(id),
    createCompute: (wgsl, uniformBytes, bufferIds) => gpu.createCompute(wgsl, uniformBytes, bufferIds),
    runCompute: (computeId, entry, uniformData, workgroups) => gpu.runCompute(computeId, entry, uniformData, workgroups),
    deleteCompute: computeId => gpu.deleteCompute(computeId),
    bindTexture: textureOrViewId => gpu.bindTexture(textureOrViewId),
    beginPass: clearIndex => gpu.beginPass(clearIndex),
    draw: (count, instances) => gpu.draw(count, instances),
    endPass: () => gpu.endPass(),
    submit: () => gpu.submit(),
    createTarget: (textureId, w, h, depth, color) => {
      const id = gpu.createTarget(textureId, w, h, depth, color)
      journal.record({ kind: 'createTarget', id, textureId, width: w, height: h, depth, color: color as ClearColor })
      return id
    },
    bindTarget: (targetId, clear) => gpu.bindTarget(targetId, clear),
    // Task 80: readback — a READ, not a declaration: not journaled
    // (a frame op in the spirit of §9.5 P3; no replay needed).
    readTargetPixels: targetId => gpu.readTargetPixels(targetId),
    // destroy ops: written to the journal so that Journal.compact() can pair
    // create+destroy. On replay on a new facade — destroy is a no-op (see applyGpuOp).
    deleteTexture: textureId => {
      gpu.deleteTexture(textureId)
      texSizes.delete(textureId)
      journal.record({ kind: 'destroyTexture', id: textureId })
    },
    deleteTarget: targetId => {
      gpu.deleteTarget(targetId)
      journal.record({ kind: 'destroyTarget', id: targetId })
    },
    // Sub-mip views (Task 56): createTextureView/destroyTextureView —
    // long-lived declarations (like createTexture). Journaled for device-loss
    // recovery: on replay on a new backend the view is recreated via
    // target.createTextureView(textureId, { baseMipLevel, mipLevelCount }).
    // IMPORTANT: textureId in the record is the id on the CURRENT backend. On replay
    // the caller must map it to the new id (via registerIdMap or
    // a similar mechanism) — applyGpuOp below delegates this to the calling code.
    createTextureView: (textureId, options) => {
      const viewId = gpu.createTextureView(textureId, options)
      journal.record({
        kind: 'createTextureView',
        id: viewId,
        textureId,
        baseMipLevel: options?.baseMipLevel,
        mipLevelCount: options?.mipLevelCount,
      })
      return viewId
    },
    deleteTextureView: viewId => {
      gpu.deleteTextureView(viewId)
      journal.record({ kind: 'destroyTextureView', id: viewId })
    },
    dispose: () => gpu.dispose(),
    installTimer: handle => gpu.installTimer(handle),
    // Public getters — delegated to the underlying facade. The Journal does not interfere
    // with caps/timer (they sit above adapter/device, not above create/destroy).
    get adapter() { return gpu.adapter },
    get device() { return gpu.device },
    get preferredFormat() { return gpu.preferredFormat },
    get timer() { return gpu.timer },
  }
}

/**
 * Replay the journal onto a target GPUFacade — for device-loss recovery.
 *
 * sourceFor — a callback for copyExternalImageToTexture (the WebGPU analog
 * of texImage2DFromSource): returns the source by kind ('ImageBitmap',
 * 'HTMLCanvasElement', etc.). If the callback is not passed or returns null —
 * the op is skipped (the texture remains empty, the sampler will return zeros).
 *
 * Idempotence: a repeated replay will create DUPLICATES of resources (realGPU always
 * issues a new id — nextTextureId++). The correct usage is on a FRESH
 * backend (after device.destroy() and recreating adapter/device).
 *
 * cross-backend replay: if the journal was recorded on WebGL2 and the target is WebGPU
 * (or vice versa), some ops will be incompatible:
 *   • createProgram/createBuffer (WebGL2-only) — applyGpuOp ignores them
 *     (default case) — WebGPU has no programs as separate resources.
 *   • texImage2DFromSource on WebGPU — copyExternalImageToTexture with dstX=0,
 *     dstY=0, copySize=externalImageSize(source). This is a full-texture upload,
 *     sub-region is not emulated.
 */
export function replayJournalOnGpu(
  journal: Journal,
  target: GPUFacade,
  sourceFor?: (kind: string) => GPUImageSource | null,
): void {
  journal.replay(op => applyGpuOp(op, target, sourceFor))
}

/** Apply one DeclOp to the target GPUFacade. */
function applyGpuOp(op: DeclOp, gpu: GPUFacade, sourceFor?: (kind: string) => GPUImageSource | null): void {
  switch (op.kind) {
    case 'createTexture':
      // The returned id is ignored: on a new facade the id will be different.
      // Order matters: texture 1 → createTexture 1, texture 2 → createTexture 2,
      // id mapping is on the user's side (via registerIdMap).
      gpu.createTexture(op.width, op.height, op.format, op.options)
      break
    case 'createTarget':
      gpu.createTarget(op.textureId, op.width, op.height, op.depth, op.color as ClearColor)
      break
    case 'texImage2DFromSource': {
      const source = sourceFor?.(op.sourceKind) ?? null
      if (source === null) break // no source — skip (the texture remains empty)
      // WebGPU: copyExternalImageToTexture — full-texture upload (dstX=dstY=0).
      // copySize = the source size (externalImageSize synchronously reads .width/
      // .height/.videoWidth/.displayWidth from the source).
      const [sw, sh] = externalImageSize(source)
      gpu.copyExternalImageToTexture(op.textureId, source, 0, 0, sw, sh, op.flipY)
      break
    }
    // Sub-mip views (Task 56): on replay we create the view on the new backend.
    // IMPORTANT: op.textureId is the id on the source backend. On the new backend
    // textureId will be DIFFERENT. The caller must map the ids before replay
    // (this is the user code's responsibility, since only it knows
    // the correspondence of old and new ids).
    //
    // In this implementation we pass op.textureId directly — this is safe
    // only if textureId on the new backend matches the original (e.g.
    // when replaying in the order of all createTexture, ids are generated in the same
    // order and match). Otherwise the caller must convert the ids in
    // journal.entries() before calling replayJournalOnGpu.
    case 'createTextureView':
      gpu.createTextureView(op.textureId, {
        baseMipLevel: op.baseMipLevel,
        mipLevelCount: op.mipLevelCount,
      })
      break
    // destroy ops on a new facade — no-op (the resources do not exist yet).
    // On the same facade (idempotence check) — the responsibility lies with the
    // facade: ignore or throw.
    // createProgram/createBuffer (WebGL2-only DeclOp variants) — ignored
    // on WebGPU: there are no separate programs/buffers as resources (pipelines
    // are lazy, vertex buffers — keyed by Float32Array in bindVertexBuffer).
    default:
      break
  }
}

/** Source type name for the journal record. Parity with describeSourceKind in
 *  journalGl.ts — the same kind names, so that the sourceFor callback is reusable
 *  across WebGL2 and WebGPU replays. */
function describeGpuSourceKind(source: GPUImageSource): string {
  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) return 'ImageBitmap'
  if (typeof OffscreenCanvas !== 'undefined' && source instanceof OffscreenCanvas) return 'OffscreenCanvas'
  if (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) return 'HTMLCanvasElement'
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) return 'HTMLVideoElement'
  // VideoFrame — WebCodecs API (only in secure contexts). Duck-typing
  // for headless environments without global types.
  if (typeof source === 'object' && source !== null) {
    if ('displayWidth' in source && 'codedWidth' in source) return 'VideoFrame'
    if ('getContext' in source) return 'OffscreenCanvas'
    if ('close' in source && 'width' in source) return 'ImageBitmap'
  }
  return (source as { constructor: { name: string } }).constructor?.name ?? 'unknown'
}
