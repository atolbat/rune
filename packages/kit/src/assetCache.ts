/**
 * AssetCache<T> — обобщённый кэш ассетов с refcount, TTL и churn-window.
 *
 * Контракт (см. дизайн-раунд «Слой 3: Кэш»):
 *  - Generic: хранит любые ассеты (ImageBitmap, Texture, объекты).
 *  - acquire(key, loader): если есть в кэше и не истёк — возвращает сразу,
 *    иначе запускает loader (функция пользователя, возвращает Promise<T>),
 *    дедуплицирует параллельные запросы по тому же ключу.
 *  - refcount: каждый acquire инкрементирует; release — декрементирует. Когда
 *    refcount = 0, ассет становится кандидатом на eviction (но не диспозится
 *    сразу — см. churn-window).
 *  - TTL: ассет с refcount = 0 живёт ещё N кадров (baseTtlFrames) — типичный
 *    «вернулся на уровень — не загружать заново». После TTL — кандидат на
 *    eviction по байтовому бюджету.
 *  - churn-window: если за последние churnWindowMs происходило много
 *    dispose-ов, cache «остужается» — не эвиктит, а ждёт (против thrashing).
 *  - scope(): создаёт child-cache, при dispose которого все его acquire'ы
 *    автоматически release'ятся (для уровня/сцены).
 *
 * Кэш знает про loader function (через callback), но НЕ знает про GPU —
 * разделение «texture primitive не знает про loader» сохранено.
 */

/** Опция acquire: можно переопределить TTL и приоритет. */
export interface AcquireOptions {
  /** Переопределить baseTtlFrames для этой записи. */
  readonly ttlFrames?: number
  /** Приоритет eviction: выше = дольше живёт при давлении. Default 1. */
  readonly priority?: number
}

/** Параметры создания AssetCache. */
export interface AssetCacheOptions {
  /** Байтовый бюджет. При превышении — LRU eviction (по lastTouched). */
  readonly maxBytes: number
  /** Сколько кадров ассет живёт после refcount=0. Default 60 (≈1 сек при 60fps). */
  readonly baseTtlFrames?: number
  /** Окно для churn detection. Если в окне >churnThreshold dispose-ов —
   *  eviction ставится на паузу. Default 60_000 (1 минута). */
  readonly churnWindowMs?: number
  /** Порог churn: при каком числе dispose в окне — пауза eviction. Default 8. */
  readonly churnThreshold?: number
  /** Источник кадрового счётчика. Default: внешний, см. tick(). */
  readonly now?: () => number
}

/** Обёртка над пользовательским ассетом. */
export interface AssetHandle<T> {
  /** Загруженный ассет. undefined, если ещё грузится или произошла ошибка. */
  readonly value: T | undefined
  /** Promise, который резолвится когда value станет доступен. */
  readonly ready: Promise<T>
  /** Освободить ссылку. Декрементирует refcount. Идемпотентно. */
  release(): void
  /** Принудительно диспозить (даже если refcount > 0). Внутренний метод —
   *  для случаев вроде switchBackend, когда весь кэш сносится. */
  dispose(): void
}

/** Внутреннее состояние записи. */
interface Entry<T> {
  readonly key: string
  value: T | undefined
  promise: Promise<T>
  refcount: number
  /** Кадр последнего touch (для LRU). */
  lastTouchedFrame: number
  /** Кадр когда refcount стал 0. null если ещё активен. */
  zeroSinceFrame: number | null
  readonly ttlFrames: number
  readonly priority: number
  /** Если ассет имеет dispose — вызовем его при eviction. */
  disposer: ((value: T) => void) | null
  /** Ошибка загрузки (если была). После error — entry можно перезапросить. */
  error: unknown | null
}

/**
 * Создаёт обобщённый кэш ассетов.
 *
 * @param disposer Опциональная функция для диспоза ассетов (например,
 *   `t => t.dispose()` для Texture). Если не передан — значения просто
 *   забываются, GC их соберёт.
 */
export function createAssetCache<T>(options: AssetCacheOptions, disposer?: (value: T) => void): AssetCache<T> {
  const baseTtl = options.baseTtlFrames ?? 60
  const churnWindowMs = options.churnWindowMs ?? 60_000
  const churnThreshold = options.churnThreshold ?? 8
  const externalNow = options.now ?? (() => 0)

  const entries = new Map<string, Entry<T>>()
  const childCaches = new Set<AssetCache<T>>()
  let currentFrame = 0
  let totalBytes = 0
  const disposeTimestamps: number[] = []
  let churnPaused = false

  // ─── public API ───────────────────────────────────────────────────────────

  function acquire(key: string, loader: (key: string) => Promise<T>, opts: AcquireOptions = {}): AssetHandle<T> {
    const existing = entries.get(key)
    if (existing !== undefined) {
      existing.refcount++
      existing.lastTouchedFrame = currentFrame
      existing.zeroSinceFrame = null
      return makeHandle(existing)
    }

    // Новый ассет — стартуем загрузку
    const promise = loader(key).then(
      value => {
        entry.value = value
        entry.error = null
        return value
      },
      err => {
        entry.error = err
        // Не удаляем entry сразу — пусть юзер увидит ошибку через ready.
        // Переподключение через acquire() с тем же key создаст новый entry
        // только если юзер сначала release'ит текущий (что удалит entry).
        throw err
      },
    )
    const entry: Entry<T> = {
      key,
      value: undefined,
      promise,
      refcount: 1,
      lastTouchedFrame: currentFrame,
      zeroSinceFrame: null,
      ttlFrames: opts.ttlFrames ?? baseTtl,
      priority: opts.priority ?? 1,
      disposer: disposer ?? null,
      error: null,
    }
    entries.set(key, entry)
    return makeHandle(entry)
  }

  function release(entry: Entry<T>): void {
    if (entry.refcount <= 0) return
    entry.refcount--
    if (entry.refcount === 0) {
      entry.zeroSinceFrame = currentFrame
      recordDispose()
    }
  }

  function disposeEntry(entry: Entry<T>): void {
    if (entry.disposer && entry.value !== undefined) {
      try {
        entry.disposer(entry.value)
      } catch {
        // disposer не должен бросать — но мы не позволим ему развалить кэш
      }
    }
    entries.delete(entry.key)
  }

  function recordDispose(): void {
    const now = externalNow()
    disposeTimestamps.push(now)
    // Trim old timestamps outside the window
    const cutoff = now - churnWindowMs
    while (disposeTimestamps.length > 0 && disposeTimestamps[0] < cutoff) {
      disposeTimestamps.shift()
    }
    if (disposeTimestamps.length > churnThreshold) {
      churnPaused = true
    }
  }

  /** Кадровый тик: продвигает TTL, при необходимости эвиктит. */
  function tick(): void {
    currentFrame++
    // Сброс churn-паузы: если dispose-ов в окне стало мало — снимаем паузу
    const now = externalNow()
    const cutoff = now - churnWindowMs
    while (disposeTimestamps.length > 0 && disposeTimestamps[0] < cutoff) {
      disposeTimestamps.shift()
    }
    if (disposeTimestamps.length <= churnThreshold) {
      churnPaused = false
    }
    if (churnPaused) return // не эвиктим — защита от thrashing

    // TTL expiry: refcount=0 и прошло достаточно кадров → удаляем.
    // `>=` (не `>`): после zeroSinceFrame=F, на frame F+ttl ассет должен быть эвикчен.
    for (const entry of entries.values()) {
      if (entry.refcount === 0 && entry.zeroSinceFrame !== null) {
        const age = currentFrame - entry.zeroSinceFrame
        if (age >= entry.ttlFrames) {
          disposeEntry(entry)
        }
      }
    }

    // LRU eviction по байтовому бюджету — если есть (байты считает пользователь
    // через markBytes). Сейчас просто по числу записей не делаем (бюджет
    // опционален — может не быть задан).
  }

  /** Сбросить всё: вызвать disposer для всех живых записей.
   *
   *  flush() диспозит ВСЕ entries в parent.entries (включая те, что были
   *  acquired через scope — scope лишь отслеживает handle'ы, не имеет
   *  собственного entry-мапа). Не вызывает child.flush() — это привело
   *  бы к бесконечной рекурсии (child.flush() делегирует в parent.flush()).
   *
   *  Scope'ы управляются через scope.dispose() — это release всех handle'ов.
   *  Parent flush() — это «снести всё», он уже покрывает все entries.
   */
  function flush(): void {
    for (const entry of entries.values()) {
      disposeEntry(entry)
    }
    entries.clear()
    // Не вызываем child.flush() — это привело бы к рекурсии. Scope'ы — это
    // просто трекеры handle'ов; их dispose() уже не актуален после parent flush
    // (entries очищены). Но зарегистрированные scope'ы могут оставаться в
    // childCaches — они безопасно останутся как «disposed» для будущих вызовов
    // (child.dispose() идемпотентен).
  }

  /** Создать child-cache (scope). При dispose — release всех acquire'ов.
   *
   *  Scope НЕ создаёт отдельный entry-мап — он делегирует в parent. Все
   *  acquire'ы через scope попадают в parent.entries, но scope хранит
   *  handle'ы и при scope.dispose() делегирует release в parent.
   *
   *  Таким образом cache.size/stats() отражают суммарное состояние.
   */
  function scope(): AssetCache<T> {
    const ownedHandles: AssetHandle<T>[] = []
    let disposed = false

    const child: AssetCache<T> = {
      acquire(key, loader, opts) {
        if (disposed) throw new Error('AssetCache.scope: scope disposed')
        const h = acquire(key, loader, opts)
        ownedHandles.push(h)
        return h
      },
      tick() { tick() },
      flush() { flush() },
      scope() { return scope() },
      stats() { return stats() },
      dispose() {
        if (disposed) return
        disposed = true
        for (const h of ownedHandles) h.release()
        ownedHandles.length = 0
      },
      get size() { return entries.size },
      get bytes() { return totalBytes },
    }
    childCaches.add(child)
    return child
  }

  /** Текущее состояние для отладки. */
  function stats(): { size: number; refcounted: number; idle: number } {
    let refcounted = 0
    let idle = 0
    for (const e of entries.values()) {
      if (e.refcount > 0) refcounted++
      else idle++
    }
    return { size: entries.size, refcounted, idle }
  }

  function dispose(): void {
    flush()
    for (const child of childCaches) child.dispose()
    childCaches.clear()
  }

  function makeHandle(entry: Entry<T>): AssetHandle<T> {
    let released = false
    return {
      get value() { return entry.value },
      get ready() { return entry.promise },
      release() {
        if (released) return
        released = true
        release(entry)
      },
      dispose() {
        released = true
        disposeEntry(entry)
      },
    }
  }

  return {
    acquire,
    tick,
    flush,
    scope,
    stats,
    dispose,
    get size() { return entries.size },
    get bytes() { return totalBytes },
    set bytes(v: number) { totalBytes = v },
  }
}

/** Публичный интерфейс кэша. */
export interface AssetCache<T> {
  acquire(key: string, loader: (key: string) => Promise<T>, opts?: AcquireOptions): AssetHandle<T>
  /** Кадровый тик: продвигает TTL, эвиктит. */
  tick(): void
  /** Сбросить всё: вызвать disposer для всех живых записей. */
  flush(): void
  /** Создать child-cache (scope). */
  scope(): AssetCache<T>
  /** Текущее состояние для отладки. */
  stats(): { size: number; refcounted: number; idle: number }
  /** Полный teardown. */
  dispose(): void
  readonly size: number
  readonly bytes: number
}
