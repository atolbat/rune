import {
  buildFrame,
  createEpoch,
  createLayoutGuard,
  createLiveCommand,
  createSegmentStore,
  createTapeWriter,
  createTransientPool,
  createUniformArena,
  derive,
  signal,
  writerView,
  OpCode,
} from '@rune/core'
import { createUploadScheduler, streamTexture } from '@rune/core'
import type { UploadScheduler, UploadSchedulerOptions, TextureUpload, TransientPool } from '@rune/core'
import type { TextureHandle } from '@rune/webgl2'
import type { LiveCommand, ReadableSignal } from '@rune/core'
import { compileDrawSpec, createCompileContext, createExecutor, createRealGL } from '@rune/webgl2'
import type { CompiledCommand, DrawSpec, GLFacade, UniformStrategy, GLTextureFormat, GLImageSource } from '@rune/webgl2'
import {
  FULLSCREEN_QUAD,
  PASS_VERT_GLSL,
  applyBuiltins,
  createPassBuiltins,
  scanBuiltins,
  withTarget,
} from './surface.ts'
import type { PassOptions, Surface, SurfaceOptions } from './surface.ts'
import { canvasDpr, getCanvasCssSize, isOffscreenCanvas, resolveCanvasAny } from './canvasHelpers.ts'
import type { AnyCanvas } from './canvasHelpers.ts'
import { withJournal } from './journalGl.ts'
import { createResourceSessionGL } from './resourceSessionGL.ts'
import type { ResourceJournal, RestoreReport, WorkingSet, EvictionReport, ResidencyStats } from '@rune/core'
import type { StatsCollector, GpuTimer } from '@rune/core'
import { createStatsCollector } from '@rune/core'
import type { TransportClient, TransportFeedView } from '@rune/core'
import { createRendererFeedGL } from './rendererFeed.ts'
import type { RendererFeed, RendererFeedOptions } from './rendererFeed.ts'
import { makeGLProbe, probeGLCaps, createGLGpuTimer } from '@rune/webgl2'
import type { Caps } from '@rune/core'
import { createCaps } from '@rune/core'
import type { Journal } from '@rune/core'

/** Контекст кадра: стабильная форма (мутация полей, без аллокаций). */
export interface FrameContext {
  time: number
  dt: number
  aspect: number
  size: readonly [number, number]
}

/** Запись команды текущего кадра (для колбэков renderer.frame). */
export type Recorder = (command: CompiledCommand, props?: unknown) => void

/** Управление подпиской на кадры. */
export interface FrameHandle {
  cancel(): void
}

/** Рендерер WebGL2: канвас, авто-цикл, resize/DPR, sim-time, команды и live. */
export interface WebGL2Renderer {
  readonly gl: GLFacade
  /** Caps — возможности бэкенда. null в headless-режиме (createGL инъектирован). */
  readonly caps: Caps | null
  readonly size: ReadableSignal<readonly [number, number]>
  readonly aspect: ReadableSignal<number>
  readonly time: ReadableSignal<number>
  /** Стриминг-планировщик: задачи исполняются в idle-слоте каждого кадра. */
  readonly uploads: UploadScheduler
  /** Кадровый пул скретч-массивов (идея №2): без аллокаций в колбэках. */
  readonly transients: TransientPool
  /** M5 (Task 73): транспорт-клиент читателя — диагностика режима
   *  (renderer.transport.mode, досье §7.2: «Диагностика доступна через
   *  renderer.transport»). null — рендерер без транспорта. */
  readonly transport: TransportClient | null
  /** M5 (Task 73): создать фид рендерера (dual-bind: vertex-атрибуты +
   *  storage-массив структур; sync — на границе кадра, грязный диапазон
   *  одним вызовом). Канал: T0/T1/T2 — SAB/local (.buffer → воркеру),
   *  T3 — ping-pong (воркер: createMsgFeedWriter; чанки — applyChunks). */
  feed(options: RendererFeedOptions | TransportFeedView): RendererFeed
  /** Создаёт пустую текстуру (стриминг — через texture.upload). */
  texture(width: number, height: number, options?: { mipLevels?: number; maxAnisotropy?: number; format?: GLTextureFormat }): Texture
  /** Task 62: handle над существующим стабильным textureId (восстановлен
   *  restoreResources после потери устройства). Не создаёт GPU-ресурс. */
  attachTexture(textureId: number, width: number, height: number, mipLevels?: number): Texture
  /** Task 64: handle над существующим стабильным viewId — view, восстановленный
   *  restoreResources() по опсу view.create (viewId ≥ 1M, parent textureId < 1M).
   *  Не создаёт GPU-ресурс и не пишет в журнал: опс view.create уже там.
   *  dispose() → deleteTextureView(viewId) — пишет view.destroy в журнал
   *  сессии (пара для будущего compact). Parent-текстуру освобождайте
   *  отдельно: attachTexture(...).dispose() → texture.destroy. */
  attachView(viewId: number, textureId: number, baseMipLevel?: number, mipLevelCount?: number): TextureView
  /** Task 62: replay ResourceJournal v2 на СВЕЖЕМ фасаде этой сессии —
   *  device-loss recovery. Присутствует только при опции resources.
   *  Task 65: options.workingSet — soft reset (восстановить только сцену;
   *  остальное лениво через ensureResident). */
  restoreResources?(options?: { workingSet?: WorkingSet }): RestoreReport
  /** Task 65: ленивый возврат ОДНОГО отложенного ресурса после soft reset
   *  (texture/view/target id). null — уже резидентен / нет сессии. */
  ensureResident?(resourceId: number): RestoreReport | null
  /** Task 66: LRU-вытеснение резидентных текстур до бюджета GPU-памяти
   *  (обратная сторона ensureResident; давление памяти между потерями).
   *  Вытесненные ресурсы остаются декларациями+контентом в журнале.
   *  Присутствует только при опции resources. */
  evictLRU?(options?: { budgetBytes?: number; pinned?: WorkingSet }): EvictionReport
  /** Task 66: оценка резидентной GPU-памяти + LRU-порядок (диагностика). */
  residencyStats?(): ResidencyStats
  command(spec: DrawSpec): CompiledCommand
  /** Полноэкранный проход в канвас: входы → фрагмент → экран. */
  pass(fragment: string, options?: PassOptions): CompiledCommand
  /** Поверхность-цель: текстура + полноэкранные проходы в неё. */
  surface(options?: SurfaceOptions): Surface<CompiledCommand>
  live(spec: DrawSpec, deps?: readonly ReadableSignal[], props?: unknown): LiveCommand
  frame(callback: (ctx: FrameContext, record: Recorder) => void): FrameHandle
  resize(cssWidth: number, cssHeight: number): void
  step(nowMs: number): void
  start(): void
  stop(): void
  /** Полный teardown: stop rAF + disconnect ResizeObserver + удалить все
   *  ресурсы фасада (textures/programs/buffers/targets). После dispose
   *  рендерер неработоспособен — пересоздавайте через createWebGL2Renderer.
   *  Идемпотентно: повторный dispose — no-op. */
  dispose(): void
}

/** Рендерер-текстура: id фасада + потоковая загрузка поверх планировщика. */
export interface Texture extends TextureHandle {
  readonly width: number
  readonly height: number
  /** Кол-во mip-уровней в цепи (1 = нет цепи). >1 → текстура создана с
   *  texStorage2D levels=N, MIN_FILTER=LINEAR_MIPMAP_LINEAR. Streaming
   *  через uploadMip(level) постепенно заполняет мипы от малого к большому;
   *  MAX_LEVEL автоматически поднимается на загруженный уровень. */
  readonly mipLevels: number
  /** Потоковая загрузка RGBA-байтов: превью → чанки; прогресс и отмена.
   *  Для ImageBitmap / HTMLCanvasElement / OffscreenCanvas / VideoFrame —
   *  см. uploadImage (атомарная загрузка без стриминга). */
  upload(source: Uint8Array, options?: { priority?: number; onProgress?: (fraction: number) => void }): TextureUpload
  /** Атомарная загрузка из bitmap/canvas/video — одним вызовом, без чанков.
   *  WebGL2: texImage2D overload с TexImageSource (перезаписывает мип 0).
   *  WebGPU: copyExternalImageToTexture (через gpu-фасад, если доступно).
   *  Размер текстуры должен соответствовать источнику (или быть больше —
   *  тайлы вне источника останутся нетронутыми).
   *
   *  options.flipY (default false): перевернуть источник по Y. WebGL2 —
   *  через UNPACK_FLIP_Y_WEBGL; WebGPU — через GPUCopyExternalImageSourceInfo.flipY.
   *  Паритет: при false оба бэкенда пишут source row 0 в texture row 0
   *  — отображение идентично. */
  uploadImage(source: GLImageSource, options?: { flipY?: boolean }): void
  /** Загрузка части текстуры (sub-region) из bitmap/canvas/video.
   *  WebGL2: texSubImage2D overload с TexImageSource (НЕ перезаписывает
   *  остальную текстуру). WebGPU: copyExternalImageToTexture с destination.origin=(x,y).
   *
   *  Используется для:
   *   - runtime atlas packing (несколько битмапов в одну текстуру),
   *   - tile replacement (обновление части карты),
   *   - progressive loading.
   *
   *  Регион определяется [x, y, x+source.width, y+source.height]. Выходит
   *  за пределы текстуры → GL-error (проверки нет намеренно — дешёвый путь).
   *  options.flipY (default false) — паритет с WebGPU (см. uploadImage). */
  uploadSubImage(x: number, y: number, source: GLImageSource, options?: { flipY?: boolean }): void
  /** Загрузка конкретного mip-уровня (level 0 = базовый, 1 = 1/2 размер, и т.д.).
   *
   *  WebGL2: texImage2D с level параметром. Source должен иметь размер N/(2^level).
   *  Для mip-chain текстуры (mipLevels>1) поднимает TEXTURE_MAX_LEVEL до level —
   *  sampler видит только загруженные мипы, без чёрного кадра при частичной
   *  загрузке. Для non-mip текстуры (mipLevels=1) загрузка level>0 не имеет
   *  видимого эффекта без пересоздания текстуры.
   *  WebGPU: copyExternalImageToTextureMip с destination.mipLevel=level.
   *  WebGPU-путь игнорирует WebGL2-specific опции internalFormat/format/type
   *  (формат текстуры задан при createTexture, не при upload).
   *
   *  options.flipY (default false) — паритет с WebGPU (см. uploadImage).
   *
   *  options.internalFormat/format/type (WebGL2-only, Task 55): строгий контракт
   *  формата/типа для HDR-данных. Default: RGBA8/RGBA/UNSIGNED_BYTE. Для
   *  RGBA16F: internalFormat=0x881A, format=0x1908, type=0x140B (HALF_FLOAT).
   *  WebGPU-путь эти опции игнорирует.
   *
   *  Используется MipStreamer'ом для progressive mip upload. */
  uploadMip(
    level: number,
    source: GLImageSource,
    options?: {
      flipY?: boolean
      /** WebGL2 internalFormat GLenum (default RGBA8=0x8058). WebGPU-ignored. */
      internalFormat?: number
      /** WebGL2 format GLenum (default RGBA=0x1908). WebGPU-ignored. */
      format?: number
      /** WebGL2 type GLenum (default UNSIGNED_BYTE=0x1401). WebGPU-ignored. */
      type?: number
    },
  ): void
  /** Создать sub-mip-range view текстуры (Task 58: expose через public handle).
   *
   *  WebGPU: GPUTextureView с baseMipLevel/mipLevelCount — sampler видит
   *  только указанный диапазон мипов. Полезно для deep-zoom paging:
   *  bindTexture(viewId) выбирает конкретный мип без авто-LOD.
   *
   *  WebGL2: эмулируется через TEXTURE_BASE_LEVEL / TEXTURE_MAX_LEVEL при
   *  bindTexture (Task 56: GLFacade.createTextureView). Disjoint id namespace:
   *  viewId ≥ 1M, textureId < 1M — bindTexture(viewId|textureId) работает
   *  без изменения сигнатуры.
   *
   *  Контракт:
   *   - textureId должен иметь mipLevels ≥ 2 (иначе view не имеет смысла).
   *   - baseMipLevel (default 0): стартовый mip-уровень для view.
   *   - mipLevelCount (default = mipLevels - baseMipLevel): кол-во мипов в view.
   *   - baseMipLevel + mipLevelCount ≤ mipLevels.
   *
   *  @returns TextureView handle с viewId. bindTexture(viewId) выбирает
   *  диапазон мипов. dispose() — освобождает view (deleteTextureView).
   *
   *  Journal-интеграция: createTextureView/destroyTextureView — долгоживущие
   *  декларации, автоматически пишутся в Journal через withJournal /
   *  withJournalGpu. При device-loss recovery воссоздаются через
   *  replayJournalOn / replayJournalOnGpu. */
  createView(options?: { baseMipLevel?: number; mipLevelCount?: number }): TextureView
  /** Освободить GPU-текстуру (gl.deleteTexture). Идемпотентно.
   *  Также освобождает все sub-mip views (созданные через createView) —
   * facade сам убирает их из внутреннего кэша. */
  dispose(): void
}

/** Sub-mip view текстуры (Task 58): expose GPUFacade.createTextureView
 *  через public Texture handle. View — это срез текстуры по диапазону
 *  мип-уровней; sampler видит только [baseMipLevel, baseMipLevel +
 *  mipLevelCount - 1]. Используется в deep-zoom paging и LOD-clamp
 *  сценариях.
 *
 *  Паритет WebGPU ↔ WebGL2: на обоих бэкендах viewId ≥ 1M, disjoint
 *  namespace с textureId (< 1M). bindTexture(viewId) работает одинаково.
 *
 *  Dispose: deleteTextureView(viewId) на facade. Идемпотентно. Не трогает
 *  parent texture (она управляется через Texture.dispose()). */
export interface TextureView {
  /** viewId ≥ 1_000_000. Передаётся в bindTexture(viewId, unit) или
   *  в текстурный референс команды (textureId: viewId). */
  readonly viewId: number
  /** Parent textureId (< 1M) — для информации. */
  readonly textureId: number
  readonly baseMipLevel: number
  readonly mipLevelCount: number | undefined
  /** Освободить view (facade.deleteTextureView). Идемпотентно.
   *  Parent texture НЕ трогается. */
  dispose(): void
}

/** Вычислить кол-во mip-уровней для текстуры размером w×h.
 *  = 1 + floor(log2(min(w, h))). Например:
 *   - 256×256 → 9 уровней (level 0 = 256², 1 = 128², ..., 8 = 1×1)
 *   - 64×64  → 7 уровней
 *   - 4×4    → 3 уровня
 *  Возвращает 1 если min(w,h) ≤ 1 (нет mip-chain).
 *
 *  Используется MipStreamer'ом и renderer.texture({ mipLevels: 'auto' }). */
export function computeMipLevels(w: number, h: number): number {
  const minDim = Math.min(w, h)
  if (minDim <= 1) return 1
  return 1 + Math.floor(Math.log2(minDim))
}

/** Опции WebGL2-рендерера; инъекции — для headless-тестов. */
export interface WebGL2RendererOptions {
  readonly canvas: AnyCanvas | string
  readonly dpr?: number
  readonly clear?: { readonly color: readonly [number, number, number, number]; readonly depth: number | null }
  readonly uniformStrategy?: UniformStrategy
  readonly uploads?: UploadSchedulerOptions
  readonly createGL?: (canvas: AnyCanvas) => GLFacade
  readonly requestFrame?: (callback: (timestamp: number) => void) => () => void
  readonly observeResize?: boolean
  readonly now?: () => number
  /** Journal — реестр долгоживущих деклараций для device-loss recovery
   *  (= switchBackend = worker migration). Если передан, GLFacade
   *  оборачивается декоратором withJournal: create/destroy-опсы пишутся
   *  автоматически. Replay — через replayJournalOn(journal, newGL, sourceFor). */
  readonly journal?: Journal
  /** Task 62: ResourceJournal v2 — стабильные id + КОНТЕНТ в журнале.
   *  Если передан, GLFacade оборачивается resourceSession-декоратором:
   *  texture/view/target получают стабильные id (переживают потерю
   *  устройства), write/update/writeMip-опсы хранят CPU-источники в
   *  ContentStore. restoreResources() восстанавливает ВСЁ — декларации
   *  и пиксели — replay-ем тех же примитивов на свежем фасаде.
   *  Приоритет над journal (v1): переданы оба — используется resources. */
  readonly resources?: ResourceJournal
  /** Приём тихих GL-ошибок (WebGL2-паритет onGpuError у WebGPU): раз в кадр
   *  после submit дренажится gl.getError() — все коды ошибок, накопленные
   *  за кадр, уходят одним сообщением. Дедупликация: подряд идущие кадры с
   *  той же ошибкой не спамят (одно сообщение на изменение состояния).
   *  Используется демо для вывода на экран («[webgl2 GL error] …») — тихие
   *  GL_INVALID_* иначе превращаются в «чёрный канвас» без диагностики. */
  readonly onGlError?: (message: string) => void
  /** StatsCollector — для RendererStats (cpuMs, drawCalls, memoryEstimate).
   *  В step() вызывает beginFrame()/endFrame() и addMemory при createTexture. */
  readonly stats?: StatsCollector
  /** Caps-объект — пробинг выполнен на уровне unified createRenderer.
   *  WebGL2-путь использует только для caps.backend строки. */
  readonly caps?: Caps | null
  /** M5 (Task 73): транспорт-клиент читателя (renderer.transport —
   *  диагностика режима; досье §7.2). Опционально: без него renderer.feed()
   *  создаёт канал по detectTransport(). */
  readonly transport?: TransportClient
}

const DEFAULT_CLEAR = { color: [0.07, 0.08, 0.11, 1] as const, depth: 1 }

/** Создаёт WebGL2-рендерер с авто-циклом (явный путь без авто-выбора). */
export function createWebGL2Renderer(options: WebGL2RendererOptions): WebGL2Renderer {
  const canvas = resolveCanvasAny(options.canvas)
  const dpr = canvasDpr(canvas, options.dpr)
  // acquireWebGL2 даёт raw WebGL2RenderingContext — сохраняем для caps-probing.
  // Если createGL инъектирован (headless-тесты) — probing пропускаем (нет raw gl).
  const rawContext = options.createGL === undefined ? acquireWebGL2(canvas) : null
  const rawGl = options.createGL !== undefined ? options.createGL(canvas) : createRealGL(rawContext!)
  // Task 62: resourceSession (v2) имеет приоритет над journal (v1):
  // стабильные id + контент в журнале + restoreResources(). v1-путь
  // (withJournal) сохранён для обратной совместимости существующих тестов.
  const session = options.resources !== undefined ? createResourceSessionGL(rawGl, options.resources) : null
  // Journal-декоратор (v1): пишет create/destroy-опсы в реестр для device-loss recovery.
  // Frame-опсы (useProgram, setUniform*, drawArrays и пр.) — не журналируются
  // (это per-frame, идут в Tape, а не в Journal).
  const gl = session !== null
    ? session.facade
    : (options.journal !== undefined ? withJournal(rawGl, options.journal) : rawGl)

  const arena = createUniformArena(64 * 1024)
  const ctx = createCompileContext(arena, 'codegen')
  const segments = createSegmentStore(256)
  const clears = [options.clear ?? DEFAULT_CLEAR]
  const executor = createExecutor({
    gl, arena, commands: ctx.commands, clears,
    segments, uniformStrategy: options.uniformStrategy ?? 'auto',
  })

  const epoch = createEpoch()
  const layoutGuard = createLayoutGuard() // сейфгард: петли «атрибут↔layout↔observer»
  const uploads = createUploadScheduler(options.uploads ?? {})
  const transients = createTransientPool() // идея №2: скретч без GC
  const feeds = new Set<RendererFeed>() // M5: sync на границе кадра
  const builtinValues = createPassBuiltins() // u_time/u_resolution/u_texel проходов
  const writer = createTapeWriter(64)
  const [initW, initH] = getCanvasCssSize(canvas)
  const size = signal<readonly [number, number]>([initW, initH])
  const aspect = derive(() => size.value[0] / size.value[1])
  const time = signal(0)
  const frameCtx: FrameContext = { time: 0, dt: 0, aspect: 1, size: [1, 1] }
  const lives: LiveCommand[] = []
  const frameCallbacks: Array<(ctx: FrameContext, record: Recorder) => void> = []
  const startedAt = (options.now ?? defaultNow)()
  let lastNow = startedAt
  let running = false
  let cancelScheduled: (() => void) | null = null
  let lastCssWidth = -1
  let lastCssHeight = -1
  let disposed = false

  const [startW, startH] = getCanvasCssSize(canvas)
  resize(startW, startH) // синхронный стартовый вьюпорт
  const resizeObserver = observeSize(canvas, options)
  // Task 64 fix: FR-чистка забытых handle'ов — ТОЛЬКО GPU-cleanup через raw-фасад,
  // БЕЗ записи texture.destroy в журнал. Раньше колбэк звал сессионный фасад:
  // после device-loss GC собирал старые handle'ы (demo обнуляет их при re-init),
  // FR писал texture.destroy в ЖИВОЙ журнал → compact() вычищал create→destroy
  // пары → «журнал пустой» на следующей потере → сцена не восстанавливалась.
  // Семантика: FR срабатывает на УТЕЧКЕ (юзер забыл dispose) — это не
  // семантическое уничтожение ресурса, recovery-журнал он трогать не вправе.
  // Журнал остаётся источником истины: restoreResources() пересоздаст текстуру.
  const textureRegistry = makeTextureFinalizationRegistry(textureId => {
    if (session !== null) {
      // Стабильный id → raw id текущей инкарнации; id уже не известен сессии —
      // ресурс давно освобождён явно, чистить нечего.
      const raw = session.rawId(textureId)
      if (raw !== undefined) rawGl.deleteTexture(raw)
      return
    }
    // Без resourceSession (v1-путь): id фасадные, журнал не ведётся.
    gl.deleteTexture(textureId)
  })
  // StatsCollector — обвязка для cpuMs/drawCalls/memoryEstimate. Если не
  // инъекцирован (headless-тесты или demo без явной инъекции) — создаём свой.
  const ownStatsCollector = options.stats ?? null
  const statsCollector = ownStatsCollector ?? createStatsCollector(options.now)

  function command(spec: DrawSpec): CompiledCommand {
    return compileDrawSpec(spec, ctx)
  }

  function surface(surfaceOptions: SurfaceOptions = {}): Surface<CompiledCommand> {
    const width = surfaceOptions.width ?? 512
    const height = surfaceOptions.height ?? 512
    const depth = surfaceOptions.depth ?? false
    const color = surfaceOptions.color ?? (options.clear ?? DEFAULT_CLEAR).color
    const textureId = gl.createTexture(width, height)
    const targetId = gl.createTarget(textureId, width, height, depth, color)
    let surfaceDisposed = false
    const result: Surface<CompiledCommand> = {
      targetId,
      texture: { textureId, width, height },
      width,
      height,
      pass: (fragment: string, passOptions: PassOptions = {}) =>
        createPassCommand(fragment, passOptions, targetId, () => [width, height]),
      capture: (command: CompiledCommand, captureOptions: { clear?: boolean } = {}) =>
        withTarget(command, targetId, captureOptions.clear !== false),
      // Task 80: readback — синхронный readPixels через фасад (флип строк —
      // внутри фасада); наружу — единый контракт SurfaceRead (RGBA8, сверху-вниз).
      read: () => {
        if (surfaceDisposed) {
          return Promise.reject(new Error('rune: surface.read() после dispose — поверхность уже освобождена'))
        }
        try {
          return Promise.resolve({ width, height, data: gl.readTargetPixels(targetId) })
        } catch (e) {
          return Promise.reject(e)
        }
      },
      dispose: () => {
        if (surfaceDisposed) return
        surfaceDisposed = true
        gl.deleteTarget(targetId)
        gl.deleteTexture(textureId)
      },
    }
    return result
  }

  function pass(fragment: string, passOptions: PassOptions = {}): CompiledCommand {
    return createPassCommand(fragment, passOptions, 0, () => {
      const [w, h] = size.peek()
      return [Math.max(1, Math.round(w * dpr)), Math.max(1, Math.round(h * dpr))]
    })
  }

  function createPassCommand(
    fragment: string,
    passOptions: PassOptions,
    targetId: number,
    resolutionSource: () => readonly [number, number],
  ): CompiledCommand {
    const builtins = scanBuiltins(fragment)
    const uniforms: Record<string, unknown> = { ...passOptions.uniforms }
    applyBuiltins(uniforms, builtins, builtinValues, resolutionSource)
    const textures: Record<string, TextureHandle> = {}
    for (const [name, ref] of Object.entries(passOptions.inputs ?? {})) {
      textures[name] = { textureId: ref.textureId }
    }
    const compiled = compileDrawSpec({
      shader: { glsl: { vertex: PASS_VERT_GLSL, fragment } },
      // Полноэкранный проход: без глубины и куллинга — квад перекрывает всё
      pipeline: { depth: { test: 'always', write: false }, raster: { cull: 'none' } },
      attributes: {
        position: { data: FULLSCREEN_QUAD.positions, size: 2 },
        uv: { data: FULLSCREEN_QUAD.uvs, size: 2 },
      },
      uniforms: uniforms as never,
      textures,
      count: FULLSCREEN_QUAD.vertexCount,
    }, ctx)
    return withTarget(compiled, targetId, passOptions.clear === true)
  }

  function texture(width: number, height: number, options?: { mipLevels?: number; maxAnisotropy?: number; format?: GLTextureFormat }): Texture {
    const mipLevels = options?.mipLevels ?? 1
    // Task 67 HDR: формат хранения (rgba8/rgba16f/rgba32f) — уходит в фасад
    // (texStorage2D internalFormat + авто-вывод type загрузок) и в журнал
    // (texture.create.format → восстановление тем же форматом).
    const format = options?.format
    const textureId = gl.createTexture(width, height, { mipLevels, maxAnisotropy: options?.maxAnisotropy, format })
    // Memory tracking: байт/пиксель по формату (rgba16f — 8, rgba32f — 16).
    // Mip-chain добавляет ~33% (sum 1/4+1/16+...). Для 256² rgba16f с 9
    // уровнями: 256*256*8 * 4/3 ≈ 700 КБ (2× от rgba8).
    const bytesPerPixel = format === 'rgba16f' ? 8 : format === 'rgba32f' ? 16 : 4
    const memBytes = Math.round(width * height * bytesPerPixel * (mipLevels > 1 ? 4 / 3 : 1))
    statsCollector?.addMemory(memBytes)
    const handle = makeTextureHandle(textureId, width, height, mipLevels, memBytes)
    // Belt-and-suspenders: если пользователь забыл вызвать dispose() и
    // отпустил ссылку на handle — FR вызовет gl.deleteTexture за нас.
    // НО! FR недетерминирован по времени (зависит от GC). Для production
    // всегда полагаться на явный dispose().
    textureRegistry.register(handle, textureId)
    return handle
  }

  /** Task 62: handle над УЖЕ существующим стабильным textureId — для
   *  текстур, восстановленных restoreResources() после потери устройства.
   *  Не создаёт GPU-ресурс и не пишет в журнал: опс texture.create уже там.
   *  upload-методы и dispose работают через текущий фасад (стабильный id). */
  function attachTexture(textureId: number, width: number, height: number, mipLevels = 1): Texture {
    return makeTextureHandle(textureId, width, height, Math.max(1, mipLevels), 0)
  }

  /** Общий строитель TextureView-handle (createView и attachView — один путь;
   *  Task 62-принцип «create и attach — один и тот же код»). Отличается только
   *  источник viewId: свежесозданный фасадом vs восстановленный из журнала.
   *  onDispose — bookkeeping родителя (subViews.delete) до освобождения. */
  function makeTextureViewHandle(
    viewId: number,
    textureId: number,
    baseMipLevel: number,
    mipLevelCount: number | undefined,
    onDispose?: () => void,
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
        onDispose?.()
        try { gl.deleteTextureView(viewId) } catch { /* facade уже умер — no-op */ }
      },
    }
  }

  /** Task 64: handle над УЖЕ существующим стабильным viewId — для view'ов,
   *  восстановленных restoreResources() по опсу view.create. Не создаёт
   *  GPU-ресурс и не пишет в журнал. dispose() → deleteTextureView (запишет
   *  view.destroy в журнал сессии). */
  function attachView(viewId: number, textureId: number, baseMipLevel = 0, mipLevelCount?: number): TextureView {
    return makeTextureViewHandle(viewId, textureId, baseMipLevel, mipLevelCount)
  }

  /** Общий строитель Texture-handle (create и attach — один путь).
   *  memBytes=0 → без memory-tracking (adopted-текстура уже учтена при create). */
  function makeTextureHandle(textureId: number, width: number, height: number, mipLevels: number, memBytes: number): Texture {
    let manuallyDisposed = false
    // Task 58: sub-views создаются через createView. Список нужен для
    // cascade dispose: при dispose() parent-текстуры мы освобождаем и views.
    // (Это дублирует поведение facade.deleteTexture, который сам убирает
    // sub-views из внутреннего кэша — но мы держим ссылки на TextureView
    // handles, чтобы их dispose() тоже стал no-op без throw.)
    const subViews: Set<TextureView> = new Set()
    const handle: Texture = {
      textureId,
      width,
      height,
      mipLevels,
      upload: (source, options = {}) =>
        streamTexture(uploads, source, width, height,
          (tile, bytes) => gl.texSubImage2D(textureId, tile.x, tile.y, tile.width, tile.height, bytes),
          options),
      uploadImage: (source, options) => gl.texImage2DFromSource(textureId, source, options),
      uploadSubImage: (x, y, source, options) => gl.texSubImage2DFromSource(textureId, x, y, source, options),
      uploadMip: (level, source, options) => gl.texImage2DLevel(textureId, level, source, options),
      createView: (viewOptions) => {
        // Делегируем в facade.createTextureView (Task 56: WebGL2 LOD-clamp
        // через TEXTURE_BASE_LEVEL/TEXTURE_MAX_LEVEL; WebGPU — нативный
        // GPUTextureView). Facade бросает Error при невалидных опциях
        // (textureId не найден, mipLevels < 2, baseMipLevel вне диапазона).
        const viewId = gl.createTextureView(textureId, viewOptions)
        const view: TextureView = makeTextureViewHandle(
          viewId, textureId,
          viewOptions?.baseMipLevel ?? 0,
          viewOptions?.mipLevelCount,
          () => { subViews.delete(view) },
        )
        subViews.add(view)
        return view
      },
      dispose: () => {
        if (manuallyDisposed) return
        manuallyDisposed = true
        // Сначала освобождаем все sub-views (чтобы их dispose-флаги выставились
        // и будущие вызовы были no-op). Facade.deleteTexture тоже убирает
        // sub-views из кэша, но мы вызываем явно для симметрии API.
        for (const view of subViews) view.dispose()
        subViews.clear()
        gl.deleteTexture(textureId)
        if (memBytes > 0) statsCollector?.subMemory(memBytes)
        // Отменить FR-регистрацию (если был): unregister гасит будущий колбэк
        textureRegistry.unregister(handle)
      },
    }
    return handle
  }

  function live(spec: DrawSpec, deps: readonly ReadableSignal[] = [], props: unknown = {}): LiveCommand {
    const compiled = compileDrawSpec(spec, ctx)
    const liveCommand = createLiveCommand(segments, w => compiled.record(props, frameCtx, w), deps)
    lives.push(liveCommand)
    return liveCommand
  }

  function frame(callback: (ctx: FrameContext, record: Recorder) => void): FrameHandle {
    frameCallbacks.push(callback)
    return { cancel: () => removeItem(frameCallbacks, callback) }
  }

  function resize(cssWidth: number, cssHeight: number): void {
    // Идемпотентность: повторные срабатывания наблюдателя с тем же CSS-размером
    // не трогают backing store (каждая запись canvas.width сбрасывает буфер).
    if (cssWidth === lastCssWidth && cssHeight === lastCssHeight) return
    lastCssWidth = cssWidth
    lastCssHeight = cssHeight
    const bufferWidth = Math.max(1, Math.round(cssWidth * dpr))
    const bufferHeight = Math.max(1, Math.round(cssHeight * dpr))
    if (canvas.width !== bufferWidth) canvas.width = bufferWidth
    if (canvas.height !== bufferHeight) canvas.height = bufferHeight
    size.value = [cssWidth, cssHeight]
    gl.setViewport(bufferWidth, bufferHeight)
  }

  function step(nowMs: number): void {
    updateFrameContext(nowMs)
    statsCollector?.beginFrame()
    transients.beginFrame() // скретч прошлого кадра начинает стареть
    epoch.frame(() => {
      // M5 (Task 73): транспорт — снапшот изменившихся слотов на границе
      // кадра (эпоха): зеркала сигналов согласованы до колбэков кадра.
      options.transport?.sampleAll()
      // M5 (Task 73): фиды — снять published, залить грязный диапазон
      // одним вызовом, поднять count-сигнал. Команды кадра читают
      // уже согласованный снапшот.
      for (const feed of feeds) feed.sync()
      time.value = frameCtx.time
      writer.reset()
      writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
      buildFrame(lives, writer)
      emitFrameCallbacks()
      writer.emit(OpCode.EndPass, 0, 0, 0, 0)
      executor.run(writerView(writer))
      uploads.drain() // idle-слот: стриминг исполняется после кадра
    })
    statsCollector?.endFrame()
    drainGlErrors()
  }

  /** Task 69: дренаж тихих GL-ошибок раз в кадр (паритет onGpuError).
   *  getError() возвращает ОДИН код и снимает флаг — крутим до NO_ERROR
   *  (с пределом защиты от бесконечного цикла). Ошибки, накопленные любыми
   *  опсами кадра (загрузки, дравы, state-переключения), ловятся здесь.
   *  CONTEXT_LOST_WEBGL тоже пройдёт — дублирует listener, но раньше него
   *  (listener_async — событие асинхронное). */
  let lastGlErrorKey = ''
  function drainGlErrors(): void {
    if (rawContext === null) return // headless-инъекция facade — нет raw-контекста
    const codes: number[] = []
    for (let i = 0; i < 16; i++) {
      const code = rawContext.getError()
      if (code === 0 /* NO_ERROR */) break
      codes.push(code)
    }
    if (codes.length === 0) {
      lastGlErrorKey = ''
      return
    }
    const key = codes.join(',')
    if (key === lastGlErrorKey) return // не спамим одну и ту же ошибку каждый кадр
    lastGlErrorKey = key
    const described = codes.map(c => `${glErrorName(c)} (0x${c.toString(16)})`).join(', ')
    options.onGlError?.(`GL error: ${described} — ошибка накоплена в последнем кадре (создание текстур/загрузки/draw)`)
  }

  function updateFrameContext(nowMs: number): void {
    frameCtx.time = (nowMs - startedAt) / 1000
    frameCtx.dt = (nowMs - lastNow) / 1000
    frameCtx.aspect = aspect.peek()
    frameCtx.size = size.peek()
    lastNow = nowMs
  }

  function emitFrameCallbacks(): void {
    for (const callback of [...frameCallbacks]) callback(frameCtx, recordIntoWriter)
  }

  function recordIntoWriter(command: CompiledCommand, props: unknown = {}): void {
    command.record(props, frameCtx, writer)
    statsCollector?.addDrawCall()
  }

  function start(): void {
    if (running) return
    running = true
    scheduleNext()
  }

  function scheduleNext(): void {
    const request = options.requestFrame ?? requestFrameDefault
    cancelScheduled = request(timestamp => {
      if (!running) return
      step(timestamp)
      scheduleNext()
    })
  }

  function stop(): void {
    running = false
    cancelScheduled?.()
    cancelScheduled = null
  }

  function observeSize(canvas: AnyCanvas, options: WebGL2RendererOptions): ResizeObserver | null {
    if (options.observeResize === false) return null
    if (isOffscreenCanvas(canvas)) return null
    if (typeof ResizeObserver === 'undefined') return null
    const observer = new ResizeObserver(() => {
      const [cssW, cssH] = getCanvasCssSize(canvas)
      const verdict = layoutGuard.classify(cssW, cssH)
      if (verdict.verdict !== 'apply') return // ignore: дребезг; runaway: петля заблокирована
      resize(verdict.cssWidth, verdict.cssHeight)
    })
    observer.observe(canvas)
    return observer
  }

  /** M5 (Task 73): фид рендерера — dual-bind канал инстансных данных.
   *  Создаёт GPU-зеркало (createBuffer — журналируемый DeclOp) и вешает
   *  sync на границу кадра (внутри epoch.frame — count-сигнал согласован). */
  function feed(feedOptions: RendererFeedOptions | TransportFeedView): RendererFeed {
    const rendererFeed = createRendererFeedGL(gl, feedOptions)
    feeds.add(rendererFeed)
    return rendererFeed
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    stop()
    resizeObserver?.disconnect()
    // M5: фиды рендерера — GPU-буферы (GL: deleteBuffer → журналируемый
    // destroy; WebGPU: keyed-кэш фасада чистится его dispose()).
    for (const rendererFeed of feeds) rendererFeed.dispose()
    feeds.clear()
    // Удалить всё, что накопилось во внутренних кэшах фасада.
    // (фасад умеет идемпотентно delete по несуществующему id — но мы
    // проходим по своим записям, чтобы не трогать то, что юзер уже dispose'нул.)
    // На уровне фасада нет итератора — поэтому полагаемся на то, что
    // пользователь должен держать ссылки на Texture/Surface и диспозить их
    // сам. renderer.dispose() — это «закрыть цикл + снести ResizeObserver
    // + обнулить кадровый контекст». Полное разрушение GL-контекста делает
    // браузер при потере страницы.
  }

  // Caps probing: на real gl-контексте (если есть). Headless-режим (createGL
  // инъектирован) — caps = null; тесты должны инъекцировать свой caps.
  // GpuTimer — если есть расширение EXT_disjoint_timer_query_webgl2. Подключается
  // к statsCollector через setGpuTimer — gpuMs начнёт писаться в snapshot().
  const probedCaps: Caps | null = (() => {
    if (options.caps !== undefined) return options.caps
    if (rawContext === null) return null
    try {
      const query = probeGLCaps(makeGLProbe(rawContext))
      // GPU timer-query: создаём если caps.has('timestamp-query'). В StatsCollector
      // подключается через setGpuTimer — gpuMs появится в snapshot() в следующем кадре.
      if (query.features.has('timestamp-query')) {
        const timer: GpuTimer | null = createGLGpuTimer(rawContext)
        if (timer !== null) {
          statsCollector.setGpuTimer(timer)
        }
      }
      // statsProvider всегда берёт снапшот из statsCollector (внешний ИЛИ наш).
      return createCaps(query, () => statsCollector.snapshot())
    } catch {
      return null
    }
  })()

  return {
    gl,
    caps: probedCaps,
    size,
    aspect,
    time,
    uploads,
    transients,
    transport: options.transport ?? null,
    feed,
    texture,
    attachTexture,
    attachView,
    restoreResources: session !== null ? (options?: { workingSet?: WorkingSet }) => session.restore(options?.workingSet) : undefined,
    ensureResident: session !== null ? (resourceId: number) => session.ensureResident(resourceId) : undefined,
    evictLRU: session !== null ? (options?: { budgetBytes?: number; pinned?: WorkingSet }) => session.evictLRU(options) : undefined,
    residencyStats: session !== null ? () => session.residencyStats() : undefined,
    command,
    pass,
    surface,
    live,
    frame,
    resize,
    step,
    start,
    stop,
    dispose,
  } as WebGL2Renderer
}

function acquireWebGL2(canvas: AnyCanvas): WebGL2RenderingContext {
  // Каскад: часть драйверов отвергает antialias+preserveDrawingBuffer вместе.
  // alpha:false — Task 69: ПАРИТЕТ КОМПОЗИТИНГА с WebGPU (alphaMode:'opaque').
  // С alpha:true (было — дефолт) прозрачные пиксели кадра (например, пустые
  // области атласа (0,0,0,0)) становятся СКВОЗНЫМИ — композитор показывает
  // фон страницы, поведение зависит от браузера/GPU/фон-стилей. С alpha:false
  // альфа игнорируется при композитинге: те же пиксели — чёрные, РОВНО как
  // на WebGPU. Одинаковая сцена — одинаковая картинка на обоих бэкендах.
  const attempts: WebGLContextAttributes[] = [
    { antialias: true, preserveDrawingBuffer: true, alpha: false },
    { antialias: false, preserveDrawingBuffer: true, alpha: false },
    { alpha: false },
  ]
  for (const attributes of attempts) {
    const gl = canvas.getContext('webgl2', attributes)
    if (gl !== null) return gl as WebGL2RenderingContext
  }
  const inIframe = typeof window !== 'undefined' && window.self !== window.top
  throw new Error(
    inIframe
      ? 'rune: WebGL2 недоступен внутри этого превью-окна (iframe без доступа к GPU). ' +
        'Откройте страницу напрямую в браузере — в новой вкладке Chrome/Edge/Safari.'
      : 'rune: WebGL2 недоступен. Включите аппаратное ускорение в настройках браузера ' +
        '(система → Использовать аппаратное ускорение, перезапуск) или откройте файл ' +
        'в Chrome/Edge/Firefox свежей версии.',
  )
}

function defaultNow(): number {
  return performance.now()
}

/** Человекочитаемое имя GL-кода ошибки (WebGL2 spec + CONTEXT_LOST_WEBGL). */
function glErrorName(code: number): string {
  switch (code) {
    case 0x0500: return 'INVALID_ENUM'
    case 0x0501: return 'INVALID_VALUE'
    case 0x0502: return 'INVALID_OPERATION'
    case 0x0503: return 'STACK_OVERFLOW'
    case 0x0504: return 'STACK_UNDERFLOW'
    case 0x0505: return 'OUT_OF_MEMORY'
    case 0x0506: return 'INVALID_FRAMEBUFFER_OPERATION'
    case 0x9242: return 'CONTEXT_LOST_WEBGL'
    default: return `UNKNOWN_${code}`
  }
}

function requestFrameDefault(callback: (timestamp: number) => void): () => void {
  const id = requestAnimationFrame(callback)
  return () => cancelAnimationFrame(id)
}

function removeItem<T>(list: T[], item: T): void {
  const at = list.indexOf(item)
  if (at >= 0) list.splice(at, 1)
}

/** FinalizationRegistry для Texture: belt-and-suspenders.
 *
 * Если пользователь забыл вызвать texture.dispose() и отпустил ссылку на
 * handle — GC соберёт объект, FR колбэк подчистит GPU-текстуру за нас.
 *
 * ВАЖНО: FR НЕ детерминирован. Зависит от GC, который может не пойти пока
 * давление памяти не появится. Для production-кода ВСЕГДА полагаться на
 * явный dispose(). FR — только страхующий механизм для утечек.
 *
 * ВАЖНО (Task 64): disposer вызывается ТОЛЬКО для GPU-cleanup. Он не имеет
 * права писать semantic-опсы (texture.destroy) в ResourceJournal: FR срабатывает
 * на утечке, а не на намеренном освобождении, и журнал восстановления не должен
 * зависеть от расписания GC (после device-loss старые handle'ы собираются GC —
 * это НЕ должно вычищать create-опсы из журнала).
 *
 * env-проверка: в среде без FinalizationRegistry (старые Node/sandbox) —
 * возвращается no-op registry. */
function makeTextureFinalizationRegistry(disposeGpu: (textureId: number) => void): {
  register: (target: object, heldValue: number) => void
  unregister: (target: object) => void
} {
  if (typeof FinalizationRegistry === 'undefined') {
    return { register: () => {}, unregister: () => {} }
  }
  const registry = new FinalizationRegistry((textureId: number) => {
    // Ошибки GPU-cleanup (фасад уже мёртв после dispose renderer'а) — молча
    // пропускаем: чистить нечего.
    try {
      disposeGpu(textureId)
    } catch {
      // фасад закрыт — нечего диспозить
    }
  })
  return {
    register: (target, heldValue) => registry.register(target, heldValue),
    unregister: target => registry.unregister(target),
  }
}
