/**
 * Task 165 — THE RENDER-PASS TWIN (WebGPU side): Task 164's memos covered
 * the compute path; the RENDER pass still re-issued its frame-static binds
 * per draw. Pinned here on a recording mock device:
 *
 *   1. THE GROUP-0 OFFSET MEMO — bindUniforms(dynamicOffset) with an
 *      UNCHANGED offset inside a pass skips the setBindGroup(0) re-assert;
 *      a different offset re-binds; a fresh pass re-binds.
 *   2. THE GROUP-1 ASSERT MEMO — draw()'s texture-group flush with the SAME
 *      texture set (the memo fast path) and the SAME group object already
 *      on the pass skips the setBindGroup(1) re-assert; a different texture
 *      set re-binds.
 *   3. ensureUBO rebuilding the group-0 OBJECT re-arms the offset memo (the
 *      old group on the pass must never be skipped onto).
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { createRealGPU } from '../src/realGPU.ts'

function installMockGpu(): { ops: string[]; canvas: unknown; cleanup: () => void } {
  const ops: string[] = []
  let bufId = 0
  const device = {
    features: new Set<string>(),
    limits: {},
    lost: new Promise(() => {}),
    addEventListener: () => {},
    createTexture: (desc: Record<string, unknown>) => ({
      __desc: desc,
      createView: () => ({ __tex: (desc as { label?: string }).label }),
      destroy: () => {},
    }),
    createSampler: () => ({ __sampler: true }),
    createBindGroupLayout: () => ({ __bgl: true }),
    createBindGroup: (desc: { entries?: unknown[] }) => ({ __bg: `${desc.entries?.length ?? 0}:${ops.length}` }),
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createPipelineLayout: () => ({ __pl: true }),
    createRenderPipeline: () => ({ __rp: true }),
    createComputePipeline: () => ({}),
    createBuffer: (desc: { size: number; usage: number }) => ({ __id: ++bufId, size: desc.size, usage: desc.usage, destroy: () => {} }),
    createCommandEncoder: () => ({
      beginRenderPass: () => {
        ops.push('renderBegin')
        return {
          setPipeline: () => ops.push('renderSetPipeline'),
          setBindGroup: (index: number, group: unknown, offsets?: Uint32Array) =>
            ops.push(`renderSetBindGroup(${index},${(group as { __bg?: string }).__bg ?? '?'}${offsets !== undefined ? `,off${offsets[0]}` : ''})`),
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
      writeBuffer: () => {},
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

async function makeFacade(): Promise<{
  facade: Awaited<ReturnType<typeof createRealGPU>>
  ops: string[]
  cleanup: () => void
}> {
  const mock = installMockGpu()
  const facade = await createRealGPU(mock.canvas as HTMLCanvasElement)
  facade.configure(64, 64)
  return { facade, ops: mock.ops, cleanup: mock.cleanup }
}

let cleanup: (() => void) | null = null
afterEach(() => {
  cleanup?.()
  cleanup = null
})

const WGSL_PLAIN = `struct U { mvp: mat4x4<f32> };
@group(0) @binding(0) var<uniform> u: U;
@vertex fn vs(@location(0) pos: vec3<f32>) -> @builtin(position) vec4<f32> { return u.mvp * vec4(pos, 1.0); }
@fragment fn fs() -> @location(0) vec4<f32> { return vec4(1.0, 0.0, 0.0, 1.0); }`

const WGSL_TEX = `struct U { mvp: mat4x4<f32> };
@group(0) @binding(0) var<uniform> u: U;
@group(1) @binding(1) var tex: texture_2d<f32>;
@group(1) @binding(0) var samp: sampler;
@vertex fn vs(@location(0) pos: vec3<f32>) -> @builtin(position) vec4<f32> { return u.mvp * vec4(pos, 1.0); }
@fragment fn fs() -> @location(0) vec4<f32> { return textureSample(tex, samp, vec2(0.5)); }`

const quad = new Float32Array(12)

describe('Task 165: the group-0 offset memo (bindUniforms)', () => {
  it('consecutive draws with the SAME dynamic offset assert setBindGroup(0) ONCE; a different offset re-binds', async () => {
    const ctx = await makeFacade()
    cleanup = ctx.cleanup
    const { facade, ops } = ctx
    facade.ensurePipeline(1, WGSL_PLAIN, [3], false)
    facade.beginPass(0)
    facade.usePipeline(1)
    facade.uploadUniforms(256, new Uint8Array(64)) // the slice lands (the real executor order)
    facade.uploadUniforms(512, new Uint8Array(64))
    ops.length = 0
    facade.bindUniforms(256)
    facade.bindUniforms(256) // the repeat — skipped
    facade.bindUniforms(256) // and again
    facade.draw(3, 1)
    expect(ops.filter(o => o.startsWith('renderSetBindGroup(0,')).length).toBe(1)
    facade.bindUniforms(512) // a different slice — a real re-bind
    facade.draw(3, 1)
    expect(ops.filter(o => o.startsWith('renderSetBindGroup(0,')).length).toBe(2)
    facade.endPass()
    facade.submit()
  })

  it('a fresh pass re-binds (the memo is pass-scoped)', async () => {
    const ctx = await makeFacade()
    cleanup = ctx.cleanup
    const { facade, ops } = ctx
    facade.ensurePipeline(1, WGSL_PLAIN, [3], false)
    facade.beginPass(0)
    facade.usePipeline(1)
    facade.uploadUniforms(256, new Uint8Array(64))
    facade.bindUniforms(256)
    facade.draw(3, 1)
    facade.endPass()
    ops.length = 0
    facade.beginPass(0) // the pass boundary kills the memo
    facade.usePipeline(1)
    facade.bindUniforms(256) // same offset as the last pass — re-bound
    facade.draw(3, 1)
    facade.endPass()
    facade.submit()
    expect(ops.filter(o => o.startsWith('renderSetBindGroup(0,')).length).toBe(1)
  })

  it('ensureUBO rebuilding the group object re-arms the memo (a bigger slice window)', async () => {
    const ctx = await makeFacade()
    cleanup = ctx.cleanup
    const { facade, ops } = ctx
    facade.ensurePipeline(1, WGSL_PLAIN, [3], false)
    facade.beginPass(0)
    facade.usePipeline(1)
    facade.uploadUniforms(256, new Uint8Array(64))
    facade.bindUniforms(256)
    facade.draw(3, 1)
    ops.length = 0
    // a LARGER slice at the same offset: the window grows, the group object
    // is rebuilt — the next bindUniforms(256) must re-bind the NEW group
    facade.uploadUniforms(256, new Uint8Array(512))
    facade.bindUniforms(256)
    facade.draw(3, 1)
    expect(ops.filter(o => o.startsWith('renderSetBindGroup(0,')).length).toBe(1)
    facade.endPass()
    facade.submit()
  })
})

describe('Task 165: the group-1 assert memo (draw texture flush)', () => {
  it('consecutive draws with the SAME texture set assert setBindGroup(1) ONCE; a different set re-binds', async () => {
    const ctx = await makeFacade()
    cleanup = ctx.cleanup
    const { facade, ops } = ctx
    facade.ensurePipeline(1, WGSL_TEX, [3], true)
    const texA = facade.createTexture(4, 4, 'rgba8unorm')
    const texB = facade.createTexture(4, 4, 'rgba8unorm')
    facade.beginPass(0)
    facade.usePipeline(1)
    facade.bindVertexBuffer(0, quad, 3)
    ops.length = 0
    facade.bindTexture(texA)
    facade.draw(3, 1)
    facade.bindTexture(texA)
    facade.draw(3, 1) // the same set — the group is already on the pass
    facade.bindTexture(texA)
    facade.draw(3, 1) // and again
    expect(ops.filter(o => o.startsWith('renderSetBindGroup(1,')).length).toBe(1)
    facade.bindTexture(texB)
    facade.draw(3, 1) // a different set — a real re-bind
    expect(ops.filter(o => o.startsWith('renderSetBindGroup(1,')).length).toBe(2)
    facade.bindTexture(texA)
    facade.draw(3, 1) // back to A — the group CHANGED since A was bound
    expect(ops.filter(o => o.startsWith('renderSetBindGroup(1,')).length).toBe(3)
    facade.endPass()
    facade.submit()
  })

  it('a fresh pass re-asserts the texture group (the memo is pass-scoped)', async () => {
    const ctx = await makeFacade()
    cleanup = ctx.cleanup
    const { facade, ops } = ctx
    facade.ensurePipeline(1, WGSL_TEX, [3], true)
    const texA = facade.createTexture(4, 4, 'rgba8unorm')
    facade.beginPass(0)
    facade.usePipeline(1)
    facade.bindTexture(texA)
    facade.draw(3, 1)
    facade.endPass()
    ops.length = 0
    facade.beginPass(0)
    facade.usePipeline(1)
    facade.bindTexture(texA)
    facade.draw(3, 1)
    facade.endPass()
    facade.submit()
    expect(ops.filter(o => o.startsWith('renderSetBindGroup(1,')).length).toBe(1)
  })
})
