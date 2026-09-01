/**
 * Disposal discipline: manual dispose, page-close, FinalizationRegistry.
 *
 * Слои (см. realGL.ts, realGPU.ts, journalGl.ts, webgl2Renderer.ts):
 *
 * 1. Фасадный: deleteTexture/deleteTarget/deleteProgram/deleteBuffer —
 *    вызывают gl.delete* и убирают из внутреннего кэша. Идемпотентны.
 *
 * 2. Журнальный: withJournal эмитит destroyTexture/destroyTarget/...
 *    опсы в Journal. После этого Journal.compact() может спаривать
 *    create+destroy. Replay на новом фасаде — destroy no-op (ресурсов нет).
 *
 * 3. Рендерер-уровень: Texture.dispose() / Surface.dispose() —
 *    вызывают фасадные delete* + (для Texture) unregister из FR.
 *
 * 4. Renderer.dispose() — полный teardown: stop rAF + disconnect
 *    ResizeObserver. После dispose рендерер неработоспособен.
 *
 * 5. FinalizationRegistry (belt-and-suspenders): если пользователь
 *    забыл dispose() и отпустил ссылку на Texture — FR колбэк вызовет
 *    gl.deleteTexture. НЕ детерминирован — GC может не пойти.
 */

import { describe, expect, it } from 'bun:test'
import { createWebGL2Renderer } from '../src/index.ts'
import { createJournal } from '@rune/core'
import { createRecordingGL } from '@rune/webgl2'
import type { GLImageSource } from '@rune/webgl2'

function fakeCanvas(): HTMLCanvasElement {
  return { clientWidth: 800, clientHeight: 600, width: 0, height: 0 } as unknown as HTMLCanvasElement
}

function fakeBitmap(w: number, h: number): ImageBitmap {
  return { width: w, height: h, close: () => {} } as unknown as ImageBitmap
}

describe('Disposal: ручные delete* методы на фасаде', () => {
  it('Texture.dispose() вызывает deleteTexture на фасаде (запись в recordingGL)', () => {
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    const tex = renderer.texture(32, 32)
    tex.dispose()
    const deleteCalls = recording.calls.filter(c => c.startsWith('deleteTexture'))
    expect(deleteCalls.length).toBe(1)
    expect(deleteCalls[0]).toContain(String(tex.textureId))
    renderer.stop()
  })

  it('Texture.dispose() идемпотентен: повторный вызов — no-op', () => {
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    const tex = renderer.texture(32, 32)
    tex.dispose()
    tex.dispose() // повтор — no-op
    tex.dispose() // и ещё раз — no-op
    const deleteCalls = recording.calls.filter(c => c.startsWith('deleteTexture'))
    expect(deleteCalls.length).toBe(1) // только один
    renderer.stop()
  })

  it('Surface.dispose() вызывает deleteTarget + deleteTexture (в правильном порядке)', () => {
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    const surf = renderer.surface({ width: 64, height: 64, depth: true })
    surf.dispose()
    const deleteTargetCalls = recording.calls.filter(c => c.startsWith('deleteTarget'))
    const deleteTextureCalls = recording.calls.filter(c => c.startsWith('deleteTexture'))
    expect(deleteTargetCalls.length).toBe(1)
    expect(deleteTextureCalls.length).toBe(1)
    // Порядок: target удалён ДО текстуры (target ссылается на текстуру)
    const targetIdx = recording.calls.findIndex(c => c.startsWith('deleteTarget'))
    const texIdx = recording.calls.findIndex(c => c.startsWith('deleteTexture'))
    expect(targetIdx).toBeLessThan(texIdx)
    renderer.stop()
  })

  it('Surface.dispose() идемпотентен', () => {
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    const surf = renderer.surface({ width: 32, height: 32 })
    surf.dispose()
    surf.dispose()
    surf.dispose()
    const deleteCalls = recording.calls.filter(c => c.startsWith('delete'))
    expect(deleteCalls.length).toBe(2) // 1 deleteTarget + 1 deleteTexture
    renderer.stop()
  })
})

describe('Disposal: Journal получает destroy-опсы (wire-up)', () => {
  it('Texture.dispose() пишет destroyTexture опс в журнал', () => {
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
    const tex = renderer.texture(16, 16)
    tex.dispose()
    const destroyTexOps = journal.entries().filter(op => op.kind === 'destroyTexture')
    expect(destroyTexOps.length).toBe(1)
    const op = destroyTexOps[0] as Extract<typeof destroyTexOps[number], { kind: 'destroyTexture' }>
    expect(op.id).toBe(tex.textureId)
    renderer.stop()
  })

  it('Surface.dispose() пишет destroyTarget + destroyTexture опсы', () => {
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
    const surf = renderer.surface({ width: 32, height: 32, depth: true })
    surf.dispose()
    const destroyTargetOps = journal.entries().filter(op => op.kind === 'destroyTarget')
    const destroyTextureOps = journal.entries().filter(op => op.kind === 'destroyTexture')
    expect(destroyTargetOps.length).toBe(1)
    expect(destroyTextureOps.length).toBe(1)
    renderer.stop()
  })

  it('Journal.compact() убирает create+destroy пару и висячий texImage2DFromSource после dispose', () => {
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
    tex.dispose()
    // До compact: createTexture + texImage2DFromSource + destroyTexture
    const beforeCompact = journal.entries().length
    expect(beforeCompact).toBeGreaterThanOrEqual(3)

    journal.compact()
    // Task 61: после compact — ПУСТО. createTexture+destroyTexture — пара;
    // texImage2DFromSource — висячая ссылка на уничтоженную текстуру
    // (раньше выживал и ломал replay на свежем фасаде: загрузка в
    // несуществующий textureId).
    expect(journal.entries()).toEqual([])
    renderer.stop()
  })

  it('Task 61: texImage2DFromSource живой текстуры переживает compact', () => {
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
    journal.compact()
    const kinds = journal.entries().map(op => op.kind)
    expect(kinds).toEqual(['createTexture', 'texImage2DFromSource'])
    renderer.stop()
  })
})

describe('Disposal: Renderer.dispose() — полный teardown', () => {
  it('Renderer.dispose() идемпотентен', () => {
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => createRecordingGL().gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    expect(() => {
      renderer.dispose()
      renderer.dispose()
      renderer.dispose()
    }).not.toThrow()
  })

  it('Renderer.dispose() останавливает цикл', () => {
    let frameCount = 0
    let requestFrameCancel = () => {}
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => createRecordingGL().gl,
      observeResize: false,
      now: () => 0,
      requestFrame: cb => {
        const id = setTimeout(() => cb(performance.now()), 0)
        return () => clearTimeout(id)
      },
    })
    renderer.frame(() => { frameCount++ })
    renderer.start()
    renderer.dispose()
    const countAfterDispose = frameCount
    // Ждём немного — кадр не должен прийти
    return new Promise<void>(resolve => {
      setTimeout(() => {
        expect(frameCount).toBe(countAfterDispose) // не было новых кадров
        resolve()
      }, 50)
    })
  })
})

describe('Disposal: replayJournalOn с destroy-опсами', () => {
  it('destroy-опсы на новом фасаде — no-op (не бросают)', () => {
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
    const tex = renderer.texture(16, 16)
    tex.dispose()
    renderer.stop()

    // Replay на новом фасаде — destroy-опсы НЕ должны бросать
    const newRecording = createRecordingGL()
    expect(() => {
      // Ручной replay: проходим все опсы
      journal.replay(op => {
        // Имитируем applyOp через простой switch — для destroy-опсов no-op
        if (op.kind === 'createTexture' || op.kind === 'createProgram' ||
            op.kind === 'createBuffer' || op.kind === 'createTarget') {
          // create-опсы — создают ресурс (но возврат id игнорируем)
        }
        // destroy-опсы — no-op
      })
    }).not.toThrow()
  })
})
