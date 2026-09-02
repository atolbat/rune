import { describe, expect, it } from 'bun:test'
import { createWebGpuRenderer } from '../src/index.ts'
import { createRecordingGPU } from '@rune/webgpu'

/**
 * REGRESSION (the "dark canvas after a tape transition" incident):
 * renderer.step must open the pass BEFORE draw calls — previously callbacks
 * called the facade directly with the pass closed (silent no-ops → an empty frame).
 * The path is checked on the recorder facade: the full frame call order.
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

describe('webgpuRenderer tape path', () => {
  it('REGRESSION: a full frame — the pass is open BEFORE draw, the correct call order', async () => {
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

    // Frame order: uniform upload → pass → pipeline → slice → draw → end → submit
    const uploadAt = calls.findIndex(call => call.startsWith('uploadUniforms(0,'))
    const beginAt = calls.indexOf('beginPass(0)')
    const drawAt = calls.findIndex(call => call.startsWith('draw(3,1)'))
    const endAt = calls.indexOf('endPass')
    expect(uploadAt).toBeGreaterThanOrEqual(0)
    expect(beginAt).toBeGreaterThan(uploadAt) // upload BEFORE the pass opens
    expect(drawAt).toBeGreaterThan(beginAt)   // draw strictly AFTER the pass opens
    expect(endAt).toBeGreaterThan(drawAt)
    expect(calls[calls.length - 1]).toBe('submit')
    renderer.stop()
  })

  it('a second frame without changes: the uniform upload is not repeated', async () => {
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
    expect(uploadsAfterSecond).toBe(uploadsAfterFirst) // value-compare: clean
    renderer.stop()
  })
})
