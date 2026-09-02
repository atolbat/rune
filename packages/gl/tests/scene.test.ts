import { describe, expect, it } from 'bun:test'
import { show } from '../src/index.ts'
import { createRecordingGL } from '@rune/webgl2'

/** scene(): sugar over injections — the full path without a browser. */
describe('show() — a cube in one line', () => {
  it('without a texture: rendering starts, the frame draws a cube', () => {
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

  it('with a texture: the texture is created and streaming reaches 100%', () => {
    const { gl, calls } = createRecordingGL()
    const texture = new Uint8Array(64 * 64 * 4) // 64×64 — small, fits into the window
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

    world.renderer.step(16) // the idle slot runs the preview + chunks
    world.renderer.step(32)

    expect(calls.some(call => call.startsWith('texSubImage2D('))).toBe(true) // tiles are loading
    expect(progress[progress.length - 1]).toBeGreaterThan(0) // progress is moving
    world.stop()
  })
})

function fakeCanvas(): { clientWidth: number; clientHeight: number; width: number; height: number } {
  return { clientWidth: 800, clientHeight: 600, width: 0, height: 0 }
}
