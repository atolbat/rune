/**
 * Task 126: the group-1 layout must follow the DECLARED @binding numbers.
 *
 * The regression: a material whose texture set is not a prefix of 1..N —
 * SOFT_PARTICLES declares texTexture@1 + depthTexture@5 (the materials
 * reserve tex@1, nrm@2, mat@3, mr@4, depth@5). The old layout numbered the
 * entries SEQUENTIALLY (1..N = 1,2), so the shader's @binding(5) had no
 * entry → "Binding doesn't exist in [BindGroupLayoutInternal]" → an invalid
 * render pipeline → the error storm paused the renderer (the live soft
 * particles demo on WebGPU).
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { createRealGPU, group1TextureBindings } from '../src/realGPU.ts'
import { reflectWgsl } from '../src/wgslReflect.ts'

/** The SOFT_PARTICLES material shape: tex@1 + depth@5 (the {1, 5} set). */
const WGSL_SOFT = `
struct Params {
  u_mvp : mat4x4<f32>,
  u_model : mat4x4<f32>,
  u_softParams : vec4<f32>,
}
@group(0) @binding(0) var<uniform> params : Params;
@group(1) @binding(0) var texSampler : sampler;
@group(1) @binding(1) var texTexture : texture_2d<f32>;
@group(1) @binding(5) var depthTexture : texture_2d<f32>;
struct VSOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> }
@vertex fn vsMain(@location(0) position : vec3<f32>, @location(1) uv : vec2<f32>, @location(2) color : vec4<f32>) -> VSOut {
  var o : VSOut; o.uv = uv; o.pos = params.u_mvp * vec4<f32>(position, 1.0); return o;
}
struct FSIn { @location(0) uv : vec2<f32>, @builtin(position) pos : vec4<f32> }
@fragment fn fsMain(frag : FSIn) -> @location(0) vec4<f32> {
  let sceneZ = dot(textureSample(depthTexture, texSampler, frag.pos.xy).rgb, vec3<f32>(1.0, 0.0, 0.0));
  let texel = textureSample(texTexture, texSampler, frag.uv);
  return vec4<f32>(texel.rgb, texel.a * clamp(sceneZ, 0.0, 1.0));
}`

describe('Task 126: group-1 bindings follow the DECLARED @binding numbers', () => {
  it('group1TextureBindings: the {1, 5} set, declaration order', () => {
    expect(group1TextureBindings(WGSL_SOFT)).toEqual([1, 5])
  })

  it('group1TextureBindings: a prefix set stays sequential (back-compat)', () => {
    const wgsl = WGSL_SOFT.replace('@group(1) @binding(5) var depthTexture : texture_2d<f32>;', '')
    expect(group1TextureBindings(wgsl)).toEqual([1])
    const wgsl2 = wgsl.replace(
      '@group(1) @binding(1) var texTexture : texture_2d<f32>;',
      '@group(1) @binding(1) var texTexture : texture_2d<f32>;\n@group(1) @binding(2) var nrmTexture : texture_2d<f32>;',
    )
    expect(group1TextureBindings(wgsl2)).toEqual([1, 2])
  })

  it('group1TextureBindings: dedup + no @binding → the legacy [1] fallback', () => {
    // a duplicated binding number (a copy-paste in a hand-written shader)
    const dup = WGSL_SOFT.replace('@group(1) @binding(1) var texTexture', '@group(1) @binding(5) var texTexture')
    expect(group1TextureBindings(dup)).toEqual([5])
    // no @binding at all → the legacy single-texture contract
    expect(group1TextureBindings('@group(1) var t : texture_2d<f32>;')).toEqual([1])
    expect(group1TextureBindings('')).toEqual([1])
  })

  it('reflectWgsl: the texture info carries the declared binding', () => {
    const r = reflectWgsl(WGSL_SOFT)
    const names = r.textures.map(t => `${t.name}@${t.binding}:${t.kind}`)
    expect(names).toEqual(['texSampler@0:sampler', 'texTexture@1:texture_2d', 'depthTexture@5:texture_2d'])
  })

  // ── the full mock-device path: the pipeline LAYOUT and the BIND GROUP
  //    carry entries at 0 (sampler), 1 and 5 ─────────────────────────────
  const cleanups: Array<() => void> = []
  afterEach(() => { for (const c of cleanups.splice(0)) c() })

  function installMockGpu(): { calls: Record<string, unknown[]>; canvas: unknown; cleanup: () => void } {
    const calls: Record<string, unknown[]> = {
      bglLayouts: [],
      bindGroups: [] as Array<{ entries: Array<{ binding: number }>; layout: unknown }>,
      pipelineLayouts: [] as Array<{ bindGroupLayouts: unknown[] }>,
    }
    let nextId = 1
    const id = (): number => nextId++
    const device = {
      features: new Set(['float32-filterable']),
      limits: {},
      lost: new Promise(() => {}),
      addEventListener: () => {},
      createTexture: () => ({ createView: () => ({ viewId: id() }), destroy: () => {} }),
      createSampler: () => ({ samplerId: id() }),
      createBindGroupLayout: (desc: { entries: unknown[] }) => {
        const bgl = { bglId: id(), ...desc }
        calls.bglLayouts.push(bgl)
        return bgl
      },
      createBindGroup: (desc: { entries: Array<{ binding: number }> }) => {
        const bg = { bgId: id(), ...desc }
        calls.bindGroups.push(bg)
        return bg
      },
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createPipelineLayout: (desc: { bindGroupLayouts: unknown[] }) => {
        const pl = { plId: id(), ...desc }
        calls.pipelineLayouts.push(pl)
        return pl
      },
      createRenderPipeline: (desc: { layout: unknown }) => ({ pipelineId: id(), ...desc }),
      createCommandEncoder: () => ({
        beginRenderPass: () => ({
          setPipeline: () => {},
          setBindGroup: () => {},
          setVertexBuffer: () => {},
          draw: () => {},
          end: () => {},
          writeTimestamp: () => {},
        }),
        finish: () => ({}),
      }),
      queue: { writeTexture: () => {}, writeBuffer: () => {}, copyExternalImageToTexture: () => {}, submit: () => {} },
    }
    const adapter = { features: new Set(['timestamp-query']), limits: {}, requestDevice: async () => device }
    const gpuMock = { requestAdapter: async () => adapter, getPreferredCanvasFormat: () => 'bgra8unorm' }
    const canvas = {
      width: 64, height: 64,
      getContext: (type: string) =>
        type === 'webgpu' ? { configure: () => {}, getCurrentTexture: () => ({ createView: () => ({ viewId: id() }) }) } : null,
    }
    const nav = navigator as unknown as { gpu?: unknown }
    const prevGpu = nav.gpu
    ;(navigator as unknown as { gpu: unknown }).gpu = gpuMock
    const g = globalThis as Record<string, unknown>
    const prevGlobals = { GPUTextureUsage: g.GPUTextureUsage, GPUShaderStage: g.GPUShaderStage, GPUBufferUsage: g.GPUBufferUsage }
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

  it('the pipeline layout AND the bind group provide tex@1 + depth@5 (the {1,5} set)', async () => {
    const { calls, canvas, cleanup } = installMockGpu()
    cleanups.push(cleanup)
    const gpu = await createRealGPU(canvas as never)
    const atlas = gpu.createTexture(256, 256)
    const prepass = gpu.createTexture(640, 480)
    gpu.ensurePipeline(1, WGSL_SOFT, [3, 2, 4], true)
    gpu.beginPass(0)
    gpu.usePipeline(1)
    gpu.bindTexture(atlas)
    gpu.bindTexture(prepass)
    gpu.draw(6, 1)

    // THE PIPELINE LAYOUT: a group-1 BGL with entries at 0, 1, 5 — the old
    // sequential layout (0, 1, 2) is exactly the storm-pause regression
    const group1 = calls.pipelineLayouts.at(-1) as { bindGroupLayouts: Array<{ entries: Array<{ binding: number }> }> }
    const bgl = group1.bindGroupLayouts[1]
    expect(bgl.entries.map(e => e.binding)).toEqual([0, 1, 5])

    // THE BIND GROUP: sampler@0 + the FIRST texture at 1 + the SECOND at 5
    const bg = (calls.bindGroups as Array<{ entries: Array<{ binding: number; resource: { viewId?: number } }> }>).at(-1)!
    expect(bg.entries.map(e => e.binding)).toEqual([0, 1, 5])
    const views = bg.entries.filter(e => (e.resource as { viewId?: number }).viewId !== undefined)
    expect(views).toHaveLength(2)
    // the bind-group's own layout agrees (it mirrors the declared numbers)
    const bgLayout = (bg as unknown as { layout: { entries: Array<{ binding: number }> } }).layout
    expect(bgLayout.entries.map(e => e.binding)).toEqual([0, 1, 5])
  })
})
