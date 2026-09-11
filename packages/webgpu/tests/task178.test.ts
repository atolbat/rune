// Task 178 — THE UPLOAD WIRE (the WG half): the feed's dirty window, the
// merged uniform uploads, and the UBO-growth pipeline-survival contract.
//
// The pins:
//  1. THE FEED WINDOW — the GPU ends up holding EXACTLY the published
//     records' bytes (the dirty-window writes tile [0, published·stride)
//     with no hole and no repeat), and the bytes CROSSED are the appends'
//     sum — not the full prefixes (the pre-178 shape re-uploaded the whole
//     prefix every frame: O(total records) per frame, measured
//     1.95 MB/frame at 60k published in bench/ab-upload.ts).
//  2. THE MERGE — a frame's adjacent dirty slices coalesce into ONE
//     writeBuffer per run (gap < 256, the SliceArena dirtyRanges rule);
//     the GPU state is byte-identical to the per-command form (the union
//     coverage pin); far-apart slices stay separate calls; a LONE dirty
//     command rides the pre-178 call verbatim (no window argument).
//  3. THE BINDING WINDOW — a merged run passes the MAX per-slice window
//     (NOT ceil(merged length/256): the dynamic-offset range check needs
//     only the largest single block — a merged-length window overstates
//     and could push tail slices out of the buffer).
//  4. THE PIPELINE SURVIVAL — a UBO growth event must NOT wipe the
//     pipeline records: usePipeline keeps calling pass.setPipeline (the
//     pre-178 wipe left pipelineReady set with the record gone — the
//     executor never re-ran ensurePipeline, and usePipeline returned
//     SILENTLY: the pass kept the stale pipeline forever).
import { describe, expect, test } from 'bun:test'
import { createRecordingGPU, createSliceArena, createWgpuContext, compileWgslSpec, createGpuExecutor } from '../src/index.ts'
import type { WgpuDrawSpec, WgpuCommand, GPUFacade } from '../src/index.ts'
import { createTapeWriter, OpCode, writerView } from '@rune/core'
import { createRendererFeedGPU } from '../../gl/src/rendererFeed.ts'

// ────────────────────────── the materializing mocks ──────────────────────────

/** A GPU facade that MATERIALIZES uploadUniforms into a UBO image —
 *  the byte-level parity pin needs the actual bytes the GPU ends up with.
 *  Wraps the recording facade (the executor needs the full surface). */
function makeUboGpu(capacity = 1 << 16): { gpu: GPUFacade; ubo: Uint8Array; calls: string[] } {
  const recording = createRecordingGPU()
  const ubo = new Uint8Array(capacity)
  const calls: string[] = []
  const gpu = new Proxy(recording.gpu, {
    get(target, prop, receiver) {
      if (prop === 'uploadUniforms') {
        return (offset: number, data: Uint8Array, bindingWindow?: number) => {
          calls.push(bindingWindow === undefined
            ? `uploadUniforms(${offset},${data.length})`
            : `uploadUniforms(${offset},${data.length},${bindingWindow})`)
          ubo.set(data, offset)
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  }) as unknown as GPUFacade
  return { gpu, ubo, calls }
}

/** A GPU facade mock that materializes syncVertexBuffer into a vertex image. */
function makeVertexGpu(capacityBytes: number): {
  gpu: GPUFacade
  vram: Uint8Array
  bytesWritten: number
  calls: Array<{ len: number; off: number }>
} {
  const vram = new Uint8Array(capacityBytes)
  const calls: Array<{ len: number; off: number }> = []
  const gpu = {
    syncVertexBuffer(data: Float32Array, byteLength: number, byteOffset = 0): void {
      calls.push({ len: byteLength, off: byteOffset })
      vram.set(new Uint8Array(data.buffer, data.byteOffset + byteOffset, byteLength), byteOffset)
    },
  } as unknown as GPUFacade
  return {
    gpu,
    vram,
    get bytesWritten() { return calls.reduce((n, c) => n + c.len, 0) },
    calls,
  }
}

// ────────────────────────── 1. the feed window ──────────────────────────

describe('task178: the WG feed dirty window (O(append) per frame)', () => {
  const CAP = 1000
  const STRIDE = 16
  const W = 2048

  function makeFeed(gpu: GPUFacade) {
    const sab = new SharedArrayBuffer(64 + CAP * STRIDE)
    const u32 = new Uint32Array(sab)
    const bytes = new Float32Array(sab, 64, (CAP * STRIDE) / 4)
    const view = { feedId: 1, stride: STRIDE, capacity: CAP, count: () => Atomics.load(u32, 1), bytes: () => bytes, recycle: () => {} }
    return { feed: createRendererFeedGPU(gpu, view as never), bytes, u32 }
  }

  test('the writes TILE [0, published·stride): the GPU image equals the source for every published record', () => {
    const mock = makeVertexGpu(CAP * STRIDE)
    const { feed, bytes, u32 } = makeFeed(mock.gpu)
    let published = 0
    for (let frame = 0; frame < 12; frame++) {
      const append = 1 + (frame % 7) // varying appends
      for (let r = 0; r < append && published + r < CAP; r++) {
        const at = (published + r) * 4
        for (let f = 0; f < 4; f++) bytes[at + f] = published + r + f / 10
      }
      published = Math.min(CAP, published + append)
      Atomics.store(u32, 1, published)
      feed.sync()
      // after EVERY frame: the GPU image matches the source over the full
      // published prefix (the windows tile with no hole and no overlap)
      const src = new Uint8Array(bytes.buffer, bytes.byteOffset, published * STRIDE)
      expect(Array.from(mock.vram.subarray(0, published * STRIDE))).toEqual(Array.from(src))
    }
  })

  test('the bytes crossed are the APPENDS sum, not the full prefixes', () => {
    const mock = makeVertexGpu(CAP * STRIDE)
    const { feed, bytes, u32 } = makeFeed(mock.gpu)
    let published = 0
    let appended = 0
    for (let frame = 0; frame < 10; frame++) {
      const append = 5
      for (let r = 0; r < append && published + r < CAP; r++) {
        const at = (published + r) * 4
        bytes[at] = published + r
      }
      published = Math.min(CAP, published + append)
      appended += Math.min(append, CAP - (published - append))
      Atomics.store(u32, 1, published)
      feed.sync()
    }
    // the pre-178 shape crossed sum(prefix) = Σ published·stride ≈ 11× the
    // appends at this pattern; the window crosses exactly the appends
    expect(mock.bytesWritten).toBe(appended * STRIDE)
    expect(mock.calls.length).toBe(10)
  })

  test('a steady stream (no appends) crosses ZERO bytes', () => {
    const mock = makeVertexGpu(CAP * STRIDE)
    const { feed, u32 } = makeFeed(mock.gpu)
    Atomics.store(u32, 1, 100)
    feed.sync()
    const after = mock.bytesWritten
    feed.sync()
    feed.sync()
    feed.sync()
    expect(mock.bytesWritten).toBe(after)
  })
})

// ────────────────────────── 2/3. the merged uniforms ──────────────────────────

const WGSL_SMALL = `
struct Params { u_mvp: mat4x4<f32>, u_tint: vec4<f32>, u_alpha: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@vertex fn vs_main(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
  return params.u_mvp * vec4<f32>(position, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4<f32> { return params.u_tint; }`

const WGSL_BIG = `
struct Params { u_mvp: mat4x4<f32>, u_bones: array<vec4<f32>, 40>, u_tint: vec4<f32> }
@group(0) @binding(0) var<uniform> params: Params;
@vertex fn vs_main(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
  return params.u_mvp * vec4<f32>(position, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4<f32> { return params.u_tint; }`

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const

function smallSpec(tint: number[]): WgpuDrawSpec {
  return {
    shader: { wgsl: WGSL_SMALL },
    pipeline: { depth: { test: 'less', write: true } },
    uniforms: { u_mvp: () => IDENTITY, u_tint: tint, u_alpha: 0.8 },
    count: 3,
  }
}

/** A flat 160-lane bone palette (the writer's ArrayLike contract). */
const bonesFlat = new Float32Array(160)
for (let b = 0; b < 40; b++) bonesFlat[b * 4 + 3] = 1

function bigSpec(tint: number[]): WgpuDrawSpec {
  return {
    shader: { wgsl: WGSL_BIG },
    pipeline: { depth: { test: 'less', write: true } },
    // u_bones: a FLAT ArrayLike (the writer's lane contract — an
    // array-of-arrays would write NaN lanes and re-dirty every frame)
    uniforms: { u_mvp: () => IDENTITY, u_tint: tint, u_alpha: 0.8, u_bones: bonesFlat },
    count: 3,
  }
}

function recordFrame(commands: readonly WgpuCommand[], time: number): ReturnType<typeof writerView> {
  const writer = createTapeWriter(commands.length + 2)
  writer.emit(OpCode.BeginPass, 0, 0, 0, 0)
  for (const command of commands) command.record({}, { time, dt: 0.016, aspect: 1.5 }, writer)
  writer.emit(OpCode.EndPass, 0, 0, 0, 0)
  return writerView(writer)
}

// ────────────────────────── Task 179: the NaN guard ──────────────────────────

describe('task179: the NaN guard (a stable NaN lane stops re-dirtying the slice)', () => {
  test('a NaN-valued uniform uploads ONCE; NaN→number re-uploads (the per-frame re-upload leak is dead)', () => {
    const mock = makeUboGpu()
    const arena = createSliceArena(1 << 14)
    const ctx = createWgpuContext(arena)
    // the array-of-arrays hazard shape: a lane that resolves to NaN every
    // frame (the pre-179 fround(NaN) !== NaN compare re-dirtied the slice
    // EVERY frame — a silent per-frame writeBuffer)
    const tint = [NaN, 0, 0, 1]
    const command = compileWgslSpec({
      shader: { wgsl: WGSL_SMALL },
      pipeline: { depth: { test: 'less', write: true } },
      uniforms: { u_mvp: () => IDENTITY, u_tint: tint, u_alpha: 0.8 },
      count: 3,
    }, ctx)
    const executor = createGpuExecutor({ gpu: mock.gpu, arena, commands: ctx.commands, clears: [], context: ctx })
    // frame 1: born dirty — one upload (the NaN lands on the GPU)
    executor.run(recordFrame([command], 1))
    expect(mock.calls.length).toBe(1)
    // frames 2..4: the same NaN — STABLE, zero uploads
    executor.run(recordFrame([command], 2))
    executor.run(recordFrame([command], 3))
    executor.run(recordFrame([command], 4))
    expect(mock.calls.length).toBe(1)
    // a NaN→number transition — dirty again, one more upload
    tint[0] = 0.5
    executor.run(recordFrame([command], 5))
    expect(mock.calls.length).toBe(2)
  })
})

describe('task178: the merged uniform uploads', () => {
  test('three adjacent dirty slices coalesce into ONE call; the union coverage is byte-identical', () => {
    const mock = makeUboGpu()
    const arena = createSliceArena(1 << 14)
    const ctx = createWgpuContext(arena)
    const commands = [compileWgslSpec(smallSpec([1, 0, 0, 1]), ctx),
      compileWgslSpec(smallSpec([0, 1, 0, 1]), ctx),
      compileWgslSpec(smallSpec([0, 0, 1, 1]), ctx)]
    // slices: 0/256/512, used bytes 84 each — gaps 172 < 256 → ONE run
    const offsets = commands.map(c => (c as unknown as { sliceOffset: number }).sliceOffset)
    const executor = createGpuExecutor({ gpu: mock.gpu, arena, commands: ctx.commands, clears: [], context: ctx })
    executor.run(recordFrame(commands, 1))
    const views = commands.map(c => (c as unknown as { sliceView?: Uint8Array }).sliceView)
    // ONE upload for the whole run, window = max per-slice (256, NOT the
    // merged length's 512)
    expect(mock.calls).toEqual(['uploadUniforms(0,596,256)'])
    // the union coverage pin: every command's slice bytes on the GPU equal
    // the arena's bytes (the per-command form's own contract)
    for (let i = 0; i < commands.length; i++) {
      const offset = offsets[i]!
      const view = views[i]!
      expect(Array.from(mock.ubo.subarray(offset, offset + view.length))).toEqual(Array.from(arena.bytes.subarray(offset, offset + view.length)))
    }
  })

  test('far-apart dirty slices stay SEPARATE; a lone command rides the classic call verbatim', () => {
    const mock = makeUboGpu()
    const arena = createSliceArena(1 << 14)
    const ctx = createWgpuContext(arena)
    // A (small, offset 0, 84 used) — BIG (offset 256, 704+20 used, slice 768) — C (offset 1024, 84)
    const aTint = [1, 0, 0, 1]
    const cTint = [0, 0, 1, 1]
    const commands = [compileWgslSpec(smallSpec(aTint), ctx),
      compileWgslSpec(bigSpec([0, 1, 0, 1]), ctx),
      compileWgslSpec(smallSpec(cTint), ctx)]
    const executor = createGpuExecutor({ gpu: mock.gpu, arena, commands: ctx.commands, clears: [], context: ctx })
    // frame 1: ALL born-dirty — the run [0, 84) + [256, 980) + [1024, 1108)
    // merges (gaps 172/64 < 256): one call, window = max(256, 768) = 768
    executor.run(recordFrame(commands, 1))
    expect(mock.calls).toEqual(['uploadUniforms(0,1108,768)'])
    mock.calls.length = 0
    // frame 2: only A and C re-dirty (in-place mutations) — BIG stays clean;
    // A's and C's windows are 940 apart → TWO separate classic calls
    aTint[0] = 0.5
    cTint[2] = 0.5
    executor.run(recordFrame(commands, 2))
    expect(mock.calls).toEqual(['uploadUniforms(0,84)', 'uploadUniforms(1024,84)'])
  })

  test('the queue and the legacy walk merge IDENTICALLY (the sort makes collection order moot)', () => {
    const runWorld = (useQueue: boolean, reverseMarkOrder: boolean): string[] => {
      const mock = makeUboGpu()
      const arena = createSliceArena(1 << 14)
      const ctx = createWgpuContext(arena)
      const tints = [[1, 0, 0, 1], [0, 1, 0, 1], [0, 0, 1, 1]]
      const commands = tints.map(t => compileWgslSpec(smallSpec(t), ctx))
      const executor = createGpuExecutor({ gpu: mock.gpu, arena, commands: ctx.commands, clears: [], ...(useQueue ? { context: ctx } : {}) })
      // mark order REVERSED relative to the slice offsets: the merge sorts
      // by sliceOffset, so both drains produce the SAME ranges
      const order = reverseMarkOrder ? [commands[2]!, commands[0]!, commands[1]!] : commands
      executor.run(recordFrame(order, 1))
      return mock.calls
    }
    // the legacy walk + reversed tape order vs the queue + natural order:
    // identical merged output (the pre-178 form's per-command logs differed
    // by collection order in exactly this case)
    expect(runWorld(false, true).join('|')).toBe(runWorld(true, false).join('|'))
    expect(runWorld(true, true).join('|')).toBe(runWorld(false, false).join('|'))
  })
})

// ────────────────────────── 4. the pipeline survival ──────────────────────────

describe('task178: the UBO growth does NOT wipe the pipelines', () => {
  test('a growth event keeps usePipeline asserting setPipeline (the pre-178 silent-death pin)', async () => {
    // the device mock: createRenderPipeline is COUNTED — the wipe would
    // force a rebuild (or worse: the record gone + pipelineReady still
    // set → usePipeline's silent return, no setPipeline ever again)
    const setPipelineCalls: unknown[] = []
    let createRenderPipelineCalls = 0
    const device = {
      features: new Set(),
      limits: {},
      lost: new Promise(() => {}),
      addEventListener: () => {},
      createBuffer: (desc: { size: number }) => ({ ...desc, destroy: () => {} }),
      createTexture: () => ({ createView: () => ({}), destroy: () => {} }),
      createSampler: () => ({}),
      createBindGroupLayout: () => ({}),
      createBindGroup: () => ({}),
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => { createRenderPipelineCalls++; return {} },
      createCommandEncoder: () => ({
        beginRenderPass: () => ({
          setPipeline: (p: unknown) => setPipelineCalls.push(p),
          setBindGroup: () => {},
          setVertexBuffer: () => {},
          draw: () => {},
          end: () => {},
        }),
        finish: () => ({}),
      }),
      queue: { writeBuffer: () => {}, submit: () => {} },
    }
    const adapter = { features: new Set(), limits: {}, requestDevice: async () => device }
    const prevGpu = (navigator as unknown as { gpu?: unknown }).gpu
    ;(navigator as unknown as { gpu: unknown }).gpu = { requestAdapter: async () => adapter, getPreferredCanvasFormat: () => 'bgra8unorm' }
    const g = globalThis as Record<string, unknown>
    const prev = { GPUTextureUsage: g.GPUTextureUsage, GPUShaderStage: g.GPUShaderStage, GPUBufferUsage: g.GPUBufferUsage }
    g.GPUTextureUsage = { TEXTURE_BINDING: 4, COPY_DST: 8, RENDER_ATTACHMENT: 16 }
    g.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 }
    g.GPUBufferUsage = { UNIFORM: 0x40, COPY_DST: 8, VERTEX: 0x20 }
    try {
      const { createRealGPU } = await import('../src/realGPU.ts')
      const canvas = { width: 8, height: 8, getContext: (t: string) => (t === 'webgpu' ? { configure: () => {}, getCurrentTexture: () => ({ createView: () => ({}) }) } : null) }
      const gpu = await createRealGPU(canvas as never)
      gpu.ensurePipeline(1, WGSL_SMALL, [3], false, {})
      // the eager float+depth variant (buildPipeline at ensurePipeline) —
      // the depth-less twin builds lazily at the first usePipeline if the
      // canvas pass carries no depth attachment
      const builtAtCompile = createRenderPipelineCalls
      expect(builtAtCompile).toBe(1)
      gpu.beginPass(0)
      gpu.usePipeline(1)
      expect(setPipelineCalls.length).toBe(1)
      const builtAfterFirstUse = createRenderPipelineCalls
      // THE GROWTH EVENT: a tail upload whose span + window exceeds the
      // 64 KiB allocator minimum (65280 + 84 + 256 > 65536)
      gpu.uploadUniforms(65280, new Uint8Array(84))
      // the pre-178 wipe died here: pipelineRecords.length = 0 with
      // pipelineReady still true — usePipeline's record lookup found
      // undefined and returned SILENTLY (the pass kept the stale pipeline)
      gpu.usePipeline(1)
      expect(setPipelineCalls.length).toBe(2)
      // and NO rebuild happened (the pipeline objects survive the growth —
      // only the bind GROUP follows the new UBO)
      expect(createRenderPipelineCalls).toBe(builtAfterFirstUse)
    } finally {
      ;(navigator as unknown as { gpu: unknown }).gpu = prevGpu
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete g[k]
        else g[k] = v
      }
    }
  })
})
