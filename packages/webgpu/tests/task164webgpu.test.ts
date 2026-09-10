/**
 * Task 164 — THE STEADY-STATE PASS (WebGPU side): the frame's hot loops
 * (the bitonic sort: ~342 dispatches per frame at 160k particles) must not
 * re-pay per-dispatch machinery that is frame-static:
 *
 *   1. THE MERGED COMPUTE PASS — consecutive runCompute calls share ONE
 *      GPUComputePassEncoder (was: begin/end per call, ~342 pairs per
 *      frame). The pass closes at the frame's structural boundaries: a
 *      render pass opening, submit, an encoder-level copy.
 *   2. THE UNIFORM WRITE-SKIP MEMO — identical uniform blocks upload once
 *      (was: one queue.writeBuffer per dispatch — ~342 identical copies).
 *   3. THE COMPUTE BIND-GROUP MEMO — setBindGroup(0, group) once per
 *      family per pass (was: per dispatch).
 *   4. THE VERTEX-BIND MEMO — pass.setVertexBuffer(slot, buffer) with the
 *      slot's already-bound buffer is skipped inside a render pass; a
 *      fresh pass re-binds (the GL twin of Task 163's unit-bind cache).
 *   5. THE SAB STAGING CACHE — SAB-backed feed uploads copy into a REUSED
 *      staging buffer (was: a fresh MB-scale Uint8Array every frame).
 *
 * All pins run on a recording mock device (the texRowAlign pattern) with
 * an ordered op log — pass boundaries, dispatch order and writeBuffer
 * identity are all observable.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { createRealGPU } from '../src/realGPU.ts'

interface WriteCall {
  buffer: unknown
  bufferOffset: number
  data: unknown
  dataOffset?: number
  size?: number
}

function installMockGpu(): {
  ops: string[]
  writes: WriteCall[]
  canvas: unknown
  cleanup: () => void
} {
  const ops: string[] = []
  const writes: WriteCall[] = []
  let bufId = 0
  const device = {
    features: new Set<string>(),
    limits: {},
    lost: new Promise(() => {}),
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
    createComputePipeline: () => {
      ops.push('computePipeline')
      return {}
    },
    createBuffer: (desc: { size: number; usage: number }) => ({ __id: ++bufId, size: desc.size, usage: desc.usage, destroy: () => {} }),
    createCommandEncoder: () => ({
      beginRenderPass: () => {
        ops.push('renderBegin')
        return {
          setPipeline: () => ops.push('renderSetPipeline'),
          setBindGroup: () => ops.push('renderSetBindGroup'),
          setVertexBuffer: (slot: number, buffer: unknown) => ops.push(`vb(${slot},${(buffer as { __id: number }).__id})`),
          draw: () => ops.push('renderDraw'),
          end: () => ops.push('renderEnd'),
          writeTimestamp: () => {},
        }
      },
      beginComputePass: () => {
        ops.push('computeBegin')
        return {
          setPipeline: () => ops.push('computeSetPipeline'),
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
      copyBufferToBuffer: () => ops.push('copyBufferToBuffer'),
      copyTextureToBuffer: () => ops.push('copyTextureToBuffer'),
    }),
    queue: {
      writeTexture: () => {},
      writeBuffer: (buffer: unknown, bufferOffset: number, data: unknown, dataOffset?: number, size?: number) => {
        writes.push({ buffer, bufferOffset, data, dataOffset, size })
      },
      copyExternalImageToTexture: () => {},
      submit: () => ops.push('submit'),
    },
  }
  const adapter = {
    features: new Set<string>(),
    limits: {},
    requestDevice: async () => device,
  }
  const gpuMock = { requestAdapter: async () => adapter, getPreferredCanvasFormat: () => 'bgra8unorm' }
  const canvas = {
    width: 64,
    height: 64,
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
  g.GPUTextureUsage = { TEXTURE_BINDING: 0x4, COPY_DST: 0x8, COPY_SRC: 0x2, RENDER_ATTACHMENT: 0x10 }
  g.GPUShaderStage = { VERTEX: 0x1, FRAGMENT: 0x2 }
  g.GPUBufferUsage = { UNIFORM: 0x40, COPY_DST: 0x8, VERTEX: 0x20, STORAGE: 0x80, MAP_READ: 0x1 }
  return {
    ops,
    writes,
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

async function makeFacade(): Promise<{
  facade: Awaited<ReturnType<typeof createRealGPU>>
  ops: string[]
  writes: WriteCall[]
  cleanup: () => void
}> {
  const mock = installMockGpu()
  const facade = await createRealGPU(mock.canvas as HTMLCanvasElement)
  facade.configure(64, 64)
  return { facade, ops: mock.ops, writes: mock.writes, cleanup: mock.cleanup }
}

let cleanup: (() => void) | null = null
afterEach(() => {
  cleanup?.()
  cleanup = null
})

describe('Task 164: the merged compute pass (realGPU.runCompute)', () => {
  it('three consecutive dispatches share ONE compute pass — one begin, one end, three dispatches in order', async () => {
    const ctx = await makeFacade()
    cleanup = ctx.cleanup
    const bufferId = ctx.facade.createExternalBuffer(256, 128)
    const compute = ctx.facade.createCompute(WGSL, 64, [bufferId, bufferId, bufferId, bufferId])
    ctx.ops.length = 0
    ctx.facade.runCompute(compute, 'main', new Float32Array(16), 2)
    ctx.facade.runCompute(compute, 'main', new Float32Array(16), 3)
    ctx.facade.runCompute(compute, 'main', new Float32Array(16), 4)
    ctx.facade.submit()
    expect(ctx.ops.filter(o => o === 'computeBegin').length).toBe(1)
    expect(ctx.ops.filter(o => o === 'computeEnd').length).toBe(1)
    expect(ctx.ops.filter(o => o.startsWith('dispatch(')).length).toBe(3)
    // the dispatch order is the call order
    const d1 = ctx.ops.indexOf('dispatch(2)')
    const d2 = ctx.ops.indexOf('dispatch(3)')
    const d3 = ctx.ops.indexOf('dispatch(4)')
    expect(d3).toBeGreaterThan(d2)
    expect(d2).toBeGreaterThan(d1)
    // all dispatches live INSIDE the single pass
    expect(d1).toBeGreaterThan(ctx.ops.indexOf('computeBegin'))
    expect(ctx.ops.indexOf('computeEnd')).toBeGreaterThan(d3)
    // the pass ends before encoder.finish (submit is the structural boundary)
    expect(ctx.ops.indexOf('finish')).toBeGreaterThan(ctx.ops.indexOf('computeEnd'))
  })

  it('a render pass opening CLOSES the merged compute pass first (one pass per encoder at a time)', async () => {
    const ctx = await makeFacade()
    cleanup = ctx.cleanup
    const bufferId = ctx.facade.createExternalBuffer(256, 128)
    const compute = ctx.facade.createCompute(WGSL, 64, [bufferId, bufferId, bufferId, bufferId])
    ctx.facade.runCompute(compute, 'main', new Float32Array(16), 2)
    ctx.ops.length = 0
    ctx.facade.beginPass(0)
    const computeEnd = ctx.ops.indexOf('computeEnd')
    const renderBegin = ctx.ops.indexOf('renderBegin')
    expect(computeEnd).toBeGreaterThanOrEqual(0)
    expect(renderBegin).toBeGreaterThan(computeEnd)
    // and compute resumes in a NEW pass after the render pass ends
    ctx.facade.endPass()
    ctx.ops.length = 0
    ctx.facade.runCompute(compute, 'main', new Float32Array(16), 2)
    expect(ctx.ops.filter(o => o === 'computeBegin').length).toBe(1)
  })

  it('two dispatch bursts around a render pass: one compute pass per burst, not per call', async () => {
    const ctx = await makeFacade()
    cleanup = ctx.cleanup
    const bufferId = ctx.facade.createExternalBuffer(256, 128)
    const compute = ctx.facade.createCompute(WGSL, 64, [bufferId, bufferId, bufferId, bufferId])
    ctx.facade.runCompute(compute, 'main', new Float32Array(16), 1)
    ctx.facade.runCompute(compute, 'main', new Float32Array(16), 1)
    ctx.facade.beginPass(0)
    ctx.facade.endPass()
    ctx.facade.runCompute(compute, 'main', new Float32Array(16), 1)
    ctx.facade.submit()
    // burst 1: 2 dispatches one pass; burst 2: 1 dispatch one pass
    expect(ctx.ops.filter(o => o === 'computeBegin').length).toBe(2)
    expect(ctx.ops.filter(o => o === 'computeEnd').length).toBe(2)
    expect(ctx.ops.filter(o => o.startsWith('dispatch(')).length).toBe(3)
  })

  it('the render-pass-open guard stays: runCompute during an open render pass is refused loudly', async () => {
    const ctx = await makeFacade()
    cleanup = ctx.cleanup
    const errors: string[] = []
    const bufferId = ctx.facade.createExternalBuffer(256, 128)
    const compute = ctx.facade.createCompute(WGSL, 64, [bufferId, bufferId, bufferId, bufferId])
    ctx.facade.beginPass(0)
    // install an error channel by driving the facade with a fresh one is not
    // possible mid-flight — the facade's onGpuError was set at creation; the
    // contract is observable through the op log instead: no dispatch lands.
    ctx.facade.runCompute(compute, 'main', new Float32Array(16), 2)
    expect(ctx.ops.filter(o => o.startsWith('dispatch(')).length).toBe(0)
    expect(ctx.ops.filter(o => o === 'computeBegin').length).toBe(0)
    ctx.facade.endPass()
    ctx.facade.submit()
  })

  it('workgroups 0 writes the uniforms but dispatches nothing (the pre-merge contract, kept)', async () => {
    const ctx = await makeFacade()
    cleanup = ctx.cleanup
    const bufferId = ctx.facade.createExternalBuffer(256, 128)
    const compute = ctx.facade.createCompute(WGSL, 64, [bufferId, bufferId, bufferId, bufferId])
    ctx.ops.length = 0
    ctx.writes.length = 0
    ctx.facade.runCompute(compute, 'main', new Float32Array(16), 0)
    expect(ctx.writes.length).toBe(1)
    expect(ctx.ops.filter(o => o.startsWith('dispatch(')).length).toBe(0)
    ctx.facade.submit()
  })
})

describe('Task 164: the uniform write-skip memo (realGPU.runCompute)', () => {
  it('identical uniform content uploads ONCE across dispatches (a different array instance still skips)', async () => {
    const ctx = await makeFacade()
    cleanup = ctx.cleanup
    const bufferId = ctx.facade.createExternalBuffer(256, 128)
    const compute = ctx.facade.createCompute(WGSL, 64, [bufferId, bufferId, bufferId, bufferId])
    ctx.facade.runCompute(compute, 'main', new Float32Array([1, 2, 3, 4]), 1)
    // a DIFFERENT instance with the same bytes — the memo is content-based
    ctx.facade.runCompute(compute, 'main', new Float32Array([1, 2, 3, 4]), 1)
    ctx.facade.submit()
    expect(ctx.writes.length).toBe(1)
  })

  it('a changed field re-uploads (last-write-wins semantics preserved)', async () => {
    const ctx = await makeFacade()
    cleanup = ctx.cleanup
    const bufferId = ctx.facade.createExternalBuffer(256, 128)
    const compute = ctx.facade.createCompute(WGSL, 64, [bufferId, bufferId, bufferId, bufferId])
    ctx.facade.runCompute(compute, 'main', new Float32Array([1, 2, 3, 4]), 1)
    ctx.facade.runCompute(compute, 'main', new Float32Array([1, 2, 3, 4]), 1) // skipped
    ctx.facade.runCompute(compute, 'main', new Float32Array([1, 2, 3, 5]), 1) // k/j-style change
    ctx.facade.runCompute(compute, 'main', new Float32Array([1, 2, 3, 5]), 1) // skipped again
    ctx.facade.submit()
    expect(ctx.writes.length).toBe(2)
  })

  it('a MUTATED scratch (same instance, new content) re-uploads — the memo holds a copy, not a reference', async () => {
    const ctx = await makeFacade()
    cleanup = ctx.cleanup
    const bufferId = ctx.facade.createExternalBuffer(256, 128)
    const compute = ctx.facade.createCompute(WGSL, 64, [bufferId, bufferId, bufferId, bufferId])
    const scratch = new Float32Array(16)
    ctx.facade.runCompute(compute, 'main', scratch, 1)
    scratch[0] = 7
    ctx.facade.runCompute(compute, 'main', scratch, 1)
    ctx.facade.submit()
    expect(ctx.writes.length).toBe(2)
  })

  it('two families keep independent memos', async () => {
    const ctx = await makeFacade()
    cleanup = ctx.cleanup
    const bufferId = ctx.facade.createExternalBuffer(256, 128)
    const a = ctx.facade.createCompute(WGSL, 64, [bufferId, bufferId, bufferId, bufferId])
    const b = ctx.facade.createCompute(WGSL, 64, [bufferId, bufferId, bufferId, bufferId])
    ctx.facade.runCompute(a, 'main', new Float32Array([1]), 1)
    ctx.facade.runCompute(b, 'main', new Float32Array([1]), 1)
    ctx.facade.runCompute(a, 'main', new Float32Array([1]), 1)
    ctx.facade.submit()
    expect(ctx.writes.length).toBe(2)
  })
})

describe('Task 164: the compute bind-group memo (realGPU.runCompute)', () => {
  it('same-family dispatches set the bind group ONCE per compute pass', async () => {
    const ctx = await makeFacade()
    cleanup = ctx.cleanup
    const bufferId = ctx.facade.createExternalBuffer(256, 128)
    const compute = ctx.facade.createCompute(WGSL, 64, [bufferId, bufferId, bufferId, bufferId])
    ctx.ops.length = 0
    ctx.facade.runCompute(compute, 'main', new Float32Array(16), 1)
    ctx.facade.runCompute(compute, 'main', new Float32Array(16), 1)
    ctx.facade.runCompute(compute, 'main', new Float32Array(16), 1)
    ctx.facade.submit()
    expect(ctx.ops.filter(o => o === 'computeSetBindGroup').length).toBe(1)
  })

  it('a fresh compute pass re-binds the group (the memo is pass-scoped)', async () => {
    const ctx = await makeFacade()
    cleanup = ctx.cleanup
    const bufferId = ctx.facade.createExternalBuffer(256, 128)
    const compute = ctx.facade.createCompute(WGSL, 64, [bufferId, bufferId, bufferId, bufferId])
    ctx.facade.runCompute(compute, 'main', new Float32Array(16), 1)
    ctx.facade.beginPass(0)
    ctx.facade.endPass()
    ctx.ops.length = 0
    ctx.facade.runCompute(compute, 'main', new Float32Array(16), 1)
    ctx.facade.submit()
    expect(ctx.ops.filter(o => o === 'computeSetBindGroup').length).toBe(1)
  })
})

describe('Task 164: the vertex-bind memo (realGPU.bindVertexBuffer)', () => {
  it('an identical re-bind inside a render pass is skipped; a different buffer re-binds; a fresh pass re-binds', async () => {
    const ctx = await makeFacade()
    cleanup = ctx.cleanup
    const dataA = new Float32Array([0, 1, 2, 3])
    const dataB = new Float32Array([4, 5, 6, 7])
    ctx.facade.beginPass(0)
    ctx.ops.length = 0
    ctx.facade.bindVertexBuffer(0, dataA, 2)
    ctx.facade.bindVertexBuffer(0, dataA, 2) // memo hit — skipped
    ctx.facade.bindVertexBuffer(1, dataA, 2) // a different SLOT binds for real
    ctx.facade.bindVertexBuffer(0, dataB, 2) // a different buffer — re-binds
    expect(ctx.ops.filter(o => o === 'vb(0,1)').length).toBe(1) // dataA on slot 0
    expect(ctx.ops.filter(o => o === 'vb(1,1)').length).toBe(1)
    expect(ctx.ops.filter(o => o === 'vb(0,2)').length).toBe(1) // dataB on slot 0
    // a fresh pass re-binds everything (the memo died at the boundary)
    ctx.facade.endPass()
    ctx.facade.beginPass(0)
    ctx.ops.length = 0
    ctx.facade.bindVertexBuffer(0, dataA, 2)
    expect(ctx.ops.filter(o => o === 'vb(0,1)').length).toBe(1)
    ctx.facade.endPass()
    ctx.facade.submit()
  })
})

describe('Task 164: the SAB staging cache (guardedWriteVertex)', () => {
  it('a SAB-backed feed reuses ONE staging buffer — writeBuffer sees the same object with fresh bytes', async () => {
    const ctx = await makeFacade()
    cleanup = ctx.cleanup
    const sab = new SharedArrayBuffer(64)
    const view = new Float32Array(sab)
    view.set([1, 2, 3, 4, 5, 6, 7, 8])
    ctx.writes.length = 0
    ctx.facade.syncVertexBuffer(view, 64)
    expect(ctx.writes.length).toBe(1)
    const first = ctx.writes[0]!.data as Uint8Array
    // frame 2: the same view, new content — the SAME staging object
    view.set([9, 10, 11, 12, 13, 14, 15, 16])
    ctx.facade.syncVertexBuffer(view, 64)
    expect(ctx.writes.length).toBe(2)
    const second = ctx.writes[1]!.data as Uint8Array
    expect(second).toBe(first)
    // and the bytes are the FRESH ones (the copy happened into the reuse)
    const floats = new Float32Array(second.buffer, second.byteOffset, 8)
    expect(Array.from(floats.slice(0, 8))).toEqual([9, 10, 11, 12, 13, 14, 15, 16])
  })
})
