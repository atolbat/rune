import { describe, expect, it } from 'bun:test'
import { createRenderer } from '../src/index.ts'
import { createRecordingGL } from '@rune/webgl2'

/** Интеграция стриминга: uploads.drain() в idle-слоте каждого кадра. */
describe('renderer.uploads (idle-слот стриминга)', () => {
  it('задачи исполняются в idle-слоте: приоритет выше — раньше; выбывающая закрывает кадр', async () => {
    const { gl } = createRecordingGL()
    const renderer = createRenderer({
      canvas: fakeCanvas(),
      dpr: 1,
      createGL: () => gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {}, // headless: без rAF (bun её не даёт)
      uploads: { initialBytes: 100 },
    })
    await renderer.start()

    const executed: number[] = []
    renderer.uploads.push({ bytes: 40, priority: 1, run: () => executed.push(1) })
    renderer.uploads.push({ bytes: 40, priority: 3, run: () => executed.push(3) })
    renderer.uploads.push({ bytes: 40, priority: 2, run: () => executed.push(2) })
    expect(renderer.uploads.pending).toBe(3)

    // Окно 100: две задачи по 40; третья не влезает в остаток (20) и
    // исполняется как выбывающая, ЗАКРЫВАЯ кадр (урок M6).
    renderer.step(16)
    expect(executed).toEqual([3, 2, 1]) // max-heap: приоритет выше — раньше
    expect(renderer.uploads.pending).toBe(0)

    // Выбывающая задача = спрос: окно растёт (AIMD additive increase).
    expect(renderer.uploads.window).toBeGreaterThan(100)

    // Следующий кадр без работы: окно мягко распускается (×7/8).
    const before = renderer.uploads.window
    renderer.step(32)
    expect(renderer.uploads.window).toBe(Math.max(64 * 1024, Math.floor(before * 7 / 8)))
  })

  it('AIMD-окно доступно снаружи (диагностика)', async () => {
    const { gl } = createRecordingGL()
    const renderer = createRenderer({
      canvas: fakeCanvas(),
      createGL: () => gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {}, // headless: без rAF
      uploads: { initialBytes: 80, minBytes: 80 },
    })
    await renderer.start()
    expect(renderer.uploads.window).toBe(80)
    renderer.uploads.push({ bytes: 80, priority: 1, run: () => {} })
    renderer.step(16)
    // Полное использование окна → рост на 1/8 (80 → 90)
    expect(renderer.uploads.window).toBe(90)
  })
})

function fakeCanvas(): HTMLCanvasElement {
  return { clientWidth: 800, clientHeight: 600, width: 0, height: 0 } as unknown as HTMLCanvasElement
}
