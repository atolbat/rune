// Контракт фасада WebGPU: толстые операции над device/queue.

import type { TextureFormat } from '@rune/core'

/** Источник для атомарной загрузки текстуры (без стриминга/чанков).
 *  WebGPU ExternalImageSource = ImageBitmap | HTMLCanvasElement | HTMLVideoElement |
 *  VideoFrame | OffscreenCanvas (с getContext('2d') | 'webgl' | 'webgl2' | 'webgpu'). */
export type GPUImageSource =
  | ImageBitmap
  | HTMLCanvasElement
  | HTMLVideoElement
  | OffscreenCanvas
  | VideoFrame

/** Размеры источника для copyExternalImageToTexture.
 *
 *  WebGPU требует, чтобы copySize соответствовал размеру копируемого региона
 *  источника — иначе "Copy rect is out of bounds of external image". Мы не можем
 *  передать «размер текстуры-назначения» как copySize (что раньше делал unified
 *  renderer): source меньше → out of bounds.
 *
 *  Извлекаем width/height из source:
 *   • ImageBitmap / OffscreenCanvas / HTMLCanvasElement: .width / .height
 *   • HTMLVideoElement: .videoWidth / .videoHeight (видео может быть не полностью
 *     загружено — тогда 0×0, что WebGPU отвергнет; это ответственность вызывающего)
 *   • VideoFrame: .displayWidth / .displayHeight (coded* могут включать padding)
 */
export function externalImageSize(source: GPUImageSource): readonly [number, number] {
  // ImageBitmap, HTMLCanvasElement, OffscreenCanvas — все имеют .width/.height
  // HTMLVideoElement — имеет .videoWidth/.videoHeight (а .width/.height — это
  // CSS-размер элемента, бесполезен для GPU)
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) {
    return [source.videoWidth || 0, source.videoHeight || 0]
  }
  // VideoFrame — displayWidth/displayHeight (предпочтительнее coded*, которые
  // могут включать выравнивание кодека)
  const vf = source as { displayWidth?: number; displayHeight?: number; codedWidth?: number; codedHeight?: number }
  if (typeof vf.displayWidth === 'number' && typeof vf.displayHeight === 'number' && vf.displayWidth > 0) {
    return [vf.displayWidth, vf.displayHeight]
  }
  if (typeof vf.codedWidth === 'number' && typeof vf.codedHeight === 'number' && vf.codedWidth > 0) {
    return [vf.codedWidth, vf.codedHeight]
  }
  // ImageBitmap / HTMLCanvasElement / OffscreenCanvas — простой путь
  const s = source as { width?: number; height?: number }
  return [s.width ?? 0, s.height ?? 0]
}

// Утилита типа для ConditionalTypes (вынесен, чтобы не плодить копии в типах)
// (globalType удалён в Task 71: единственное применение — условный VideoFrame —
// заменён на прямую ссылку VideoFrame из lib.dom; WebCodecs-типы в среде есть.)

/** Handle, который GPUFacade дёргает в нужные моменты для writeTimestamp.
 *  Создаётся createGpuGpuTimer вместе с GpuTimer (core). Устанавливается в
 *  GPUFacade через installTimer(). realGPU вызывает handle.onBeginPass /
 *  onEndPass / onSubmit в нужные моменты командного потока. */
export interface GpuTimerHandle {
  onBeginPass(pass: GPURenderPassEncoder): void
  onEndPass(pass: GPURenderPassEncoder): void
  onSubmit(encoder: GPUCommandEncoder): void
}

/** M5 (Task 73): слот вершинного буфера пайплайна.
 *  number — tight-раскладка (arrayStride = size*4, offset 0);
 *  объект — интерливинг фида: stride (байты записи) + offset (байты поля).
 *  Пайплайн строит GPUVertexBufferLayout: arrayStride=stride,
 *  attribute offset=offset, формат по size.
 *  Task 75: step='instance' → stepMode 'instance' (запись фида читается
 *  один раз на инстанс — квады-звёзды; углы разворачиваются из
 *  @builtin(vertex_index) в шейдере). */
export type GpuAttrSlot = number | {
  readonly size: number
  readonly stride?: number
  readonly offset?: number
  readonly step?: 'vertex' | 'instance'
}

export interface GPUFacade {
  configure(width: number, height: number): void
  resize(width: number, height: number): void
  /** format 'canvas' — формат канваса (нужен поверхностям-целям,
   *  чтобы пайплайны подходили и канвасу, и поверхности).
   *  Task 67 HDR: 'rgba16float' (8 б/пиксель, filterable+renderable core)
   *  и 'rgba32float' (16 б/пиксель, renderable core; линейная фильтрация
   *  требует feature 'float32-filterable' — без неё sampler фасада
   *  деградирует до nearest). Паритет с WebGL2 createTexture({format}).
   *
   *  options.mipLevels (default 1): кол-во mip-уровней в цепи. Если >1 —
   *  mipLevelCount в descriptor, sampler с mipmapFilter='linear' (минификация
   *  выбирает mip по distance, аналог LINEAR_MIPMAP_LINEAR в WebGL2).
   *  copyExternalImageToTexture пишет в mip 0; для других мипов —
   *  copyExternalImageToTextureMip.
   *
   *  Контракт: WebGPU автоматически использует mip-chain при sampling, если
   *  mipLevelCount>1. Незагруженные мипы возвращают нули. Для progressive
   *  streaming (MipStreamer) рекомендуется держать lodMaxClamp на максимальный
   *  загруженный мип — но это уже responsibility texture-обёртки, не facade. */
  createTexture(
    width: number,
    height: number,
    format?: TextureFormat,
    options?: { mipLevels?: number; maxAnisotropy?: number },
  ): number
  texSubImage2D(textureId: number, x: number, y: number, width: number, height: number, bytes: Uint8Array): void
  /** Атомарная загрузка из bitmap/canvas/video в mip 0 — одним вызовом
   *  copyExternalImageToTexture.
   *
   *  Семантика (исправление бага «Copy rect is out of bounds of external image»):
   *   • dstX, dstY — origin в текстуре-назначении (куда писать)
   *   • copyWidth, copyHeight — размер копируемого региона (= размер source,
   *     НЕ размер текстуры). Должны быть ≤ source.width/height и ≤
   *     (texture.width - dstX) / (texture.height - dstY), иначе WebGPU
   *     бросит validation error.
   *   • flipY (default false) — если true, источник переворачивается по Y
   *     ПЕРЕД копированием. WebGPU нативно поддерживает эту опцию через
   *     GPUCopyExternalImageSourceInfo.flipY. Паритет с WebGL2:
   *     UNPACK_FLIP_Y_WEBGL делает то же самое — flipY=true на обоих
   *     бэкендах даёт идентичный результат.
   *
   *  Для full-texture upload: dstX=0, dstY=0, copyWidth=texture.width,
   *  copyHeight=texture.height (при совпадающем размере source).
   *
   *  Для sub-region upload (atlas packing): dstX=slot.x, dstY=slot.y,
   *  copyWidth=source.width, copyHeight=source.height. */
  copyExternalImageToTexture(
    textureId: number,
    source: GPUImageSource,
    dstX: number,
    dstY: number,
    copyWidth: number,
    copyHeight: number,
    flipY?: boolean,
  ): void
  /** Загрузка конкретного mip-уровня. copyExternalImageToTexture с
   *  destination.mipLevel=level. Source должен иметь размер N/(2^level).
   *  Используется MipStreamer'ом для progressive mip upload.
   *
   *  Семантика: dstX/dstY — origin в mip level, copyWidth/copyHeight —
   *  размер копируемого региона (обычно = mip size = N/(2^level)).
   *  flipY (default false) — аналог copyExternalImageToTexture (см. выше).
   *
   *  WebGPU-паритет с WebGL2 texImage2DLevel. */
  copyExternalImageToTextureMip(
    textureId: number,
    mipLevel: number,
    source: GPUImageSource,
    dstX: number,
    dstY: number,
    copyWidth: number,
    copyHeight: number,
    flipY?: boolean,
  ): void
  uploadUniforms(offset: number, data: Uint8Array): void
  /** M5 (Task 73): слот вершинного буфера — число (tight: size×4 байта,
   *  offset 0 — обратная совместимость) ИЛИ дескриптор интерливинга фида
   *  (size компонент, stride байты записи, offset байты поля).
   *  Task 75: desc — растеризационное состояние (blend/depth/cull/
   *  primitive) из GpuPipelineDesc; раньше пайплайн хардкодил
   *  less+write без блендинга. */
  ensurePipeline(pipelineId: number, wgsl: string, attrs: readonly GpuAttrSlot[], hasTextures: boolean, desc?: import('./pipeline/pipelineCache.ts').GpuPipelineDesc): void
  usePipeline(pipelineId: number): void
  bindUniforms(dynamicOffset: number): void
  bindVertexBuffer(slot: number, data: Float32Array, size: number): void
  /** M5 (Task 73): динамический вершинный буфер фида — writeBuffer одним
   *  вызовом на кадр (грязный диапазон [0, byteLength)). Ключ — сама
   *  Float32Array (стабильная у рендерера фида). Биндинг — executor'ом
   *  через bindVertexBuffer (тот же keyed-кэш). */
  syncVertexBuffer(data: Float32Array, byteLength: number): void
  bindTexture(textureId: number): void
  beginPass(clearIndex: number): void
  draw(count: number, instances: number): void
  endPass(): void
  submit(): void
  /** Task 80 (readback): прочитать пиксели ЦЕЛИ (surface) — Promise<Uint8Array>.
   *
   *  Контракт паритета с GL-фасадом (readTargetPixels → Uint8Array):
   *   - RGBA8, tight-раскладка (rowBytes = width*4, без 256-байтового
   *     выравнивания WebGPU — фасад уплотняет строки);
   *   - строки СВЕРХУ ВНИЗ: data[0..3] = верхний-левый пиксель (texture
   *     row 0; GL-фасад переворачивает readPixels ради этого же контракта);
   *   - каналы RGBA: канвасные bgra8unorm-форматы свиззлируются (B↔R).
   *
   *  Асинхронность: copyTextureToBuffer → submit → mapAsync (WebGPU-путь
   *  читает только через маппинг буфера). Открытый render-pass закрывается
   *  фасадом; копия дописывается в тот же командный буфер (порядок сохранён).
   *  targetId 0 (канвас) не читается — honest reject (presented-текстура
   *  живёт один кадр); читайте поверхность (renderer.surface().read()). */
  readTargetPixels(targetId: number): Promise<Uint8Array>
  /** Цель рендера: пасс пишет в текстуру (view + опциональная глубина). */
  createTarget(
    textureId: number,
    width: number,
    height: number,
    depth: boolean,
    color: readonly [number, number, number, number],
  ): number
  /** Переключить цель: 0 = канвас (закрывает текущий пасс, открывает новый). */
  bindTarget(targetId: number, clear: boolean): void

  /** Adapter — для caps probing (probeGPUCaps через exposeGPUCaps).
   *  null если caps-probing не нужен (headless/mock). */
  readonly adapter: GPUAdapter | null
  /** Device — для caps probing (device.limits.maxAnisotropy и др.).
   *  null в recording-фасаде (нет device). У некоторых браузеров
   *  adapter.limits НЕ содержит maxAnisotropy, но device.limits — да
   *  (после requestDevice()). Поэтому probeGPUCaps использует device
   *  как fallback к adapter.limits. */
  readonly device: GPUDevice | null
  /** Preferred canvas format — нужен capsProbe для bgra8unorm baseline. */
  readonly preferredFormat: GPUTextureFormat

  // ─── Disposal (M1 §9.9 disposal discipline) ───────────────────────────
  // WebGPU-ресурсы: texture (GPUTexture) и target (color view + опц. depth).
  // Pipelines/bindGroupLayouts/shaderModule/device — НЕ освобождаются вручную
  // до полного dispose(), т.к. они одноразово создаются под компиляцию спека
  // и живут до конца сессии рендерера (внутренний кэш).
  // VertexBuffers — особый случай: они keyed по Float32Array и освобождаются
  // автоматически через FinalizationRegistry (см. realGPU.ts).

  /** Удалить текстуру: GPUTexture.destroy + удаление из кэша.
   *  BindGroup для неё инвалидирован и будет пересоздан при след. bindTexture. */
  deleteTexture(textureId: number): void
  /** Удалить цель: уничтожает целевую depth-текстуру (если была). Цветовая
   *  текстура НЕ трогается (она — отдельный ресурс, см. deleteTexture). */
  deleteTarget(targetId: number): void
  /** Создать GPUTextureView с sub-mip-range. По умолчанию createTexture()
   *  создаёт default-view на всю mip-chain. Этот метод позволяет создать
   *  дополнительные views с ограниченным диапазоном мипов — для deep-zoom
   *  paging (sampler сэмплит только конкретный мип, без avg между уровнями).
   *
   *  WebGPU: GPUTextureViewDescriptor с baseMipLevel/mipLevelCount.
   *  WebGL2: эмулируется через TEXTURE_BASE_LEVEL / TEXTURE_MAX_LEVEL при
   *  bindTexture (per-texture state, переписывается каждый bind для
   *  предотвращения утечки состояния между view'ами). Реализовано в Task 56
   *  (GLFacade.createTextureView + deleteTextureView, disjoint id namespace
   *  с textureId через границу 1M). Паритет LOD-clamp на обоих бэкендах.
   *
   *  Контракт: createTextureView не требует mipLevels>1 в createTexture.
   *  Если textureId указывает на текстуру с mipLevels=1, а в options
   *  передаётся baseMipLevel=2 — WebGPU бросит validation error (асинхронно
   *  через onGpuError). Рекомендуется проверить texture.mipLevels перед
   *  созданием view.
   *
   *  @returns viewId — целочисленный handle. Используется в bindTexture(viewId).
   *  При dispose() фасада view уничтожается автоматически (GPUTextureView
   *  освобождается через device.destroy() неявно, как и оригинальный texture).
   *  Для поштучного освобождения — deleteTextureView(viewId). */
  createTextureView(
    textureId: number,
    options?: { baseMipLevel?: number; mipLevelCount?: number; baseArrayLayer?: number; arrayLayerCount?: number },
  ): number
  /** Удалить GPUTextureView (если был создан через createTextureView).
   *  Default-view (созданный в createTexture) не может быть удалён этим
   *  методом — он управляется вместе с текстурой (deleteTexture).
   *  Идемпотентно: повторный deleteTextureView того же id — no-op. */
  deleteTextureView(viewId: number): void
  /** Полный teardown фасада: уничтожает ВСЕ GPUTexture (textures map),
   *  UBO, vertex buffers, depth-texture (canvas attachment), target
   *  depth-textures, и в финале — device.destroy(). Идемпотентно:
   *  повторный dispose — no-op.
   *
   *  WebGPU-специфика: device.destroy() детерминированно освобождает всю
   *  GPU-память, выделенную устройством, включая все текстуры/буферы/
   *  пайплайны/семплеры, даже если они не были уничтожены явно. Это
   *  критично при частом switch backend (kit-demo): каждое переключение
   *  создаёт новое устройство. Без destroy() старые устройства остаются
   *  живыми до unload страницы → утечка GPU-памяти.
   *
   *  После dispose рендерер должен пересоздать фасад через createRealGPU —
   *  использовать старый GPUFacade нельзя (все ресурсы и device мертвы). */
  dispose(): void
  /** Установить GPU-timer handle для writeTimestamp hooks. handle != null
   *  включает begin/endPass + onSubmit hooks для timestamp-query. handle=null
   *  снимает hooks (для dispose или при ошибке timer'а).
   *
   *  realGPU вызывает handle.onBeginPass(pass) сразу после beginRenderPass,
   *  handle.onEndPass(pass) перед pass.end(), handle.onSubmit(encoder)
   *  перед encoder.finish() — это закрывает timestamps в правильном порядке.
   *
   *  Возвращает предыдущий handle (или null) — для chain/uninstall. */
  installTimer(handle: GpuTimerHandle | null): GpuTimerHandle | null
  /** GpuTimer (core), если device имеет 'timestamp-query' feature. null —
   *  если feature недоступна или timer деактивирован (device lost, mapAsync
   *  failed). Подключается к StatsCollector.setGpuTimer() в renderer.ts.
   *
   *  Важно: timer инициализирован внутри realGPU (querySet + resolveBuffer
   *  + readBuffer созданы на device). handle уже подключен к этому timer'у
   *  через installTimer внутри createRealGPU — пользователь GPUFacade не
   *  должен вызывать installTimer вручную (если только не подменяет timer
   *  для тестов). */
  readonly timer: import('@rune/core').GpuTimer | null
}
