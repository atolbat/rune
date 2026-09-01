// Рекордер-фасад GPU: порядок вызовов кадра строками (защита tape-путей).

import type { GPUFacade, GPUImageSource } from './facade.ts'

export interface RecordingGPU {
  readonly gpu: GPUFacade
  readonly calls: string[]
}

export function createRecordingGPU(): RecordingGPU {
  const calls: string[] = []
  let nextTextureId = 1
  let nextTargetId = 1
  let nextTextureViewId = 1_000_000
  let currentTarget = 0
  let passOpen = false

  const gpu: GPUFacade = {
    configure: (width, height) => calls.push(`configure(${width},${height})`),
    resize: (width, height) => calls.push(`resize(${width},${height})`),
    createTexture: (width, height, format, options) => {
      const mipLevels = options?.mipLevels ?? 1
      const aniso = options?.maxAnisotropy
      // Task 67: HDR-форматы пишем в запись; rgba8unorm — дефолт, опускаем.
      const fmtSuffix = format !== undefined && format !== 'rgba8unorm' ? `,${format}` : ''
      const parts: string[] = []
      if (mipLevels > 1) parts.push(`mipLevels=${mipLevels}`)
      if (aniso !== undefined) parts.push(`aniso=${aniso}`)
      const optSuffix = parts.length > 0 ? `,${parts.join(',')}` : ''
      calls.push(`createTexture(${width},${height}${fmtSuffix}${optSuffix})`)
      return nextTextureId++
    },
    texSubImage2D: (textureId, x, y, width, height) =>
      calls.push(`texSubImage2D(${textureId},${x},${y},${width},${height})`),
    copyExternalImageToTexture: (textureId, source, dstX, dstY, w, h, flipY) => {
      const kind = describeGpuSource(source)
      const flipSuffix = flipY === true ? ',flipY' : ''
      calls.push(`copyExternalImageToTexture(${textureId},${kind},@${dstX},${dstY},${w}x${h}${flipSuffix})`)
    },
    copyExternalImageToTextureMip: (textureId, mipLevel, source, dstX, dstY, w, h, flipY) => {
      const kind = describeGpuSource(source)
      const flipSuffix = flipY === true ? ',flipY' : ''
      calls.push(`copyExternalImageToTextureMip(${textureId},mip=${mipLevel},${kind},@${dstX},${dstY},${w}x${h}${flipSuffix})`)
    },
    uploadUniforms: (offset, data) => calls.push(`uploadUniforms(${offset},${data.byteLength})`),
    ensurePipeline: (pipelineId, _wgsl, attrs, hasTextures, pipeline) => {
      // M5: числа — tight (3x3x2); интерливинг фида — size/stride@offset.
      // Task 75: instance-step суффикс + blend/depth маркеры дескриптора.
      const desc = attrs.map(a => {
        if (typeof a === 'number') return `${a}`
        const inst = a.step === 'instance' ? '!i' : ''
        return `${a.size}${inst}/${a.stride ?? a.size * 4}@${a.offset ?? 0}`
      }).join('x')
      const state: string[] = []
      if (pipeline?.blend !== undefined && pipeline.blend !== false) state.push(`blend=${pipeline.blend.src}/${pipeline.blend.dst}`)
      if (pipeline?.depth === false) state.push('depth=off')
      calls.push(`ensurePipeline(${pipelineId}, [${desc}]${hasTextures ? ', tex' : ''}${state.length > 0 ? `, ${state.join(' ')}` : ''})`)
    },
    usePipeline: pipelineId => calls.push(`usePipeline(${pipelineId})`),
    bindUniforms: offset => calls.push(`bindUniforms(${offset})`),
    bindVertexBuffer: (slot, data, size) => calls.push(`bindVertexBuffer(${slot},${data.length},${size})`),
    syncVertexBuffer: (data, byteLength) => calls.push(`syncVertexBuffer(${data.length},${byteLength})`),
    bindTexture: textureId => calls.push(`bindTexture(${textureId})`),
    beginPass: clearIndex => {
      currentTarget = 0
      passOpen = true
      calls.push(`beginPass(${clearIndex})`)
    },
    draw: (count, instances) => calls.push(`draw(${count},${instances})`),
    endPass: () => {
      passOpen = false
      calls.push('endPass')
    },
    submit: () => calls.push('submit'),
    // Task 80: readback — записываем вызов; рекордер не имеет GPU — пустой
    // массив (паритет формы с realGPU-контрактом). Контракт targetId 0
    // (канвас не читается) зеркалим: честный reject как в realGPU.
    readTargetPixels: targetId => {
      if (targetId === 0) {
        return Promise.reject(new Error('rune: readTargetPixels(0) — канвас не читается (presented-текстура живёт один кадр). Читайте ПОВЕРХНОСТЬ: renderer.surface(...) → capture/проходы → surface.read()'))
      }
      calls.push(`readTargetPixels(${targetId})`)
      return Promise.resolve(new Uint8Array(0))
    },
    createTarget: (textureId, width, height, depth) => {
      calls.push(`createTarget(${textureId},${width},${height}${depth ? ',depth' : ''})`)
      return nextTargetId++
    },
    bindTarget: (targetId, clear) => {
      // Тот же skip-контракт, что и realGPU: цель та же, пасс открыт, без очистки
      if (targetId === currentTarget && passOpen && !clear) return
      currentTarget = targetId
      passOpen = true
      calls.push(`bindTarget(${targetId},${clear ? 1 : 0})`)
    },
    deleteTexture: textureId => calls.push(`deleteTexture(${textureId})`),
    deleteTarget: targetId => calls.push(`deleteTarget(${targetId})`),
    createTextureView: (textureId, options) => {
      const base = options?.baseMipLevel ?? 0
      const count = options?.mipLevelCount
      const optSuffix = (base !== 0 || count !== undefined)
        ? `,mip=${base}${count !== undefined ? `+${count}` : ''}`
        : ''
      calls.push(`createTextureView(${textureId}${optSuffix})`)
      // Возвращаем фейковый viewId из диапазона sub-views (≥1M)
      nextTextureViewId++
      return nextTextureViewId
    },
    deleteTextureView: viewId => calls.push(`deleteTextureView(${viewId})`),
    dispose: () => calls.push('dispose'),
    installTimer: handle => {
      const handleName = handle === null ? 'null' : 'handle'
      calls.push(`installTimer(${handleName})`)
      // recording не хранит handle — возвращаем null (предыдущего нет)
      return null
    },
    get adapter() { return null },
    get device() { return null },
    get preferredFormat() { return 'bgra8unorm' as GPUTextureFormat },
    get timer() { return null }, // recording-фасад: нет device, нет timer
  }

  return { gpu, calls }
}

/** Имя типа источника для записи в строку вызова. */
function describeGpuSource(source: GPUImageSource): string {
  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) return 'ImageBitmap'
  if (typeof OffscreenCanvas !== 'undefined' && source instanceof OffscreenCanvas) return 'OffscreenCanvas'
  if (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) return 'HTMLCanvasElement'
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) return 'HTMLVideoElement'
  // Duck-typing для headless-окружений без глобальных типов
  if (typeof source === 'object' && source !== null) {
    if ('getContext' in source) return 'OffscreenCanvas'
    if ('close' in source && 'width' in source) return 'ImageBitmap'
  }
  return (source as { constructor: { name: string } }).constructor?.name ?? 'unknown'
}

/** Счётный фасад GPU: нулевая работа, только инкременты — бенчмарки
 *  пути кадра (теория E) без стоимости записи строк. */
export function createCountingGPU(): GPUFacade & { totalCalls: number } {
  let totalCalls = 0
  const bump = (): void => { totalCalls++ }
  let nextId = 0
  const alloc = (): number => nextId++
  return {
    configure: bump,
    resize: bump,
    createTexture: alloc as never,
    copyExternalImageToTexture: bump,
    copyExternalImageToTextureMip: bump,
    uploadUniforms: bump,
    ensurePipeline: bump,
    usePipeline: bump,
    bindUniforms: bump,
    bindVertexBuffer: bump,
    syncVertexBuffer: bump,
    bindTexture: bump,
    beginPass: bump,
    draw: bump,
    endPass: bump,
    submit: bump,
    readTargetPixels: () => {
      bump()
      return Promise.resolve(new Uint8Array(0))
    },
    createTarget: alloc as never,
    bindTarget: bump,
    deleteTexture: bump,
    deleteTarget: bump,
    createTextureView: alloc as never,
    deleteTextureView: bump,
    dispose: bump,
    get timer() { return null as never },
    get adapter() { return null as never },
    get device() { return null as never },
    get preferredFormat() { return 'rgba8unorm' as const },
    get totalCalls() { return totalCalls },
  } as unknown as GPUFacade & { totalCalls: number }
}
