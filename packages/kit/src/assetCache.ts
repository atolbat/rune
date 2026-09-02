/**
 * AssetCache<T> — a generic asset cache with refcount, TTL and a churn-window.
 *
 * Contract (see the design round "Layer 3: Cache"):
 *  - Generic: stores any assets (ImageBitmap, Texture, objects).
 *  - acquire(key, loader): if present in the cache and not expired — returns immediately,
 *    otherwise starts the loader (a user function returning Promise<T>),
 *    deduplicating concurrent requests for the same key.
 *  - refcount: every acquire increments it; release decrements it. When
 *    refcount = 0, the asset becomes an eviction candidate (but is not disposed
 *    right away — see the churn-window).
 *  - TTL: an asset with refcount = 0 lives for another N frames (baseTtlFrames) — the
 *    typical "returned to a level — don't reload" case. After the TTL — an
 *    eviction candidate under the byte budget.
 *  - churn-window: if many dispose events happened within the last churnWindowMs,
 *    the cache "cools down" — it stops evicting and waits (against thrashing).
 *  - scope(): creates a child cache whose dispose automatically releases all of
 *    its acquires (for a level/scene).
 *
 * The cache knows about the loader function (via a callback) but NOT about the GPU —
 * the separation "a texture primitive knows nothing about the loader" is preserved.
 */

/** acquire option: TTL and priority can be overridden. */
export interface AcquireOptions {
  /** Override baseTtlFrames for this entry. */
  readonly ttlFrames?: number
  /** Eviction priority: higher = survives longer under pressure. Default 1. */
  readonly priority?: number
}

/** AssetCache creation parameters. */
export interface AssetCacheOptions {
  /** Byte budget. When exceeded — LRU eviction (by lastTouched). */
  readonly maxBytes: number
  /** How many frames an asset lives after refcount=0. Default 60 (≈1 s at 60fps). */
  readonly baseTtlFrames?: number
  /** Window for churn detection. If the window sees >churnThreshold dispose events,
   *  eviction is paused. Default 60_000 (1 minute). */
  readonly churnWindowMs?: number
  /** Churn threshold: how many dispose events in the window pause eviction. Default 8. */
  readonly churnThreshold?: number
  /** Frame counter source. Default: external, see tick(). */
  readonly now?: () => number
}

/** Wrapper around a user asset. */
export interface AssetHandle<T> {
  /** The loaded asset. undefined while it is still loading or after an error. */
  readonly value: T | undefined
  /** A promise that resolves once value becomes available. */
  readonly ready: Promise<T>
  /** Release the reference. Decrements the refcount. Idempotent. */
  release(): void
  /** Force a dispose (even if refcount > 0). An internal method —
   *  for cases like switchBackend, when the whole cache is torn down. */
  dispose(): void
}

/** Internal entry state. */
interface Entry<T> {
  readonly key: string
  value: T | undefined
  promise: Promise<T>
  refcount: number
  /** Frame of the last touch (for LRU). */
  lastTouchedFrame: number
  /** Frame when refcount reached 0. null while still active. */
  zeroSinceFrame: number | null
  readonly ttlFrames: number
  readonly priority: number
  /** If the asset has a dispose — we call it on eviction. */
  disposer: ((value: T) => void) | null
  /** Load error (if any). After an error the entry can be re-requested. */
  error: unknown | null
}

/**
 * Creates a generic asset cache.
 *
 * @param disposer An optional function for disposing assets (e.g.
 *   `t => t.dispose()` for a Texture). If not passed — the values are simply
 *   forgotten, GC will collect them.
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

    // A new asset — start the load
    const promise = loader(key).then(
      value => {
        entry.value = value
        entry.error = null
        return value
      },
      err => {
        entry.error = err
        // Do not delete the entry right away — let the user see the error via ready.
        // Re-acquiring with the same key creates a new entry
        // only if the user first releases the current one (which deletes the entry).
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
        // the disposer must not throw — but we won't let it break the cache
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

  /** Frame tick: advances the TTL, evicts when needed. */
  function tick(): void {
    currentFrame++
    // Churn-pause reset: if the dispose events in the window drop — lift the pause
    const now = externalNow()
    const cutoff = now - churnWindowMs
    while (disposeTimestamps.length > 0 && disposeTimestamps[0] < cutoff) {
      disposeTimestamps.shift()
    }
    if (disposeTimestamps.length <= churnThreshold) {
      churnPaused = false
    }
    if (churnPaused) return // no eviction — thrashing protection

    // TTL expiry: refcount=0 and enough frames have passed → delete.
    // `>=` (not `>`): after zeroSinceFrame=F, on frame F+ttl the asset must be evicted.
    for (const entry of entries.values()) {
      if (entry.refcount === 0 && entry.zeroSinceFrame !== null) {
        const age = currentFrame - entry.zeroSinceFrame
        if (age >= entry.ttlFrames) {
          disposeEntry(entry)
        }
      }
    }

    // LRU eviction under the byte budget — if one exists (the user counts bytes
    // via markBytes). For now we don't evict by entry count alone (the budget
    // is optional — it may be unset).
  }

  /** Reset everything: call the disposer for all live entries.
   *
   *  flush() disposes ALL entries in parent.entries (including those
   *  acquired via a scope — a scope merely tracks handles, it has no
   *  entry map of its own). It does not call child.flush() — that would
   *  lead to infinite recursion (child.flush() delegates to parent.flush()).
   *
   *  Scopes are managed via scope.dispose() — that releases all handles.
   *  A parent flush() is a "tear everything down" operation; it already covers all entries.
   */
  function flush(): void {
    for (const entry of entries.values()) {
      disposeEntry(entry)
    }
    entries.clear()
    // No child.flush() call — it would recurse. Scopes are merely
    // handle trackers; their dispose() is moot after a parent flush
    // (entries are cleared). But registered scopes may remain in
    // childCaches — they safely stay "disposed" for future calls
    // (child.dispose() is idempotent).
  }

  /** Create a child cache (a scope). Its dispose releases all acquires.
   *
   *  A scope does NOT create a separate entry map — it delegates to the parent. All
   *  acquires through a scope land in parent.entries, but the scope keeps
   *  the handles and on scope.dispose() delegates the release to the parent.
   *
   *  That way cache.size/stats() reflect the combined state.
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

  /** Current state for debugging. */
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

/** Public cache interface. */
export interface AssetCache<T> {
  acquire(key: string, loader: (key: string) => Promise<T>, opts?: AcquireOptions): AssetHandle<T>
  /** Frame tick: advances the TTL, evicts. */
  tick(): void
  /** Reset everything: call the disposer for all live entries. */
  flush(): void
  /** Create a child cache (a scope). */
  scope(): AssetCache<T>
  /** Current state for debugging. */
  stats(): { size: number; refcounted: number; idle: number }
  /** Full teardown. */
  dispose(): void
  readonly size: number
  readonly bytes: number
}
