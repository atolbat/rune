import { describe, expect, it } from 'bun:test'
import { createWebGpuRenderer } from '../src/index.ts'
import { createRecordingGPU } from '@rune/webgpu'
import type { GPUFacade } from '@rune/webgpu'

/**
 * Task 175 — THE DEVICE-LOSS WIRE.
 *
 * The field finding (traced live, task175-profile / task175-reboot-matrix /
 * task175-raw-present): on the container's SwiftShader+Vulkan Chrome,
 * GPUQueue.copyExternalImageToTexture dies with a SYNC TypeError once the
 * device has presented a frame — and the failed call takes the whole
 * WebGPU instance down with it (device.lost fires, every later submit
 * silently no-ops, the canvas freezes). Before this task NOTHING watched
 * device.lost: the uncapturederror listener goes dead on a lost device, so
 * the renderer kept "rendering" a frozen canvas forever — the model-viewer
 * demo's WG leg died exactly there ("Failed to copy content from external
 * image" → "load failed" badge → a frozen canvas, no fallback, no report).
 *
 * The wire: realGPU takes onDeviceLost (fired from device.lost, guarded
 * against our own dispose — teardown also fires 'destroyed'), and the
 * renderer routes it into storm.fatal() — an IMMEDIATE pause with ONE
 * honest report (a lost device is a fact, not a three-error flake).
 * These pins drive the wire through the createGPU injection's third
 * argument, the exact channel realGPU receives.
 */
describe('task 175 — the device-loss wire', () => {
  it('device.lost fires → FATAL pause: one report, immediate, no 3-error count', async () => {
    const { gpu } = createRecordingGPU()
    const reported: string[] = []
    let onError: ((message: string) => void) | undefined
    let onDeviceLost: ((reason: string) => void) | undefined

    const renderer = await createWebGpuRenderer({
      canvas: fakeCanvas(),
      createGPU: async (_canvas, error, deviceLost) => {
        onError = error
        onDeviceLost = deviceLost
        return gpu as GPUFacade
      },
      onGpuError: message => reported.push(message),
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {}, // Bun without rAF: the loop is driven manually via step
    })

    let frames = 0
    renderer.frame(() => { frames++ })
    renderer.step(100)
    expect(frames).toBe(1) // alive before the loss

    onDeviceLost!('destroyed') // the poisoned-copy death the task traced
    expect(reported.length).toBe(1) // ONE report — not three errors + a summary
    expect(reported[0]).toContain('device lost')
    expect(reported[0]).toContain('destroyed')
    expect(reported[0]).toContain('rendering stopped')
    expect(reported[0]).toContain('re-boot') // the recovery path is named

    renderer.step(200)
    expect(frames).toBe(1) // paused: no frames drawn on a dead device

    onError!('a validation error on the dead device') // silence after the pause
    expect(reported.length).toBe(1)
    renderer.stop()
  })

  it('fatal beats the count: a device loss pauses even at error count 0', async () => {
    const { gpu } = createRecordingGPU()
    const reported: string[] = []
    let onDeviceLost: ((reason: string) => void) | undefined

    const renderer = await createWebGpuRenderer({
      canvas: fakeCanvas(),
      createGPU: async (_canvas, _error, deviceLost) => {
        onDeviceLost = deviceLost
        return gpu as GPUFacade
      },
      onGpuError: message => reported.push(message),
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })

    // no prior errors at all — the loss alone must pause
    onDeviceLost!('deviceRemoved')
    expect(reported.length).toBe(1)
    expect(reported[0]).toContain('deviceRemoved')
    renderer.stop()
  })

  it('a second fatal is silent (the first report stands); restart clears it', async () => {
    const { gpu } = createRecordingGPU()
    const reported: string[] = []
    let onDeviceLost: ((reason: string) => void) | undefined

    const renderer = await createWebGpuRenderer({
      canvas: fakeCanvas(),
      createGPU: async (_canvas, _error, deviceLost) => {
        onDeviceLost = deviceLost
        return gpu as GPUFacade
      },
      onGpuError: message => reported.push(message),
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })

    let frames = 0
    renderer.frame(() => { frames++ })
    onDeviceLost!('destroyed')
    onDeviceLost!('destroyed') // duplicate delivery — one report total
    expect(reported.length).toBe(1)

    renderer.restart() // the documented recovery: re-boot the renderer
    renderer.step(100)
    expect(frames).toBe(1) // the loop is live again (the NEW renderer/device does the work)
    renderer.stop()
  })

  it('the old storm semantics are untouched: 3 validation errors still pause (not fatal)', async () => {
    const { gpu } = createRecordingGPU()
    const reported: string[] = []
    let onError: ((message: string) => void) | undefined
    let onDeviceLost: ((reason: string) => void) | undefined

    const renderer = await createWebGpuRenderer({
      canvas: fakeCanvas(),
      createGPU: async (_canvas, error, deviceLost) => {
        onError = error
        onDeviceLost = deviceLost
        return gpu as GPUFacade
      },
      onGpuError: message => reported.push(message),
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })

    onError!('error 1')
    onError!('error 2')
    expect(reported.length).toBe(2) // below the threshold: no pause report yet
    onDeviceLost!('destroyed') // the loss preempts the third error
    expect(reported.length).toBe(3) // two errors + ONE fatal
    expect(reported[2]).toContain('device lost')
    renderer.stop()
  })
})

function fakeCanvas(): HTMLCanvasElement {
  return { clientWidth: 800, clientHeight: 600, width: 800, height: 600 } as unknown as HTMLCanvasElement
}
