/**
 * The dynamic-offset UBO binding window. A skinned draw (model-viewer:
 * 67-bone palette, a 4448-byte uniform block) died in Dawn validation:
 * "bound with size 256 at group 0, binding 0 is too small. The pipeline
 * requires a buffer binding which is at least 4448 bytes" → Invalid
 * CommandBuffer → the error storm stopped rendering on WebGPU entirely
 * (WebGL kept drawing, but with garbage beyond the 256-byte window).
 *
 * The bind group must expose a window of at least the largest uniform
 * block, and the UBO must fit offset + window for every live slot.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { createRealGPU } from '../src/realGPU.ts'

interface MockCalls {
  buffers: Array<{ size: number; usage: number }>
  bindGroups: Array<{ entries: Array<{ binding: number; resource: { buffer: unknown; size: number } }> }>
  passSetBindGroup: Array<[number, unknown, number[]]>
}

function installMockGpu(): { calls: MockCalls; canvas: unknown; cleanup: () => void } {
  const calls: MockCalls = { buffers: [], bindGroups: [], passSetBindGroup: [] }
  let nextId = 1
  const id = (): number => nextId++

  const device = {
    features: new Set(),
    limits: {},
    lost: new Promise(() => {}), // never resolves in the test
    addEventListener: () => {},
    createBuffer: (desc: { size: number; usage: number }) => {
      const buffer = { bufferId: id(), ...desc, destroy: () => {} }
      calls.buffers.push(desc)
      return buffer
    },
    createTexture: (desc: Record<string, unknown>) => ({
      __desc: desc,
      createView: () => ({ viewId: id() }),
      destroy: () => {},
    }),
    createSampler: () => ({ samplerId: id() }),
    createBindGroupLayout: (desc: { entries: Array<Record<string, unknown>> }) => ({ bglId: id(), ...desc }),
    createBindGroup: (desc: { layout: unknown; entries: Array<{ binding: number; resource: { buffer: unknown; size: number } }> }) => {
      const bg = { bgId: id(), ...desc }
      calls.bindGroups.push(bg)
      return bg
    },
    createShaderModule: (_desc: { code: string }) => ({
      getCompilationInfo: async () => ({ messages: [] }),
    }),
    createPipelineLayout: (desc: { bindGroupLayouts: unknown[] }) => ({ plId: id(), ...desc }),
    createRenderPipeline: (desc: { layout: unknown }) => ({ pipelineId: id(), ...desc }),
    createCommandEncoder: () => ({
      beginRenderPass: (_desc: unknown) => ({
        setPipeline: () => {},
        setBindGroup: (index: number, group: unknown, dynamicOffsets: number[]) =>
          calls.passSetBindGroup.push([index, group, dynamicOffsets]),
        setVertexBuffer: () => {},
        draw: () => {},
        end: () => {},
        writeTimestamp: () => {},
      }),
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
  const adapter = { features: new Set(), limits: {}, requestDevice: async () => device }
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

describe('UBO dynamic-offset binding window', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => { for (const c of cleanups.splice(0)) c() })

  it('a small slice: the window is the 256-byte minimum', async () => {
    const { calls, canvas, cleanup } = installMockGpu()
    cleanups.push(cleanup)
    const gpu = await createRealGPU(canvas as never)
    gpu.uploadUniforms(0, new Uint8Array(84))
    expect(calls.bindGroups).toHaveLength(1)
    expect(calls.bindGroups[0]!.entries[0]!.resource.size).toBe(256)
    // the buffer is at least 64 KiB (the allocator minimum)
    expect(calls.buffers[0]!.size).toBeGreaterThanOrEqual(65536)
  })

  it('a 4448-byte skin palette: the window grows to 4608 and covers the block', async () => {
    const { calls, canvas, cleanup } = installMockGpu()
    cleanups.push(cleanup)
    const gpu = await createRealGPU(canvas as never)
    gpu.uploadUniforms(0, new Uint8Array(4448))
    const bg = calls.bindGroups[calls.bindGroups.length - 1]!
    // ceil(4448 / 256) * 256 = 4608 ≥ 4448 — the pipeline accepts the binding
    expect(bg.entries[0]!.resource.size).toBe(4608)
    // the UBO fits offset (0) + window (4608)
    expect(calls.buffers[0]!.size).toBeGreaterThanOrEqual(4608)
  })

  it('window growth WITHOUT buffer growth still rebuilds the group (no stale 256)', async () => {
    const { calls, canvas, cleanup } = installMockGpu()
    cleanups.push(cleanup)
    const gpu = await createRealGPU(canvas as never)
    // a small slice first: the buffer is created at the 64 KiB minimum
    gpu.uploadUniforms(0, new Uint8Array(84))
    expect(calls.bindGroups).toHaveLength(1)
    expect(calls.bindGroups[0]!.entries[0]!.resource.size).toBe(256)
    // the big slice fits into the existing buffer (offset 256 + 4608 ≤ 64 KiB):
    // no buffer may be recreated, but the group MUST be rebuilt with the
    // larger window — the stale 256-byte group was the WebGPU failure
    const buffersBefore = calls.buffers.length
    gpu.uploadUniforms(256, new Uint8Array(4448))
    expect(calls.buffers.length).toBe(buffersBefore)
    expect(calls.bindGroups).toHaveLength(2)
    expect(calls.bindGroups[1]!.entries[0]!.resource.size).toBe(4608)
  })

  it('a later small slice does not recreate or shrink the group', async () => {
    const { calls, canvas, cleanup } = installMockGpu()
    cleanups.push(cleanup)
    const gpu = await createRealGPU(canvas as never)
    gpu.uploadUniforms(0, new Uint8Array(4448))
    const groupsAfterBig = calls.bindGroups.length
    // a small slice at a further offset — the window stays at the maximum
    gpu.uploadUniforms(4608, new Uint8Array(256))
    expect(calls.bindGroups.length).toBe(groupsAfterBig)
    expect(calls.bindGroups[calls.bindGroups.length - 1]!.entries[0]!.resource.size).toBe(4608)
    // and its own range fits: 4608 + 4608 ≤ the 64 KiB minimum buffer
    expect(calls.buffers[0]!.size).toBeGreaterThanOrEqual(4608 + 4608)
  })

  it('bindUniforms passes the slice offset as the dynamic offset', async () => {
    const { calls, canvas, cleanup } = installMockGpu()
    cleanups.push(cleanup)
    const gpu = await createRealGPU(canvas as never)
    gpu.uploadUniforms(0, new Uint8Array(84))
    gpu.beginPass(0)
    gpu.bindUniforms(256)
    expect(calls.passSetBindGroup.length).toBe(1)
    const [index, group, dynamicOffsets] = calls.passSetBindGroup[0]!
    expect(index).toBe(0)
    expect(group).toBe(calls.bindGroups[0]!)
    // A scratch Uint32Array is passed (no array allocation per draw) —
    // the WebGPU API accepts any sequence; compare contents, not the wrapper.
    expect(Array.from(dynamicOffsets as ArrayLike<number>)).toEqual([256])
  })
})
