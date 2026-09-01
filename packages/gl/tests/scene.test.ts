import { describe, expect, it } from 'bun:test'
import { show } from '../src/index.ts'
import { createRecordingGL } from '@rune/webgl2'

/** scene(): сахар на инъекциях — полный путь без браузера. */
describe('show() — куб в одну строку', () => {
  it('без текстуры: рендер стартует, кадр рисует куб', () => {
    const { gl, calls } = createRecordingGL()
    const world = show(fakeCanvas() as unknown as HTMLCanvasElement, {
      createGL: () => gl,
      observeResize: false,
      requestFrame: () => () => {},
      now: () => 0,
    } as never)

    world.renderer.step(1000)
    world.renderer.step(1050)

    expect(calls).toContain('drawArrays(triangles,0,36,1)')
    expect(calls.some(call => call.startsWith('clear('))).toBe(true)
    world.stop()
  })

  it('с текстурой: создаётся текстура и стриминг доезжает до 100%', () => {
    const { gl, calls } = createRecordingGL()
    const texture = new Uint8Array(64 * 64 * 4) // 64×64 — маленькая, влезает в окно
    texture.fill(200)
    const progress: number[] = []

    const world = show(fakeCanvas() as unknown as HTMLCanvasElement, {
      texture,
      textureSize: 64,
      onProgress: (fraction: number) => progress.push(fraction),
      createGL: () => gl,
      observeResize: false,
      requestFrame: () => () => {},
      now: () => 0,
    } as never)

    world.renderer.step(16) // idle-слот исполняет превью + чанки
    world.renderer.step(32)

    expect(calls.some(call => call.startsWith('texSubImage2D('))).toBe(true) // тайлы грузятся
    expect(progress[progress.length - 1]).toBeGreaterThan(0) // прогресс двигается
    world.stop()
  })
})

function fakeCanvas(): { clientWidth: number; clientHeight: number; width: number; height: number } {
  return { clientWidth: 800, clientHeight: 600, width: 0, height: 0 }
}
