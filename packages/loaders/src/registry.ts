/**
 * Format registry + AssetLoader — the loading facade for all assets.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CONTRACT:
 *
 *   const loader = new AssetLoader({ scheduler, fetchImpl, ... })
 *   const handle = loader.load('model.glb', { onProgress, priority })
 *   const model: GltfModel = await handle        // handle — thenable
 *   handle.cancel('not needed')
 *
 *   • The format is chosen automatically: extension → magic bytes
 *     (glTF/FBX → 'glb'/'fbx', everything else → 'bytes').
 *   • Progress is honest, phased: queued → fetching (0.7) →
 *     parsing (0.2) → transforming (0.1) → done. Byte progress is
 *     from streaming, phase progress from parsers (onPhase).
 *   • Deduplication by URL: parallel load() calls of the same URL get
 *     ONE handle (jobs-Map). LRU cache with a byte budget (256 MB
 *     by default), eviction does NOT touch active jobs.
 *   • Group: loadGroup([...]) — aggregated progress/cancellation.
 *   • Custom formats: registerFormat(id, extensions, parse) —
 *     take precedence over the built-ins (unshift).
 *
 * COMPOSITION of built-in formats: glb, gltf (.gltf + external buffers),
 * obj, mtl, fbx (skeletal animation — parseFBX), image (MIME by
 * magic bytes), config (json/zml/ini/txt + registered ones),
 * bytes (bin/ktx2 — raw bytes).
 *
 * The loader knows nothing about the GPU: assets are decoded data.
 */

import { asciiDecode, nowMs } from './bytes.ts'
import {
  type Assembler,
  FetchScheduler,
  allocJobId,
  fetchStreaming,
  isAbortError,
  toAbortError,
  type SchedulerJob,
} from './assembler.ts'
import { isGltfJson, parseGlb, parseGltfJson, type CreateBitmap, type DracoDecoder, type GltfPhase } from './gltf.ts'
import { parseObj } from './obj.ts'
import { parseMtl } from './mtl.ts'
import { parseImage } from './image.ts'
import { parseConfig, registerConfigParser, configParserOf, type ConfigParser } from './config.ts'
import { parseFBX } from './fbx.ts'

// ─── Types ────────────────────────────────────────────────────────────────────

/** Load lifecycle phase. */
export type LoadPhase = 'queued' | 'fetching' | 'parsing' | 'transforming' | 'done' | 'error' | 'cancelled'

export type OnAssetPhase = (phase: GltfPhase) => void

/** Progress snapshot (immutable, goes to onProgress and events). */
export interface LoadProgress {
  readonly phase: LoadPhase
  readonly loaded: number
  readonly total: number
  /** Progress within the current phase (0..1). */
  readonly phaseRatio: number
  /** Overall progress with phase weights (0..1). */
  readonly ratio: number
  readonly url: string
  readonly cached: boolean
  readonly detail: string
}

/** Context passed to a format parser. */
export interface ParserContext {
  readonly url: string
  readonly assembler: Assembler
  /** Composite signal: job cancellation + external. */
  readonly signal: AbortSignal
  readonly onPhase: OnAssetPhase
  /** Resolve a relative URI → bytes (external .gltf buffers). */
  readonly loadExternal: (uri: string) => Promise<Uint8Array>
  readonly createBitmap?: CreateBitmap
  readonly dracoDecoder?: DracoDecoder
}

/** Format description in the registry. */
export interface FormatDescriptor {
  readonly id: string
  readonly extensions: readonly string[]
  readonly parse: (ctx: ParserContext) => Promise<unknown>
}

/** Asset post-processing (conversions, cache assembly, LOD stripping). */
export type TransformHook = (
  asset: unknown,
  meta: { url: string; bytes: number; fetchedMs: number; parsedMs: number },
) => unknown | Promise<unknown>

/** Single load options. */
export interface LoadOptions {
  /** Priority in the scheduler (lower = earlier). Default 5. */
  readonly priority?: number
  /** Initial byte weight for the scheduler budget. Default 8 MB. */
  readonly weightBytes?: number
  readonly signal?: AbortSignal
  readonly connectTimeoutMs?: number
  readonly retries?: number
  /** Force a parser by id (bypassing extension/magic bytes). */
  readonly parser?: string
  /** Do not put the result into the cache. */
  readonly noCache?: boolean
  readonly transform?: readonly TransformHook[]
  readonly onProgress?: (progress: LoadProgress) => void
}

/** AssetLoader constructor options. */
export interface AssetLoaderOptions {
  readonly scheduler?: FetchScheduler
  readonly fetchImpl?: typeof fetch
  /** Byte cache budget; ≤0 — unlimited cache. Default 256 MB. */
  readonly cacheBytesLimit?: number
  readonly createBitmap?: CreateBitmap
  readonly dracoDecoder?: DracoDecoder
  /** Defaults applied to every load. */
  readonly defaults?: LoadOptions
}

/** Loader events (on('progress'|'done'|'error'|'cancelled'|'evicted')). */
export type LoaderEvent =
  | { type: 'progress'; handle: LoadHandle }
  | { type: 'done'; handle: LoadHandle }
  | { type: 'error'; handle: LoadHandle; error: unknown }
  | { type: 'cancelled'; handle: LoadHandle }
  | { type: 'evicted'; url: string; bytes: number }

/** Aggregated loader statistics. */
export interface LoaderStats {
  readonly cached: number
  readonly cacheBytes: number
  readonly running: number
  readonly queued: number
  readonly bytesInFlight: number
  readonly downloads: number
  readonly downloadBytes: number
  readonly cacheHits: number
}

/** loadGroup result: aggregated progress + shared cancellation. */
export interface LoadGroup {
  readonly urls: readonly string[]
  readonly promise: Promise<unknown[]>
  readonly progress: LoadProgress
  cancel(reason?: string): void
}

// ─── Weights of phases in overall progress ───────────────────────────────────────────────

/** Phase contribution to ratio: download 70%, parse 20%, transform 10%. */
export const PHASE_WEIGHTS = { fetch: 0.7, parse: 0.2, transform: 0.1 } as const

// ─── LoadHandle ──────────────────────────────────────────────────────────────

/**
 * Load handle: thenable (await gives the asset) + control
 * (cancel/setPriority) + progress snapshot (handle.progress).
 */
export class LoadHandle {
  private promise: Promise<unknown>
  private snapshot: LoadProgress
  private settled = false
  private readonly cancelImpl: (reason?: string) => boolean
  private readonly priorityImpl: (priority: number) => boolean

  constructor(
    readonly url: string,
    readonly key: string,
    promise: Promise<unknown>,
    snapshot: LoadProgress,
    cancelImpl: (reason?: string) => boolean,
    priorityImpl: (priority: number) => boolean,
  ) {
    this.promise = promise
    this.snapshot = snapshot
    this.cancelImpl = cancelImpl
    this.priorityImpl = priorityImpl
  }

  get progress(): LoadProgress {
    return this.snapshot
  }

  get state(): LoadPhase {
    return this.snapshot.phase
  }

  get isSettled(): boolean {
    return this.settled
  }

  markSettled(): void {
    this.settled = true
  }

  update(snapshot: LoadProgress): void {
    this.snapshot = snapshot
  }

  cancel(reason?: string): boolean {
    return this.cancelImpl(reason)
  }

  setPriority(priority: number): boolean {
    return this.priorityImpl(priority)
  }

  then<T, R>(onFulfilled?: (asset: unknown) => T, onRejected?: (reason: unknown) => R): Promise<T | R> {
    return this.promise.then(onFulfilled, onRejected)
  }

  catch<R>(onRejected?: (reason: unknown) => R): Promise<unknown | R> {
    return this.promise.then(undefined, onRejected)
  }
}

// ─── Built-in formats ──────────────────────────────────────────────────────

/** Magic of binary FBX: "Kaydara FBX Binary  \x1a\x00". */
export function isBinaryFbx(bytes: Uint8Array): boolean {
  return bytes.length >= 23 && asciiDecode(bytes, 0, 20) === 'Kaydara FBX Binary  '
}

/** Default format registry (order = selection priority by extension). */
export function defaultFormats(): FormatDescriptor[] {
  return [
    {
      id: 'glb',
      extensions: ['glb'],
      parse: (ctx) => parseGlb(ctx.assembler, gltfOptionsFrom(ctx)),
    },
    {
      id: 'gltf',
      extensions: ['gltf'],
      parse: async (ctx) => {
        await ctx.assembler.completion
        const text = new TextDecoder('utf-8').decode(ctx.assembler.fullView())
        return parseGltfJson(text, { loadExternal: ctx.loadExternal }, gltfOptionsFrom(ctx))
      },
    },
    { id: 'obj', extensions: ['obj'], parse: (ctx) => parseObj(ctx.assembler, { onPhase: ctx.onPhase }) },
    {
      id: 'mtl',
      extensions: ['mtl'],
      parse: async (ctx) => {
        await ctx.assembler.completion
        return parseMtl(ctx.assembler.fullView())
      },
    },
    {
      id: 'fbx',
      extensions: ['fbx'],
      parse: async (ctx) => {
        await ctx.assembler.completion
        const bytes = ctx.assembler.fullView()
        // fullView — a view over the assembly buffer; parseFBX needs an exact ArrayBuffer
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
        return parseFBX(buffer)
      },
    },
    {
      id: 'image',
      extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'ico'],
      parse: (ctx) =>
        parseImage(ctx.assembler, {
          signal: ctx.signal,
          onPhase: ctx.onPhase,
          createBitmap: ctx.createBitmap,
        }),
    },
    {
      id: 'config',
      extensions: ['json', 'zml', 'ini', 'txt', 'yaml', 'yml', 'toml'],
      parse: (ctx) => parseConfig(ctx.assembler, extensionOf(ctx.url), { onPhase: ctx.onPhase }),
    },
    {
      id: 'bytes',
      extensions: ['bin', 'ktx2'],
      parse: async (ctx) => {
        await ctx.assembler.completion
        return ctx.assembler.fullView()
      },
    },
  ]
}

function gltfOptionsFrom(ctx: ParserContext): {
  signal: AbortSignal
  onPhase: OnAssetPhase
  createBitmap?: CreateBitmap
  dracoDecoder?: DracoDecoder
} {
  return {
    signal: ctx.signal,
    onPhase: ctx.onPhase,
    createBitmap: ctx.createBitmap,
    dracoDecoder: ctx.dracoDecoder,
  }
}

// ─── AssetLoader ─────────────────────────────────────────────────────────────

interface CacheEntry {
  readonly asset: unknown
  readonly bytes: number
  lastAccess: number
}

interface JobEntry {
  readonly handle: LoadHandle
  readonly schedulerJob: SchedulerJob
}

/**
 * Loading facade: scheduler + streaming + format registry + LRU cache
 * + events. One AssetLoader per application; the class has no global
 * state — instantiate as many as you need (e.g., an isolated one
 * for a worker).
 */
export class AssetLoader {
  private scheduler: FetchScheduler
  private fetchImpl: typeof fetch
  private cacheBytesLimit: number
  private createBitmap?: CreateBitmap
  private dracoDecoder?: DracoDecoder
  private defaults: LoadOptions
  private formats: FormatDescriptor[] = defaultFormats()
  private jobs = new Map<string, JobEntry>()
  private cache = new Map<string, CacheEntry>()
  private listeners = new Map<string, Array<(event: LoaderEvent) => void>>()
  private downloads = 0
  private downloadBytes = 0
  private cacheHits = 0

  constructor(options: AssetLoaderOptions = {}) {
    this.scheduler = options.scheduler ?? new FetchScheduler()
    this.fetchImpl = options.fetchImpl ?? fetch
    this.cacheBytesLimit = options.cacheBytesLimit ?? 268435456
    this.createBitmap = options.createBitmap
    this.dracoDecoder = options.dracoDecoder
    this.defaults = options.defaults ?? {}
  }

  /** Load an asset; repeated calls of the same URL — the same handle. */
  load(url: string, options: LoadOptions = {}): LoadHandle {
    const opts: LoadOptions = { ...this.defaults, ...options }
    const key = url

    // Cache: a ready asset is returned instantly by a "completed" handle
    const cached = this.cache.get(key)
    if (cached !== undefined) {
      cached.lastAccess = nowMs()
      this.cacheHits++
      const handle = new LoadHandle(
        url,
        key,
        Promise.resolve(cached.asset),
        {
          phase: 'done',
          loaded: cached.bytes,
          total: cached.bytes,
          phaseRatio: 1,
          ratio: 1,
          url,
          cached: true,
          detail: 'from cache',
        },
        () => false,
        () => false,
      )
      handle.markSettled()
      opts.onProgress?.(handle.progress)
      this.emit({ type: 'done', handle })
      return handle
    }

    // Deduplication: an active job is already downloading
    const active = this.jobs.get(key)
    if (active !== undefined) return active.handle

    let weight = opts.weightBytes ?? 8388608
    let phase: LoadPhase = 'queued'
    let loaded = 0
    let total = 0
    let phaseRatio = 0
    let detail = 'queued'
    let resolveAsset!: (asset: unknown) => void
    let rejectAsset!: (reason: unknown) => void
    const assetPromise = new Promise<unknown>((resolve, reject) => {
      resolveAsset = resolve
      rejectAsset = reject
    })

    const snapshot = (): LoadProgress => ({
      phase,
      loaded,
      total,
      phaseRatio,
      ratio: overallRatio(phase, phaseRatio, loaded, total),
      url,
      cached: false,
      detail,
    })
    const forgetJob = (): void => {
      this.jobs.delete(key)
    }

    const job: SchedulerJob = {
      id: allocJobId(),
      priority: opts.priority ?? 5,
      seq: allocJobId(),
      weight: () => weight,
      onCancelledBeforeStart: (reason) => {
        phase = 'cancelled'
        const snap = snapshot()
        handle.update(snap)
        opts.onProgress?.(snap)
        forgetJob()
        handle.markSettled()
        rejectAsset(toAbortError(reason))
        this.emit({ type: 'cancelled', handle })
      },
      start: async (schedulerSignal) => {
        const startedAt = nowMs()
        phase = 'fetching'
        reportProgress('connecting')
        const controller = new AbortController()
        const external = opts.signal
        if (external?.aborted) throw toAbortError(external.reason)
        external?.addEventListener('abort', () => controller.abort(toAbortError(external.reason)), {
          once: true,
        })
        schedulerSignal.addEventListener('abort', () => controller.abort(toAbortError(schedulerSignal.reason)), {
          once: true,
        })
        const fetchOptions = {
          signal: controller.signal,
          connectTimeoutMs: opts.connectTimeoutMs,
          retries: opts.retries,
          fetchImpl: this.fetchImpl,
          onBytes: (received: number, declared: number) => {
            loaded = received
            if (declared > 0 && received <= declared && declared !== total) {
              // Content-Length became known: refine the job weight
              total = declared
              weight = declared
              this.scheduler.updateWeight(job)
            } else if (total > 0 && received > total) {
              // The server overstated it — reset the total
              total = 0
            }
            phaseRatio = total > 0 ? loaded / total : unknownTotalRatio(loaded)
            reportProgress(
              `${formatBytes(loaded)}${total > 0 ? ` / ${formatBytes(total)}` : ''}`,
            )
          },
        }
        try {
          const response = await fetchStreaming(url, fetchOptions)
          if (response.contentLength !== undefined && response.contentLength > 0) {
            total = response.contentLength
            weight = response.contentLength
            this.scheduler.updateWeight(job)
          }
          this.downloads++
          const parse = await this.resolveParser(url, opts, response.assembler)
          phase = 'parsing'
          phaseRatio = 0
          reportProgress('parsing')
          const parseStartedAt = nowMs()
          const asset = await parse({
            url,
            assembler: response.assembler,
            signal: controller.signal,
            onPhase: (event) => {
              phaseRatio = event.ratio
              reportProgress(`${event.stage}: ${event.detail}`)
            },
            loadExternal: async (uri) => {
              const resolved = resolveUrl(url, uri)
              const externalResponse = await fetchStreaming(resolved, fetchOptions)
              await externalResponse.done
              return externalResponse.assembler.fullView()
            },
            createBitmap: this.createBitmap,
            dracoDecoder: this.dracoDecoder,
          })
          const parsedMs = nowMs() - parseStartedAt
          const transforms = opts.transform ?? []
          let result = asset
          if (transforms.length > 0) {
            phase = 'transforming'
            for (let i = 0; i < transforms.length; i++) {
              phaseRatio = i / transforms.length
              reportProgress(`transform ${i + 1}/${transforms.length}`)
              const meta = { url, bytes: loaded, fetchedMs: parseStartedAt - startedAt, parsedMs }
              result = await transforms[i](result, meta)
            }
          }
          if (!opts.noCache) {
            this.cache.set(key, { asset: result, bytes: Math.max(loaded, total, 1), lastAccess: nowMs() })
            this.evictIfNeeded()
          }
          this.downloadBytes += loaded
          phase = 'done'
          phaseRatio = 1
          reportProgress(`done in ${formatDuration(nowMs() - startedAt)}`)
          forgetJob()
          resolveAsset(result)
          handle.markSettled()
          this.emit({ type: 'done', handle })
        } catch (error) {
          const cancelled = isAbortError(error)
          phase = cancelled ? 'cancelled' : 'error'
          const snap = snapshot()
          handle.update(snap)
          opts.onProgress?.(snap)
          forgetJob()
          handle.markSettled()
          rejectAsset(error)
          if (cancelled) this.emit({ type: 'cancelled', handle })
          else this.emit({ type: 'error', handle, error })
        }
      },
    }

    const handle = new LoadHandle(
      url,
      key,
      assetPromise,
      {
        phase: 'queued',
        loaded: 0,
        total: 0,
        phaseRatio: 0,
        ratio: 0,
        url,
        cached: false,
        detail: 'queued',
      },
      (reason) => {
        if (handle.isSettled) return false
        return this.scheduler.cancel(job, reason)
      },
      (priority) => {
        if (handle.isSettled) return false
        return this.scheduler.setPriority(job, priority)
      },
    )

    const reportProgress = (text?: string): void => {
      if (text !== undefined) detail = text
      const snap = snapshot()
      handle.update(snap)
      opts.onProgress?.(snap)
      this.emit({ type: 'progress', handle })
    }

    this.jobs.set(key, { handle, schedulerJob: job })
    this.scheduler.submit(job)
    return handle
  }

  /** Bulk preload: errors do not fail the batch, they are collected. */
  async preload(urls: readonly string[], options: LoadOptions = {}): Promise<{ ok: string[]; failed: Array<{ url: string; error: unknown }> }> {
    const ok: string[] = []
    const failed: Array<{ url: string; error: unknown }> = []
    await Promise.all(
      urls.map(async (url) => {
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

  /** Group of loads: aggregated progress + shared cancellation. */
  loadGroup(entries: ReadonlyArray<{ url: string; options?: LoadOptions }>): LoadGroup {
    const handles: LoadHandle[] = entries.map((entry) => this.load(entry.url, entry.options ?? {}))
    const promise = Promise.all(handles.map((handle) => handle.then((asset) => asset)))
    return {
      urls: entries.map((entry) => entry.url),
      promise,
      get progress(): LoadProgress {
        let weightSum = 0
        let ratioWeighted = 0
        let loadedSum = 0
        let totalSum = 0
        let doneCount = 0
        let worstPhase: LoadPhase = 'queued'
        let worstRank = 0
        const ranks: Record<LoadPhase, number> = {
          queued: 1,
          fetching: 2,
          parsing: 3,
          transforming: 4,
          done: 5,
          error: 5,
          cancelled: 5,
        }
        for (const handle of handles) {
          const progress = handle.progress
          const weight = Math.max(progress.total, progress.loaded, 1)
          weightSum += weight
          ratioWeighted += weight * progress.ratio
          loadedSum += progress.loaded
          totalSum += progress.total
          if (progress.phase === 'done') doneCount++
          if (ranks[progress.phase] > worstRank) {
            worstRank = ranks[progress.phase]
            worstPhase = progress.phase
          }
        }
        const groupRatio = weightSum > 0 ? ratioWeighted / weightSum : 0
        const text =
          `${doneCount}/${handles.length} done · ` +
          (worstPhase === 'fetching'
            ? `${formatBytes(loadedSum)}${totalSum > 0 ? ` / ${formatBytes(totalSum)}` : ''}`
            : worstPhase)
        return {
          phase: worstPhase,
          loaded: loadedSum,
          total: totalSum,
          phaseRatio: groupRatio,
          ratio: groupRatio,
          url: entries.length === 1 ? entries[0].url : `${handles.length} assets`,
          cached: false,
          detail: text,
        }
      },
      cancel: (reason?: string) => {
        for (const handle of handles) handle.cancel(reason)
      },
    }
  }

  /** Asset from the cache (undefined — not loaded). */
  get(url: string): unknown {
    return this.cache.get(url)?.asset
  }

  /** Handle of an active job by URL (undefined — job finished/absent). */
  getHandle(url: string): LoadHandle | undefined {
    return this.jobs.get(url)?.handle
  }

  stats(): LoaderStats {
    let cacheBytes = 0
    for (const entry of this.cache.values()) cacheBytes += entry.bytes
    const schedulerStats = this.scheduler.stats()
    return {
      cached: this.cache.size,
      cacheBytes,
      running: schedulerStats.running,
      queued: schedulerStats.queued,
      bytesInFlight: schedulerStats.bytesInFlight,
      downloads: this.downloads,
      downloadBytes: this.downloadBytes,
      cacheHits: this.cacheHits,
    }
  }

  /** Evict one URL from the cache. */
  dispose(url: string): boolean {
    return this.cache.delete(url)
  }

  clear(): void {
    this.cache.clear()
  }

  /** Subscribe to events; the returned function unsubscribes. */
  on<T extends LoaderEvent['type']>(type: T, listener: (event: Extract<LoaderEvent, { type: T }>) => void): () => void {
    let list = this.listeners.get(type)
    if (list === undefined) {
      list = []
      this.listeners.set(type, list)
    }
    list.push(listener as (event: LoaderEvent) => void)
    return () => {
      const current = this.listeners.get(type)
      if (current === undefined) return
      const index = current.indexOf(listener as (event: LoaderEvent) => void)
      if (index >= 0) current.splice(index, 1)
    }
  }

  /** Custom format — takes precedence over the built-ins. */
  registerFormat(id: string, extensions: readonly string[], parse: (ctx: ParserContext) => Promise<unknown>): void {
    this.formats.unshift({ id, extensions, parse })
  }

  /** Access to the config parser registry (registerConfigParser/configParserOf). */
  get configParsers(): {
    register: (extension: string, parser: ConfigParser) => void
    of: (extension: string) => ConfigParser | undefined
  } {
    return {
      register: registerConfigParser,
      of: configParserOf,
    }
  }

  /** Parser selection: explicit id → extension → magic bytes (glb/fbx/bytes). */
  async resolveParser(url: string, options: LoadOptions, assembler: Assembler): Promise<(ctx: ParserContext) => Promise<unknown>> {
    if (options.parser !== undefined) {
      const format = this.formats.find((f) => f.id === options.parser)
      if (format !== undefined) return format.parse
      throw new Error(`parser "${options.parser}" is not registered`)
    }
    const extension = extensionOf(url)
    if (extension !== '') {
      const format = this.formats.find((f) => f.extensions.includes(extension))
      if (format !== undefined) return format.parse
    }
    await assembler.waitFor(24)
    const prefix = assembler.slice(0, Math.min(24, assembler.watermark))
    if (isGltfJson(prefix)) return this.formats.find((f) => f.id === 'glb')!.parse
    if (isBinaryFbx(prefix)) return this.formats.find((f) => f.id === 'fbx')!.parse
    return this.formats.find((f) => f.id === 'bytes')!.parse
  }

  private emit(event: LoaderEvent): void {
    const list = this.listeners.get(event.type)
    if (list === undefined) return
    for (const listener of [...list])
      try {
        listener(event)
      } catch {
        // A listener must not break the load
      }
  }

  private evictIfNeeded(): void {
    if (this.cacheBytesLimit <= 0) return
    let bytes = 0
    for (const entry of this.cache.values()) bytes += entry.bytes
    while (bytes > this.cacheBytesLimit) {
      let victim: { key: string; entry: CacheEntry } | undefined
      for (const [key, entry] of this.cache) {
        // Active jobs are not evicted — their assets are still needed
        if (this.jobs.has(key)) continue
        if (victim === undefined || entry.lastAccess < victim.entry.lastAccess) victim = { key, entry }
      }
      if (victim === undefined) break
      this.cache.delete(victim.key)
      bytes -= victim.entry.bytes
      this.emit({ type: 'evicted', url: victim.key, bytes: victim.entry.bytes })
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** URL extension (no query/hash, lower-case; '' — none). */
export function extensionOf(url: string): string {
  const path = url.split('?')[0]?.split('#')[0] ?? ''
  const lastSlash = path.lastIndexOf('/')
  const lastDot = path.lastIndexOf('.')
  if (lastDot <= lastSlash) return ''
  return path.slice(lastDot + 1).toLowerCase()
}

/** Overall ratio by phases and weights. */
function overallRatio(phase: LoadPhase, phaseRatio: number, loaded: number, total: number): number {
  switch (phase) {
    case 'queued':
      return 0
    case 'fetching':
      return PHASE_WEIGHTS.fetch * (total > 0 ? Math.min(1, loaded / total) : unknownTotalRatio(loaded))
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

/** Uptime without total: saturation 1-e^(-bytes/8MB) (cap 95%). */
function unknownTotalRatio(bytes: number): number {
  return Math.min(0.95, 1 - Math.exp(-bytes / 8388608))
}

/** Resolve a relative URI against a base URL. */
export function resolveUrl(baseUrl: string, uri: string): string {
  if (/^https?:\/\//i.test(uri) || uri.startsWith('data:')) return uri
  try {
    return new URL(uri, baseUrl).toString()
  } catch {
    const lastSlash = baseUrl.lastIndexOf('/')
    return lastSlash >= 0 ? `${baseUrl.slice(0, lastSlash + 1)}${uri}` : uri
  }
}

/** «1.2 MB» / «345 KB» / «900 B». */
function formatBytes(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

/** "1.2 s" / "890 ms". */
function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`
}

// ─── Bridge to the Task 88 layer (core/ + formats/) ─────────────────────────────────
// Restoration: the manager (core/manager.ts) expects a parser registry
// factory and a sniffer from the root registry.ts. The parsers themselves live in formats/ and
// implement the Parser interface from core/types.ts.

export { sniffKind } from './core/util.ts'
export type { SniffResult } from './core/util.ts'

import type { Parser, ImageDecode, UrlResolver } from './core/types.ts'
import { gltfParser } from './formats/gltf.ts'
import { objParser } from './formats/obj.ts'
import { fbxParser } from './formats/fbx.ts'
import { hdrParser, createImageParser } from './formats/image.ts'
import { bytesParser, textParser, jsonParser, zmlParser } from './formats/config.ts'
import type { MtlModel } from './mtl.ts'

/** Parser registry factory options (core/manager.ts contract). */
export interface ParserRegistryOptions {
  readonly fetchImpl?: typeof fetch
  readonly resolveUrl?: UrlResolver
  /** zlib-inflate for FBX; null forbids it (the contract is passed to the parser via ctx). */
  readonly inflate?: ((bytes: Uint8Array) => Promise<Uint8Array>) | null
  /** Image decoder; null → the image parser throws UnsupportedError. */
  readonly decodeImage?: ImageDecode | null
}

/** MTL parser on top of the root parseMtl (MtlModel). */
const mtlParserAdapter: Parser<MtlModel> = {
  kind: 'mtl',
  extensions: ['.mtl'],
  parse(input: { bytes: Uint8Array }): MtlModel {
    return parseMtl(input.bytes)
  },
}

/**
 * Default parser registry for LoadManager (Task 88): kinds → parsers.
 * The manager itself maps 'glb' to 'gltf' when sniffing.
 */
export function createParserRegistry(
  options: ParserRegistryOptions = {},
): Map<string, Parser<any, any>> {
  const decodeImage: ImageDecode | null =
    options.decodeImage !== undefined
      ? options.decodeImage
      : typeof createImageBitmap === 'function'
        ? (createImageBitmap as unknown as ImageDecode)
        : null
  const map = new Map<string, Parser<any, any>>()
  map.set('gltf', gltfParser)
  map.set('obj', objParser)
  map.set('fbx', fbxParser)
  map.set('mtl', mtlParserAdapter)
  map.set('image', createImageParser({ decodeImage }))
  map.set('hdr', hdrParser)
  map.set('json', jsonParser)
  map.set('zml', zmlParser)
  map.set('text', textParser)
  map.set('bytes', bytesParser)
  return map
}
