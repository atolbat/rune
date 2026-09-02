/**
 * resourceSessionGL — a stable-id session over GLFacade + journal v2.
 *
 * THE ROOT OF THE REWORK (Task 62): previously the journal stored the
 * facade's counter ids, and replay on a fresh facade produced DIFFERENT ids
 * whenever there were gaps → dependent ops missed the textures → the scene
 * did not restore.
 *
 * Now the session introduces STABLE ids with its own counter (over the
 * facade):
 *   • public facade.createTexture(...) → a stable id, a mapping of
 *     stable → raw-facade, journal.record(texture.create);
 *   • all methods taking textureId/viewId/targetId translate the
 *     stable id → the raw id of the current device incarnation;
 *   • restore() takes ids FROM journal ops and rebuilds the mapping on a
 *     fresh facade → ids match before and after loss BY CONSTRUCTION.
 *
 * PRIMARY resources WITH CONTENT are journaled (texture.write/update/
 * writeMip store a ContentRef to a CPU source — sources survive loss).
 * Programs/buffers are DERIVED state: pass-through raw ids without
 * journaling (the renderer re-creates them lazily from command specs).
 * Raw-byte texSubImage2D is the domain of the UploadScheduler, not
 * journaled.
 *
 * Restoration and normal operation are ONE path: restore() calls the same
 * raw-facade methods as the live code (texImage2DFromSource /
 * texSubImage2DFromSource / texImage2DLevel / createTextureView / ...).
 */

import type { ResourceJournal, ResOp, RestoreReport, ContentRef, WorkingSet, EvictionReport, ResidencyStats, TextureFormat } from '@rune/core'
import { selectResidentOps, selectLRUEvictions, estimateTextureBytes } from '@rune/core'
import type { GLFacade, GLImageSource, GLTextureFormat } from '@rune/webgl2'

/** Starting id for the view namespace (parity with realGL: ≥ 1M). */
const VIEW_ID_BASE = 1_000_000

/** Task 67: journal format (WebGPU names) → GL facade format.
 *  'canvas' and 'rgba8unorm' — RGBA8 (the GL default, not written into ops).
 *  'rgba16float' → 'rgba16f' (texStorage2D RGBA16F + HALF_FLOAT uploads).
 *  'rgba32float' → 'rgba32f' (RGBA32F + FLOAT). */
export function glFormatFromTextureFormat(fmt?: TextureFormat): GLTextureFormat | undefined {
  if (fmt === 'rgba16float') return 'rgba16f'
  if (fmt === 'rgba32float') return 'rgba32f'
  return undefined
}

/** Task 67: GL facade format → journal format (undefined = the default rgba8unorm). */
export function textureFormatFromGL(fmt?: GLTextureFormat): TextureFormat | undefined {
  if (fmt === 'rgba16f') return 'rgba16float'
  if (fmt === 'rgba32f') return 'rgba32float'
  return undefined
}

export interface ResourceSessionGL {
  /** Public facade: the same GLFacade contract, but the ids are stable. */
  readonly facade: GLFacade
  /** Current stable textureId → raw id (diagnostics/tests). */
  readonly mapping: ReadonlyMap<number, number>
  /** Translate any stable id (texture/view/target) to the raw id of the
   *  current device incarnation. undefined — the id is unknown to the session. */
  rawId(stableId: number): number | undefined
  /** Replay the journal on a FRESH raw facade of this session.
   *  Call after device re-init, BEFORE creating new resources.
   *  A repeated call on a live facade will create duplicates (as any replay would).
   *
   *  Task 65 soft reset: keep (the working set) — restore ONLY its
   *  closure (scene + content + parents of views); the rest stays a
   *  declaration in the journal (report.deferred) and will come back lazily
   *  via ensureResident(). Without keep — a full replay (strategy='full'). */
  restore(keep?: WorkingSet): RestoreReport
  /** Task 65: lazy return of ONE resource into GPU memory after a soft reset.
   *  textureId → create + content; viewId → parent (create + content) + view;
   *  targetId → parent create + target. Idempotent: an already resident
   *  resource is a no-op (null). Returns a replay report of a journal sublist. */
  ensureResident(resourceId: number): RestoreReport | null
  /** Task 66: LRU eviction of resident textures down to a budget (the
   *  flip side of ensureResident). Evicted views/targets — the closure over
   *  evicted textures. Raw resources are freed, declarations+content
   *  remain in the journal (the resource will come back via ensureResident).
   *  The journal is NOT changed. pinned (e.g. the scene's working set) is untouchable. */
  evictLRU(options?: { budgetBytes?: number; pinned?: WorkingSet }): EvictionReport
  /** Task 66: resident GPU memory estimate + LRU order (diagnostics). */
  residencyStats(): ResidencyStats
}

/** Create a session: stable ids + journaling over a raw facade. */
export function createResourceSessionGL(raw: GLFacade, journal: ResourceJournal): ResourceSessionGL {
  // stable id → raw id (the current device incarnation)
  const texMap = new Map<number, number>()
  const viewMap = new Map<number, number>()
  const targetMap = new Map<number, number>()
  // Task 66: LRU residency tracking.
  //  • lastUse: stable textureId → a monotonic usage counter;
  //  • viewParent/targetParent: dependent id → parent texture
  //    (the eviction closure: a texture drags its views/targets along);
  //  • texMeta: dimensions+mipLevels of resident textures (GPU memory estimate).
  let useCounter = 0
  const lastUse = new Map<number, number>()
  const viewParent = new Map<number, number>()
  const targetParent = new Map<number, number>()
  const texMeta = new Map<number, { w: number; h: number; mips: number; format?: TextureFormat }>()
  // dimensions of stable textures — for classifying a full GPU upload;
  // not needed on GL (texImage2DFromSource is always full), but kept for parity
  let nextTex = 1
  let nextView = VIEW_ID_BASE
  let nextTarget = 1

  /** Mark a texture as used (LRU freshness). */
  function touch(textureId: number): void {
    lastUse.set(textureId, ++useCounter)
  }
  /** Touch by a texture-OR-view id (view → parent texture). */
  function touchTexOrView(texOrViewId: number): void {
    touch(texOrViewId >= VIEW_ID_BASE ? (viewParent.get(texOrViewId) ?? texOrViewId) : texOrViewId)
  }

  function seedCounters(): void {
    nextTex = Math.max(nextTex, journal.maxTextureId() + 1)
    nextView = Math.max(nextView, journal.maxViewId() + 1)
    nextTarget = Math.max(nextTarget, journal.maxTargetId() + 1)
  }
  seedCounters()

  const rawTex = (id: number): number => {
    const mapped = texMap.get(id)
    if (mapped === undefined) {
      throw new Error(`resourceSession: unknown stable textureId=${id}. ` +
        `The resource was not created in this session (or restore() has not been run after device loss).`)
    }
    return mapped
  }
  const rawView = (id: number): number => {
    const mapped = viewMap.get(id)
    if (mapped === undefined) {
      throw new Error(`resourceSession: unknown stable viewId=${id}.`)
    }
    return mapped
  }
  const rawTarget = (id: number): number => {
    const mapped = targetMap.get(id)
    if (mapped === undefined) {
      throw new Error(`resourceSession: unknown stable targetId=${id}.`)
    }
    return mapped
  }
  /** The id can be a textureId (<VIEW_ID_BASE) or a viewId (≥VIEW_ID_BASE). */
  const rawTexOrView = (id: number): number =>
    id >= VIEW_ID_BASE ? rawView(id) : rawTex(id)

  const facade: GLFacade = {
    // ─── Derived state: pass-through raw ids, WITHOUT the journal ─────────
    createProgram: (vertex, fragment) => raw.createProgram(vertex, fragment),
    useProgram: programId => raw.useProgram(programId),
    createBuffer: data => raw.createBuffer(data),
    bindVertexBuffer: (bufferId, location, size, stride, byteOffset, divisor) => raw.bindVertexBuffer(bufferId, location, size, stride, byteOffset, divisor),
    // M5 (Task 73): feed dual-bind — a frame op (per-frame dirty range), not journaled.
    updateBuffer: (bufferId, data, byteOffset) => raw.updateBuffer(bufferId, data, byteOffset),
    setUniformMatrix4: (programId, name, values) => raw.setUniformMatrix4(programId, name, values),
    setUniform4fv: (programId, name, values) => raw.setUniform4fv(programId, name, values),
    setUniform3fv: (programId, name, values) => raw.setUniform3fv(programId, name, values),
    setUniform2fv: (programId, name, values) => raw.setUniform2fv(programId, name, values),
    setUniform1f: (programId, name, value) => raw.setUniform1f(programId, name, value),
    setUniform1i: (programId, name, value) => raw.setUniform1i(programId, name, value),

    // ─── Primary resources: stable ids + journal ───────────────────────
    createTexture: (width, height, options) => {
      const rawId = raw.createTexture(width, height, options)
      const id = nextTex++
      texMap.set(id, rawId)
      // Task 67: storage format — into meta (residency bytes: HDR 2×/4×) and
      // into the journal (replay/ensureResident re-creates the texture with
      // the same format). The GL name ('rgba16f') is normalized to the journal
      // one ('rgba16float'); we do NOT duplicate the format in options — it
      // lives at the top level of the op. Options without content are written
      // as undefined — the journal stays compact and replay passes the facade
      // exactly the same args as the live path.
      const format = textureFormatFromGL(options?.format)
      const { format: _glFmt, ...rest } = options ?? {}
      const journalOptions = Object.keys(rest).length > 0 ? rest : undefined
      texMeta.set(id, { w: width, h: height, mips: options?.mipLevels ?? 1, format })
      touch(id)
      journal.record({ kind: 'texture.create', id, width, height, format, options: journalOptions })
      return id
    },
    texImage2DFromSource: (textureId, source, options) => {
      raw.texImage2DFromSource(rawTex(textureId), source, options)
      touch(textureId)
      const [w, h] = glSourceSize(source)
      const content = journal.storeSource(source, describeSourceKind(source), w, h)
      journal.record({ kind: 'texture.write', id: textureId, content, flipY: options?.flipY ?? false })
    },
    texSubImage2DFromSource: (textureId, x, y, source, options) => {
      raw.texSubImage2DFromSource(rawTex(textureId), x, y, source, options)
      touch(textureId)
      const [w, h] = glSourceSize(source)
      const content = journal.storeSource(source, describeSourceKind(source), w, h)
      journal.record({ kind: 'texture.update', id: textureId, x, y, w, h, content, flipY: options?.flipY ?? false })
    },
    texImage2DLevel: (textureId, level, source, options) => {
      raw.texImage2DLevel(rawTex(textureId), level, source, options)
      touch(textureId)
      const [w, h] = glSourceSize(source)
      const content = journal.storeSource(source, describeSourceKind(source), w, h)
      journal.record({ kind: 'texture.writeMip', id: textureId, level, content, flipY: options?.flipY ?? false })
    },
    // Raw-byte streaming is the domain of the UploadScheduler: the Pump holds
    // the data and re-streams it. Journaling chunks would blow up the journal.
    texSubImage2D: (textureId, x, y, width, height, bytes) => {
      touch(textureId)
      raw.texSubImage2D(rawTex(textureId), x, y, width, height, bytes)
    },
    bindTexture: (textureOrViewId, unit) => {
      touchTexOrView(textureOrViewId)
      raw.bindTexture(rawTexOrView(textureOrViewId), unit)
    },
    createTextureView: (textureId, options) => {
      const rawViewId = raw.createTextureView(rawTex(textureId), options)
      const id = nextView++
      viewMap.set(id, rawViewId)
      viewParent.set(id, textureId)
      touch(textureId)
      journal.record({
        kind: 'view.create',
        id,
        textureId,
        baseMipLevel: options?.baseMipLevel,
        mipLevelCount: options?.mipLevelCount,
      })
      return id
    },
    deleteTextureView: viewId => {
      // Task 65: a deferred view — only the declaration in the journal.
      const mapped = viewMap.get(viewId)
      if (mapped !== undefined) raw.deleteTextureView(mapped)
      viewMap.delete(viewId)
      viewParent.delete(viewId)
      journal.record({ kind: 'view.destroy', id: viewId })
    },
    createTarget: (textureId, width, height, depth, color) => {
      const rawId = raw.createTarget(rawTex(textureId), width, height, depth, color)
      const id = nextTarget++
      targetMap.set(id, rawId)
      targetParent.set(id, textureId)
      touch(textureId)
      journal.record({ kind: 'target.create', id, textureId, width, height, depth, color })
      return id
    },
    bindTarget: (targetId, clear) => {
      if (targetId !== 0) {
        const parent = targetParent.get(targetId)
        if (parent !== undefined) touch(parent)
      }
      raw.bindTarget(targetId === 0 ? 0 : rawTarget(targetId), clear)
    },
    // Task 80: readback — translate the stable target id to a raw id (pass-through,
    // the read is not journaled).
    readTargetPixels: targetId => raw.readTargetPixels(targetId === 0 ? 0 : rawTarget(targetId)),
    deleteTarget: targetId => {
      // Task 65: a deferred target — only the declaration in the journal.
      const mapped = targetMap.get(targetId)
      if (mapped !== undefined) raw.deleteTarget(mapped)
      targetMap.delete(targetId)
      targetParent.delete(targetId)
      journal.record({ kind: 'target.destroy', id: targetId })
    },
    deleteTexture: textureId => {
      // Task 65: the resource may be DEFERRED (a soft reset did not restore it) —
      // then there is no raw call, but texture.destroy in the journal is mandatory
      // (kill the declaration → compact will purge the create→destroy pair).
      // Task 66: an evicted (evictLRU) resource is the same: no raw, only an
      // EXPLICIT deletion kills the declaration (eviction is not the death of a resource).
      const mapped = texMap.get(textureId)
      if (mapped !== undefined) raw.deleteTexture(mapped)
      texMap.delete(textureId)
      texMeta.delete(textureId)
      lastUse.delete(textureId)
      journal.record({ kind: 'texture.destroy', id: textureId })
    },

    // ─── Frame ops: pass-through (not resources) ───────────────────────────
    setViewport: (width, height) => raw.setViewport(width, height),
    setDepthMode: (test, write) => raw.setDepthMode(test, write),
    setCull: mode => raw.setCull(mode),
    setBlend: (src, dst) => raw.setBlend(src, dst),
    clear: (color, depth) => raw.clear(color, depth),
    drawArrays: (mode, first, count, instances) => raw.drawArrays(mode, first, count, instances),
    deleteProgram: programId => raw.deleteProgram(programId),
    deleteBuffer: bufferId => raw.deleteBuffer(bufferId),
  }

  // ─── Task 65: applying a single op on the raw facade WITHOUT journaling ─────
  // One code path for restore() and ensureResident() (the principle "live and
  // restore — one path"): the same facade calls as in live operation,
  // only the id comes from the op instead of being generated by a counter.
  // Task 66: every applied op marks usage (touch) —
  // ensureResident makes the resource the freshest in LRU.
  function applyOp(op: ResOp, acc: {
    opsReplayed: number; contentOps: number; skipped: number
    textureIds: number[]; viewIds: number[]; targetIds: number[]
  }): void {
    switch (op.kind) {
      case 'texture.create': {
        // Task 67: format from the op → GL facade format (rgba16float→rgba16f).
        // "Live and restore — one path": applyOp calls the same
        // raw.createTexture with the same options as the live code. We mix in
        // the format ONLY when present — the args contract is identical to the
        // live path (no format key for ordinary RGBA8 textures).
        const glFormat = glFormatFromTextureFormat(op.format)
        const rawId = raw.createTexture(
          op.width,
          op.height,
          glFormat === undefined ? op.options : { ...op.options, format: glFormat },
        )
        texMap.set(op.id, rawId)
        texMeta.set(op.id, { w: op.width, h: op.height, mips: op.options?.mipLevels ?? 1, format: op.format })
        touch(op.id)
        acc.textureIds.push(op.id)
        acc.opsReplayed++
        break
      }
      case 'texture.write': {
        const source = journal.getSource(op.content.ref)
        if (source === null || !sourceAlive(source)) { acc.skipped++; break }
        raw.texImage2DFromSource(rawTex(op.id), source as GLImageSource, { flipY: op.flipY })
        touch(op.id)
        acc.contentOps++
        acc.opsReplayed++
        break
      }
      case 'texture.update': {
        const source = journal.getSource(op.content.ref)
        if (source === null || !sourceAlive(source)) { acc.skipped++; break }
        raw.texSubImage2DFromSource(rawTex(op.id), op.x, op.y, source as GLImageSource, { flipY: op.flipY })
        touch(op.id)
        acc.contentOps++
        acc.opsReplayed++
        break
      }
      case 'texture.writeMip': {
        const source = journal.getSource(op.content.ref)
        if (source === null || !sourceAlive(source)) { acc.skipped++; break }
        raw.texImage2DLevel(rawTex(op.id), op.level, source as GLImageSource, { flipY: op.flipY })
        touch(op.id)
        acc.contentOps++
        acc.opsReplayed++
        break
      }
      case 'view.create': {
        const rawViewId = raw.createTextureView(rawTex(op.textureId), {
          baseMipLevel: op.baseMipLevel,
          mipLevelCount: op.mipLevelCount,
        })
        viewMap.set(op.id, rawViewId)
        viewParent.set(op.id, op.textureId)
        touch(op.textureId)
        acc.viewIds.push(op.id)
        acc.opsReplayed++
        break
      }
      case 'target.create': {
        const rawId = raw.createTarget(rawTex(op.textureId), op.width, op.height, op.depth, op.color)
        targetMap.set(op.id, rawId)
        targetParent.set(op.id, op.textureId)
        touch(op.textureId)
        acc.targetIds.push(op.id)
        acc.opsReplayed++
        break
      }
      // destroy-ops on a fresh facade — no-op: the resources of the former
      // incarnation are not here (they died together with the device).
      default:
        break
    }
  }

  function restore(keep?: WorkingSet): RestoreReport {
    seedCounters()
    // A fresh device incarnation: the mappings and LRU tracking of the old one are garbage
    // (raw ids are dead, and deferred resources are NOT resident). We clean up,
    // otherwise evictLRU/residencyStats would count dead ids as "resident".
    texMap.clear()
    viewMap.clear()
    targetMap.clear()
    viewParent.clear()
    targetParent.clear()
    texMeta.clear()
    lastUse.clear()
    const acc = { opsReplayed: 0, contentOps: 0, skipped: 0, textureIds: [] as number[], viewIds: [] as number[], targetIds: [] as number[] }
    if (keep !== undefined) {
      // Task 65 soft reset: only the closure of the working set; the rest
      // stays deferred (will come back lazily via ensureResident).
      const sel = selectResidentOps(journal.entries(), keep)
      for (const op of sel.ops) applyOp(op, acc)
      return {
        ...acc,
        deferred: { textures: sel.deferredTextures, views: sel.deferredViews, targets: sel.deferredTargets },
      }
    }
    journal.replay(op => applyOp(op, acc))
    return { ...acc }
  }

  function ensureResident(resourceId: number): RestoreReport | null {
    // Already resident — no-op. Namespace: viewId ≥ 1M; texture/target are
    // checked against journal ops (id < 1M: first texture, then target).
    if (resourceId >= VIEW_ID_BASE) {
      if (viewMap.has(resourceId)) return null
      const sel = selectResidentOps(journal.entries(), { viewIds: [resourceId] })
      const acc = { opsReplayed: 0, contentOps: 0, skipped: 0, textureIds: [] as number[], viewIds: [] as number[], targetIds: [] as number[] }
      for (const op of sel.ops) applyOp(op, acc)
      return { ...acc }
    }
    if (texMap.has(resourceId)) return null
    // Texture or target? Look at what is alive in the journal under this id.
    const isTexture = journal.entries().some(op => op.kind === 'texture.create' && op.id === resourceId)
    const sel = selectResidentOps(
      journal.entries(),
      isTexture ? { textureIds: [resourceId] } : { targetIds: [resourceId] },
    )
    const acc = { opsReplayed: 0, contentOps: 0, skipped: 0, textureIds: [] as number[], viewIds: [] as number[], targetIds: [] as number[] }
    for (const op of sel.ops) applyOp(op, acc)
    return { ...acc }
  }

  // ─── Task 66: LRU eviction (pressure → evict) ────────────────────────────
  /** Parents of pinned views/targets from the JOURNAL (the source of truth;
   *  the session knows the parents only of resident ones). The LAST create
   *  op of an id is taken. */
  function pinnedTextures(pinned?: WorkingSet): Set<number> {
    const pin = new Set<number>(pinned?.textureIds ?? [])
    if (pinned?.viewIds !== undefined || pinned?.targetIds !== undefined) {
      for (const op of journal.entries()) {
        if (op.kind === 'view.create' && pinned.viewIds?.includes(op.id)) pin.add(op.textureId)
        else if (op.kind === 'target.create' && pinned.targetIds?.includes(op.id)) pin.add(op.textureId)
      }
    }
    return pin
  }

  /** Entries of the LRU tracking of resident textures. */
  function residencyEntries(): { id: number; bytes: number; lastUse: number }[] {
    const entries: { id: number; bytes: number; lastUse: number }[] = []
    for (const id of texMap.keys()) {
      const meta = texMeta.get(id)
      // Task 67: the estimate accounts for the format (rgba16float — 8
      // bytes/pixel, rgba32float — 16): an HDR texture "weighs" honestly in eviction.
      const bytes = meta !== undefined ? estimateTextureBytes(meta.w, meta.h, meta.mips, meta.format) : 0
      entries.push({ id, bytes, lastUse: lastUse.get(id) ?? 0 })
    }
    return entries
  }

  function residencyStats(): ResidencyStats {
    const textures = residencyEntries().sort((a, b) => a.lastUse - b.lastUse || a.id - b.id)
    return {
      textures,
      totalBytes: textures.reduce((sum, e) => sum + e.bytes, 0),
      views: [...viewMap.keys()].sort((a, b) => a - b),
      targets: [...targetMap.keys()].sort((a, b) => a - b),
    }
  }

  function evictLRU(options?: { budgetBytes?: number; pinned?: WorkingSet }): EvictionReport {
    const budget = options?.budgetBytes ?? Number.POSITIVE_INFINITY
    const pin = pinnedTextures(options?.pinned)
    const entries = residencyEntries()
    const plan = selectLRUEvictions(entries, budget, pin)
    const evictedViews: number[] = []
    const evictedTargets: number[] = []
    for (const texId of plan.evictIds) {
      // Closure: resident views/targets of this texture are useless without
      // its storage (GL: a view is a mip range, a target is an FBO on the texture).
      for (const [viewId, parent] of viewParent) {
        if (parent === texId && viewMap.has(viewId)) {
          raw.deleteTextureView(viewMap.get(viewId)!)
          viewMap.delete(viewId)
          viewParent.delete(viewId)
          evictedViews.push(viewId)
        }
      }
      for (const [targetId, parent] of targetParent) {
        if (parent === texId && targetMap.has(targetId)) {
          raw.deleteTarget(targetMap.get(targetId)!)
          targetMap.delete(targetId)
          targetParent.delete(targetId)
          evictedTargets.push(targetId)
        }
      }
      // Free the raw texture WITHOUT a journal record: the resource lives as a
      // declaration + content (like deferred after a soft reset) and will come
      // back via ensureResident through the same code path. Eviction is not destruction.
      const mapped = texMap.get(texId)
      if (mapped !== undefined) raw.deleteTexture(mapped)
      texMap.delete(texId)
      texMeta.delete(texId)
      lastUse.delete(texId)
    }
    return {
      textures: plan.evictIds,
      views: evictedViews,
      targets: evictedTargets,
      freedBytes: plan.freedBytes,
      residentBytes: plan.residentBytes,
      residentTextures: [...texMap.keys()].sort((a, b) => a - b),
    }
  }

  return {
    facade,
    get mapping() { return texMap as ReadonlyMap<number, number> },
    rawId(stableId: number): number | undefined {
      if (stableId >= VIEW_ID_BASE) return viewMap.get(stableId)
      return texMap.get(stableId) ?? targetMap.get(stableId)
    },
    restore,
    ensureResident,
    evictLRU,
    residencyStats,
  }
}

/** Size of a GL source (analogous to externalImageSize from @rune/webgpu). */
function glSourceSize(source: GLImageSource): [number, number] {
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) {
    return [source.videoWidth || 0, source.videoHeight || 0]
  }
  const s = source as { width?: number; height?: number; displayWidth?: number; displayHeight?: number }
  if (typeof s.displayWidth === 'number' && s.displayWidth > 0) return [s.displayWidth, s.displayHeight ?? 0]
  return [s.width ?? 0, s.height ?? 0]
}

/** Source type name (parity with journalGl/journalGpu v1). */
function describeSourceKind(source: GLImageSource): string {
  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) return 'ImageBitmap'
  if (typeof OffscreenCanvas !== 'undefined' && source instanceof OffscreenCanvas) return 'OffscreenCanvas'
  if (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) return 'HTMLCanvasElement'
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) return 'HTMLVideoElement'
  if (typeof source === 'object' && source !== null) {
    if ('getContext' in source) return 'OffscreenCanvas'
    if ('close' in source && 'width' in source) return 'ImageBitmap'
  }
  return (source as { constructor?: { name?: string } }).constructor?.name ?? 'unknown'
}

/** A dead source: null/undefined, a closed ImageBitmap (width=0),
 *  or any bitmap-like object with zero numeric dimensions
 *  (a closed/invalid canvas). Such sources cannot be uploaded. */
function sourceAlive(source: unknown): boolean {
  if (source === null || source === undefined) return false
  const s = source as { width?: unknown; height?: unknown }
  if (typeof s.width === 'number' && typeof s.height === 'number') {
    return s.width > 0 && s.height > 0
  }
  return true
}

/** Apply a single ResOp to a GL facade WITHOUT a session (raw id = stable id).
 *  Useful for tests and for accepting ops on a facade where ids already match. */
export function applyResOpGL(op: ResOp, gl: GLFacade, sourceFor: (content: ContentRef) => GLImageSource | null): void {
  switch (op.kind) {
    case 'texture.create': {
      const glFormat = glFormatFromTextureFormat(op.format)
      gl.createTexture(
        op.width,
        op.height,
        glFormat === undefined ? op.options : { ...op.options, format: glFormat },
      )
      break
    }
    case 'texture.write': {
      const source = sourceFor(op.content)
      if (source !== null) gl.texImage2DFromSource(op.id, source, { flipY: op.flipY })
      break
    }
    case 'texture.update': {
      const source = sourceFor(op.content)
      if (source !== null) gl.texSubImage2DFromSource(op.id, op.x, op.y, source, { flipY: op.flipY })
      break
    }
    case 'texture.writeMip': {
      const source = sourceFor(op.content)
      if (source !== null) gl.texImage2DLevel(op.id, op.level, source, { flipY: op.flipY })
      break
    }
    case 'view.create':
      gl.createTextureView(op.textureId, { baseMipLevel: op.baseMipLevel, mipLevelCount: op.mipLevelCount })
      break
    case 'target.create':
      gl.createTarget(op.textureId, op.width, op.height, op.depth, op.color)
      break
    default:
      break
  }
}
