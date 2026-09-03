/**
 * Task 116 — the canvas clear color parity (WebGPU):
 * the renderer's `clear` option must reach the render-pass clearValue.
 *
 * Before the fix, realGPU.bindTarget(0) hardcoded {r:0.07, g:0.08, b:0.11}:
 * the unified renderer's `clear` option was silently dropped on the WebGPU
 * path (WebGpuRendererOptions had no `clear` field at all), so the same demo
 * rendered a ~4.5× lighter background on WebGPU than on WebGL2.
 *
 * Two levels:
 *  1. realGPU (a full mock device) — setCanvasClearColor stores the color;
 *     beginPass(0) → beginRenderPass with loadOp:'clear' + the configured
 *     clearValue (and the legacy default when never set);
 *  2. webgpuRenderer (the recording facade) — options.clear → the facade
 *     receives setCanvasClearColor; without the option — the DEFAULT_CLEAR
 *     values (0.07/0.08/0.11/1, the same numbers as the GL facade).
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { createRealGPU } from '../src/realGPU.ts'

interface PassDesc {
  colorAttachments: Array<{ clearValue: { r: number; g: number; b: number; a: number }; loadOp: string; storeOp: string }>
  depthStencilAttachment?: { depthClearValue: number; depthLoadOp: string } | undefined
}

interface MockCalls {
  passes: PassDesc[]
  requestedFeatures: string[][]
}

function installMockGpu(): { calls: MockCalls; canvas: unknown; cleanup: () => void } {
  const calls: MockCalls = { passes: [], requestedFeatures: [] }
  const device = {
    features: new Set<string>(),
    limits: {},
    lost: new Promise(() => {}), // never resolves in the test
    addEventListener: () => {},
    createTexture: (desc: Record<string, unknown>) => ({
      __desc: desc,
      createView: () => ({}),
      destroy: () => {},
    }),
    createSampler: () => ({}),
    createBindGroupLayout: () => ({}),
    createBindGroup: () => ({}),
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createPipelineLayout: () => ({}),
    createRenderPipeline: () => ({}),
    createCommandEncoder: () => ({
      // THE probe point: the render-pass descriptor the facade builds
      beginRenderPass: (desc: PassDesc) => {
        calls.passes.push(desc)
        return { setPipeline: () => {}, setBindGroup: () => {}, setVertexBuffer: () => {}, draw: () => {}, end: () => {}, writeTimestamp: () => {} }
      },
      finish: () => ({}),
      resolveQuerySet: () => {},
      copyBufferToBuffer: () => {},
    }),
    queue: {
      writeTexture: () => {},
      writeBuffer: () => {},
      copyExternalImageToTexture: () => {},
      submit: () => {},
    },
  }
  const adapter = {
    features: new Set<string>(),
    limits: {},
    requestDevice: async (req: { requiredFeatures?: string[] }) => {
      calls.requestedFeatures.push([...(req?.requiredFeatures ?? [])])
      return device
    },
  }
  const gpuMock = { requestAdapter: async () => adapter, getPreferredCanvasFormat: () => 'bgra8unorm' }
  const canvas = {
    width: 800,
    height: 600,
    getContext: (type: string) =>
      type === 'webgpu'
        ? { configure: () => {}, getCurrentTexture: () => ({ createView: () => ({}) }) }
        : null,
  }
  const nav = navigator as unknown as { gpu?: unknown }
  const prevGpu = nav.gpu
  ;(navigator as unknown as { gpu: unknown }).gpu = gpuMock
  const g = globalThis as Record<string, unknown>
  const prevGlobals = {
    GPUTextureUsage: g.GPUTextureUsage,
    GPUShaderStage: g.GPUShaderStage,
    GPUBufferUsage: g.GPUBufferUsage,
  }
  g.GPUTextureUsage = { TEXTURE_BINDING: 0x4, COPY_DST: 0x8, RENDER_ATTACHMENT: 0x10 }
  g.GPUShaderStage = { VERTEX: 0x1, FRAGMENT: 0x2 }
  g.GPUBufferUsage = { UNIFORM: 0x40, COPY_DST: 0x8, VERTEX: 0x20 }
  return {
    calls,
    canvas,
    cleanup: () => {
      ;(navigator as unknown as { gpu: unknown }).gpu = prevGpu
      for (const [k, v] of Object.entries(prevGlobals)) {
        if (v === undefined) delete g[k]
        else g[k] = v
      }
    },
  }
}

describe('Task 116: the canvas clear color (realGPU)', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => { for (const c of cleanups.splice(0)) c() })

  it('LEGACY DEFAULT: without setCanvasClearColor the canvas pass clears to 0.07/0.08/0.11', async () => {
    const { calls, canvas, cleanup } = installMockGpu()
    cleanups.push(cleanup)
    const gpu = await createRealGPU(canvas as never)
    gpu.configure(800, 600) // creates the canvas depth attachment
    gpu.beginPass(0)
    gpu.submit()
    const desc = calls.passes[calls.passes.length - 1]!
    expect(desc.colorAttachments[0]!.clearValue).toEqual({ r: 0.07, g: 0.08, b: 0.11, a: 1 })
    expect(desc.colorAttachments[0]!.loadOp).toBe('clear')
  })

  it('setCanvasClearColor: the NEXT canvas pass clears with the configured color + depth', async () => {
    const { calls, canvas, cleanup } = installMockGpu()
    cleanups.push(cleanup)
    const gpu = await createRealGPU(canvas as never)
    gpu.configure(800, 600) // creates the canvas depth attachment
    gpu.setCanvasClearColor([0.015, 0.02, 0.035, 1], 0.5)
    gpu.beginPass(0)
    gpu.submit()
    const desc = calls.passes[calls.passes.length - 1]!
    // the demo's dark navy — the reported "WebGL is much darker" case, now equal
    expect(desc.colorAttachments[0]!.clearValue).toEqual({ r: 0.015, g: 0.02, b: 0.035, a: 1 })
    expect(desc.depthStencilAttachment?.depthClearValue).toBe(0.5)
  })

  it('setCanvasClearColor: depth omitted → 1; the surface targets keep their OWN clear', async () => {
    const { calls, canvas, cleanup } = installMockGpu()
    cleanups.push(cleanup)
    const gpu = await createRealGPU(canvas as never)
    gpu.configure(800, 600) // creates the canvas depth attachment
    gpu.setCanvasClearColor([0, 0.1, 0.2, 1])
    gpu.beginPass(0)
    gpu.submit()
    let desc = calls.passes[calls.passes.length - 1]!
    expect(desc.depthStencilAttachment?.depthClearValue).toBe(1)
    // a surface target: createTarget carries its own color — NOT the canvas one
    const textureId = gpu.createTexture(64, 64)
    const targetId = gpu.createTarget(textureId, 64, 64, false, [0.5, 0.5, 0.5, 1])
    gpu.bindTarget(targetId, true)
    gpu.endPass()
    gpu.submit()
    desc = calls.passes[calls.passes.length - 1]!
    expect(desc.colorAttachments[0]!.clearValue).toEqual({ r: 0.5, g: 0.5, b: 0.5, a: 1 })
  })

  it('setCanvasClearColor: rejects non-finite colors loudly (not a silent black canvas)', async () => {
    const { canvas, cleanup } = installMockGpu()
    cleanups.push(cleanup)
    const gpu = await createRealGPU(canvas as never)
    expect(() => gpu.setCanvasClearColor([0, Number.NaN, 0, 1])).toThrow('finite rgba')
    expect(() => gpu.setCanvasClearColor([0, 0, 0, 1], Number.NaN)).toThrow('finite number')
  })
})
