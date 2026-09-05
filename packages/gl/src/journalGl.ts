/**
 * withJournal — a GLFacade decorator: writes create/destroy ops to the Journal.
 *
 * Contract §9.5 P3: the journal makes switchBackend = device-loss recovery =
 * = worker migration one replay mechanism.
 *
 * What is journaled automatically:
 *   - createTexture(w,h) → {kind:'createTexture', id, width, height}
 *   - createProgram(v,f) → {kind:'createProgram', id, vertex, fragment}
 *   - createBuffer(data) → {kind:'createBuffer', id, data}
 *   - createTarget(...)  → {kind:'createTarget', id, textureId, w, h, depth, color}
 *   - texImage2DFromSource(tex, src, opt) → {kind:'texImage2DFromSource', textureId, sourceKind, flipY}
 *
 * What is NOT in the journal (deliberately):
 *   - Frame ops (useProgram, setUniform*, bindTexture, bindTarget, drawArrays,
 *     setViewport, clear, setDepthMode, setCull, texSubImage2D streaming) —
 *     these are per-frame, they go to the Tape, not the Journal.
 *   - The texImage2DFromSource source is not serialized (an ImageBitmap may be
 *     closed, HTMLCanvasElement is DOM-dependent). The journal stores only kind+flipY;
 *     on replay the user provides the source via sourceFor(kind).
 *
 * Replay on a new facade: journal.replay(op => applyOp(op, targetGL, sourceFor?))
 *   — see replayJournalOn in this same file. All create ops are executed in
 *   record order; destroy ops are a no-op on a new facade for now (the resources do not exist yet).
 */

import type { Journal, DeclOp, ClearColor } from '@rune/core'
import { toFloat32Array } from '@rune/core'
import type { GLFacade, GLImageSource } from '@rune/webgl2'

/** Decorates GLFacade so that create/destroy ops are written to the Journal. */
export function withJournal(gl: GLFacade, journal: Journal): GLFacade {
  return {
    createProgram: (vertex, fragment) => {
      const id = gl.createProgram(vertex, fragment)
      journal.record({ kind: 'createProgram', id, vertex, fragment })
      return id
    },
    useProgram: id => gl.useProgram(id),
    createBuffer: (data, usage) => {
      const id = gl.createBuffer(data, usage)
      journal.record({ kind: 'createBuffer', id, data, usage })
      return id
    },
    // Task 140 — readBuffer: a DIAGNOSTIC read (one-shot, frame-independent)
    // — a frame op, not a journaled one. Passthrough.
    readBuffer: (bufferId, dst) => gl.readBuffer(bufferId, dst),
    bindVertexBuffer: (bufferId, location, size, stride, byteOffset, divisor) => gl.bindVertexBuffer(bufferId, location, size, stride, byteOffset, divisor),
    // M5 (Task 73): feed dual-bind — a frame op (per-frame dirty range), not journaled.
    updateBuffer: (bufferId, data, byteOffset) => gl.updateBuffer(bufferId, data, byteOffset),
    setUniformMatrix4: (programId, name, values) => gl.setUniformMatrix4(programId, name, values),
    setUniform4fv: (programId, name, values) => gl.setUniform4fv(programId, name, values),
    setUniform3fv: (programId, name, values) => gl.setUniform3fv(programId, name, values),
    setUniform2fv: (programId, name, values) => gl.setUniform2fv(programId, name, values),
    setUniform1f: (programId, name, value) => gl.setUniform1f(programId, name, value),
    setUniform1i: (programId, name, value) => gl.setUniform1i(programId, name, value),
    createTexture: (width, height, options) => {
      const id = gl.createTexture(width, height, options)
      // Task 67: the storage format goes into the v1 op (journal name 'rgba16float'),
      // so that replay/switch-backend recreates the texture with the same format.
      const format = options?.format === 'rgba16f' ? 'rgba16float' as const
        : options?.format === 'rgba32f' ? 'rgba32float' as const
        : undefined
      journal.record({ kind: 'createTexture', id, width, height, format, options })
      return id
    },
    texSubImage2D: (textureId, x, y, width, height, bytes) =>
      gl.texSubImage2D(textureId, x, y, width, height, bytes),
    texImage2DFromSource: (textureId, source, options) => {
      gl.texImage2DFromSource(textureId, source, options)
      journal.record({
        kind: 'texImage2DFromSource',
        textureId,
        sourceKind: describeSourceKind(source),
        flipY: options?.flipY ?? false,
      })
    },
    // Frame ops (per-frame): texSubImage2DFromSource + texImage2DLevel —
    // progressive mip streaming / sub-region upload. Not journaled
    // (like other frame ops — see the contract §9.5 P3: frame ops go to the Tape).
    // Pass-through without journal.record().
    texSubImage2DFromSource: (textureId, x, y, source, options) =>
      gl.texSubImage2DFromSource(textureId, x, y, source, options),
    texImage2DLevel: (textureId, level, source, options) =>
      gl.texImage2DLevel(textureId, level, source, options),
    bindTexture: (textureOrViewId, unit) => gl.bindTexture(textureOrViewId, unit),
    // Sub-mip views (Task 56): createTextureView/destroyTextureView —
    // long-lived declarations (like createTexture). Journaled for device-loss
    // recovery: on replay on a new backend the view is recreated via
    // target.createTextureView(textureId, { baseMipLevel, mipLevelCount }).
    // IMPORTANT: textureId in the record is the id on the CURRENT backend. On replay
    // the caller must map it to the new id (via registerIdMap or
    // a similar mechanism) — applyOp below delegates this to the calling code.
    createTextureView: (textureId, options) => {
      const viewId = gl.createTextureView(textureId, options)
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
      gl.deleteTextureView(viewId)
      journal.record({ kind: 'destroyTextureView', id: viewId })
    },
    setViewport: (width, height) => gl.setViewport(width, height),
    setDepthMode: (test, write) => gl.setDepthMode(test, write),
    setCull: mode => gl.setCull(mode),
    setBlend: (src, dst, equation) => gl.setBlend(src, dst, equation),
    clear: (color, depth) => gl.clear(color, depth),
    drawArrays: (mode, first, count, instances) => gl.drawArrays(mode, first, count, instances),
    createTarget: (textureId, width, height, depth, color) => {
      const id = gl.createTarget(textureId, width, height, depth, color)
      journal.record({ kind: 'createTarget', id, textureId, width, height, depth, color })
      return id
    },
    bindTarget: (targetId, clear) => gl.bindTarget(targetId, clear),
    // Task 80: readback — a READ, not a declaration: not journaled (like
    // frame ops §9.5 P3 — no replay needed, the result lives for one call).
    readTargetPixels: targetId => gl.readTargetPixels(targetId),
    // destroy ops: written to the journal so that Journal.compact() can pair
    // create+destroy. On replay on a new facade — destroy is a no-op (see applyOp).
    deleteTexture: textureId => {
      gl.deleteTexture(textureId)
      journal.record({ kind: 'destroyTexture', id: textureId })
    },
    deleteTarget: targetId => {
      gl.deleteTarget(targetId)
      journal.record({ kind: 'destroyTarget', id: targetId })
    },
    deleteProgram: programId => {
      gl.deleteProgram(programId)
      journal.record({ kind: 'destroyProgram', id: programId })
    },
    deleteBuffer: bufferId => {
      gl.deleteBuffer(bufferId)
      journal.record({ kind: 'destroyBuffer', id: bufferId })
    },
    // Task 132 — the transform-feedback family: NOT journaled (the same
    // contract as the WebGPU compute family — the orchestrator recreates
    // its passes on re-attach; the TF buffers themselves ARE journaled
    // through the ordinary createBuffer path).
    createTransformPass: desc => gl.createTransformPass(desc),
    runTransformPass: (passId, vertexCount, output) => gl.runTransformPass(passId, vertexCount, output),
    deleteTransformPass: passId => gl.deleteTransformPass(passId),
    texSubImage2DBuffer: (textureId, x, y, width, height, bufferId, byteOffset) =>
      gl.texSubImage2DBuffer(textureId, x, y, width, height, bufferId, byteOffset),
  }
}

/**
 * Replay the journal onto a target GLFacade — for device-loss recovery.
 *
 * sourceFor — a callback for texImage2DFromSource: returns the source by kind
 * (e.g. 'ImageBitmap' → a prepared bitmap). If the callback is not passed
 * or returns null — the op is skipped (the resource remains an "empty texture").
 *
 * Idempotence: a repeated replay will create DUPLICATES of resources (realGL
 * always issues a new id). The correct usage is on a FRESH backend.
 */
export function replayJournalOn(
  journal: Journal,
  target: GLFacade,
  sourceFor?: (kind: string) => GLImageSource | null,
): void {
  journal.replay(op => applyOp(op, target, sourceFor))
}

/** Apply one DeclOp to the target GLFacade. */
function applyOp(op: DeclOp, gl: GLFacade, sourceFor?: (kind: string) => GLImageSource | null): void {
  switch (op.kind) {
    case 'createTexture':
      // The returned id is ignored: on a new facade the id will be different.
      // Order matters: texture 1 → createTexture 1, texture 2 → createTexture 2,
      // id mapping is on the user's side.
      // Task 67: format from the op → GL name ('rgba16float' → 'rgba16f').
      gl.createTexture(op.width, op.height, {
        ...op.options,
        ...(op.format === 'rgba16float' || op.format === 'rgba32float'
          ? { format: op.format === 'rgba16float' ? 'rgba16f' as const : 'rgba32f' as const }
          : {}),
      })
      break
    case 'createProgram':
      gl.createProgram(op.vertex, op.fragment)
      break
    case 'createBuffer':
      // Task 61: after a JSON round-trip (worker migration) data can be a
      // plain-object {"0":v0,...} or number[]. Coerce to Float32Array BEFORE
      // passing to the facade — gl.bufferData with a plain object is incompatible, and
      // the withJournal decorator would have written a stale op into the journal.
      gl.createBuffer(op.data instanceof Float32Array ? op.data : toFloat32Array(op.data), op.usage)
      break
    case 'createTarget':
      gl.createTarget(op.textureId, op.width, op.height, op.depth, op.color as ClearColor)
      break
    case 'texImage2DFromSource': {
      const source = sourceFor?.(op.sourceKind) ?? null
      if (source === null) break // no source — skip (the texture remains empty)
      gl.texImage2DFromSource(op.textureId, source, { flipY: op.flipY })
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
    // journal.entries() before calling replayJournalOn.
    case 'createTextureView':
      gl.createTextureView(op.textureId, {
        baseMipLevel: op.baseMipLevel,
        mipLevelCount: op.mipLevelCount,
      })
      break
    // destroy ops on a new facade — no-op (the resources do not exist yet)
    // On the same facade (idempotence check) —
    // the responsibility lies with the facade: ignore or throw.
    default:
      break
  }
}

/** Source type name for the journal record. */
function describeSourceKind(source: GLImageSource): string {
  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) return 'ImageBitmap'
  if (typeof OffscreenCanvas !== 'undefined' && source instanceof OffscreenCanvas) return 'OffscreenCanvas'
  if (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) return 'HTMLCanvasElement'
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) return 'HTMLVideoElement'
  if (typeof source === 'object' && source !== null) {
    if ('getContext' in source) return 'OffscreenCanvas'
    if ('close' in source && 'width' in source) return 'ImageBitmap'
  }
  return (source as { constructor: { name: string } }).constructor?.name ?? 'unknown'
}
