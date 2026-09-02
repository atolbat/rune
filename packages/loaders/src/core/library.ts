/**
 * core/library.ts — AssetLibrary: a named asset library on top of
 * LoadManager — preloading, refcount, TTL, byte budget (LRU).
 *
 * Scenario:
 *   const lib = createAssetLibrary({ manager, maxBytes: 256 << 20 })
 *   lib.define([{ id: 'hero', url: 'hero.glb', kind: 'gltf' },
 *               { id: 'env', url: 'quarry.hdr', kind: 'hdr', tags: ['env'] }])
 *   lib.preload(['hero'])                  // at prefetch priority, in the background
 *   const h = lib.acquire<MeshDocument>('hero'); const doc = await h.ready
 *   ... h.release()                        // refcount 0 → TTL candidate
 *   lib.preload(e => e.tags?.includes('env')) // "next level" preload
 *
 * Budget: asset bytes are counted by estimateBytes (a heuristic by data
 * type); when maxBytes is exceeded, LRU entries with refcount=0 are evicted.
 * TTL (the lifetime of a zero refcount) protects against "load-evict" thrashing.
 *
 * GPU residency is NOT here: @rune/kit AssetCache does the same for textures
 * per frame; the library is about network/parsing. The bridge: acquire →
 * upload → kit cache, release when leaving the scene.
 */

import type { LoadHandle, LoadOptions, Parser } from './types.ts'
import type { LoadManager } from './manager.ts'
import { createLoadManager } from './manager.ts'
import { Priority } from './types.ts'
import { LoadError } from './errors.ts'

// ─── types ────────────────────────────────────────────────────────────────────

/** Asset description in a library/manifest. */
export interface AssetEntrySpec {
  /** Unique id for acquire/preload. */
  readonly id: string
  /** Source URL (or data:). */
  readonly url: string
  /** Format from the manager's registry; sniffing if not specified. */
  readonly kind?: string
  /** Priority for acquire (default normal). Preload is always prefetch. */
  readonly priority?: number
  /** Tags for preload filters ("next-level", "env", ...). */
  readonly tags?: readonly string[]
  /** Parser options (image resize etc.). */
  readonly parserOptions?: unknown
  /** Parser handle directly (overrides kind). */
  readonly parser?: Parser<any, any>
  /** Preload immediately after define. */
  readonly preload?: boolean
}

export interface AssetManifest {
  readonly assets: readonly AssetEntrySpec[]
}

export interface LibraryHandle<T = unknown> {
  readonly id: string
  readonly ready: Promise<T>
  /** undefined until loaded. */
  readonly value: T | undefined
  /** Decrements the refcount; idempotent. */
  release(): void
}

export interface LibraryStats {
  readonly entries: number
  readonly resident: number
  readonly inflight: number
  readonly failed: number
  readonly bytes: number
}

export interface AssetLibraryOptions {
  /** Manager; a private one is created (default fetch) if not passed. */
  manager?: LoadManager
  /** Byte budget (default ∞). */
  maxBytes?: number
  /** Lifetime of a zero refcount, ms (default 30_000). */
  ttlMs?: number
  now?: () => number
  /** Asset weight estimate in bytes (default heuristic). */
  estimateBytes?: (asset: unknown) => number
  /** Disposer (e.g. bitmap.close()). */
  disposeAsset?: (asset: unknown) => void
}

export interface PreloadOptions {
  /** Preload priority (default Priority.prefetch). */
  priority?: number
  /** Progress/signal/meta — into the manager's LoadOptions. */
  onProgress?: LoadOptions['onProgress']
  signal?: LoadOptions['signal']
}

export interface AssetLibrary {
  /** Register/update asset descriptions. */
  define(entries: AssetEntrySpec | readonly AssetEntrySpec[]): void
  /** Background preload: loads at prefetch priority, refcount stays 0. */
  preload(
    filter: string | readonly string[] | ((spec: AssetEntrySpec) => boolean),
    options?: PreloadOptions,
  ): readonly LoadHandle<unknown>[]
  /** Take an asset: resident → immediately, otherwise load via the manager. */
  acquire<T = unknown>(id: string, options?: { priority?: number }): LibraryHandle<T>
  /** The value if resident (does not load). */
  peek(id: string): unknown | undefined
  /** The last load error, if any. */
  errorOf(id: string): unknown | undefined
  /** Evict an entry (idempotent). */
  evict(id?: string): boolean
  /** State snapshot. */
  stats(): LibraryStats
  /** Unload everything and close. */
  dispose(): void
  readonly manager: LoadManager
}

// ─── implementation ──────────────────────────────────────────────────────────────

interface Entry {
  spec: AssetEntrySpec
  value: unknown
  error: unknown
  hasError: boolean
  inflight: LoadHandle<unknown> | null
  refcount: number
  lastTouched: number
  bytes: number
}

export function createAssetLibrary(options: AssetLibraryOptions = {}): AssetLibrary {
  const manager = options.manager ?? createLoadManager()
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY
  const ttlMs = options.ttlMs ?? 30_000
  const now = options.now ?? (() => Date.now())
  const estimate = options.estimateBytes ?? defaultEstimateBytes
  const disposeAsset = options.disposeAsset

  const entries = new Map<string, Entry>()

  function define(input: AssetEntrySpec | readonly AssetEntrySpec[]): void {
    const list = Array.isArray(input) ? input : [input]
    for (const spec of list) {
      if (typeof spec.id !== 'string' || spec.id.length === 0) {
        throw new LoadError('source', 'define: id is required')
      }
      entries.set(spec.id, {
        spec,
        value: undefined,
        error: undefined,
        hasError: false,
        inflight: null,
        refcount: 0,
        lastTouched: now(),
        bytes: 0,
      })
    }
    // auto-preload
    for (const spec of list) {
      if (spec.preload === true) preload([spec.id])
    }
  }

  function matches(
    filter: string | readonly string[] | ((spec: AssetEntrySpec) => boolean),
    spec: AssetEntrySpec,
  ): boolean {
    if (typeof filter === 'string') return spec.id === filter
    if (typeof filter === 'function') return filter(spec)
    return filter.includes(spec.id)
  }

  function preload(
    filter: string | readonly string[] | ((spec: AssetEntrySpec) => boolean),
    preloadOptions: PreloadOptions = {},
  ): readonly LoadHandle<unknown>[] {
    sweep()
    const priority = preloadOptions.priority ?? Priority.prefetch
    const handles: LoadHandle<unknown>[] = []
    for (const entry of entries.values()) {
      if (!matches(filter, entry.spec)) continue
      if (entry.value !== undefined) continue
      if (entry.inflight !== null) {
        handles.push(entry.inflight)
        continue
      }
      const handle = manager.load<unknown, unknown>(entry.spec.url, {
        kind: entry.spec.kind,
        parser: entry.spec.parser,
        parserOptions: entry.spec.parserOptions,
        priority,
        onProgress: preloadOptions.onProgress,
        signal: preloadOptions.signal,
        meta: { libraryId: entry.spec.id },
      })
      entry.inflight = handle
      handles.push(handle)
      void handle.ready.then(
        (value: unknown) => settle(entry, value, undefined),
        (error: unknown) => settle(entry, undefined, error),
      )
    }
    return handles
  }

  function settle(entry: Entry, value: unknown, error: unknown): void {
    entry.inflight = null
    if (error !== undefined) {
      entry.hasError = true
      entry.error = error
      return
    }
    entry.value = value
    entry.hasError = false
    entry.error = undefined
    entry.bytes = estimate(value)
    entry.lastTouched = now()
    enforceBudget()
  }

  function acquire<T>(id: string, acquireOptions: { priority?: number } = {}): LibraryHandle<T> {
    sweep()
    const entry = entries.get(id)
    if (entry === undefined) {
      throw new LoadError('source', `AssetLibrary: asset "${id}" is not defined (define primero)`)
    }
    if (entry.hasError && entry.inflight === null && entry.value === undefined) {
      // the previous attempt failed — reload
      entry.hasError = false
    }
    entry.refcount++
    entry.lastTouched = now()

    if (entry.value !== undefined) {
      return makeHandle(entry, Promise.resolve(entry.value as T))
    }
    if (entry.inflight !== null) {
      return makeHandle(entry, entry.inflight.ready as Promise<T>)
    }
    const handle = manager.load(entry.spec.url, {
      kind: entry.spec.kind,
      parser: entry.spec.parser,
      parserOptions: entry.spec.parserOptions,
      priority: acquireOptions.priority ?? entry.spec.priority ?? Priority.normal,
      meta: { libraryId: id },
    })
    entry.inflight = handle
    void handle.ready.then(
      (value: unknown) => settle(entry, value, undefined),
      (error: unknown) => settle(entry, undefined, error),
    )
    return makeHandle(entry, handle.ready as Promise<T>)
  }

  function makeHandle<T>(entry: Entry, ready: Promise<T>): LibraryHandle<T> {
    let released = false
    const handle: LibraryHandle<T> = {
      id: entry.spec.id,
      ready,
      get value() { return entry.value as T | undefined },
      release() {
        if (released) return
        released = true
        if (entry.refcount > 0) entry.refcount--
        entry.lastTouched = now()
      },
    }
    return handle
  }

  /** Lazy sweeping: TTL expired → dispose; byte budget → LRU. */
  function sweep(): void {
    const t = now()
    for (const [id, entry] of entries) {
      if (entry.refcount === 0 && entry.inflight === null && entry.value !== undefined) {
        if (t - entry.lastTouched > ttlMs) {
          disposeEntry(entry)
          entries.delete(id)
        }
      }
    }
    enforceBudget()
  }

  function enforceBudget(): void {
    if (!Number.isFinite(maxBytes)) return
    let total = 0
    for (const entry of entries.values()) total += entry.bytes
    if (total <= maxBytes) return
    // candidates: refcount 0 and a value — LRU by lastTouched
    const candidates = [...entries.values()]
      .filter(e => e.refcount === 0 && e.value !== undefined)
      .sort((a, b) => a.lastTouched - b.lastTouched)
    for (const entry of candidates) {
      if (total <= maxBytes) break
      total -= entry.bytes
      disposeEntry(entry)
      entries.delete(entry.spec.id)
    }
  }

  function disposeEntry(entry: Entry): void {
    if (disposeAsset !== undefined && entry.value !== undefined) {
      try {
        disposeAsset(entry.value)
      } catch {
        // the disposer must not bring down the library
      }
    }
    entry.value = undefined
    entry.bytes = 0
  }

  function peek(id: string): unknown | undefined {
    return entries.get(id)?.value
  }

  function errorOf(id: string): unknown | undefined {
    const entry = entries.get(id)
    return entry !== undefined && entry.hasError ? entry.error : undefined
  }

  function evict(id?: string): boolean {
    if (id === undefined) {
      for (const entry of entries.values()) disposeEntry(entry)
      entries.clear()
      return true
    }
    const entry = entries.get(id)
    if (entry === undefined) return false
    if (entry.inflight !== null) entry.inflight.cancel('evicted')
    disposeEntry(entry)
    entries.delete(id)
    return true
  }

  function stats(): LibraryStats {
    sweep()
    let resident = 0, inflight = 0, failed = 0, bytes = 0
    for (const entry of entries.values()) {
      if (entry.value !== undefined) resident++
      if (entry.inflight !== null) inflight++
      if (entry.hasError) failed++
      bytes += entry.bytes
    }
    return { entries: entries.size, resident, inflight, failed, bytes }
  }

  function dispose(): void {
    for (const entry of entries.values()) {
      if (entry.inflight !== null) entry.inflight.cancel('library disposed')
      disposeEntry(entry)
    }
    entries.clear()
  }

  return {
    define,
    preload,
    acquire,
    peek,
    errorOf,
    evict,
    stats,
    dispose,
    get manager() { return manager },
  }
}

/** Weight heuristic: TypedArray → byteLength; bitmap → w*h*4; otherwise 0. */
function defaultEstimateBytes(asset: unknown): number {
  if (asset === null || asset === undefined) return 0
  if (asset instanceof Uint8Array) return asset.byteLength
  const anyAsset = asset as Record<string, unknown>
  if (typeof anyAsset.byteLength === 'number') return anyAsset.byteLength as number
  if (typeof anyAsset.width === 'number' && typeof anyAsset.height === 'number') {
    return (anyAsset.width as number) * (anyAsset.height as number) * 4
  }
  if (typeof anyAsset.rgb === 'object' && anyAsset.rgb !== null) {
    const rgb = anyAsset.rgb as { byteLength?: number }
    if (typeof rgb.byteLength === 'number') return rgb.byteLength
  }
  if (Array.isArray(anyAsset.meshes)) {
    let bytes = 0
    for (const mesh of anyAsset.meshes as Array<Record<string, unknown>>) {
      for (const key of ['positions', 'normals', 'uvs', 'tangents', 'indices']) {
        const arr = mesh[key] as { byteLength?: number } | null
        if (arr !== null && arr !== undefined && typeof arr.byteLength === 'number') {
          bytes += arr.byteLength
        }
      }
    }
    return bytes
  }
  return 0
}
