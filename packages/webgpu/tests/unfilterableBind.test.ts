/**
 * Task 69: rgba32float without feature 'float32-filterable' — the bind group
 * and pipeline must use sampleType 'unfilterable-float' + sampler
 * 'non-filtering'. The hardcoded 'float' produced a CreateBindGroup
 * validation error:
 * "None of the supported sample types (UnfilterableFloat) of
 * [Texture RGBA32Float] match the expected sample types (Float)".
 *
 * Here — a full mock of navigator.gpu/device: we check the descriptors the
 * facade actually sends to device.createBindGroupLayout/createRenderPipeline/
 * createSampler, and the pipeline variant switch in bindTexture.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { createRealGPU } from '../src/realGPU.ts'

/** WGSL valid for BOTH sampleType variants (textureSampleLevel). */
const WGSL_LEVEL = `
@group(0) @binding(0) var<uniform> params : vec4<f32>;
@group(1) @binding(0) var s : sampler;
@group(1) @binding(1) var t : texture_2d<f32>;
struct VSOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> }
@vertex fn vsMain(@location(0) p : vec2<f32>, @location(1) uv : vec2<f32>) -> VSOut {
  var o : VSOut; o.uv = uv; o.pos = vec4<f32>(p, 0.0, 1.0); return o;
}
@fragment fn fsMain(in : VSOut) -> @location(0) vec4<f32> {
  return textureSampleLevel(t, s, in.uv, 0.0);
}`

/** WGSL with textureSample — NOT compatible with 'unfilterable-float' (diagnostics). */
const WGSL_SAMPLE = WGSL_LEVEL.replace('textureSampleLevel(t, s, in.uv, 0.0)', 'textureSample(t, s, in.uv)')

interface MockCalls {
  requestedFeatures: string[][]
  samplers: Array<{ magFilter?: string; minFilter?: string; mipmapFilter?: string }>
  bglLayouts: Array<{ bglId?: number; entries: Array<Record<string, unknown>> }>
  bindGroups: Array<{ bgId?: number; layout: unknown; entries: Array<{ binding: number; resource: unknown }> }>
  pipelineLayouts: Array<{ plId?: number; bindGroupLayouts: unknown[] }>
  renderPipelines: Array<{ pipelineId?: number; layout: unknown }>
  passSetPipeline: unknown[]
  passSetBindGroup: Array<[number, unknown]>
}

function installMockGpu(deviceFeatures: string[]): { calls: MockCalls; canvas: unknown; cleanup: () => void } {
  const calls: MockCalls = {
    requestedFeatures: [],
    samplers: [],
    bglLayouts: [],
    bindGroups: [],
    pipelineLayouts: [],
    renderPipelines: [],
    passSetPipeline: [],
    passSetBindGroup: [],
  }
  let nextId = 1
  const id = (): number => nextId++

  const device = {
    features: new Set(deviceFeatures),
    limits: {},
    lost: new Promise(() => {}), // never resolves in the test
    addEventListener: () => {},
    createTexture: (desc: Record<string, unknown>) => ({
      __desc: desc,
      createView: () => ({ viewId: id() }),
      destroy: () => {},
    }),
    createSampler: (desc: { magFilter?: string; minFilter?: string; mipmapFilter?: string }) => {
      calls.samplers.push(desc)
      return { samplerId: id() }
    },
    createBindGroupLayout: (desc: { entries: Array<Record<string, unknown>> }) => {
      const bgl = { bglId: id(), ...desc }
      calls.bglLayouts.push(bgl)
      return bgl
    },
    createBindGroup: (desc: { layout: unknown; entries: Array<{ binding: number; resource: unknown }> }) => {
      const bg = { bgId: id(), ...desc }
      calls.bindGroups.push(bg)
      return bg
    },
    createShaderModule: (_desc: { code: string }) => ({
      getCompilationInfo: async () => ({ messages: [] }),
    }),
    createPipelineLayout: (desc: { bindGroupLayouts: unknown[] }) => {
      const pl = { plId: id(), ...desc }
      calls.pipelineLayouts.push(pl)
      return pl
    },
    createRenderPipeline: (desc: { layout: unknown }) => {
      const p = { pipelineId: id(), ...desc }
      calls.renderPipelines.push(p)
      return p
    },
    createCommandEncoder: () => ({
      beginRenderPass: (_desc: unknown) => {
        const pass = {
          setPipeline: (p: unknown) => calls.passSetPipeline.push(p),
          setBindGroup: (index: number, group: unknown) => calls.passSetBindGroup.push([index, group]),
          setVertexBuffer: () => {},
          draw: () => {},
          end: () => {},
          writeTimestamp: () => {},
        }
        return pass
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
    features: new Set([...deviceFeatures, 'timestamp-query'.includes('never') ? '' : 'timestamp-query']),
    limits: {},
    requestDevice: async (req: { requiredFeatures?: string[] }) => {
      calls.requestedFeatures.push([...(req?.requiredFeatures ?? [])])
      return device
    },
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
  // WebGPU globals (Bun does not define them — the facade uses the
  // GPUTextureUsage/GPUShaderStage/GPUBufferUsage constants).
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

/** The sampleType of the BGL texture entry (binding 1); undefined — no texture entry (group 0). */
function sampleTypeOf(bgl: { entries: Array<Record<string, unknown>> }): string | undefined {
  const texEntry = bgl.entries.find(e => 'texture' in e)
  if (texEntry === undefined) return undefined
  return (texEntry.texture as { sampleType?: string }).sampleType
}

describe('Task 69: rgba32float without float32-filterable — unfilterable bind path', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => { for (const c of cleanups.splice(0)) c() })

  it('the feature is requested from the adapter if supported', async () => {
    const { calls, canvas, cleanup } = installMockGpu(['float32-filterable'])
    cleanups.push(cleanup)
    await createRealGPU(canvas as never)
    expect(calls.requestedFeatures[0]).toContain('float32-filterable')
  })

  it('without the feature: rgba32float → nearest sampler + unfilterable-float/non-filtering bind group', async () => {
    const { calls, canvas, cleanup } = installMockGpu([])
    cleanups.push(cleanup)
    const gpu = await createRealGPU(canvas as never)
    const tex = gpu.createTexture(256, 256, 'rgba32float')
    // the sampler degrades to nearest (all three filters)
    const sampler = calls.samplers[calls.samplers.length - 1]!
    expect(sampler.magFilter).toBe('nearest')
    expect(sampler.minFilter).toBe('nearest')
    // pipeline + texture bind + draw: bind-group layout with unfilterable-float.
    // Multi-texture contract: bindTexture ACCUMULATES bindings, the bind group
    // is fixed in draw() (single-texture commands — the previous group composition)
    gpu.ensurePipeline(1, WGSL_LEVEL, [2, 2], true)
    gpu.beginPass(0)
    gpu.usePipeline(1)
    gpu.bindTexture(tex)
    gpu.draw(3, 1)
    const unfilterableBgl = calls.bglLayouts.find(b => sampleTypeOf(b) === 'unfilterable-float')
    expect(unfilterableBgl).toBeDefined()
    const samplerEntry = unfilterableBgl!.entries.find(e => (e as { sampler?: unknown }).sampler !== undefined)
    expect((samplerEntry!.sampler as { type?: string }).type).toBe('non-filtering')
    // the bind group is built on ITS OWN layout with THE SAME sampleType/sampler
    // type (the bind-group layout and the pipeline layout are different
    // objects, but compatible)
    const bg = calls.bindGroups[calls.bindGroups.length - 1]!
    const bgEntries = (bg.layout as { entries: Array<Record<string, unknown>> }).entries
    const bgTex = bgEntries.find(e => 'texture' in e)!
    expect((bgTex.texture as { sampleType?: string }).sampleType).toBe('unfilterable-float')
    const bgSampler = bgEntries.find(e => 'sampler' in e)!
    expect((bgSampler.sampler as { type?: string }).type).toBe('non-filtering')
    expect(bg.entries[0]!.binding).toBe(0)
    expect(bg.entries[1]!.binding).toBe(1)
    // pipeline variant: TWO render pipelines created (float + unfilterable),
    // the pass switched to the variant with the unfilterable layout
    expect(calls.renderPipelines.length).toBe(2)
    const unfilterablePl = calls.pipelineLayouts.find(pl =>
      pl.bindGroupLayouts.some(b => sampleTypeOf(b as { entries: Array<Record<string, unknown>> }) === 'unfilterable-float'),
    )
    expect(unfilterablePl).toBeDefined()
    const unfilterablePipeline = calls.renderPipelines.find(p => p.layout === unfilterablePl)
    expect(unfilterablePipeline).toBeDefined()
    expect(calls.passSetPipeline[calls.passSetPipeline.length - 1]).toBe(unfilterablePipeline)
    expect(calls.passSetBindGroup.some(([i]) => i === 1)).toBe(true)
  })

  it('multi-textures: two binds before draw → ONE bind group with tex@1 and tex@2', async () => {
    const { calls, canvas, cleanup } = installMockGpu([])
    cleanups.push(cleanup)
    const gpu = await createRealGPU(canvas as never)
    const baseTex = gpu.createTexture(256, 256)
    const normalTex = gpu.createTexture(256, 256)
    // WGSL with TWO texture_2d in group 1 — the layout must provide bindings 1..2
    const wgsl2 = WGSL_LEVEL.replace(
      '@group(1) @binding(1) var t : texture_2d<f32>;',
      '@group(1) @binding(1) var t : texture_2d<f32>;\n@group(1) @binding(2) var n : texture_2d<f32>;',
    )
    gpu.ensurePipeline(7, wgsl2, [2, 2], true)
    gpu.beginPass(0)
    gpu.usePipeline(7)
    gpu.bindTexture(baseTex)
    gpu.bindTexture(normalTex)
    const bindGroupsBefore = calls.bindGroups.length
    gpu.draw(3, 1)
    // exactly ONE new bind group per draw (not one per bind)
    expect(calls.bindGroups.length).toBe(bindGroupsBefore + 1)
    const bg = calls.bindGroups[calls.bindGroups.length - 1]!
    expect(bg.entries).toHaveLength(3)
    expect(bg.entries.map(e => e.binding)).toEqual([0, 1, 2])
    // texture slots 1 and 2 — TWO different textures
    const textures = bg.entries.filter(e => (e.resource as { viewId?: number }).viewId !== undefined)
    expect(textures).toHaveLength(2)
    expect(textures[0]!.resource).not.toBe(textures[1]!.resource)
  })

  it('without the feature: rgba8unorm → the previous path (float + filtering, ONE pipeline)', async () => {
    const { calls, canvas, cleanup } = installMockGpu([])
    cleanups.push(cleanup)
    const gpu = await createRealGPU(canvas as never)
    const tex = gpu.createTexture(256, 256)
    const sampler = calls.samplers[calls.samplers.length - 1]!
    expect(sampler.magFilter).toBe('linear')
    gpu.ensurePipeline(1, WGSL_LEVEL, [2, 2], true)
    gpu.beginPass(0)
    gpu.usePipeline(1)
    gpu.bindTexture(tex)
    expect(calls.renderPipelines.length).toBe(1)
    const floatBgl = calls.bglLayouts.find(b => sampleTypeOf(b) === 'float')
    expect(floatBgl).toBeDefined()
    const samplerEntry = floatBgl!.entries.find(e => (e as { sampler?: unknown }).sampler !== undefined)
    expect((samplerEntry!.sampler as { type?: string }).type).toBe('filtering')
  })

  it('WITH the feature: rgba32float → LINEAR + sampleType float (no variants)', async () => {
    const { calls, canvas, cleanup } = installMockGpu(['float32-filterable'])
    cleanups.push(cleanup)
    const gpu = await createRealGPU(canvas as never)
    const tex = gpu.createTexture(256, 256, 'rgba32float')
    const sampler = calls.samplers[calls.samplers.length - 1]!
    expect(sampler.magFilter).toBe('linear')
    gpu.ensurePipeline(1, WGSL_LEVEL, [2, 2], true)
    gpu.beginPass(0)
    gpu.usePipeline(1)
    gpu.bindTexture(tex)
    expect(calls.renderPipelines.length).toBe(1)
    const bgl = calls.bglLayouts.find(b => sampleTypeOf(b) === 'float')
    expect(bgl).toBeDefined()
  })

  it('textureSample shader + unfilterable variant → proactive onGpuError diagnostics', async () => {
    const { calls, canvas, cleanup } = installMockGpu([])
    cleanups.push(cleanup)
    const errors: string[] = []
    const gpu = await createRealGPU(canvas as never, msg => errors.push(msg))
    const tex = gpu.createTexture(256, 256, 'rgba32float')
    gpu.ensurePipeline(1, WGSL_SAMPLE, [2, 2], true)
    gpu.beginPass(0)
    gpu.usePipeline(1)
    gpu.bindTexture(tex)
    expect(errors.some(m => m.includes('textureSample'))).toBe(true)
  })

  it('texture change within one pipeline: unfilterable → filterable switches the variant back', async () => {
    const { calls, canvas, cleanup } = installMockGpu([])
    cleanups.push(cleanup)
    const gpu = await createRealGPU(canvas as never)
    const tex32 = gpu.createTexture(256, 256, 'rgba32float')
    const tex8 = gpu.createTexture(256, 256)
    gpu.ensurePipeline(1, WGSL_LEVEL, [2, 2], true)
    gpu.beginPass(0)
    gpu.usePipeline(1)
    gpu.bindTexture(tex32)
    const unfilterablePl = calls.pipelineLayouts.find(pl =>
      pl.bindGroupLayouts.some(b => sampleTypeOf(b as { entries: Array<Record<string, unknown>> }) === 'unfilterable-float'),
    )
    const floatPl = calls.pipelineLayouts.find(pl =>
      pl.bindGroupLayouts.some(b => sampleTypeOf(b as { entries: Array<Record<string, unknown>> }) === 'float')
      && pl.bindGroupLayouts.length === 2,
    )
    expect(unfilterablePl).toBeDefined()
    expect(floatPl).toBeDefined()
    const pipelineOf = (pl: unknown) => calls.renderPipelines.find(p => p.layout === pl)
    expect(calls.passSetPipeline[calls.passSetPipeline.length - 1]).toBe(pipelineOf(unfilterablePl))
    // the next command binds a filterable one — the pipeline returns to 'float'
    gpu.usePipeline(1)
    gpu.bindTexture(tex8)
    expect(calls.passSetPipeline[calls.passSetPipeline.length - 1]).toBe(pipelineOf(floatPl))
  })
})
