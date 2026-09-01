/**
 * Caps — модуль возможностей бэкенда (M4, DESIGN.md §11.4 + §5.2).
 *
 * Контракт (досье v1.0 §11.4, добавлено в addendum §5.2):
 *  - caps.has(FeatureId): boolean            — фича доступна нативно?
 *  - caps.format(f, axis): FormatSupport    — 6-осная матрица форматов
 *  - caps.path(name): PathSupport           — переносимость present-путей
 *  - caps.ext(name): unknown | null        — escape-hatch к сырому расширению
 *  - caps.stats(): RendererStats           — cpuMs, gpuMs, memoryEstimate, hit-rate
 *  - caps.invalidate(): void                — сброс кэша (после device-loss / backend-swap)
 *
 * Дизайн: backend-агностический каркас в @rune/core. Backend (WebGL2 / WebGPU)
 * пробитует реальную среду и поставляет `CapsQuery` — структура с measured
 * capabilities. `createCaps(query, statsProvider)` строит замкнутый объект с
 * методами интерфейса.
 *
 * RendererStats — runtime-метрики, обновляются рендерером каждый кадр.
 * cpuMs — performance.now() обвязка вокруг frame callback (дешёво, везде).
 * gpuMs — требует EXT_disjoint_timer_query (WebGL2) или pipeline-statistics-query
 * (WebGPU feature). Без расширения = null — честно, не фейковый 0.
 * memoryEstimate — ручной счётчик: размер текстур (w*h*channels*bytesPerChannel)
 * + размер буферов. В @rune/webgl2 realGL ведётся Map<textureId, GPUTexture>
 * — там же считаем bytes.
 *
 * Контракт 5 (честность гейтов): недоступная возможность — null или 'none'
 * в матрице, а не молчаливое падение. caps.has('float-blend') === false
 * на Mali без EXT_float_blend — юзер может гейтить код на это.
 */

// ─── FeatureId — канонические имена фич ──────────────────────────────────────
//
// Соответствие WebGPU features ↔ FeatureId (по канону):
//   texture-compression-astc  → 'astc'
//   texture-compression-bc    → 'bc1' | 'bc3' | 'bc7' (один флаг → 3 FeatureId'а)
//   texture-compression-etc2  → 'etc2'
//   depth-clamping            → 'depth-clamp'
//   timestamp-query           → 'timestamp-query'
//   pipeline-statistics-query → 'pipeline-stats'
//   occlusion-query           → 'occlusion-query'
//   bgra8unorm-storage        → 'bgra8-storage'
//   float32-filterable        → 'float32-filterable'
//
// Соответствие WebGL2 extensions ↔ FeatureId:
//   WEBGL_compressed_texture_astc  → 'astc'
//   WEBGL_compressed_texture_s3tc  → 'bc1' | 'bc3' (BC1=RGB DXT1, BC3=RGBA DXT5)
//   EXT_texture_compression_rgtc   → 'bc4' | 'bc5'
//   WEBGL_compressed_texture_etc   → 'etc2'
//   WEBGL_compressed_texture_pvrtc → 'pvrtc'
//   EXT_color_buffer_float         → 'float32-render' | 'float32-blend'
//   EXT_float_blend                → 'float32-blend'
//   OES_texture_float              → 'float32-texture'
//   OES_texture_half_float         → 'float16-texture'
//   EXT_texture_filter_anisotropic → 'anisotropic'
//   ANGLE_instanced_arrays          → 'instancing' (но в WebGL2 — нативно!)
//   EXT_disjoint_timer_query_webgl2 → 'timestamp-query'
//   OES_texture_float_linear       → 'float32-filterable'
//
// 'instancing' в WebGL2 нативно (gl.drawArraysInstanced), без расширения.
// В WebGPU — всегда есть (drawIndirect/vertex buffers), но limits.maxDrawBuffers
// может быть 0 в software-fallback.

export type FeatureId =
  // Compression
  | 'astc'
  | 'etc2'
  | 'bc1'
  | 'bc3'
  | 'bc4'
  | 'bc5'
  | 'bc7'
  | 'pvrtc'
  // Texture formats
  | 'float16-texture'
  | 'float32-texture'
  | 'float16-render'
  | 'float32-render'
  | 'float16-blend'
  | 'float32-blend'
  | 'float32-filterable'
  | 'rg11b10ufloat-render'
  | 'shared-exponent'
  // Filtering / sampling
  | 'anisotropic'
  | 'linear-filter-half-float'
  | 'linear-filter-float'
  // Geometry / draw
  | 'instancing'
  | 'draw-indirect'
  | 'multi-draw-indirect'
  | 'base-instance'
  // Compute
  | 'compute'
  | 'storage-buffer'
  | 'storage-texture'
  // Render
  | 'msaa-2x'
  | 'msaa-4x'
  | 'msaa-8x'
  | 'msaa-16x'
  | 'depth-texture'
  | 'depth-clamp'
  | 'wireframe'
  // Queries / timing
  | 'timestamp-query'
  | 'occlusion-query'
  | 'pipeline-stats'
  // Buffer / memory
  | 'map-buffer'
  | 'persistent-mapping'
  // Surfaces
  | 'offscreen-canvas'
  | 'video-frame'
  | 'bgra8-storage'

/** Допускаются строковые alias'ы для расширений, не перечисленных в FeatureId. */
export type FeatureName = FeatureId | (string & {})

// ─── FormatAxis — 6 осей матрицы переносимости форматов ──────────────────────

export type FormatAxis =
  | 'sampled'    // текстурирование (texture() в шейдере)
  | 'render'     // как render target (color attachment)
  | 'blend'      // blending работает при использовании как render target
  | 'filter'     // linear filtering доступен (не только nearest)
  | 'msaa'       // multisample render target
  | 'storage'    // storage texture (imageStore / writeonly storage)

// ─── FormatSupport — уровень поддержки ───────────────────────────────────────

export type FormatSupport =
  | 'native'    // GPU нативно поддерживает
  | 'fallback'  // эмуляция (медленно) — не для production hot path
  | 'none'      // не поддерживается

// ─── PathSupport — переносимость present-путей (упрощённо для M4) ────────────
//
// Полный PathRegistry с PathState (healthy/degraded/disabled через Decay.ratio)
// — это M8 (#61, #62). В M4 — упрощённый PathSupport: supported/unsupported.
// RendererStats и degradationRatio появятся в M8 с PathState.

export type PathSupport = 'supported' | 'unsupported' | 'unknown'

// ─── RendererStats — runtime-метрики кадра ──────────────────────────────────
//
// Обновляются рендерером на каждый кадр. Snapshot через caps.stats().
// hitRate — пока всегда 1.0 (нет кэша компиляции шейдеров с инвалидирующимся
// состоянием); будет Wiring когда появятся cache-invalidation триггеры.

export interface RendererStats {
  /** CPU-side время на обработку кадра (мс). Включает: frame callback, recorder
   *  push, dispatch Tape. Не включает rAF-wait. Измеряется через performance.now(). */
  readonly cpuMs: number
  /** GPU-side время на отрисовку (мс). null если нет расширения timer-query
   *  (EXT_disjoint_timer_query / pipeline-statistics-query). Честно null —
   *  не фейковый 0. */
  readonly gpuMs: number | null
  /** Оценка занятой GPU-памяти (байт). Сумма: textures (w*h*channels*bpc) +
   *  vertex buffers (data.length * 4 для Float32Array). Не точная — не учитывает
   *  mip-цепи (×1.33) и alignment/padding. Достаточно для dashboards. */
  readonly memoryEstimate: number
  /** Кол-во draw calls в последнем кадре. */
  readonly drawCalls: number
  /** Счётчик кадров с момента старта. */
  readonly frameCount: number
  /** Cache hit-rate (0..1). Пока всегда 1.0 — нет инвалидаций. */
  readonly hitRate: number
}

// ─── CapsQuery — что backend пробирует и поставляет в createCaps ─────────────

/**
 * Backend-зависимая часть Caps. Заполняется webgl2/capsProbe или webgpu/capsProbe
 * на старте рендерера. createCaps(query) строит замкнутый Caps-объект.
 */
export interface CapsQuery {
  /** Множество доступных FeatureId. */
  readonly features: ReadonlySet<FeatureName>
  /** Карта format × axis → support. Ключ — `${format}|${axis}`. */
  readonly formatMatrix: ReadonlyMap<string, FormatSupport>
  /** Карта present-path → support. */
  readonly paths: ReadonlyMap<string, PathSupport>
  /** Карта имени расширения → raw object (getExtension / features.has). */
  readonly extensions: ReadonlyMap<string, unknown>
  /** Лимиты адаптера (maxTextureSize, maxBufferSize, maxTextureUnits, etc.). */
  readonly limits: Readonly<Record<string, number>>
  /** Бэкенд-строка: 'webgl2' | 'webgpu' | 'webgl1' | 'software'. */
  readonly backend: string
}

// ─── StatsProvider — callback от рендерера для свежих метрик ─────────────────

export type StatsProvider = () => RendererStats

// ─── Caps — публичный интерфейс (досье §11.4) ───────────────────────────────

export interface Caps {
  /** Доступна ли фича нативно (не 'fallback'). */
  has(f: FeatureName): boolean
  /** Поддержка формата по оси. */
  format(f: string, axis: FormatAxis): FormatSupport
  /** Переносимость present-пути (упрощённо для M4). */
  path(name: string): PathSupport
  /** Raw расширение (escape-hatch). null если недоступно. */
  ext(name: string): unknown | null
  /** Свежие метрики кадра. */
  stats(): RendererStats
  /** Лимит адаптера (maxTextureSize2D, maxBufferSize, ...). */
  limit(name: string): number | null
  /** Бэкенд. */
  readonly backend: string
  /** Сброс кэша — вызвать после device-loss / backend-swap. */
  invalidate(): void
}

// ─── createCaps — фабрика ────────────────────────────────────────────────────
//
// Принимает query (результат probing) и statsProvider (callback от рендерера).
// statsProvider может быть null на момент createCaps (рендерер ещё не запустил
// frame loop) — stats() вернёт zero-state, потом statsProvider подключится.

const ZERO_STATS: RendererStats = {
  cpuMs: 0,
  gpuMs: null,
  memoryEstimate: 0,
  drawCalls: 0,
  frameCount: 0,
  hitRate: 1.0,
}

export function createCaps(query: CapsQuery, statsProvider: StatsProvider | null = null): Caps {
  // Snapshot запроса на момент создания. invalidate() — пересоздаёт snapshot
  // (например, после device-loss юзер пере-пробивает и пересоздаёт caps).
  let snapshot = query
  let statsRef = statsProvider

  function formatKey(f: string, axis: FormatAxis): string {
    return `${f}|${axis}`
  }

  return {
    has(f) {
      return snapshot.features.has(f)
    },
    format(f, axis) {
      return snapshot.formatMatrix.get(formatKey(f, axis)) ?? 'none'
    },
    path(name) {
      return snapshot.paths.get(name) ?? 'unknown'
    },
    ext(name) {
      return snapshot.extensions.get(name) ?? null
    },
    stats() {
      if (!statsRef) return ZERO_STATS
      return statsRef()
    },
    limit(name) {
      const v = snapshot.limits[name]
      return v === undefined ? null : v
    },
    get backend() {
      return snapshot.backend
    },
    invalidate() {
      // Помечаем snapshot как требующий перепробинга. Реальный reprobe
      // делает бэкенд (вызывает probeGLCaps / probeGPUCaps заново и
      // создаёт новый Caps). invalidate() — соглашение: вызвать на
      // device-lost / contextlost.
      // Здесь просто сбрасываем statsProvider — юзер может передать новый.
      statsRef = null
    },
  }
}

// ─── StatsCollector — CPU-side измерение времени кадра ──────────────────────
//
// Рендерер обвязывает frame callback в statsCollector.beginFrame()/endFrame().
// beginFrame возвращает timer который endFrame() читает для cpuMs. drawCalls
// и memoryEstimate обновляются отдельными setters — recorder постит drawCall count
// после каждой записи, realGL постит memoryEstimate после createTexture/createBuffer.
//
// gpuMs: если statsCollector подключен к GpuTimer (setGpuTimer), то endFrame()
// дёргает timer.result() предыдущего кадра (GPU timer async — результат приходит
// не сразу). Это даёт gpuMs со сдвигом в 1 кадр (типичный паттерн в GPU
// profiling: frame N дёргает timer, frame N+1 читает результат). Без GpuTimer
// gpuMs = null (честно, не фейковый 0).

export interface StatsCollector {
  beginFrame(): void
  endFrame(): void
  addDrawCall(): void
  addMemory(bytes: number): void
  subMemory(bytes: number): void
  /** Текущий snapshot — то, что возвращает caps.stats(). */
  snapshot(): RendererStats
  /** Сброс счётчиков на кадр (вызывается beginFrame). */
  resetForFrame(): void
  /** Подключить GPU-timer (если доступен). null — нет расширения, gpuMs = null. */
  setGpuTimer(timer: GpuTimer | null): void
}

// ─── GpuTimer — GPU-side измерение времени кадра ──────────────────────────────
//
// GPU timer-query работает асинхронно: begin()/end() вписывают метки в
// command stream GPU, result() читает результат когда GPU дойдёт.
// Из-за этого типичный паттерн — frame N вызывает begin/end, frame N+1
// дёргает result() и получает gpuMs.
//
// WebGL2: EXT_disjoint_timer_query_webgl2 — beginQuery(TIME_ELAPSED)/endQuery,
// результат читается через getQueryObject в следующем кадре. Если disjoint=GPU
// reset — отбрасываем, пере-запускаем.
//
// WebGPU: timestamp-query feature — beginEndWriteTimestamp, результат читается
// через resolveQuerySet в буфер. Реализован в packages/webgpu/src/gpuTimer.ts
// (createGpuGpuTimer) и подключается в realGPU.ts при наличии feature
// 'timestamp-query' на адаптере. На адаптерах без feature gpuTimer=null, gpuMs=null.

export interface GpuTimer {
  /** Старт таймера в текущем кадре. beginFrame()/endFrame() вызывают
   *  это между собой. idempotent: если уже запущен — no-op. */
  begin(): void
  /** Финиш таймера. Закрывает query. */
  end(): void
  /** Читает результат предыдущего кадра. null если:
   *   - timer не запускался (первый кадр)
   *   - GPU disjoint (reset) — отбрасываем
   *   - расширение недоступно
   *  Возвращает ms (float). Со сдвигом в 1 кадр. */
  result(): number | null
}

export function createStatsCollector(now: () => number = () => performance.now()): StatsCollector {
  let frameStart = 0
  let cpuMs = 0
  let drawCalls = 0
  let memoryEstimate = 0
  let frameCount = 0
  let gpuTimer: GpuTimer | null = null
  let gpuMs: number | null = null

  return {
    beginFrame() {
      frameStart = now()
      drawCalls = 0
      cpuMs = 0
      frameCount++
      // GPU timer: begin на старте кадра (под обвязку frame callback).
      // result() читаем НЕ здесь (он асинхронный) — а в snapshot(), после
      // того как endFrame уже закрыл query предыдущего кадра.
      if (gpuTimer !== null) {
        // Читаем результат ПРЕДЫДУЩЕГО кадра (он был закрыт в past endFrame).
        const prev = gpuTimer.result()
        gpuMs = prev
        gpuTimer.begin()
      }
    },
    endFrame() {
      cpuMs = now() - frameStart
      if (gpuTimer !== null) {
        gpuTimer.end()
      }
    },
    addDrawCall() {
      drawCalls++
    },
    addMemory(bytes) {
      memoryEstimate += bytes
    },
    subMemory(bytes) {
      memoryEstimate = Math.max(0, memoryEstimate - bytes)
    },
    snapshot() {
      return {
        cpuMs,
        gpuMs: gpuTimer === null ? null : gpuMs,
        memoryEstimate,
        drawCalls,
        frameCount,
        hitRate: 1.0,
      }
    },
    resetForFrame() {
      drawCalls = 0
    },
    setGpuTimer(timer) {
      gpuTimer = timer
      gpuMs = timer === null ? null : gpuMs
    },
  }
}
