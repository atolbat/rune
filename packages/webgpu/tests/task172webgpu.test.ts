/**
 * Task 172 — THE DEPTH-LESS PASS AXIS (the astral field report: the storm
 * pause on Chrome 150 / WebGPU):
 *
 *   «Attachment state of [RenderPipeline] is not compatible with
 *    [RenderPassEncoder]. RenderPassEncoder expects { colorTargets:
 *    [RGBA8Unorm], sampleCount: 1 }. RenderPipeline has { ...,
 *    depthStencilFormat: Depth24Plus }»
 *
 * The post-processing chain renders the whole scene into a surface created
 * with depth:false — a render pass with NO depth attachment — while every
 * pipeline unconditionally declared depthStencil: depth24plus (the Task-75
 * "the canvas pass ALWAYS carries depth" assumption). Chrome 150's Dawn
 * validates pipeline-vs-pass depth compatibility → three errors → the storm
 * pause. The container's older Dawn does not run this validation, which is
 * why the Task-169 gate stayed green while the phone died — the bug class is
 * only visible as a DESCRIPTOR mismatch, so these tests pin the descriptors
 * the facade sends to device.createRenderPipeline against the pass state.
 *
 * The fix: pipelines carry a per-DEPTH-PRESENCE variant (× the Task-69
 * sampleType variants), chosen at bind time from the CURRENT pass:
 *   • a pass WITH a depth attachment (the canvas after configure, a
 *     depth:true target) binds the depth-carrying twin;
 *   • a DEPTH-LESS pass binds a twin with NO depthStencil at all;
 *   • both twins are lazy per pipeline — the eager build stays the
 *     depth-carrying 'float' (the canvas default);
 *   • switching targets re-binds the right twin (the pass boundary resets
 *     the current pipeline), and re-entering the same pass kind reuses the
 *     cached twin (exactly TWO createRenderPipeline calls for one shader
 *     used in both pass kinds).
 *
 * All pins run on the unfilterableBind mock pattern: a full mock
 * navigator.gpu/device recording createRenderPipeline descriptors and the
 * pass's setPipeline identity.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { createRealGPU } from '../src/realGPU.ts'

/** Minimal WGSL with one texture (the composite-style command shape). */
const WGSL = `
@group(0) @binding(0) var<uniform> params : vec4<f32>;
@group(1) @binding(0) var texSampler : sampler;
@group(1) @binding(1) var texTexture : texture_2d<f32>;
struct VSOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> }
@vertex fn vsMain(@location(0) p : vec2<f32>, @location(1) uv : vec2<f32>) -> VSOut {
  var o : VSOut; o.uv = uv; o.pos = vec4<f32>(p, 0.0, 1.0); return o;
}
@fragment fn fsMain(in : VSOut) -> @location(0) vec4<f32> {
  return textureSample(texTexture, texSampler, in.uv);
}`

interface MockCalls {
  renderPipelines: Array<{ pipelineId: number; depthStencil?: { format?: string; depthWriteEnabled?: boolean; depthCompare?: string } }>
  passSetPipeline: unknown[]
  passBound: Array<{ depthStencilAttachment: unknown }>
}

function installMockGpu(): { calls: MockCalls; canvas: unknown; cleanup: () => void } {
  const calls: MockCalls = {
    renderPipelines: [],
    passSetPipeline: [],
    passBound: [],
  }
  let nextId = 1
  const id = (): number => nextId++

  const device = {
    features: new Set<string>(),
    limits: {},
    lost: new Promise(() => {}),
    addEventListener: () => {},
    createTexture: () => ({
      createView: () => ({ viewId: id() }),
      destroy: () => {},
    }),
    createSampler: () => ({}),
    createBindGroupLayout: () => ({}),
    createBindGroup: () => ({}),
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createPipelineLayout: () => ({}),
    createRenderPipeline: (desc: { depthStencil?: { format?: string; depthWriteEnabled?: boolean; depthCompare?: string } }) => {
      const p = { pipelineId: id(), depthStencil: desc.depthStencil }
      calls.renderPipelines.push(p)
      return p
    },
    createBuffer: () => ({ destroy: () => {} }),
    createCommandEncoder: () => ({
      beginRenderPass: (desc: { depthStencilAttachment?: unknown }) => {
        calls.passBound.push({ depthStencilAttachment: desc.depthStencilAttachment })
        return {
          setPipeline: (p: unknown) => calls.passSetPipeline.push(p),
          setBindGroup: () => {},
          setVertexBuffer: () => {},
          draw: () => {},
          end: () => {},
          writeTimestamp: () => {},
        }
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
    requestDevice: async () => device,
  }
  const gpuMock = {
    requestAdapter: async () => adapter,
    getPreferredCanvasFormat: () => 'bgra8unorm',
  }
  const canvas = {
    width: 800,
    height: 600,
    getContext: (type: string) =>
      type === 'webgpu'
        ? { configure: () => {}, getCurrentTexture: () => ({ createView: () => ({ canvasViewId: id() }) }) }
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

describe('Task 172: the depth-less pass binds depth-less pipelines (the storm-pause fix)', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => { for (const c of cleanups.splice(0)) c() })

  it('a depth-less target: the bound pipeline declares NO depthStencil (the pass has none)', async () => {
    const { calls, canvas, cleanup } = installMockGpu()
    cleanups.push(cleanup)
    const gpu = await createRealGPU(canvas as never)
    const tex = gpu.createTexture(64, 64)
    // depth:false — the post chain's scene surface
    const target = gpu.createTarget(tex, 64, 64, false, [0, 0, 0, 1])
    gpu.bindTexture(tex)
    gpu.bindTarget(target, true)
    expect(calls.passBound[calls.passBound.length - 1]!.depthStencilAttachment).toBeUndefined()
    // bind a command into the pass
    gpu.ensurePipeline(1, WGSL, [2, 2], true, { depth: false })
    gpu.usePipeline(1)
    gpu.bindUniforms(0)
    gpu.bindTexture(tex)
    gpu.draw(3, 1)
    // exactly TWO pipelines exist: the eager float+depth twin (the canvas
    // default) and the lazily-built depth-less twin; the LAST one set on
    // the pass is the depth-less one
    expect(calls.renderPipelines.length).toBe(2)
    const depthless = calls.renderPipelines.find(p => p.depthStencil === undefined)
    const withDepth = calls.renderPipelines.find(p => p.depthStencil !== undefined)
    expect(depthless).toBeDefined()
    expect(withDepth).toBeDefined()
    expect((withDepth!.depthStencil as { format?: string }).format).toBe('depth24plus')
    expect(calls.passSetPipeline[calls.passSetPipeline.length - 1]).toBe(depthless)
  })

  it('the same pipeline back on the canvas (depth attachment) re-binds the depth-carrying twin — no third build', async () => {
    const { calls, canvas, cleanup } = installMockGpu()
    cleanups.push(cleanup)
    const gpu = await createRealGPU(canvas as never)
    const tex = gpu.createTexture(64, 64)
    gpu.ensurePipeline(1, WGSL, [2, 2], true, { depth: false })
    // pass 1: the depth-less target
    const target = gpu.createTarget(tex, 64, 64, false, [0, 0, 0, 1])
    gpu.bindTarget(target, true)
    gpu.usePipeline(1)
    gpu.bindTexture(tex)
    gpu.draw(3, 1)
    // pass 2: the canvas (configure gives it a depth attachment)
    gpu.configure(800, 600)
    gpu.bindTarget(0, true)
    expect(calls.passBound[calls.passBound.length - 1]!.depthStencilAttachment).toBeDefined()
    gpu.usePipeline(1)
    gpu.bindTexture(tex)
    gpu.draw(3, 1)
    // still exactly two pipelines: the twins are cached per pipeline record
    expect(calls.renderPipelines.length).toBe(2)
    const withDepth = calls.renderPipelines.find(p => p.depthStencil !== undefined)!
    expect((withDepth.depthStencil as { format?: string }).format).toBe('depth24plus')
    // the last setPipeline on the pass is the depth-carrying twin
    expect(calls.passSetPipeline[calls.passSetPipeline.length - 1]).toBe(withDepth)
  })

  it('a depth:true target binds the depth-carrying twin; re-entering the depth-less target reuses its twin', async () => {
    const { calls, canvas, cleanup } = installMockGpu()
    cleanups.push(cleanup)
    const gpu = await createRealGPU(canvas as never)
    const tex = gpu.createTexture(64, 64)
    gpu.ensurePipeline(1, WGSL, [2, 2], true, { depth: false })
    const flat = gpu.createTarget(tex, 64, 64, false, [0, 0, 0, 1])
    const deep = gpu.createTarget(tex, 64, 64, true, [0, 0, 0, 1])

    // flat pass → depth-less twin
    gpu.bindTarget(flat, true)
    gpu.usePipeline(1)
    gpu.bindTexture(tex)
    gpu.draw(3, 1)
    // deep pass → depth twin
    gpu.bindTarget(deep, true)
    expect(calls.passBound[calls.passBound.length - 1]!.depthStencilAttachment).toBeDefined()
    gpu.usePipeline(1)
    gpu.bindTexture(tex)
    gpu.draw(3, 1)
    // flat AGAIN → the cached depth-less twin, no new build
    gpu.bindTarget(flat, true)
    gpu.usePipeline(1)
    gpu.bindTexture(tex)
    gpu.draw(3, 1)

    expect(calls.renderPipelines.length).toBe(2)
    const setPipelines = calls.passSetPipeline
    // three pass binds — flat, deep, flat — ending on the depth-less twin
    const depthless = calls.renderPipelines.find(p => p.depthStencil === undefined)!
    const withDepth = calls.renderPipelines.find(p => p.depthStencil !== undefined)!
    expect(setPipelines[setPipelines.length - 3]).toBe(depthless)
    expect(setPipelines[setPipelines.length - 2]).toBe(withDepth)
    expect(setPipelines[setPipelines.length - 1]).toBe(depthless)
  })

  it('a depth-enabled desc in a depth pass keeps write/test from the descriptor', async () => {
    const { calls, canvas, cleanup } = installMockGpu()
    cleanups.push(cleanup)
    const gpu = await createRealGPU(canvas as never)
    const tex = gpu.createTexture(64, 64)
    // depth: { test: 'lequal', write: true } — an honest depth pipeline
    gpu.ensurePipeline(1, WGSL, [2, 2], true, { depth: { test: 'lequal', write: true } })
    gpu.configure(800, 600)
    gpu.bindTarget(0, true)
    gpu.usePipeline(1)
    gpu.bindTexture(tex)
    gpu.draw(3, 1)
    const withDepth = calls.renderPipelines.find(p => p.depthStencil !== undefined)
    expect(withDepth).toBeDefined()
    expect((withDepth!.depthStencil as { depthWriteEnabled?: boolean }).depthWriteEnabled).toBe(true)
    expect((withDepth!.depthStencil as { depthCompare?: string }).depthCompare).toBe('less-equal')
  })
})
