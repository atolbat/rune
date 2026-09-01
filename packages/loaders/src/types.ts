/**
 * types.ts — контракт ассетов и загрузок @rune/loaders.
 *
 * Слои (см. DESIGN.md rune — «Валидированный дизайн»):
 *   LoadScheduler  — приоритеты/квоты/отмена, ничего не знает про форматы;
 *   источник       — fetch-стрим с прогрессом и abort;
 *   парсер         — формат: GLB/OBJ/FBX/изображение/конфиг;
 *   AssetLibrary   — кэш, dedup, preload, групповой прогресс.
 *
 * Лоадеры НЕ знают про GPU: результат — декодированные данные
 * (типизированные массивы, ImageBitmap, объекты). GPU-интеграция —
 * в @rune/gl / @rune/kit или пользовательском коде.
 */

/** Фаза жизненного цикла ассета. */
export type AssetPhase =
  | 'queued'      // в очереди планировщика (ждёт слот/квоту)
  | 'fetching'    // тело качается (байты растут)
  | 'parsing'     // байты разбираются форматом (GLB-чанки, OBJ-строки…)
  | 'transforming'// пост-пайп пользователя (transform-функции)
  | 'done'        // готов, лежит в кэше
  | 'error'       // упал (сеть/формат/трансформ)
  | 'cancelled';  // отменён пользователем/сигналом

/** Снимок прогресса ассета — иммутабельная запись на каждый апдейт. */
export interface AssetProgress {
  readonly phase: AssetPhase
  /** Загружено байт тела (fetch). */
  readonly loaded: number
  /** Полная длина тела, если известна (Content-Length). */
  readonly total: number
  /** Прогресс фазы 0..1 (fetch — байты; parse — вложенные единицы; done — 1). */
  readonly phaseRatio: number
  /** Агрегат 0..1: фазы взвешены (fetch 70%, parse 20%, transform 10%). */
  readonly ratio: number
  /** Уникальный URL (ключ кэша). */
  readonly url: string
  /** Пришёл из кэша (мгновенно, без сети). */
  readonly cached: boolean
  /** Человекочитаемая деталь фазы (имя чанка, кол-во мешей…). */
  readonly detail: string
}

/** Вес фаз в агрегатном ratio. */
export const PHASE_WEIGHTS: Readonly<Record<'fetch' | 'parse' | 'transform', number>> = {
  fetch: 0.7,
  parse: 0.2,
  transform: 0.1,
}

/** Опции загрузки — «широкие настройки» общего лоадера. */
export interface LoadOptions {
  /** Приоритет: меньше — раньше. 0 — высший, default 5. */
  readonly priority?: number
  /** Ожидаемый вес в байтах для квоты in-flight (default: Content-Length). */
  readonly weightBytes?: number
  /** Внешняя отмена. */
  readonly signal?: AbortSignal
  /** Таймаут на установку соединения (не на всё тело), мс. */
  readonly connectTimeoutMs?: number
  /** Повторы при сетевых ошибках (default 1; abort не ретраится). */
  readonly retries?: number
  /** Пост-парсинг трансформы, применяются по цепочке. */
  readonly transform?: readonly AssetTransform[]
  /** Прогресс-колбэк (тот же снимок, что и в handle.progress). */
  readonly onProgress?: (progress: AssetProgress) => void
  /** Форсировать парсер (минует авто-определение по расширению/магике). */
  readonly parser?: string
  /** Не писать результат в кэш (одноразовая загрузка). */
  readonly noCache?: boolean
}

/** Трансформ: (asset, meta) => новый asset. Синхронный или async. */
export type AssetTransform<TIn = unknown, TOut = unknown> = (
  asset: TIn,
  meta: AssetMeta,
) => TOut | Promise<TOut>

/** Метаданные ассета для трансформов. */
export interface AssetMeta {
  readonly url: string
  readonly bytes: number
  readonly fetchedMs: number
  readonly parsedMs: number
}

/** Хэндл загрузки: thenable + управление. */
export interface AssetHandle<T = unknown> extends PromiseLike<T> {
  readonly url: string
  readonly key: string
  /** Текущее состояние (снимок, иммутабельно). */
  readonly progress: AssetProgress
  /** Состояние жизненного цикла. */
  readonly state: AssetPhase
  /** Отменить (queued — мгновенно; fetching — abort сети). */
  cancel(reason?: string): boolean
  /** Сменить приоритет queued-задания. Running — только внутри планировщика. */
  setPriority(priority: number): boolean
  then<R1 = T, R2 = never>(
    onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2>
}

/** События библиотеки. */
export type LibraryEvent =
  | { readonly type: 'progress'; readonly handle: AssetHandle }
  | { readonly type: 'done'; readonly handle: AssetHandle }
  | { readonly type: 'error'; readonly handle: AssetHandle; readonly error: unknown }
  | { readonly type: 'cancelled'; readonly handle: AssetHandle }
  | { readonly type: 'evicted'; readonly url: string; readonly bytes: number }

/** Групповая загрузка: агрегатный прогресс + общая отмена. */
export interface LoadGroup<T = unknown> {
  readonly urls: readonly string[]
  readonly promise: Promise<readonly T[]>
  /** Агрегатный прогресс 0..1 (взвешен по Content-Length/весу). */
  readonly progress: AssetProgress
  cancel(reason?: string): void
}

/** Статистика библиотеки. */
export interface LibraryStats {
  readonly cached: number
  readonly cacheBytes: number
  readonly running: number
  readonly queued: number
  readonly bytesInFlight: number
  readonly downloads: number
  readonly downloadBytes: number
  readonly cacheHits: number
}
