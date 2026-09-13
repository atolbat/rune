/**
 * Task 198 — the canvas MSAA (the `antialias` option):
 *
 * WebGPU has no sampleCount on the canvas context's configure() — the only
 * spec shape for an antialiased canvas is a persistent 4x color texture +
 * 4x depth attachment with a resolveTarget into the canvas texture. These
 * tests pin the facade contract on the installMockGpu pattern (canvasClear's
 * twin):
 *   1. antialias: true → bindTarget(0) opens the pass with view = the 4x
 *      texture, resolveTarget = the canvas view, storeOp 'discard', and the
 *      4x depth attachment;
 *   2. the SAMPLE-COUNT pipeline axis: a pipeline first built for the 1x
 *      canvas and then used in the 4x pass builds a SECOND pipeline twin
 *      (multisample.count 4) — the variant cache keys on it;
 *   3. a 1x target (an r32float z-tile) in the SAME session keeps its own
 *      1x pass descriptor (no resolveTarget, storeOp 'store');
 *   4. resize() recreates the 4x twins at the new size;
 *   5. the default (no hints) is the historical 1x path, byte-shaped.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { createRealGPU } from '../src/realGPU.ts'

interface PassDesc {
  colorAttachments: Array<{ view: unknown; resolveTarget?: unknown; clearValue: { r: number; g: number; b: number; a: number }; loadOp: string; storeOp: string }>
  depthStencilAttachment?: { view: unknown; depthClearValue: number; depthLoadOp: string } | undefined
}

interface PipelineDesc {
  vertex: unknown
  fragment: unknown
  multisample?: { count: number } | undefined
}

interface MockCalls {
  passes: PassDesc[]
  textures: Array<{ size: number[]; format: string; sampleCount?: number; usage: number }>
  pipelines: PipelineDesc[]
}

/** The WGSL of the occlusion demo's color pass shape: one attribute slot,
 * a uniform block, no textures — enough to drive usePipeline + draws. */
const WGSL_PLAIN = `
struct Params { mvp: mat4x4<f32> }
@group(0) @binding(0) var<uniform> params: Params;
@vertex fn vsMain(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
  return params.mvp * vec4<f32>(position, 1.0);
}
@fragment fn fsMain() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }`

function installMockGpu(): { calls: MockCalls; canvas: { width: number; height: number; getContext: (type: string) => unknown; canvasTextureView: object }; cleanup: () => void } {
  const calls: MockCalls = { passes: [], textures: [], pipelines: [] }
  const canvasTextureView = { __canvas: true }
  const device = {
    features: new Set<string>(),
    limits: {},
    lost: new Promise(() => {}),
    addEventListener: () => {},
    createTexture: (desc: { size: number[]; format: string; sampleCount?: number; usage: number }) => {
      calls.textures.push({ size: [...desc.size], format: desc.format, sampleCount: desc.sampleCount, usage: desc.usage })
      return { __desc: desc, createView: () => ({ __of: desc }), destroy: () => {} }
    },
    createSampler: () => ({}),
    createBindGroupLayout: () => ({}),
    createBindGroup: () => ({}),
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createPipelineLayout: () => ({}),
    createRenderPipeline: (desc: PipelineDesc) => {
      calls.pipelines.push(desc)
      return { __pipeline: desc }
    },
    createCommandEncoder: () => ({
      beginRenderPass: (desc: PassDesc) => {
        calls.passes.push(desc)
        return { setPipeline: () => {}, setBindGroup: () => {}, setVertexBuffer: () => {}, draw: () => {}, drawIndexed: () => {}, end: () => {}, writeTimestamp: () => {} }
      },
      beginComputePass: () => ({ setPipeline: () => {}, setBindGroup: () => {}, dispatchWorkgroups: () => {}, end: () => {} }),
      finish: () => ({}),
      resolveQuerySet: () => {},
      copyBufferToBuffer: () => {},
      copyTextureToBuffer: () => {},
    }),
    queue: { writeTexture: () => {}, writeBuffer: () => {}, copyExternalImageToTexture: () => {}, submit: () => {} },
  }
  const adapter = {
    features: new Set<string>(),
    limits: {},
    requestDevice: async () => device,
  }
  const gpuMock = { requestAdapter: async () => adapter, getPreferredCanvasFormat: () => 'bgra8unorm' }
  const canvas = {
    width: 800,
    height: 600,
    getContext: (type: string) =>
      type === 'webgpu'
        ? { configure: () => {}, getCurrentTexture: () => ({ createView: () => canvasTextureView }) }
        : null,
    canvasTextureView,
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
  g.GPUBufferUsage = { UNIFORM: 0x40, COPY_DST: 0x8, VERTEX: 0x20, STORAGE: 0x80, INDIRECT: 0x100, COPY_SRC: 0x4, INDEX: 0x10 }
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

describe('Task 198: the canvas MSAA (realGPU)', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => { for (const c of cleanups.splice(0)) c() })

  it('antialias: bindTarget(0) resolves the 4x pass into the canvas', async () => {
    const { calls, canvas, cleanup } = installMockGpu()
    cleanups.push(cleanup)
    const gpu = await createRealGPU(canvas as never, undefined, undefined, { antialias: true })
    gpu.configure(800, 600)

    gpu.ensurePipeline(1, WGSL_PLAIN, [3], false)
    gpu.bindTarget(0, true)
    gpu.usePipeline(1)
    gpu.draw(3, 1)
    gpu.endPass()
    gpu.submit()

    // the 4x twins exist: color + depth, sampleCount 4, RENDER_ATTACHMENT
    const msaaColor = calls.textures.find(t => t.sampleCount === 4 && t.format === 'bgra8unorm')
    const msaaDepth = calls.textures.find(t => t.sampleCount === 4 && t.format === 'depth24plus')
    expect(msaaColor).toBeDefined()
    expect(msaaDepth).toBeDefined()

    const pass = calls.passes[0]
    expect(pass.colorAttachments[0].resolveTarget).toBe(canvas.canvasTextureView)
    expect(pass.colorAttachments[0].storeOp).toBe('discard')
    expect(pass.colorAttachments[0].view).not.toBe(canvas.canvasTextureView)
    expect(pass.depthStencilAttachment?.view).not.toBeUndefined()

    // the pipeline twin carries multisample.count 4
    const msaaPipeline = calls.pipelines.find(p => p.multisample?.count === 4)
    expect(msaaPipeline).toBeDefined()
  })

  it('a 1x target in the same session keeps the plain pass shape', async () => {
    const { calls, canvas, cleanup } = installMockGpu()
    cleanups.push(cleanup)
    const gpu = await createRealGPU(canvas as never, undefined, undefined, { antialias: true })
    gpu.configure(800, 600)

    const zTex = gpu.createTexture(64, 64, 'r32float')
    const zTarget = gpu.createTarget(zTex, 64, 64, true, [1, 1, 1, 1])
    gpu.ensurePipeline(1, WGSL_PLAIN, [3], false)
    gpu.bindTarget(zTarget, true)
    gpu.usePipeline(1)
    gpu.draw(3, 1)
    gpu.endPass()
    gpu.submit()

    const pass = calls.passes[0]
    expect(pass.colorAttachments[0].resolveTarget).toBeUndefined()
    expect(pass.colorAttachments[0].storeOp).toBe('store')
    // no 4x pipeline was built for the 1x pass
    expect(calls.pipelines.every(p => p.multisample === undefined)).toBe(true)
  })

  it('the default (no hints) stays the historical 1x canvas', async () => {
    const { calls, canvas, cleanup } = installMockGpu()
    cleanups.push(cleanup)
    const gpu = await createRealGPU(canvas as never)

    gpu.bindTarget(0, true)
    gpu.endPass()
    gpu.submit()

    expect(calls.passes[0].colorAttachments[0].view).toBe(canvas.canvasTextureView)
    expect(calls.passes[0].colorAttachments[0].resolveTarget).toBeUndefined()
    expect(calls.textures.every(t => t.sampleCount === undefined)).toBe(true)
  })

  it('resize() recreates the 4x twins at the new size', async () => {
    const { calls, canvas, cleanup } = installMockGpu()
    cleanups.push(cleanup)
    const gpu = await createRealGPU(canvas as never, undefined, undefined, { antialias: true })
    gpu.configure(800, 600)

    const at800 = calls.textures.filter(t => t.sampleCount === 4)
    expect(at800.every(t => t.size[0] === 800 && t.size[1] === 600)).toBe(true)

    gpu.resize(1024, 768)
    const at1024 = calls.textures.filter(t => t.sampleCount === 4 && t.size[0] === 1024)
    expect(at1024.length).toBe(2) // color + depth
    expect(at1024.every(t => t.size[1] === 768)).toBe(true)
  })
})
