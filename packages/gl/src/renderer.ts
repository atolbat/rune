/**
 * Единый createRenderer — надстройка над WebGL2/WebGPU с авто-выбором бэкенда.
 *
 * Контракт (см. DESIGN.md §9.12):
 * 1. createRenderer(opts) — СИНХРОННЫЙ, никакой GPU-работы. Возвращает обёртку.
 * 2. command(spec) до .start(): записывает спек, возвращает proxy CompiledCommand.
 * 3. frame(cb) до .start(): записывает колбэк.
 * 4. start() — АСИНХРОННЫЙ: probe hardware → resolveBackend → создаёт inner
 *    нужного бэкенда → проксирует pending specs/frames → запускает rAF.
 * 5. command(spec) после .start(): late-reject — если spec.shader не покрывает
 *    выбранный бэкенд, кидает actionable-ошибку.
 * 6. surface/pass/texture — требуют .start() (нужен GL/GPU-контекст).
 *
 * Lazy discovery заменяет предобъявление `specs: DrawSpec[]` из раунда 2
 * (бойлерплейт «спеки дважды»). Спеки собираются автоматически из того,
 * что юзер реально вызывает в command(). Решение принимается на .start() —
 * это и есть «pre-check до первого рендра».
 *
 * BackendResolutionError — выбрасывается из .start() если chosen === null.
 * Несёт структурированный BackendDecision с verdicts и coverage.
 */

import type { AutoDrawSpec, BackendDecision, BackendId } from './autoBackend.ts'
import { resolveBackend } from './autoBackend.ts'
import { createWebGL2Renderer } from './webgl2Renderer.ts'
import type { WebGL2Renderer, WebGL2RendererOptions, FrameContext, Recorder, FrameHandle, Texture, TextureView } from './webgl2Renderer.ts'
import { createWebGpuRenderer } from './webgpuRenderer.ts'
import type { WebGpuRenderer, WebGpuRendererOptions, GpuFrameContext, GpuRecorder } from './webgpuRenderer.ts'
import type { CompiledCommand, GLImageSource } from '@rune/webgl2'
import { probeGLCaps, makeGLProbe } from '@rune/webgl2'
import type { WgpuCommand, GPUImageSource, GPUFacade } from '@rune/webgpu'
import { probeGPUCaps, makeGPUProbe, externalImageSize } from '@rune/webgpu'
import type { TapeWriter, UploadScheduler, UploadSchedulerOptions, TransientPool, ReadableSignal, Journal, ResourceJournal, RestoreReport, WorkingSet, EvictionReport, ResidencyStats, TextureFormat, TransportClient, TransportFeedView } from '@rune/core'
import { createCaps, createStatsCollector } from '@rune/core'
import type { RendererFeed, RendererFeedOptions } from './rendererFeed.ts'
import { glFormatFromTextureFormat } from './resourceSessionGL.ts'
import type { Caps, StatsCollector, RendererStats } from '@rune/core'
import type { Surface, SurfaceOptions, PassOptions } from './surface.ts'
import type { AnyCanvas } from './canvasHelpers.ts'

/** Union-команда — у обеих есть record(), структура совместима по форме. */
export type AnyCommand = CompiledCommand | WgpuCommand

/** Пере-экспорт handle-типов (autoRenderer и потребители импортируют их
 *  из renderer.ts — единая точка входа унифицированного слоя). */
export type { FrameContext, Recorder, FrameHandle, Texture, TextureView } from './webgl2Renderer.ts'

/** Унифицированный кадровый колбэк: FrameContext и GpuFrameContext структурно идентичны. */
export type AnyFrameCallback =
  | ((ctx: FrameContext, record: AnyRecorder) => void)
  | ((ctx: GpuFrameContext, record: AnyRecorder) => void)
export type AnyRecorder = (command: AnyCommand, props?: unknown) => void

export interface RendererOptions {
  readonly canvas: AnyCanvas | string
  /** Порядок попыток. Default ['webgpu', 'webgl2']. Строка = strict (без фолбэка). */
  readonly backend?: BackendId | readonly BackendId[]
  readonly dpr?: number
  readonly clear?: WebGL2RendererOptions['clear']
  readonly uploads?: UploadSchedulerOptions
  /** Инъекция GL-фасада для headless-тестов. */
  readonly createGL?: WebGL2RendererOptions['createGL']
  /** Инъекция GPU-фасада для headless-тестов. */
  readonly createGPU?: WebGpuRendererOptions['createGPU']
  /** Приём тихих ошибок валидации WebGPU (не бросают исключений). */
  readonly onGpuError?: WebGpuRendererOptions['onGpuError']
  /** Task 69: приём тихих GL-ошибок WebGL2 (дренаж getError раз в кадр —
   *  паритет onGpuError). Без канала GL_INVALID_* молча превращаются
   *  в «чёрный канвас» без диагностики. */
  readonly onGlError?: WebGL2RendererOptions['onGlError']
  readonly requestFrame?: (callback: (timestamp: number) => void) => () => void
  readonly observeResize?: boolean
  readonly now?: () => number
  /** Инъекция пробы WebGPU — для тестов. */
  readonly probeGpu?: () => Promise<boolean>
  /** Инъекция пробы WebGL2 — для тестов. Default: typeof WebGL2RenderingContext. */
  readonly probeGl2?: () => boolean
  /** Journal — реестр долгоживущих деклараций для device-loss recovery
   *  (= switchBackend = worker migration). Применяется к ОБЕИМ бэкендам
   *  (Task 57: WebGPU-декоратор добавлен; до этого был только WebGL2-путь).
   *  Если journal передан и chosen=webgl2 — GLFacade обёртывается withJournal.
   *  Если chosen=webgpu — GPUFacade обёртывается withJournalGpu. Replay —
   *  через replayJournalOn (WebGL2) или replayJournalOnGpu (WebGPU). */
  readonly journal?: Journal
  /** Task 62: ResourceJournal v2 — УНИФИЦИРОВАННЫЙ журнал первичных
   *  ресурсов с КОНТЕНТОМ: texture.create/write/update/writeMip, view.*,
   *  target.*. Стабильные id переживают потерю устройства; ContentStore
   *  держит CPU-источники пикселей. После re-init вызовите
   *  renderer.restoreResources() — ресурсы И контент вернутся.
   *  Приоритет над journal (v1). */
  readonly resources?: ResourceJournal
  /** M5 (Task 73): транспорт-клиент читателя — renderer.transport
   *  (диагностика режима T0–T3, досье §7.2). Опционально. */
  readonly transport?: TransportClient
}

/** Унифицированный рендерер: командует обоими бэкендами. */
export interface Renderer {
  readonly size: ReadableSignal<readonly [number, number]>
  readonly aspect: ReadableSignal<number>
  readonly time: ReadableSignal<number>
  readonly uploads: UploadScheduler
  readonly transients: TransientPool
  /** Escape-hatch к конкретному бэкенду (для WebGL2-only методов типа .gl/.live). */
  readonly inner: WebGL2Renderer | WebGpuRenderer | null
  /** Выбранный бэкенд (null до .start()). */
  readonly backend: BackendId | null
  /** Структурированное решение (null до .start()). */
  readonly decision: BackendDecision | null
  /** Возможности выбранного бэкенда (null до .start()).
   *
   *  M4 (DESIGN.md §11.4): caps.has(FeatureId), caps.format(format, axis),
   *  caps.path(name), caps.ext(name), caps.stats(), caps.limit(name),
   *  caps.invalidate(). Пробинг выполняется один раз на .start() — в
   *  WebGL2 через gl.getExtension + gl.getParameter, в WebGPU через
   *  adapter.features + adapter.limits. invalidate() вызывается на
   *  contextlost / device.lost — юзер должен пере-пробить и пересоздать
   *  caps (см. TODO webglcontextlost). */
  readonly caps: Caps | null
  texture(width: number, height: number, options?: { mipLevels?: number; maxAnisotropy?: number; format?: TextureFormat }): Texture
  /** Task 62: handle над существующим стабильным textureId — текстура,
   *  восстановленная restoreResources() после потери устройства. Не создаёт
   *  GPU-ресурс и не пишет в журнал (texture.create-опс уже там). */
  attachTexture(textureId: number, width: number, height: number, mipLevels?: number): Texture
  /** Task 64: handle над существующим стабильным viewId — view, восстановленный
   *  restoreResources() по опсу view.create (viewId ≥ 1M). Не создаёт
   *  GPU-ресурс и не пишет в журнал (view.create-опс уже там). dispose()
   *  освобождает view (view.destroy в журнал сессии). Parent-текстуру
   *  освобождайте отдельно: attachTexture(...).dispose(). */
  attachView(viewId: number, textureId: number, baseMipLevel?: number, mipLevelCount?: number): TextureView
  /** Task 62: восстановить первичные ресурсы ИЗ ResourceJournal v2 на
   *  свежем фасаде текущего inner — device-loss recovery. Возвращает отчёт
   *  (стабильные id живых ресурсов + счётчики контента) или null, если
   *  рендерер создан без опции resources. Вызывать ПОСЛЕ re-init, ДО
   *  создания новых ресурсов.
   *
   *  Task 65 soft reset: options.workingSet — восстановить ТОЛЬКО замыкание
   *  рабочего множества (текущая сцена + её контент + родители views);
   *  остальные живые ресурсы останутся в журнале декларациями
   *  (report.deferred) и вернутся лениво через ensureResident(). Без
   *  options — полный replay (strategy='full'). */
  restoreResources(options?: { workingSet?: WorkingSet }): RestoreReport | null
  /** Task 65: ленивый возврат ОДНОГО отложенного ресурса после soft reset
   *  (textureId / viewId ≥ 1M / targetId). Проигрывает подсписок журнала
   *  (create + контент + зависимости) на текущем фасаде тем же код-путём,
   *  что и живая работа. Идемпотентно: уже резидентный ресурс → null.
   *  null также если рендерер без опции resources. */
  ensureResident(resourceId: number): RestoreReport | null
  /** Task 66: LRU-вытеснение резидентных текстур до бюджета GPU-памяти —
   *  управление давлением памяти МЕЖДУ потерями (каталог #14 pressure→evict).
   *  Вытесняет наименее давно использованные (LRU) текстуры, пока оценка
   *  резидентной памяти не уложится в budgetBytes; pinned (например, сцена)
   *  неприкосновенен. Вытесненные ресурсы НЕ умирают: декларации и контент
   *  остаются в журнале, ресурс вернётся через ensureResident() тем же
   *  код-путём. Использование отмечается автоматически (bind/upload/view/
   *  target через сессионный фасад). null-отчёт не бывает: пустой план —
   *  легитимный результат «бюджет не превышен». */
  evictLRU(options?: { budgetBytes?: number; pinned?: WorkingSet }): EvictionReport | null
  /** Task 66: оценка резидентной GPU-памяти + порядок LRU (диагностика;
   *  null — рендерер без опции resources). */
  residencyStats(): ResidencyStats | null
  /** Lazy: до .start() записывает спек + возвращает proxy; после — late-reject. */
  command(spec: AutoDrawSpec): AnyCommand
  pass(fragment: string, options?: PassOptions): AnyCommand
  surface(options?: SurfaceOptions): Surface<AnyCommand>
  /** M5 (Task 73): фид рендерера (dual-bind: vertex + storage).
   *  Требует .start() (как surface/texture) — нужен фасад бэкенда. */
  feed(options: RendererFeedOptions | TransportFeedView): RendererFeed
  /** M5 (Task 73): транспорт-клиент читателя (null — не передан). */
  readonly transport: TransportClient | null
  frame(callback: AnyFrameCallback): FrameHandle
  resize(cssWidth: number, cssHeight: number): void
  step(nowMs: number): void
  start(): Promise<void>
  stop(): void
  /** Полный teardown: stop() + inner.dispose() (disconnect ResizeObserver
   *  + для WebGL2 — разрушение GL-контекста не делается; браузер сделает сам
   *  при потере страницы). После dispose рендерер неработоспособен.
   *  Идемпотентно. */
  dispose(): void
  /** Алиас к decision для отладки (как в DESIGN.md §9.12.5). */
  whyBackend(): BackendDecision | null
}

/** Ошибка с структурированным decision — ловящий код может показать вердикты. */
export class BackendResolutionError extends Error {
  readonly decision: BackendDecision
  constructor(decision: BackendDecision) {
    super(decision.message)
    this.name = 'BackendResolutionError'
    this.decision = decision
  }
}

/** Главная точка входа: унифицированный рендерер с авто-выбором бэкенда. */
export function createRenderer(options: RendererOptions): Renderer {
  const order = normalizeOrder(options.backend)
  const pendingSpecs: AutoDrawSpec[] = []
  const pendingFrames: AnyFrameCallback[] = []
  const proxies: Array<{ proxy: ProxyCommand; spec: AutoDrawSpec }> = []
  let decision: BackendDecision | null = null
  let inner: WebGL2Renderer | WebGpuRenderer | null = null
  let caps: Caps | null = null
  let statsCollector: StatsCollector | null = null

  function requireInner(method: string): WebGL2Renderer | WebGpuRenderer {
    if (inner === null) {
      throw new Error(
        `rune: renderer.${method}() требует .start(). ` +
        'Сначала дождитесь await renderer.start(), потом создавайте поверхности/текстуры/проходы.',
      )
    }
    return inner
  }

  return {
    get size() { return requireInner('size').size },
    get aspect() { return requireInner('aspect').aspect },
    get time() { return requireInner('time').time },
    get uploads() { return requireInner('uploads').uploads },
    get transients() { return requireInner('transients').transients },
    get inner() { return inner as WebGL2Renderer | WebGpuRenderer | null },
    get backend() { return decision?.chosen ?? null },
    get decision() { return decision },
    get caps() { return caps },
    get transport() { return options.transport ?? null },

    feed(feedOptions) {
      // M5: фид требует фасад выбранного бэкенда (GPU-зеркало) — только
      // после .start() (как surface/texture). Досье §4.3: рендер-воркер
      // создаёт renderer уже с готовым device.
      return requireInner('feed').feed(feedOptions)
    },

    texture(w, h, options) {
      const i = requireInner('texture')
      const mipLevels = options?.mipLevels ?? 1
      const maxAnisotropy = options?.maxAnisotropy
      // Task 67 HDR: формат хранения — единый журнальный тип TextureFormat;
      // GL-путь маппит его в GLTextureFormat ('rgba16float' → 'rgba16f'),
      // GPU-путь передаёт как есть. Оба бэкенда восстановят формат из журнала
      // после потери устройства (texture.create несёт format).
      const format = options?.format
      if ('gl' in i) {
        return i.texture(w, h, { mipLevels, maxAnisotropy, format: glFormatFromTextureFormat(format) }) as Texture
      }
      // WebGPU: текстуры через gpu.createTexture (с mipLevels если передано);
      // обёртка как в showWebgpu.ts. Task 58: добавлен createView для паритета
      // с WebGL2-путём — вызывает gpu.createTextureView/deleteTextureView.
      const gpu = i.gpu
      const textureId = gpu.createTexture(w, h, format ?? 'rgba8unorm', { mipLevels, maxAnisotropy })
      return makeGpuTextureHandle(gpu, textureId, w, h, mipLevels)
    },

    attachTexture(textureId, width, height, mipLevels = 1) {
      const i = requireInner('attachTexture')
      if ('gl' in i) return i.attachTexture(textureId, width, height, mipLevels) as Texture
      // WebGPU: handle над восстановленным стабильным id (GPU-ресурс уже
      // создан restoreResources; в журнал ничего не пишем).
      return makeGpuTextureHandle(i.gpu, textureId, width, height, Math.max(1, mipLevels))
    },

    attachView(viewId, textureId, baseMipLevel = 0, mipLevelCount) {
      const i = requireInner('attachView')
      if ('gl' in i) return i.attachView(viewId, textureId, baseMipLevel, mipLevelCount) as TextureView
      // WebGPU: handle над восстановленным стабильным viewId (GPU-view уже
      // создан restoreResources по опсу view.create; в журнал ничего не пишем).
      return makeGpuTextureViewHandle(i.gpu, viewId, textureId, baseMipLevel, mipLevelCount)
    },

    restoreResources(options) {
      const i = requireInner('restoreResources')
      const restore = (i as WebGL2Renderer & WebGpuRenderer).restoreResources
      return restore !== undefined ? restore.call(i, options) : null
    },

    ensureResident(resourceId) {
      const i = requireInner('ensureResident')
      const ensure = (i as WebGL2Renderer & WebGpuRenderer).ensureResident
      return ensure !== undefined ? ensure.call(i, resourceId) : null
    },

    evictLRU(options) {
      const i = requireInner('evictLRU')
      const evict = (i as WebGL2Renderer & WebGpuRenderer).evictLRU
      return evict !== undefined ? evict.call(i, options) : null
    },

    residencyStats() {
      const i = requireInner('residencyStats')
      const stats = (i as WebGL2Renderer & WebGpuRenderer).residencyStats
      return stats !== undefined ? stats.call(i) : null
    },

    command(spec) {
      if (inner !== null) {
        // После старта — late-reject + delegate
        assertCovers(spec, decision!, 'inner')
        return adaptAndCompile(spec, decision!.chosen!, inner)
      }
      // До старта — записываем спек, возвращаем proxy
      pendingSpecs.push(spec)
      const proxy = makeProxyCommand()
      proxies.push({ proxy, spec })
      return proxy as unknown as AnyCommand
    },

    pass(fragment, passOptions) {
      return requireInner('pass').pass(fragment, passOptions)
    },

    surface(surfaceOptions) {
      return requireInner('surface').surface(surfaceOptions) as Surface<AnyCommand>
    },

    frame(callback) {
      if (inner !== null) return inner.frame(callback as never)
      pendingFrames.push(callback)
      return { cancel: () => removeItem(pendingFrames, callback) }
    },

    resize(w, h) {
      if (inner === null) return // canvas ещё не создан — стартовый resize сделает inner
      inner.resize(w, h)
    },

    step(now) {
      requireInner('step').step(now)
    },

    async start() {
      if (inner !== null) {
        // Уже инициализирован — просто возобновляем rAF после stop()
        inner.start()
        return
      }
      // Probe hardware — только для бэкендов из order (Task 75: строгий
      // webgl2 не должен платить за navigator.gpu.requestAdapter() — на
      // SwiftShader/софт-рендерах это секунды).
      const hardware = await probeHardware(options, order)
      // Resolve
      decision = resolveBackend({ order, specs: pendingSpecs, hardware })
      if (decision.chosen === null) throw new BackendResolutionError(decision)
      // Create inner
      // StatsCollector — обвязка для cpuMs/drawCalls/memoryEstimate. До .start()
      // stats не собирается; после — step() дёргает beginFrame/endFrame.
      statsCollector = createStatsCollector(options.now ?? (() => performance.now()))
      inner = decision.chosen === 'webgpu'
        ? await createWebGpuRenderer({
            canvas: options.canvas,
            createGPU: options.createGPU,
            onGpuError: options.onGpuError,
            requestFrame: options.requestFrame,
            observeResize: options.observeResize,
            now: options.now,
            journal: options.journal,
            resources: options.resources,
            transport: options.transport,
          })
        : createWebGL2Renderer({
            canvas: options.canvas,
            dpr: options.dpr,
            clear: options.clear,
            uploads: options.uploads,
            createGL: options.createGL,
            onGlError: options.onGlError,
            requestFrame: options.requestFrame,
            observeResize: options.observeResize,
            now: options.now,
            journal: options.journal,
            resources: options.resources,
            stats: statsCollector,
            transport: options.transport,
          })
      // Probe caps на выбранном бэкенде.
      // WebGL2-рендерер пробит caps сам (внутри createWebGL2Renderer через
      // raw gl, включая GpuTimer подключение). WebGPU — здесь, через
      // gpu.adapter и gpu.preferredFormat (adapter публично в GPUFacade
      // с M4-addendum-2).
      if ('caps' in inner) {
        caps = (inner as WebGL2Renderer).caps
        // WebGL2 сам подключил GpuTimer к своему statsCollector (внутри
        // createWebGL2Renderer). Внешний statsCollector тут не при делах —
        // inner использует свой собственный.
      } else if ('gpu' in inner) {
        // WebGPU путь: пробиваем caps через gpu.adapter + probeGPUCaps.
        // ВАЖНО: передаём device в makeGPUProbe — на некоторых браузерах
        // adapter.limits НЕ содержит maxAnisotropy, а device.limits — да.
        // Без этого fallback'а caps.has('anisotropic')=false на WebGPU,
        // хотя realGPU.createTexture применяет anisotropic x16.
        const gpu = (inner as WebGpuRenderer).gpu
        const adapter = gpu.adapter
        const device = gpu.device
        const preferredFormat = gpu.preferredFormat
        if (adapter !== null) {
          try {
            const query = probeGPUCaps(makeGPUProbe(adapter, preferredFormat, device))
            caps = createCaps(query, () => statsCollector!.snapshot())
            // GpuTimer: realGPU создаёт timer внутри себя при requestDevice
            // (если adapter поддерживает 'timestamp-query' feature). timer
            // доступен через gpu.timer getter (null если feature нет).
            // Подключаем к statsCollector — gpuMs появится в snapshot() в
            // следующем кадре (после первого writeTimestamp→resolve→map).
            const gpuTimer = gpu.timer
            if (gpuTimer !== null) {
              statsCollector.setGpuTimer(gpuTimer)
            }
          } catch {
            caps = null
          }
        }
      }
      // Привяжем statsProvider к caps (чтобы caps.stats() возвращал свежие
      // метрики из statsCollector'а). probeGLCaps / probeGPUCaps уже сделал
      // probing — мы просто подменяем statsProvider на наш collector.
      if (caps && statsCollector) {
        const backendStr = caps.backend
        const prev = caps
        caps = {
          has: (f) => prev.has(f),
          format: (f, a) => prev.format(f, a),
          path: (n) => prev.path(n),
          ext: (n) => prev.ext(n),
          stats: () => statsCollector!.snapshot(),
          limit: (n) => prev.limit(n),
          get backend() { return backendStr },
          invalidate: () => prev.invalidate(),
        }
      }
      // Attach proxies: компилируем спеки на выбранном бэкенде, подключаем к proxy
      for (const { proxy, spec } of proxies) {
        const real = adaptAndCompile(spec, decision.chosen, inner)
        proxy._attach(real)
      }
      // Replay frames
      for (const cb of pendingFrames) inner.frame(cb as never)
      pendingFrames.length = 0
      pendingSpecs.length = 0
      proxies.length = 0
      // Begin rAF
      inner.start()
    },

    stop() {
      inner?.stop()
    },

    dispose() {
      if (inner === null) return
      // inner может быть WebGL2 или WebGPU — у обоих есть dispose()
      const i = inner as WebGL2Renderer & WebGpuRenderer
      i.dispose()
    },

    whyBackend() { return decision },
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

/** GPU-строитель Texture-handle: общий путь для texture() и attachTexture()
 *  (Task 62: create и attach — один и тот же код; отличается только источник
 *  textureId: свежесозданный vs восстановленный из журнала). */
function makeGpuTextureHandle(
  gpu: GPUFacade,
  textureId: number,
  w: number,
  h: number,
  mipLevels: number,
): Texture {
  let manuallyDisposed = false
  const subViews: Set<TextureView> = new Set()
  const handle: Texture = {
    textureId,
    width: w,
    height: h,
    mipLevels,
    upload: () => ({ done: Promise.resolve() }) as never,
    uploadImage: (source: GLImageSource | GPUImageSource, options?: { flipY?: boolean }) => {
      const [sw, sh] = externalImageSize(source as GPUImageSource)
      gpu.copyExternalImageToTexture(textureId, source as GPUImageSource, 0, 0, sw, sh, options?.flipY)
    },
    uploadSubImage: (x: number, y: number, source: GLImageSource | GPUImageSource, options?: { flipY?: boolean }) => {
      const [sw, sh] = externalImageSize(source as GPUImageSource)
      gpu.copyExternalImageToTexture(textureId, source as GPUImageSource, x, y, sw, sh, options?.flipY)
    },
    uploadMip: (
      level: number,
      source: GLImageSource | GPUImageSource,
      options?: {
        flipY?: boolean
        /** WebGL2 internalFormat GLenum (default RGBA8). WebGPU-ignored. */
        internalFormat?: number
        /** WebGL2 format GLenum (default RGBA). WebGPU-ignored. */
        format?: number
        /** WebGL2 type GLenum (default UNSIGNED_BYTE). WebGPU-ignored. */
        type?: number
      },
    ) => {
      const [sw, sh] = externalImageSize(source as GPUImageSource)
      gpu.copyExternalImageToTextureMip(textureId, level, source as GPUImageSource, 0, 0, sw, sh, options?.flipY)
    },
    createView: (viewOptions?: { baseMipLevel?: number; mipLevelCount?: number }) => {
      // Task 58: делегируем в gpu.createTextureView (нативный GPUTextureView).
      // Facade бросает Error при невалидных опциях (textureId не найден,
      // mipLevels < 2, baseMipLevel вне диапазона).
      const viewId = gpu.createTextureView(textureId, viewOptions)
      const view: TextureView = makeGpuTextureViewHandle(
        gpu, viewId, textureId,
        viewOptions?.baseMipLevel ?? 0,
        viewOptions?.mipLevelCount,
      )
      subViews.add(view)
      return view
    },
    dispose: () => {
      if (manuallyDisposed) return
      manuallyDisposed = true
      // Cascade dispose: освобождаем все sub-views (нативные GPUTextureView
      // освобождаются через device.destroy() при dispose facade, но мы
      // вызываем deleteTextureView явно для симметрии с WebGL2-путём).
      for (const view of subViews) view.dispose()
      subViews.clear()
      gpu.deleteTexture(textureId)
    },
  } as Texture
  return handle
}

/** GPU-строитель TextureView-handle (createView и attachView — один путь;
 *  Task 64: источник viewId — свежесозданный или восстановленный из журнала).
 *  dispose() → deleteTextureView(viewId) на фасаде. Идемпотентно. */
function makeGpuTextureViewHandle(
  gpu: GPUFacade,
  viewId: number,
  textureId: number,
  baseMipLevel: number,
  mipLevelCount: number | undefined,
): TextureView {
  let viewDisposed = false
  return {
    viewId,
    textureId,
    baseMipLevel,
    mipLevelCount,
    dispose: () => {
      if (viewDisposed) return
      viewDisposed = true
      try { gpu.deleteTextureView(viewId) } catch { /* facade уже умер — no-op */ }
    },
  }
}

function normalizeOrder(backend: BackendId | readonly BackendId[] | undefined): readonly BackendId[] {
  if (backend === undefined) return ['webgpu', 'webgl2']
  if (Array.isArray(backend)) return backend
  return [backend as BackendId]
}

async function probeHardware(options: RendererOptions, order: readonly BackendId[]): Promise<{ webgpu: boolean; webgl2: boolean }> {
  // Инъекции createGL/createGPU трактуются как «бэкенд доступен»: тест берёт ответственность на себя.
  if (options.createGPU !== undefined || options.createGL !== undefined) {
    return {
      webgpu: options.createGPU !== undefined,
      webgl2: options.createGL !== undefined,
    }
  }
  const probeGpu = options.probeGpu ?? defaultProbeGpu
  const probeGl2 = options.probeGl2 ?? defaultProbeGl2
  return {
    webgpu: order.includes('webgpu') ? await probeGpu() : false,
    webgl2: order.includes('webgl2') ? probeGl2() : false,
  }
}

/** WebGPU-проба: navigator.gpu + requestAdapter(). */
async function defaultProbeGpu(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) return false
  try {
    const adapter = await navigator.gpu.requestAdapter()
    return adapter !== null
  } catch {
    return false
  }
}

/** WebGL2-проба: наличие глобального WebGL2RenderingContext (без захвата канваса). */
function defaultProbeGl2(): boolean {
  return typeof WebGL2RenderingContext !== 'undefined'
}

/** Проверяет, что spec.shader покрывает выбранный бэкенд; иначе late-reject. */
function assertCovers(spec: AutoDrawSpec, decision: BackendDecision, _when: string): void {
  if (decision.chosen === null) return // не должно случиться после start
  const need = decision.chosen === 'webgpu' ? 'wgsl' : 'glsl'
  if (!spec.shader[need]) {
    throw lateRejectError(spec, decision.chosen)
  }
}

/** Actionable late-reject: что подкрутить. */
function lateRejectError(spec: AutoDrawSpec, backend: BackendId): Error {
  const need = backend === 'webgl2' ? 'glsl' : 'wgsl'
  const hasOther = backend === 'webgl2' ? !!spec.shader.wgsl : !!spec.shader.glsl
  const other = backend === 'webgl2' ? 'WGSL' : 'GLSL'
  const target = backend === 'webgl2' ? 'GLSL' : 'WGSL'
  const id = spec.id ?? '<без id>'
  const altOrder = backend === 'webgl2' ? '["webgpu","webgl2"]' : '["webgl2","webgpu"]'
  if (hasOther) {
    return new Error(
      `Spec "${id}" имеет только ${other}, а активный бэкенд — ${backend.toUpperCase()} (нет ${target}). ` +
      `Перезапустите с backend=${altOrder} ИЛИ добавьте ${target} к спеку.`,
    )
  }
  return new Error(
    `Spec "${id}" не имеет ни GLSL, ни WGSL. Невалидный спек — добавьте хотя бы один вариант шейдера.`,
  )
}

/** Адаптирует AutoDrawSpec под конкретный бэкенд и компилирует через inner. */
function adaptAndCompile(spec: AutoDrawSpec, backend: BackendId, inner: WebGL2Renderer | WebGpuRenderer): AnyCommand {
  if (backend === 'webgpu') {
    return (inner as WebGpuRenderer).command({
      shader: { wgsl: spec.shader.wgsl! },
      uniforms: spec.uniforms,
      attributes: spec.attributes,
      textures: spec.textures,
      pipeline: spec.pipeline,
      count: spec.count,
      // Task 75: инстансы пробрасываются (квады-звёзды: instances=feed.count).
      instances: spec.instances,
    } as never)
  }
  return (inner as WebGL2Renderer).command({
    shader: { glsl: spec.shader.glsl! },
    pipeline: spec.pipeline,
    attributes: spec.attributes,
    uniforms: spec.uniforms,
    textures: spec.textures,
    count: spec.count,
    instances: spec.instances,
  } as never)
}

// ─── proxy CompiledCommand ───────────────────────────────────────────────────

interface ProxyCommand {
  id: number
  record(props: unknown, frameCtx: { time: number; dt: number; aspect: number }, writer: TapeWriter): void
  lastProps: unknown
  _attach(real: AnyCommand): void
}

/** Создаёт proxy CompiledCommand: делегирует .record к real после _attach(). */
function makeProxyCommand(): ProxyCommand {
  let real: AnyCommand | null = null
  let lastPropsValue: unknown = undefined
  const proxy: ProxyCommand = {
    id: -1,
    record(props, frameCtx, writer) {
      if (real === null) {
        throw new Error('rune: вызван command.record() до renderer.start(). Сначала дождитесь await renderer.start().')
      }
      real.record(props, frameCtx, writer)
      lastPropsValue = props
    },
    get lastProps() { return lastPropsValue },
    set lastProps(v: unknown) { lastPropsValue = v },
    _attach(realCmd) {
      real = realCmd
      proxy.id = realCmd.id
    },
  }
  return proxy
}

function removeItem<T>(list: T[], item: T): void {
  const at = list.indexOf(item)
  if (at >= 0) list.splice(at, 1)
}
