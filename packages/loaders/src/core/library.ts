/**
 * core/library.ts — AssetLibrary: именованная библиотека ассетов поверх
 * LoadManager — прелоадинг, refcount, TTL, байтовый бюджет (LRU).
 *
 * Сценарий:
 *   const lib = createAssetLibrary({ manager, maxBytes: 256 << 20 })
 *   lib.define([{ id: 'hero', url: 'hero.glb', kind: 'gltf' },
 *               { id: 'env', url: 'quarry.hdr', kind: 'hdr', tags: ['env'] }])
 *   lib.preload(['hero'])                  // prefetch-приоритетом, в фоне
 *   const h = lib.acquire<MeshDocument>('hero'); const doc = await h.ready
 *   ... h.release()                        // refcount 0 → кандидат на TTL
 *   lib.preload(e => e.tags?.includes('env')) // прелоад «следующего уровня»
 *
 * Бюджет: байты ассета считает estimateBytes (эвристика по типу данных);
 * при превышении maxBytes выталкиваются LRU-записи с refcount=0. TTL
 * (время жизни нулевого refcount) защищает от «загрузил-выгрузил».
 *
 * GPU-резидентность — НЕ здесь: @rune/kit AssetCache делает то же для
 * текстур по кадрам; библиотека — про сеть/парсинг. Мост: acquire → upload
 * → kit-кэш, release по уходу со сцены.
 */

import type { LoadHandle, LoadOptions, Parser } from './types.ts'
import type { LoadManager } from './manager.ts'
import { createLoadManager } from './manager.ts'
import { Priority } from './types.ts'
import { LoadError } from './errors.ts'

// ─── типы ────────────────────────────────────────────────────────────────────

/** Описание ассета в библиотеке/манифесте. */
export interface AssetEntrySpec {
  /** Уникальный id, по которому acquire/preload. */
  readonly id: string
  /** URL (или data:) источника. */
  readonly url: string
  /** Формат из реестра менеджера; sniffing, если не задан. */
  readonly kind?: string
  /** Приоритет для acquire (default normal). Preload всегда prefetch. */
  readonly priority?: number
  /** Теги для фильтров прелоадинга («next-level», «env», ...). */
  readonly tags?: readonly string[]
  /** Опции парсера (resize картинок и т.п.). */
  readonly parserOptions?: unknown
  /** Хэндл парсера напрямую (переопределяет kind). */
  readonly parser?: Parser<any, any>
  /** Прелоадить сразу после define. */
  readonly preload?: boolean
}

export interface AssetManifest {
  readonly assets: readonly AssetEntrySpec[]
}

export interface LibraryHandle<T = unknown> {
  readonly id: string
  readonly ready: Promise<T>
  /** undefined, пока не загружен. */
  readonly value: T | undefined
  /** Декремент refcount; идемпотентно. */
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
  /** Менеджер; создаётся свой (default fetch), если не передан. */
  manager?: LoadManager
  /** Байтовый бюджет (default ∞). */
  maxBytes?: number
  /** Время жизни нулевого refcount, мс (default 30_000). */
  ttlMs?: number
  now?: () => number
  /** Оценка веса ассета в байтах (эвристика по умолчанию). */
  estimateBytes?: (asset: unknown) => number
  /** Диспозер (например, bitmap.close()). */
  disposeAsset?: (asset: unknown) => void
}

export interface PreloadOptions {
  /** Приоритет прелоада (default Priority.prefetch). */
  priority?: number
  /** Прогресс/сигнал/мета — в LoadOptions менеджера. */
  onProgress?: LoadOptions['onProgress']
  signal?: LoadOptions['signal']
}

export interface AssetLibrary {
  /** Зарегистрировать/обновить описания ассетов. */
  define(entries: AssetEntrySpec | readonly AssetEntrySpec[]): void
  /** Прелоад в фоне: грузит по prefetch-приоритету, refcount остаётся 0. */
  preload(
    filter: string | readonly string[] | ((spec: AssetEntrySpec) => boolean),
    options?: PreloadOptions,
  ): readonly LoadHandle<unknown>[]
  /** Взять ассет: resident → сразу, иначе загрузка через менеджер. */
  acquire<T = unknown>(id: string, options?: { priority?: number }): LibraryHandle<T>
  /** Значение, если резидентно (не грузит). */
  peek(id: string): unknown | undefined
  /** Ошибка последней загрузки, если была. */
  errorOf(id: string): unknown | undefined
  /** Вытолкнуть запись (идемпотентно). */
  evict(id?: string): boolean
  /** Снапшот состояния. */
  stats(): LibraryStats
  /** Всё выгрузить и закрыть. */
  dispose(): void
  readonly manager: LoadManager
}

// ─── реализация ──────────────────────────────────────────────────────────────

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
        throw new LoadError('source', 'define: id обязателен')
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
      throw new LoadError('source', `AssetLibrary: ассет "${id}" не определён (define primero)`)
    }
    if (entry.hasError && entry.inflight === null && entry.value === undefined) {
      // предыдущая попытка упала — перегружаем
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

  /** Ленивая уборка: TTL истёк → dispose; байтовый бюджет → LRU. */
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
    // кандидаты: refcount 0 и value есть — LRU по lastTouched
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
        // диспозер не должен ронять библиотеку
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

/** Эвристика веса: TypedArray → byteLength; bitmap → w*h*4; иначе 0. */
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
