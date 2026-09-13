/**
 * Task 203 — THE FRAME GRAPH (the «супер рендеринг» architecture): render
 * passes declared as DATA, the frame compiled into a DAG.
 *
 *   · Рендер-пассы описываются декларативно: каждый пас объявляет читаемые
 *     и записываемые ресурсы через ВЕРСИОНИРОВАННЫЕ ХЭНДЛЫ — запись бампит
 *     версию ресурса, читатель фиксирует версию, актуальную НА МОМЕНТ
 *     объявления (Frostbite FrameGraph, GDC 2017; UE's RDG; Unity's SRP
 *     RenderGraph — the same law in all three).
 *   · Движок строит DAG кадра и сам управляет временем жизни
 *     transient-ресурсов → ALIASING памяти: ресурсы с непересекающимися
 *     сроками жизни получают один слот (interval scheduling — the classic
 *     register-allocation-by-live-range math).
 *   · Автоматическая вставка барьеров: every write→read/write crossing
 *     between lanes (graphics / compute / transfer) is emitted as an
 *     ordered barrier list — exactly what a D3D12/Vulkan backend submits.
 *   · Автоматическое перекрытие async compute и графики: a 3-lane event
 *     simulation computes which compute/copy passes legally overlap the
 *     graphics lane (the plan a multi-queue backend follows).
 *   · Отсечение целых веток пассов: passes unreachable from the roots
 *     (the present passes + the kept side effects) leave the frame —
 *     «отключили тени → зависимые пассы исчезли из графа». Conditional
 *     reads (`reads: props => [...]`) are what let a whole branch die
 *     when its consumer stops reading it.
 *
 * THE HONEST WEB REALIZATION (documented, not hidden):
 *   · The DAG, the culling, the versioning, the compile cache — REAL on
 *     any backend: they are pure scheduling, and the executes are the
 *     caller's own brick calls (this module is DOM/GPU-free by law).
 *   · VRAM aliasing is NOT reachable from the web — WebGL2/WebGPU expose
 *     no memory control (a texture is a texture; you cannot hand its
 *     bytes to another texture). The PLANNER is real (slots, lifetimes,
 *     peak bytes, the savings report); on a console those slots ARE the
 *     memory aliases; on the web the same planner drives a pooled
 *     scratch (the `resolve` hook — acquire/release follow the slot plan,
 *     so a pooled object's reuse discipline is the graph's own).
 *   · Barriers: WebGL2 and WebGPU satisfy cross-pass hazards AT PASS
 *     BOUNDARIES implicitly (the GL global order + ANGLE's transform-
 *     feedback sync; the WG encoder's pass ordering). The emitted list is
 *     the contract those boundaries are already honoring — and the exact
 *     submission a D3D12 port would make. WAW (write-after-write on one
 *     target) is emitted too: that is the render-pass layout transition.
 *   · Async compute: a single WebGPU queue executes passes in submission
 *     order — true multi-queue overlap is not exposed. The 3-lane plan is
 *     still honest: the copy lane IS real on the web (async readbacks —
 *     mapAsync — genuinely overlap the next passes' GPU work), and the
 *     compute-lane plan is the submission script for the day a backend
 *     gives us queues (or a browser that overlaps dependency-free passes
 *     inside a command buffer — the plan is already legal for that).
 *
 * THE VERSION LAW (the brick this module adds to the catalog — beyond
 * the classic frame graph):
 *   · TRANSIENT resources reset to version 0 every frame: a live reader
 *     of an unwritten version is a compile ERROR (the honest refusal —
 *     «pass X reads 'hi-z'@2, but its writer is gated off this frame»).
 *   · PERSISTENT resources keep their version counters ACROSS frames:
 *     a reader with no intervening writer legally binds the LAST WRITTEN
 *     version — however many frames ago that was. THE STALENESS is a
 *     first-class metric: `stale: n` frames. This is what makes the
 *     amortized-cull (temporal coherence) and the two-pass HZB (the
 *     prepass reading the PREV frame's visible set) LEGAL, VISIBLE and
 *     MEASURED — the frame graph does not just tolerate temporal reuse,
 *     it accounts it.
 *
 * THE COMPILE CACHE: the declarations are functions of the frame's POLICY
 * props (gates, toggles). compile(props) evaluates them through a
 * recording proxy — only PRIMITIVE prop reads are legal during
 * declaration (the per-frame data — cameras, lights — must ride the
 * execute, never the declaration). The recorded (key, value) pairs ARE
 * the cache key: the same policy bit-still → the SAME compiled frame
 * (identity), a flipped gate → a fresh compile. The amortized frame thus
 * re-uses not only its verdicts but the compiled graph object itself.
 */

// ─── the public types ─────────────────────────────────────────────────────

export type FgResourceKind = 'buffer' | 'texture'
export type FgPassKind = 'render' | 'compute' | 'copy' | 'present'

/** The three execution lanes — the overlap model's workers.
 *  G: render + present (the graphics queue) · C: compute (the async
 *  compute queue) · T: copy (the transfer queue — the readbacks). */
export type FgLane = 'G' | 'C' | 'T'

export interface FgResourceDesc {
  readonly name: string
  readonly kind: FgResourceKind
  /** buffer: the byte size; texture: optional (w·h·4 assumed when width
   *  is given — the planner's currency, an estimate by design). */
  readonly bytes?: number
  readonly width?: number
  readonly height?: number
  readonly format?: string
  /** transient (default): the content lives inside the frame; the planner
   *  frees it after the last read and ALIASES the slot. persistent: the
   *  content survives frames — the version history is the temporal reuse
   *  (reading a not-yet-written version binds the last written one). */
  readonly transient?: boolean
  /** the brick's own object behind the handle (opaque here — the caller's
   *  resolve hook and the executes see it). */
  readonly external?: unknown
  /** declared outside the graph and read by the world (validation
   * channels, HUD): the graph reports its staleness but never force-roots
   * its writers — temporal reuse stays the frame's own policy. */
  readonly exported?: boolean
}

/** The resource handle — a stable identity; versions are resolved AT
 *  COMPILE (declaration order + the persistent version state). */
export interface FgResource {
  readonly name: string
  readonly kind: FgResourceKind
  readonly bytes: number
  readonly transient: boolean
  readonly external: unknown
  readonly exported: boolean
  /** Pin a SPECIFIC version for this read (the feedback pattern: read the
   *  version before this frame's writer). The default read binds the
   *  version current at the pass's declaration point. */
  at(version: number): FgPinnedRead
}

/** A version-pinned read view (see FgResource.at). */
export interface FgPinnedRead {
  readonly resource: FgResource
  readonly pinned: number
}

export interface FgPassDesc<P> {
  readonly name: string
  readonly kind: FgPassKind
  /** The gate, evaluated AT COMPILE with the policy props — a disabled
   *  pass (and whatever depends on it alone) leaves the frame. Default:
   *  enabled. (The execute is never called for a gated-off pass.) */
  readonly when?: (props: P) => boolean
  /** The consumed resources — an array, or a compile-time function of the
   *  policy props (CONDITIONAL READS: the consumer that stops reading a
   *  branch kills the branch — `reads: p => [scene, ...(p.culling ?
   *  [tile] : [])]`). */
  readonly reads?: readonly (FgResource | FgPinnedRead)[] | ((props: P) => readonly (FgResource | FgPinnedRead)[])
  /** The produced resources — writing bumps each one's version. */
  readonly writes?: readonly FgResource[] | ((props: P) => readonly FgResource[])
  /** The rough duration (arbitrary units) — the overlap scheduler's
   *  currency; an engine feeds it from timestamp queries, the math is
   *  the same. Default 1. */
  readonly cost?: number
  /** Keep the pass even when nothing consumes it (side effects — a stats
   *  sweeper, a debug dump). Present passes are kept by definition. */
  readonly keep?: boolean
  /** The work — runs in the compiled timeline order with the RUN props
   *  (the per-frame data rides HERE, never the declaration). */
  readonly execute: (ctx: FgRunCtx<P>) => void
}

/** What an execute sees. `view(name)` exposes the compile's own metadata
 *  (the resolved version, the staleness, the slot) — the bricks mostly
 *  close over their own handles and only read props; the view channel is
 *  the honest way to reach the resolver's pooled objects. */
export interface FgRunCtx<P> {
  readonly props: P
  readonly frame: number
  readonly graph: FrameGraph<P>
  view(name: string): FgViewInfo
}

export interface FgViewInfo {
  readonly name: string
  readonly version: number
  /** frames since this version was written (0 = this frame; persistent
   *  imports carry −1 = never written / imported). */
  readonly stale: number
  readonly slot: number
  /** the resource's declared external object (the brick's own handle). */
  readonly external: unknown
  /** the pooled slot backing when the resolver hooks own this transient
   *  (the acquire happened at the slot's first interval start). */
  readonly object: unknown
}

/** One writer→reader dependency edge (the DAG's own shape). */
export interface FgEdge {
  readonly from: string | null // null = imported content (no writer pass)
  readonly to: string
  readonly resource: string
  readonly version: number
  readonly lane: FgLane | null
}

/** A barrier the frame needs between two passes. `realized` documents how
 *  each web backend satisfies it today (the honest column of the table). */
export interface FgBarrier {
  readonly after: string
  readonly before: string
  readonly resource: string
  readonly class: 'RAW' | 'WAR' | 'WAW'
  readonly lanes: `${FgLane}->${FgLane}`
}

/** A transient version's live interval (topo indices, inclusive). */
export interface FgLifetime {
  readonly resource: string
  readonly version: number
  readonly from: number
  readonly to: number
  readonly bytes: number
  readonly slot: number
}

/** One aliasing slot — one physical backing on a console, one pooled
 *  object on the web; the intervals assigned to it never overlap. An
 *  EXTERNAL slot's backing is the brick's own imported object: the
 *  accounting tracks it, the resolver hooks stay idle. */
export interface FgSlot {
  readonly index: number
  readonly intervals: readonly FgLifetime[]
  readonly peakBytes: number
  readonly external: boolean
}

export interface FgOverlap {
  /** lanes' busy windows (topo time, unit costs) — the plan's timeline. */
  readonly busy: Readonly<Record<FgLane, number>>
  readonly criticalPath: number
  /** compute/copy passes whose window overlaps graphics work — the legal
   *  overlap (what a multi-queue backend would run in parallel). */
  readonly parallel: readonly { readonly pass: string; readonly lane: FgLane; readonly units: number }[]
  readonly overlapUnits: number
}

export interface FgStats {
  readonly declared: number
  readonly live: number
  readonly gated: number
  readonly culled: number
  readonly barriers: number
  readonly slots: number
  readonly naiveBytes: number
  readonly peakBytes: number
  readonly savedBytes: number
  readonly savedPct: number
  readonly overlapUnits: number
  readonly compiles: number
}

export interface FgRunReport {
  readonly executed: readonly string[]
  /** frames since each persistent resource's bound version was written */
  readonly stale: Readonly<Record<string, number>>
  readonly ms: number
}

export interface CompiledFrame<P> {
  readonly key: string
  readonly passes: readonly { readonly name: string; readonly kind: FgPassKind; readonly execute: (ctx: FgRunCtx<P>) => void }[]
  readonly gated: readonly string[]
  readonly culled: readonly string[]
  readonly edges: readonly FgEdge[]
  readonly barriers: readonly FgBarrier[]
  readonly lifetimes: readonly FgLifetime[]
  readonly slots: readonly FgSlot[]
  readonly overlap: FgOverlap
  readonly stats: FgStats
  /** Executes the live passes in timeline order. Persistent writes land
   *  their versions into the graph state HERE (an executed write is the
   *  truth; a culled write never happened). */
  run(props: P): FgRunReport
}

export interface FrameGraph<P> {
  /** Declares a resource (once — the handle is a stable identity). */
  resource(desc: FgResourceDesc): FgResource
  /** Declares a pass (once — the declaration is the recipe; per-frame
   *  variation rides the policy props and the executes). */
  pass(desc: FgPassDesc<P>): FrameGraph<P>
  /** Compiles the frame for a policy state (CACHED: the same recorded
   *  policy returns the SAME compiled object — identity). */
  compile(props: P): CompiledFrame<P>
  /** The last run's freshness channel (per-resource staleness). */
  readonly lastStale: Readonly<Record<string, number>>
  /** The resolve hook's registry: acquire/release a slot's backing for a
   *  transient, following the plan (a pooled object's discipline is the
   *  graph's own). Both hooks are optional — pure accounting otherwise. */
  readonly declaredResources: readonly FgResource[]
  /** Drops the persistent version history (a scene reload). */
  reset(): void
}

export interface FgResolveHooks {
  /** called at a slot's FIRST interval start of a frame (once per slot
   *  per frame) — hands the plan's backing to the executes (ctx.view()
   *  exposes it as `object`). */
  readonly acquire?: (slot: number, first: FgLifetime) => unknown
  /** called when the slot's last interval of the frame retires — the
   *  pooled object goes home; the next frame's first interval of the
   *  slot re-acquires it (the discipline IS the plan). */
  readonly release?: (slot: number, backing: unknown) => void
}

// ─── the implementation ───────────────────────────────────────────────────

interface PassRec<P> {
  readonly desc: FgPassDesc<P>
  readonly index: number // declaration order
}

interface Usage {
  readonly resource: FgResource
  readonly version: number
  readonly access: 'read' | 'write'
  readonly pinned: boolean
}

function laneOf(kind: FgPassKind): FgLane {
  if (kind === 'compute') return 'C'
  if (kind === 'copy') return 'T'
  return 'G' // render + present
}

/** The recording proxy: the declarations may read only PRIMITIVE props —
 *  the recorded (key, value) pairs become the compile-cache key. A
 *  non-primitive read is the honest refusal (the per-frame data must ride
 *  the execute, or every frame would miss the cache). The key is built
 *  LAZILY — after the declarations ran — a key snapshot taken at wrap
 *  time would be the empty string for every frame (the bug the cache
 *  tests caught: the first compile answered for every policy). */
function recordPolicy<P extends Record<string, unknown>>(props: P): { proxy: P; key: () => string } {
  const seen = new Map<string, string | number | boolean | null | undefined>()
  const proxy = new Proxy(props, {
    get(target, prop, receiver) {
      if (typeof prop !== 'string') return Reflect.get(target, prop, receiver)
      const v = target[prop]
      if (typeof v === 'object' && v !== null || typeof v === 'function') {
        throw new Error(`rune/framegraph: declarations must read only primitive policy props — '${prop}' is an object/function; move the per-frame data into the pass execute (the cache keys on the policy, the data rides the run)`,)
      }
      if (!seen.has(prop)) seen.set(prop, v as string | number | boolean | null | undefined)
      return v
    },
  }) as P
  const key = (): string => Array.from(seen.keys()).sort().map(k => `${k}=${String(seen.get(k))}`).join('|')
  return { proxy, key }
}

export function createFrameGraph<P extends Record<string, unknown>>(hooks: FgResolveHooks = {}): FrameGraph<P> {
  const resources: FgResource[] = []
  const resourceByName = new Map<string, FgResource>()
  const passes: PassRec<P>[] = []
  const passNames = new Set<string>()

  // the persistent version state (cross-frame — the temporal reuse's law):
  // writtenVersion[r] = the last EXECUTED write's version; writtenFrame[r]
  // = the frame index at which it happened. Transients reset by design
  // (their versions are resolved fresh inside every compile).
  const writtenVersion = new Map<string, number>()
  const writtenFrame = new Map<string, number>()
  let frameNo = 0
  let compiles = 0
  let lastStale: Record<string, number> = {}
  const cache = new Map<string, CompiledFrame<P>>()

  function resource(desc: FgResourceDesc): FgResource {
    if (resourceByName.has(desc.name)) {
      throw new Error(`rune/framegraph: resource '${desc.name}' is declared twice — one handle is one identity`)
    }
    const bytes = desc.bytes !== undefined
      ? desc.bytes
      : desc.width !== undefined && desc.height !== undefined
        ? desc.width * desc.height * 4 // the r32f-class estimate (the planner's currency is an estimate by design)
        : 0
    const res: FgResource = {
      name: desc.name,
      kind: desc.kind,
      bytes,
      transient: desc.transient !== false,
      external: desc.external,
      exported: desc.exported === true,
      at(version: number): FgPinnedRead {
        if (version < 0 || !Number.isInteger(version)) {
          throw new Error(`rune/framegraph: at(${version}) — a pinned version is a non-negative integer`)
        }
        return { resource: res, pinned: version }
      },
    }
    resources.push(res)
    resourceByName.set(desc.name, res)
    return res
  }

  function pass(desc: FgPassDesc<P>): FrameGraph<P> {
    if (passNames.has(desc.name)) {
      throw new Error(`rune/framegraph: pass '${desc.name}' is declared twice — one name is one node`)
    }
    passNames.add(desc.name)
    passes.push({ desc, index: passes.length })
    return api
  }

  function resolveUsageList(
    list: readonly (FgResource | FgPinnedRead)[] | ((props: P) => readonly (FgResource | FgPinnedRead)[]),
    props: P,
  ): readonly (FgResource | FgPinnedRead)[] {
    const value = typeof list === 'function' ? list(props) : list
    for (const item of value) {
      const res = 'resource' in item ? (item as FgPinnedRead).resource : (item as FgResource)
      if (!resourceByName.has(res.name) || resourceByName.get(res.name) !== res) {
        throw new Error(`rune/framegraph: pass reads '${res.name}' — a handle from ANOTHER graph (handles are per-graph identities)`)
      }
    }
    return value
  }

  function compile(props: P): CompiledFrame<P> {
    const { proxy, key } = recordPolicy(props)

    // (1) the gates — evaluated on the recording proxy (the policy key)
    const enabled: PassRec<P>[] = []
    const gated: string[] = []
    for (const p of passes) {
      const on = p.desc.when === undefined ? true : p.desc.when(proxy)
      if (on) enabled.push(p)
      else gated.push(p.desc.name)
    }

    // (2) the version resolution — declaration order over the enabled set.
    // pending[r] starts at the persistent state (the last executed write)
    // and bumps on every declared write; reads bind the CURRENT pending
    // version (a pinned read binds its own).
    const pending = new Map<string, number>()
    const usages = new Map<number, Usage[]>() // pass declaration index → usages
    for (const r of resources) {
      if (!r.transient) pending.set(r.name, writtenVersion.get(r.name) ?? 0)
    }
    for (const p of enabled) {
      const own: Usage[] = []
      const readList = p.desc.reads === undefined ? [] : resolveUsageList(p.desc.reads, proxy)
      for (const item of readList) {
        const pinned = 'pinned' in (item as FgPinnedRead)
        const res = pinned ? (item as FgPinnedRead).resource : (item as FgResource)
        const version = pinned ? (item as FgPinnedRead).pinned : (pending.get(res.name) ?? 0)
        own.push({ resource: res, version, access: 'read', pinned })
      }
      const writeList = p.desc.writes === undefined ? [] : resolveUsageList(p.desc.writes, proxy)
      for (const item of writeList) {
        if ('pinned' in (item as FgPinnedRead)) {
          throw new Error(`rune/framegraph: pass '${p.desc.name}' WRITES a pinned handle — pins are read-only views (res.at(v))`)
        }
        const res = item as FgResource
        const version = (pending.get(res.name) ?? 0) + 1
        pending.set(res.name, version)
        own.push({ resource: res, version, access: 'write', pinned: false })
      }
      usages.set(p.index, own)
    }

    // THE POLICY KEY — built LAZILY here, after every declaration ran: the
    // recorded (name, value) pairs of the props the declarations actually
    // read. The same policy bit-still → the cache answers with the SAME
    // compiled object; a flipped gate → a fresh compile. (A cached frame
    // may re-run with fresh RUN props — the executes see those, the
    // declarations never see them again.)
    const policyKey = key()
    const hit = cache.get(policyKey)
    if (hit !== undefined) return hit
    compiles++

    // (3) the DAG — per resource-version: the writer pass + the readers
    // (sequential writers are LEGAL — each write bumps its own version;
    // the reader binds the LAST one, exactly the ping-pong/overlay law)
    const writerOf = new Map<string, number>() // "res@v" → pass declaration index
    const readersOf = new Map<string, number[]>()
    for (const p of enabled) {
      for (const u of usages.get(p.index) ?? []) {
        const k = `${u.resource.name}@${u.version}`
        if (u.access === 'write') {
          writerOf.set(k, p.index)
        } else {
          const arr = readersOf.get(k) ?? []
          arr.push(p.index)
          readersOf.set(k, arr)
        }
      }
    }
    // (4) the roots + backward reachability — THE BRANCH CULLING.
    // Roots: enabled present passes + enabled keep passes + enabled
    // WRITE-LESS COPY passes (a copy that writes nothing is an EXPORT —
    // its product leaves the graph to the world; when its gate is on,
    // the pass is wanted, period). Everything a root cannot reach
    // through the edges leaves the frame.
    const liveSet = new Set<number>()
    const stack: number[] = []
    for (const p of enabled) {
      const writesNothing = (usages.get(p.index) ?? []).every(u => u.access !== 'write')
      if (p.desc.kind === 'present' || p.desc.keep === true || (p.desc.kind === 'copy' && writesNothing)) {
        liveSet.add(p.index)
        stack.push(p.index)
      }
    }
    // reverse adjacency: reader → its writers (the LIVE edges' own map)
    const deps = new Map<number, number[]>()
    for (const p of enabled) deps.set(p.index, [])
    for (const [k, readers] of readersOf) {
      const w = writerOf.get(k)
      if (w === undefined) continue // imported content — no pass dependency
      for (const r of readers) {
        if (r === w) continue
        deps.get(r)?.push(w)
      }
    }
    while (stack.length > 0) {
      const cur = stack.pop() as number
      for (const d of deps.get(cur) ?? []) {
        if (!liveSet.has(d)) {
          liveSet.add(d)
          stack.push(d)
        }
      }
    }
    const live = enabled.filter(p => liveSet.has(p.index))
    const culled = enabled.filter(p => !liveSet.has(p.index)).map(p => p.desc.name)

    // the public edge list — LIVE passes only (the frame's own DAG; the
    // gated/culled branches left it, and their edges left with them)
    const edges: FgEdge[] = []
    for (const [k, readers] of readersOf) {
      const [resName, vRaw] = k.split('@')
      const w = writerOf.get(k)
      for (const r of readers) {
        if (w === r) continue // a read-modify-write pass is not its own edge
        if (!liveSet.has(r) || (w !== undefined && !liveSet.has(w))) continue
        edges.push({ from: w === undefined ? null : passes[w].desc.name, to: passes[r].desc.name, resource: resName, version: Number(vRaw), lane: w === undefined ? null : laneOf(passes[w].desc.kind) })
      }
    }

    // (5) the honest refusal — a LIVE reader of a transient version with
    // no live writer (the gated-writer class). Imported persistent
    // content (version never written, ever) is legal — the boot upload.
    for (const p of live) {
      for (const u of usages.get(p.index) ?? []) {
        if (u.access !== 'read' || !u.resource.transient) continue
        const k = `${u.resource.name}@${u.version}`
        const w = writerOf.get(k)
        if (w === undefined || !liveSet.has(w)) {
          const writerNote = w === undefined
            ? `no pass writes it this frame`
            : `its writer '${passes[w].desc.name}' left the frame (gated off or culled)`
          throw new Error(`rune/framegraph: pass '${p.desc.name}' reads '${k}' but ${writerNote} — a transient's content exists only inside its frame; gate the READER too, or keep the writer (this is the shadows-off class: the consumer must die with the producer)`)
        }
      }
    }

    // (6) the timeline — deterministic topological order. Declaration
    // order already respects every edge (versions only move forward), so
    // Kahn with a declaration-order tiebreak IS the declaration order of
    // the live set; the walk below verifies the law (a cycle would mean a
    // pass reading a version written later — impossible by construction,
    // but the check stays: honest machines verify their own axioms).
    const order = live.map(p => p.index)
    const topoIndex = new Map<number, number>()
    order.forEach((passIdx, i) => topoIndex.set(passIdx, i))
    {
      const rank = new Map<number, number>()
      for (const passIdx of order) {
        let r = 0
        for (const d of deps.get(passIdx) ?? []) {
          const dr = rank.get(d)
          if (dr === undefined) {
            throw new Error(`rune/framegraph: the frame graph is not a DAG ('${passes[passIdx].desc.name}' precedes its producer) — declaration order must write before it reads`)
          }
          r = Math.max(r, dr + 1)
        }
        rank.set(passIdx, r)
      }
    }

    // (7) the transient lifetimes — [writer's topo index .. last LIVE
    // reader] (a version read only by dead passes still owns its writer's
    // interval: the memory lived while the writer ran)
    const lifetimesRaw: Omit<FgLifetime, 'slot'>[] = []
    for (const [k, readers] of readersOf) {
      const w = writerOf.get(k)
      if (w === undefined || !liveSet.has(w)) continue
      const resName = k.split('@')[0]
      const res = resourceByName.get(resName)
      if (res === undefined || !res.transient) continue
      let last = topoIndex.get(w) as number
      for (const r of readers) {
        if (!liveSet.has(r) || r === w) continue
        last = Math.max(last, topoIndex.get(r) as number)
      }
      lifetimesRaw.push({
        resource: resName,
        version: Number(k.split('@')[1]),
        from: topoIndex.get(w) as number,
        to: last,
        bytes: res.bytes,
      })
    }
    // a written-but-never-read transient still owns its interval (the
    // writer alone — the pass's own scratch, freed right after it)
    for (const p of live) {
      for (const u of usages.get(p.index) ?? []) {
        if (u.access !== 'write' || !u.resource.transient) continue
        const k = `${u.resource.name}@${u.version}`
        if (readersOf.has(k)) continue // already covered above
        lifetimesRaw.push({ resource: u.resource.name, version: u.version, from: topoIndex.get(p.index) as number, to: topoIndex.get(p.index) as number, bytes: u.resource.bytes })
      }
    }

    // (8) THE ALIASING PLANNER — interval scheduling by live range: sort
    // by (from, to); each pooled slot keeps its last end; an interval fits
    // the first slot free before its start. Overlapping lifetimes NEVER
    // share a slot — the soundness the tests pin (and the exact math a
    // console uses to hand one memory block to two textures).
    // EXTERNAL-backed transients (a brick's own object) get a DEDICATED
    // slot each: their backing is not the graph's to alias — the planner
    // still tracks the lifetime (the accounting stays honest), the
    // resolver hooks never touch it.
    lifetimesRaw.sort((a, b) => a.from - b.from || a.to - b.to || a.bytes - b.bytes)
    const slotEnds: number[] = []
    const slotIntervals: FgLifetime[][] = []
    const slotExternal: boolean[] = []
    const lifetimes: FgLifetime[] = lifetimesRaw.map(iv => {
      const res = resourceByName.get(iv.resource)
      const external = res?.external !== undefined
      let slot: number
      if (external) {
        slot = slotEnds.length
        slotEnds.push(iv.to)
        slotIntervals.push([])
        slotExternal.push(true)
      } else {
        slot = slotEnds.findIndex(end => end < iv.from)
        if (slot === -1 || slotExternal[slot]) {
          slot = slotEnds.length
          slotEnds.push(iv.to)
          slotIntervals.push([])
          slotExternal.push(false)
        } else {
          slotEnds[slot] = iv.to
        }
      }
      const withSlot = { ...iv, slot }
      slotIntervals[slot].push(withSlot)
      return withSlot
    })
    const slots: FgSlot[] = slotIntervals.map((intervals, index) => ({
      index,
      intervals,
      peakBytes: intervals.reduce((m, iv) => Math.max(m, iv.bytes), 0),
      external: slotExternal[index],
    }))
    const naiveBytes = lifetimes.reduce((s, iv) => s + iv.bytes, 0)
    const peakBytes = slots.reduce((s, slot) => s + slot.peakBytes, 0)

    // (9) THE BARRIERS — two honest sources, deduped:
    //  (a) EDGE crossings: every DAG edge whose writer's lane differs from
    //      its reader's lane is a RAW the queues must sync (the async-
    //      compute case — the consumer's lane cannot start on the
    //      producer's data without it). An intervening same-lane read
    //      does NOT discharge it: the reader's lane is different, the
    //      producer's write is the hazard;
    //  (b) USAGE crossings: per pass (WRITE-PRIORITY — a read-modify-write
    //      counts as a write; a pass's own usages never self-compare), a
    //      write on either side across lanes is a WAR/WAW the timeline
    //      must order.
    //  SAME-LANE hazards ride the queue's own order — the pipeline law:
    //  GL's global order and the WG encoder's pass boundaries cover RAW/
    //  WAR/WAW inside one lane, and a same-state WAW on one target needs
    //  no transition. The emitted list is the sync contract those
    //  boundaries are already honoring — and the exact submission a
    //  D3D12/Vulkan port would make.
    const barriers: FgBarrier[] = []
    {
      const barrierKeys = new Set<string>()
      const kindByName = new Map<string, FgPassKind>()
      for (const passIdx of order) kindByName.set(passes[passIdx].desc.name, passes[passIdx].desc.kind)
      const topoOfName = new Map<string, number>()
      order.forEach((passIdx, i) => topoOfName.set(passes[passIdx].desc.name, i))
      const emit = (after: string, before: string, resource: string, cls: 'RAW' | 'WAR' | 'WAW', lanes: `${FgLane}->${FgLane}`): void => {
        const k = `${after}|${before}|${resource}|${cls}|${lanes}`
        if (barrierKeys.has(k)) return
        barrierKeys.add(k)
        barriers.push({ after, before, resource, class: cls, lanes })
      }
      // (a) the edge crossings
      for (const e of edges) {
        if (e.from === null || e.lane === null) continue
        const consumerKind = kindByName.get(e.to)
        if (consumerKind === undefined) continue
        const consumerLane = laneOf(consumerKind)
        if (consumerLane !== e.lane) emit(e.from, e.to, e.resource, 'RAW', `${e.lane}->${consumerLane}`)
      }
      // (b) the usage crossings (per-pass, write-priority, cross-lane only)
      const lastBefore = new Map<string, { pass: string; kind: FgPassKind; access: 'read' | 'write' }>()
      for (const passIdx of order) {
        const p = passes[passIdx]
        const own = new Map<string, 'read' | 'write'>()
        for (const u of usages.get(passIdx) ?? []) {
          own.set(u.resource.name, own.get(u.resource.name) === 'write' || u.access === 'write' ? 'write' : 'read')
        }
        for (const [name, access] of own) {
          const prev = lastBefore.get(name)
          if (prev !== undefined && prev.pass !== p.desc.name) {
            const hazard = prev.access === 'write' || access === 'write'
            if (hazard && laneOf(prev.kind) !== laneOf(p.desc.kind)) {
              const cls: 'RAW' | 'WAR' | 'WAW' = prev.access === 'write' && access === 'read' ? 'RAW' : prev.access === 'read' && access === 'write' ? 'WAR' : 'WAW'
              emit(prev.pass, p.desc.name, name, cls, `${laneOf(prev.kind)}->${laneOf(p.desc.kind)}`)
            }
          }
          lastBefore.set(name, { pass: p.desc.name, kind: p.desc.kind, access })
        }
      }
      // the timeline order (the report reads like the frame runs)
      barriers.sort((a, b) => (topoOfName.get(a.before) ?? 0) - (topoOfName.get(b.before) ?? 0) || (topoOfName.get(a.after) ?? 0) - (topoOfName.get(b.after) ?? 0))
    }

    // (10) THE 3-LANE OVERLAP PLAN — event simulation: each pass starts
    // at max(its deps' finish, its lane's free time) and runs `cost`
    // units on its lane. A compute/copy window overlapping the graphics
    // lane's busy time is LEGAL parallelism — the plan a multi-queue
    // backend follows (and the async-readback reality the copy lane
    // already has on the web).
    const finishOf = new Map<number, number>()
    const busy: Record<FgLane, number> = { G: 0, C: 0, T: 0 }
    const parallel: { pass: string; lane: FgLane; units: number }[] = []
    let overlapUnits = 0
    for (const passIdx of order) {
      const p = passes[passIdx]
      const lane = laneOf(p.desc.kind)
      const cost = p.desc.cost ?? 1
      let ready = 0
      for (const d of deps.get(passIdx) ?? []) {
        const f = finishOf.get(d)
        if (f !== undefined) ready = Math.max(ready, f)
      }
      // the other lanes' busy-now at this pass's START — the overlap the
      // plan finds for a compute/copy pass running beside graphics work
      const othersBusy = (['G', 'C', 'T'] as const).filter(l => l !== lane && busy[l] > ready)
      const start = Math.max(ready, busy[lane])
      const finish = start + cost
      busy[lane] = finish
      finishOf.set(passIdx, finish)
      if ((lane === 'C' || lane === 'T') && othersBusy.length > 0) {
        // the overlap window: from this pass's start until the earliest
        // busy other lane goes quiet (capped by this pass's own finish)
        const until = Math.min(...othersBusy.map(l => busy[l]), finish)
        const units = Math.max(0, until - start)
        if (units > 0) {
          parallel.push({ pass: p.desc.name, lane, units })
          overlapUnits += units
        }
      }
    }
    const criticalPath = Math.max(busy.G, busy.C, busy.T)

    const statsSnapshot: Omit<FgStats, 'compiles'> = {
      declared: passes.length,
      live: live.length,
      gated: gated.length,
      culled: culled.length,
      barriers: barriers.length,
      slots: slots.length,
      naiveBytes,
      peakBytes,
      savedBytes: Math.max(0, naiveBytes - peakBytes),
      savedPct: naiveBytes > 0 ? 100 * (naiveBytes - peakBytes) / naiveBytes : 0,
      overlapUnits,
    }

    const frame: CompiledFrame<P> = {
      key: policyKey,
      passes: live.map(p => ({ name: p.desc.name, kind: p.desc.kind, execute: p.desc.execute })),
      gated,
      culled,
      edges,
      barriers,
      lifetimes,
      slots,
      overlap: { busy, criticalPath, parallel, overlapUnits },
      // the compile-time numbers + the LIVE compile counter (a cached
      // frame's snapshot would otherwise freeze the count at its birth)
      get stats(): FgStats { return { ...statsSnapshot, compiles } },
      run(runProps: P): FgRunReport {
        const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now()
        const executed: string[] = []
        // THE SLOT DISCIPLINE (plan-driven, not execute-driven): a slot's
        // backing is acquired at its FIRST interval's start and released
        // at its LAST interval's end — whether or not the executes ask.
        // This is the exact acquire/release timeline the console's memory
        // aliases and the web pool follow.
        const slotFirstStart = new Map<number, number>()
        const slotLastEnd = new Map<number, number>()
        for (const iv of lifetimes) {
          slotFirstStart.set(iv.slot, Math.min(slotFirstStart.get(iv.slot) ?? Infinity, iv.from))
          slotLastEnd.set(iv.slot, Math.max(slotLastEnd.get(iv.slot) ?? -1, iv.to))
        }
        const slotBacking = new Map<number, unknown>()
        const ctx: FgRunCtx<P> = {
          props: runProps,
          frame: frameNo,
          graph: api,
          view(name: string): FgViewInfo {
            const res = resourceByName.get(name)
            if (res === undefined) throw new Error(`rune/framegraph: view('${name}') — no such resource`)
            const ver = pending.get(name) ?? writtenVersion.get(name) ?? 0
            const wf = writtenFrame.get(name)
            const iv = lifetimes.find(l => l.resource === name && l.version === ver)
            return {
              name,
              version: ver,
              stale: wf === undefined ? -1 : frameNo - wf,
              slot: iv?.slot ?? -1,
              external: res.external,
              object: slotBacking.get(iv?.slot ?? -1) ?? res.external,
            }
          },
        }
        for (let i = 0; i < order.length; i++) {
          const passIdx = order[i]
          const p = passes[passIdx]
          if (hooks.acquire !== undefined) {
            for (const [slot, start] of slotFirstStart) {
              if (start === i && !slotBacking.has(slot) && !slots[slot]?.external) {
                slotBacking.set(slot, hooks.acquire(slot, lifetimes.find(l => l.slot === slot && l.from === start) as FgLifetime))
              }
            }
          }
          p.desc.execute(ctx)
          executed.push(p.desc.name)
          // a persistent write lands its version NOW — an executed write
          // is the truth; a culled write never happened (the staleness
          // grows by exactly the frames the writer stayed out)
          for (const u of usages.get(passIdx) ?? []) {
            if (u.access === 'write' && !u.resource.transient) {
              writtenVersion.set(u.resource.name, u.version)
              writtenFrame.set(u.resource.name, frameNo)
            }
          }
          if (hooks.release !== undefined) {
            for (const [slot, end] of slotLastEnd) {
              if (end === i && slotBacking.has(slot)) {
                hooks.release(slot, slotBacking.get(slot))
                slotBacking.delete(slot)
              }
            }
          }
        }
        // a read-only frame (nothing acquired?) — nothing to release; a
        // frame whose last interval ends past the last pass cannot exist
        // (lifetimes are bounded by the live passes); the leftover sweep
        // below is the belt-and-suspenders honesty of this codebase
        if (hooks.release !== undefined) {
          for (const [slot, backing] of slotBacking) hooks.release(slot, backing)
        }
        frameNo++
        const stale: Record<string, number> = {}
        for (const r of resources) {
          if (r.transient) continue
          const wf = writtenFrame.get(r.name)
          stale[r.name] = wf === undefined ? -1 : frameNo - 1 - wf
        }
        lastStale = stale
        const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now()
        return { executed, stale, ms: t1 - t0 }
      },
    }
    cache.set(policyKey, frame)
    return frame
  }

  const api: FrameGraph<P> = {
    resource,
    pass,
    compile,
    get lastStale() { return lastStale },
    get declaredResources() { return resources },
    reset(): void {
      writtenVersion.clear()
      writtenFrame.clear()
      cache.clear()
      frameNo = 0
    },
  }
  return api
}
