import { describe, expect, it } from 'bun:test'
import { createWebGpuRenderer } from '../src/index.ts'
import { createRecordingGPU } from '@rune/webgpu'
import type { GPUFacade } from '@rune/webgpu'

/** REGRESSION (customer requirement): a storm of GPU errors → render pause. */
describe('error-storm guard', () => {
  it('after 3 GPU errors rendering is paused; restart clears it', async () => {
    const { gpu } = createRecordingGPU()
    const reported: string[] = []
    let captured: ((message: string) => void) | undefined

    const renderer = await createWebGpuRenderer({
      canvas: fakeCanvas(),
      createGPU: async (_canvas, onError) => {
        captured = onError
        return gpu
      },
      onGpuError: message => reported.push(message),
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {}, // Bun without rAF: the loop is driven manually via step
    })

    let frames = 0
    renderer.frame(() => { frames++ })

    renderer.step(100)
    expect(frames).toBe(1) // before errors the render is alive

    captured!('error 1')
    captured!('error 2')
    captured!('error 3') // threshold: pause
    expect(reported.length).toBe(4) // three errors + the pause summary
    expect(reported[3]).toContain('rendering stopped')

    renderer.step(200)
    expect(frames).toBe(1) // pause: frames are not drawn

    captured!('error 4') // silence after the pause: not reported
    expect(reported.length).toBe(4)

    renderer.restart()
    renderer.step(300)
    expect(frames).toBe(2) // the loop is restored
    renderer.stop()
  })

  it('single errors do not stop the render', async () => {
    const { gpu } = createRecordingGPU()
    let captured: ((message: string) => void) | undefined
    const renderer = await createWebGpuRenderer({
      canvas: fakeCanvas(),
      createGPU: async (_canvas, onError) => {
        captured = onError
        return gpu as GPUFacade
      },
      observeResize: false,
      now: () => 0,
    })
    let frames = 0
    renderer.frame(() => { frames++ })

    captured!('single error')
    renderer.step(100)
    renderer.step(200)
    expect(frames).toBe(2) // one error is not a reason to pause
    renderer.stop()
  })
})

function fakeCanvas(): HTMLCanvasElement {
  return { clientWidth: 800, clientHeight: 600, width: 800, height: 600 } as unknown as HTMLCanvasElement
}
