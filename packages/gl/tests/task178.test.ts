// Task 178 — THE UPLOAD WIRE (the GL TF half): the live-prefix round-trips
// and the map's identity skip.
//
// The pre-178 shape round-tripped CAPACITY-scaled textures every frame:
//   • the state texture: ALL H rows (H = ceil(capacity·5/2048)) — 12.5
//     MiB/frame at a 160k capacity regardless of the live count;
//   • the pairs texture: ALL pairsH rows after sortKeys AND after every
//     bitonic pass (171 passes × 4 MiB at the 160k demo ≈ 686 MiB/frame of
//     driver traffic with a 5k live count — the audit's top GL number);
//   • the map buffer: count×4 bytes re-uploaded every frame even when the
//     provenance is the identity (a swap-free frame — the steady stream).
//
// The live prefix is safe because every reader is confined to the fresh
// union: the next advance reads [0, preCount) = [0, count) ∪ [emitBase,
// preCount) (the round-trip's rows + the emit upload's rows — the emitBase
// IS the post-compaction count, the facade's own gpuSynced contract); the
// sortKeys guard `i < u_count` and the packSorted sentinel guard confine
// the render tier to [0, count). These tests pin the arithmetic at the
// boundaries where the row count flips.
import { describe, expect, it } from 'bun:test'
import { createRecordingGL } from '@rune/webgl2'
import { createTfTier } from '@rune/core'
import { createParticles, GPU_GL_STATE_TEXTURE_W, GPU_GL_TEXELS_PER_PARTICLE, gpuGlStateTextureH, gpuGlPairsTextureH } from '@rune/particles'
import { createGpuParticlesTf } from '../src/particlesGpuGl.ts'
import { bitonicPadCount } from '@rune/core'

const W = GPU_GL_STATE_TEXTURE_W

function makeFacade(capacity: number, extra: Record<string, unknown> = {}): ReturnType<typeof createParticles> {
  return createParticles({
    capacity,
    ramp: { points: [{ t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 }] } as never,
    render: { kind: 'billboard', draw: 'instance' },
    sim: 'gpu',
    ...extra,
  })
}

function burst(facade: ReturnType<typeof createParticles>, n: number, life = 100): void {
  facade.burst(n, {
    shape: { kind: 'point', origin: [0, 0, 0] },
    velocity: { mode: 'fixed', dir: [0, 1, 0] },
    speed: [0, 0],
    life: [life, life],
    size: [1, 1],
    color: [[1, 1, 1, 1], [1, 1, 1, 1]],
    seed: 1,
  })
}

/** The live rows the state round-trip must copy for a live count. */
function liveStateRows(count: number): number {
  return Math.max(1, Math.ceil((count * GPU_GL_TEXELS_PER_PARTICLE) / W))
}

describe('task178: the state round-trip is LIVE-PREFIX (rows track count, not capacity)', () => {
  it('a 100-count frame at a 5000 capacity copies 1 row, not H=13', () => {
    const { gl, calls } = createRecordingGL()
    const facade = makeFacade(5000)
    const backend = createGpuParticlesTf(facade, createTfTier(gl))
    burst(facade, 100)
    facade.advance(0.016)
    calls.length = 0
    backend.step(0.016)
    const seq = calls.join('\n')
    expect(gpuGlStateTextureH(5000)).toBe(13) // the capacity-scaled allocation
    // the round-trip copies ONLY the rows the advance TF wrote: 100·5=500
    // texels → 1 row
    expect(seq).toContain(`texSubImage2DBuffer(1,0,0,${W},1,buf:1,off:0)`)
    expect(seq).not.toContain(`texSubImage2DBuffer(1,0,0,${W},13,`)
  })

  it('the row count flips at the W/5 boundary: 409 particles → 1 row, 410 → 2 rows', () => {
    const { gl, calls } = createRecordingGL()
    const facade = makeFacade(5000)
    const backend = createGpuParticlesTf(facade, createTfTier(gl))
    burst(facade, 409)
    facade.advance(0.016)
    calls.length = 0
    backend.step(0.016)
    expect(calls.join('\n')).toContain(`texSubImage2DBuffer(1,0,0,${W},1,buf:1,off:0)`) // 2045 texels ≤ 2048
    calls.length = 0
    burst(facade, 1) // 410·5 = 2050 texels — the second row begins
    facade.advance(0.016)
    backend.step(0.016)
    expect(calls.join('\n')).toContain(`texSubImage2DBuffer(1,0,0,${W},2,buf:1,off:0)`)
  })

  it('the count can grow across many frames: the rows track the live count each frame', () => {
    const { gl, calls } = createRecordingGL()
    const facade = makeFacade(5000)
    const backend = createGpuParticlesTf(facade, createTfTier(gl))
    for (let frame = 0; frame < 10; frame++) {
      burst(facade, 100)
      facade.advance(0.016)
      calls.length = 0
      backend.step(0.016)
      const count = (frame + 1) * 100
      expect(calls.join('\n')).toContain(`texSubImage2DBuffer(1,0,0,${W},${liveStateRows(count)},buf:1,off:0)`)
    }
  })
})

describe('task178: the pairs round-trips are LIVE-PREFIX (padN rows, not pairsH)', () => {
  const VP = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  const CAMERA = { forward: [0, 0, -1], viewProj: VP }

  it('the pairs texture is allocated capacity-scaled, but the round-trips copy padN rows', () => {
    const { gl, calls } = createRecordingGL()
    const facade = makeFacade(5000, { render: { kind: 'billboard', draw: 'instance', sort: true, cull: true } })
    const backend = createGpuParticlesTf(facade, createTfTier(gl))
    // capacity 5000 → pairsH = ceil(8192/2048) = 4 rows allocated
    expect(gpuGlPairsTextureH(5000)).toBe(4)
    expect(calls.some(c => c === `createTexture(${W},4,rgba32f)`)).toBe(true)
    burst(facade, 300)
    facade.advance(0.016)
    calls.length = 0
    backend.step(0.016, CAMERA)
    const seq = calls.join('\n')
    // 300 live → padN = 512 → ONE row per round-trip (not 4)
    expect(bitonicPadCount(300)).toBe(512)
    expect(seq.match(/texSubImage2DBuffer\(3,0,0,2048,1,buf:4,off:0\)/g)).not.toBeNull()
    expect(seq).not.toContain('texSubImage2DBuffer(3,0,0,2048,4,')
    // and the pass still runs the FULL padded network (512 verts)
    expect(seq).toContain('runTransformPass(3,512,buf:4,t:1,u:30)')
  })
})

describe('task178: the map upload skips the identity (a swap-free frame)', () => {
  it('burst → upload; steady frames → ZERO map uploads; growth → upload; deaths (swaps) → upload', () => {
    const { gl, calls } = createRecordingGL()
    const facade = makeFacade(200)
    const backend = createGpuParticlesTf(facade, createTfTier(gl))
    burst(facade, 50)
    facade.advance(0.016)
    calls.length = 0
    backend.step(0.016)
    expect(calls.join('\n')).toContain('updateBuffer(3,50,0)') // the burst frame's map
    // a STEADY frame: no newborns, no deaths — the provenance is the
    // identity and the GPU already holds it → the map upload is SKIPPED
    calls.length = 0
    facade.advance(0.016)
    backend.step(0.016)
    expect(calls.filter(c => c.startsWith('updateBuffer(3,')).length).toBe(0)
    // ...and the frame still runs (the advance pass is there)
    expect(calls.join('\n')).toContain('runTransformPass(1,50,')
    // MORE steady frames — still zero (the skip is stable, not one-shot)
    for (let i = 0; i < 3; i++) {
      calls.length = 0
      facade.advance(0.016)
      backend.step(0.016)
      expect(calls.filter(c => c.startsWith('updateBuffer(3,')).length).toBe(0)
    }
    // GROWTH: the count outgrows what the GPU's identity prefix covers
    calls.length = 0
    burst(facade, 10)
    facade.advance(0.016)
    backend.step(0.016)
    expect(calls.join('\n')).toContain('updateBuffer(3,60,0)')
    // DEATHS WITH SWAPS: the dead must sit BEFORE live particles (a dead
    // TAIL just truncates the count — zero swaps, the identity map stays
    // valid and the skip is CORRECT). Interleave: short-lived first, then
    // long-lived — the expiry compacts the survivors DOWN over the dead
    // slots → real swaps → the map is NOT the identity → the upload returns
    calls.length = 0
    burst(facade, 20, 0.02) // dies within 0.02s (slots 60..79)
    burst(facade, 10) // long-lived (slots 80..89) — compacts DOWN over the dead
    facade.advance(0.016)
    backend.step(0.016)
    expect(calls.join('\n')).toContain('updateBuffer(3,90,0)') // the growth frame
    facade.advance(0.1) // the expiry: 20 die, the 10 compact down (10 swaps)
    calls.length = 0
    backend.step(0.016)
    const seq = calls.join('\n')
    expect(calls.filter(c => c.startsWith('updateBuffer(3,')).length).toBe(1) // the swap map
    expect(seq).toContain('runTransformPass(1,70,') // 70 survivors compacted
    // the first steady frame after the swap RESTORES the identity (the GPU
    // map still holds the swap map; this frame's prov is the identity —
    // one upload, and the state machine re-arms the identity)
    calls.length = 0
    facade.advance(0.016)
    backend.step(0.016)
    expect(calls.filter(c => c.startsWith('updateBuffer(3,')).length).toBe(1)
    // and every steady frame AFTER THAT skips again (the identity holds)
    for (let i = 0; i < 2; i++) {
      calls.length = 0
      facade.advance(0.016)
      backend.step(0.016)
      expect(calls.filter(c => c.startsWith('updateBuffer(3,')).length).toBe(0)
    }
  })
})
