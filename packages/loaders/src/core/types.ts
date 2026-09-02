/**
 * core/types.ts — the contract of the @rune/loaders loading layer.
 *
 * Design principles (see DESIGN.md §9.2 "Zero-main-thread asset path" #12):
 *  1. **Zero dependencies.** The package depends neither on @rune/core nor on
 *     @rune/gl — it embeds equally into a bare core (worker, headless) and into
 *     the scene graph. All platform things (fetch, createImageBitmap, inflate,
 *     URL resolution) are injectable with a default of "use the global if present".
 *  2. **Bytes, not text.** Parsers eat Uint8Array/AsyncIterable<Uint8Array>.
 *     Strings — only where the format is textual by nature (JSON, .obj).
 *  3. **Pipes.** source → (stream) → transforms → parser. Parsers with a
 *     `streaming` factory eat chunks as they download — parsing overlaps the
 *     network. Buffer parsers receive the accumulated buffer.
 *  4. **Neutral data.** Mesh formats are normalized into a MeshDocument
 *     (formats/mesh.ts) — plain data without GPU objects. The render layer
 *     decides itself how to feed it into the pipeline.
 */

// ─── byte source ─────────────────────────────────────────────────────────

/** Where to get bytes. Anything from "already in hand" or "download it". */
export type LoadSource =
  | string
  | URL
  | Request
  | Response
  | ArrayBuffer
  | Uint8Array
  | Blob
  | File
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>

/** Normalized source: either ready bytes, a stream, or a URL. */
export interface NormalizedSource {
  /** URL for resolveExternal/logs; null for anonymous bytes. */
  readonly url: string | null
  /** Ready bytes (ArrayBuffer/Uint8Array) — no fetch needed. */
  readonly bytes?: Uint8Array
  /** Stream (Response/Blob/ReadableStream/AsyncIterable) — downloaded with progress. */
  readonly stream?: AsyncIterable<Uint8Array>
  /** Content-Length if the source knows it (Response). */
  readonly totalBytes: number | null
  /** Whether fetch is needed (string/URL/Request). */
  readonly fetchUrl: string | null
  readonly fetchRequest: Request | null
}

// ─── progress and phases ─────────────────────────────────────────────────────────

export type LoadPhase =
  | 'queued'
  | 'fetching'
  | 'transforming'
  | 'parsing'
  | 'done'
  | 'cancelled'
  | 'failed'

/** Progress snapshot of a single request. */
export interface LoadProgress {
  readonly phase: LoadPhase
  readonly receivedBytes: number
  /** content-length / expectedBytes / Blob.size; null — unknown. */
  readonly totalBytes: number | null
  /** 0..1; null — unknown (no length and the parser does not report). */
  readonly fraction: number | null
}

// ─── parser context ────────────────────────────────────────────────────────

/** What the parser gets from the manager. */
export interface ParseContext {
  /** Source URL (the base for resolveExternal/resolveUrl) or null. */
  readonly sourceUrl: string | null
  /** Full input length, if known in advance. */
  readonly byteLength: number | null
  /**
   * Cancellation. Hot loops must call checkpoint() / throwIfAborted() —
   * otherwise cancel() will not stop parsing a large file.
   */
  readonly signal: AbortSignal
  /** Parse progress 0..1 (the fraction of the whole request's work, not just parsing). */
  reportProgress(fraction: number): void
  /**
   * Load an external format reference (.bin for glTF, .mtl for OBJ, textures).
   * Goes through LoadManager as a child task: in parallel with the others,
   * at a priority below the parent, cancelled together with the parent.
   * Returns "raw bytes" — parsing them is the calling parser's business.
   */
  resolveExternal(url: string): Promise<Uint8Array>
  /** Resolve a relative path against sourceUrl. */
  resolveUrl(base: string | null, rel: string): string
  /** zlib inflate (compressed FBX arrays). null — the platform cannot. */
  readonly inflate: ((bytes: Uint8Array) => Promise<Uint8Array>) | null
  /** Task identifier — for logs/meta. */
  readonly taskId: number
}

/** Input of a buffer parser. */
export interface ParseInput {
  /** The full buffer. The view is not a copy; the parser must not mutate it. */
  readonly bytes: Uint8Array
  readonly ctx: ParseContext
}

// ─── parsers and transforms ────────────────────────────────────────────────────

/**
 * A parser's streaming session: chunks arrive as the download progresses.
 * finish() is called once, when the stream is exhausted.
 */
export interface StreamSink<T> {
  push(chunk: Uint8Array): void | Promise<void>
  finish(): T | Promise<T>
}

/**
 * A format parser. T is the output asset type (MeshDocument, ImageBitmap, ...),
 * O is the parsing options (image: resize/premultiply; passed from LoadOptions).
 *
 * Buffer and streaming parsers share one interface: if `streaming` is present,
 * the manager pipes chunks into the session (parse overlaps download), otherwise
 * it accumulates readAllBytes and calls parse(). Both paths get the same ParseContext.
 */
export interface Parser<T, O = void> {
  /** Short name for the registry ('obj', 'gltf', 'image', ...). */
  readonly kind: string
  /** Parsing from a full buffer. Always supported. */
  parse(input: ParseInput, options: O): T | Promise<T>
  /** Stream session factory; its absence = the format requires a full buffer. */
  readonly streaming?: (ctx: ParseContext, options: O) => StreamSink<T>
  /** Extensions for detectKind by URL ('.obj'...). */
  readonly extensions?: readonly string[]
}

/** Chunk transform: AsyncIterable → AsyncIterable (gzip, decryption, ...). */
export interface StreamTransform {
  readonly name: string
  (chunks: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array>
}

// ─── priorities ──────────────────────────────────────────────────────────────

/**
 * Numeric priority: bigger = earlier. The bands are fixed reference points;
 * you can place your own between them (e.g. high-10).
 * We do not preempt a started task (no preemption), but cancel+reload is cheap.
 */
export const Priority = {
  /** The screen is blocked by this asset (splash, startup model). */
  critical: 1000,
  /** Needed within the next frame. */
  high: 100,
  /** Ordinary level loading. */
  normal: 50,
  /** Background — streaming in details. */
  low: 20,
  /** "Just in case" warm-up, served last. */
  prefetch: 0,
} as const

export type PriorityBand = keyof typeof Priority

// ─── request and options ──────────────────────────────────────────────────────────

/** Load options — the "broad settings" of the general-purpose loader. */
export interface LoadOptions<T = unknown, O = unknown> {
  /** A ready parser (takes precedence over kind). */
  parser?: Parser<T, O>
  /** Format name from the manager's registry ('gltf' | 'obj' | ...). */
  kind?: string
  /** Options that will go into parser.parse(..., options). */
  parserOptions?: O
  /** Priority. Default Priority.normal. */
  priority?: number
  /** Chunk transforms between the network and the parser (gzip, decrypt). */
  transforms?: StreamTransform[]
  /** External cancellation (combined with handle.cancel()). */
  signal?: AbortSignal
  /** Progress callback (called at most every ~50 ms + on phase transitions). */
  onProgress?: (progress: LoadProgress) => void
  /** Timeout for the fetch phase, ms. Default: no timeout. */
  timeoutMs?: number
  /** Retries on network errors/5xx/429. Default 0. */
  retries?: number
  /** Pause before a retry, ms (or a function of the attempt number). Default 0. */
  retryDelayMs?: number | ((attempt: number) => number)
  /** Expected size if there is no content-length. For progress and the budget. */
  expectedBytes?: number
  /** Arbitrary meta (tags, level id...) — visible in stats/logs. */
  meta?: Record<string, unknown>
}

/** Handle of an active request. */
export interface LoadHandle<T = unknown> {
  readonly id: number
  readonly url: string | null
  /** Resolves with the asset; rejects with LoadError (incl. abort/timeout). */
  readonly ready: Promise<T>
  /** Current phase. */
  readonly state: LoadPhase
  /** Progress snapshot. */
  readonly progress: LoadProgress
  /** Cancellation (idempotent). done — no-op. Rejects ready with an AbortError. */
  cancel(reason?: string): void
}

// ─── platform injections ──────────────────────────────────────────────────

/** Image decoder: bytes + options → an ImageBitmap-like object. */
export type ImageDecode = (
  bytes: Uint8Array,
  mimeType: string | null,
  options: ImageParserOptions,
) => Promise<ImageBitmapLike>

/** ImageBitmap or its replacement in a headless environment. */
export interface ImageBitmapLike {
  readonly width: number
  readonly height: number
  close?(): void
}

/** Image parsing options (forwarded to createImageBitmap). */
export interface ImageParserOptions {
  premultiplyAlpha?: 'none' | 'premultiply' | 'default'
  colorSpaceConversion?: 'none' | 'default'
  imageOrientation?: 'none' | 'flipY'
  resizeWidth?: number
  resizeHeight?: number
  resizeQuality?: 'pixelated' | 'low' | 'medium' | 'high'
}

/** Relative path resolver. */
export type UrlResolver = (base: string | null, rel: string) => string

/** Parser registry by kind ('obj', 'gltf', ...). */
export type ParserRegistry = ReadonlyMap<string, Parser<any, any>>

/** Platform capabilities; defaults are taken from globals when present. */
export interface PlatformCaps {
  fetchImpl: typeof fetch
  resolveUrl: UrlResolver
  inflate: ((bytes: Uint8Array) => Promise<Uint8Array>) | null
  decodeImage: ImageDecode | null
}
