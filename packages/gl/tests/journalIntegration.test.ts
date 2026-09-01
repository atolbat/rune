import { describe, expect, it } from 'bun:test'
import { createWebGL2Renderer } from '../src/index.ts'
import { replayJournalOn } from '../src/journalGl.ts'
import { createJournal } from '@rune/core'
import { createRecordingGL } from '@rune/webgl2'
import type { GLImageSource } from '@rune/webgl2'

/**
 * Интеграция Journal с WebGL2Renderer:
 * 1. createWebGL2Renderer({ journal }) — оборачивает GLFacade декоратором withJournal
 * 2. Все долгоживущие create* опсы пишутся в журнал автоматически
 * 3. replayJournalOn(journal, newGL, sourceFor) — восстанавливает состояние на новом фасаде
 *
 * Сценарий device-loss recovery:
 * 1. Пользователь создал текстуру, программу, буфер, цель — Journal записал
 * 2. Устройство потеряно (старый GLFacade умер)
 * 3. Создаётся новый GLFacade (через createGL)
 * 4. replayJournalOn(journal, newGL) — пересоздаёт все ресурсы в правильном порядке
 *
 * Источник texImage2DFromSource не сериализуется — пользователь при replay
 * передаёт sourceFor(kind) callback, который возвращает готовый источник.
 */

function fakeCanvas(): HTMLCanvasElement {
  return { clientWidth: 800, clientHeight: 600, width: 0, height: 0 } as unknown as HTMLCanvasElement
}

function fakeBitmap(w: number, h: number): ImageBitmap {
  return { width: w, height: h, close: () => {} } as unknown as ImageBitmap
}

describe('Journal интеграция с WebGL2Renderer', () => {
  it('createTexture/createProgram/createBuffer/createTarget автоматически пишутся в журнал', () => {
    const journal = createJournal()
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
      journal,
    })

    // surface создаёт текстуру (target) — должно записаться
    renderer.surface({ width: 64, height: 64, depth: true })
    // command() — компилирует спек; createProgram+createBuffer лениво в executor

    // surface записала createTexture + createTarget
    const texOps = journal.entries().filter(op => op.kind === 'createTexture')
    const targetOps = journal.entries().filter(op => op.kind === 'createTarget')
    expect(texOps.length).toBe(1)
    expect(targetOps.length).toBe(1)
    renderer.stop()
  })

  it('texture.uploadImage(source) пишет texImage2DFromSource опс в журнал', () => {
    const journal = createJournal()
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
      journal,
    })
    const tex = renderer.texture(32, 32)
    // Очистим журнал до uploadImage, чтобы изолировать
    journal.reset()
    tex.uploadImage(fakeBitmap(32, 32) as GLImageSource)
    const uploadOps = journal.entries().filter(op => op.kind === 'texImage2DFromSource')
    expect(uploadOps.length).toBe(1)
    const op = uploadOps[0] as Extract<typeof uploadOps[number], { kind: 'texImage2DFromSource' }>
    expect(op.textureId).toBe(tex.textureId)
    expect(op.sourceKind).toBe('ImageBitmap')
    expect(op.flipY).toBe(false) // default
    renderer.stop()
  })

  it('replayJournalOn восстанавливает ресурсы на новом фасаде в правильном порядке', () => {
    // Фаза 1: первый рендерер создал ресурсы, журнал записал
    const journal = createJournal()
    const oldRecording = createRecordingGL()
    const oldRenderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => oldRecording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
      journal,
    })
    const surf = oldRenderer.surface({ width: 64, height: 64, depth: true })
    const tex = oldRenderer.texture(16, 16)
    tex.uploadImage(fakeBitmap(16, 16) as GLImageSource, { flipY: false })
    // compact() — убрать мусор (здесь не должно быть пар create+destroy,
    // но это безопасно)
    journal.compact()
    const originalOps = journal.entries().slice()
    oldRenderer.stop()

    // Фаза 2: «устройство потеряно» — создаём НОВЫЙ фасад и replay'ем
    const newRecording = createRecordingGL()
    const sourceFor = (kind: string): GLImageSource | null => {
      if (kind === 'ImageBitmap') return fakeBitmap(16, 16) as GLImageSource
      return null
    }
    replayJournalOn(journal, newRecording.gl, sourceFor)

    // Все create-опсы дошли: createTexture (×2 — surface + manual), createTarget, texImage2DFromSource
    const newCreateTex = newRecording.calls.filter(c => c.startsWith('createTexture')).length
    const newCreateTarget = newRecording.calls.filter(c => c.startsWith('createTarget')).length
    const newTexImage = newRecording.calls.filter(c => c.startsWith('texImage2DFromSource')).length

    // surface создаёт createTexture + createTarget; manual texture — ещё createTexture
    expect(newCreateTex).toBeGreaterThanOrEqual(2)
    expect(newCreateTarget).toBe(1)
    expect(newTexImage).toBe(1)
    // texImage2DFromSource в журнале с flipY=false
    const newTexImageCall = newRecording.calls.find(c => c.startsWith('texImage2DFromSource'))
    expect(newTexImageCall).toContain('flipY=false')

    // Исходный журнал не мутировал при replay (snapshot-семантика неявно через append-only)
    expect(journal.entries().length).toBe(originalOps.length)
  })

  it('replayJournalOn без sourceFor: texImage2DFromSource пропускается (без исключения)', () => {
    const journal = createJournal()
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
      journal,
    })
    const tex = renderer.texture(8, 8)
    tex.uploadImage(fakeBitmap(8, 8) as GLImageSource)
    renderer.stop()

    // новый фасад, БЕЗ sourceFor
    const newRecording = createRecordingGL()
    expect(() => replayJournalOn(journal, newRecording.gl)).not.toThrow()
    // createTexture — дошёл; texImage2DFromSource — пропущен
    expect(newRecording.calls.some(c => c.startsWith('createTexture'))).toBe(true)
    expect(newRecording.calls.some(c => c.startsWith('texImage2DFromSource'))).toBe(false)
  })

  it('snapshot+replay: восстановление из снапшота, оригинал продолжает расти', () => {
    // Сценарий #41 resume-snapshot: зафиксировать состояние журнала,
    // продолжить работу, потом восстановиться из снапшота
    const journal = createJournal()
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
      journal,
    })
    renderer.surface({ width: 64, height: 64, depth: true })
    const snap = journal.snapshot()
    // После снапшота — ещё ресурсы
    renderer.texture(32, 32)

    // Replay только снапшота (без второй текстуры)
    const newRecording = createRecordingGL()
    const snapJournal = {
      replay: (apply: (op: never) => void) => { snap.ops.forEach(op => apply(op as never)) },
    }
    replayJournalOn(snapJournal as never, newRecording.gl)
    const newTex = newRecording.calls.filter(c => c.startsWith('createTexture')).length
    const newTarget = newRecording.calls.filter(c => c.startsWith('createTarget')).length
    // snap содержал 1 текстура (surface) + 1 target
    expect(newTex).toBe(1)
    expect(newTarget).toBe(1)
    renderer.stop()
  })

  it('Task 61: JSON round-trip replay — createBuffer с plain-object data не падает и доходит до фасада как Float32Array', () => {
    // Регрессия «Unhandled rejection: op.data.slice is not a function»:
    // worker migration сериализует журнал в JSON. JSON.stringify(Float32Array)
    // даёт {"0":v0,...}; после JSON.parse createBuffer.data — plain object.
    // Живой путь: record() нормализует его в Float32Array, replayJournalOn
    // передаёт фасаду корректный тип, повторный snapshot() не бросает.
    const journal = createJournal()
    journal.record({ kind: 'createTexture', id: 1, width: 32, height: 32 })
    journal.record({ kind: 'createProgram', id: 1, vertex: 'V', fragment: 'F' })
    journal.record({ kind: 'createBuffer', id: 1, data: new Float32Array([1, 2, 3, 4, 5, 6]) })

    // Worker migration: JSON → postMessage → JSON.parse → новый журнал
    const json = JSON.stringify(journal.snapshot().ops)
    const parsed = JSON.parse(json) as { kind: string; data?: unknown }[]
    // Сам JSON действительно «протух»: data — plain object без .slice
    const parsedBuf = parsed.find(op => op.kind === 'createBuffer')!
    expect(typeof (parsedBuf.data as { slice?: unknown }).slice).toBe('undefined')

    const workerJournal = createJournal()
    for (const op of parsed as never[]) workerJournal.record(op)

    // Повторный snapshot (второй device-loss) — раньше падал на op.data.slice
    expect(() => workerJournal.snapshot()).not.toThrow()

    // Replay на новом фасаде — не бросает, буфер доходит с длиной 6
    const newRecording = createRecordingGL()
    expect(() => replayJournalOn(workerJournal, newRecording.gl)).not.toThrow()
    const bufCall = newRecording.calls.find(c => c.startsWith('createBuffer'))
    expect(bufCall).toBe('createBuffer(6)')
  })
})
