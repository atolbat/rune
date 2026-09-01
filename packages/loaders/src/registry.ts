/**
 * Реестр форматов + AssetLoader — фасад загрузки всех ассетов.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * КОНТРАКТ:
 *
 *   const loader = new AssetLoader({ scheduler, fetchImpl, ... })
 *   const handle = loader.load('model.glb', { onProgress, priority })
 *   const model: GltfModel = await handle        // handle — thenable
 *   handle.cancel('не нужен')
 *
 *   • Формат выбирается автоматически: расширение → magic-байты
 *     (glTF/FBX → 'glb'/'fbx', остальное → 'bytes').
 *   • Прогресс — честный, фазовый: queued → fetching (0.7) →
 *     parsing (0.2) → transforming (0.1) → done. Байтовый прогресс
 *     стриминга, фазовый — парсеров (onPhase).
 *   • Дедупликация по URL: параллельные load() одного URL получают
 *     ОДИН handle (jobs-Map). Кэш LRU с бюджетом байт (256 МБ
 *     по умолчанию), eviction НЕ трогает активные задачи.
 *   • Группа: loadGroup([...]) — агрегированный прогресс/отмена.
 *   • Свои форматы: registerFormat(id, extensions, parse) —
 *     приоритетнее встроенных (unshift).
 *
 * СОСТАВ встроенных форматов: glb, gltf (.gltf + внешние буферы),
 * obj, mtl, fbx (скелетная анимация — parseFBX), image (MIME по
 * magic-байтам), config (json/zml/ini/txt + регистрируемые),
 * bytes (bin/ktx2 — сырые байты).
 *
 * Лоадер не знает про GPU: ассеты — декодированные данные.
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

// ─── Типы ────────────────────────────────────────────────────────────────────

/** Фаза жизненного цикла загрузки. */
export type LoadPhase = 'queued' | 'fetching' | 'parsing' | 'transforming' | 'done' | 'error' | 'cancelled'

export type OnAssetPhase = (phase: GltfPhase) => void

/** Снапшот прогресса (immutable, идёт в onProgress и события). */
export interface LoadProgress {
  readonly phase: LoadPhase
  readonly loaded: number
  readonly total: number
  /** Прогресс внутри текущей фазы (0..1). */
  readonly phaseRatio: number
  /** Общий прогресс с весами фаз (0..1). */
  readonly ratio: number
  readonly url: string
  readonly cached: boolean
  readonly detail: string
}

/** Контекст, передаваемый парсеру формата. */
export interface ParserContext {
  readonly url: string
  readonly assembler: Assembler
  /** Составной сигнал: отмена задачи + внешняя. */
  readonly signal: AbortSignal
  readonly onPhase: OnAssetPhase
  /** Разрешённый относительный URI → байты (внешние буферы .gltf). */
  readonly loadExternal: (uri: string) => Promise<Uint8Array>
  readonly createBitmap?: CreateBitmap
  readonly dracoDecoder?: DracoDecoder
}

/** Описание формата в реестре. */
export interface FormatDescriptor {
  readonly id: string
  readonly extensions: readonly string[]
  readonly parse: (ctx: ParserContext) => Promise<unknown>
}

/** Пост-обработка ассета (конверсии, кэш-сборка, LOD-стриппинг). */
export type TransformHook = (
  asset: unknown,
  meta: { url: string; bytes: number; fetchedMs: number; parsedMs: number },
) => unknown | Promise<unknown>

/** Опции единичной загрузки. */
export interface LoadOptions {
  /** Приоритет в планировщике (меньше = раньше). По умолчанию 5. */
  readonly priority?: number
  /** Начальный вес байт для бюджета планировщика. По умолчанию 8 МБ. */
  readonly weightBytes?: number
  readonly signal?: AbortSignal
  readonly connectTimeoutMs?: number
  readonly retries?: number
  /** Форсировать парсер по id (мимо расширения/magic-байтов). */
  readonly parser?: string
  /** Не класть результат в кэш. */
  readonly noCache?: boolean
  readonly transform?: readonly TransformHook[]
  readonly onProgress?: (progress: LoadProgress) => void
}

/** Опции конструктора AssetLoader. */
export interface AssetLoaderOptions {
  readonly scheduler?: FetchScheduler
  readonly fetchImpl?: typeof fetch
  /** Бюджет байт-кэша; ≤0 — кэш без ограничений. По умолчанию 256 МБ. */
  readonly cacheBytesLimit?: number
  readonly createBitmap?: CreateBitmap
  readonly dracoDecoder?: DracoDecoder
  /** Дефолты, применяемые к каждой загрузке. */
  readonly defaults?: LoadOptions
}

/** События загрузчика (on('progress'|'done'|'error'|'cancelled'|'evicted')). */
export type LoaderEvent =
  | { type: 'progress'; handle: LoadHandle }
  | { type: 'done'; handle: LoadHandle }
  | { type: 'error'; handle: LoadHandle; error: unknown }
  | { type: 'cancelled'; handle: LoadHandle }
  | { type: 'evicted'; url: string; bytes: number }

/** Агрегированная статистика загрузчика. */
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

/** Результат loadGroup: агрегированный прогресс + общая отмена. */
export interface LoadGroup {
  readonly urls: readonly string[]
  readonly promise: Promise<unknown[]>
  readonly progress: LoadProgress
  cancel(reason?: string): void
}

// ─── Веса фаз общего прогресса ───────────────────────────────────────────────

/** Вклад фаз в ratio: скачивание 70%, парсинг 20%, transform 10%. */
export const PHASE_WEIGHTS = { fetch: 0.7, parse: 0.2, transform: 0.1 } as const

// ─── LoadHandle ──────────────────────────────────────────────────────────────

/**
 * Хэндл загрузки: thenable (await даёт ассет) + управление
 * (cancel/setPriority) + снимок прогресса (handle.progress).
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

// ─── Встроенные форматы ──────────────────────────────────────────────────────

/** Магия бинарного FBX: «Kaydara FBX Binary  \x1a\x00». */
export function isBinaryFbx(bytes: Uint8Array): boolean {
  return bytes.length >= 23 && asciiDecode(bytes, 0, 20) === 'Kaydara FBX Binary  '
}

/** Реестр форматов по умолчанию (порядок = приоритет выбора по расширению). */
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
        // fullView — вид над буфером сборки; parseFBX нужен точный ArrayBuffer
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
 * Фасад загрузки: планировщик + стриминг + реестр форматов + LRU-кэш
 * + события. Один AssetLoader на приложение; класс без глобального
 * состояния — инстанцируйте сколько нужно (например, изолированный
 * для воркера).
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

  /** Загрузка ассета; повторные вызовы того же URL — один и тот же handle. */
  load(url: string, options: LoadOptions = {}): LoadHandle {
    const opts: LoadOptions = { ...this.defaults, ...options }
    const key = url

    // Кэш: готовый ассет отдаётся мгновенно «выполненным» хэндлом
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
          detail: 'из кэша',
        },
        () => false,
        () => false,
      )
      handle.markSettled()
      opts.onProgress?.(handle.progress)
      this.emit({ type: 'done', handle })
      return handle
    }

    // Дедупликация: активная задача уже качается
    const active = this.jobs.get(key)
    if (active !== undefined) return active.handle

    let weight = opts.weightBytes ?? 8388608
    let phase: LoadPhase = 'queued'
    let loaded = 0
    let total = 0
    let phaseRatio = 0
    let detail = 'в очереди'
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
        reportProgress('соединение')
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
              // Content-Length стал известен: уточняем вес задачи
              total = declared
              weight = declared
              this.scheduler.updateWeight(job)
            } else if (total > 0 && received > total) {
              // Сервер соврал в большую сторону — сбрасываем тотал
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
          reportProgress('парсинг')
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
          reportProgress(`готово за ${formatDuration(nowMs() - startedAt)}`)
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
        detail: 'в очереди',
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

  /** Массовая предзагрузка: ошибки не роняют пачку, а собираются. */
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

  /** Группа загрузок: агрегированный прогресс + общая отмена. */
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
          `${doneCount}/${handles.length} готово · ` +
          (worstPhase === 'fetching'
            ? `${formatBytes(loadedSum)}${totalSum > 0 ? ` / ${formatBytes(totalSum)}` : ''}`
            : worstPhase)
        return {
          phase: worstPhase,
          loaded: loadedSum,
          total: totalSum,
          phaseRatio: groupRatio,
          ratio: groupRatio,
          url: entries.length === 1 ? entries[0].url : `${handles.length} ассетов`,
          cached: false,
          detail: text,
        }
      },
      cancel: (reason?: string) => {
        for (const handle of handles) handle.cancel(reason)
      },
    }
  }

  /** Ассет из кэша (undefined — не загружен). */
  get(url: string): unknown {
    return this.cache.get(url)?.asset
  }

  /** Хэндл активной задачи по URL (undefined — задача завершена/отсутствует). */
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

  /** Выбросить один URL из кэша. */
  dispose(url: string): boolean {
    return this.cache.delete(url)
  }

  clear(): void {
    this.cache.clear()
  }

  /** Подписка на события; отписка — возвращенная функция. */
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

  /** Свой формат — приоритетнее встроенных. */
  registerFormat(id: string, extensions: readonly string[], parse: (ctx: ParserContext) => Promise<unknown>): void {
    this.formats.unshift({ id, extensions, parse })
  }

  /** Доступ к реестру конфиг-парсеров (registerConfigParser/configParserOf). */
  get configParsers(): {
    register: (extension: string, parser: ConfigParser) => void
    of: (extension: string) => ConfigParser | undefined
  } {
    return {
      register: registerConfigParser,
      of: configParserOf,
    }
  }

  /** Выбор парсера: явный id → расширение → magic-байты (glb/fbx/bytes). */
  async resolveParser(url: string, options: LoadOptions, assembler: Assembler): Promise<(ctx: ParserContext) => Promise<unknown>> {
    if (options.parser !== undefined) {
      const format = this.formats.find((f) => f.id === options.parser)
      if (format !== undefined) return format.parse
      throw new Error(`парсер «${options.parser}» не зарегистрирован`)
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
        // Слушатель не должен ломать загрузку
      }
  }

  private evictIfNeeded(): void {
    if (this.cacheBytesLimit <= 0) return
    let bytes = 0
    for (const entry of this.cache.values()) bytes += entry.bytes
    while (bytes > this.cacheBytesLimit) {
      let victim: { key: string; entry: CacheEntry } | undefined
      for (const [key, entry] of this.cache) {
        // Активные задачи не выкидываем — их ассет ещё нужен
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

// ─── Вспомогательные ─────────────────────────────────────────────────────────

/** Расширение URL (без query/hash, в нижнем регистре; '' — нет). */
export function extensionOf(url: string): string {
  const path = url.split('?')[0]?.split('#')[0] ?? ''
  const lastSlash = path.lastIndexOf('/')
  const lastDot = path.lastIndexOf('.')
  if (lastDot <= lastSlash) return ''
  return path.slice(lastDot + 1).toLowerCase()
}

/** Общий ratio по фазам и весам. */
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

/** Аптайм без total: сатурация 1-e^(-bytes/8MB) (cap 95%). */
function unknownTotalRatio(bytes: number): number {
  return Math.min(0.95, 1 - Math.exp(-bytes / 8388608))
}

/** Разрешение относительного URI против базового URL. */
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

/** «1.2 с» / «890 мс». */
function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} с` : `${Math.round(ms)} мс`
}

// ─── Мост к слою Task 88 (core/ + formats/) ─────────────────────────────────
// Реставрация: менеджер (core/manager.ts) ждёт от корневого registry.ts
// фабрику реестра парсеров и сниффер. Сами парсеры живут в formats/ и
// реализуют интерфейс Parser из core/types.ts.

export { sniffKind } from './core/util.ts'
export type { SniffResult } from './core/util.ts'

import type { Parser, ImageDecode, UrlResolver } from './core/types.ts'
import { gltfParser } from './formats/gltf.ts'
import { objParser } from './formats/obj.ts'
import { fbxParser } from './formats/fbx.ts'
import { hdrParser, createImageParser } from './formats/image.ts'
import { bytesParser, textParser, jsonParser, zmlParser } from './formats/config.ts'
import type { MtlModel } from './mtl.ts'

/** Опции фабрики реестра парсеров (контракт core/manager.ts). */
export interface ParserRegistryOptions {
  readonly fetchImpl?: typeof fetch
  readonly resolveUrl?: UrlResolver
  /** zlib-inflate для FBX; null запрещает (контракт передаётся парсеру через ctx). */
  readonly inflate?: ((bytes: Uint8Array) => Promise<Uint8Array>) | null
  /** Декодер картинок; null → image-парсер бросит UnsupportedError. */
  readonly decodeImage?: ImageDecode | null
}

/** MTL-парсер поверх корневого parseMtl (MtlModel). */
const mtlParserAdapter: Parser<MtlModel> = {
  kind: 'mtl',
  extensions: ['.mtl'],
  parse(input: { bytes: Uint8Array }): MtlModel {
    return parseMtl(input.bytes)
  },
}

/**
 * Реестр парсеров по умолчанию для LoadManager (Task 88): kinds → парсеры.
 * 'glb' на сниффе менеджер сам отображает на 'gltf'.
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
