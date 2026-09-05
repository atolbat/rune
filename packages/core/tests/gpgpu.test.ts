// Task 133 — the dual-backend GPGPU tier controller (@rune/core gpgpu.ts):
// the SSBO↔transform-feedback common point extracted from @rune/gl's
// particle orchestrators.
//
// Pinned here:
//   1. THE DISPATCH — createCompute → the SSBO tier, createTransformPass →
//      the TF tier, neither → a loud throw (no silent CPU fallback);
//      the real facade shapes satisfy the structural contracts.
//   2. THE LIFECYCLE — every tracked buffer/kernel/texture/pass is deleted
//      on dispose(), in REVERSE creation order (dependencies die before
//      their inputs), exactly once (idempotent); resources created after
//      a dispose are NOT tracked (a disposed controller stays dead).
//   3. THE UNIFORM SCRATCH — f32/u32 aliasing over one ArrayBuffer.
//   4. THE LEAK FIX — createKernel registers deleteCompute (the WebGPU
//      compute families' staging buffers died with nobody before Task 133).
//   5. THE GOLDENS — the simplex noise + hash01 moved from @rune/particles
//      bit-identically (the CPU↔GPU parity tables are pinned).

import { describe, expect, it } from 'bun:test'
import {
  createGpgpu, createSsboTier, createTfTier, createGpuScratch, GPU_BUFFER_USAGE,
  type TfComputeTier,
} from '../src/gpgpu.ts'
import { simplex3, PERM, GRAD3 } from '../src/noise.ts'
import { hash01 } from '../src/random.ts'
import { createRecordingGL } from '@rune/webgl2'

/** A minimal WebGPU-shaped backend (the five-method contract, recorded). */
function ssboBackend(log: string[]) {
  let next = 1
  return {
    createExternalBuffer: (byteLength: number, usage: number) => {
      const id = next++
      log.push(`createExternalBuffer(${byteLength},${usage})`)
      return id
    },
    writeExternalBuffer: (id: number) => log.push(`writeExternalBuffer(${id})`),
    createCompute: (wgsl: string, uniformBytes: number) => {
      const id = 100 + next++
      log.push(`createCompute(${uniformBytes})`)
      return id
    },
    runCompute: (id: number, entry: string) => log.push(`runCompute(${id},${entry})`),
    deleteCompute: (id: number) => log.push(`deleteCompute(${id})`),
    deleteExternalBuffer: (id: number) => log.push(`deleteExternalBuffer(${id})`),
  }
}

/** A minimal WebGL2-shaped backend (the TF family, recorded). */
function tfBackend(log: string[]) {
  let buf = 1, tex = 1, pass = 1
  return {
    createBuffer: (init: Float32Array, usage?: 'static' | 'dynamic') => { const id = buf++; log.push(`createBuffer(${init.length}${usage === 'dynamic' ? ',dynamic' : ''})`); return id },
    readBuffer: (id: number, dst: Float32Array) => { log.push(`readBuffer(${id},${dst.length})`); return true },
    updateBuffer: (id: number) => log.push(`updateBuffer(${id})`),
    createTexture: (w: number, h: number, opts?: { format?: string }) => {
      const id = tex++
      log.push(`createTexture(${w},${h},${opts?.format})`)
      return id
    },
    texSubImage2D: (id: number) => log.push(`texSubImage2D(${id})`),
    texSubImage2DBuffer: (id: number) => log.push(`texSubImage2DBuffer(${id})`),
    createTransformPass: (desc: { vertex: string }) => {
      const id = pass++
      log.push(`createTransformPass(${desc.vertex})`)
      return id
    },
    runTransformPass: (id: number, count: number) => log.push(`runTransformPass(${id},${count})`),
    deleteTransformPass: (id: number) => log.push(`deleteTransformPass(${id})`),
    deleteBuffer: (id: number) => log.push(`deleteBuffer(${id})`),
    deleteTexture: (id: number) => log.push(`deleteTexture(${id})`),
  }
}

describe('Task 133 — the dispatch (the common entry point)', () => {
  it('createCompute → the SSBO tier; createTransformPass → the TF tier; neither → a loud throw', () => {
    const ssbo = createGpgpu(ssboBackend([]))
    expect(ssbo.kind).toBe('ssbo')
    const tf = createGpgpu(tfBackend([]))
    expect(tf.kind).toBe('transform-feedback')
    expect(() => createGpgpu({})).toThrow('rune/core: createGpgpu needs a WebGPU compute facade')
    // createCompute wins when both shapes present (a WebGPU facade's own)
    const both = createGpgpu({ ...tfBackend([]), ...ssboBackend([]) })
    expect(both.kind).toBe('ssbo')
  })

  it('the REAL facade shapes satisfy the structural contracts (no adapter needed)', () => {
    // @rune/webgl2's recording facade speaks the TF family — the tier
    // wraps it directly (the reference consumer: gl's particlesGpuGl).
    const { gl } = createRecordingGL()
    const tier = createGpgpu(gl)
    expect(tier.kind).toBe('transform-feedback')
    expect(tier.backend === (gl as unknown as TfComputeTier['backend'])).toBe(true)
  })
})

describe('Task 133 — the tracked lifecycle (the control)', () => {
  it('SSBO: dispose deletes kernels and buffers in REVERSE creation order, once', () => {
    const log: string[] = []
    const tier = createSsboTier(ssboBackend(log))
    tier.createBuffer(64, GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_DST)
    tier.createKernel('wgsl', 16, [])
    tier.createBuffer(128, GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.VERTEX)
    log.length = 0
    tier.dispose()
    tier.dispose() // idempotent — the second call is a no-op
    expect(log).toEqual(['deleteExternalBuffer(3)', 'deleteCompute(102)', 'deleteExternalBuffer(1)'])
    expect(tier.createBuffer(64, 0)).toBeGreaterThan(0) // facade still alive; untracked (disposed set)
  })

  it('SSBO: the tracked resources forward to the facade verbatim', () => {
    const log: string[] = []
    const tier = createSsboTier(ssboBackend(log))
    const id = tier.createBuffer(256, GPU_BUFFER_USAGE.STORAGE)
    tier.writeBuffer(id, new Float32Array(4), 8, 16)
    tier.runKernel(5, 'advance', new Float32Array(4), 3)
    expect(log).toEqual([
      'createExternalBuffer(256,128)',
      'writeExternalBuffer(1)',
      'runCompute(5,advance)',
    ])
  })

  it('TF: dispose deletes passes, buffers and textures in REVERSE creation order, once', () => {
    const log: string[] = []
    const tier = createTfTier(tfBackend(log))
    tier.createBuffer(new Float32Array(8))
    tier.createTexture(64, 4, { format: 'rgba32f' })
    tier.createBuffer(new Float32Array(16))
    tier.createPass({ vertex: 'adv', outputs: ['v_a'] })
    tier.createPass({ vertex: 'pack', outputs: ['v_b'] })
    tier.createTexture(8, 1, { format: 'rgba32f' })
    log.length = 0
    tier.dispose()
    tier.dispose()
    expect(log).toEqual([
      'deleteTexture(2)',
      'deleteTransformPass(2)',
      'deleteTransformPass(1)',
      'deleteBuffer(2)',
      'deleteTexture(1)',
      'deleteBuffer(1)',
    ])
  })

  it('TF: the tracked calls forward verbatim (the recording-sequence contract)', () => {
    const log: string[] = []
    const tier = createTfTier(tfBackend(log))
    const buf = tier.createBuffer(new Float32Array(4))
    tier.updateBuffer(buf, new Float32Array(4))
    tier.texSubImage2D(1, 0, 0, 4, 1, new Float32Array(4))
    tier.texSubImage2DBuffer(1, 0, 0, 4, 1, buf, 0)
    const pass = tier.createPass({ vertex: 'v', outputs: ['o'] })
    tier.runPass(pass, 4, { bufferId: buf })
    expect(log.filter(c => !c.startsWith('create')).length).toBe(4)
    expect(log).toContain('updateBuffer(1)')
    expect(log).toContain('texSubImage2DBuffer(1)')
    expect(log).toContain('runTransformPass(1,4)')
  })
})

describe('Task 133 — the uniform scratch', () => {
  it('f32 + u32 alias one ArrayBuffer; zeroed; validates its size', () => {
    const s = createGpuScratch(8)
    expect(s.f32.length).toBe(8)
    expect(s.u32.length).toBe(8)
    expect(s.bytes.byteLength).toBe(32)
    s.f32[0] = 1.5
    expect(s.u32[0]).not.toBe(0) // the alias — an f32 write is visible through u32
    s.u32[1] = 7
    expect(s.f32[1]).not.toBe(0)
    expect(() => createGpuScratch(0)).toThrow('positive integer')
    expect(() => createGpuScratch(2.5)).toThrow('positive integer')
  })

  it('the GPU_BUFFER_USAGE bits are the spec values', () => {
    expect(GPU_BUFFER_USAGE.STORAGE).toBe(128)
    expect(GPU_BUFFER_USAGE.COPY_DST).toBe(8)
    expect(GPU_BUFFER_USAGE.VERTEX).toBe(32)
    expect(GPU_BUFFER_USAGE.UNIFORM).toBe(64)
  })
})

describe('Task 133 — the goldens (the bit-identical move from @rune/particles)', () => {
  it('simplex3: the pinned values (the CPU↔GPU parity contract)', () => {
    expect(simplex3(0, 0, 0)).toBe(0)
    expect(simplex3(1.7, -2.3, 0.6)).toBe(0.23123407999999998)
    expect(simplex3(-5.1, 3.2, 9.9)).toBe(-0.36491455789300326)
    expect(simplex3(100.25, -0.5, 7.125)).toBe(-0.5940350363413457)
    expect(simplex3(0.001, -0.002, 0.003)).toBe(0.00829362588309462)
    // range + determinism over a sweep
    for (let i = 0; i < 512; i++) {
      const v = simplex3(i * 0.1731, i * -0.2117, i * 0.1299)
      expect(Math.abs(v)).toBeLessThanOrEqual(1)
      expect(v).toBe(simplex3(i * 0.1731, i * -0.2117, i * 0.1299))
    }
  })

  it('PERM/GRAD3: the pinned table (the WGSL/GLSL twins bake this exact table)', () => {
    expect(PERM.length).toBe(512)
    expect(PERM[0]).toBe(157); expect(PERM[7]).toBe(43)
    expect(PERM[255]).toBe(243); expect(PERM[256]).toBe(157); expect(PERM[511]).toBe(243)
    expect(PERM[256]).toBe(PERM[0]) // the wrap
    expect(GRAD3.length).toBe(36)
    expect(GRAD3[0]).toBe(1); expect(GRAD3[35]).toBe(-1)
  })

  it('hash01: the pinned values (the spawning determinism contract)', () => {
    expect(hash01(1, 0, 1)).toBe(0.9172614980489016)
    expect(hash01(42, 17, 3)).toBe(0.27967720991000533)
    expect(hash01(-7, 999, 2147483647)).toBe(0.9190663595218211)
    expect(hash01(0, 0, 0)).toBe(0)
    for (let i = 0; i < 256; i++) {
      const v = hash01(i, i * 7, i * 13)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
      expect(v).toBe(hash01(i, i * 7, i * 13))
    }
  })
})
