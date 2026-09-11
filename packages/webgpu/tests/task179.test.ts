/**
 * Task 179 — the compute steady-state pass, round two (the dig-everywhere
 * program): the sort loop's dispatch stream pays for the PIPELINE re-bind
 * per dispatch, and the sort family grew a SIXTH binding (the network
 * clock). Pins:
 *
 *   1. THE COMPUTE PIPELINE MEMO — same-entry dispatches set the pipeline
 *      ONCE per compute pass (the sort loop's 171 bitonic dispatches: 1
 *      setPipeline, not 171); an entry switch re-asserts; a fresh pass
 *      re-asserts (the memo is pass-scoped, like the bind-group twin).
 *   2. THE SIX-BINDING LAYOUT — createCompute sizes the bind-group layout
 *      by the bufferIds it is handed: 4 buffers → the exact pre-179
 *      five-entry layout (1 rw / 2 ro / 3 rw / 4 ro); 5 buffers →
 *      binding 5 joins as rw storage (the sort family's NETWORK CLOCK).
 *      A bind group carries an entry for EVERY layout slot — the layout
 *      never declares more than it binds.
 *
 * All pins run on a recording mock device (the task164 pattern) with the
 * layout descs captured — entry counts and buffer types are observable.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { createRealGPU } from '../src/realGPU.ts'

interface LayoutDesc {
  entries: Array<{ binding: number; visibility: number; buffer: { type: string } }>
}

function installMockGpu(): {
  ops: string[]
  layouts: LayoutDesc[]
  canvas: HTMLCanvasElement
  cleanup: () => void
} {
  const ops: string[] = []
  const layouts: LayoutDesc[] = []
  let pipelineId = 0
  const device = {
    features: new Set<string>(),
    limits: {},
    lost: new Promise(() => {}),
    addEventListener: () => {},
    createTexture: (desc: Record<string, unknown>) => ({ __desc: desc, createView: () => ({}), destroy: () => {} }),
    createSampler: () => ({}),
    createBindGroupLayout: (desc: LayoutDesc) => {
      layouts.push(desc)
      return { __layout: layouts.length }
    },
    createBindGroup: () => ({}),
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createPipelineLayout: () => ({}),
    createRenderPipeline: () => ({}),
    createComputePipeline: () => ({ __pipeline: ++pipelineId }),
    createBuffer: (desc: { size: number; usage: number }) => ({ size: desc.size, usage: desc.usage, destroy: () => {} }),
    createCommandEncoder: () => ({
      beginRenderPass: () => ({
        setPipeline: () => ops.push('renderSetPipeline'),
        setBindGroup: () => ops.push('renderSetBindGroup'),
        setVertexBuffer: () => ops.push('vb'),
        draw: () => ops.push('renderDraw'),
        end: () => ops.push('renderEnd'),
        writeTimestamp: () => {},
      }),
      beginComputePass: () => {
        ops.push('computeBegin')
        return {
          setPipeline: (p: unknown) => ops.push(`computeSetPipeline(${(p as { __pipeline: number }).__pipeline})`),
          setBindGroup: () => ops.push('computeSetBindGroup'),
          dispatchWorkgroups: (n: number) => ops.push(`dispatch(${n})`),
          end: () => ops.push('computeEnd'),
        }
      },
      finish: () => {
        ops.push('finish')
        return {}
      },
      resolveQuerySet: () => {},
      copyBufferToBuffer: () => {},
      copyTextureToBuffer: () => {},
    }),
    queue: {
      writeTexture: () => {},
      writeBuffer: () => {},
      copyExternalImageToTexture: () => {},
      submit: () => ops.push('submit'),
    },
  }
  const adapter = { features: new Set<string>(), limits: {}, requestDevice: async () => device }
  const gpuMock = { requestAdapter: async () => adapter, getPreferredCanvasFormat: () => 'bgra8unorm' }
  const canvas = {
    width: 64,
    height: 64,
    getContext: (type: string) =>
      type === 'webgpu'
        ? { configure: () => {}, getCurrentTexture: () => ({ createView: () => ({}) }) }
        : null,
  } as unknown as HTMLCanvasElement
  const nav = navigator as unknown as { gpu?: unknown }
  const prevGpu = nav.gpu
  ;(navigator as unknown as { gpu: unknown }).gpu = gpuMock
  const g = globalThis as Record<string, unknown>
  const prevGlobals = {
    GPUTextureUsage: g.GPUTextureUsage,
    GPUShaderStage: g.GPUShaderStage,
    GPUBufferUsage: g.GPUBufferUsage,
  }
  g.GPUTextureUsage = { TEXTURE_BINDING: 0x4, COPY_DST: 0x8, COPY_SRC: 0x2, RENDER_ATTACHMENT: 0x10 }
  g.GPUShaderStage = { VERTEX: 0x1, FRAGMENT: 0x2 }
  g.GPUBufferUsage = { UNIFORM: 0x40, COPY_DST: 0x8, VERTEX: 0x20, STORAGE: 0x80, MAP_READ: 0x1 }
  return {
    ops,
    layouts,
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

const WGSL = `@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u) {}`
const WGSL_B = `@compute @workgroup_size(64) fn other(@builtin(global_invocation_id) gid: vec3u) {}`

async function makeFacade(): Promise<{
  facade: Awaited<ReturnType<typeof createRealGPU>>
  ops: string[]
  layouts: LayoutDesc[]
  cleanup: () => void
}> {
  const mock = installMockGpu()
  const facade = await createRealGPU(mock.canvas as HTMLCanvasElement)
  facade.configure(64, 64)
  return { facade, ops: mock.ops, layouts: mock.layouts, cleanup: mock.cleanup }
}

let cleanup: (() => void) | null = null
afterEach(() => {
  cleanup?.()
  cleanup = null
})

describe('Task 179: the compute PIPELINE memo (realGPU.runCompute)', () => {
  it('same-entry dispatches set the pipeline ONCE per compute pass (the sort loop: 1, not 171)', async () => {
    const ctx = await makeFacade()
    cleanup = ctx.cleanup
    const bufferId = ctx.facade.createExternalBuffer(256, 128)
    const compute = ctx.facade.createCompute(WGSL, 64, [bufferId, bufferId, bufferId, bufferId])
    ctx.ops.length = 0
    ctx.facade.runCompute(compute, 'main', new Float32Array(16), 2)
    ctx.facade.runCompute(compute, 'main', new Float32Array(16), 2)
    ctx.facade.runCompute(compute, 'main', new Float32Array(16), 2)
    ctx.facade.submit()
    expect(ctx.ops.filter(o => o.startsWith('computeSetPipeline(')).length).toBe(1)
    expect(ctx.ops.filter(o => o.startsWith('dispatch(')).length).toBe(3)
  })

  it('an entry switch re-asserts the pipeline; the return to the first entry re-asserts again', async () => {
    const ctx = await makeFacade()
    cleanup = ctx.cleanup
    const bufferId = ctx.facade.createExternalBuffer(256, 128)
    // one module, two entries — the (bitonic, sortStep) shape of the
    // PRE-179 sort loop: every dispatch switched pipelines
    const compute = ctx.facade.createCompute(`${WGSL}\n${WGSL_B}`, 64, [bufferId, bufferId, bufferId, bufferId])
    ctx.ops.length = 0
    ctx.facade.runCompute(compute, 'main', new Float32Array(16), 2)
    ctx.facade.runCompute(compute, 'other', new Float32Array(16), 2)
    ctx.facade.runCompute(compute, 'main', new Float32Array(16), 2)
    ctx.facade.submit()
    // three switches, three asserts — the memo dedupes ONLY the identical
    // re-bind (the family's pipeline cache still creates one per entry)
    expect(ctx.ops.filter(o => o.startsWith('computeSetPipeline(')).length).toBe(3)
    expect(ctx.ops.filter(o => o.startsWith('computeSetPipeline(')).map(o => o.slice(o.indexOf('(') + 1, -1))).toEqual(['1', '2', '1'])
  })

  it('a fresh compute pass re-asserts the pipeline (the memo is pass-scoped)', async () => {
    const ctx = await makeFacade()
    cleanup = ctx.cleanup
    const bufferId = ctx.facade.createExternalBuffer(256, 128)
    const compute = ctx.facade.createCompute(WGSL, 64, [bufferId, bufferId, bufferId, bufferId])
    ctx.facade.runCompute(compute, 'main', new Float32Array(16), 1)
    ctx.facade.beginPass(0) // the structural boundary: the render pass closes the compute pass
    ctx.facade.endPass()
    ctx.ops.length = 0
    ctx.facade.runCompute(compute, 'main', new Float32Array(16), 1)
    ctx.facade.submit()
    expect(ctx.ops.filter(o => o.startsWith('computeSetPipeline(')).length).toBe(1)
    expect(ctx.ops.filter(o => o === 'computeSetBindGroup').length).toBe(1)
  })
})

describe('Task 179: the six-binding compute layout (realGPU.createCompute)', () => {
  it('FOUR buffers: the exact pre-179 five-entry layout (uniform + rw/ro/rw/ro)', async () => {
    const ctx = await makeFacade()
    cleanup = ctx.cleanup
    const bufferId = ctx.facade.createExternalBuffer(256, 128)
    ctx.layouts.length = 0
    ctx.facade.createCompute(WGSL, 64, [bufferId, bufferId, bufferId, bufferId])
    expect(ctx.layouts.length).toBe(1)
    const entries = ctx.layouts[0]!.entries
    expect(entries.length).toBe(5)
    expect(entries.map(e => e.binding)).toEqual([0, 1, 2, 3, 4])
    expect(entries.map(e => e.buffer.type)).toEqual(['uniform', 'storage', 'read-only-storage', 'storage', 'read-only-storage'])
  })

  it('FIVE buffers: binding 5 joins as rw storage (the sort family\'s NETWORK CLOCK)', async () => {
    const ctx = await makeFacade()
    cleanup = ctx.cleanup
    const bufferId = ctx.facade.createExternalBuffer(256, 128)
    ctx.layouts.length = 0
    ctx.facade.createCompute(WGSL, 64, [bufferId, bufferId, bufferId, bufferId, bufferId])
    expect(ctx.layouts.length).toBe(1)
    const entries = ctx.layouts[0]!.entries
    expect(entries.length).toBe(6)
    expect(entries.map(e => e.binding)).toEqual([0, 1, 2, 3, 4, 5])
    expect(entries[5]!.buffer.type).toBe('storage')
    // the first four storage slots keep the pre-179 types
    expect(entries.slice(0, 5).map(e => e.buffer.type)).toEqual(['uniform', 'storage', 'read-only-storage', 'storage', 'read-only-storage'])
  })

  it('a missing external buffer in the extended slots still fails loudly (id −1)', async () => {
    const ctx = await makeFacade()
    cleanup = ctx.cleanup
    const bufferId = ctx.facade.createExternalBuffer(256, 128)
    ctx.layouts.length = 0
    const id = ctx.facade.createCompute(WGSL, 64, [bufferId, bufferId, bufferId, bufferId, 424242])
    expect(id).toBe(-1)
    expect(ctx.layouts.length).toBe(1) // the layout was built before the buffer resolution failed
  })
})
