/**
 * @rune/loaders — HTTP + decode утилиты и потоковые парсеры ассетов.
 *
 * Контракт (см. архитектурный раунд «Валидированный дизайн — слои»):
 *  - Лоадеры возвращают **декодированный** ассет (ImageBitmap / объект / ArrayBuffer).
 *  - Лоадеры НЕ знают про GPU, текстуры, кэш, рендерер.
 *  - Любая интеграция с GPU — в @rune/kit или в пользовательском коде.
 *
 * Это разделение критично: `Texture` primitive в @rune/gl принимает ImageBitmap
 * (уже загруженный), а `loadImage` здесь знает только про fetch + createImageBitmap.
 * Если их смешать — получим God-object, который лезет в сеть из GPU-примитива.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * СОСТАВ ПАКЕТА:
 *
 *  Простые утилиты (одна функция = один запрос):
 *    loadImage / loadJSON / loadArrayBuffer
 *
 *  Потоковая инфраструктура (стриминг + приоритеты):
 *    Assembler, FetchScheduler, fetchStreaming, inflateDeflate
 *
 *  Парсеры форматов (все — чистый decode, без GPU):
 *    parseGlb / parseGltfJson  — GLB 2.0 и .gltf (PBR, alphaMode, webp/avif)
 *    parseObj                   — OBJ (стриминг, группы, MTL-ссылка)
 *    parseMtl / parseMtlText    — MTL материалы
 *    parseFBX                   — FBX 7.x (скелет, скин, клипы анимаций)
 *    parseImage / sniffImageMime — изображение → ImageBitmap по magic-байтам
 *    parseConfig / parseZml / parseIni — конфиги (json/zml/ini/txt)
 *
 *  Фасад (реестр форматов + кэш + дедупликация + прогресс):
 *    AssetLoader, LoadHandle, defaultFormats, registerConfigParser
 */

// ─── Простые утилиты (fetch + decode одной функцией) ─────────────────────────

/** Опции загрузки изображения. */
export interface LoadImageOptions {
  /** Запросить определённый ImageBitmapOptions (например, resizeWidth/Height). */
  readonly imageBitmapOptions?: ImageBitmapOptions
  /** Таймаут на fetch в миллисекундах. По умолчанию — без таймаута. */
  readonly timeoutMs?: number
  /** AbortSignal из вызывающего кода — для отмены. */
  readonly signal?: AbortSignal
}

/**
 * Загружает изображение по URL и декодирует в ImageBitmap.
 *
 * Возвращает ImageBitmap — нативный браузерный декодированный растр, который
 * GPU-примитив может принять напрямую (WebGPU: copyExternalImageToTexture,
 * WebGL2: texImage2D overload). Никакой GPU-работы здесь не происходит.
 *
 * @throws TypeError если ответ не ok или content-type не изображение.
 * @throws AbortError если таймаут или signal отменён.
 */
export async function loadImage(url: string, options: LoadImageOptions = {}): Promise<ImageBitmap> {
  const blob = await fetchBlob(url, { timeoutMs: options.timeoutMs, signal: options.signal })
  // Браузер сам определяет декодер по MIME-типу. ImageBitmap — это
  // «декодированные пиксели + opaque handle» — идеально для GPU.
  return createImageBitmap(blob, options.imageBitmapOptions ?? {})
}

/**
 * Загружает JSON по URL. Для атлас-метаданных (frames), конфигов, GLB-manifest'ов.
 *
 * @throws SyntaxError если ответ не валидный JSON.
 */
export async function loadJSON<T = unknown>(url: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
  const blob = await fetchBlob(url, options)
  const text = await blob.text()
  try {
    return JSON.parse(text) as T
  } catch (err) {
    throw new SyntaxError(`loadJSON: ${url} — невалидный JSON: ${(err as Error).message}`, { cause: err })
  }
}

/**
 * Загружает ArrayBuffer (для GLB, бинарных данных, сырых пикселей).
 *
 * @throws TypeError если ответ не ok.
 */
export async function loadArrayBuffer(url: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ArrayBuffer> {
  const blob = await fetchBlob(url, options)
  return blob.arrayBuffer()
}

// ─── Реэкспорт потоковой инфраструктуры ──────────────────────────────────────

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

// ─── Реэкспорт парсеров форматов ─────────────────────────────────────────────

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

// ─── Реэкспорт фасада загрузки ───────────────────────────────────────────────

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

// ─── Реэкспорт байтовых утилит ───────────────────────────────────────────────

export { asciiDecode, align4, clamp, isWhitespace, nowMs, parseDecimal, CHAR } from './bytes.ts'

// ─── helpers ─────────────────────────────────────────────────────────────────

async function fetchBlob(url: string, options: { timeoutMs?: number; signal?: AbortSignal }): Promise<Blob> {
  // Композитный signal: внешний + наш timeout
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
// Слой Task 88+ (AssetLibrary / планировщик / типы ассетов)
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

// LoadManager (Task 88): приоритеты/отмена/прогресс/бюджеты/группы enough(N)
export { createLoadManager } from './core/manager.ts'
export type { LoadManagerOptions } from './core/manager.ts'
export { LoadError, ParseError, UnsupportedError, abortError, throwIfAborted } from './core/errors.ts'
export { sniffKind, type SniffResult } from './core/util.ts'
export { createParserRegistry, type ParserRegistryOptions } from './registry.ts'
export type { DracoGeometryDecoder } from './gltf.ts'
export type { MtlLibrary } from './mtl.ts'
