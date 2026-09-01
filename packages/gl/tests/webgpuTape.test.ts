import { describe, expect, it } from 'bun:test'
import { createWebGpuRenderer } from '../src/index.ts'
import { createRecordingGPU } from '@rune/webgpu'

/**
 * REGRESSION (инцидент «тёмный канвас после tape-перехода»):
 * renderer.step обязан открывать пасс ДО вызовов draw — раньше колбэки
 * звали фасад напрямую при закрытом пассе (тихие no-op → пустой кадр).
 * Путь проверяется на рекордер-фасаде: полный порядок вызовов кадра.
 */

const WGSL = `struct Params {
  u_mvp : mat4x4<f32>,
  u_tint : vec4<f32>,
}
@group(0) @binding(0) var<uniform> params : Params;

@vertex
fn vsMain(@location(0) inPos : vec3<f32>) -> @builtin(position) vec4<f32> {
  return params.u_mvp * vec4<f32>(inPos, 1.0);
}

@fragment
fn fsMain() -> @location(0) vec4<f32> {
  return params.u_tint;
}`

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function fakeCanvas(): HTMLCanvasElement {
  return { clientWidth: 800, clientHeight: 600, width: 800, height: 600 } as unknown as HTMLCanvasElement
}

describe('webgpuRenderer tape-путь', () => {
  it('REGRESSION: полный кадр — пасс открыт ДО draw, верный порядок вызовов', async () => {
    const { gpu, calls } = createRecordingGPU()
    const renderer = await createWebGpuRenderer({
      canvas: fakeCanvas(),
      createGPU: async () => gpu,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })

    const command = renderer.command({
      shader: { wgsl: WGSL },
      uniforms: { u_mvp: () => IDENTITY, u_tint: [1, 0.5, 0.25, 1] },
      count: 3,
    })
    renderer.frame((_ctx, record) => record(command))
    renderer.step(16)

    // Порядок кадра: аплоад юниформов → пасс → пайплайн → слайс → draw → end → submit
    const uploadAt = calls.findIndex(call => call.startsWith('uploadUniforms(0,'))
    const beginAt = calls.indexOf('beginPass(0)')
    const drawAt = calls.findIndex(call => call.startsWith('draw(3,1)'))
    const endAt = calls.indexOf('endPass')
    expect(uploadAt).toBeGreaterThanOrEqual(0)
    expect(beginAt).toBeGreaterThan(uploadAt) // аплоад ДО открытия пасса
    expect(drawAt).toBeGreaterThan(beginAt)   // draw строго ПОСЛЕ открытия пасса
    expect(endAt).toBeGreaterThan(drawAt)
    expect(calls[calls.length - 1]).toBe('submit')
    renderer.stop()
  })

  it('второй кадр без изменений: аплоад юниформов не повторяется', async () => {
    const { gpu, calls } = createRecordingGPU()
    const renderer = await createWebGpuRenderer({
      canvas: fakeCanvas(),
      createGPU: async () => gpu,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    const command = renderer.command({
      shader: { wgsl: WGSL },
      uniforms: { u_mvp: () => IDENTITY, u_tint: [1, 0.5, 0.25, 1] },
      count: 3,
    })
    renderer.frame((_ctx, record) => record(command))
    renderer.step(16)
    const uploadsAfterFirst = calls.filter(call => call.startsWith('uploadUniforms(')).length
    renderer.step(32)
    const uploadsAfterSecond = calls.filter(call => call.startsWith('uploadUniforms(')).length
    expect(uploadsAfterFirst).toBe(1)
    expect(uploadsAfterSecond).toBe(uploadsAfterFirst) // value-compare: чисто
    renderer.stop()
  })
})
