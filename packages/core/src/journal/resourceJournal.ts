/**
 * ResourceJournal (v2) — a journal of PRIMARY resources with CONTENT.
 *
 * Task (a Task 62 rework): the old Journal stored declarations with
 * facade counter ids. A replay on a fresh facade yields a dense
 * id sequence — with any "hole" (compact/evict/lazy
 * pipelines) ids shift, dependent ops reference foreign textures,
 * and the application cannot restore the scene ("texture id 1, 2, 4 → 1, 2,
 * 3, 4 DO NOT MATCH").
 *
 * The new model — three decisions:
 *
 * 1. STABLE IDS. An op carries an id assigned by the level ABOVE the facade
 *    (resourceSession). Replay takes the id from the op and builds a mapping
 *    stable-id → new facade id. Ids match BEFORE and AFTER device
 *    loss BY CONSTRUCTION — nothing to compare, nowhere to err.
 *
 * 2. PRIMITIVE OPS. All engine actions on primary resources
 *    are reduced to a simple set:
 *      texture.create / texture.write / texture.update / texture.writeMip
 *      / texture.destroy
 *      view.create / view.destroy            (sub-mip views)
 *      target.create / target.destroy        (render targets)
 *    Normal operation and recovery — ONE AND THE SAME path: replay
 *    executes the same primitives through the same facade API.
 *
 * 3. CONTENT IN THE JOURNAL. texture.write/update/writeMip store a ContentRef —
 *    a reference to a CPU source in ContentStore (ImageBitmap/OffscreenCanvas/
 *    HTMLCanvasElement/...). Sources survive GPU device loss,
 *    so replay restores PIXELS, not just declarations.
 *    "What is the point of a journal that asks to recreate the atlas?" — now
 *    the atlas restores itself, tiles included.
 *
 * What does NOT get into the journal (intentionally):
 *   - Command programs/buffers (GL) — DERIVED state: a pure function
 *     of command specs; the owner (renderer) recreates them lazily on the
 *     first draw. The journal stores only PRIMARY state (content).
 *   - texSubImage2D (raw byte streaming) — the UploadScheduler's domain:
 *     the Pump re-streams its own data; journaling chunks would blow up
 *     the journal.
 *   - Frame ops (bind/draw/uniform/...) — the Tape, not the journal.
 *
 * compact() (beyond the v1 create→destroy pairs):
 *   - texture.write absorbs ALL previous write/update/writeMip of the same
 *     texture (a full rewrite makes them pointless);
 *   - a repeated texture.update of the same exact rectangle — the last one
 *     survives (last-write-wins);
 *   - create→destroy pairs + dangling references (Task 61) — as in v1:
 *     a dependent op of a dead texture is dropped together with the destroy ops
 *     of the pruned view/target (no orphans);
 *   - ContentStore GC (Task 65): sources not referenced by a SINGLE
 *     remaining content op are released — CPU memory does not leak from
 *     "pressed many buttons" (each created-and-discarded a texture).
 *
 * Task 65 (soft reset / lazy residency):
 *   - WorkingSet — which resources must be in GPU memory after the loss
 *     (the scene); everything else is restored LAZILY (ensureResident);
 *   - selectResidentOps(ops, keep) — a pure function: the closure of the
 *     working set (view → parent texture, target → parent texture, content →
 *     its own texture) + lists of deferred resources;
 *   - RestoreReport.deferred — what remained unrestored in the journal.
 *
 * Serialization (worker migration): ops — plain objects, JSON-safe.
 * ContentStore sources are NOT serialized (ImageBitmap closed/transferred,
 * canvas — DOM). snapshot() returns a content manifest (refs + kind +
 * sizes); the receiving side re-registers sources via
 * attachSource(ref, source) before replay.
 */

/** Texture format (Task 67: HDR).
 *  'rgba8unorm' — the default of both backends (WebGL2: RGBA8).
 *  'canvas' — the WebGPU canvas format (usually bgra8unorm); WebGL2 ignores it
 *  and allocates RGBA8 (render-to-texture on GL always goes through its own texture).
 *  'rgba16float' / 'rgba32float' — HDR: WebGL2 → RGBA16F/RGBA32F
 *  (texStorage2D/texImage2D internalFormat + HALF_FLOAT/FLOAT type on
 *  upload), WebGPU → rgba16float/rgba32float (core, renderable).
 *  Requirements: WebGL2 — float texture storage is core; LINEAR filtering of
 *  rgba16float is core, rgba32float requires OES_texture_float_linear;
 *  rendering INTO a float target requires EXT_color_buffer_float. WebGPU — both formats are
 *  core (rgba32float is not linearly filterable without the 'float32-filterable' feature). */
// Task 110 (restoration): TextureFormat is unified with formats.ts —
// the full canonical catalog (the old narrow journal type was its subset).
import { TEXTURE_FORMATS, type TextureFormat, type TextureFormatId } from '../formats.ts'
export type { TextureFormat }

/** Bytes per pixel by format: uncompressed — the catalog's texelBytes, compressed —
 *  a per-block estimate, unknown/unspecified — 4 (rgba8-compatible). */
export function textureFormatBytesPerPixel(format?: TextureFormat): number {
  if (format === undefined) return 4
  const info = TEXTURE_FORMATS[format as TextureFormatId]
  if (info === undefined) return 4
  if (info.blockWidth > 1 || info.blockHeight > 1) {
    // compressed: bytes per block / texels per block (an average density estimate)
    return info.blockBytes / (info.blockWidth * info.blockHeight)
  }
  return info.texelBytes
}

/** Target clear color. */
export type ClearColor2 = readonly [number, number, number, number]

/** A reference to a CPU pixel source in the journal's ContentStore.
 *  kind — the source type name ('ImageBitmap', 'OffscreenCanvas', ...),
 *  width/height — the sizes AT RECORDING TIME (replay does not depend on
 *  whether the source is alive now: dead → the op is skipped with a warning). */
export interface ContentRef {
  readonly ref: number
  readonly kind: string
  readonly width: number
  readonly height: number
}

/** Primitive ops over primary resources. id — STABLE resourceSession-level
 *  ids (not facade ones). Dependent references (textureId) — too. */
export type ResOp =
  | { readonly kind: 'texture.create'; readonly id: number; readonly width: number; readonly height: number; readonly format?: TextureFormat; readonly options?: { readonly mipLevels?: number; readonly maxAnisotropy?: number } }
  | { readonly kind: 'texture.write'; readonly id: number; readonly content: ContentRef; readonly flipY: boolean }
  | { readonly kind: 'texture.update'; readonly id: number; readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly content: ContentRef; readonly flipY: boolean }
  | { readonly kind: 'texture.writeMip'; readonly id: number; readonly level: number; readonly content: ContentRef; readonly flipY: boolean }
  | { readonly kind: 'texture.destroy'; readonly id: number }
  | { readonly kind: 'view.create'; readonly id: number; readonly textureId: number; readonly baseMipLevel?: number; readonly mipLevelCount?: number }
  | { readonly kind: 'view.destroy'; readonly id: number }
  | { readonly kind: 'target.create'; readonly id: number; readonly textureId: number; readonly width: number; readonly height: number; readonly depth: boolean; readonly color: ClearColor2 }
  | { readonly kind: 'target.destroy'; readonly id: number }

/** Content manifest — what must be re-registered on the receiving
 *  side (worker migration) before replaying the snapshot. */
export interface ContentManifestEntry {
  readonly ref: number
  readonly kind: string
  readonly width: number
  readonly height: number
}

/** Working set (Task 65 soft reset): which resources must return to
 *  GPU memory immediately after device loss. Everything alive that is NOT included —
 *  stays a declaration in the journal and returns lazily (ensureResident).
 *  An empty set = "no scene": after loss — a clean backend. */
export interface WorkingSet {
  readonly textureIds?: readonly number[]
  readonly viewIds?: readonly number[]
  readonly targetIds?: readonly number[]
}

/** The resident-op selection result: the minimal sublist of the journal
 *  restoring the working set (+ what remained deferred). */
export interface ResidentSelection {
  /** Ops for replay in original order (create + content + dependents). */
  readonly ops: readonly ResOp[]
  /** Live textures NOT included in the working set (deferred). */
  readonly deferredTextures: readonly number[]
  /** Live views NOT included (deferred). */
  readonly deferredViews: readonly number[]
  /** Live targets NOT included (deferred). */
  readonly deferredTargets: readonly number[]
}

/** Select the ops of the resident subset (a pure function).
 *
 * Working-set closure:
 *   • keep.textureIds → their texture.create + ALL their content ops
 *     (write/update/writeMip of the live incarnation);
 *   • keep.viewIds → their view.create + the parent texture (create + content —
 *     a view without the parent's pixels is pointless);
 *   • keep.targetIds → their target.create + the parent texture (create WITHOUT
 *     content — in a target the content is overwritten by rendering);
 *   • views/targets on NOT included textures — deferred (even if their parent
 *     is included: a view is a separate resource, it returns via its own ensureResident).
 *
 * Liveness — by the last lifecycle op (compact semantics): the last
 * incarnation create→…→destroy→create is alive, and we take its ops. */
export function selectResidentOps(ops: readonly ResOp[], keep: WorkingSet): ResidentSelection {
  // Live resources: the last lifecycle op is create.
  const lastTexLifecycle = new Map<number, 'create' | 'destroy'>()
  const lastViewLifecycle = new Map<number, 'create' | 'destroy'>()
  const lastTargetLifecycle = new Map<number, 'create' | 'destroy'>()
  // Last view/target create → parent textureId (for the parent closure).
  const viewParent = new Map<number, number>()
  const targetParent = new Map<number, number>()
  // The index of the LAST create (dead-incarnation content is not restored —
  // compact semantics: in create→…→destroy→create only the last one is alive).
  const lastTexCreateIdx = new Map<number, number>()
  const lastViewCreateIdx = new Map<number, number>()
  const lastTargetCreateIdx = new Map<number, number>()
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!
    if (op.kind === 'texture.create') { lastTexLifecycle.set(op.id, 'create'); lastTexCreateIdx.set(op.id, i) }
    else if (op.kind === 'texture.destroy') lastTexLifecycle.set(op.id, 'destroy')
    else if (op.kind === 'view.create') { lastViewLifecycle.set(op.id, 'create'); lastViewCreateIdx.set(op.id, i); viewParent.set(op.id, op.textureId) }
    else if (op.kind === 'view.destroy') lastViewLifecycle.set(op.id, 'destroy')
    else if (op.kind === 'target.create') { lastTargetLifecycle.set(op.id, 'create'); lastTargetCreateIdx.set(op.id, i); targetParent.set(op.id, op.textureId) }
    else if (op.kind === 'target.destroy') lastTargetLifecycle.set(op.id, 'destroy')
  }

  // Texture closure: the requested ones + the parents of the requested views/targets.
  const texKeep = new Set<number>(keep.textureIds ?? [])
  const viewKeep = new Set<number>(keep.viewIds ?? [])
  const targetKeep = new Set<number>(keep.targetIds ?? [])
  for (const viewId of viewKeep) {
    const parent = viewParent.get(viewId)
    if (parent !== undefined) texKeep.add(parent)
  }
  for (const targetId of targetKeep) {
    const parent = targetParent.get(targetId)
    if (parent !== undefined) texKeep.add(parent)
  }
  // Views require the parent's CONTENT (nothing to sample without pixels);
  // targets do not (rendering will overwrite it).
  const texNeedsContent = new Set<number>(keep.textureIds ?? [])
  for (const viewId of viewKeep) {
    const parent = viewParent.get(viewId)
    if (parent !== undefined) texNeedsContent.add(parent)
  }

  const selected: ResOp[] = []
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!
    switch (op.kind) {
      case 'texture.create': {
        // Only the LAST incarnation (dead creates were dropped in a pair
        // with destroy in compact; without compact — also correct: dead-incarnation
        // content is invalid anyway).
        if (texKeep.has(op.id) && lastTexCreateIdx.get(op.id) === i) selected.push(op)
        break
      }
      case 'texture.destroy': {
        break
      }
      case 'texture.write':
      case 'texture.update':
      case 'texture.writeMip': {
        if (texKeep.has(op.id) && texNeedsContent.has(op.id)
          && lastTexLifecycle.get(op.id) === 'create'
          && (lastTexCreateIdx.get(op.id) ?? -1) < i) {
          selected.push(op)
        }
        break
      }
      case 'view.create': {
        if (viewKeep.has(op.id) && lastViewCreateIdx.get(op.id) === i) selected.push(op)
        break
      }
      case 'target.create': {
        if (targetKeep.has(op.id) && lastTargetCreateIdx.get(op.id) === i) selected.push(op)
        break
      }
      default:
        break // destroy ops during recovery — a no-op by definition
    }
  }

  const deferredTextures: number[] = []
  for (const [id, lifecycle] of lastTexLifecycle) {
    if (lifecycle === 'create' && !texKeep.has(id)) deferredTextures.push(id)
  }
  const deferredViews: number[] = []
  for (const [id, lifecycle] of lastViewLifecycle) {
    if (lifecycle === 'create' && !viewKeep.has(id)) deferredViews.push(id)
  }
  const deferredTargets: number[] = []
  for (const [id, lifecycle] of lastTargetLifecycle) {
    if (lifecycle === 'create' && !targetKeep.has(id)) deferredTargets.push(id)
  }
  return { ops: selected, deferredTextures, deferredViews, deferredTargets }
}

/** Journal snapshot: JSON-safe ops + a content manifest. */
export interface ResourceJournalSnapshot {
  readonly ops: readonly ResOp[]
  readonly content: readonly ContentManifestEntry[]
}

/** Recovery quantification — what happened during the replay. */
export interface RestoreReport {
  /** How many ops were executed (without destroy skips). */
  readonly opsReplayed: number
  /** Stable ids of live textures (match the pre-loss ids BY CONSTRUCTION). */
  readonly textureIds: readonly number[]
  /** Stable ids of live views. */
  readonly viewIds: readonly number[]
  /** Stable ids of live targets. */
  readonly targetIds: readonly number[]
  /** How many content ops (write/update/writeMip) were re-uploaded. */
  readonly contentOps: number
  /** How many content ops were skipped (source dead/not re-registered). */
  readonly skipped: number
  /** Task 65: live resources NOT included in the working set (soft reset) —
 *  remained declarations in the journal, will return via ensureResident().
 *  Absent/empty on a full restore (strategy='full'). */
  readonly deferred?: { readonly textures: readonly number[]; readonly views: readonly number[]; readonly targets: readonly number[] }
}

/** Primary resource journal: append-only + compaction + ContentStore. */
export interface ResourceJournal {
  /** Record a primitive op. Append-only. */
  record(op: ResOp): void
  /** Execute ops in recording order on any receiver. */
  replay(apply: (op: ResOp) => void): void
  /** All ops in recording order (a defensive copy). */
  entries(): readonly ResOp[]
  /** Compaction: create→destroy pairs, absorption by write,
   *  last-write-wins of identical rects, pruning of dangling references. */
  compact(): void
  /** Deep copy (ops are cloned; ContentStore is shared — sources are
   *  live objects, cloning bitmaps = doubling memory). */
  snapshot(): ResourceJournalSnapshot
  /** Remove ops under a predicate. */
  evict(predicate: (op: ResOp) => boolean): void
  /** Reset to an empty state (a new session). ContentStore is not cleaned:
   *  the application may hold the sources. */
  reset(): void
  readonly size: number

  // ─── ContentStore ───────────────────────────────────────────────────────
  /** Register a CPU pixel source. Returns a reference for ops. */
  storeSource(source: unknown, kind: string, width: number, height: number): ContentRef
  /** Source by reference (null — not registered/dead). */
  getSource(ref: number): unknown
  /** Worker migration: re-register a source under an existing ref. */
  attachSource(ref: number, source: unknown): void
  /** Is the source alive (not null and not a closed ImageBitmap). */
  isSourceAlive(ref: number): boolean

  // ─── Stable id seeding ──────────────────────────────────────────
  /** The maximal stable texture.create id (+1 = the next free one). */
  maxTextureId(): number
  /** The maximal stable view.create id. */
  maxViewId(): number
  /** The maximal stable target.create id. */
  maxTargetId(): number
}

/** A dead source: a closed ImageBitmap (close()) reports width=0. */
function sourceIsDead(source: unknown): boolean {
  if (source === null || source === undefined) return true
  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) {
    return source.width === 0 || source.height === 0
  }
  return false
}

/** Create an empty ResourceJournal. */
export function createResourceJournal(): ResourceJournal {
  const ops: ResOp[] = []
  const sources = new Map<number, unknown>()
  // Task 65: a monotonic ref counter — NOT sources.size: after the GC cleanup
  // of compact() the map size drops, while refs must remain unique
  // forever (otherwise a new source would overwrite a live ref).
  let nextRef = 1

  function storeSource(source: unknown, kind: string, width: number, height: number): ContentRef {
    const ref = nextRef++
    sources.set(ref, source)
    return { ref, kind, width, height }
  }

  /** ContentStore GC: drop sources not referenced by any
   *  content op. Called from compact() — CPU memory does not leak from
   *  created-and-discarded textures (their ops are already removed in pairs). */
  function pruneSources(): number {
    const used = new Set<number>()
    for (const op of ops) {
      if (op.kind === 'texture.write' || op.kind === 'texture.update' || op.kind === 'texture.writeMip') {
        used.add(op.content.ref)
      }
    }
    let pruned = 0
    for (const ref of [...sources.keys()]) {
      if (!used.has(ref)) { sources.delete(ref); pruned++ }
    }
    return pruned
  }

  return {
    record(op) {
      ops.push(op)
    },
    replay(apply) {
      for (const op of ops) apply(op)
    },
    entries() {
      return ops.slice()
    },

    compact() {
      // ─── Step 1: texture liveness (Task 61 semantics, generalized to v2) ──
      // A texture is alive in the FINAL state if its last lifecycle op
      // is create (create→…→destroy→create = alive, incarnation #2). Dependent
      // ops (write/update/writeMip/view.create/target.create) are dead if:
      //   1) the texture's last lifecycle op is destroy (dead at the end); or
      //   2) the op comes BEFORE the last create (belongs to a dead incarnation);
      //   3) at the op's moment the texture was destroyed (running state).
      const lastTexLifecycle = new Map<number, 'create' | 'destroy'>()
      const lastTexCreateIdx = new Map<number, number>()
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i]!
        if (op.kind === 'texture.create') {
          lastTexLifecycle.set(op.id, 'create')
          lastTexCreateIdx.set(op.id, i)
        } else if (op.kind === 'texture.destroy') {
          lastTexLifecycle.set(op.id, 'destroy')
        }
      }
      const running = new Map<number, 'create' | 'destroy'>()
      const aliveAt = new Map<number, boolean>()
      // Content ops (write/update/writeMip) reference a texture by the id field;
      // view.create/target.create — by the textureId field.
      const opTextureId = (op: ResOp): number | null =>
        op.kind === 'texture.write' || op.kind === 'texture.update' || op.kind === 'texture.writeMip'
          ? op.id
          : op.kind === 'view.create' || op.kind === 'target.create'
            ? op.textureId
            : null
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i]!
        const dep = opTextureId(op)
        if (dep !== null) {
          aliveAt.set(i, running.get(dep) === 'create')
        } else if (op.kind === 'texture.create') {
          running.set(op.id, 'create')
        } else if (op.kind === 'texture.destroy') {
          running.set(op.id, 'destroy')
        }
      }
      const texAliveAt = (i: number, textureId: number): boolean =>
        lastTexLifecycle.get(textureId) === 'create'
        && (lastTexCreateIdx.get(textureId) ?? -1) < i
        && aliveAt.get(i) === true

      // ─── Step 2: create→destroy pairs + dependents of dead textures ────────
      // One pass: a create paired with a destroy is dropped together with the destroy.
      // A view/target on a dead texture is dropped, its destroys too
      // (no orphans). Content ops of a dead texture are dropped.
      const seenTexDestroy = new Set<number>()
      const seenViewDestroy = new Set<number>()
      const seenTargetDestroy = new Set<number>()
      for (const op of ops) {
        if (op.kind === 'texture.destroy') seenTexDestroy.add(op.id)
        else if (op.kind === 'view.destroy') seenViewDestroy.add(op.id)
        else if (op.kind === 'target.destroy') seenTargetDestroy.add(op.id)
      }
      const prunedViews = new Set<number>()
      const prunedTargets = new Set<number>()
      // The v1 pattern (verified by Task 61): walk ops; the create of an id with a destroy pair
      // is skipped ONLY THE FIRST TIME (and the id is marked); a repeated create of the same id
      // (create→…→destroy→create) stays — the last incarnation survives.
      // The destroy of a marked id is dropped (its create is already removed).
      const keep: ResOp[] = []
      const pairedTexCreateDropped = new Set<number>()
      const pairedViewCreateDropped = new Set<number>()
      const pairedTargetCreateDropped = new Set<number>()
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i]!
        switch (op.kind) {
          case 'texture.create':
            if (seenTexDestroy.has(op.id) && !pairedTexCreateDropped.has(op.id)) {
              pairedTexCreateDropped.add(op.id) // the first create — paired with a destroy
            } else {
              keep.push(op)
            }
            break
          case 'texture.destroy':
            if (pairedTexCreateDropped.has(op.id)) continue // the paired create is removed
            keep.push(op)
            break
          case 'view.create':
            if (seenViewDestroy.has(op.id) && !pairedViewCreateDropped.has(op.id)) {
              pairedViewCreateDropped.add(op.id)
              continue
            }
            if (!texAliveAt(i, op.textureId)) { prunedViews.add(op.id); continue }
            keep.push(op)
            break
          case 'view.destroy':
            if (pairedViewCreateDropped.has(op.id)) continue
            if (prunedViews.has(op.id)) continue
            keep.push(op)
            break
          case 'target.create':
            if (seenTargetDestroy.has(op.id) && !pairedTargetCreateDropped.has(op.id)) {
              pairedTargetCreateDropped.add(op.id)
              continue
            }
            if (!texAliveAt(i, op.textureId)) { prunedTargets.add(op.id); continue }
            keep.push(op)
            break
          case 'target.destroy':
            if (pairedTargetCreateDropped.has(op.id)) continue
            if (prunedTargets.has(op.id)) continue
            keep.push(op)
            break
          case 'texture.write':
          case 'texture.update':
          case 'texture.writeMip':
            if (!texAliveAt(i, op.id)) continue
            keep.push(op)
            break
          default:
            keep.push(op)
        }
      }
      ops.length = 0
      ops.push(...keep)

      // ─── Step 3: content coalescing ────────────────────────────────────
      // texture.write(x) absorbs all previous content ops of x. A repeated
      // texture.update of the same rect — the last one survives (last-write-wins).
      // writeMip is NOT absorbed by write (a different mip level); an identical
      // writeMip(level) — the last one survives.
      const contentKeep: ResOp[] = []
      /** Indices in contentKeep that must be removed after the pass. */
      const absorbed = new Set<number>()
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i]!
        if (op.kind === 'texture.write') {
          // absorb all previous write/update of this texture (a full
          // rewrite makes them pointless). writeMip is a DIFFERENT mip level,
          // write does NOT absorb it.
          for (let j = 0; j < contentKeep.length; j++) {
            const prev = contentKeep[j]!
            if (prev.id === op.id && (prev.kind === 'texture.write' || prev.kind === 'texture.update')) {
              absorbed.add(j)
            }
          }
          contentKeep.push(op)
        } else if (op.kind === 'texture.update') {
          // last-write-wins for the same rect
          for (let j = 0; j < contentKeep.length; j++) {
            const prev = contentKeep[j]!
            if (prev.id === op.id && prev.kind === 'texture.update'
              && prev.x === op.x && prev.y === op.y && prev.w === op.w && prev.h === op.h) {
              absorbed.add(j)
            }
          }
          contentKeep.push(op)
        } else if (op.kind === 'texture.writeMip') {
          for (let j = 0; j < contentKeep.length; j++) {
            const prev = contentKeep[j]!
            if (prev.id === op.id && prev.kind === 'texture.writeMip' && prev.level === op.level) {
              absorbed.add(j)
            }
          }
          contentKeep.push(op)
        } else {
          contentKeep.push(op)
        }
      }
      const coalesced = contentKeep.filter((_, j) => !absorbed.has(j))
      ops.length = 0
      ops.push(...coalesced)

      // ─── Step 4 (Task 65): ContentStore GC ──────────────────────────────
      // Sources not referenced by any remaining content op
      // are released: their textures are already destroyed (create→destroy pairs) or
      // their content is absorbed by the last write. Otherwise "pressed many buttons" →
      // dozens of dead ImageBitmap/canvas in CPU memory forever.
      pruneSources()
    },

    snapshot() {
      const manifest: ContentManifestEntry[] = []
      for (const [ref, source] of sources) {
        const meta = opContentByRef(ops, ref)
        manifest.push({ ref, kind: meta.kind, width: meta.width, height: meta.height })
        void source
      }
      return { ops: ops.map(cloneResOp), content: manifest }
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

    storeSource,
    getSource(ref) {
      return sources.get(ref) ?? null
    },
    attachSource(ref, source) {
      sources.set(ref, source)
    },
    isSourceAlive(ref) {
      return !sourceIsDead(sources.get(ref) ?? null)
    },

    maxTextureId() {
      let max = 0
      for (const op of ops) if (op.kind === 'texture.create' && op.id > max) max = op.id
      return max
    },
    maxViewId() {
      let max = 1_000_000 - 1
      for (const op of ops) if (op.kind === 'view.create' && op.id > max) max = op.id
      return max
    },
    maxTargetId() {
      let max = 0
      for (const op of ops) if (op.kind === 'target.create' && op.id > max) max = op.id
      return max
    },
  }
}

/** ContentRef metadata from journal ops (for the manifest). */
function opContentByRef(ops: readonly ResOp[], ref: number): ContentManifestEntry {
  for (const op of ops) {
    if (op.kind === 'texture.write' || op.kind === 'texture.update' || op.kind === 'texture.writeMip') {
      if (op.content.ref === ref) return { ref, kind: op.content.kind, width: op.content.width, height: op.content.height }
    }
  }
  return { ref, kind: 'unknown', width: 0, height: 0 }
}

/** Op clone (depth 1: all fields are readonly primitives + the ContentRef object). */
function cloneResOp(op: ResOp): ResOp {
  if (op.kind === 'texture.write' || op.kind === 'texture.update' || op.kind === 'texture.writeMip') {
    return { ...op, content: { ...op.content } }
  }
  return op
}
