// Рекордер-фасад: те же операции, но строками — основа юнит-тестов
// порядка вызовов на tape-путях (уроки инцидентов 36/37).
// Плюс сырая state-поверхность (enableDepthTest/depthFunc/…) — её применяет
// state-программа (state/stateProgram.ts) в обоих режимах исполнения.

import type { GLFacade, GLImageSource } from './facade.ts'
import type { DepthFunc, CullFace, FrontFace, BlendFactor } from './gl/facade.ts'
import type { StateProgramGL } from './gl/shadow.ts'

export interface RecordingGL {
  /** GLFacade + сырая state-поверхность: рекордер реализует ОБЕ (см. комментарий
   *  шапки) — тип отражает это, чтобы state-программы принимались без кастов. */
  readonly gl: GLFacade & StateProgramGL
  readonly calls: string[]
}

export function createRecordingGL(): RecordingGL {
  const calls: string[] = []
  let nextProgram = 1
  let nextBuffer = 1
  let nextTexture = 1
  let nextTarget = 1
  let nextTextureView = 1_000_000 // disjoint namespace с textureId (<1M)
  let currentTarget = 0

  const gl: GLFacade & {
    enableDepthTest(): void
    disableDepthTest(): void
    depthMask(enabled: boolean): void
    depthFunc(fn: DepthFunc): void
    enableBlend(): void
    disableBlend(): void
    blendFunc(src: BlendFactor, dst: BlendFactor): void
    enableCull(): void
    disableCull(): void
    cullFace(face: CullFace): void
    frontFace(order: FrontFace): void
  } = {
    createProgram: (vertex, fragment) => {
      calls.push(`createProgram(vs:${vertex.length},fs:${fragment.length})`)
      return nextProgram++
    },
    useProgram: id => calls.push(`useProgram(${id})`),
    createBuffer: data => {
      calls.push(`createBuffer(${data.length})`)
      return nextBuffer++
    },
    updateBuffer: (bufferId, data, byteOffset = 0) =>
      calls.push(`updateBuffer(${bufferId},${data.length},${byteOffset})`),
    bindVertexBuffer: (bufferId, location, size, stride, byteOffset, divisor) => {
      // M5: интерливинг фида — суффикс stride@offset; tight — без него.
      // Task 75: инстанс-делитель — суффикс !i (только когда ≠ 0 — старые
      // записи вызовов в тестах не меняются).
      const interleave = stride !== undefined || byteOffset !== undefined
        ? `,${stride ?? 0}@${byteOffset ?? 0}`
        : ''
      const inst = divisor !== undefined && divisor > 0 ? ',!i' : ''
      calls.push(`bindVertexBuffer(${bufferId},${location},${size}${interleave}${inst})`)
    },
    setUniformMatrix4: (programId, name) => calls.push(`uniformMatrix4fv(${name})`),
    setUniform4fv: (programId, name) => calls.push(`uniform4fv(${name})`),
    setUniform3fv: (programId, name) => calls.push(`uniform3fv(${name})`),
    setUniform2fv: (programId, name) => calls.push(`uniform2fv(${name})`),
    setUniform1f: (programId, name, value) => calls.push(`uniform1f(${name},${roundValue(value)})`),
    setUniform1i: (programId, name, value) => calls.push(`uniform1i(${name},${value})`),
    createTexture: (width, height, options) => {
      const mipLevels = options?.mipLevels ?? 1
      const aniso = options?.maxAnisotropy
      const parts: string[] = []
      if (mipLevels > 1) parts.push(`mipLevels=${mipLevels}`)
      if (aniso !== undefined) parts.push(`aniso=${aniso}`)
      // Task 67: формат хранения в запись (rgba16f/rgba32f — HDR-текстуры).
      if (options?.format !== undefined && options.format !== 'rgba8') parts.push(options.format)
      if (parts.length > 0) {
        calls.push(`createTexture(${width},${height},${parts.join(',')})`)
      } else {
        calls.push(`createTexture(${width},${height})`)
      }
      return nextTexture++
    },
    texSubImage2D: (textureId, x, y, width, height) => calls.push(`texSubImage2D(${textureId},${x},${y},${width},${height})`),
    texImage2DFromSource: (textureId, source, options) => {
      const kind = describeSource(source)
      // flipY в запись: по умолчанию false (паритет с realGL.texImage2DFromSource
      // и WebGPU copyExternalImageToTexture — оба пишут source row 0 в texture
      // row 0). Тесты могут искать «,flipY=false» или «,flipY=true» явно.
      const flipY = options?.flipY ?? false
      calls.push(`texImage2DFromSource(${textureId},${kind},flipY=${flipY})`)
    },
    texSubImage2DFromSource: (textureId, x, y, source, options) => {
      const kind = describeSource(source)
      const flipY = options?.flipY ?? false
      calls.push(`texSubImage2DFromSource(${textureId},${x},${y},${kind},flipY=${flipY})`)
    },
    texImage2DLevel: (textureId, level, source, options) => {
      const kind = describeSource(source)
      const flipY = options?.flipY ?? false
      const fmtParts: string[] = []
      if (options?.internalFormat !== undefined) fmtParts.push(`ifmt=0x${options.internalFormat.toString(16)}`)
      if (options?.format !== undefined) fmtParts.push(`fmt=0x${options.format.toString(16)}`)
      if (options?.type !== undefined) fmtParts.push(`type=0x${options.type.toString(16)}`)
      const fmtSuffix = fmtParts.length > 0 ? `,${fmtParts.join(',')}` : ''
      calls.push(`texImage2DLevel(${textureId},level=${level},${kind},flipY=${flipY}${fmtSuffix})`)
    },
    bindTexture: (textureOrViewId, unit) => calls.push(`bindTexture(${textureOrViewId},${unit})`),
    createTextureView: (textureId, options) => {
      const base = options?.baseMipLevel ?? 0
      const count = options?.mipLevelCount
      // Формат записи: `createTextureView(texId,mip=base+count)` или
      // `createTextureView(texId)` если base=0 и count не передан (default view).
      // Word-boundary: используем `,mip=` чтобы не путать с другими суффиксами.
      const hasOpts = base !== 0 || count !== undefined
      const optSuffix = hasOpts ? `,mip=${base}${count !== undefined ? `+${count}` : ''}` : ''
      calls.push(`createTextureView(${textureId}${optSuffix})`)
      // Возвращаем фейковый viewId из диапазона sub-views (≥1M), как в realGL.
      return nextTextureView++
    },
    deleteTextureView: viewId => calls.push(`deleteTextureView(${viewId})`),
    setViewport: (width, height) => calls.push(`setViewport(${width},${height})`),
    setDepthMode: (test, write) => calls.push(`setDepthMode(${test},${write})`),
    setCull: mode => calls.push(`setCull(${mode})`),
    // Task 75: блендинг пайплайна (null/null = выкл).
    setBlend: (src, dst) => calls.push(`setBlend(${src ?? 'off'},${dst ?? 'off'})`),
    // Сырая state-поверхность (state-программы, M2-легаси + реальные сценарии).
    enableDepthTest: () => calls.push('enableDepthTest'),
    disableDepthTest: () => calls.push('disableDepthTest'),
    depthMask: on => calls.push(`depthMask(${on})`),
    depthFunc: fn => calls.push(`depthFunc(${fn})`),
    enableBlend: () => calls.push('enableBlend'),
    disableBlend: () => calls.push('disableBlend'),
    blendFunc: (src, dst) => calls.push(`blendFunc(${src},${dst})`),
    enableCull: () => calls.push('enableCull'),
    disableCull: () => calls.push('disableCull'),
    cullFace: face => calls.push(`cullFace(${face})`),
    frontFace: order => calls.push(`frontFace(${order})`),
    clear: (color, depth) => calls.push(`clear(${color.join(',')};${depth})`),
    drawArrays: (mode, first, count, instances) => calls.push(`drawArrays(${mode},${first},${count},${instances})`),
    createTarget: (textureId, width, height, depth) => {
      calls.push(`createTarget(${textureId},${width},${height}${depth ? ',depth' : ''})`)
      return nextTarget++
    },
    bindTarget: (targetId, clear) => {
      // Тот же skip-контракт, что и realGL: без дублирующих bindTarget
      if (targetId === currentTarget && !clear) return
      currentTarget = targetId
      calls.push(`bindTarget(${targetId},${clear ? 1 : 0})`)
    },
    deleteTexture: textureId => {
      currentTarget = 0
      calls.push(`deleteTexture(${textureId})`)
    },
    deleteTarget: targetId => {
      currentTarget = 0
      calls.push(`deleteTarget(${targetId})`)
    },
    // Task 80: readback — записываем вызов; рекордер без GPU отдаёт пустой
    // массив (форма контракта realGL: Uint8Array, строки сверху-вниз).
    // Контракт targetId 0 (канвас не читается) зеркалим: throw как в realGL.
    readTargetPixels: targetId => {
      if (targetId === 0) {
        throw new Error('rune: readTargetPixels(0) — канвас не читается (паритет с WebGPU: presented-текстура живёт один кадр). Читайте ПОВЕРХНОСТЬ: renderer.surface(...) → capture/проходы → surface.read()')
      }
      calls.push(`readTargetPixels(${targetId})`)
      return new Uint8Array(0)
    },
    deleteProgram: programId => calls.push(`deleteProgram(${programId})`),
    deleteBuffer: bufferId => calls.push(`deleteBuffer(${bufferId})`),
  }

  return { gl, calls }
}

/** Округление значения для строки вызова: значение прошло через f32-арену
 *  (fround), сырая печать даёт «0.800000011920929» — округляем до 3 знаков
 *  (тот же приём, что у легаси-рекордера gl/facade.ts). */
function roundValue(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** Имя типа источника для записи в строку вызова. */
function describeSource(source: GLImageSource): string {
  // 1. instanceof-проверки (если глобал доступен в окружении)
  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) return 'ImageBitmap'
  if (typeof OffscreenCanvas !== 'undefined' && source instanceof OffscreenCanvas) return 'OffscreenCanvas'
  if (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) return 'HTMLCanvasElement'
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) return 'HTMLVideoElement'
  // 2. Fallback: duck-typing через наличие характерных методов
  if (typeof source === 'object' && source !== null) {
    if ('getContext' in source) return 'OffscreenCanvas' // или HTMLCanvasElement, но в headless-тестах — Offscreen
    if ('close' in source && 'width' in source) return 'ImageBitmap' // ImageBitmap имеет close() и width/height
  }
  // 3. Последний fallback — constructor.name (для моков с .constructor)
  return (source as { constructor: { name: string } }).constructor?.name ?? 'unknown'
}
