import { describe, expect, it } from 'bun:test'
import { createWebGpuRenderer } from '../src/index.ts'
import { createRecordingGPU } from '@rune/webgpu'
import type { GPUFacade } from '@rune/webgpu'

/** REGRESSION (требование заказчика): шторм ошибок GPU → пауза рендера. */
describe('error-storm guard', () => {
  it('после 3 ошибок GPU рендер ставится на паузу; restart снимает', async () => {
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
      requestFrame: () => () => {}, // Bun без rAF: цикл управляется step вручную
    })

    let frames = 0
    renderer.frame(() => { frames++ })

    renderer.step(100)
    expect(frames).toBe(1) // до ошибок рендер жив

    captured!('ошибка 1')
    captured!('ошибка 2')
    captured!('ошибка 3') // порог: пауза
    expect(reported.length).toBe(4) // три ошибки + сводка о паузе
    expect(reported[3]).toContain('рендер остановлен')

    renderer.step(200)
    expect(frames).toBe(1) // пауза: кадры не рисуются

    captured!('ошибка 4') // тишина после паузы: не репортится
    expect(reported.length).toBe(4)

    renderer.restart()
    renderer.step(300)
    expect(frames).toBe(2) // цикл восстановлен
    renderer.stop()
  })

  it('одиночные ошибки не останавливают рендер', async () => {
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

    captured!('единичная ошибка')
    renderer.step(100)
    renderer.step(200)
    expect(frames).toBe(2) // одна ошибка — не повод для паузы
    renderer.stop()
  })
})

function fakeCanvas(): HTMLCanvasElement {
  return { clientWidth: 800, clientHeight: 600, width: 800, height: 600 } as unknown as HTMLCanvasElement
}
