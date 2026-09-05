/**
 * Journal — a registry of long-lived declarations (resource create/destroy) with replay.
 *
 * Contract (DESIGN.md §9.5 P3, §5.1, §9.9, §8 task 1):
 *   Journal.replay(newBackend) = switchBackend = device-loss recovery =
 *   = worker migration — one mechanism for three scenarios.
 *
 * What is journaled (M1 — the basic set):
 *   - createTexture / destroyTexture
 *   - createProgram / destroyProgram
 *   - createBuffer / destroyBuffer
 *   - createTarget / destroyTarget
 *   - texImage2DFromSource — partially: source is not serializable (ImageBitmap may
 *     be closed, HTMLCanvasElement — DOM-dependent). The journal stores kind+flipY;
 *     the user registers the source at replay via sourceFor(kind).
 *
 * What is NOT journaled:
 *   - Frame ops (drawArrays, setUniform*, bindTexture) — these are per-frame,
 *     they go into the Tape, not the Journal. Journal — only long-lived resources.
 *   - texSubImage2D (streaming) — belongs to Pump<UploadJob>, not to declarations.
 *
 * compact(): remove create→destroy pairs of the same id (heap compaction #13).
 *            If there was a destroy but create repeated — keep the last create.
 *
 * snapshot(): a deep copy of the journal (#41 resume-snapshot). The user
 *             can replay onto a new backend without rewriting history.
 *
 * evict(predicate): remove ops matching the predicate (#14 lazy re-declaration).
 *
 * Replay idempotency: a repeated replay on the same backend yields the same
 * ids — Journal knows nothing about the backend's state, only about op order.
 * If the backend already has a resource with the same id — the responsibility is the backend's
 * (either ignore, or throw). For WebGL2 realGL: createTexture always
 * yields a new id — a repeated replay will create duplicates. So the correct
 * usage is after device loss, on a FRESH backend.
 */

/** Target clear color (used in createTarget). */
import type { TextureFormat } from '../formats.ts'

export type ClearColor = readonly [number, number, number, number]

/** A declaration — create or destroy of a long-lived resource.
 *  id is the id issued by the facade at create. On replay the new backend
 *  must issue the same id (hence replay via registerIdMap). */
export type DeclOp =
  // Task 57: format added for WebGPU — GPUFacade.createTexture's
  // signature (width, height, format?, options?) differs from WebGL2's
  // (width, height, options?). In cross-backend replay (e.g.,
  // journal on WebGPU → replay on WebGL2) format='canvas' will be
  // silently ignored by WebGL2 (it is always RGBA8). On the same backend
  // replay passes format as is.
  // Task 67: the format extended with HDR values (rgba16float/rgba32float) —
  // sessions map them to the WebGL2 internalFormat (RGBA16F/RGBA32F) and to the
  // WebGPU GPUTextureFormat ('rgba16float'/'rgba32float').
  | { readonly kind: 'createTexture'; readonly id: number; readonly width: number; readonly height: number; readonly format?: TextureFormat; readonly options?: { readonly mipLevels?: number; readonly maxAnisotropy?: number } }
  | { readonly kind: 'destroyTexture'; readonly id: number }
  | { readonly kind: 'createProgram'; readonly id: number; readonly vertex: string; readonly fragment: string }
  | { readonly kind: 'destroyProgram'; readonly id: number }
  | { readonly kind: 'createBuffer'; readonly id: number; readonly data: Float32Array; readonly usage?: 'static' | 'dynamic' }
  | { readonly kind: 'destroyBuffer'; readonly id: number }
  | { readonly kind: 'createTarget'; readonly id: number; readonly textureId: number; readonly width: number; readonly height: number; readonly depth: boolean; readonly color: ClearColor }
  | { readonly kind: 'destroyTarget'; readonly id: number }
  | { readonly kind: 'texImage2DFromSource'; readonly textureId: number; readonly sourceKind: string; readonly flipY: boolean }
  // Sub-mip views (Task 56): createTextureView/destroyTextureView — long-lived
  // declarations (like createTexture). On replay onto a new backend the view
  // is recreated via target.createTextureView(textureId, { baseMipLevel,
  // mipLevelCount }). ATTENTION: textureId in createTextureView is the id on
  // the source backend (before device-loss). On replay it must be mapped to
  // the new id via idMap (see replayJournalOn — the caller bears responsibility
  // for id-mapping, since only it knows the order of creates).
  | { readonly kind: 'createTextureView'; readonly id: number; readonly textureId: number; readonly baseMipLevel?: number; readonly mipLevelCount?: number }
  | { readonly kind: 'destroyTextureView'; readonly id: number }

/** Snapshot — a deep copy of the journal for resume (#41). */
export interface JournalSnapshot {
  readonly ops: readonly DeclOp[]
}

/** Declaration journal: append-only with compaction. */
export interface Journal {
  /** Record a declaration. Append-only, does not iterate. */
  record(op: DeclOp): void
  /** Replay ops onto any compatible receiver.
   *  For device-loss recovery: create a new backend facade, register
   *  a source-provider (for texImage2DFromSource), and replay. */
  replay(apply: (op: DeclOp) => void): void
  /** All ops in recording order (for debugging/audit). */
  entries(): readonly DeclOp[]
  /** Remove create→destroy pairs of the same id; ones destroyed to the end are not needed.
   *  Remaining destroy without create — we keep (a strange state, audit). */
  compact(): void
  /** Deep copy (#41 resume-snapshot). */
  snapshot(): JournalSnapshot
  /** Remove ops under a predicate (#14 lazy re-declaration). */
  evict(predicate: (op: DeclOp) => boolean): void
  /** Reset the journal to an empty state (new session). */
  reset(): void
  /** Number of ops. */
  readonly size: number
}

/** Create an empty Journal. */
export function createJournal(): Journal {
  const ops: DeclOp[] = []

  return {
    record(op) {
      // Task 61: a JSON round-trip (worker migration / device-loss recovery)
      // turns Float32Array into a plain object {"0":v0,"1":v1,...}. We record
      // such ops via normalization — the journal self-heals to
      // typed state, and snapshot()/replay() do not crash on
      // op.data.slice (the "Unhandled rejection: op.data.slice is not
      // a function" regression). All other kinds pass through as is.
      ops.push(op.kind === 'createBuffer' && !(op.data instanceof Float32Array)
        ? { ...op, data: toFloat32Array(op.data) }
        : op)
    },
    replay(apply) {
      for (const op of ops) apply(op)
    },
    entries() {
      // Defensive copy: external code must not mutate internal state
      return ops.slice()
    },
    compact() {
      // Remove create→destroy pairs of the same id. Walk from the end: if destroy,
      // look for a preceding create of the same resource — drop both. Otherwise
      // keep it (destroy without create — an audit anomaly).
      //
      // Task 61 (dead-reference prune): besides create→destroy pairs, we drop
      // ops referencing a DESTROYED texture — texImage2DFromSource,
      // createTextureView and createTarget. Otherwise replaying such a journal on
      // a fresh facade would crash: the texture's create is removed by the pair, while a dependent op
      // keeps referencing a nonexistent textureId.
      const destroyedTextures = new Set<number>()
      const destroyedPrograms = new Set<number>()
      const destroyedBuffers = new Set<number>()
      const destroyedTargets = new Set<number>()
      // Sub-mip views (Task 56): the id namespace is separate from textureId (≥1M),
      // but compaction follows the same principle — a create+destroy pair
      // of the same viewId removes both ops.
      const destroyedTextureViews = new Set<number>()

      // Pass 0 (Task 61): positional liveness of textures for dependent ops
      // (texImage2DFromSource / createTextureView / createTarget).
      //
      // A texture is alive in the FINAL state if its last lifecycle op is
      // create. But that is not enough: on id "recreation" (create→…→destroy→create)
      // the surviving create is the LAST one, while a dependent op may precede it —
      // such an op belongs to a dead incarnation of the id and on replay would reference
      // the texture before its (re)creation. Hence the rule is threefold:
      //   1) the texture's last lifecycle op is create (alive at the end);
      //   2) the dependent op comes AFTER the last create of its texture;
      //   3) at the moment of the dependent op the texture existed (the last
      //      lifecycle op BEFORE it — create, not destroy).
      const lastTexLifecycle = new Map<number, 'create' | 'destroy'>()
      const lastTexCreateIdx = new Map<number, number>()
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i]!
        if (op.kind === 'createTexture') {
          lastTexLifecycle.set(op.id, 'create')
          lastTexCreateIdx.set(op.id, i)
        } else if (op.kind === 'destroyTexture') {
          lastTexLifecycle.set(op.id, 'destroy')
        }
      }
      // Texture state at each position (one pass with running state)
      const runningState = new Map<number, 'create' | 'destroy'>()
      const aliveAt = new Map<number, boolean>() // dependent op index → is its texture alive (cond. 3)
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i]!
        if (op.kind === 'texImage2DFromSource' || op.kind === 'createTextureView' || op.kind === 'createTarget') {
          aliveAt.set(i, runningState.get(op.textureId) === 'create')
        } else if (op.kind === 'createTexture') {
          runningState.set(op.id, 'create')
        } else if (op.kind === 'destroyTexture') {
          runningState.set(op.id, 'destroy')
        }
      }
      const texAliveAt = (i: number, textureId: number): boolean =>
        lastTexLifecycle.get(textureId) === 'create'            // cond. 1: alive at the end
        && (lastTexCreateIdx.get(textureId) ?? -1) < i          // cond. 2: after the last create
        && aliveAt.get(i) === true                              // cond. 3: existed at the op's moment

      // First pass: collect all destroys (id + type)
      for (const op of ops) {
        if (op.kind === 'destroyTexture') destroyedTextures.add(op.id)
        else if (op.kind === 'destroyProgram') destroyedPrograms.add(op.id)
        else if (op.kind === 'destroyBuffer') destroyedBuffers.add(op.id)
        else if (op.kind === 'destroyTarget') destroyedTargets.add(op.id)
        else if (op.kind === 'destroyTextureView') destroyedTextureViews.add(op.id)
      }

      // Second pass: remove create+destroy pairs of the same id; keep only
      // either create without destroy (alive), or destroy without create (an anomaly).
      const keep: DeclOp[] = []
      const seenDestroy = {
        tex: new Set<number>(),
        prog: new Set<number>(),
        buf: new Set<number>(),
        tgt: new Set<number>(),
        view: new Set<number>(),
      }
      // Task 61: view and target resources whose create ops were dropped by the prune
      // (the texture is dead) — their destroy ops are dropped too, so as not to
      // leave orphans.
      const prunedViewIds = new Set<number>()
      const prunedTargetIds = new Set<number>()
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i]!
        switch (op.kind) {
          case 'createTexture':
            if (destroyedTextures.has(op.id) && !seenDestroy.tex.has(op.id)) {
              seenDestroy.tex.add(op.id) // skip the create — it is paired with a destroy
            } else {
              keep.push(op)
            }
            break
          case 'destroyTexture':
            if (seenDestroy.tex.has(op.id)) continue // already removed the create — drop the destroy too
            keep.push(op)
            break
          case 'createProgram':
            if (destroyedPrograms.has(op.id) && !seenDestroy.prog.has(op.id)) {
              seenDestroy.prog.add(op.id)
            } else {
              keep.push(op)
            }
            break
          case 'destroyProgram':
            if (seenDestroy.prog.has(op.id)) continue
            keep.push(op)
            break
          case 'createBuffer':
            if (destroyedBuffers.has(op.id) && !seenDestroy.buf.has(op.id)) {
              seenDestroy.buf.add(op.id)
            } else {
              keep.push(op)
            }
            break
          case 'destroyBuffer':
            if (seenDestroy.buf.has(op.id)) continue
            keep.push(op)
            break
          case 'createTarget':
            // Task 61: a target on a dead texture is not restored —
            // drop the create, mark its destroy for removal.
            if (!texAliveAt(i, op.textureId)) {
              prunedTargetIds.add(op.id)
              continue
            }
            if (destroyedTargets.has(op.id) && !seenDestroy.tgt.has(op.id)) {
              seenDestroy.tgt.add(op.id)
            } else {
              keep.push(op)
            }
            break
          case 'destroyTarget':
            if (prunedTargetIds.has(op.id)) continue // create dropped by the prune
            if (seenDestroy.tgt.has(op.id)) continue
            keep.push(op)
            break
          // Sub-mip views (Task 56): compacted by the same principle.
          case 'createTextureView':
            // Task 61: a view on a dead texture is not restored.
            if (!texAliveAt(i, op.textureId)) {
              prunedViewIds.add(op.id)
              continue
            }
            if (destroyedTextureViews.has(op.id) && !seenDestroy.view.has(op.id)) {
              seenDestroy.view.add(op.id)
            } else {
              keep.push(op)
            }
            break
          case 'destroyTextureView':
            if (prunedViewIds.has(op.id)) continue // create dropped by the prune
            if (seenDestroy.view.has(op.id)) continue
            keep.push(op)
            break
          case 'texImage2DFromSource':
            // Task 61: an upload into a dead texture is not replayed.
            if (!texAliveAt(i, op.textureId)) continue
            keep.push(op)
            break
          default:
            keep.push(op)
        }
      }
      ops.length = 0
      ops.push(...keep)
    },
    snapshot() {
      // Deep copy of ops. Float32Array is copied via slice.
      const copy = ops.map(cloneOp)
      return { ops: copy }
    },
    evict(predicate) {
      for (let i = ops.length - 1; i >= 0; i--) {
        if (predicate(ops[i]!)) ops.splice(i, 1)
      }
    },
    reset() {
      ops.length = 0
    },
    get size() {
      return ops.length
    },
  }
}

/** Clone an op for a snapshot (Float32Array — slice, the rest — readonly). */
function cloneOp(op: DeclOp): DeclOp {
  if (op.kind === 'createBuffer') {
    // Task 61: toFloat32Array — protection from "stale" ops that got into the
    // journal bypassing record() normalization (external writes/experiments).
    // The live path is covered by record(); here — belt-and-suspenders.
    return { ...op, data: toFloat32Array(op.data).slice() }
  }
  return op
}

/** Task 61: coercion of createBuffer data to Float32Array.
 *
 * JSON.stringify(Float32Array) yields {"0":v0,"1":v1,...} — a plain object with
 * numeric keys (integer-like keys iterate in ascending order,
 * value order is preserved). JSON.parse returns the same plain
 * object — without .slice(), without ArrayBuffer. This function restores the
 * typed view from any valid representation:
 *   • Float32Array → as is (the same instance)
 *   • number[]     → new Float32Array(arr)
 *   • plain object {"0":..,"1":..} → new Float32Array(Object.values(obj))
 *   • other        → an empty Float32Array (we do not crash)
 */
export function toFloat32Array(data: unknown): Float32Array {
  if (data instanceof Float32Array) return data
  if (Array.isArray(data)) return new Float32Array(data)
  if (typeof data === 'object' && data !== null) {
    const values = Object.values(data as Record<string, unknown>)
    return new Float32Array(values.filter(v => typeof v === 'number') as number[])
  }
  return new Float32Array(0)
}
