/**
 * Task 120 — the WebGPU writeTexture ROW ALIGNMENT (realGPU.texSubImage2D):
 * bytesPerRow must be a multiple of 256. w*bytesPerPixel is aligned only by
 * luck (w=64 → 256, w=128 → 512); an unaligned width (w=100 → 400) fails
 * queue.writeTexture validation and the write is silently dropped — the
 * texture stays empty (the raw-byte sprite regression class).
 *
 * The fix repacks the rows into a padded buffer (alignedRow = ceil(row/256)*256).
 * These tests pin the contract on a recording mock device:
 *   1. an aligned width passes the ORIGINAL array through (no repack, no copy);
 *   2. an unaligned width gets padded rows: bytesPerRow = 512 for w=100,
 *      every row's texels land at row*512, padding is zero;
 *   3. a single-row (h=1) upload keeps the natural row (no padding needed).
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { createRealGPU } from '../src/realGPU.ts'

interface WriteCall {
  origin: { x: number; y: number; z: number }
  data: Uint8Array
  bytesPerRow: number
  rowsPerImage: number
  width: number
  height: number
}

function installMockGpu(): { writes: WriteCall[]; canvas: unknown; cleanup: () => void } {
  const writes: WriteCall[] = []
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
    createCommandEncoder: () => ({
      beginRenderPass: () => ({ setPipeline: () => {}, setBindGroup: () => {}, setVertexBuffer: () => {}, draw: () => {}, end: () => {}, writeTimestamp: () => {} }),
      finish: () => ({}),
      resolveQuerySet: () => {},
      copyBufferToBuffer: () => {},
    }),
    queue: {
      writeTexture: (dst: { origin: { x: number; y: number; z: number } }, data: Uint8Array, layout: { bytesPerRow: number; rowsPerImage: number }, size: { width: number; height: number }) => {
        writes.push({ origin: dst.origin, data, bytesPerRow: layout.bytesPerRow, rowsPerImage: layout.rowsPerImage, width: size.width, height: size.height })
      },
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
  g.GPUTextureUsage = { TEXTURE_BINDING: 0x4, COPY_DST: 0x8, COPY_SRC: 0x2, RENDER_ATTACHMENT: 0x10 }
  g.GPUShaderStage = { VERTEX: 0x1, FRAGMENT: 0x2 }
  g.GPUBufferUsage = { UNIFORM: 0x40, COPY_DST: 0x8, VERTEX: 0x20 }
  return {
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

describe('Task 120: writeTexture row alignment (realGPU.texSubImage2D)', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => { for (const c of cleanups.splice(0)) c() })

  async function makeFacade(): Promise<ReturnType<typeof installMockGpu>> {
    const mock = installMockGpu()
    cleanups.push(mock.cleanup)
    await createRealGPU(mock.canvas as never)
    return mock
  }

  it('an aligned width (128) passes the original bytes through — no repack', async () => {
    const mock = await makeFacade()
    const gpu = await createRealGPU(mock.canvas as never)
    const texId = gpu.createTexture(128, 128)
    const bytes = new Uint8Array(128 * 128 * 4)
    bytes[0] = 1; bytes[127 * 512 + 127 * 4] = 2 // spot marks
    gpu.texSubImage2D(texId, 0, 0, 128, 128, bytes)
    expect(mock.writes.length).toBe(1)
    const w = mock.writes[0]
    expect(w.bytesPerRow).toBe(512) // 128*4 — already a multiple of 256
    expect(w.data).toBe(bytes) // the SAME array — zero-copy
    expect(w.rowsPerImage).toBe(128)
    expect(w.width).toBe(128)
    expect(w.height).toBe(128)
    expect(w.origin).toEqual({ x: 0, y: 0, z: 0 })
  })

  it('an unaligned width (100) repacks the rows into 512-byte aligned strides', async () => {
    const mock = await makeFacade()
    const gpu = await createRealGPU(mock.canvas as never)
    const texId = gpu.createTexture(100, 100)
    const bytes = new Uint8Array(100 * 100 * 4)
    // a mark at row 42, texel 7: offset 42*400 + 7*4 = 16828
    const mark = 16828
    bytes[mark] = 0xab; bytes[mark + 1] = 0xcd
    gpu.texSubImage2D(texId, 0, 0, 100, 100, bytes)
    expect(mock.writes.length).toBe(1)
    const w = mock.writes[0]
    expect(w.bytesPerRow).toBe(512) // ceil(400/256)*256
    expect(w.data.length).toBe(512 * 100) // the padded buffer
    expect(w.data).not.toBe(bytes) // repacked
    // the row-42 mark lands at 42*512 + 28
    const at = 42 * 512 + 7 * 4
    expect(w.data[at]).toBe(0xab)
    expect(w.data[at + 1]).toBe(0xcd)
    // row 0 starts at 0, row 1 starts at 512 — the 112 padding bytes are zero
    expect(w.data[0]).toBe(bytes[0])
    expect(w.data[512]).toBe(bytes[400])
    let padNonZero = 0
    for (let i = 400; i < 512; i++) if (w.data[i] !== 0) padNonZero++
    expect(padNonZero).toBe(0)
  })

  it('a single-row upload (h=1) keeps the natural row length — no padding buffer', async () => {
    const mock = await makeFacade()
    const gpu = await createRealGPU(mock.canvas as never)
    const texId = gpu.createTexture(100, 1)
    const bytes = new Uint8Array(100 * 4)
    bytes[0] = 7
    gpu.texSubImage2D(texId, 0, 0, 100, 1, bytes)
    expect(mock.writes.length).toBe(1)
    const w = mock.writes[0]
    expect(w.bytesPerRow).toBe(512)
    expect(w.data).toBe(bytes) // h=1: no repack (the layout is spec-valid as-is)
    expect(w.height).toBe(1)
  })
})
