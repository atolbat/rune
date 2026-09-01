import {
  createEpoch,
  createLayoutGuard,
  createTapeWriter,
  createTransientPool,
  derive,
  signal,
  writerView,
  OpCode,
} from '@rune/core'
import type { ReadableSignal, TransientPool, Journal, TransportClient, TransportFeedView } from '@rune/core'
import { createRealGPU } from '@rune/webgpu'
import { compileWgslSpec, createGpuExecutor, createSliceArena, createWgpuContext } from '@rune/webgpu'
import { createUploadScheduler } from '@rune/core'
import type { UploadScheduler, UploadSchedulerOptions } from '@rune/core'
import type { GPUFacade, WgpuCommand, WgpuDrawSpec, GpuTapeExecutor, SliceArena, WgpuCompileContext, TextureHandle } from '@rune/webgpu'
import { createRendererFeedGPU } from './rendererFeed.ts'
import type { RendererFeed, RendererFeedOptions } from './rendererFeed.ts'
import {
  FULLSCREEN_QUAD,
  PASS_VERT_WGSL,
  applyBuiltins,
  createPassBuiltins,
  scanBuiltins,
  withTarget,
} from './surface.ts'
import type { PassOptions, Surface, SurfaceOptions } from './surface.ts'
import { canvasDpr, getCanvasCssSize, isOffscreenCanvas, resolveCanvasAny } from './canvasHelpers.ts'
import type { AnyCanvas } from './canvasHelpers.ts'
import { withJournalGpu } from './journalGpu.ts'
import { createResourceSessionGPU } from './resourceSessionGPU.ts'
import type { ResourceJournal, RestoreReport, WorkingSet, EvictionReport, ResidencyStats } from '@rune/core'

/** Контекст кадра WebGPU-рендерера (совместим с WebGL2-фасадом по форме). */
export interface GpuFrameContext {
  time: number
  dt: number
  aspect: number
  size: readonly [number, number]
}

/** Запись WG-команды текущего кадра (в ленту, как в WebGL2). */
export type GpuRecorder = (command: WgpuCommand, props?: unknown) => void

/** Кадровый колбэк: контекст + запись команд в ленту. */
export type GpuFrameCallback = (ctx: GpuFrameContext, record: GpuRecorder) => void
/** Рендерер на WebGPU: device, авто-цикл, resize/DPR, sim-time. */
export interface WebGpuRenderer {
  readonly gpu: GPUFacade
  /** Task 62: replay ResourceJournal v2 на СВЕЖЕМ фасаде этой сессии —
   *  device-loss recovery. Присутствует только при опции resources.
   *  Task 65: options.workingSet — soft reset (восстановить только сцену;
   *  остальное лениво через ensureResident). */
  restoreResources?(options?: { workingSet?: WorkingSet }): RestoreReport
  /** Task 65: ленивый возврат ОДНОГО отложенного ресурса после soft reset
   *  (texture/view/target id). null — уже резидентен / нет сессии. */
  ensureResident?(resourceId: number): RestoreReport | null
  /** Task 66: LRU-вытеснение резидентных текстур до бюджета GPU-памяти
   *  (паритет с WebGL2-рендерером; давление памяти между потерями). */
  evictLRU?(options?: { budgetBytes?: number; pinned?: WorkingSet }): EvictionReport
  /** Task 66: оценка резидентной GPU-памяти + LRU-порядок (диагностика). */
  residencyStats?(): ResidencyStats
  readonly size: ReadableSignal<readonly [number, number]>
  readonly aspect: ReadableSignal<number>
  readonly time: ReadableSignal<number>
  /** Стриминг-планировщик: задачи в idle-слоте каждого кадра. */
  readonly uploads: UploadScheduler
  /** Кадровый пул скретч-массивов (идея №2): паритет с WebGL2-рендерером. */
  readonly transients: TransientPool
  /** M5 (Task 73): транспорт-клиент читателя — диагностика режима
   *  (renderer.transport.mode, досье §7.2). null — без транспорта. */
  readonly transport: TransportClient | null
  /** M5 (Task 73): фид рендерера (dual-bind: vertex-атрибуты + storage;
   *  sync — writeBuffer одним вызовом на границе кадра). */
  feed(options: RendererFeedOptions | TransportFeedView): RendererFeed
  /** Компилирует WG-спек в команду (ленты, слайс-арена, ленивый пайплайн). */
  command(spec: WgpuDrawSpec): WgpuCommand
  /** Полноэкранный проход в канвас: входы → фрагмент → экран. */
  pass(fragment: string, options?: PassOptions): WgpuCommand
  /** Поверхность-цель: текстура + полноэкранные проходы в неё. */
  surface(options?: SurfaceOptions): Surface<WgpuCommand>
  frame(callback: GpuFrameCallback): { cancel(): void }
  resize(cssWidth: number, cssHeight: number): void
  step(nowMs: number): void
  start(): void
  stop(): void
  /** Снимает паузу шторма ошибок и продолжает цикл. */
  restart(): void
  /** Полный teardown: stop rAF + disconnect ResizeObserver + GPUFacade.dispose()
   *  (уничтожение всех текстур/буферов/пайплайнов + device.destroy()).
   *  В отличие от WebGL2, WebGPU-устройство детерминированно освобождает
   *  всю GPU-память через device.destroy() — это критично при частом
   *  switch backend в kit-demo: без destroy() утечка GPU-памяти.
   *  Для поштучного освобождения WebGL2-текстур используйте
   *  Texture.dispose() / Surface.dispose() — это gpu.deleteTexture.
   *  Идемпотентно: повторный dispose — no-op. */
  dispose(): void
}

export interface WebGpuRendererOptions {
  readonly canvas: AnyCanvas | string
  readonly dpr?: number
  readonly uploads?: UploadSchedulerOptions
  /** Инъекция GPU-фасада для headless-тестов. */
  readonly createGPU?: (canvas: AnyCanvas, onError?: (message: string) => void) => Promise<GPUFacade>
  /** Приём тихих ошибок валидации WebGPU (они не бросают исключений). */
  readonly onGpuError?: (message: string) => void
  readonly requestFrame?: (callback: (timestamp: number) => void) => () => void
  readonly observeResize?: boolean
  readonly now?: () => number
  /** Journal — реестр долгоживущих деклараций для device-loss recovery
   *  (= switchBackend = worker migration). Task 57: WebGPU-паритет с WebGL2.
   *  Если передан, GPUFacade оборачивается декоратором withJournalGpu:
   *  create/destroy-опсы (createTexture, createTarget, createTextureView,
   *  copyExternalImageToTexture как full-texture upload) пишутся автоматически.
   *  Replay — через replayJournalOnGpu(journal, newGpu, sourceFor).
   *
   *  Frame-опсы (usePipeline, bindUniforms, bindTexture, draw, submit и пр.)
   *  НЕ журналируются — это per-frame, идут в Tape, не в Journal.
   *  WGSL-источник пайплайнов хранится в WgpuCommand (compiled), поэтому для
   *  device-loss recovery достаточно replay-нуть только текстуры/цели/views —
   *  пайплайны пересоздадутся автоматически при первом draw на новом device. */
  readonly journal?: Journal
  /** Task 62: ResourceJournal v2 — стабильные id + контент в журнале.
   *  Паритет с WebGL2-путём (webgl2Renderer.ts): GPUFacade оборачивается
   *  resourceSession-декоратором, restoreResources() восстанавливает
   *  текстуры/цели/views и ИХ КОНТЕНТ на свежем устройстве.
   *  Приоритет над journal (v1). */
  readonly resources?: ResourceJournal
  /** M5 (Task 73): транспорт-клиент читателя (renderer.transport). */
  readonly transport?: TransportClient
}

/** Порог шторма: после стольких ошибок GPU рендер ставится на паузу. */
const ERROR_STORM_LIMIT = 3

/** Создаёт WebGPU-рендерер: кадр = beginPass → колбэки → endPass → submit.
 * Защита от шторма: после ERROR_STORM_LIMIT ошибок GPU цикл останавливается. */
export async function createWebGpuRenderer(options: WebGpuRendererOptions): Promise<WebGpuRenderer> {
  const canvas = resolveCanvasAny(options.canvas)
  const dpr = canvasDpr(canvas, options.dpr)
  const storm = createErrorStorm(options.onGpuError)
  const rawGpu = options.createGPU !== undefined
    ? await options.createGPU(canvas, storm.handle)
    : await createRealGPU(canvas, storm.handle)
  // Task 62: resourceSession (v2) — приоритет над journal (v1).
  // Стабильные id над фасадом + контент в журнале + restoreResources().
  const session = options.resources !== undefined ? createResourceSessionGPU(rawGpu, options.resources) : null
  // Task 57 (v1): Journal-декоратор для WebGPU (паритет с WebGL2).
  const gpu: GPUFacade = session !== null
    ? session.facade
    : (options.journal !== undefined ? withJournalGpu(rawGpu, options.journal) : rawGpu)

  const epoch = createEpoch()
  const layoutGuard = createLayoutGuard()
  const uploads = createUploadScheduler(options.uploads ?? {})
  const transients = createTransientPool() // идея №2: скретч без GC
  const feeds = new Set<RendererFeed>() // M5: sync на границе кадра
  const builtinValues = createPassBuiltins() // u_time/u_resolution/u_texel проходов
  const writer = createTapeWriter(64)
  const arena: SliceArena = createSliceArena(1 << 16)
  const wgslCtx: WgpuCompileContext = createWgpuContext(arena)
  // executor держит ТУ ЖЕ ссылку на массив команд: compileWgslSpec дополняет её
  const executor: GpuTapeExecutor = createGpuExecutor({ gpu, arena, commands: wgslCtx.commands, clears: [] })
  const [initW, initH] = getCanvasCssSize(canvas)
  const size = signal<readonly [number, number]>([initW, initH])
  const aspect = derive(() => size.value[0] / size.value[1])
  const time = signal(0)
  const frameCtx: GpuFrameContext = { time: 0, dt: 0, aspect: 1, size: [1, 1] }
  const callbacks: GpuFrameCallback[] = []
  const startedAt = (options.now ?? defaultNow)()
  let lastNow = startedAt
  let running = false
  let cancelScheduled: (() => void) | null = null
  let lastCssWidth = -1
  let lastCssHeight = -1

  await gpu.configure(canvas.width, canvas.height)
  const [startW, startH] = getCanvasCssSize(canvas)
  resize(startW, startH)
  const resizeObserver = observeSize(canvas, options)
  let disposed = false

  function frame(callback: GpuFrameCallback): { cancel(): void } {
    callbacks.push(callback)
    return { cancel: () => removeItem(callbacks, callback) }
  }

  function command(spec: WgpuDrawSpec): WgpuCommand {
    return compileWgslSpec(spec, wgslCtx)
  }

  function surface(surfaceOptions: SurfaceOptions = {}): Surface<WgpuCommand> {
    const width = surfaceOptions.width ?? 512
    const height = surfaceOptions.height ?? 512
    const depth = surfaceOptions.depth ?? false
    const color = surfaceOptions.color ?? DEFAULT_SURFACE_COLOR
    // Формат канваса: пайплайны (targets: [format]) подходят и канвасу,
    // и поверхности — без второй ветки создания пайплайнов
    const textureId = gpu.createTexture(width, height, 'canvas')
    const targetId = gpu.createTarget(textureId, width, height, depth, color)
    let surfaceDisposed = false
    return {
      targetId,
      texture: { textureId, width, height },
      width,
      height,
      pass: (fragment: string, passOptions: PassOptions = {}) =>
        createPassCommand(fragment, passOptions, targetId, () => [width, height]),
      capture: (command: WgpuCommand, captureOptions: { clear?: boolean } = {}) =>
        withTarget(command, targetId, captureOptions.clear !== false),
      // Task 80: readback — асинхронный (copyTextureToBuffer → submit →
      // mapAsync); фасад отдаёт уже tight RGBA сверху-вниз — как GL.
      read: () => {
        if (surfaceDisposed) {
          return Promise.reject(new Error('rune: surface.read() после dispose — поверхность уже освобождена'))
        }
        return gpu.readTargetPixels(targetId).then(data => ({ width, height, data }))
      },
      dispose: () => {
        if (surfaceDisposed) return
        surfaceDisposed = true
        gpu.deleteTarget(targetId)
        gpu.deleteTexture(textureId)
      },
    }
  }

  function pass(fragment: string, passOptions: PassOptions = {}): WgpuCommand {
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
  ): WgpuCommand {
    const inputs = Object.entries(passOptions.inputs ?? {})
    if (inputs.length > 1) {
      throw new Error('rune: v1 WebGPU-проход — один текстурный вход (bind-группа group 1); для цепочек используйте последовательные проходы')
    }
    const builtins = scanBuiltins(fragment)
    const uniforms: Record<string, unknown> = { ...passOptions.uniforms }
    applyBuiltins(uniforms, builtins, builtinValues, resolutionSource)
    const textures: Record<string, TextureHandle> = {}
    for (const [name, ref] of inputs) {
      textures[name] = { textureId: ref.textureId }
    }
    const compiled = compileWgslSpec({
      shader: { wgsl: PASS_VERT_WGSL + fragment },
      uniforms,
      attributes: {
        position: { data: FULLSCREEN_QUAD.positions, size: 2 },
        uv: { data: FULLSCREEN_QUAD.uvs, size: 2 },
      },
      textures,
      count: FULLSCREEN_QUAD.vertexCount,
    }, wgslCtx)
    return withTarget(compiled, targetId, passOptions.clear === true)
  }

  /** Записывает WG-команду в ленту кадра (вызывается из колбэков frame). */
  function recordIntoWriter(command: WgpuCommand, props: unknown = {}): void {
    command.record(props, frameCtx, writer)
  }

  function resize(cssWidth: number, cssHeight: number): void {
    if (cssWidth === lastCssWidth && cssHeight === lastCssHeight) return
    lastCssWidth = cssWidth
    lastCssHeight = cssHeight
    const bufferWidth = Math.max(1, Math.round(cssWidth * dpr))
    const bufferHeight = Math.max(1, Math.round(cssHeight * dpr))
    if (canvas.width !== bufferWidth) canvas.width = bufferWidth
    if (canvas.height !== bufferHeight) canvas.height = bufferHeight
    size.value = [cssWidth, cssHeight]
    gpu.resize(bufferWidth, bufferHeight)
  }

  function step(nowMs: number): void {
    if (storm.paused) return // шторм ошибок: рендер на паузе
    updateFrameContext(nowMs)
    transients.beginFrame() // скретч прошлого кадра начинает стареть
    epoch.frame(() => {
      // M5 (Task 73): транспорт — снапшот слотов на границе кадра (эпоха),
      // затем фиды — writeBuffer грязного диапазона одним вызовом.
      options.transport?.sampleAll()
      for (const feed of feeds) feed.sync()
      time.value = frameCtx.time
      writer.reset()
      writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
      for (const callback of [...callbacks]) callback(frameCtx, recordIntoWriter)
      writer.emit(OpCode.EndPass, 0, 0, 0, 0)
      executor.run(writerView(writer)) // ленты: тот же путь, что и WebGL2
      uploads.drain() // idle-слот: стриминг после кадра
    })
  }

  function updateFrameContext(nowMs: number): void {
    frameCtx.time = (nowMs - startedAt) / 1000
    frameCtx.dt = (nowMs - lastNow) / 1000
    frameCtx.aspect = aspect.peek()
    frameCtx.size = size.peek()
    lastNow = nowMs
  }

  function start(): void {
    if (running) return
    if (storm.paused) return // после шторма старт вручную через restart()
    running = true
    scheduleNext()
  }

  function scheduleNext(): void {
    const request = options.requestFrame ?? defaultRequestFrame
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

  function restart(): void {
    storm.resume()
    start()
  }

  function observeSize(canvas: AnyCanvas, options: WebGpuRendererOptions): ResizeObserver | null {
    if (options.observeResize === false) return null
    if (isOffscreenCanvas(canvas)) return null
    if (typeof ResizeObserver === 'undefined') return null
    const observer = new ResizeObserver(() => {
      const [cssW, cssH] = getCanvasCssSize(canvas)
      const verdict = layoutGuard.classify(cssW, cssH)
      if (verdict.verdict !== 'apply') return
      resize(verdict.cssWidth, verdict.cssHeight)
    })
    observer.observe(canvas)
    return observer
  }

  /** M5 (Task 73): фид рендерера — keyed-буфер по стабильному view,
   *  writeBuffer одним вызовом на границе кадра. */
  function feed(feedOptions: RendererFeedOptions | TransportFeedView): RendererFeed {
    const rendererFeed = createRendererFeedGPU(gpu, feedOptions)
    feeds.add(rendererFeed)
    return rendererFeed
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    stop()
    resizeObserver?.disconnect()
    // M5: фиды (keyed-буферы фасада — device.destroy() в gpu.dispose()
    // освобождает их детерминированно).
    for (const rendererFeed of feeds) rendererFeed.dispose()
    feeds.clear()
    // Полный teardown GPU-фасада: device.destroy() освобождает всю
    // GPU-память устройства детерминированно (текстуры/буферы/
    // пайплайны/семплеры, включая не уничтоженные явно). Это
    // критично при частом switch backend в kit-demo: без destroy()
    // каждое переключение создавало бы новое GPUDevice, а старые
    // оставались живыми до unload страницы → утечка GPU-памяти.
    gpu.dispose()
  }

  return { gpu, size, aspect, time, uploads, transients, transport: options.transport ?? null, feed, restoreResources: session !== null ? (options?: { workingSet?: WorkingSet }) => session.restore(options?.workingSet) : undefined, ensureResident: session !== null ? (resourceId: number) => session.ensureResident(resourceId) : undefined, evictLRU: session !== null ? (options?: { budgetBytes?: number; pinned?: WorkingSet }) => session.evictLRU(options) : undefined, residencyStats: session !== null ? () => session.residencyStats() : undefined, command, pass, surface, frame, resize, step, start, stop, restart, dispose }
}

/** Цвет очистки поверхностей по умолчанию — фон рендерера. */
const DEFAULT_SURFACE_COLOR: readonly [number, number, number, number] = [0.07, 0.08, 0.11, 1]

/** Шторм-охранник: считает ошибки GPU; после лимита глушит цикл. */
interface ErrorStorm {
  readonly paused: boolean
  readonly handle: (message: string) => void
  resume(): void
}

function createErrorStorm(report?: (message: string) => void): ErrorStorm {
  let count = 0
  let paused = false
  return {
    get paused() { return paused },
    handle: (message: string): void => {
      if (paused) return // тишина после паузы: без спама
      count++
      report?.(message)
      if (count >= ERROR_STORM_LIMIT) {
        paused = true
        report?.(`обнаружено ${count} ошибок GPU — рендер остановлен (пауза шторма)`)
      }
    },
    resume(): void {
      count = 0
      paused = false
    },
  }
}

function defaultRequestFrame(callback: (timestamp: number) => void): () => void {
  // requestAnimationFrame — свойство window, а не прототипа: голый вызов легален
  const id = requestAnimationFrame(callback)
  return () => cancelAnimationFrame(id)
}

function defaultNow(): number {
  return performance.now() // вызывается от владельца: вырванный из объекта
  // нативный метод кидает в Chrome «Illegal invocation»
}

function removeItem<T>(list: T[], item: T): void {
  const at = list.indexOf(item)
  if (at >= 0) list.splice(at, 1)
}
