/**
 * library.ts — AssetLibrary: the public asset loading facade.
 *
 * Responsibilities:
 *   - load(url, opts) → AssetHandle: thenable + progress + cancel + priority;
 *   - dedup: parallel loads of one URL share ONE job;
 *   - cache with LRU eviction by a byte budget (cacheBytesLimit);
 *   - preload(urls) — cache warm-up (errors go into the report, not thrown);
 *   - loadGroup — aggregated progress/cancellation of a batch;
 *   - events (progress/done/error/cancelled/evicted) for the UI;
 *   - format registry: extension + magic sniffing (glb/fbx) + registration
 *     of custom parsers (registerFormat).
 *
 * Layers do NOT mix: the library knows about network/formats/cache, but not the
 * GPU — the "bare core" receives typed arrays and ImageBitmaps;
 * integration with rendering is the consumer's job (demo / @rune/kit).
 */

import { LoadScheduler, nextSchedulerJobId, type SchedulerJob } from './scheduler.ts'
import { openByteSource, type StreamAssembler, type ByteSourceOptions } from './source.ts'
import {
  PHASE_WEIGHTS,
  type AssetHandle,
  type AssetMeta,
  type AssetPhase,
  type AssetProgress,
  type LibraryEvent,
  type LibraryStats,
  type LoadGroup,
  type LoadOptions,
} from './types.ts'
import { parseGlb, parseGltfJson, looksLikeGlb, type GltfModel, type GltfParseOptions, type DracoGeometryDecoder } from './gltf.ts'
import { parseObjStream, type ObjModel } from './obj.ts'
import { parseFbx, looksLikeFbxBinary, type FbxModel } from './fbx.ts'
import { parseImage, type ImageAsset } from './image.ts'
import { parseMtlBytes, type MtlLibrary } from './mtl.ts'
import { configParserOf, parseConfig, parseTextBytes, registerConfigParser, type ConfigParser } from './config.ts'

export type LoadedAsset = GltfModel | ObjModel | FbxModel | MtlLibrary | ImageAsset | unknown

export interface AssetLibraryOptions {
  /** Custom scheduler (default: maxConcurrent 3, 64 MB in-flight). */
  readonly scheduler?: LoadScheduler
  /** fetch override — tests/synthetics. */
  readonly fetchImpl?: typeof fetch
  /** Cache budget in bytes (default 256 MB; 0 = no limit). */
  readonly cacheBytesLimit?: number
  /** ImageBitmap factory injection (tests). */
  readonly createBitmap?: (bytes: Uint8Array, mimeType: string) => Promise<ImageBitmap>
  /** Draco decoder injection (KHR_draco_mesh_compression): the engine does not
   *  carry wasm — the consumer (demo/app) plugs in an external decoder. */
  readonly dracoDecoder?: DracoGeometryDecoder
  /** Defaults applied to every load. */
  readonly defaults?: Partial<LoadOptions>
}

export interface ParserContext {
  readonly url: string
  readonly assembler: StreamAssembler
  readonly signal?: AbortSignal
  readonly onPhase: (info: { stage: string; ratio: number; detail: string }) => void
  /** Load an external resource (for .gltf with external buffers). */
  loadExternal(uri: string): Promise<Uint8Array>
  createBitmap?: (bytes: Uint8Array, mimeType: string) => Promise<ImageBitmap>
  /** Draco decoder from library options (injection). */
  dracoDecoder?: DracoGeometryDecoder
}

export type ParserFn = (ctx: ParserContext) => Promise<unknown>

interface FormatEntry {
  readonly id: string
  readonly extensions: readonly string[]
  readonly parse: ParserFn
}

// ─── Format registry ───────────────────────────────────────────────────────

function defaultFormats(): FormatEntry[] {
  return [
    { id: 'glb', extensions: ['glb'], parse: async ctx => parseGlb(ctx.assembler, gltfOptions(ctx)) },
    {
      id: 'gltf',
      extensions: ['gltf'],
      parse: async ctx => {
        await ctx.assembler.completion
        const jsonText = parseTextBytes(ctx.assembler.fullView())
        return parseGltfJson(jsonText, { loadExternal: ctx.loadExternal }, gltfOptions(ctx))
      },
    },
    { id: 'obj', extensions: ['obj'], parse: async ctx => parseObjStream(ctx.assembler, { onPhase: ctx.onPhase }) },
    {
      id: 'mtl',
      extensions: ['mtl'],
      parse: async ctx => {
        await ctx.assembler.completion
        return parseMtlBytes(ctx.assembler.fullView())
      },
    },
    {
      id: 'fbx',
      extensions: ['fbx'],
      parse: async ctx => {
        await ctx.assembler.completion
        return parseFbx(ctx.assembler.fullView(), { signal: ctx.signal, onPhase: ctx.onPhase })
      },
    },
    {
      id: 'image',
      extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'ico'],
      parse: async ctx =>
        parseImage(ctx.assembler, { signal: ctx.signal, onPhase: ctx.onPhase, createBitmap: ctx.createBitmap }),
    },
    {
      id: 'config',
      extensions: ['json', 'zml', 'ini', 'txt', 'yaml', 'yml', 'toml'],
      parse: async ctx => parseConfig(ctx.assembler, extensionOf(ctx.url), { onPhase: ctx.onPhase }),
    },
    {
      id: 'bytes',
      extensions: ['bin', 'ktx2'],
      parse: async ctx => {
        await ctx.assembler.completion
        return ctx.assembler.fullView()
      },
    },
  ]
}

function gltfOptions(ctx: ParserContext): GltfParseOptions {
  return { signal: ctx.signal, onPhase: ctx.onPhase, createBitmap: ctx.createBitmap, dracoDecoder: ctx.dracoDecoder }
}

/** URL extension (no query/hash, lower-case). */
function extensionOf(url: string): string {
  const clean = url.split('?')[0]?.split('#')[0] ?? ''
  const slash = clean.lastIndexOf('/')
  const dot = clean.lastIndexOf('.')
  if (dot <= slash) return ''
  return clean.slice(dot + 1).toLowerCase()
}

// ─── Handle ─────────────────────────────────────────────────────────────────

class AssetHandleImpl<T> implements AssetHandle<T> {
  private snapshot: AssetProgress
  private settled = false

  constructor(
    readonly url: string,
    readonly key: string,
    private readonly promise: Promise<T>,
    initial: AssetProgress,
    private readonly cancelImpl: (reason?: string) => boolean,
    private readonly priorityImpl: (priority: number) => boolean,
  ) {
    this.snapshot = initial
  }

  get progress(): AssetProgress {
    return this.snapshot
  }

  get state(): AssetPhase {
    return this.snapshot.phase
  }

  get isSettled(): boolean {
    return this.settled
  }

  markSettled(): void {
    this.settled = true
  }

  update(next: AssetProgress): void {
    this.snapshot = next
  }

  cancel(reason?: string): boolean {
    return this.cancelImpl(reason)
  }

  setPriority(priority: number): boolean {
    return this.priorityImpl(priority)
  }

  then<R1 = T, R2 = never>(
    onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.promise.then(onfulfilled, onrejected)
  }

  catch<R2 = never>(onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null): PromiseLike<T | R2> {
    return this.promise.then(undefined, onrejected)
  }
}

// ─── Library ────────────────────────────────────────────────────────────

interface CacheEntry {
  asset: unknown
  bytes: number
  lastAccess: number
}

export class AssetLibrary {
  readonly scheduler: LoadScheduler
  private readonly fetchImpl: typeof fetch
  private readonly cacheBytesLimit: number
  private readonly createBitmap?: (bytes: Uint8Array, mimeType: string) => Promise<ImageBitmap>
  private readonly dracoDecoder?: DracoGeometryDecoder
  private readonly defaults: Partial<LoadOptions>
  private readonly formats: FormatEntry[] = defaultFormats()
  private readonly jobs = new Map<string, { handle: AssetHandleImpl<unknown>; schedulerJob: SchedulerJob; cancelled: boolean }>()
  private readonly cache = new Map<string, CacheEntry>()
  private readonly listeners = new Map<string, Set<(event: LibraryEvent) => void>>()
  private downloads = 0
  private downloadBytes = 0
  private cacheHits = 0

  constructor(options: AssetLibraryOptions = {}) {
    this.scheduler = options.scheduler ?? new LoadScheduler()
    this.fetchImpl = options.fetchImpl ?? fetch
    this.cacheBytesLimit = options.cacheBytesLimit ?? 256 * 1024 * 1024
    this.createBitmap = options.createBitmap
    this.dracoDecoder = options.dracoDecoder
    this.defaults = options.defaults ?? {}
  }

  // ── Public API ───────────────────────────────────────────────────

  /** Load an asset: a thenable handle with progress/cancel/priority. */
  load<T = LoadedAsset>(url: string, options: LoadOptions = {}): AssetHandle<T> {
    const merged: LoadOptions = { ...this.defaults, ...options }
    const key = url

    // Cache: an instant handle (no network).
    const cached = this.cache.get(key)
    if (cached !== undefined) {
      cached.lastAccess = now()
      this.cacheHits++
      const handle = new AssetHandleImpl<T>(
        url,
        key,
        Promise.resolve(cached.asset as T),
        { phase: 'done', loaded: cached.bytes, total: cached.bytes, phaseRatio: 1, ratio: 1, url, cached: true, detail: 'from cache' },
        () => false,
        () => false,
      )
      handle.markSettled()
      // Cache hit — the progress callback also gets the final snapshot.
      options.onProgress?.(handle.progress)
      this.emit({ type: 'done', handle: handle as never })
      return handle
    }

    // Dedup: parallel loads of one URL share the job and the handle.
    const existing = this.jobs.get(key)
    if (existing !== undefined) {
      return existing.handle as AssetHandle<T>
    }

    let currentWeight = merged.weightBytes ?? 8 * 1024 * 1024
    let phase: AssetPhase = 'queued'
    let loaded = 0
    let total = 0
    let phaseRatio = 0
    let detail = 'queued'

    let resolveAsset!: (asset: unknown) => void
    let rejectAsset!: (error: unknown) => void
    const promise = new Promise<unknown>((resolve, reject) => {
      resolveAsset = resolve
      rejectAsset = reject
    })

    const snapshot = (): AssetProgress => ({
      phase,
      loaded,
      total,
      phaseRatio,
      ratio: aggregateRatio(phase, phaseRatio, loaded, total),
      url,
      cached: false,
      detail,
    })

    const finishJob = (): void => {
      this.jobs.delete(key)
    }

    const schedulerJob: SchedulerJob = {
      id: nextSchedulerJobId(),
      priority: merged.priority ?? 5,
      seq: nextSchedulerJobId(),
      weight: () => currentWeight,
      onCancelledBeforeStart: reason => {
        phase = 'cancelled'
        const snap = snapshot()
        handle.update(snap)
        merged.onProgress?.(snap)
        finishJob()
        handle.markSettled()
        rejectAsset(cancelError(reason))
        this.emit({ type: 'cancelled', handle: handle as never })
      },
      start: async signal => {
        const startedAt = now()
        phase = 'fetching'
        pushProgress('connecting')

        // Composite cancellation: scheduler + external signal.
        const controller = new AbortController()
        const external = merged.signal
        if (external?.aborted) throw cancelError(external.reason)
        external?.addEventListener('abort', () => controller.abort(cancelError(external.reason)), { once: true })
        signal.addEventListener('abort', () => controller.abort(cancelError(signal.reason)), { once: true })

        try {
          const sourceOptions: ByteSourceOptions = {
            signal: controller.signal,
            connectTimeoutMs: merged.connectTimeoutMs,
            retries: merged.retries,
            fetchImpl: this.fetchImpl,
            onBytes: (received, contentTotal) => {
              loaded = received
              if (contentTotal > 0 && received <= contentTotal && contentTotal !== total) {
                total = contentTotal
                currentWeight = contentTotal
                this.scheduler.updateWeight(schedulerJob)
              } else if (total > 0 && received > total) {
                // gzip transfer: content-length is compressed, the body is longer —
                // treat the length as unknown (asymptotic progress).
                total = 0
              }
              phaseRatio = total > 0 ? received / total : asymptotic(received)
              pushProgress(
                `${fmtBytes(received)}${total > 0 ? ` / ${fmtBytes(total)}` : ''}`,
              )
            },
          }
          const source = await openByteSource(url, sourceOptions)
          if (source.contentLength !== undefined && source.contentLength > 0) {
            total = source.contentLength
            currentWeight = source.contentLength
            this.scheduler.updateWeight(schedulerJob)
          }
          this.downloads++

          const parser = await this.resolveParser(url, merged, source.assembler)

          phase = 'parsing'
          phaseRatio = 0
          pushProgress('parsing')
          const parseStartedAt = now()
          const asset = await parser({
            url,
            assembler: source.assembler,
            signal: controller.signal,
            onPhase: info => {
              phaseRatio = info.ratio
              pushProgress(`${info.stage}: ${info.detail}`)
            },
            loadExternal: async uri => {
              const absolute = resolveUrl(url, uri)
              const sub = await openByteSource(absolute, sourceOptions)
              await sub.done
              return sub.assembler.fullView()
            },
            createBitmap: this.createBitmap,
            dracoDecoder: this.dracoDecoder,
          })
          const parseMs = now() - parseStartedAt

          // User transforms — the post-processing pipe.
          const transforms = merged.transform ?? []
          let value: unknown = asset
          if (transforms.length > 0) {
            phase = 'transforming'
            for (let i = 0; i < transforms.length; i++) {
              phaseRatio = i / transforms.length
              pushProgress(`transform ${i + 1}/${transforms.length}`)
              const meta: AssetMeta = { url, bytes: loaded, fetchedMs: parseStartedAt - startedAt, parsedMs: parseMs }
              value = await (transforms[i] as (a: unknown, m: AssetMeta) => unknown)(value, meta)
            }
          }

          if (!merged.noCache) {
            this.cache.set(key, { asset: value, bytes: Math.max(loaded, total, 1), lastAccess: now() })
            this.evictIfNeeded()
          }
          this.downloadBytes += loaded
          phase = 'done'
          phaseRatio = 1
          pushProgress(`done in ${fmtMs(now() - startedAt)}`)
          finishJob()
          resolveAsset(value)
          handle.markSettled()
          this.emit({ type: 'done', handle: handle as never })
        } catch (error) {
          const aborted = isAbortError(error)
          phase = aborted ? 'cancelled' : 'error'
          const snap = snapshot()
          handle.update(snap)
          merged.onProgress?.(snap)
          finishJob()
          handle.markSettled()
          rejectAsset(error)
          if (aborted) this.emit({ type: 'cancelled', handle: handle as never })
          else this.emit({ type: 'error', handle: handle as never, error })
        }
      },
    }

    const handle: AssetHandleImpl<unknown> = new AssetHandleImpl<unknown>(
      url,
      key,
      promise,
      { phase: 'queued', loaded: 0, total: 0, phaseRatio: 0, ratio: 0, url, cached: false, detail: 'queued' },
      reason => {
        if (handle.isSettled) return false
        const job = this.jobs.get(key)
        if (job !== undefined) job.cancelled = true
        return this.scheduler.cancel(schedulerJob, reason)
      },
      priority => {
        if (handle.isSettled) return false
        return this.scheduler.setPriority(schedulerJob, priority)
      },
    )

    function pushProgress(nextDetail?: string): void {
      if (nextDetail !== undefined) detail = nextDetail
      const snap = snapshot()
      handle.update(snap)
      merged.onProgress?.(snap)
      // emit — via the library closure (this is unavailable in a function):
      emitProgress(snap)
    }

    // Arrow bridge: pushProgress is declared before the handle, but called
    // after its creation — function hoisting + the closure are correct.
    const emitProgress = (snap: AssetProgress): void => {
      this.emit({ type: 'progress', handle: handle as never })
      void snap
    }

    this.jobs.set(key, { handle, schedulerJob, cancelled: false })
    this.scheduler.submit(schedulerJob)
    return handle as AssetHandle<T>
  }

  /** Preload: warm up the cache (errors go into the report, not thrown). */
  async preload(
    urls: readonly string[],
    options: LoadOptions = {},
  ): Promise<{ ok: string[]; failed: { url: string; error: unknown }[] }> {
    const ok: string[] = []
    const failed: { url: string; error: unknown }[] = []
    await Promise.all(
      urls.map(async url => {
        try {
          await this.load(url, options)
          ok.push(url)
        } catch (error) {
          failed.push({ url, error })
        }
      }),
    )
    return { ok, failed }
  }

  /** A batch with aggregated progress (weighted by weights). */
  loadGroup<T = LoadedAsset>(entries: readonly { url: string; options?: LoadOptions }[]): LoadGroup<T> {
    const handles = entries.map(entry => this.load<T>(entry.url, entry.options ?? {}))
    let cancelled = false
    const promise = Promise.all(handles.map(handle => (handle as AssetHandle<T>).then(value => value)))
    const group: LoadGroup<T> = {
      urls: entries.map(entry => entry.url),
      promise,
      get progress(): AssetProgress {
        let weightSum = 0
        let weighted = 0
        let loaded = 0
        let total = 0
        let doneCount = 0
        let label = 'queued'
        const rank: Record<AssetPhase, number> = {
          queued: 1, fetching: 2, parsing: 3, transforming: 4, done: 5, error: 5, cancelled: 5,
        }
        let worstRank = 0
        for (const handle of handles) {
          const p = handle.progress
          const weight = Math.max(p.total, p.loaded, 1)
          weightSum += weight
          weighted += weight * p.ratio
          loaded += p.loaded
          total += p.total
          if (p.phase === 'done') doneCount++
          if (rank[p.phase] > worstRank) {
            worstRank = rank[p.phase]
            label = p.phase
          }
        }
        const ratio = weightSum > 0 ? weighted / weightSum : 0
        const detail =
          `${doneCount}/${handles.length} done · ` +
          (label === 'fetching' ? `${fmtBytes(loaded)}${total > 0 ? ` / ${fmtBytes(total)}` : ''}` : label)
        return {
          phase: label as AssetPhase,
          loaded,
          total,
          phaseRatio: ratio,
          ratio,
          url: entries.length === 1 ? entries[0].url : `${handles.length} assets`,
          cached: false,
          detail,
        }
      },
      cancel: (reason?: string) => {
        cancelled = true
        for (const handle of handles) handle.cancel(reason)
        void cancelled
      },
    }
    return group
  }

  /** Synchronous access to the cache (undefined — not loaded). */
  get<T = unknown>(url: string): T | undefined {
    return this.cache.get(url)?.asset as T | undefined
  }

  /** Handle of an active job (undefined — none). */
  getHandle<T = unknown>(url: string): AssetHandle<T> | undefined {
    return this.jobs.get(url)?.handle as AssetHandle<T> | undefined
  }

  stats(): LibraryStats {
    let cacheBytes = 0
    for (const entry of this.cache.values()) cacheBytes += entry.bytes
    const s = this.scheduler.stats()
    return {
      cached: this.cache.size,
      cacheBytes,
      running: s.running,
      queued: s.queued,
      bytesInFlight: s.bytesInFlight,
      downloads: this.downloads,
      downloadBytes: this.downloadBytes,
      cacheHits: this.cacheHits,
    }
  }

  /** Evict an asset from the cache. */
  dispose(url: string): boolean {
    return this.cache.delete(url)
  }

  /** Clear the cache completely. */
  clear(): void {
    this.cache.clear()
  }

  /** Subscribe to events. */
  on(type: LibraryEvent['type'], listener: (event: LibraryEvent) => void): () => void {
    let set = this.listeners.get(type)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
    return () => set.delete(listener)
  }

  /** Custom format (overrides the built-ins by extensions). */
  registerFormat(id: string, extensions: readonly string[], parse: ParserFn): void {
    this.formats.unshift({ id, extensions, parse })
  }

  /** Config parser registry (json/zml/...). */
  get configParsers(): { register: typeof registerConfigParser; of: (ext: string) => ConfigParser | undefined } {
    return { register: registerConfigParser, of: ext => configParserOf(ext) }
  }

  // ─── Internals ─────────────────────────────────────────────────────

  private async resolveParser(url: string, options: LoadOptions, assembler: StreamAssembler): Promise<ParserFn> {
    if (options.parser !== undefined) {
      const byId = this.formats.find(format => format.id === options.parser)
      if (byId !== undefined) return byId.parse
      throw new Error(`parser "${options.parser}" is not registered`)
    }
    const extension = extensionOf(url)
    if (extension !== '') {
      const byExtension = this.formats.find(format => format.extensions.includes(extension))
      if (byExtension !== undefined) return byExtension.parse
    }
    // Magic sniffing: glb/fbx.
    await assembler.waitFor(24)
    const head = assembler.slice(0, Math.min(24, assembler.watermark))
    if (looksLikeGlb(head)) return this.formats.find(f => f.id === 'glb')!.parse
    if (looksLikeFbxBinary(head)) return this.formats.find(f => f.id === 'fbx')!.parse
    return this.formats.find(f => f.id === 'bytes')!.parse
  }

  private emit(event: LibraryEvent): void {
    const set = this.listeners.get(event.type)
    if (set === undefined) return
    for (const listener of [...set]) {
      try {
        listener(event)
      } catch {
        // a listener must not break the library
      }
    }
  }

  private evictIfNeeded(): void {
    if (this.cacheBytesLimit <= 0) return
    let total = 0
    for (const entry of this.cache.values()) total += entry.bytes
    while (total > this.cacheBytesLimit) {
      let victim: { key: string; entry: CacheEntry } | undefined
      for (const [key, entry] of this.cache) {
        if (this.jobs.has(key)) continue // an active job — do not touch
        if (victim === undefined || entry.lastAccess < victim.entry.lastAccess) victim = { key, entry }
      }
      if (victim === undefined) break
      this.cache.delete(victim.key)
      total -= victim.entry.bytes
      this.emit({ type: 'evicted', url: victim.key, bytes: victim.entry.bytes })
    }
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────

function resolveUrl(baseUrl: string, uri: string): string {
  if (/^https?:\/\//i.test(uri) || uri.startsWith('data:')) return uri
  try {
    return new URL(uri, baseUrl).toString()
  } catch {
    const slash = baseUrl.lastIndexOf('/')
    return slash >= 0 ? `${baseUrl.slice(0, slash + 1)}${uri}` : uri
  }
}

function aggregateRatio(phase: AssetPhase, phaseRatio: number, loaded: number, total: number): number {
  switch (phase) {
    case 'queued':
      return 0
    case 'fetching':
      return PHASE_WEIGHTS.fetch * (total > 0 ? Math.min(1, loaded / total) : asymptotic(loaded))
    case 'parsing':
      return PHASE_WEIGHTS.fetch + PHASE_WEIGHTS.parse * phaseRatio
    case 'transforming':
      return PHASE_WEIGHTS.fetch + PHASE_WEIGHTS.parse + PHASE_WEIGHTS.transform * phaseRatio
    case 'done':
      return 1
    case 'error':
    case 'cancelled':
      return 0
  }
}

/** Asymptotics for an unknown length (≈90% at 8 MB). */
function asymptotic(loaded: number): number {
  return Math.min(0.95, 1 - Math.exp(-loaded / (8 * 1024 * 1024)))
}

function cancelError(reason?: unknown): unknown {
  if (reason instanceof Error) return reason
  const message = typeof reason === 'string' ? reason : 'loading cancelled'
  return new DOMException(message, 'AbortError')
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  )
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

function fmtMs(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`
}
