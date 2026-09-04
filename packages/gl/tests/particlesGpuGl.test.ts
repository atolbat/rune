// Task 132 — the WebGL2 TRANSFORM-FEEDBACK GPU tier (the SSBO's twin).
//
// Pinned here:
//   1. THE GLSL GENERATION — the ES 3.00 headers, the baked tables, the
//      outputs/uniforms matching the declaration contract, no reserved
//      words (`half` is reserved in GLSL ES 3.00 — a regression class the
//      browser would only report at run time).
//   2. THE PROVENANCE MAP — the golden test: a sim:'gpu' facade whose
//      particles' positions ENCODE THEIR OWN PRE-COMPACTION SLOTS; after
//      deaths + newborns + compaction, gpuGlProvenance must return exactly
//      the pre-slot of each live particle (prov[j] === fields.px[j]).
//   3. THE STEP SEQUENCE — the recording facade: the emit upload, the map
//      update, the two passes, the PBO round-trip — in order, with the
//      right shapes.
//   4. THE DISPATCH — createGpuParticles routes the GL facade to the TF
//      tier (the common point).

import { describe, expect, it, test } from 'bun:test'
import { createRecordingGL } from '@rune/webgl2'
import { createTfTier } from '@rune/core'
import {
  createParticles,
  gpuSimGlAdvanceGlsl,
  gpuSimGlPackGlsl,
  gpuRampLUTTexture,
  gpuGlStateTextureH,
  GPU_GL_ADVANCE_UNIFORMS,
  GPU_GL_PACK_UNIFORMS,
  GPU_GL_STATE_TEXTURE_W,
  INSTANCE_STRIDE,
} from '@rune/particles'
import { createGpuParticles } from '../src/particlesGpu.ts'
import { gpuGlProvenance, createGpuParticlesTf } from '../src/particlesGpuGl.ts'

describe('Task 132 — the GLSL generation (gpuSimGl)', () => {
  test('advance: the ES 3.00 header, the baked tables, the uniform set, no reserved words', () => {
    const src = gpuSimGlAdvanceGlsl()
    expect(src.startsWith('#version 300 es\n')).toBe(true)
    expect(src).toContain('uniform highp sampler2D u_state;')
    // the same perm table the CPU/WGSL evaluate (512 entries, baked)
    expect(src).toContain('const uint PERM_T[512] = uint[512](')
    expect(src).toContain('const vec3 GRAD_T[12] = vec3[12](')
    // every declared uniform name is present
    for (const u of GPU_GL_ADVANCE_UNIFORMS) {
      expect(src).toContain(`uniform ${u.size === 3 ? 'vec3' : 'float'} ${u.name};`)
    }
    // the gather attribute + the five TF outputs
    expect(src).toContain('in float a_map;')
    for (const out of ['v_s0', 'v_s1', 'v_s2', 'v_s3', 'v_s4']) {
      expect(src).toContain(`out vec4 ${out};`)
    }
    // `half` is RESERVED in GLSL ES 3.00 — must never appear as an identifier
    expect(/\bfloat half\b/.test(src)).toBe(false)
    // the force walk order (the WGSL twin's own)
    const iDrag = src.indexOf('u_fDrag > 0.5')
    const iLimit = src.indexOf('u_fLimit > 0.5')
    const iGravity = src.indexOf('u_fGravity > 0.5')
    const iAttract = src.indexOf('u_fAttract > 0.5')
    const iTurb = src.indexOf('u_fTurb > 0.5')
    const iNoise = src.indexOf('u_fNoise > 0.5')
    expect(iDrag).toBeGreaterThan(0)
    expect(iLimit).toBeGreaterThan(iDrag)
    expect(iGravity).toBeGreaterThan(iLimit)
    expect(iAttract).toBeGreaterThan(iGravity)
    expect(iTurb).toBeGreaterThan(iAttract)
    expect(iNoise).toBeGreaterThan(iTurb)
  })

  test('pack: gl_VertexID addresses the element, the ramp LUT walk, the record rows', () => {
    const src = gpuSimGlPackGlsl()
    expect(src.startsWith('#version 300 es\n')).toBe(true)
    expect(src).toContain('int i = gl_VertexID;')
    for (const u of GPU_GL_PACK_UNIFORMS) {
      expect(src).toContain(`uniform float ${u.name};`)
    }
    for (const out of ['v_r0', 'v_r1', 'v_r2', 'v_r3']) {
      expect(src).toContain(`out vec4 ${out};`)
    }
    expect(/\bfloat half\b/.test(src)).toBe(false)
    // the record contract: the angle0 = seed·tau, the tile math
    expect(src).toContain('seed * 6.283185307179586')
    expect(src).toContain('mod(fr, u_tileU) / u_tileU')
  })

  test('the ramp LUT texture: 8 floats per point (2 texels), the caps', () => {
    const lut = gpuRampLUTTexture([
      { t: 0, size: 1, r: 1, g: 0.9, b: 0.8, a: 0.7, frame: 3 },
      { t: 1, size: 0.5, r: 0.4, g: 0.3, b: 0.2, a: 0.1 },
    ])
    expect(lut.length).toBe(16)
    expect(lut[0]).toBe(0); expect(lut[1]).toBe(1); expect(lut[6]).toBe(3)
    expect(() => gpuRampLUTTexture([])).toThrow('at least one point')
    expect(() => gpuRampLUTTexture(new Array(257).fill({ t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 }))).toThrow('capped at 256')
  })

  test('the state texture height: ceil(capacity·5 / W), at least 1 row', () => {
    expect(gpuGlStateTextureH(1)).toBe(1)
    expect(gpuGlStateTextureH(Math.floor(GPU_GL_STATE_TEXTURE_W / 5))).toBe(1)
    expect(gpuGlStateTextureH(Math.floor(GPU_GL_STATE_TEXTURE_W / 5) + 1)).toBe(2)
  })
})

describe('Task 132 — the provenance map (the golden test)', () => {
  it('prov[j] === the pre-slot of the particle that ends up at slot j (deaths + newborns)', () => {
    // A sim:'gpu' facade — the CPU keeps emission + death + compaction.
    // Positions ENCODE their own pre-compaction slot (px[i] = i), so after
    // any compaction the post-compaction px[j] IS the pre-slot of the live
    // particle at slot j — the exact value prov[j] must produce.
    const facade = createParticles({
      capacity: 16,
      render: { kind: 'billboard', draw: 'instance' },
      sim: 'gpu',
    })
    const ho = facade.gpuHandoff!
    ho.attached = true // a bare attach — the orchestrator is not needed for the CPU half
    facade.burst(8, { shape: { kind: 'point', origin: [0, 0, 0] }, velocity: { mode: 'fixed', dir: [0, 1, 0] }, speed: [0, 0], life: [100, 100], size: [1, 1], color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 1 })
    const f = facade.fields
    for (let i = 0; i < 8; i++) { f.px[i] = i; f.life[i] = 100 } // age 0 → long lives
    // kill slots 2, 5, 7 (they die during the next advance)
    f.life[2] = 0.001; f.life[5] = 0.001; f.life[7] = 0.001
    facade.advance(0.016)
    expect(facade.count).toBe(5) // 8 − 3 dead
    // a MANUAL burst between advances (the Task 132 catch-up story: the
    // handoff must still see these rows) — the newborns encode their slots
    facade.burst(3, { shape: { kind: 'point', origin: [0, 0, 0] }, velocity: { mode: 'fixed', dir: [0, 1, 0] }, speed: [0, 0], life: [100, 100], size: [1, 1], color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 2 })
    for (let i = 5; i < 8; i++) { f.px[i] = i; f.life[i] = 100 }
    f.life[1] = 0.001 // another death among the old guard
    // the PRE-compaction snapshot (after the burst, before the advance) —
    // the invariant: pxBefore[prov[j]] === pxAfter[j] (the gather's source
    // slot holds exactly the particle that ends up at slot j)
    const pxBefore = Array.from(f.px.slice(0, 8))
    facade.advance(0.016)
    // THE CATCH-UP: the manual burst's rows ARE in the handoff (the
    // between-advance burst was the silent-loss hole before Task 132)
    expect(ho.emitBase).toBe(5) // the previous advance's synced count
    expect(ho.emitCount).toBe(3) // the manual burst's catch-up
    // THE CHECK: the provenance of THIS advance maps each live post-slot
    // to the pre-slot that holds its data
    const prov = new Int32Array(16)
    const preCount = ho.emitBase + ho.emitCount
    gpuGlProvenance(preCount, ho.swaps, ho.swapCount, prov)
    for (let j = 0; j < facade.count; j++) {
      expect(pxBefore[prov[j]]).toBe(f.px[j])
    }
  })

  it('no swaps — the identity map', () => {
    const prov = new Int32Array(8)
    gpuGlProvenance(5, new Uint32Array(0), 0, prov)
    expect(Array.from(prov.subarray(0, 5))).toEqual([0, 1, 2, 3, 4])
  })
})

describe('Task 132 — the TF orchestrator (the recording sequence)', () => {
  it('step: the emit upload → the map update → compact+advance → the PBO round-trip → pack', () => {
    const { gl, calls } = createRecordingGL()
    const facade = createParticles({
      capacity: 12,
      ramp: { points: [{ t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 }] } as never,
      render: { kind: 'billboard', draw: 'instance' },
      sim: 'gpu',
    })
    const backend = createGpuParticlesTf(facade, createTfTier(gl))
    // THE MANUAL BURST between advances — the catch-up path (Task 132): the
    // rows MUST reach the handoff on the next advance
    facade.burst(4, { shape: { kind: 'point', origin: [0, 0, 0] }, velocity: { mode: 'fixed', dir: [0, 1, 0] }, speed: [0, 0], life: [100, 100], size: [1, 1], color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 1 })
    facade.advance(0.016)
    calls.length = 0
    backend.step(0.016)
    const seq = calls.join('\n')
    // the emit block: the texel range [0, 20) of the state texture — one row rect
    expect(seq).toContain('texSubImage2D(1,0,0,20,1)')
    // the map: buffer 3, 4 entries, offset 0
    expect(seq).toContain('updateBuffer(3,4,0)')
    // compact+advance: pass 1, 4 verts, out buffer 1, map attrib, state texture, 29 uniforms
    expect(seq).toContain('runTransformPass(1,4,buf:1,a:1,t:1,u:29)')
    // the PBO round-trip: the whole texture from the state buffer 2
    const H = gpuGlStateTextureH(12)
    expect(seq).toContain(`texSubImage2DBuffer(1,0,0,${GPU_GL_STATE_TEXTURE_W},${H},buf:1,off:0)`)
    // pack: pass 2, 4 verts, records buffer 2, 2 textures, 4 uniforms
    expect(seq).toContain('runTransformPass(2,4,buf:2,t:2,u:4)')
    // THE ORDER: emit → map → advance → round-trip → pack
    const order = [
      seq.indexOf('texSubImage2D(1,0,0,20,1)'),
      seq.indexOf('updateBuffer(3,4,0)'),
      seq.indexOf('runTransformPass(1,4'),
      seq.indexOf('texSubImage2DBuffer(1,'),
      seq.indexOf('runTransformPass(2,4'),
    ]
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1])
  })

  it('the records buffer is the draw-facing contract (stride 64 = INSTANCE_STRIDE)', () => {
    const { gl } = createRecordingGL()
    const facade = createParticles({
      capacity: 4,
      render: { kind: 'billboard', draw: 'instance' },
      sim: 'gpu',
    })
    const backend = createGpuParticlesTf(facade, createTfTier(gl))
    expect(backend.recordsBufferId).toBeGreaterThan(0)
    // the record contract: 16 floats — the BILLBOARD material's instance layout
    expect(INSTANCE_STRIDE).toBe(16)
  })

  it('dispose is clean and the handoff detaches', () => {
    const { gl, calls } = createRecordingGL()
    const facade = createParticles({
      capacity: 4,
      render: { kind: 'billboard', draw: 'instance' },
      sim: 'gpu',
    })
    const backend = createGpuParticlesTf(facade, createTfTier(gl))
    expect(facade.gpuHandoff!.attached).toBe(true)
    backend.dispose()
    expect(facade.gpuHandoff!.attached).toBe(false)
    expect(calls.filter(c => c.startsWith('deleteTransformPass(')).length).toBe(2)
  })

  it('createGpuParticles dispatches the GL facade to the TF tier (the common point)', () => {
    const { gl } = createRecordingGL()
    const facade = createParticles({
      capacity: 4,
      render: { kind: 'billboard', draw: 'instance' },
      sim: 'gpu',
    })
    const backend = createGpuParticles(facade, gl) // the GL shape → the TF tier
    expect(typeof backend.step).toBe('function')
    // the recording facade has no createCompute — a non-GPU, non-GL object
    // throws (the core controller's dispatch error)
    expect(() => createGpuParticles(facade, {} as never)).toThrow('needs a WebGPU compute facade')
  })
})
