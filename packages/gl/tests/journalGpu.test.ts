import { describe, expect, it } from 'bun:test'
import { createJournal } from '@rune/core'
import type { DeclOp } from '@rune/core'
import { createRecordingGPU } from '@rune/webgpu'
import { withJournalGpu, replayJournalOnGpu } from '../src/journalGpu.ts'
import type { GPUImageSource } from '@rune/webgpu'

/**
 * Task 57: WebGPU journal-decorator (withJournalGpu + replayJournalOnGpu).
 *
 * Контракт (паритет с journalGl.ts для WebGL2):
 *  1. withJournalGpu(gpu, journal) — оборачивает GPUFacade декоратором.
 *  2. create/destroy-опсы (createTexture, createTarget, createTextureView,
 *     copyExternalImageToTexture как full-texture upload) пишутся автоматически.
 *  3. Frame-опсы (usePipeline, bindUniforms, bindTexture, draw, submit и пр.)
 *     НЕ журналируются (это per-frame, идут в Tape, не в Journal).
 *  4. copyExternalImageToTextureMip (mip streaming) — frame-op, не журналируется.
 *  5. Sub-region copyExternalImageToTexture (dstX != 0 || dstY != 0) — frame-op
 *     (atlas packing), не журналируется.
 *  6. Replay на новом фасаде: replayJournalOnGpu(journal, newGpu, sourceFor?)
 *     — воссоздаёт все долгоживущие ресурсы в правильном порядке.
 *  7. sourceFor(kind) callback для copyExternalImageToTexture — возвращает
 *     готовый источник по kind ('ImageBitmap', 'HTMLCanvasElement' и т.д.).
 *     Если callback не передан или вернул null — опс пропускается (текстура
 *     остаётся пустой, sampler вернёт нули).
 *
 * Сценарий device-loss recovery:
 *  1. Пользователь создал текстуру/цель/view — Journal записал.
 *  2. Устройство потеряно (старый GPUFacade умер).
 *  3. Создаётся новый GPUFacade (через createRealGPU).
 *  4. replayJournalOnGpu(journal, newGpu, sourceFor) — пересоздаёт все ресурсы.
 */

function fakeBitmap(w: number, h: number): ImageBitmap {
  return { width: w, height: h, close: () => {} } as unknown as ImageBitmap
}

describe('Task 57 — withJournalGpu decorator', () => {
  it('createTexture автоматически пишется в журнал (с format по умолчанию undefined)', () => {
    const journal = createJournal()
    const { gpu } = createRecordingGPU()
    const decorated = withJournalGpu(gpu, journal)

    decorated.createTexture(128, 128)

    const texOps = journal.entries().filter(op => op.kind === 'createTexture')
    expect(texOps.length).toBe(1)
    const op = texOps[0] as Extract<DeclOp, { kind: 'createTexture' }>
    expect(op.width).toBe(128)
    expect(op.height).toBe(128)
    expect(op.format).toBeUndefined() // format не передан → undefined (replay: default RGBA8)
    expect(op.options).toBeUndefined()
  })

  it('createTexture с format=canvas → format сохранён в опсе', () => {
    const journal = createJournal()
    const { gpu } = createRecordingGPU()
    const decorated = withJournalGpu(gpu, journal)

    decorated.createTexture(800, 600, 'canvas')

    const op = journal.entries()[0] as Extract<DeclOp, { kind: 'createTexture' }>
    expect(op.format).toBe('canvas')
  })

  it('createTexture с mipLevels + maxAnisotropy → options сохранены', () => {
    const journal = createJournal()
    const { gpu } = createRecordingGPU()
    const decorated = withJournalGpu(gpu, journal)

    decorated.createTexture(256, 256, 'rgba8unorm', { mipLevels: 9, maxAnisotropy: 8 })

    const op = journal.entries()[0] as Extract<DeclOp, { kind: 'createTexture' }>
    expect(op.format).toBe('rgba8unorm')
    expect(op.options?.mipLevels).toBe(9)
    expect(op.options?.maxAnisotropy).toBe(8)
  })

  it('deleteTexture → destroyTexture опс в журнале', () => {
    const journal = createJournal()
    const { gpu } = createRecordingGPU()
    const decorated = withJournalGpu(gpu, journal)

    const id = decorated.createTexture(64, 64)
    decorated.deleteTexture(id)

    const ops = journal.entries()
    expect(ops[0].kind).toBe('createTexture')
    expect(ops[1].kind).toBe('destroyTexture')
    expect((ops[1] as Extract<DeclOp, { kind: 'destroyTexture' }>).id).toBe(id)
  })

  it('createTarget + deleteTarget → журналируются', () => {
    const journal = createJournal()
    const { gpu } = createRecordingGPU()
    const decorated = withJournalGpu(gpu, journal)

    const texId = decorated.createTexture(128, 128)
    const targetId = decorated.createTarget(texId, 128, 128, true, [0.1, 0.2, 0.3, 1])
    decorated.deleteTarget(targetId)

    const ops = journal.entries()
    expect(ops[0].kind).toBe('createTexture')
    expect(ops[1].kind).toBe('createTarget')
    expect(ops[2].kind).toBe('destroyTarget')
    const targetOp = ops[1] as Extract<DeclOp, { kind: 'createTarget' }>
    expect(targetOp.textureId).toBe(texId)
    expect(targetOp.width).toBe(128)
    expect(targetOp.height).toBe(128)
    expect(targetOp.depth).toBe(true)
    expect(targetOp.color).toEqual([0.1, 0.2, 0.3, 1])
  })

  it('createTextureView + deleteTextureView → журналируются', () => {
    const journal = createJournal()
    const { gpu } = createRecordingGPU()
    const decorated = withJournalGpu(gpu, journal)

    const texId = decorated.createTexture(256, 256, 'rgba8unorm', { mipLevels: 9 })
    const viewId = decorated.createTextureView(texId, { baseMipLevel: 4, mipLevelCount: 2 })
    decorated.deleteTextureView(viewId)

    const ops = journal.entries()
    expect(ops[0].kind).toBe('createTexture')
    expect(ops[1].kind).toBe('createTextureView')
    expect(ops[2].kind).toBe('destroyTextureView')
    const viewOp = ops[1] as Extract<DeclOp, { kind: 'createTextureView' }>
    expect(viewOp.id).toBe(viewId)
    expect(viewOp.textureId).toBe(texId)
    expect(viewOp.baseMipLevel).toBe(4)
    expect(viewOp.mipLevelCount).toBe(2)
  })

  it('copyExternalImageToTexture (full-texture) → texImage2DFromSource опс в журнале', () => {
    const journal = createJournal()
    const { gpu } = createRecordingGPU()
    const decorated = withJournalGpu(gpu, journal)

    const texId = decorated.createTexture(64, 64)
    const src = fakeBitmap(64, 64)
    decorated.copyExternalImageToTexture(texId, src, 0, 0, 64, 64)

    const ops = journal.entries()
    expect(ops[0].kind).toBe('createTexture')
    expect(ops[1].kind).toBe('texImage2DFromSource')
    const uploadOp = ops[1] as Extract<DeclOp, { kind: 'texImage2DFromSource' }>
    expect(uploadOp.textureId).toBe(texId)
    expect(uploadOp.sourceKind).toBe('ImageBitmap')
    expect(uploadOp.flipY).toBe(false) // default
  })

  it('copyExternalImageToTexture с flipY=true → flipY=true в опсе', () => {
    const journal = createJournal()
    const { gpu } = createRecordingGPU()
    const decorated = withJournalGpu(gpu, journal)

    const texId = decorated.createTexture(32, 32)
    const src = fakeBitmap(32, 32)
    decorated.copyExternalImageToTexture(texId, src, 0, 0, 32, 32, true)

    const uploadOp = journal.entries()[1] as Extract<DeclOp, { kind: 'texImage2DFromSource' }>
    expect(uploadOp.flipY).toBe(true)
  })

  it('copyExternalImageToTexture sub-region (dstX=8, dstY=8) → НЕ журналируется (atlas packing = frame-op)', () => {
    const journal = createJournal()
    const { gpu } = createRecordingGPU()
    const decorated = withJournalGpu(gpu, journal)

    const texId = decorated.createTexture(64, 64)
    const src = fakeBitmap(16, 16)
    decorated.copyExternalImageToTexture(texId, src, 8, 8, 16, 16)

    const ops = journal.entries()
    // Только createTexture — sub-region upload не журналируется
    expect(ops.length).toBe(1)
    expect(ops[0].kind).toBe('createTexture')
  })

  it('Task 61: copyExternalImageToTexture sub-region в (0,0) с размером МЕНЬШЕ текстуры → НЕ журналируется', () => {
    // Раньше эвристика проверяла только dstX=dstY=0: sub-region копия в левом
    // верхнем углу (первый тайл атласа, uploadSubImage в origin) ошибочно
    // журналировалась как полная загрузка — replay заливал бы текстуру
    // обрезанным источником. Теперь — size-aware: только полное покрытие.
    const journal = createJournal()
    const { gpu } = createRecordingGPU()
    const decorated = withJournalGpu(gpu, journal)

    const texId = decorated.createTexture(64, 64)
    const src = fakeBitmap(32, 32)
    decorated.copyExternalImageToTexture(texId, src, 0, 0, 32, 32)

    const ops = journal.entries()
    expect(ops.length).toBe(1)
    expect(ops[0].kind).toBe('createTexture')
  })

  it('Task 61: copyExternalImageToTexture полного размера в (0,0) → журналируется (size-aware совпадение)', () => {
    const journal = createJournal()
    const { gpu } = createRecordingGPU()
    const decorated = withJournalGpu(gpu, journal)

    const texId = decorated.createTexture(64, 64, 'rgba8unorm', { mipLevels: 1 })
    const src = fakeBitmap(64, 64)
    decorated.copyExternalImageToTexture(texId, src, 0, 0, 64, 64, true)

    const ops = journal.entries()
    expect(ops.length).toBe(2)
    expect(ops[1].kind).toBe('texImage2DFromSource')
  })

  it('copyExternalImageToTextureMip (mip streaming) → НЕ журналируется (frame-op)', () => {
    const journal = createJournal()
    const { gpu } = createRecordingGPU()
    const decorated = withJournalGpu(gpu, journal)

    const texId = decorated.createTexture(256, 256, 'rgba8unorm', { mipLevels: 9 })
    const src = fakeBitmap(8, 8)
    decorated.copyExternalImageToTextureMip(texId, 5, src, 0, 0, 8, 8)

    const ops = journal.entries()
    // Только createTexture — mip upload не журналируется
    expect(ops.length).toBe(1)
    expect(ops[0].kind).toBe('createTexture')
  })

  it('Frame-опсы НЕ журналируются: usePipeline, bindTexture, draw, submit', () => {
    const journal = createJournal()
    const { gpu } = createRecordingGPU()
    const decorated = withJournalGpu(gpu, journal)

    const texId = decorated.createTexture(64, 64)
    decorated.usePipeline(1)
    decorated.bindTexture(texId)
    decorated.draw(6, 1)
    decorated.endPass()
    decorated.submit()

    // Только createTexture
    expect(journal.size).toBe(1)
    expect(journal.entries()[0].kind).toBe('createTexture')
  })

  it('configure/resize/installTimer — НЕ журналируются (lifecycle, не ресурсы)', () => {
    const journal = createJournal()
    const { gpu } = createRecordingGPU()
    const decorated = withJournalGpu(gpu, journal)

    decorated.configure(800, 600)
    decorated.resize(1024, 768)
    decorated.installTimer(null)

    expect(journal.size).toBe(0)
  })

  it('public getters делегируют на underlying facade (adapter/device/preferredFormat/timer)', () => {
    const journal = createJournal()
    const { gpu } = createRecordingGPU()
    const decorated = withJournalGpu(gpu, journal)

    // recordingGPU: adapter=null, device=null, preferredFormat='bgra8unorm', timer=null
    expect(decorated.adapter).toBeNull()
    expect(decorated.device).toBeNull()
    expect(decorated.preferredFormat).toBe('bgra8unorm')
    expect(decorated.timer).toBeNull()
  })
})

describe('Task 57 — replayJournalOnGpu', () => {
  it('replay пересоздаёт ресурсы на новом фасаде в правильном порядке', () => {
    // Фаза 1: первый фасад создал ресурсы, журнал записал
    const journal = createJournal()
    const oldRecording = createRecordingGPU()
    const oldGpu = withJournalGpu(oldRecording.gpu, journal)

    const texId = oldGpu.createTexture(64, 64)
    oldGpu.createTarget(texId, 64, 64, true, [0.1, 0.2, 0.3, 1])
    oldGpu.createTextureView(texId, { baseMipLevel: 0, mipLevelCount: 1 })

    // Фаза 2: «устройство потеряно» — создаём НОВЫЙ фасад и replay'ем
    const newRecording = createRecordingGPU()
    replayJournalOnGpu(journal, newRecording.gpu)

    // Все create-опсы дошли: createTexture(64,64), createTarget, createTextureView.
    // ВАЖНО: фильтр с exact prefix, чтобы не поймать createTextureView в
    // createTexture-счётчике (startsWith('createTexture') ловит оба).
    const newCreateTex = newRecording.calls.filter(c => c.startsWith('createTexture(')).length
    const newCreateTarget = newRecording.calls.filter(c => c.startsWith('createTarget(')).length
    const newCreateView = newRecording.calls.filter(c => c.startsWith('createTextureView(')).length

    expect(newCreateTex).toBe(1)
    expect(newCreateTarget).toBe(1)
    expect(newCreateView).toBe(1)
  })

  it('replay с sourceFor: copyExternalImageToTexture (texImage2DFromSource) восстанавливается', () => {
    const journal = createJournal()
    const oldRecording = createRecordingGPU()
    const oldGpu = withJournalGpu(oldRecording.gpu, journal)

    const texId = oldGpu.createTexture(16, 16)
    const src = fakeBitmap(16, 16)
    oldGpu.copyExternalImageToTexture(texId, src, 0, 0, 16, 16)

    // Новый фасад + sourceFor-callback
    const newRecording = createRecordingGPU()
    const sourceFor = (kind: string): GPUImageSource | null => {
      if (kind === 'ImageBitmap') return fakeBitmap(16, 16) as GPUImageSource
      return null
    }
    expect(() => replayJournalOnGpu(journal, newRecording.gpu, sourceFor)).not.toThrow()

    // copyExternalImageToTexture дошел
    const uploadCalls = newRecording.calls.filter(c => c.startsWith('copyExternalImageToTexture'))
    expect(uploadCalls.length).toBe(1)
    // Проверяем что dstX=0, dstY=0 (full-texture upload, не sub-region)
    expect(uploadCalls[0]).toContain('@0,0')
  })

  it('replay без sourceFor: texImage2DFromSource пропускается (без исключения)', () => {
    const journal = createJournal()
    const oldRecording = createRecordingGPU()
    const oldGpu = withJournalGpu(oldRecording.gpu, journal)

    const texId = oldGpu.createTexture(8, 8)
    const src = fakeBitmap(8, 8)
    oldGpu.copyExternalImageToTexture(texId, src, 0, 0, 8, 8)

    // Новый фасад БЕЗ sourceFor
    const newRecording = createRecordingGPU()
    expect(() => replayJournalOnGpu(journal, newRecording.gpu)).not.toThrow()
    // createTexture дошел, copyExternalImageToTexture — пропущен
    expect(newRecording.calls.some(c => c.startsWith('createTexture'))).toBe(true)
    expect(newRecording.calls.some(c => c.startsWith('copyExternalImageToTexture'))).toBe(false)
  })

  it('replay не мутирует исходный журнал (snapshot-семантика через append-only)', () => {
    const journal = createJournal()
    const oldRecording = createRecordingGPU()
    const oldGpu = withJournalGpu(oldRecording.gpu, journal)
    oldGpu.createTexture(32, 32)
    const originalOps = journal.entries().slice()

    const newRecording = createRecordingGPU()
    replayJournalOnGpu(journal, newRecording.gpu)

    // Журнал не мутировал при replay
    expect(journal.entries().length).toBe(originalOps.length)
  })

  it('compact убирает createTexture → destroyTexture пару перед replay', () => {
    const journal = createJournal()
    const oldRecording = createRecordingGPU()
    const oldGpu = withJournalGpu(oldRecording.gpu, journal)

    const texId = oldGpu.createTexture(64, 64) // createTexture
    oldGpu.deleteTexture(texId) // destroyTexture
    // compaction: пара create→destroy одного id удаляет оба опса
    journal.compact()

    expect(journal.size).toBe(0)

    // Replay на новом фасаде — пустой журнал → ничего не делается
    const newRecording = createRecordingGPU()
    replayJournalOnGpu(journal, newRecording.gpu)
    expect(newRecording.calls.length).toBe(0)
  })

  it('cross-backend replay: WebGL2-only опсы (createProgram/createBuffer) игнорируются на WebGPU', () => {
    // Симулируем журнал, записанный на WebGL2 (есть createProgram/createBuffer).
    // Эти DeclOp variants не валидны для WebGPU (там нет отдельных программ/
    // буферов как ресурсов — пайплайны ленивые, vertex buffers — keyed по
    // Float32Array). applyGpuOp должен молча их пропускать (default case).
    const journal = createJournal()
    journal.record({ kind: 'createProgram', id: 1, vertex: 'V', fragment: 'F' })
    journal.record({ kind: 'createBuffer', id: 1, data: new Float32Array([1, 2, 3]) })
    journal.record({ kind: 'createTexture', id: 1, width: 64, height: 64 })

    const newRecording = createRecordingGPU()
    expect(() => replayJournalOnGpu(journal, newRecording.gpu)).not.toThrow()
    // createTexture дошел, createProgram/createBuffer — проигнорированы
    expect(newRecording.calls.some(c => c.startsWith('createTexture'))).toBe(true)
    expect(newRecording.calls.some(c => c.startsWith('createProgram'))).toBe(false)
    expect(newRecording.calls.some(c => c.startsWith('createBuffer'))).toBe(false)
  })
})
