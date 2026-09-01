/**
 * core/types.ts — контракт слоя загрузки @rune/loaders.
 *
 * Дизайн-принципы (см. DESIGN.md §9.2 «Zero-main-thread путь ассета» #12):
 *  1. **Ноль зависимостей.** Пакет не зависит ни от @rune/core, ни от @rune/gl —
 *     он одинаково встраивается в голое ядро (воркер, headless) и в сценовый
 *     граф. Все платформенные вещи (fetch, createImageBitmap, inflate,
 *     резолвинг URL) — injectable с дефолтом «если есть в глобале».
 *  2. **Байты, не текст.** Парсеры едят Uint8Array/AsyncIterable<Uint8Array>.
 *     Строки — только там, где формат текстовый по своей природе (JSON, .obj).
 *  3. **Пайпы.** source → (stream) → transforms → parser. Парсеры с
 *     `streaming`-фабрикой едят чанки по мере скачивания — разбор перекрывает
 *     сеть. Буферные парсеры получают накопленный буфер.
 *  4. **Нейтральные данные.** Меш-форматы нормализуются в MeshDocument
 *     (formats/mesh.ts) — plain data без GPU-объектов. Рендер-слой сам решает,
 *     как его загнать в конвейер.
 */

// ─── источник байтов ─────────────────────────────────────────────────────────

/** Откуда брать байты. Всё, что угодно из «уже есть в руках» или «скачай». */
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

/** Нормализованный источник: либо готовые байты, либо поток, либо URL. */
export interface NormalizedSource {
  /** URL для resolveExternal/логов; null для анонимных байтов. */
  readonly url: string | null
  /** Готовые байты (ArrayBuffer/Uint8Array) — fetch не нужен. */
  readonly bytes?: Uint8Array
  /** Поток (Response/Blob/ReadableStream/AsyncIterable) — качаем с прогрессом. */
  readonly stream?: AsyncIterable<Uint8Array>
  /** Content-Length, если источник его знает (Response). */
  readonly totalBytes: number | null
  /** Нужен ли fetch (string/URL/Request). */
  readonly fetchUrl: string | null
  readonly fetchRequest: Request | null
}

// ─── прогресс и фазы ─────────────────────────────────────────────────────────

export type LoadPhase =
  | 'queued'
  | 'fetching'
  | 'transforming'
  | 'parsing'
  | 'done'
  | 'cancelled'
  | 'failed'

/** Снимок прогресса одного запроса. */
export interface LoadProgress {
  readonly phase: LoadPhase
  readonly receivedBytes: number
  /** content-length / expectedBytes / Blob.size; null — неизвестно. */
  readonly totalBytes: number | null
  /** 0..1; null — неизвестно (нет длины и парсер не репортит). */
  readonly fraction: number | null
}

// ─── контекст парсера ────────────────────────────────────────────────────────

/** Что парсер получает от менеджера. */
export interface ParseContext {
  /** URL исходника (база для resolveExternal/resolveUrl) или null. */
  readonly sourceUrl: string | null
  /** Полная длина входа, если известна заранее. */
  readonly byteLength: number | null
  /**
   * Отмена. Горячие циклы обязаны звать checkpoint() / throwIfAborted() —
   * иначе cancel() не остановит разбор большого файла.
   */
  readonly signal: AbortSignal
  /** Прогресс разбора 0..1 (доля всей работы запроса, не только парсинга). */
  reportProgress(fraction: number): void
  /**
   * Загрузить внешний референс формата (.bin у glTF, .mtl у OBJ, texture).
   * Идёт через LoadManager дочерней задачей: параллельно с остальными,
   * приоритетом ниже родителя, отменяется вместе с родителем.
   * Возвращает «сырые байты» — их разбор — дело вызывающего парсера.
   */
  resolveExternal(url: string): Promise<Uint8Array>
  /** Разрешить относительный путь от sourceUrl. */
  resolveUrl(base: string | null, rel: string): string
  /** Распаковка zlib (сжатые массивы FBX). null — платформа не умеет. */
  readonly inflate: ((bytes: Uint8Array) => Promise<Uint8Array>) | null
  /** Идентификатор задачи — для логов/меты. */
  readonly taskId: number
}

/** Вход буферного парсера. */
export interface ParseInput {
  /** Полный буфер. View — не копия; парсеру нельзя его мутировать. */
  readonly bytes: Uint8Array
  readonly ctx: ParseContext
}

// ─── парсеры и трансформы ────────────────────────────────────────────────────

/**
 * Стриминговая сессия парсера: чанки прилетают по мере скачивания.
 * finish() вызывается один раз, когда поток иссяк.
 */
export interface StreamSink<T> {
  push(chunk: Uint8Array): void | Promise<void>
  finish(): T | Promise<T>
}

/**
 * Парсер формата. T — тип ассета на выходе (MeshDocument, ImageBitmap, ...),
 * O — опции разбора (image: resize/premultiply; передаются из LoadOptions).
 *
 * Буферные и стриминговые парсеры — один интерфейс: если есть `streaming`,
 * менеджер пайпит чанки в сессию (parse overlaps download), иначе копит
 * readAllBytes и зовёт parse(). Оба пути получают одинаковый ParseContext.
 */
export interface Parser<T, O = void> {
  /** Короткое имя для реестра ('obj', 'gltf', 'image', ...). */
  readonly kind: string
  /** Разбор из полного буфера. Всегда поддерживается. */
  parse(input: ParseInput, options: O): T | Promise<T>
  /** Фабрика стрим-сессии; отсутствие = формат требует полного буфера. */
  readonly streaming?: (ctx: ParseContext, options: O) => StreamSink<T>
  /** Расширения для detectKind по URL ('.obj'...). */
  readonly extensions?: readonly string[]
}

/** Трансформ чанков: AsyncIterable → AsyncIterable (gzip, дешифровка, ...). */
export interface StreamTransform {
  readonly name: string
  (chunks: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array>
}

// ─── приоритеты ──────────────────────────────────────────────────────────────

/**
 * Числовой приоритет: больше = раньше. Полосы — фиксированные точки отсчёта,
 * между ними можно ставить свои (например high-10).
 * От запуска не отбираем (нет preemption), но cancel+reload — дёшево.
 */
export const Priority = {
  /** Экран блокирован этим ассетом (сплэш, стартовая модель). */
  critical: 1000,
  /** Нужно в ближайший кадр. */
  high: 100,
  /** Обычная загрузка уровня. */
  normal: 50,
  /** Фон — догрузка деталей. */
  low: 20,
  /** Прогрев «на всякий случай», отдаётся последним. */
  prefetch: 0,
} as const

export type PriorityBand = keyof typeof Priority

// ─── запрос и опции ──────────────────────────────────────────────────────────

/** Опции загрузки — «широкие настройки» общего лоадера. */
export interface LoadOptions<T = unknown, O = unknown> {
  /** Готовый парсер (приоритетнее kind). */
  parser?: Parser<T, O>
  /** Имя формата из реестра менеджера ('gltf' | 'obj' | ...). */
  kind?: string
  /** Опции, которые уйдут в parser.parse(..., options). */
  parserOptions?: O
  /** Приоритет. Default Priority.normal. */
  priority?: number
  /** Чанковые трансформы между сетью и парсером (gzip, decrypt). */
  transforms?: StreamTransform[]
  /** Внешняя отмена (объединяется с handle.cancel()). */
  signal?: AbortSignal
  /** Прогресс-колбэк (вызывается не чаще ~50 мс + на фазовых переходах). */
  onProgress?: (progress: LoadProgress) => void
  /** Таймаут на фазу fetch, мс. Default: без таймаута. */
  timeoutMs?: number
  /** Ретраи при сетевых ошибках/5xx/429. Default 0. */
  retries?: number
  /** Пауза перед ретраем, мс (или функция номера попытки). Default 0. */
  retryDelayMs?: number | ((attempt: number) => number)
  /** Ожидаемый размер, если content-length не будет. Для прогресса и бюджета. */
  expectedBytes?: number
  /** Произвольная мета (теги, id уровня...) — видна в stats/логах. */
  meta?: Record<string, unknown>
}

/** Хэндл активного запроса. */
export interface LoadHandle<T = unknown> {
  readonly id: number
  readonly url: string | null
  /** Резолвится ассетом; реджектится LoadError (в т.ч. abort/timeout). */
  readonly ready: Promise<T>
  /** Текущая фаза. */
  readonly state: LoadPhase
  /** Снимок прогресса. */
  readonly progress: LoadProgress
  /** Отмена (идемпотентна). done — no-op. Реджектит ready AbortError'ом. */
  cancel(reason?: string): void
}

// ─── платформенные инъекции ──────────────────────────────────────────────────

/** Декодер картинок: байты + опции → ImageBitmap-подобное. */
export type ImageDecode = (
  bytes: Uint8Array,
  mimeType: string | null,
  options: ImageParserOptions,
) => Promise<ImageBitmapLike>

/** ImageBitmap или его замена в headless-окружении. */
export interface ImageBitmapLike {
  readonly width: number
  readonly height: number
  close?(): void
}

/** Опции разбора изображения (пробрасываются в createImageBitmap). */
export interface ImageParserOptions {
  premultiplyAlpha?: 'none' | 'premultiply' | 'default'
  colorSpaceConversion?: 'none' | 'default'
  imageOrientation?: 'none' | 'flipY'
  resizeWidth?: number
  resizeHeight?: number
  resizeQuality?: 'pixelated' | 'low' | 'medium' | 'high'
}

/** Резолвер относительных путей. */
export type UrlResolver = (base: string | null, rel: string) => string

/** Реестр парсеров по kind ('obj', 'gltf', ...). */
export type ParserRegistry = ReadonlyMap<string, Parser<any, any>>

/** Платформенные возможности, дефолты берутся из глобалей, если есть. */
export interface PlatformCaps {
  fetchImpl: typeof fetch
  resolveUrl: UrlResolver
  inflate: ((bytes: Uint8Array) => Promise<Uint8Array>) | null
  decodeImage: ImageDecode | null
}
