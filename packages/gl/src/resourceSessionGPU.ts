/**
 * resourceSessionGPU — a stable-id session over GPUFacade + journal v2.
 *
 * The WebGPU twin of resourceSessionGL.ts. The same three decisions (Task 62):
 * stable ids over the facade, primitive ops, content in the journal.
 *
 * Differences from the GL session:
 *  • createTexture takes a format parameter ('rgba8unorm' | 'canvas' |
 *    'rgba16float' | 'rgba32float' — Task 67 HDR) — stored in the
 *    texture.create op;
 *  • copyExternalImageToTexture is the only upload primitive: a full
 *    upload (dst 0,0 + the copy covers the whole texture) → texture.write,
 *    otherwise → texture.update (sub-region, atlas packing);
 *  • copyExternalImageToTextureMip → texture.writeMip;
 *  • pipelines are lazy (ensurePipeline — pass-through, WGSL lives in
 *    WgpuCommand), vertex buffers are keyed by Float32Array (pass-through) —
 *    derived state, not owned by the journal.
 *
 * bindTexture accepts a textureId OR a viewId (namespace ≥ 1M) —
 * translated to the raw id of the current device incarnation.
 */

import type { ResourceJournal, ResOp, RestoreReport, WorkingSet, EvictionReport, ResidencyStats, TextureFormat } from '@rune/core'
import { selectResidentOps, selectLRUEvictions, estimateTextureBytes } from '@rune/core'
import type { GPUFacade, GPUImageSource } from '@rune/webgpu'

/** Starting id for the view namespace (parity with realGPU: ≥ 1M). */
const VIEW_ID_BASE = 1_000_000

export interface ResourceSessionGPU {
  /** Public facade: the same GPUFacade contract, but texture/view/target ids are stable. */
  readonly facade: GPUFacade
  /** Current stable textureId → raw id (diagnostics/tests). */
  readonly mapping: ReadonlyMap<number, number>
  /** Translate any stable id (texture/view/target) to a raw id. */
  rawId(stableId: number): number | undefined
  /** Replay the journal on a FRESH raw facade of this session.
   *  Task 65 soft reset: keep — restore only the closure of the working
   *  set; the rest stays deferred (lazily via ensureResident). */
  restore(keep?: WorkingSet): RestoreReport
  /** Task 65: lazy return of a single resource (texture/view/target id)
   *  after a soft reset. Idempotent (resident → null). */
  ensureResident(resourceId: number): RestoreReport | null
  /** Task 66: LRU eviction of resident textures down to a budget (parity
   *  with the GL session: closure of views/targets, the journal is unchanged). */
  evictLRU(options?: { budgetBytes?: number; pinned?: WorkingSet }): EvictionReport
  /** Task 66: resident GPU memory estimate + LRU order (diagnostics). */
  residencyStats(): ResidencyStats
}

/** Create a session: stable ids + journaling on top of a raw GPUFacade. */
export function createResourceSessionGPU(raw: GPUFacade, journal: ResourceJournal): ResourceSessionGPU {
  const texMap = new Map<number, number>()
  const viewMap = new Map<number, number>()
  const targetMap = new Map<number, number>()
  /** Stable textureId → dimensions (for classifying a full upload). */
  const texSizes = new Map<number, { w: number; h: number }>()
  // Task 66: LRU tracking (a monotonic lastUse) + parents of dependent
  // resources (the eviction closure) + mipLevels for the GPU memory estimate.
  let useCounter = 0
  const lastUse = new Map<number, number>()
  const viewParent = new Map<number, number>()
  const targetParent = new Map<number, number>()
  const texMips = new Map<number, number>()
  // Task 67: storage format (HDR 2×/4× bytes per pixel) — for the GPU
  // memory estimate in residency/evictLRU.
  const texFormats = new Map<number, TextureFormat | undefined>()
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
  const rawTexOrView = (id: number): number =>
    id >= VIEW_ID_BASE ? rawView(id) : rawTex(id)

  const facade: GPUFacade = {
    configure: (w, h) => raw.configure(w, h),
    resize: (w, h) => raw.resize(w, h),
    // Task 116: renderer init state — a pass-through (the clear is policy,
    // not a resource; the journal does not model it, the renderer re-applies
    // it after recovery).
    setCanvasClearColor: (color, depth) => raw.setCanvasClearColor(color, depth),

    createTexture: (width, height, format, options) => {
      const rawId = raw.createTexture(width, height, format, options)
      const id = nextTex++
      texMap.set(id, rawId)
      texSizes.set(id, { w: width, h: height })
      texMips.set(id, options?.mipLevels ?? 1)
      texFormats.set(id, format)
      touch(id)
      journal.record({ kind: 'texture.create', id, width, height, format, options })
      return id
    },
    texSubImage2D: (textureId, x, y, w, h, bytes) => {
      touch(textureId)
      raw.texSubImage2D(rawTex(textureId), x, y, w, h, bytes)
    },
    copyExternalImageToTexture: (textureId, source, dstX, dstY, copyWidth, copyHeight, flipY) => {
      raw.copyExternalImageToTexture(rawTex(textureId), source, dstX, dstY, copyWidth, copyHeight, flipY)
      touch(textureId)
      const size = texSizes.get(textureId)
      const isFull = size !== undefined
        && dstX === 0 && dstY === 0
        && copyWidth === size.w && copyHeight === size.h
      const kind = describeGpuSourceKind(source)
      const content = journal.storeSource(source, kind, copyWidth, copyHeight)
      if (isFull) {
        journal.record({ kind: 'texture.write', id: textureId, content, flipY: flipY === true })
      } else {
        journal.record({ kind: 'texture.update', id: textureId, x: dstX, y: dstY, w: copyWidth, h: copyHeight, content, flipY: flipY === true })
      }
    },
    copyExternalImageToTextureMip: (textureId, mipLevel, source, dstX, dstY, copyWidth, copyHeight, flipY) => {
      raw.copyExternalImageToTextureMip(rawTex(textureId), mipLevel, source, dstX, dstY, copyWidth, copyHeight, flipY)
      touch(textureId)
      const kind = describeGpuSourceKind(source)
      const content = journal.storeSource(source, kind, copyWidth, copyHeight)
      journal.record({ kind: 'texture.writeMip', id: textureId, level: mipLevel, content, flipY: flipY === true })
    },
    uploadUniforms: (offset, data) => raw.uploadUniforms(offset, data),
    ensurePipeline: (pipelineId, wgsl, attrSizes, hasTextures) =>
      raw.ensurePipeline(pipelineId, wgsl, attrSizes, hasTextures),
    usePipeline: pipelineId => raw.usePipeline(pipelineId),
    bindUniforms: dynamicOffset => raw.bindUniforms(dynamicOffset),
    bindVertexBuffer: (slot, data, size) => raw.bindVertexBuffer(slot, data, size),
    // M5 (Task 73): feed dual-bind — a frame op (per-frame dirty range), not journaled.
    syncVertexBuffer: (data, byteLength) => raw.syncVertexBuffer(data, byteLength),
    bindExternalVertexBuffer: (slot, bufferId) => raw.bindExternalVertexBuffer(slot, bufferId),
    createExternalBuffer: (byteLength, usage) => raw.createExternalBuffer(byteLength, usage),
    writeExternalBuffer: (id, data, byteOffset, byteLength) => raw.writeExternalBuffer(id, data, byteOffset, byteLength),
    readExternalBuffer: (id, byteLength) => raw.readExternalBuffer(id, byteLength),
    deleteExternalBuffer: id => raw.deleteExternalBuffer(id),
    externalBufferOf: id => raw.externalBufferOf(id),
    createCompute: (wgsl, uniformBytes, bufferIds) => raw.createCompute(wgsl, uniformBytes, bufferIds),
    runCompute: (computeId, entry, uniformData, workgroups) => raw.runCompute(computeId, entry, uniformData, workgroups),
    bindTexture: textureOrViewId => {
      touchTexOrView(textureOrViewId)
      raw.bindTexture(rawTexOrView(textureOrViewId))
    },
    beginPass: clearIndex => raw.beginPass(clearIndex),
    draw: (count, instances) => raw.draw(count, instances),
    endPass: () => raw.endPass(),
    submit: () => raw.submit(),

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

    deleteTexture: textureId => {
      // Task 65: the resource may be DEFERRED (a soft reset did not restore it) —
      // then there is no raw call, but texture.destroy in the journal is mandatory
      // (kill the declaration → compact will purge the create→destroy pair).
      // Task 66: an evicted (evictLRU) resource — the same: no raw, only an
      // EXPLICIT deletion kills the declaration (eviction is not the death of a resource).
      const mapped = texMap.get(textureId)
      if (mapped !== undefined) raw.deleteTexture(mapped)
      texMap.delete(textureId)
      texSizes.delete(textureId)
      texMips.delete(textureId)
      texFormats.delete(textureId)
      lastUse.delete(textureId)
      journal.record({ kind: 'texture.destroy', id: textureId })
    },
    deleteTarget: targetId => {
      // Task 65: a deferred target — only the declaration in the journal.
      const mapped = targetMap.get(targetId)
      if (mapped !== undefined) raw.deleteTarget(mapped)
      targetMap.delete(targetId)
      targetParent.delete(targetId)
      journal.record({ kind: 'target.destroy', id: targetId })
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
    dispose: () => raw.dispose(),
    installTimer: handle => raw.installTimer(handle),
    get adapter() { return raw.adapter },
    get device() { return raw.device },
    get preferredFormat() { return raw.preferredFormat },
    get timer() { return raw.timer },
  }

  // ─── Task 65: applying a single op without journaling ──────────────────────
  function applyOp(op: ResOp, acc: {
    opsReplayed: number; contentOps: number; skipped: number
    textureIds: number[]; viewIds: number[]; targetIds: number[]
  }): void {
    switch (op.kind) {
      case 'texture.create': {
        const rawId = raw.createTexture(op.width, op.height, op.format, op.options)
        texMap.set(op.id, rawId)
        texSizes.set(op.id, { w: op.width, h: op.height })
        texMips.set(op.id, op.options?.mipLevels ?? 1)
        texFormats.set(op.id, op.format)
        touch(op.id)
        acc.textureIds.push(op.id)
        acc.opsReplayed++
        break
      }
      case 'texture.write': {
        const source = journal.getSource(op.content.ref)
        if (source === null || !gpuSourceAlive(source)) { acc.skipped++; break }
        raw.copyExternalImageToTexture(
          rawTex(op.id), source as GPUImageSource,
          0, 0, op.content.width, op.content.height, op.flipY)
        touch(op.id)
        acc.contentOps++
        acc.opsReplayed++
        break
      }
      case 'texture.update': {
        const source = journal.getSource(op.content.ref)
        if (source === null || !gpuSourceAlive(source)) { acc.skipped++; break }
        raw.copyExternalImageToTexture(
          rawTex(op.id), source as GPUImageSource,
          op.x, op.y, op.w, op.h, op.flipY)
        touch(op.id)
        acc.contentOps++
        acc.opsReplayed++
        break
      }
      case 'texture.writeMip': {
        const source = journal.getSource(op.content.ref)
        if (source === null || !gpuSourceAlive(source)) { acc.skipped++; break }
        raw.copyExternalImageToTextureMip(
          rawTex(op.id), op.level, source as GPUImageSource,
          0, 0, op.content.width, op.content.height, op.flipY)
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
      default:
        break
    }
  }

  function restore(keep?: WorkingSet): RestoreReport {
    seedCounters()
    // A fresh device incarnation: the mappings and LRU tracking of the old one are garbage
    // (raw ids are dead; deferred resources are NOT resident). Parity with the GL session.
    texMap.clear()
    viewMap.clear()
    targetMap.clear()
    viewParent.clear()
    targetParent.clear()
    texSizes.clear()
    texMips.clear()
    texFormats.clear()
    lastUse.clear()
    const acc = { opsReplayed: 0, contentOps: 0, skipped: 0, textureIds: [] as number[], viewIds: [] as number[], targetIds: [] as number[] }
    if (keep !== undefined) {
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
    if (resourceId >= VIEW_ID_BASE) {
      if (viewMap.has(resourceId)) return null
      const sel = selectResidentOps(journal.entries(), { viewIds: [resourceId] })
      const acc = { opsReplayed: 0, contentOps: 0, skipped: 0, textureIds: [] as number[], viewIds: [] as number[], targetIds: [] as number[] }
      for (const op of sel.ops) applyOp(op, acc)
      return { ...acc }
    }
    if (texMap.has(resourceId)) return null
    const isTexture = journal.entries().some(op => op.kind === 'texture.create' && op.id === resourceId)
    const sel = selectResidentOps(
      journal.entries(),
      isTexture ? { textureIds: [resourceId] } : { targetIds: [resourceId] },
    )
    const acc = { opsReplayed: 0, contentOps: 0, skipped: 0, textureIds: [] as number[], viewIds: [] as number[], targetIds: [] as number[] }
    for (const op of sel.ops) applyOp(op, acc)
    return { ...acc }
  }

  // ─── Task 66: LRU eviction (pressure → evict) — parity with the GL session ─────
  /** Parents of pinned views/targets from the JOURNAL (the source of truth). */
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
      const size = texSizes.get(id)
      // Task 67: the estimate accounts for the format (rgba16float — 8, rgba32float — 16
      // bytes/pixel): an HDR texture "weighs" honestly in eviction.
      const bytes = size !== undefined
        ? estimateTextureBytes(size.w, size.h, texMips.get(id) ?? 1, texFormats.get(id))
        : 0
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
      // Closure: resident views/targets follow the texture's storage
      // (a GPUTextureView lives until the parent's destroy(), but binding via a dead
      // view alias is pointless — remove it from the Map and the raw facade).
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
      // A raw call WITHOUT a journal record: declaration+content stay alive — the
      // resource will come back via ensureResident (eviction is not destruction).
      const mapped = texMap.get(texId)
      if (mapped !== undefined) raw.deleteTexture(mapped)
      texMap.delete(texId)
      texSizes.delete(texId)
      texMips.delete(texId)
      texFormats.delete(texId)
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

/** Source type name (parity with journalGpu v1 — the same kind names). */
function describeGpuSourceKind(source: GPUImageSource): string {
  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) return 'ImageBitmap'
  if (typeof OffscreenCanvas !== 'undefined' && source instanceof OffscreenCanvas) return 'OffscreenCanvas'
  if (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) return 'HTMLCanvasElement'
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) return 'HTMLVideoElement'
  if (typeof source === 'object' && source !== null) {
    if ('displayWidth' in source && 'codedWidth' in source) return 'VideoFrame'
    if ('getContext' in source) return 'OffscreenCanvas'
    if ('close' in source && 'width' in source) return 'ImageBitmap'
  }
  return (source as { constructor?: { name?: string } }).constructor?.name ?? 'unknown'
}

/** A dead source: null/undefined, a closed ImageBitmap (width=0),
 *  or a bitmap-like object with zero numeric dimensions. */
function gpuSourceAlive(source: unknown): boolean {
  if (source === null || source === undefined) return false
  const s = source as { width?: unknown; height?: unknown }
  if (typeof s.width === 'number' && typeof s.height === 'number') {
    return s.width > 0 && s.height > 0
  }
  return true
}
