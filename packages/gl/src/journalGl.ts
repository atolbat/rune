/**
 * withJournal — декоратор GLFacade: пишет create/destroy-опсы в Journal.
 *
 * Контракт §9.5 P3: журнал делает switchBackend = device-loss recovery =
 * = worker migration одним механизмом replay.
 *
 * Что журналируется автоматически:
 *   - createTexture(w,h) → {kind:'createTexture', id, width, height}
 *   - createProgram(v,f) → {kind:'createProgram', id, vertex, fragment}
 *   - createBuffer(data) → {kind:'createBuffer', id, data}
 *   - createTarget(...)  → {kind:'createTarget', id, textureId, w, h, depth, color}
 *   - texImage2DFromSource(tex, src, opt) → {kind:'texImage2DFromSource', textureId, sourceKind, flipY}
 *
 * Чего в журнале НЕТ (намеренно):
 *   - Frame-опсы (useProgram, setUniform*, bindTexture, bindTarget, drawArrays,
 *     setViewport, clear, setDepthMode, setCull, texSubImage2D-стриминг) —
 *     это per-frame, идут в Tape, а не в Journal.
 *   - Источник texImage2DFromSource не сериализуется (ImageBitmap может быть
 *     закрыт, HTMLCanvasElement — DOM-зависим). Журнал хранит только kind+flipY;
 *     при replay пользователь предоставляет источник через sourceFor(kind).
 *
 * Replay на новом фасаде: journal.replay(op => applyOp(op, targetGL, sourceFor?))
 *   — см. replayJournalOn в этом же файле. Все create-опсы выполняются в
 *   порядке записи; destroy-опсы пока no-op на новом фасаде (ресурсов ещё нет).
 */

import type { Journal, DeclOp, ClearColor } from '@rune/core'
import { toFloat32Array } from '@rune/core'
import type { GLFacade, GLImageSource } from '@rune/webgl2'

/** Декорирует GLFacade так, что create/destroy-опсы пишутся в Journal. */
export function withJournal(gl: GLFacade, journal: Journal): GLFacade {
  return {
    createProgram: (vertex, fragment) => {
      const id = gl.createProgram(vertex, fragment)
      journal.record({ kind: 'createProgram', id, vertex, fragment })
      return id
    },
    useProgram: id => gl.useProgram(id),
    createBuffer: data => {
      const id = gl.createBuffer(data)
      journal.record({ kind: 'createBuffer', id, data })
      return id
    },
    bindVertexBuffer: (bufferId, location, size, stride, byteOffset, divisor) => gl.bindVertexBuffer(bufferId, location, size, stride, byteOffset, divisor),
    // M5 (Task 73): feed dual-bind — frame-op (per-frame dirty range), не журналируется.
    updateBuffer: (bufferId, data, byteOffset) => gl.updateBuffer(bufferId, data, byteOffset),
    setUniformMatrix4: (programId, name, values) => gl.setUniformMatrix4(programId, name, values),
    setUniform4fv: (programId, name, values) => gl.setUniform4fv(programId, name, values),
    setUniform3fv: (programId, name, values) => gl.setUniform3fv(programId, name, values),
    setUniform2fv: (programId, name, values) => gl.setUniform2fv(programId, name, values),
    setUniform1f: (programId, name, value) => gl.setUniform1f(programId, name, value),
    setUniform1i: (programId, name, value) => gl.setUniform1i(programId, name, value),
    createTexture: (width, height, options) => {
      const id = gl.createTexture(width, height, options)
      // Task 67: формат хранения — в v1-опс (журнальное имя 'rgba16float'),
      // чтобы replay/switch-backend пересоздал текстуру тем же форматом.
      const format = options?.format === 'rgba16f' ? 'rgba16float' as const
        : options?.format === 'rgba32f' ? 'rgba32float' as const
        : undefined
      journal.record({ kind: 'createTexture', id, width, height, format, options })
      return id
    },
    texSubImage2D: (textureId, x, y, width, height, bytes) =>
      gl.texSubImage2D(textureId, x, y, width, height, bytes),
    texImage2DFromSource: (textureId, source, options) => {
      gl.texImage2DFromSource(textureId, source, options)
      journal.record({
        kind: 'texImage2DFromSource',
        textureId,
        sourceKind: describeSourceKind(source),
        flipY: options?.flipY ?? false,
      })
    },
    // Frame-опсы (per-frame): texSubImage2DFromSource + texImage2DLevel —
    // progressive mip streaming / sub-region upload. Не журналируются
    // (как и другие frame-опсы — см. контракт §9.5 P3: frame-опсы в Tape).
    // Pass-through без journal.record().
    texSubImage2DFromSource: (textureId, x, y, source, options) =>
      gl.texSubImage2DFromSource(textureId, x, y, source, options),
    texImage2DLevel: (textureId, level, source, options) =>
      gl.texImage2DLevel(textureId, level, source, options),
    bindTexture: (textureOrViewId, unit) => gl.bindTexture(textureOrViewId, unit),
    // Sub-mip views (Task 56): createTextureView/destroyTextureView —
    // долгоживущие декларации (как createTexture). Журналируем для device-loss
    // recovery: при replay на новом backend'е вид воссоздаётся через
    // target.createTextureView(textureId, { baseMipLevel, mipLevelCount }).
    // ВАЖНО: textureId в записи — это id на ТЕКУЩЕМ backend'е. При replay
    // caller должен замапить его на новый id (через registerIdMap или
    // подобный механизм) — applyOp ниже делегирует это вызывающему коду.
    createTextureView: (textureId, options) => {
      const viewId = gl.createTextureView(textureId, options)
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
      gl.deleteTextureView(viewId)
      journal.record({ kind: 'destroyTextureView', id: viewId })
    },
    setViewport: (width, height) => gl.setViewport(width, height),
    setDepthMode: (test, write) => gl.setDepthMode(test, write),
    setCull: mode => gl.setCull(mode),
    setBlend: (src, dst) => gl.setBlend(src, dst),
    clear: (color, depth) => gl.clear(color, depth),
    drawArrays: (mode, first, count, instances) => gl.drawArrays(mode, first, count, instances),
    createTarget: (textureId, width, height, depth, color) => {
      const id = gl.createTarget(textureId, width, height, depth, color)
      journal.record({ kind: 'createTarget', id, textureId, width, height, depth, color })
      return id
    },
    bindTarget: (targetId, clear) => gl.bindTarget(targetId, clear),
    // Task 80: readback — ЧТЕНИЕ, не декларация: не журналируется (как
    // frame-опсы §9.5 P3 — replay не нужен, результат живёт один вызов).
    readTargetPixels: targetId => gl.readTargetPixels(targetId),
    // destroy-опсы: пишем в журнал, чтобы Journal.compact() мог спаривать
    // create+destroy. Replay на новом фасаде — destroy no-op (см. applyOp).
    deleteTexture: textureId => {
      gl.deleteTexture(textureId)
      journal.record({ kind: 'destroyTexture', id: textureId })
    },
    deleteTarget: targetId => {
      gl.deleteTarget(targetId)
      journal.record({ kind: 'destroyTarget', id: targetId })
    },
    deleteProgram: programId => {
      gl.deleteProgram(programId)
      journal.record({ kind: 'destroyProgram', id: programId })
    },
    deleteBuffer: bufferId => {
      gl.deleteBuffer(bufferId)
      journal.record({ kind: 'destroyBuffer', id: bufferId })
    },
  }
}

/**
 * Replay журнала на целевом GLFacade — для device-loss recovery.
 *
 * sourceFor — callback для texImage2DFromSource: возвращает источник по kind
 * (например, 'ImageBitmap' → подготовленный битмап). Если callback не передан
 * или вернул null — опс пропускается (ресурс остаётся «пустой текстурой»).
 *
 * Идемпотентность: повторный replay создаст ДУБЛИКАТЫ ресурсов (realGL
 * всегда выдаёт новый id). Правильное использование — на СВЕЖЕМ backend'е.
 */
export function replayJournalOn(
  journal: Journal,
  target: GLFacade,
  sourceFor?: (kind: string) => GLImageSource | null,
): void {
  journal.replay(op => applyOp(op, target, sourceFor))
}

/** Применить один DeclOp к целевому GLFacade. */
function applyOp(op: DeclOp, gl: GLFacade, sourceFor?: (kind: string) => GLImageSource | null): void {
  switch (op.kind) {
    case 'createTexture':
      // Игнорируем возвращаемый id: на новом фасаде id будет другим.
      // Порядок важен: texture 1 → createTexture 1, texture 2 → createTexture 2,
      // mapping id'шников на стороне пользователя.
      // Task 67: формат из опса → GL-имя ('rgba16float' → 'rgba16f').
      gl.createTexture(op.width, op.height, {
        ...op.options,
        ...(op.format === 'rgba16float' || op.format === 'rgba32float'
          ? { format: op.format === 'rgba16float' ? 'rgba16f' as const : 'rgba32f' as const }
          : {}),
      })
      break
    case 'createProgram':
      gl.createProgram(op.vertex, op.fragment)
      break
    case 'createBuffer':
      // Task 61: после JSON round-trip (worker migration) data может быть
      // plain-object {"0":v0,...} или number[]. Коэрсим к Float32Array ДО
      // передачи фасаду — gl.bufferData с plain object несовместим, а
      // withJournal-декоратор записал бы протухший опс в журнал.
      gl.createBuffer(op.data instanceof Float32Array ? op.data : toFloat32Array(op.data))
      break
    case 'createTarget':
      gl.createTarget(op.textureId, op.width, op.height, op.depth, op.color as ClearColor)
      break
    case 'texImage2DFromSource': {
      const source = sourceFor?.(op.sourceKind) ?? null
      if (source === null) break // нет источника — пропускаем (текстура остаётся пустой)
      gl.texImage2DFromSource(op.textureId, source, { flipY: op.flipY })
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
    // journal.entries() перед вызовом replayJournalOn.
    case 'createTextureView':
      gl.createTextureView(op.textureId, {
        baseMipLevel: op.baseMipLevel,
        mipLevelCount: op.mipLevelCount,
      })
      break
    // destroy-опсы на новом фасаде — no-op (ресурсов ещё нет)
    // На том же фасаде (сверка идемпотентности) —
    // ответственность лежит на фасаде: игнорировать или бросать.
    default:
      break
  }
}

/** Имя типа источника для записи в журнал. */
function describeSourceKind(source: GLImageSource): string {
  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) return 'ImageBitmap'
  if (typeof OffscreenCanvas !== 'undefined' && source instanceof OffscreenCanvas) return 'OffscreenCanvas'
  if (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) return 'HTMLCanvasElement'
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) return 'HTMLVideoElement'
  if (typeof source === 'object' && source !== null) {
    if ('getContext' in source) return 'OffscreenCanvas'
    if ('close' in source && 'width' in source) return 'ImageBitmap'
  }
  return (source as { constructor: { name: string } }).constructor?.name ?? 'unknown'
}
