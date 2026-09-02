/**
 * @rune/loaders — HTTP + decode utilities and streaming asset parsers.
 *
 * Contract (see the architecture round "Validated design — layers"):
 *  - Loaders return a **decoded** asset (ImageBitmap / object / ArrayBuffer).
 *  - Loaders do NOT know about the GPU, textures, cache, renderer.
 *  - Any GPU integration lives in @rune/kit or in user code.
 *
 * This separation is critical: the `Texture` primitive in @rune/gl accepts an ImageBitmap
 * (already loaded), while `loadImage` here knows only about fetch + createImageBitmap.
 * Mixing them would produce a God-object that reaches into the network from a GPU primitive.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PACKAGE COMPOSITION:
 *
 *  Simple utilities (one function = one request):
 *    loadImage / loadJSON / loadArrayBuffer
 *
 *  Streaming infrastructure (streaming + priorities):
 *    Assembler, FetchScheduler, fetchStreaming, inflateDeflate
 *
 *  Format parsers (all of them pure decode, no GPU):
 *    parseGlb / parseGltfJson  — GLB 2.0 and .gltf (PBR, alphaMode, webp/avif)
 *    parseObj                   — OBJ (streaming, groups, MTL reference)
 *    parseMtl / parseMtlText    — MTL materials
 *    parseFBX                   — FBX 7.x (skeleton, skin, animation clips)
 *    parseImage / sniffImageMime — image → ImageBitmap by magic bytes
 *    parseConfig / parseZml / parseIni — configs (json/zml/ini/txt)
 *
 *  Facade (format registry + cache + deduplication + progress):
 *    AssetLoader, LoadHandle, defaultFormats, registerConfigParser
 */

// ─── Simple utilities (fetch + decode in one function) ─────────────────────────

/** Image load options. */
export interface LoadImageOptions {
  /** Request specific ImageBitmapOptions (e.g., resizeWidth/Height). */
  readonly imageBitmapOptions?: ImageBitmapOptions
  /** fetch timeout in milliseconds. Default — no timeout. */
  readonly timeoutMs?: number
  /** AbortSignal from the calling code — for cancellation. */
  readonly signal?: AbortSignal
}

/**
 * Loads an image by URL and decodes it into an ImageBitmap.
 *
 * Returns an ImageBitmap — the browser's native decoded raster, which
 * a GPU primitive can accept directly (WebGPU: copyExternalImageToTexture,
 * WebGL2: texImage2D overload). No GPU work happens here.
 *
 * @throws TypeError if the response is not ok or content-type is not an image.
 * @throws AbortError on timeout or if the signal is cancelled.
 */
export async function loadImage(url: string, options: LoadImageOptions = {}): Promise<ImageBitmap> {
  const blob = await fetchBlob(url, { timeoutMs: options.timeoutMs, signal: options.signal })
  // The browser itself picks the decoder by MIME type. An ImageBitmap is
  // "decoded pixels + an opaque handle" — perfect for the GPU.
  return createImageBitmap(blob, options.imageBitmapOptions ?? {})
}

/**
 * Loads JSON by URL. For atlas metadata (frames), configs, GLB manifests.
 *
 * @throws SyntaxError if the response is not valid JSON.
 */
export async function loadJSON<T = unknown>(url: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
  const blob = await fetchBlob(url, options)
  const text = await blob.text()
  try {
    return JSON.parse(text) as T
  } catch (err) {
    throw new SyntaxError(`loadJSON: ${url} — invalid JSON: ${(err as Error).message}`, { cause: err })
  }
}

/**
 * Loads an ArrayBuffer (for GLB, binary data, raw pixels).
 *
 * @throws TypeError if the response is not ok.
 */
export async function loadArrayBuffer(url: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ArrayBuffer> {
  const blob = await fetchBlob(url, options)
  return blob.arrayBuffer()
}

// ─── Re-export of the streaming infrastructure ──────────────────────────────────────

export {
  Assembler,
  FetchScheduler,
  fetchStreaming,
  inflateDeflate,
  signalAbortError,
  toAbortError,
  isAbortError,
  allocJobId,
  type AssemblerOptions,
  type FetchStreamingOptions,
  type OnBytes,
  type SchedulerJob,
  type SchedulerStats,
  type StreamingResponse,
} from './assembler.ts'

// ─── Re-export of format parsers ─────────────────────────────────────────────

export {
  parseGlb,
  parseGltfJson,
  isGltfJson,
  type CreateBitmap,
  type DracoDecoder,
  type GltfBounds,
  type GltfImage,
  type GltfMaterial,
  type GltfMesh,
  type GltfModel,
  type GltfNode,
  type GltfParseOptions,
  type GltfPhase,
  type GltfPrimitive,
  type GltfSampler,
  type GltfStats,
} from './gltf.ts'

export { parseObj, type ObjGroup, type ObjModel, type ObjParseOptions, type ObjStats } from './obj.ts'

export {
  parseMtl,
  parseMtlText,
  type MtlMaterial,
  type MtlModel,
  type MtlStats,
} from './mtl.ts'

export { parseFBX, quatFromEulerXYZ, invert4, type FbxClip, type FbxJoint, type FbxMesh, type FbxModel, type FbxSkin, type FbxSkeleton, type FbxTrackR, type FbxTrackT } from './fbx.ts'

export {
  parseImage,
  sniffImageMime,
  defaultCreateBitmap,
  type ImageAsset,
  type ImageParseOptions,
} from './image.ts'

export {
  parseConfig,
  parseZml,
  parseIni,
  registerConfigParser,
  configParserOf,
  type ConfigParseOptions,
  type ConfigParser,
  type ConfigSection,
  type ConfigValue,
} from './config.ts'

// ─── Re-export of the loading facade ───────────────────────────────────────────────

export {
  AssetLoader,
  LoadHandle,
  PHASE_WEIGHTS,
  defaultFormats,
  extensionOf,
  isBinaryFbx,
  resolveUrl,
  type AssetLoaderOptions,
  type FormatDescriptor,
  type LoadGroup,
  type LoadOptions,
  type LoadPhase,
  type LoadProgress,
  type LoaderEvent,
  type LoaderStats,
  type OnAssetPhase,
  type ParserContext,
  type TransformHook,
} from './registry.ts'

// ─── Re-export of byte utilities ───────────────────────────────────────────────

export { asciiDecode, align4, clamp, isWhitespace, nowMs, parseDecimal, CHAR } from './bytes.ts'

// ─── helpers ─────────────────────────────────────────────────────────────────

async function fetchBlob(url: string, options: { timeoutMs?: number; signal?: AbortSignal }): Promise<Blob> {
  // Composite signal: external + our timeout
  const controller = new AbortController()
  const externalAbort = options.signal?.addEventListener('abort', () => controller.abort()) ?? (() => {})

  const timeoutId = options.timeoutMs !== undefined
    ? setTimeout(() => controller.abort(new DOMException('loadImage timeout', 'TimeoutError')), options.timeoutMs)
    : null

  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) {
      throw new TypeError(`loadBlob: ${url} — HTTP ${response.status} ${response.statusText}`)
    }
    return await response.blob()
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId)
    // cleanup listener
    if (typeof externalAbort === 'function') externalAbort()
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Task 88+ layer (AssetLibrary / scheduler / asset types)
// ══════════════════════════════════════════════════════════════════════════

export {
  AssetLibrary,
  type LoadedAsset,
  type AssetLibraryOptions,
  type ParserFn,
} from './library.ts'
export { LoadScheduler, type SchedulerOptions } from './scheduler.ts'
export type {
  AssetPhase,
  AssetProgress,
  AssetTransform,
  AssetMeta,
  AssetHandle,
  LibraryEvent,
  LibraryStats,
} from './types.ts'

// LoadManager (Task 88): priorities/cancel/progress/budgets/groups enough(N)
export { createLoadManager } from './core/manager.ts'
export type { LoadManagerOptions } from './core/manager.ts'
export { LoadError, ParseError, UnsupportedError, abortError, throwIfAborted } from './core/errors.ts'
export { sniffKind, type SniffResult } from './core/util.ts'
export { createParserRegistry, type ParserRegistryOptions } from './registry.ts'
export type { DracoGeometryDecoder } from './gltf.ts'
export type { MtlLibrary } from './mtl.ts'
