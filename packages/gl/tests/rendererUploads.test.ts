import { describe, expect, it } from 'bun:test'
import { createRenderer } from '../src/index.ts'
import { createRecordingGL } from '@rune/webgl2'

/** Streaming integration: uploads.drain() in the idle slot of each frame. */
describe('renderer.uploads (streaming idle slot)', () => {
  it('tasks are executed in the idle slot: higher priority — earlier; an evicted task closes the frame', async () => {
    const { gl } = createRecordingGL()
    const renderer = createRenderer({
      canvas: fakeCanvas(),
      dpr: 1,
      createGL: () => gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {}, // headless: no rAF (bun does not provide it)
      uploads: { initialBytes: 100 },
    })
    await renderer.start()

    const executed: number[] = []
    renderer.uploads.push({ bytes: 40, priority: 1, run: () => executed.push(1) })
    renderer.uploads.push({ bytes: 40, priority: 3, run: () => executed.push(3) })
    renderer.uploads.push({ bytes: 40, priority: 2, run: () => executed.push(2) })
    expect(renderer.uploads.pending).toBe(3)

    // Window of 100: two tasks of 40; the third does not fit into the remainder (20) and
    // is executed as an evicted task, CLOSING the frame (lesson M6).
    renderer.step(16)
    expect(executed).toEqual([3, 2, 1]) // max-heap: higher priority — earlier
    expect(renderer.uploads.pending).toBe(0)

    // An evicted task = demand: the window grows (AIMD additive increase).
    expect(renderer.uploads.window).toBeGreaterThan(100)

    // Next frame without work: the window gently relaxes (×7/8).
    const before = renderer.uploads.window
    renderer.step(32)
    expect(renderer.uploads.window).toBe(Math.max(64 * 1024, Math.floor(before * 7 / 8)))
  })

  it('the AIMD window is available from the outside (diagnostics)', async () => {
    const { gl } = createRecordingGL()
    const renderer = createRenderer({
      canvas: fakeCanvas(),
      createGL: () => gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {}, // headless: no rAF
      uploads: { initialBytes: 80, minBytes: 80 },
    })
    await renderer.start()
    expect(renderer.uploads.window).toBe(80)
    renderer.uploads.push({ bytes: 80, priority: 1, run: () => {} })
    renderer.step(16)
    // Full window utilization → growth by 1/8 (80 → 90)
    expect(renderer.uploads.window).toBe(90)
  })
})

function fakeCanvas(): HTMLCanvasElement {
  return { clientWidth: 800, clientHeight: 600, width: 0, height: 0 } as unknown as HTMLCanvasElement
}
