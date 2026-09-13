/**
 * Task 196 — the Hi-Z occlusion-culling contract extensions:
 *
 *   1. COMPUTE TEXTURE SLOTS: createCompute's optional fourth argument
 *      appends read-only texture bindings at slots 6.. of the family's ONE
 *      bind group — 'sampled' (texture_2d<f32>, unfilterable-float) and
 *      'depth' (texture_depth_2d); a sub-range view comes from
 *      baseMipLevel/mipLevelCount, the full view otherwise; a missing
 *      texture and a 'depth' kind on a color texture are LOUD errors
 *      (onGpuError, -1), never a silent unbound slot;
 *   2. THE GPU-DRIVEN DRAWS: drawIndexedIndirect/drawIndirect ride the
 *      current pass with the external buffer + byte offset; a buffer
 *      without INDIRECT usage is a loud early error (the caller owns the
 *      usage flags), and a missing buffer the same;
 *   3. THE TARGET-FORMAT AXIS: a pipeline drawn into an r32float target
 *      (the Hi-Z z-prepass tile) is BUILT with that fragment target format
 *      — pre-196 every pipeline was built for the canvas format, a latent
 *      Dawn validation bug for any non-canvas-format target; variants are
 *      cached per (sampleType × depth × format), re-entering a format
 *      reuses its twin;
 *   4. DEPTH TEXTURES: createTexture with a depth format drops COPY_DST
 *      (spec-forbidden for the depth family) — a depth source can exist
 *      through the facade now.
 *
 * All real-level pins run on the installMockGpu pattern (uboWindow /
 * task172): a mock navigator.gpu/device recording bind-group layouts,
 * bind groups, render-pipeline descriptors, texture usages and the pass's
 * indirect draws.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { createRealGPU } from '../src/realGPU.ts'
import { createRecordingGPU } from '../src/recordingGPU.ts'

/** A plain one-output shader (no textures, no storage) for pipeline pins. */
const WGSL_PLAIN = `
struct Params { u_mvp: mat4x4<f32> }
@group(0) @binding(0) var<uniform> params: Params;
@vertex fn vsMain(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
  return params.u_mvp * vec4<f32>(position, 1.0);
}
@fragment fn fsMain() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }`

interface MockCalls {
  textures: Array<{ size: number[]; format: string; usage: number; mipLevelCount?: number }>
  views: Array<{ viewId: number; descriptor?: { baseMipLevel?: number; mipLevelCount?: number } }>
  bindGroupLayouts: Array<{ entries: Array<{ binding: number; visibility?: number; buffer?: { type: string }; texture?: { sampleType: string } }> }>
  bindGroups: Array<{ entries: Array<{ binding: number; resource: unknown }> }>
  renderPipelines: Array<{ fragment: { targets: Array<{ format: string }> }; depthStencil?: unknown }>
  passDrawIndexedIndirect: Array<[unknown, number]>
  passDrawIndirect: Array<[unknown, number]>
  computePipelines: number[]
  errors: string[]
}

function installMockGpu(): { calls: MockCalls; canvas: unknown; cleanup: () => void } {
  const calls: MockCalls = {
    textures: [], views: [], bindGroupLayouts: [], bindGroups: [],
    renderPipelines: [], passDrawIndexedIndirect: [], passDrawIndirect: [],
    computePipelines: [], errors: [],
  }
  let nextId = 1
  const id = (): number => nextId++

  const device = {
    features: new Set<string>(),
    limits: {},
    lost: new Promise(() => {}),
    addEventListener: () => {},
    createBuffer: (desc: { size: number; usage: number }) => {
      const buffer = { bufferId: id(), ...desc, destroy: () => {} }
      return buffer
    },
    createTexture: (desc: { size: number[]; format: string; usage: number; mipLevelCount?: number }) => {
      calls.textures.push({ size: desc.size, format: desc.format, usage: desc.usage, mipLevelCount: desc.mipLevelCount })
      const texture = {
        textureId: id(),
        createView: (descriptor?: { baseMipLevel?: number; mipLevelCount?: number }) => {
          const view = { viewId: id(), textureId: texture.textureId, descriptor }
          calls.views.push(view)
          return view
        },
        destroy: () => {},
      }
      return texture
    },
    createSampler: () => ({ samplerId: id() }),
    createBindGroupLayout: (desc: { entries: Array<{ binding: number; visibility?: number; buffer?: { type: string }; texture?: { sampleType: string } }> }) => {
      const bgl = { bglId: id(), ...desc }
      calls.bindGroupLayouts.push(bgl)
      return bgl
    },
    createBindGroup: (desc: { layout: unknown; entries: Array<{ binding: number; resource: unknown }> }) => {
      const bg = { bgId: id(), ...desc }
      calls.bindGroups.push(bg)
      return bg
    },
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createPipelineLayout: () => ({ plId: id() }),
    createRenderPipeline: (desc: { fragment: { targets: Array<{ format: string }> }; depthStencil?: unknown }) => {
      const p = { pipelineId: id(), fragment: desc.fragment, depthStencil: desc.depthStencil }
      calls.renderPipelines.push(p)
      return p
    },
    createComputePipeline: () => {
      const p = { computePipelineId: id() }
      calls.computePipelines.push(p.computePipelineId)
      return p
    },
    createCommandEncoder: () => ({
      beginRenderPass: (_desc: unknown) => ({
        setPipeline: () => {},
        setBindGroup: () => {},
        setVertexBuffer: () => {},
        setIndexBuffer: () => {},
        draw: () => {},
        drawIndexed: () => {},
        drawIndexedIndirect: (buffer: unknown, offset: number) => calls.passDrawIndexedIndirect.push([buffer, offset]),
        drawIndirect: (buffer: unknown, offset: number) => calls.passDrawIndirect.push([buffer, offset]),
        end: () => {},
        writeTimestamp: () => {},
      }),
      beginComputePass: () => ({
        setPipeline: () => {},
        setBindGroup: () => {},
        dispatchWorkgroups: () => {},
        end: () => {},
      }),
      finish: () => ({}),
      resolveQuerySet: () => {},
      copyBufferToBuffer: () => {},
      copyTextureToBuffer: () => {},
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
  g.GPUTextureUsage = { COPY_SRC: 0x2, COPY_DST: 0x8, TEXTURE_BINDING: 0x4, RENDER_ATTACHMENT: 0x10 }
  g.GPUShaderStage = { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 }
  g.GPUBufferUsage = { COPY_SRC: 0x4, COPY_DST: 0x8, VERTEX: 0x20, UNIFORM: 0x40, STORAGE: 0x80, INDIRECT: 0x100 }
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

const CLEANUPS: Array<() => void> = []
afterEach(() => { for (const c of CLEANUPS.splice(0)) c() })

describe('Task 196: compute family texture slots', () => {
  it('a sampled texture lands at binding 6 with unfilterable-float, view included', async () => {
    const { calls, canvas, cleanup } = installMockGpu()
    CLEANUPS.push(cleanup)
    const errors: string[] = []
    const gpu = await createRealGPU(canvas as never, m => errors.push(m))
    const zTex = gpu.createTexture(64, 32, 'r32float')
    const buf = gpu.createExternalBuffer(1024, 0x80) // STORAGE
    const computeId = gpu.createCompute('// wgsl', 16, [buf], [{ kind: 'sampled', textureId: zTex }])
    expect(computeId).toBeGreaterThan(0)
    expect(errors).toEqual([])
    // the LAST bind-group layout: uniform@0, storage@1, texture@6
    const bgl = calls.bindGroupLayouts[calls.bindGroupLayouts.length - 1]!
    const bindings = bgl.entries.map(e => e.binding)
    expect(bindings).toEqual([0, 1, 6])
    const texEntry = bgl.entries.find(e => e.binding === 6)!
    expect(texEntry.texture?.sampleType).toBe('unfilterable-float')
    // the bind group carries the texture's FULL view (textureLoad's level
    // argument is dynamic — the cull kernel picks the mip per instance)
    const bg = calls.bindGroups[calls.bindGroups.length - 1]!
    const resource = bg.entries.find(e => e.binding === 6)!.resource
    expect((resource as { viewId?: number }).viewId).toBeDefined()
    expect((resource as { descriptor?: unknown }).descriptor).toBeUndefined()
  })

  it('a sub-range view: baseMipLevel/mipLevelCount create the restricted view', async () => {
    const { calls, canvas, cleanup } = installMockGpu()
    CLEANUPS.push(cleanup)
    const gpu = await createRealGPU(canvas as never)
    const tex = gpu.createTexture(64, 64, 'rgba8unorm')
    gpu.createExternalBuffer(64, 0x80)
    gpu.createCompute('// wgsl', 16, [], [{ kind: 'sampled', textureId: tex, baseMipLevel: 2, mipLevelCount: 3 }])
    const bg = calls.bindGroups[calls.bindGroups.length - 1]!
    const resource = bg.entries.find(e => e.binding === 6)!.resource as { descriptor?: { baseMipLevel?: number; mipLevelCount?: number } }
    expect(resource.descriptor).toEqual({ baseMipLevel: 2, mipLevelCount: 3 })
  })

  it('a depth texture lands with sampleType depth; createTexture drops COPY_DST for depth formats', async () => {
    const { calls, canvas, cleanup } = installMockGpu()
    CLEANUPS.push(cleanup)
    const gpu = await createRealGPU(canvas as never)
    const depthTex = gpu.createTexture(64, 64, 'depth32float')
    // spec: COPY_DST is forbidden for the depth family — the facade's
    // createTexture conditionally drops it (a depth source can exist now)
    const depthTexDesc = calls.textures[calls.textures.length - 1]!
    expect(depthTexDesc.usage & 0x8).toBe(0) // no COPY_DST
    expect(depthTexDesc.usage & 0x4).toBe(0x4) // TEXTURE_BINDING stays
    expect(depthTexDesc.usage & 0x10).toBe(0x10) // RENDER_ATTACHMENT stays
    // a color texture keeps the full pre-196 set
    gpu.createTexture(64, 64, 'r32float')
    const colorTexDesc = calls.textures[calls.textures.length - 1]!
    expect(colorTexDesc.usage & 0x8).toBe(0x8) // COPY_DST present
    // the depth kind binds as texture_depth_2d
    const buf = gpu.createExternalBuffer(64, 0x80)
    gpu.createCompute('// wgsl', 16, [buf], [{ kind: 'depth', textureId: depthTex }])
    const bgl = calls.bindGroupLayouts[calls.bindGroupLayouts.length - 1]!
    expect(bgl.entries.find(e => e.binding === 6)!.texture?.sampleType).toBe('depth')
  })

  it('a missing texture and a depth kind on a color texture are LOUD errors (createCompute → -1)', async () => {
    const { canvas, cleanup } = installMockGpu()
    CLEANUPS.push(cleanup)
    const errors: string[] = []
    const gpu = await createRealGPU(canvas as never, m => errors.push(m))
    const buf = gpu.createExternalBuffer(64, 0x80)
    const missing = gpu.createCompute('// wgsl', 16, [buf], [{ kind: 'sampled', textureId: 999 }])
    expect(missing).toBe(-1)
    expect(errors.some(e => e.includes('no texture 999'))).toBe(true)
    errors.length = 0
    const colorTex = gpu.createTexture(64, 64, 'r32float')
    const wrongKind = gpu.createCompute('// wgsl', 16, [buf], [{ kind: 'depth', textureId: colorTex }])
    expect(wrongKind).toBe(-1)
    expect(errors.some(e => e.includes("kind 'depth' needs a depth-format texture"))).toBe(true)
  })
})

describe('Task 196: the GPU-driven indirect draws', () => {
  it('drawIndexedIndirect rides the current pass with the external buffer + offset', async () => {
    const { calls, canvas, cleanup } = installMockGpu()
    CLEANUPS.push(cleanup)
    const errors: string[] = []
    const gpu = await createRealGPU(canvas as never, m => errors.push(m))
    const args = gpu.createExternalBuffer(64, 0x80 | 0x100) // STORAGE | INDIRECT
    const tex = gpu.createTexture(64, 64, 'canvas')
    const target = gpu.createTarget(tex, 64, 64, true, [0, 0, 0, 1])
    gpu.bindTarget(target, true)
    gpu.ensurePipeline(1, WGSL_PLAIN, [3], false, {})
    gpu.usePipeline(1)
    gpu.drawIndexedIndirect(args, 20)
    expect(errors).toEqual([])
    expect(calls.passDrawIndexedIndirect.length).toBe(1)
    const [buffer, offset] = calls.passDrawIndexedIndirect[0]!
    expect(offset).toBe(20)
    expect((buffer as { size: number }).size).toBe(64)
    gpu.drawIndirect(args, 0)
    expect(calls.passDrawIndirect.length).toBe(1)
    expect(calls.passDrawIndirect[0]![1]).toBe(0)
  })

  it('a buffer without INDIRECT usage is a loud early error — no pass call', async () => {
    const { calls, canvas, cleanup } = installMockGpu()
    CLEANUPS.push(cleanup)
    const errors: string[] = []
    const gpu = await createRealGPU(canvas as never, m => errors.push(m))
    const storageOnly = gpu.createExternalBuffer(64, 0x80) // STORAGE, no INDIRECT
    gpu.beginPass(0)
    gpu.drawIndexedIndirect(storageOnly, 0)
    expect(calls.passDrawIndexedIndirect.length).toBe(0)
    expect(errors.some(e => e.includes('lacks INDIRECT usage'))).toBe(true)
    // a missing buffer — the same loud shape
    errors.length = 0
    gpu.drawIndirect(999, 0)
    expect(calls.passDrawIndirect.length).toBe(0)
    expect(errors.some(e => e.includes('no such external buffer'))).toBe(true)
  })
})

describe('Task 196: the target-format pipeline axis', () => {
  it('an r32float target builds its pipeline with the r32float fragment target', async () => {
    const { calls, canvas, cleanup } = installMockGpu()
    CLEANUPS.push(cleanup)
    const gpu = await createRealGPU(canvas as never)
    gpu.ensurePipeline(1, WGSL_PLAIN, [3], false, {})
    // the eager build: canvas format (bgra8unorm), with depth
    expect(calls.renderPipelines.length).toBe(1)
    expect(calls.renderPipelines[0]!.fragment.targets[0]!.format).toBe('bgra8unorm')
    // an r32float z-prepass target: the pipeline is built FOR it
    const zTex = gpu.createTexture(64, 64, 'r32float')
    const zTarget = gpu.createTarget(zTex, 64, 64, true, [1, 1, 1, 1])
    gpu.bindTarget(zTarget, true)
    gpu.usePipeline(1)
    gpu.draw(3, 1)
    expect(calls.renderPipelines.length).toBe(2)
    expect(calls.renderPipelines[1]!.fragment.targets[0]!.format).toBe('r32float')
    // back to the canvas: the eager twin serves, no third build
    gpu.configure(800, 600)
    gpu.bindTarget(0, true)
    gpu.usePipeline(1)
    gpu.draw(3, 1)
    expect(calls.renderPipelines.length).toBe(2)
    // re-entering the r32float target reuses its cached twin
    gpu.bindTarget(zTarget, true)
    gpu.usePipeline(1)
    gpu.draw(3, 1)
    expect(calls.renderPipelines.length).toBe(2)
    expect(calls.renderPipelines[1]!.fragment.targets[0]!.format).toBe('r32float')
  })
})

describe('Task 196: the recording facade records the new calls', () => {
  it('createCompute with textures, drawIndexedIndirect and drawIndirect land in the stream', () => {
    const { gpu, calls } = createRecordingGPU()
    gpu.createCompute('// wgsl', 16, [901, 902], [{ kind: 'sampled', textureId: 3 }])
    expect(calls).toContain('createCompute(16,901+902+tex:sampled@3)')
    gpu.drawIndexedIndirect(905, 20)
    expect(calls).toContain('drawIndexedIndirect(905,20)')
    gpu.drawIndirect(905)
    expect(calls).toContain('drawIndirect(905,0)')
  })
})
