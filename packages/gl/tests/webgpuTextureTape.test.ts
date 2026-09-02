import { describe, expect, it } from 'bun:test'
import { createWebGpuRenderer } from '../src/index.ts'
import { createRecordingGPU } from '@rune/webgpu'

/**
 * Texture WG commands (incidents 36/37): ensurePipeline receives the command's
 * attribute sizes ([3x3x2] — including uv float32x2), bindTexture between
 * the pipeline and draw, lazy creation exactly once.
 */

const WGSL_TEX = `struct Params {
  u_mvp : mat4x4<f32>,
}
@group(0) @binding(0) var<uniform> params : Params;
@group(1) @binding(0) var texSampler : sampler;
@group(1) @binding(1) var texTexture : texture_2d<f32>;

@vertex
fn vsMain(
  @location(0) inPos : vec3<f32>,
  @location(1) inNormal : vec3<f32>,
  @location(2) inUv : vec2<f32>,
) -> @builtin(position) vec4<f32> {
  return params.u_mvp * vec4<f32>(inPos, 1.0);
}

@fragment
fn fsMain() -> @location(0) vec4<f32> {
  return textureSample(texTexture, texSampler, vec2<f32>(0.5, 0.5));
}`

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function fakeCanvas(): HTMLCanvasElement {
  return { clientWidth: 800, clientHeight: 600, width: 800, height: 600 } as unknown as HTMLCanvasElement
}

describe('webgpu texture tape path', () => {
  it('ensurePipeline with [3x3x2] and tex; bindTexture between the pipeline and draw', async () => {
    const { gpu, calls } = createRecordingGPU()
    const renderer = await createWebGpuRenderer({
      canvas: fakeCanvas(),
      createGPU: async () => gpu,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })

    const textureId = renderer.gpu.createTexture(64, 64)
    const command = renderer.command({
      shader: { wgsl: WGSL_TEX },
      uniforms: { u_mvp: () => IDENTITY },
      attributes: {
        inPos: { data: new Float32Array(36 * 3), size: 3 },
        inNormal: { data: new Float32Array(36 * 3), size: 3 },
        inUv: { data: new Float32Array(36 * 2), size: 2 },
      },
      textures: { texTexture: { textureId } },
      count: 36,
    })
    renderer.frame((_ctx, record) => record(command))
    renderer.step(16)

    expect(calls).toContain(`ensurePipeline(1, [3x3x2], tex)`)
    const pipelineAt = calls.indexOf('usePipeline(1)')
    const bindAt = calls.indexOf(`bindTexture(${textureId})`)
    const drawAt = calls.findIndex(call => call.startsWith('draw(36,1)'))
    expect(pipelineAt).toBeGreaterThanOrEqual(0)
    expect(bindAt).toBeGreaterThan(pipelineAt) // texture after the pipeline
    expect(drawAt).toBeGreaterThan(bindAt)     // and before draw
    renderer.stop()
  })

  it('ensurePipeline exactly once per command (lazily, without re-creation)', async () => {
    const { gpu, calls } = createRecordingGPU()
    const renderer = await createWebGpuRenderer({
      canvas: fakeCanvas(),
      createGPU: async () => gpu,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    const command = renderer.command({
      shader: { wgsl: WGSL_TEX },
      uniforms: { u_mvp: () => IDENTITY },
      attributes: { inPos: { data: new Float32Array(9), size: 3 } },
      textures: { texTexture: { textureId: 1 } },
      count: 3,
    })
    renderer.frame((_ctx, record) => record(command))
    renderer.step(16)
    renderer.step(32)
    expect(calls.filter(call => call.startsWith('ensurePipeline(')).length).toBe(1)
    renderer.stop()
  })
})
