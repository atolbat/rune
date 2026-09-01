/**
 * withJournalGpu — декоратор GPUFacade: пишет create/destroy-опсы в Journal.
 *
 * Контракт §9.5 P3 (тот же, что и для WebGL2): журнал делает switchBackend =
 * device-loss recovery = worker migration одним механизмом replay.
 *
 * Это WebGPU-близнец journalGl.ts. Принципы те же:
 *   • Долгоживущие create/destroy-опсы журналируются автоматически.
 *   • Frame-опсы (usePipeline, bindUniforms, bindVertexBuffer, bindTexture,
 *     beginPass, draw, endPass, submit, bindTarget, uploadUniforms,
 *     texSubImage2D, copyExternalImageToTextureMip) — НЕ журналируются
 *     (это per-frame, идут в Tape, не в Journal).
 *   • Источник copyExternalImageToTexture не сериализуется (ImageBitmap может
 *     быть закрыт, HTMLVideoElement — DOM-зависим). Журнал хранит только
 *     kind+flipY; при replay пользователь предоставляет источник через
 *     sourceFor(kind).
 *
 * Чем WebGPU-журнал ОТЛИЧАЕТСЯ от WebGL2-журнала:
 *   1. createTexture — у GPUFacade есть параметр format ('rgba8unorm' | 'canvas').
 *      Журнал хранит format в DeclOp (см. journal.ts — Task 57). При replay
 *      на новом WebGPU-фасаде format передаётся как есть. При cross-backend
 *      replay (WebGPU → WebGL2) format молча игнорируется (WebGL2 всегда RGBA8).
 *   2. createProgram/createBuffer — у GPUFacade их НЕТ. Пайплайны ( WGSL
 *      шейдеры) — ленивые: создаются при первом draw через ensurePipeline.
 *      WGSL-источник хранится в WgpuCommand (compiled), поэтому для device-loss
 *      recovery достаточно replay-нуть только текстуры/цели/views — пайплайны
 *      пересоздадутся автоматически при первом draw на новом device.
 *   3. copyExternalImageToTexture — это WebGPU-аналог texImage2DFromSource
 *      (полная загрузка в mip 0). Записывается как { kind:'texImage2DFromSource',
 *      textureId, sourceKind, flipY }. sub-region (atlas packing) и
 *      mip-загрузка (copyExternalImageToTextureMip) — frame-опсы, не журналируются.
 *
 * Replay на новом фасаде: replayJournalOnGpu(journal, targetGpu, sourceFor?)
 *   — см. ниже. Все create-опсы выполняются в порядке записи; destroy-опсы
 *   no-op на новом фасаде (ресурсов ещё нет).
 */

import type { Journal, DeclOp, ClearColor } from '@rune/core'
import type { GPUFacade, GPUImageSource } from '@rune/webgpu'
import { externalImageSize } from '@rune/webgpu'

/** Декорирует GPUFacade так, что create/destroy-опсы пишутся в Journal. */
export function withJournalGpu(gpu: GPUFacade, journal: Journal): GPUFacade {
  // Task 61: размеры созданных текстур — для эвристики «полной загрузки».
  // copyExternalImageToTexture журналируется как texImage2DFromSource ТОЛЬКО
  // если копия покрывает ВСЮ текстуру (dstX=dstY=0 и copyWidth/copyHeight
  // совпадают с размерами из createTexture). Раньше проверялись только
  // dstX/dstY — sub-region копия в (0,0) (например, первый тайл атласа или
  // uploadSubImage в левый верхний угол) ошибочно журналировалась как
  // полная загрузка, и replay заливал бы текстуру обрезанным источником.
  const texSizes = new Map<number, { w: number; h: number }>()
  return {
    configure: (w, h) => gpu.configure(w, h),
    resize: (w, h) => gpu.resize(w, h),
    createTexture: (width, height, format, options) => {
      const id = gpu.createTexture(width, height, format, options)
      // Task 57: format сохранён в опсе — при replay на WebGPU передаётся как
      // есть. При cross-backend replay на WebGL2 — игнорируется (там всегда RGBA8).
      texSizes.set(id, { w: width, h: height })
      journal.record({ kind: 'createTexture', id, width, height, format, options })
      return id
    },
    texSubImage2D: (textureId, x, y, w, h, bytes) =>
      gpu.texSubImage2D(textureId, x, y, w, h, bytes),
    // copyExternalImageToTexture — атомарная полная загрузка в mip 0 (аналог
    // texImage2DFromSource в WebGL2). Журналируем как долгоживущую декларацию:
    // при replay на новом бэкенде через sourceFor(kind) пользователь
    // предоставляет источник и мы вызываем copyExternalImageToTexture(textureId,
    // source, 0, 0, sw, sh, flipY) — full-texture upload.
    copyExternalImageToTexture: (textureId, source, dstX, dstY, copyWidth, copyHeight, flipY) => {
      gpu.copyExternalImageToTexture(textureId, source, dstX, dstY, copyWidth, copyHeight, flipY)
      // Журналируем только ПОЛНУЮ загрузку текстуры: dstX=dstY=0 И копия
      // покрывает весь размер из createTexture (Task 61 — size-aware).
      // Sub-region upload (atlas packing) — frame-опс, идёт в Tape, не в Journal.
      const size = texSizes.get(textureId)
      const isFullTexture = size !== undefined
        && dstX === 0 && dstY === 0
        && copyWidth === size.w && copyHeight === size.h
      if (isFullTexture) {
        journal.record({
          kind: 'texImage2DFromSource',
          textureId,
          sourceKind: describeGpuSourceKind(source),
          flipY: flipY === true,
        })
      }
    },
    // Frame-опсы (progressive mip upload): copyExternalImageToTextureMip —
    // progressive mip streaming, frame-опс. Не журналируется (контракт §9.5 P3:
    // frame-опсы в Tape). Pass-through без journal.record().
    copyExternalImageToTextureMip: (textureId, mipLevel, source, dstX, dstY, copyWidth, copyHeight, flipY) =>
      gpu.copyExternalImageToTextureMip(textureId, mipLevel, source, dstX, dstY, copyWidth, copyHeight, flipY),
    // Frame-опсы: uploadUniforms — writeBuffer в UBO, per-frame.
    uploadUniforms: (offset, data) => gpu.uploadUniforms(offset, data),
    // ensurePipeline — ленивая компиляция WGSL → GPURenderPipeline. Не журн-
    // алируется: WGSL-источник хранится в WgpuCommand (compiled), поэтому для
    // device-loss recovery достаточно replay-нуть только текстуры/цели/views —
    // пайплайны пересоздадутся автоматически при первом draw на новом device.
    ensurePipeline: (pipelineId, wgsl, attrSizes, hasTextures) =>
      gpu.ensurePipeline(pipelineId, wgsl, attrSizes, hasTextures),
    usePipeline: pipelineId => gpu.usePipeline(pipelineId),
    bindUniforms: dynamicOffset => gpu.bindUniforms(dynamicOffset),
    bindVertexBuffer: (slot, data, size) => gpu.bindVertexBuffer(slot, data, size),
    // M5 (Task 73): feed dual-bind — frame-op (per-frame dirty range), не журналируется.
    syncVertexBuffer: (data, byteLength) => gpu.syncVertexBuffer(data, byteLength),
    bindTexture: textureOrViewId => gpu.bindTexture(textureOrViewId),
    beginPass: clearIndex => gpu.beginPass(clearIndex),
    draw: (count, instances) => gpu.draw(count, instances),
    endPass: () => gpu.endPass(),
    submit: () => gpu.submit(),
    createTarget: (textureId, w, h, depth, color) => {
      const id = gpu.createTarget(textureId, w, h, depth, color)
      journal.record({ kind: 'createTarget', id, textureId, width: w, height: h, depth, color: color as ClearColor })
      return id
    },
    bindTarget: (targetId, clear) => gpu.bindTarget(targetId, clear),
    // Task 80: readback — ЧТЕНИЕ, не декларация: не журналируется
    // (frame-опс по духу §9.5 P3; replay не нужен).
    readTargetPixels: targetId => gpu.readTargetPixels(targetId),
    // destroy-опсы: пишем в журнал, чтобы Journal.compact() мог спаривать
    // create+destroy. Replay на новом фасаде — destroy no-op (см. applyGpuOp).
    deleteTexture: textureId => {
      gpu.deleteTexture(textureId)
      texSizes.delete(textureId)
      journal.record({ kind: 'destroyTexture', id: textureId })
    },
    deleteTarget: targetId => {
      gpu.deleteTarget(targetId)
      journal.record({ kind: 'destroyTarget', id: targetId })
    },
    // Sub-mip views (Task 56): createTextureView/destroyTextureView —
    // долгоживущие декларации (как createTexture). Журналируем для device-loss
    // recovery: при replay на новом backend'е вид воссоздаётся через
    // target.createTextureView(textureId, { baseMipLevel, mipLevelCount }).
    // ВАЖНО: textureId в записи — это id на ТЕКУЩЕМ backend'е. При replay
    // caller должен замапить его на новый id (через registerIdMap или
    // подобный механизм) — applyGpuOp ниже делегирует это вызывающему коду.
    createTextureView: (textureId, options) => {
      const viewId = gpu.createTextureView(textureId, options)
      journal.record({
        kind: 'createTextureView',
        id: viewId,
        textureId,
        baseMipLevel: options?.baseMipLevel,
        mipLevelCount: options?.mipLevelCount,
      })
      return viewId
    },
    deleteTextureView: viewId => {
      gpu.deleteTextureView(viewId)
      journal.record({ kind: 'destroyTextureView', id: viewId })
    },
    dispose: () => gpu.dispose(),
    installTimer: handle => gpu.installTimer(handle),
    // Public getters — делегируем на underlying facade. Journal не вмешивается
    // в caps/timer (они устроены над adapter/device, не над create/destroy).
    get adapter() { return gpu.adapter },
    get device() { return gpu.device },
    get preferredFormat() { return gpu.preferredFormat },
    get timer() { return gpu.timer },
  }
}

/**
 * Replay журнала на целевом GPUFacade — для device-loss recovery.
 *
 * sourceFor — callback для copyExternalImageToTexture (WebGPU-аналог
 * texImage2DFromSource): возвращает источник по kind ('ImageBitmap',
 * 'HTMLCanvasElement', и т.д.). Если callback не передан или вернул null —
 * опс пропускается (текстура остаётся пустой, sampler вернёт нули).
 *
 * Идемпотентность: повторный replay создаст ДУБЛИКАТЫ ресурсов (realGPU всегда
 * выдаёт новый id — nextTextureId++). Правильное использование — на СВЕЖЕМ
 * backend'е (после device.destroy() и пересоздания adapter/device).
 *
 * cross-backend replay: если журнал записан на WebGL2, а target — WebGPU
 * (или наоборот), некоторые опсы будут несовместимы:
 *   • createProgram/createBuffer (WebGL2-only) — applyGpuOp их игнорирует
 *     (default case) — на WebGPU нет программ как отдельных ресурсов.
 *   • texImage2DFromSource на WebGPU — copyExternalImageToTexture с dstX=0,
 *     dstY=0, copySize=externalImageSize(source). Это full-texture upload,
 *     sub-region не эмулируется.
 */
export function replayJournalOnGpu(
  journal: Journal,
  target: GPUFacade,
  sourceFor?: (kind: string) => GPUImageSource | null,
): void {
  journal.replay(op => applyGpuOp(op, target, sourceFor))
}

/** Применить один DeclOp к целевому GPUFacade. */
function applyGpuOp(op: DeclOp, gpu: GPUFacade, sourceFor?: (kind: string) => GPUImageSource | null): void {
  switch (op.kind) {
    case 'createTexture':
      // Игнорируем возвращаемый id: на новом фасаде id будет другим.
      // Порядок важен: texture 1 → createTexture 1, texture 2 → createTexture 2,
      // mapping id'шников на стороне пользователя (через registerIdMap).
      gpu.createTexture(op.width, op.height, op.format, op.options)
      break
    case 'createTarget':
      gpu.createTarget(op.textureId, op.width, op.height, op.depth, op.color as ClearColor)
      break
    case 'texImage2DFromSource': {
      const source = sourceFor?.(op.sourceKind) ?? null
      if (source === null) break // нет источника — пропускаем (текстура остаётся пустой)
      // WebGPU: copyExternalImageToTexture — full-texture upload (dstX=dstY=0).
      // copySize = размер источника (externalImageSize синхронно читает .width/
      // .height/.videoWidth/.displayWidth из source).
      const [sw, sh] = externalImageSize(source)
      gpu.copyExternalImageToTexture(op.textureId, source, 0, 0, sw, sh, op.flipY)
      break
    }
    // Sub-mip views (Task 56): при replay создаём view на новом backend'е.
    // ВАЖНО: op.textureId — это id на исходном backend'е. На новом backend'е
    // textureId будет ДРУГИМ. Caller должен замапить id'шники перед replay
    // (это ответственность пользовательского кода, т.к. только он знает
    // соответствие старых и новых id'шников).
    //
    // В этой реализации мы передаём op.textureId напрямую — это безопасно
    // только если textureId на новом backend'е совпадает с исходным (например,
    // при replay в порядке всех createTexture, id'шники генерируются в том же
    // порядке и совпадают). Иначе caller должен конвертировать id'шники в
    // journal.entries() перед вызовом replayJournalOnGpu.
    case 'createTextureView':
      gpu.createTextureView(op.textureId, {
        baseMipLevel: op.baseMipLevel,
        mipLevelCount: op.mipLevelCount,
      })
      break
    // destroy-опсы на новом фасаде — no-op (ресурсов ещё нет).
    // На том же фасаде (сверка идемпотентности) — ответственность лежит на
    // фасаде: игнорировать или бросать.
    // createProgram/createBuffer (WebGL2-only DeclOp variants) — игнорируем
    // на WebGPU: там нет отдельных программ/буферов как ресурсов (пайплайны
    // ленивые, vertex buffers — keyed по Float32Array в bindVertexBuffer).
    default:
      break
  }
}

/** Имя типа источника для записи в журнал. Паритет с describeSourceKind в
 *  journalGl.ts — те же kind-имена, чтобы sourceFor-callback был переиспользуем
 *  между WebGL2 и WebGPU replay'ями. */
function describeGpuSourceKind(source: GPUImageSource): string {
  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) return 'ImageBitmap'
  if (typeof OffscreenCanvas !== 'undefined' && source instanceof OffscreenCanvas) return 'OffscreenCanvas'
  if (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) return 'HTMLCanvasElement'
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) return 'HTMLVideoElement'
  // VideoFrame — WebCodecs API (только в защищённых контекстах). Duck-typing
  // для headless-окружений без глобальных типов.
  if (typeof source === 'object' && source !== null) {
    if ('displayWidth' in source && 'codedWidth' in source) return 'VideoFrame'
    if ('getContext' in source) return 'OffscreenCanvas'
    if ('close' in source && 'width' in source) return 'ImageBitmap'
  }
  return (source as { constructor: { name: string } }).constructor?.name ?? 'unknown'
}
