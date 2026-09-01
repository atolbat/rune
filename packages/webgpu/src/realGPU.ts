/**
 * Настоящий фасад WebGPU: adapter/device, контекст канваса, UBO с dynamic
 * offsets, ленивые пайплайны (дескрипторы выводятся из атрибутов команды —
 * урок инцидента «тёмный канвас»), writeTexture-тайлы с origin, bind-группа
 * текстур (group 1). Тихие ошибки валидации уходят в onGpuError.
 */

import type { GPUFacade, GPUImageSource, GpuTimerHandle, GpuAttrSlot } from './facade.ts'
import type { GpuPipelineDesc } from './pipeline/pipelineCache.ts'
import { createGpuGpuTimer } from './gpuTimer.ts'
import type { GpuTimer } from '@rune/core'
import { GPU_FORMATS } from './formats.ts'
import type { TextureFormat, TextureFormatId } from '@rune/core'

/** Канвас любого типа (HTML или Offscreen). Избегаем циклической зависимости
 *  на @rune/gl, поэтому тип локальный, структурно совместимый. */
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas

/** Task 69: вариант sampleType текстурного биндинга (group 1). 'float' —
 *  фильтруемые текстуры (LINEAR); 'unfilterable-float' — rgba32float без
 *  feature 'float32-filterable' (NEAREST, сэмпл только через
 *  textureSampleLevel). */
type TextureSampleVariant = 'float' | 'unfilterable-float'

export async function createRealGPU(
  canvas: AnyCanvas,
  onGpuError?: (message: string) => void,
): Promise<GPUFacade> {
  const adapter = await navigator.gpu.requestAdapter()
  if (adapter === null) throw new Error('rune: WebGPU-адаптер недоступен')
  // Запросить timestamp-query feature ЕСЛИ adapter её поддерживает.
  // Это даёт device.createQuerySet({ type: 'timestamp' }) и pass.writeTimestamp.
  // На адаптерах без feature — device создаётся без неё, GpuTimer не подключается.
  const requiredFeatures: GPUFeatureName[] = []
  if (adapter.features.has('timestamp-query' as GPUFeatureName)) {
    requiredFeatures.push('timestamp-query' as GPUFeatureName)
  }
  // Task 69: 'float32-filterable' — линейная фильтрация rgba32float.
  // Запрашиваем, ЕСЛИ адаптер умеет (как timestamp-query): на таких устройствах
  // rgba32float остаётся LINEAR + sampleType 'float' — поведение не меняется.
  // На устройствах без feature фасад деградирует корректно: sampler → nearest,
  // bind-group/pipeline layout → sampleType 'unfilterable-float' + sampler
  // 'non-filtering' (см. bindTexture/ensurePipeline). Раньше bind-group
  // создавался с sampleType 'float' на любой текстуре → валидационная ошибка
  // «None of the supported sample types (UnfilterableFloat) … match the
  // expected sample types (Float)» при первом сэмплинге rgba32float.
  if (adapter.features.has('float32-filterable' as GPUFeatureName)) {
    requiredFeatures.push('float32-filterable' as GPUFeatureName)
  }
  // ─── WebGPU baseline: anisotropic filtering нативно, без requiredLimits ────
  // Task 54: по WebGPU spec (ver. 2026-08-20, MDN GPUSupportedLimits)
  // maxAnisotropy НЕ входит в специфицированный список свойств
  // GPUSupportedLimits — ни adapter.limits, ни device.limits. Это часть
  // базовой спецификации: GPUSamplerDescriptor.maxAnisotropy клампится
  // платформой к своему нативному максимуму (обычно 16). Не требуется
  // ни requiredFeatures, ни requiredLimits — анисотропная фильтрация
  // доступна на всех WebGPU-устройствах (платформа clamp'ит к 1 если
  // оборудование не поддерживает, что эквивалентно bilinear).
  //
  // realGPU.createTexture передаёт maxAnisotropy через GPUSamplerDescriptor
  // и платформа клампит. caps.has('anisotropic')=true (см. probeGPUCaps) —
  // согласовано с реальным применением sampler'а.
  let device: GPUDevice
  try {
    device = await adapter.requestDevice({ requiredFeatures })
  } catch {
    // requestDevice может упасть на валидации features или при отсутствии
    // устройства. Fallback — без requiredFeatures (timestamp-query не
    // запрошен, gpuMs будет null — честно, не фейковый 0).
    device = await adapter.requestDevice()
  }
  device.addEventListener('uncapturederror', event => {
    onGpuError?.(String((event as GPUUncapturedErrorEvent).error.message ?? event))
  })

  const context = canvas.getContext('webgpu') as GPUCanvasContext | null
  if (context === null) throw new Error('rune: webgpu-контекст канваса недоступен')
  const gpuContext: GPUCanvasContext = context
  const format = navigator.gpu.getPreferredCanvasFormat()

  const textures = new Map<number, { texture: GPUTexture; sampler: GPUSampler; view: GPUTextureView; format: GPUTextureFormat; filterable: boolean }>()
  const textureViews = new Map<number, { textureId: number; view: GPUTextureView }>()
  // Task 69: пайплайн кэшируется СПЕКОЙ + ВАРИАНТАМИ по sampleType текстурного
  // биндинга. Вариант 'float' (sampler 'filtering' + texture 'float') — дефолт;
  // 'unfilterable-float' (sampler 'non-filtering' + texture 'unfilterable-float')
  // лениво создаётся в bindTexture при первом бинде rgba32float без feature
  // 'float32-filterable'. Layout пайплайна и bind-group обязаны совпадать по
  // sampleType — иначе setBindGroup-валидация падает.
  const pipelines = new Map<number, {
    wgsl: string
    attrs: readonly GpuAttrSlot[]
    hasTextures: boolean
    desc: GpuPipelineDesc
    variants: Map<TextureSampleVariant, GPURenderPipeline>
  }>()
  // Vertex buffers: keyed по Float32Array (обычно одна команда = один спек =
  // одна data). Если пользователь дропнул ссылку на data — GPUBuffer утечёт,
  // но за весь срок сессии рендерера. dispose() чистит всё. FR не применён:
  // привязка к lifetime команды спецификации, а не user-facing handle.
  const vertexBuffers = new Map<Float32Array, GPUBuffer>()
  const textureBindGroups = new Map<number, GPUBindGroup>()
  const targets = new Map<number, {
    view: GPUTextureView
    depthView: GPUTextureView | null
    depthTexture: GPUTexture | null
    color: readonly number[]
    /** Task 80 (readback): размер и текстура цели — copyTextureToBuffer. */
    width: number
    height: number
    textureId: number
  }>()
  let nextTextureId = 1
  let nextTargetId = 1
  let nextTextureViewId = 1_000_000 // отделяем namespace от textureId (1, 2, 3...)
  let width = 0
  let height = 0
  let depthTexture: GPUTexture | null = null
  let depthView: GPUTextureView | null = null
  let ubo: GPUBuffer | null = null
  let uboSize = 0
  let uboGroup: GPUBindGroup | null = null
  let encoder: GPUCommandEncoder | null = null
  let pass: GPURenderPassEncoder | null = null
  let currentPipeline: GPURenderPipeline | null = null
  let currentPipelineId = -1
  let currentTarget = 0
  let timerHandle: GpuTimerHandle | null = null
  // Создаём timer ЕСЛИ device имеет 'timestamp-query' feature.
  // createGpuGpuTimer возвращает {timer, handle} или null (если feature нет).
  // handle подключается к этому фасаду через timerHandle — onBeginPass /
  // onEndPass / onSubmit вызываются в bindTarget/endPass/submit. timer
  // отдаётся через gpu.timer getter — renderer.ts подключит к statsCollector.
  const timerBundle = createGpuGpuTimer(device)
  const gpuTimer: GpuTimer | null = timerBundle === null ? null : timerBundle.timer
  if (timerBundle !== null) {
    timerHandle = timerBundle.handle
  }

  function configure(w: number, h: number): void {
    gpuContext.configure({ device, format, alphaMode: 'opaque' })
    resize(w, h)
  }

  function resize(w: number, h: number): void {
    if (w === width && h === height && depthTexture !== null) return
    width = w
    height = h
    depthTexture?.destroy()
    depthTexture = device.createTexture({
      size: [w, h],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })
    depthView = depthTexture.createView()
  }

  /** Канонический id → нативная GPUTextureFormat (Task 110, реставрация). */
  function resolveGpuFormat(id: TextureFormatId): string {
    const info = GPU_FORMATS[id]
    if (info === undefined) {
      throw new TypeError(`WebGPU не поддерживает формат '${id}' (GL-only или вне каталога)`)
    }
    return info.gpu
  }

  function createTexture(
    w: number,
    h: number,
    textureFormat: TextureFormat = 'rgba8unorm',
    options?: { mipLevels?: number; maxAnisotropy?: number },
  ): number {
    const mipLevels = options?.mipLevels ?? 1
    // Task 67 HDR: 'rgba16float'/'rgba32float' — core-форматы WebGPU
    // (renderable, для rgba16float — и filterable). rgba32float НЕ
    // фильтруется линейно без feature 'float32-filterable' — sampler
    // деградирует до 'nearest' (валидно для любого формата), а bind-group
    // и пайплайн получают sampleType 'unfilterable-float' (Task 69) — иначе
    // bind-group validation error при первом сэмплинге.
    // Task 110 (реставрация): полный каталог форматов — TextureFormatId
    // разрешается через GPU_FORMATS (formats.ts); 'canvas' — формат канваса.
    const gpuFormat: GPUTextureFormat =
      textureFormat === 'canvas'
        ? format
        : (resolveGpuFormat(textureFormat) as GPUTextureFormat)
    const filterable =
      textureFormat !== 'rgba32float' || device.features.has('float32-filterable' as GPUFeatureName)
    const texture = device.createTexture({
      size: [w, h],
      format: gpuFormat,
      // Task 80 (readback): COPY_SRC — copyTextureToBuffer для readTargetPixels
      // (surface.read()); паритет с GL-фасадом (readPixels читает FBO всегда).
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
      // mipLevelCount: по умолчанию 1. При >1 создаёт mip-chain (imm storage).
      // Sampler с mipmapFilter='linear' выбирает mip по distance — аналог
      // LINEAR_MIPMAP_LINEAR в WebGL2.
      mipLevelCount: mipLevels,
    })
    // Anisotropic filtering — WebGPU GPUSamplerDescriptor.maxAnisotropy.
    // WebGPU поддерживает нативно (без feature-request, без requiredLimits).
    // Платформа сама клампит maxAnisotropy к своему нативному максимуму (обычно
    // 16 на desktop, может быть 1 на некоторых mobile GPU — эффект bilinear).
    // По умолчанию 1 = disabled. caps.has('anisotropic')=true всегда на WebGPU
    // (см. probeGPUCaps — Task 54: это часть базовой спецификации).
    // Применяется только при mipLevels>1 — на non-mip бесполезна.
    let appliedAniso = 1
    if (mipLevels > 1) {
      const requested = options?.maxAnisotropy ?? 16 // default 16 — nативный WebGPU max
      // WebGPU требует степень двойки для maxAnisotropy (1, 2, 4, 8, 16).
      // Clamp к [1, 16] (нативный WebGPU максимум по спецификации; платформа
      // дополнительно clamp'ит к своему реальному максимуму при createSampler).
      // Если платформа не поддерживает anisotropic — clamp к 1, эффект bilinear.
      const limit = 16 // nативный WebGPU max; device.limits.maxAnisotropy НЕ существует
      const clamped = Math.max(1, Math.min(requested, limit))
      appliedAniso = clamped
    }
    const sampler = device.createSampler({
      magFilter: filterable ? 'linear' : 'nearest',
      minFilter: filterable ? 'linear' : 'nearest',
      // mipmapFilter='linear' если есть mip-chain. Иначе 'nearest' (по умолчанию
      // в WebGPU — sampling с mipmapFilter='nearest' игнорирует mip-chain,
      // всегда сэмплит level 0 — это и нужно для текстур без mips).
      mipmapFilter: mipLevels > 1 && filterable ? 'linear' : 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      // maxAnisotropy: применяется при mipmapFilter='linear'. WebGPU сам
      // валидирует: maxAnisotropy должен быть ∈ {1, 2, 4, 8, 16} и ≤
      // device.limits.maxAnisotropy. На mobile=1 — эффект нейтральный.
      ...(appliedAniso > 1 ? { maxAnisotropy: appliedAniso } : {}),
    })
    const id = nextTextureId++
    textures.set(id, { texture, sampler, view: texture.createView(), format: gpuFormat, filterable })
    return id
  }

  function texSubImage2D(textureId: number, x: number, y: number, w: number, h: number, bytes: Uint8Array): void {
    const record = textures.get(textureId)
    if (record === undefined) return
    // Task 67 HDR: bytesPerRow зависит от формата (rgba16float — 8 б/пиксель,
    // rgba32float — 16). Данные готовит вызывающий: длина bytes обязана быть
    // w*h*bytesPerPixel формата.
    const bytesPerPixel = record.format === 'rgba16float' ? 8 : record.format === 'rgba32float' ? 16 : 4
    device.queue.writeTexture(
      { texture: record.texture, origin: { x, y, z: 0 } },
      bytes as Uint8Array<ArrayBuffer>,
      { bytesPerRow: w * bytesPerPixel, rowsPerImage: h },
      { width: w, height: h, depthOrArrayLayers: 1 },
    )
  }

  function copyExternalImageToTexture(
    textureId: number,
    source: GPUImageSource,
    dstX: number,
    dstY: number,
    copyWidth: number,
    copyHeight: number,
    flipY?: boolean,
  ): void {
    const record = textures.get(textureId)
    if (record === undefined) return
    // WebGPU ExternalImageCopy — source: ImageBitmap | HTMLcanvasElement | HTMLVideoElement | VideoFrame | OffscreenCanvas
    // destination.origin = куда в текстуре писать (mip 0 по умолчанию).
    // copySize = размер копируемого региона. ДОЛЖЕН быть ≤ source.width/height,
    // иначе validation error "Copy rect is out of bounds of external image".
    //
    // flipY (default false) — если true, источник переворачивается по Y
    // ПЕРЕД копированием. WebGPU поддерживает нативно через
    // GPUCopyExternalImageSourceInfo.flipY. Это и есть паритет с WebGL2
    // UNPACK_FLIP_Y_WEBGL: flipY=true на обоих бэкендах даёт идентичный
    // результат — пиксели source row 0 попадают в texture row H-1.
    device.queue.copyExternalImageToTexture(
      { source: source as GPUCopyExternalImageSource, flipY: flipY === true },
      { texture: record.texture, mipLevel: 0, origin: { x: dstX, y: dstY, z: 0 } },
      { width: copyWidth, height: copyHeight, depthOrArrayLayers: 1 },
    )
  }

  function copyExternalImageToTextureMip(
    textureId: number,
    mipLevel: number,
    source: GPUImageSource,
    dstX: number,
    dstY: number,
    copyWidth: number,
    copyHeight: number,
    flipY?: boolean,
  ): void {
    const record = textures.get(textureId)
    if (record === undefined) return
    // WebGPU copyExternalImageToTexture с destination.mipLevel=level.
    // Source должен иметь размер N/(2^level). WebGPU сам проверит —
    // при несоответствии будет validation error (асинхронно в onGpuError).
    // flipY — см. copyExternalImageToTexture выше (GPUCopyExternalImageSourceInfo.flipY).
    device.queue.copyExternalImageToTexture(
      { source: source as GPUCopyExternalImageSource, flipY: flipY === true },
      { texture: record.texture, mipLevel, origin: { x: dstX, y: dstY, z: 0 } },
      { width: copyWidth, height: copyHeight, depthOrArrayLayers: 1 },
    )
  }

  function uploadUniforms(offset: number, data: Uint8Array): void {
    ensureUBO(offset + data.length)
    try {
      device.queue.writeBuffer(ubo!, offset, data as Uint8Array<ArrayBuffer>)
    } catch (error) {
      // Task 75: синхронные ошибки валидации writeBuffer (например, размер
      // больше буфера) НЕ должны ронять демо «Uncaught OperationError» —
      // уходят в канал onGpuError, кадр деградирует, но живёт.
      onGpuError?.(`writeBuffer(uniforms, ${data.length} байт @${offset}) отклонён: ${errorMessage(error)}`)
    }
  }

  function ensureUBO(needed: number): void {
    const rounded = Math.ceil(needed / 256) * 256
    if (ubo !== null && rounded <= uboSize) return
    const size = Math.max(65536, rounded)
    const next = device.createBuffer({ size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    const layout = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform', hasDynamicOffset: true },
      }],
    })
    uboGroup = device.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: { buffer: next, size: 256 } }],
    })
    if (ubo !== null) ubo.destroy()
    ubo = next
    uboSize = size
    currentPipeline = null // перезапайплайнить layout-зависимые кэши
    pipelines.clear()
  }

  function ensurePipeline(pipelineId: number, wgsl: string, attrs: readonly GpuAttrSlot[], hasTextures: boolean, desc?: GpuPipelineDesc): void {
    if (pipelines.has(pipelineId)) return
    const record = { wgsl, attrs, hasTextures, desc: desc ?? {}, variants: new Map<TextureSampleVariant, GPURenderPipeline>() }
    pipelines.set(pipelineId, record)
    // Дефолтный вариант 'float' — фильтруемые текстуры (все, кроме rgba32float
    // на устройствах без 'float32-filterable').
    record.variants.set('float', buildPipeline(record, 'float'))
  }

  /** Task 69: собрать пайплайн под конкретный sampleType текстурного биндинга.
   *  'float' → sampler 'filtering' + texture 'float' (LINEAR-фильтрация);
   *  'unfilterable-float' → sampler 'non-filtering' + texture
   *  'unfilterable-float' (NEAREST; единственный легальный способ сэмплинга
   *  rgba32float без feature 'float32-filterable'). WGSL обязан использовать
   *  textureSampleLevel (textureSample требует filterable-текстуру). */
  function buildPipeline(
    record: { wgsl: string; attrs: readonly GpuAttrSlot[]; hasTextures: boolean; desc: GpuPipelineDesc },
    variant: TextureSampleVariant,
  ): GPURenderPipeline {
    const wgsl = record.wgsl
    const attrs = record.attrs
    const desc = record.desc
    const module = device.createShaderModule({ code: wgsl })
    // getCompilationInfo — best-effort диагностика: на SwiftShader/падении
    // GPU-процесса промис может reject'нуться («Instance dropped error») —
    // это НЕ ошибка движка, глотаем чтобы не получить unhandled rejection.
    void module.getCompilationInfo().then(info => {
      for (const message of info.messages) {
        if (message.type === 'error') onGpuError?.(`WGSL: ${message.message} (строка ${message.lineNum})`)
      }
    }).catch(() => {})
    const group0 = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform', hasDynamicOffset: true },
      }],
    })
    const layouts: GPUBindGroupLayout[] = [group0]
    if (record.hasTextures) {
      layouts.push(device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: variant === 'float' ? 'filtering' : 'non-filtering' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: variant } },
        ],
      }))
      // Проактивная диагностика (Task 69): textureSample в WGSL несовместим с
      // вариантом 'unfilterable-float' — пайплайн не соберётся. Говорим честно,
      // как чинить (textureSampleLevel валиден для ОБЕИХ вариантов).
      if (variant === 'unfilterable-float' && /\btextureSample\s*\(/.test(wgsl)) {
        onGpuError?.('rgba32float без feature float32-filterable: WGSL вызывает textureSample — он требует filterable-текстуру (sampleType float). Для unfilterable-float допустим textureSampleLevel(t, s, uv, level) — он валиден и для фильтруемых текстур (level 0 = базовый мип).')
      }
    }
    return device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: layouts }),
      vertex: {
        module,
        entryPoint: 'vsMain',
        // M5 (Task 73): tight-числа — своя раскладка (size*4); интерливинг
        // фида — объект {size, stride, offset}: arrayStride=запись,
        // attribute offset=поле. Несколько полей одного фида — несколько
        // слотов, указывающих на общий буфер (биндинг — bindVertexBuffer).
        // Task 75: slot.step='instance' → stepMode 'instance' — запись фида
        // читается один раз на ИНСТАНС (квады-звёзды: углы разворачиваются
        // из @builtin(vertex_index) в шейдере, count=6, instances=feed.count).
        buffers: attrs.map((slot, i) =>
          typeof slot === 'number'
            ? { arrayStride: slot * 4, attributes: [{ shaderLocation: i, offset: 0, format: vertexFormat(slot) }] }
            : {
                arrayStride: slot.stride ?? slot.size * 4,
                attributes: [{ shaderLocation: i, offset: slot.offset ?? 0, format: vertexFormat(slot.size) }],
                stepMode: slot.step === 'instance' ? 'instance' : 'vertex',
              },
        ),
      },
      fragment: {
        module,
        entryPoint: 'fsMain',
        // Task 75: blend из GpuPipelineDesc (премультиплицированный вывод
        // шейдера: аддитив = one/one, альфа = one/one-minus-src-alpha).
        // Словарь BlendFactor фасада совпадает с GPUBlendFactor один-в-один.
        targets: [{
          format,
          blend: desc.blend === undefined || desc.blend === false ? undefined : {
            color: { srcFactor: desc.blend.src as GPUBlendFactor, dstFactor: desc.blend.dst as GPUBlendFactor, operation: 'add' },
            alpha: { srcFactor: desc.blend.src as GPUBlendFactor, dstFactor: desc.blend.dst as GPUBlendFactor, operation: 'add' },
          },
        }],
      },
      // Task 75: depth из дескриптора. Канвас-пасс ВСЕГДА несёт depth24plus-
      // attachment → пайплайн обязан объявлять совместимый depthStencil; для
      // «выключенной» глубины это write:false + compare:'always' (сохраняем
      // формат, чтобы не плодить вторую ветку пассов без глубины).
      primitive: {
        topology: desc.primitive === 'triangle-strip' ? 'triangle-strip' : 'triangle-list',
        cullMode: desc.raster?.cull === 'back' || desc.raster?.cull === 'front' ? desc.raster.cull : 'none',
        frontFace: desc.raster?.frontFace === 'cw' ? 'cw' : 'ccw',
      },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: desc.depth === false ? false : (desc.depth?.write ?? true),
        depthCompare: desc.depth === false ? 'always' : depthCompareOf(desc.depth?.test),
      },
    })
  }

  /** DepthFunc фасада → GPUCompareFunction. */
  function depthCompareOf(test: string | undefined): GPUCompareFunction {
    switch (test) {
      case 'never': return 'never'
      case 'equal': return 'equal'
      case 'lequal': return 'less-equal'
      case 'greater': return 'greater'
      case 'notequal': return 'not-equal'
      case 'gequal': return 'greater-equal'
      case 'always': return 'always'
      default: return 'less'
    }
  }

  function vertexFormat(size: number): GPUVertexFormat {
    if (size >= 4) return 'float32x4'
    if (size === 3) return 'float32x3'
    if (size === 2) return 'float32x2'
    return 'float32'
  }

  function usePipeline(pipelineId: number): void {
    const record = pipelines.get(pipelineId)
    if (record === undefined) return
    currentPipelineId = pipelineId
    // Дефолтный вариант 'float'; bindTexture переключит на
    // 'unfilterable-float', если биндится rgba32float без feature.
    setPipelineVariant(record, 'float')
  }

  /** Установить вариант пайплайна (лениво создаётся при первом обращении). */
  function setPipelineVariant(
    record: { wgsl: string; attrs: readonly GpuAttrSlot[]; hasTextures: boolean; desc: GpuPipelineDesc; variants: Map<TextureSampleVariant, GPURenderPipeline> },
    variant: TextureSampleVariant,
  ): void {
    let pipeline = record.variants.get(variant)
    if (pipeline === undefined) {
      pipeline = buildPipeline(record, variant)
      record.variants.set(variant, pipeline)
    }
    if (pipeline === currentPipeline) return
    currentPipeline = pipeline
    pass?.setPipeline(pipeline)
  }

  function bindUniforms(dynamicOffset: number): void {
    pass?.setBindGroup(0, uboGroup!, [dynamicOffset])
  }

  function bindVertexBuffer(slot: number, data: Float32Array, _size: number): void {
    let buffer = vertexBuffers.get(data)
    if (buffer === undefined) {
      buffer = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
      guardedWriteVertex(buffer, data, data.byteLength)
      vertexBuffers.set(data, buffer)
    }
    pass?.setVertexBuffer(slot, buffer)
  }

  /** M5 (Task 73): динамический вершинный буфер фида — writeBuffer одним
   *  вызовом на кадр с грязным диапазоном [0, byteLength). Ключ — стабильная
   *  Float32Array рендерера фида (SAB-view / зеркало T3). Биндинг — позже,
   *  через bindVertexBuffer (тот же keyed-кэш, без повторной записи). */
  function syncVertexBuffer(data: Float32Array, byteLength: number): void {
    let buffer = vertexBuffers.get(data)
    if (buffer === undefined) {
      buffer = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
      vertexBuffers.set(data, buffer)
    }
    if (byteLength <= 0) return
    guardedWriteVertex(buffer, data, byteLength)
  }

  /** Task 75: защищённая запись вершинного буфера. Три рубежа:
   *  (1) clamp byteLength до размера GPU-буфера (data.byteLength может
   *      расти/расходиться с ключом кэша при стрессе);
   *  (2) копия SAB-view в обычный ArrayBuffer (WebGPU запрещает shared
   *      memory в writeBuffer — фиды T1/T2);
   *  (3) try/catch вокруг writeBuffer — синхронная ошибка валидации
   *      («Number of bytes to write is too large», некратность 4 и пр.)
   *      уходит в onGpuError, кадр ПРОДОЛЖАЕТСЯ, демо не падает.
   *  ⚠️ Формы вызова: TypedArray → dataOffset/size в ЭЛЕМЕНТАХ; ArrayBuffer →
   *  в БАЙТАХ (спека GPUQueue.writeBuffer). */
  function guardedWriteVertex(buffer: GPUBuffer, data: Float32Array, byteLength: number): void {
    // (1) clamp: записываем не больше размера GPU-буфера.
    const capped = Math.min(byteLength, buffer.size)
    if (capped !== byteLength) {
      onGpuError?.(`writeBuffer(vertex) clamp: ${byteLength} → ${capped} байт (размер буфера ${buffer.size})`)
    }
    if (capped <= 0) return
    try {
      const isSabView = typeof SharedArrayBuffer !== 'undefined' && data.buffer instanceof SharedArrayBuffer
      if (isSabView) {
        // capped — часть диапазона записи (кратно 4); копия в обычный буфер.
        const copy = new Uint8Array(new ArrayBuffer(capped))
        copy.set(new Uint8Array(data.buffer, data.byteOffset, capped))
        device.queue.writeBuffer(buffer, 0, copy)
        return
      }
      if (data.byteOffset === 0 && capped === data.byteLength) {
        device.queue.writeBuffer(buffer, 0, data as Float32Array<ArrayBuffer>)
        return
      }
      // ArrayBuffer-форма: смещение и размер — в БАЙТАХ.
      device.queue.writeBuffer(buffer, 0, data.buffer as ArrayBuffer, data.byteOffset, capped)
    } catch (error) {
      onGpuError?.(`writeBuffer(vertex, ${capped} байт) отклонён: ${errorMessage(error)}`)
    }
  }

  function bindTexture(textureOrViewId: number): void {
    // textureOrViewId: либо textureId (1..1M) → default view, либо viewId
    // (1M+) → sub-mip-range view из textureViews Map.
    // Если id ∈ textureViews → берём sub-view (созданный через
    // createTextureView). Иначе — default-view из textures Map.
    // BindGroup инвалидируется и пересоздаётся при смене id.
    //
    // Task 69: sampleType bind-group-Layout выводится из ФИЛЬТРУЕМОСТИ
    // текстуры: rgba32float без feature 'float32-filterable' →
    // 'unfilterable-float' + sampler 'non-filtering' (сэмплер у такой
    // текстуры уже nearest). Захардкоженный 'float' давал валидационную
    // ошибку CreateBindGroup: «None of the supported sample types
    // (UnfilterableFloat) of [Texture rgba32float] match the expected
    // sample types (Float)». Layout пайплайна синхронно переключается на
    // соответствующий вариант (setPipelineVariant) — иначе несовместимость
    // пайплайн/bind-group всплыла бы на draw.
    let view: GPUTextureView
    let sampler: GPUSampler
    let filterable: boolean
    const subView = textureViews.get(textureOrViewId)
    if (subView !== undefined) {
      const record = textures.get(subView.textureId)
      if (record === undefined) return
      view = subView.view
      sampler = record.sampler
      filterable = record.filterable
    } else {
      const record = textures.get(textureOrViewId)
      if (record === undefined) return
      view = record.view
      sampler = record.sampler
      filterable = record.filterable
    }
    const pipelineRecord = currentPipelineId >= 0 ? pipelines.get(currentPipelineId) : undefined
    if (pipelineRecord !== undefined && pipelineRecord.hasTextures) {
      setPipelineVariant(pipelineRecord, filterable ? 'float' : 'unfilterable-float')
    }
    let group = textureBindGroups.get(textureOrViewId)
    if (group === undefined) {
      const layout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: filterable ? 'filtering' : 'non-filtering' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: filterable ? 'float' : 'unfilterable-float' } },
        ],
      })
      group = device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: sampler },
          { binding: 1, resource: view },
        ],
      })
      textureBindGroups.set(textureOrViewId, group)
    }
    pass?.setBindGroup(1, group)
  }

  function beginPass(_clearIndex: number): void {
    // Канвас-пасс = bindTarget(0, clear): единый путь переключения целей
    bindTarget(0, true)
  }

  function createTarget(
    textureId: number,
    targetWidth: number,
    targetHeight: number,
    depth: boolean,
    color: readonly [number, number, number, number],
  ): number {
    const record = textures.get(textureId)
    if (record === undefined) throw new Error(`rune: createTarget — текстура ${textureId} не найдена`)
    let targetDepthView: GPUTextureView | null = null
    let targetDepthTexture: GPUTexture | null = null
    if (depth) {
      targetDepthTexture = device.createTexture({
        size: [targetWidth, targetHeight],
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      })
      targetDepthView = targetDepthTexture.createView()
    }
    const id = nextTargetId++
    targets.set(id, { view: record.view, depthView: targetDepthView, depthTexture: targetDepthTexture, color, width: targetWidth, height: targetHeight, textureId })
    return id
  }

  function bindTarget(targetId: number, clear: boolean): void {
    if (targetId === currentTarget && pass !== null && !clear) return
    if (pass !== null) {
      // END-stamp ПЕРЕД pass.end(): writeTimestamp(querySet, END_INDEX)
      if (timerHandle !== null) timerHandle.onEndPass(pass)
      pass.end()
      pass = null
    }
    currentTarget = targetId
    encoder ??= device.createCommandEncoder()
    const loadOp: GPULoadOp = clear ? 'clear' : 'load'
    let colorView: GPUTextureView
    let depthAttachment: GPURenderPassDepthStencilAttachment | undefined
    let clearValue: GPUColor
    if (targetId === 0) {
      colorView = gpuContext.getCurrentTexture().createView()
      clearValue = { r: 0.07, g: 0.08, b: 0.11, a: 1 }
      depthAttachment = depthView !== null ? {
        view: depthView,
        depthClearValue: 1,
        depthLoadOp: loadOp,
        depthStoreOp: 'store',
      } : undefined
    } else {
      const target = targets.get(targetId)
      if (target === undefined) return
      colorView = target.view
      clearValue = { r: target.color[0], g: target.color[1], b: target.color[2], a: target.color[3] }
      depthAttachment = target.depthView !== null ? {
        view: target.depthView,
        depthClearValue: 1,
        depthLoadOp: loadOp,
        depthStoreOp: 'store',
      } : undefined
    }
    pass = encoder.beginRenderPass({
      colorAttachments: [{ view: colorView, clearValue, loadOp, storeOp: 'store' }],
      depthStencilAttachment: depthAttachment,
    })
    // BEGIN-stamp ПОСЛЕ beginRenderPass: writeTimestamp(querySet, BEGIN_INDEX)
    if (timerHandle !== null) timerHandle.onBeginPass(pass)
    // Новый пасс — пайплайн и его вариант выставляются заново (usePipeline);
    // сброс id исключает свап варианта по устаревшему пайплайну в bindTexture.
    currentPipelineId = -1
    currentPipeline = null
  }

  function draw(count: number, instances: number): void {
    pass?.draw(count, instances)
  }

  function endPass(): void {
    if (pass !== null && timerHandle !== null) timerHandle.onEndPass(pass)
    pass?.end()
    pass = null
  }

  function submit(): void {
    if (encoder === null) return
    // onSubmit ПЕРЕД encoder.finish(): resolveQuerySet(BEGIN..END →
    // resolveBuffer) + copyBuffer(resolveBuffer → readBuffer для mapAsync).
    if (timerHandle !== null) timerHandle.onSubmit(encoder)
    device.queue.submit([encoder.finish()])
    encoder = null
  }

  // ─── Task 80: readback (copyTextureToBuffer + mapAsync) ──────────────
  // Контракт: RGBA8, строки СВЕРХУ ВНИЗ (texture row 0 = верх), tight-раскладка
  // (без 256-байтового выравнивания bytesPerRow), каналы RGBA — BGRA-канвасные
  // форматы свиззлируются. Полный паритет с GL-фасадом (readPixels + flip):
  // data[0..3] — верхний-левый пиксель на ОБОИХ бэкендах.

  function readTargetPixels(targetId: number): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      if (targetId === 0) {
        reject(new Error('rune: readTargetPixels(0) — канвас не читается (presented-текстура живёт один кадр). Читайте ПОВЕРХНОСТЬ: renderer.surface(...) → capture/проходы → surface.read()'))
        return
      }
      const target = targets.get(targetId)
      if (target === undefined) {
        reject(new Error(`rune: readTargetPixels — цель ${targetId} не найдена (удалена или не создана)`))
        return
      }
      const record = textures.get(target.textureId)
      if (record === undefined) {
        reject(new Error(`rune: readTargetPixels — текстура ${target.textureId} цели ${targetId} не найдена`))
        return
      }
      try {
        const w = target.width
        const h = target.height
        // Открытый пасс на этой цели нельзя читать — закрываем; копия
        // дописывается в ТЕ ЖЕ командный буфер (порядок сохранён), затем submit.
        if (pass !== null) {
          if (timerHandle !== null) timerHandle.onEndPass(pass)
          pass.end()
          pass = null
        }
        encoder ??= device.createCommandEncoder()
        const rowBytes = w * 4
        const bytesPerRow = Math.ceil(rowBytes / 256) * 256 // WebGPU-выравнивание
        const buffer = device.createBuffer({
          size: bytesPerRow * h,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        })
        encoder.copyTextureToBuffer(
          { texture: record.texture },
          { buffer, bytesPerRow, rowsPerImage: h },
          [w, h, 1],
        )
        // Свиззл BGRA→RGBA нужен для канвасных форматов (bgra8unorm на большинстве платформ).
        const swizzle = record.format === 'bgra8unorm' || record.format === 'bgra8unorm-srgb'
        submit()
        void buffer.mapAsync(GPUMapMode.READ).then(
          () => {
            try {
              const mapped = new Uint8Array(buffer.getMappedRange())
              const out = new Uint8Array(rowBytes * h)
              for (let y = 0; y < h; y++) {
                const src = y * bytesPerRow
                const dst = y * rowBytes
                if (swizzle) {
                  for (let x = 0; x < rowBytes; x += 4) {
                    out[dst + x] = mapped[src + x + 2]! // B → R
                    out[dst + x + 1] = mapped[src + x + 1]! // G
                    out[dst + x + 2] = mapped[src + x]! // R → B
                    out[dst + x + 3] = mapped[src + x + 3]! // A
                  }
                } else {
                  out.set(mapped.subarray(src, src + rowBytes), dst)
                }
              }
              buffer.unmap()
              buffer.destroy()
              resolve(out)
            } catch (e) {
              try { buffer.destroy() } catch { /* уже мёртв */ }
              reject(e instanceof Error ? e : new Error(String(e)))
            }
          },
          (e: unknown) => {
            // mapAsync отвергнут: device lost / уничтожен буфер — честный reject.
            try { buffer.destroy() } catch { /* уже мёртв */ }
            reject(e instanceof Error ? e : new Error(`readTargetPixels: mapAsync отвергнут (${String(e)})`))
          },
        )
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  // ─── Disposal: явное освобождение GPU-ресурса ────────────────────────
  // Идемпотентность: повторный delete того же id — no-op (записи уже нет в Map).

  function deleteTexture(textureId: number): void {
    const record = textures.get(textureId)
    if (record === undefined) return
    // Инвалидация bindGroup: при след. bindTexture он будет пересоздан
    // (textureBindGroups.get(textureId) на старом record.view больше не валиден).
    textureBindGroups.delete(textureId)
    // Удалить все sub-views этой текстуры (созданные через createTextureView)
    for (const [viewId, sv] of textureViews) {
      if (sv.textureId === textureId) {
        textureBindGroups.delete(viewId)
        textureViews.delete(viewId)
      }
    }
    record.texture.destroy()
    record.sampler // GPUSampler не имеет destroy() — GC сам уберёт
    textures.delete(textureId)
  }

  function createTextureView(
    textureId: number,
    options?: { baseMipLevel?: number; mipLevelCount?: number; baseArrayLayer?: number; arrayLayerCount?: number },
  ): number {
    const record = textures.get(textureId)
    if (record === undefined) {
      // Текстура не найдена — WebGPU сам бы бросил, мы молча вернём 0.
      // Caller должен проверить через textureId ∈ textures, но мы не
      // экспонируем Map. Лучше бросать внятную ошибку.
      throw new Error(`rune: createTextureView — текстура ${textureId} не найдена`)
    }
    const view = record.texture.createView({
      baseMipLevel: options?.baseMipLevel ?? 0,
      mipLevelCount: options?.mipLevelCount,
      baseArrayLayer: options?.baseArrayLayer,
      arrayLayerCount: options?.arrayLayerCount,
      dimension: '2d',
      aspect: 'all',
    })
    const viewId = nextTextureViewId++
    textureViews.set(viewId, { textureId, view })
    return viewId
  }

  function deleteTextureView(viewId: number): void {
    const sv = textureViews.get(viewId)
    if (sv === undefined) return
    // GPUTextureView не имеет destroy() — освобождается при destroy()
    // родительской текстуры (device.destroy() неявно). Но мы убираем
    // из Map чтобы bindTexture больше не находил этот view.
    textureBindGroups.delete(viewId)
    textureViews.delete(viewId)
  }

  function deleteTarget(targetId: number): void {
    const target = targets.get(targetId)
    if (target === undefined) return
    target.depthTexture?.destroy()
    targets.delete(targetId)
  }

  let facadeDisposed = false

  function installTimer(handle: GpuTimerHandle | null): GpuTimerHandle | null {
    const prev = timerHandle
    timerHandle = handle
    return prev
  }

  function dispose(): void {
    if (facadeDisposed) return
    facadeDisposed = true
    // 0. Снять timer hooks — writeTimestamp после dispose всё равно бессмыслен
    timerHandle = null
    // 1. Уничтожить все текстуры фасада (color + sampler не нуждается в destroy)
    for (const record of textures.values()) {
      record.texture.destroy()
    }
    textures.clear()
    textureBindGroups.clear()
    // 1b. Sub-views очищаем — GPUTextureView освобождается через
    // device.destroy() неявно, как и родительские текстуры.
    textureViews.clear()
    // 2. Уничтожить depth-текстуры canvas-аттачмента и target-ов
    depthTexture?.destroy()
    depthTexture = null
    depthView = null
    for (const target of targets.values()) {
      target.depthTexture?.destroy()
    }
    targets.clear()
    // 3. UBO — GPUBuffer.destroy
    ubo?.destroy()
    ubo = null
    uboSize = 0
    uboGroup = null
    // 4. Vertex buffers — keyed по Float32Array
    for (const buf of vertexBuffers.values()) {
      buf.destroy()
    }
    vertexBuffers.clear()
    // 5. Pipelines: GPURenderPipeline не имеет destroy() — device.destroy()
    //    освободит их неявно. Чистим Map чтобы не тащить ссылки.
    pipelines.clear()
    // 6. Активный pass/encoder — обнуляем (device.destroy() сделает submit
    //    бросающим, но мы не дойдём — никто не вызовет submit после dispose).
    encoder = null
    pass = null
    currentPipeline = null
    currentTarget = 0
    // 7. Финал: device.destroy() — детерминированно освобождает ВСЮ GPU-память
    //    устройства (текстуры/буферы/пайплайны/семплеры/texture-views), даже
    //    не уничтоженную явно. Браузер после этого закроет canvas-контекст.
    //    Это и есть паритет с WebGL2 loseContext + явное освобождение.
    //    QuerySet, resolveBuffer, readBuffer от GpuTimer — тоже освободятся
    //    device.destroy() (они созданы через этот device).
    device.destroy()
  }

  return {
    configure,
    resize,
    createTexture,
    texSubImage2D,
    copyExternalImageToTexture,
    copyExternalImageToTextureMip,
    uploadUniforms,
    ensurePipeline,
    usePipeline,
    bindUniforms,
    bindVertexBuffer,
    syncVertexBuffer,
    bindTexture,
    beginPass,
    draw,
    endPass,
    submit,
    readTargetPixels,
    createTarget,
    bindTarget,
    deleteTexture,
    deleteTarget,
    createTextureView,
    deleteTextureView,
    dispose,
    installTimer,
    get adapter() { return adapter },
    get device() { return device },
    get preferredFormat() { return format },
    get timer() { return gpuTimer },
  }
}

/** Сообщение ошибки одной строкой (для канала onGpuError). */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
