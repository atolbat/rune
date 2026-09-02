/**
 * types.ts — the asset and loading contract of @rune/loaders.
 *
 * Layers (see DESIGN.md rune — "Validated design"):
 *   LoadScheduler  — priorities/quotas/cancellation, knows nothing about formats;
 *   source         — fetch stream with progress and abort;
 *   parser         — format: GLB/OBJ/FBX/image/config;
 *   AssetLibrary   — cache, dedup, preload, group progress.
 *
 * Loaders do NOT know about the GPU: the result is decoded data
 * (typed arrays, ImageBitmap, objects). GPU integration —
 * lives in @rune/gl / @rune/kit or in user code.
 */

/** Asset lifecycle phase. */
export type AssetPhase =
  | 'queued'      // in the scheduler queue (waiting for a slot/quota)
  | 'fetching'    // the body is downloading (bytes grow)
  | 'parsing'     // bytes are parsed by a format (GLB chunks, OBJ lines...)
  | 'transforming'// user post-pipe (transform functions)
  | 'done'        // ready, sits in the cache
  | 'error'       // failed (network/format/transform)
  | 'cancelled';  // cancelled by user/signal

/** Asset progress snapshot — an immutable record on every update. */
export interface AssetProgress {
  readonly phase: AssetPhase
  /** Body bytes loaded (fetch). */
  readonly loaded: number
  /** Total body length, if known (Content-Length). */
  readonly total: number
  /** Phase progress 0..1 (fetch — bytes; parse — nested units; done — 1). */
  readonly phaseRatio: number
  /** Aggregate 0..1: phases weighted (fetch 70%, parse 20%, transform 10%). */
  readonly ratio: number
  /** Unique URL (cache key). */
  readonly url: string
  /** Came from the cache (instantly, no network). */
  readonly cached: boolean
  /** Human-readable phase detail (chunk name, mesh count...). */
  readonly detail: string
}

/** Phase weights in the aggregate ratio. */
export const PHASE_WEIGHTS: Readonly<Record<'fetch' | 'parse' | 'transform', number>> = {
  fetch: 0.7,
  parse: 0.2,
  transform: 0.1,
}

/** Load options — "broad settings" of the general loader. */
export interface LoadOptions {
  /** Priority: lower — earlier. 0 is highest, default 5. */
  readonly priority?: number
  /** Expected weight in bytes for the in-flight quota (default: Content-Length). */
  readonly weightBytes?: number
  /** External cancellation. */
  readonly signal?: AbortSignal
  /** Timeout for establishing the connection (not for the whole body), ms. */
  readonly connectTimeoutMs?: number
  /** Retries on network errors (default 1; abort is not retried). */
  readonly retries?: number
  /** Post-parse transforms, applied in a chain. */
  readonly transform?: readonly AssetTransform[]
  /** Progress callback (the same snapshot as in handle.progress). */
  readonly onProgress?: (progress: AssetProgress) => void
  /** Force a parser (bypasses auto-detection by extension/magic bytes). */
  readonly parser?: string
  /** Do not write the result to the cache (one-off load). */
  readonly noCache?: boolean
}

/** Transform: (asset, meta) => a new asset. Sync or async. */
export type AssetTransform<TIn = unknown, TOut = unknown> = (
  asset: TIn,
  meta: AssetMeta,
) => TOut | Promise<TOut>

/** Asset metadata for transforms. */
export interface AssetMeta {
  readonly url: string
  readonly bytes: number
  readonly fetchedMs: number
  readonly parsedMs: number
}

/** Load handle: thenable + control. */
export interface AssetHandle<T = unknown> extends PromiseLike<T> {
  readonly url: string
  readonly key: string
  /** Current state (snapshot, immutable). */
  readonly progress: AssetProgress
  /** Lifecycle state. */
  readonly state: AssetPhase
  /** Cancel (queued — instantly; fetching — network abort). */
  cancel(reason?: string): boolean
  /** Change the priority of a queued job. Running — only inside the scheduler. */
  setPriority(priority: number): boolean
  then<R1 = T, R2 = never>(
    onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2>
}

/** Library events. */
export type LibraryEvent =
  | { readonly type: 'progress'; readonly handle: AssetHandle }
  | { readonly type: 'done'; readonly handle: AssetHandle }
  | { readonly type: 'error'; readonly handle: AssetHandle; readonly error: unknown }
  | { readonly type: 'cancelled'; readonly handle: AssetHandle }
  | { readonly type: 'evicted'; readonly url: string; readonly bytes: number }

/** Group load: aggregate progress + shared cancellation. */
export interface LoadGroup<T = unknown> {
  readonly urls: readonly string[]
  readonly promise: Promise<readonly T[]>
  /** Aggregate progress 0..1 (weighted by Content-Length/weight). */
  readonly progress: AssetProgress
  cancel(reason?: string): void
}

/** Library statistics. */
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
