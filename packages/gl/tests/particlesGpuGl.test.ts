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
  gpuSimGlSortKeysGlsl,
  gpuSimGlBitonicGlsl,
  gpuSimGlPackSortedGlsl,
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

describe('Task 134 — the TF render tier (sort/cull pipeline)', () => {
  // A column-major view-projection of ANY valid shape (the recording
  // facade doesn't evaluate it — the orchestrator only extracts planes).
  const VP = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -10, 1]
  const CAMERA = { forward: [0, 0, -1], viewProj: VP }

  function burst4(facade: ReturnType<typeof createParticles>): void {
    facade.burst(4, { shape: { kind: 'point', origin: [0, 0, 0] }, velocity: { mode: 'fixed', dir: [0, 1, 0] }, speed: [0, 0], life: [100, 100], size: [1, 1], color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 1 })
  }

  it('sort+cull: sortKeys → the bitonic (k, j) passes → the sorted pack', () => {
    const { gl, calls } = createRecordingGL()
    const facade = createParticles({
      capacity: 12,
      ramp: { points: [{ t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 }] } as never,
      render: { kind: 'billboard', draw: 'instance', sort: true, cull: true },
      sim: 'gpu',
    })
    const backend = createGpuParticlesTf(facade, createTfTier(gl))
    burst4(facade)
    facade.advance(0.016)
    calls.length = 0
    backend.step(0.016, CAMERA)
    const seq = calls.join('\n')
    // the sim half is UNCHANGED: emit → map → compact+advance → the state PBO
    expect(seq).toContain('runTransformPass(1,4,buf:1,a:1,t:1,u:29)')
    expect(seq).toContain(`texSubImage2DBuffer(1,0,0,${GPU_GL_STATE_TEXTURE_W},${gpuGlStateTextureH(12)},buf:1,off:0)`)
    // 5a. sortKeys: pass 3, padN=4 verts, the pairs output buffer 4, the
    // state texture, 30 uniforms — then the pairs PBO round-trip
    expect(seq).toContain('runTransformPass(3,4,buf:4,t:1,u:30)')
    // 5b. the bitonic network: N=4 → THREE passes (k=2,j=1; k=4,j=2; k=4,j=1)
    expect(seq.match(/runTransformPass\(4,4,buf:4,t:1,u:2\)/g)).toHaveLength(3)
    // the pairs PBO after sortKeys AND after every bitonic pass (4 total)
    expect(seq.match(/texSubImage2DBuffer\(3,0,0,2048,1,buf:4,off:0\)/g)).toHaveLength(4)
    // 5c. the sorted pack: pass 5, count=4 verts, the records buffer 2,
    // three textures (state + ramp + pairs), 4 uniforms
    expect(seq).toContain('runTransformPass(5,4,buf:2,t:3,u:4)')
    // THE ORDER: advance → state PBO → sortKeys → pairs PBO → bitonic×3 → packSorted
    const order = [
      seq.indexOf('runTransformPass(1,4'),
      seq.indexOf('texSubImage2DBuffer(1,'),
      seq.indexOf('runTransformPass(3,4'),
      seq.indexOf('runTransformPass(5,4'),
    ]
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1])
  })

  it('cull only: sortKeys + the sorted pack, NO bitonic passes (the cheap gate)', () => {
    const { gl, calls } = createRecordingGL()
    const facade = createParticles({
      capacity: 12,
      ramp: { points: [{ t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 }] } as never,
      render: { kind: 'billboard', draw: 'instance', cull: true },
      sim: 'gpu',
    })
    const backend = createGpuParticlesTf(facade, createTfTier(gl))
    burst4(facade)
    facade.advance(0.016)
    calls.length = 0
    backend.step(0.016, CAMERA)
    const seq = calls.join('\n')
    expect(seq).toContain('runTransformPass(3,4,buf:4,t:1,u:30)')
    expect(seq).toContain('runTransformPass(5,4,buf:2,t:3,u:4)')
    expect(seq).not.toContain('runTransformPass(4,') // no bitonic pass
    expect(seq.match(/texSubImage2DBuffer\(3,/g)).toHaveLength(1) // ONE pairs round-trip
  })

  it('the camera contracts are loud (sort without forward, cull without viewProj)', () => {
    const { gl } = createRecordingGL()
    const sortFacade = createParticles({
      capacity: 12,
      ramp: { points: [{ t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 }] } as never,
      render: { kind: 'billboard', draw: 'instance', sort: true },
      sim: 'gpu',
    })
    const sortBackend = createGpuParticlesTf(sortFacade, createTfTier(gl))
    burst4(sortFacade)
    sortFacade.advance(0.016)
    expect(() => sortBackend.step(0.016)).toThrow('render.sort needs the camera forward')
    expect(() => sortBackend.step(0.016, { forward: [0, 0, -1] })).not.toThrow() // sort alone: no viewProj needed

    const cullFacade = createParticles({
      capacity: 12,
      ramp: { points: [{ t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 }] } as never,
      render: { kind: 'billboard', draw: 'instance', cull: true },
      sim: 'gpu',
    })
    const cullBackend = createGpuParticlesTf(cullFacade, createTfTier(gl))
    burst4(cullFacade)
    cullFacade.advance(0.016)
    expect(() => cullBackend.step(0.016)).toThrow('render.cull needs the view-projection')
    expect(() => cullBackend.step(0.016, { forward: [0, 0, -1] })).toThrow('render.cull needs the view-projection')
    expect(() => cullBackend.step(0.016, CAMERA)).not.toThrow()
  })

  it('dispose tears the sort family down too (2 + 3 passes)', () => {
    const { gl, calls } = createRecordingGL()
    const facade = createParticles({
      capacity: 12,
      ramp: { points: [{ t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 }] } as never,
      render: { kind: 'billboard', draw: 'instance', sort: true, cull: true },
      sim: 'gpu',
    })
    const backend = createGpuParticlesTf(facade, createTfTier(gl))
    backend.dispose()
    expect(calls.filter(c => c.startsWith('deleteTransformPass(')).length).toBe(5)
  })
})

describe('Task 134 — the GLSL generation (the sort family)', () => {
  it('sortKeys/bitonic/packSorted: the headers, the uniforms, the sentinel contract', () => {
    const sk = gpuSimGlSortKeysGlsl()
    expect(sk.startsWith('#version 300 es\n')).toBe(true)
    expect(sk).toContain('uniform highp sampler2D u_state;')
    expect(sk).toContain('uniform vec4 u_p5;')
    expect(sk).toContain('out vec4 v_pair;')
    expect(sk).toContain('const float SENTINEL = 33554432.0;')
    const bt = gpuSimGlBitonicGlsl()
    expect(bt).toContain('int p = i ^ int(u_j + 0.5);')
    expect(bt).toContain('bool asc = (i & int(u_k + 0.5)) == 0;')
    expect(bt).toContain('if (i < p) { v_pair = asc ? lo : hi; } else { v_pair = asc ? hi : lo; }')
    const ps = gpuSimGlPackSortedGlsl()
    expect(ps).toContain('vec4 pr = texelFetch(u_pairs, texelOf(i), 0);')
    expect(ps).toContain('if (pr.y >= 33554432.0)')
    expect(ps).toContain('int slot = int(pr.y + 0.5);')
    expect(ps).toContain('uniform highp sampler2D u_pairs;')
    // no reserved words in any of the three sources (`half` and `flat`
    // are reserved in GLSL ES 3.00 — the browser-only regression class)
    for (const src of [sk, bt, ps]) {
      expect(/\bfloat half\b/.test(src)).toBe(false)
      expect(/\bflat\b/.test(src)).toBe(false)
    }
  })
})

describe('Task 134 — the compute render tier (the SSBO dispatch sequence)', () => {
  /** A minimal SsboComputeFacade recording mock (the core gpgpu.test
   *  pattern — the five methods the core controller wraps). */
  function createRecordingGpu() {
    const calls: string[] = []
    let nextBuf = 1
    let nextCompute = 1
    const backend = {
      createExternalBuffer: (byteLength: number) => {
        calls.push(`createExternalBuffer(${byteLength})`)
        return nextBuf++
      },
      writeExternalBuffer: (bufferId: number, data: Float32Array | Uint32Array, byteOffset?: number, byteLength?: number) => {
        calls.push(`writeExternalBuffer(${bufferId},${byteLength ?? data.byteLength},${byteOffset ?? 0})`)
      },
      createCompute: (wgsl: string, uniformBytes: number, bufferIds: readonly number[]) => {
        calls.push(`createCompute(${uniformBytes},${bufferIds.join(',')})`)
        return nextCompute++
      },
      runCompute: (computeId: number, entry: string, uniformData: Float32Array, workgroups: number) => {
        calls.push(`runCompute(${computeId},${entry},${workgroups})`)
      },
      deleteCompute: (computeId: number) => { calls.push(`deleteCompute(${computeId})`) },
      deleteExternalBuffer: (bufferId: number) => { calls.push(`deleteExternalBuffer(${bufferId})`) },
    }
    return { backend, calls }
  }

  it('sort+cull: advance → sortKeys → bitonic×3 → the sorted pack (one dispatch each)', () => {
    const { backend, calls } = createRecordingGpu()
    const facade = createParticles({
      capacity: 12,
      ramp: { points: [{ t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 }] } as never,
      render: { kind: 'billboard', draw: 'instance', sort: true, cull: true },
      sim: 'gpu',
    })
    const gpu = createGpuParticles(facade, backend)
    // the ATTACH sequence: the sim family (kernel 1) + the sort family
    // (kernel 2) over the SAME four buffers, one slot shifted:
    // [pairs 5, state 1, records 3, ramp 4] — both 144-byte uniforms
    const attachSeq = calls.join('\n')
    expect(attachSeq).toContain('createCompute(144,1,2,3,4)')
    expect(attachSeq).toContain('createCompute(144,5,1,3,4)')
    facade.burst(4, { shape: { kind: 'point', origin: [0, 0, 0] }, velocity: { mode: 'fixed', dir: [0, 1, 0] }, speed: [0, 0], life: [100, 100], size: [1, 1], color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 1 })
    facade.advance(0.016)
    calls.length = 0
    gpu.step(0.016, { forward: [0, 0, -1], viewProj: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -10, 1] })
    const seq = calls.join('\n')
    // no deaths → no compact; the advance, then the render tier
    expect(seq).toContain('runCompute(1,advance,1)')
    expect(seq).toContain('runCompute(2,sortKeys,1)')
    // the SELF-DRIVING network: [bitonic, sortStep] × 3 (N=4) — the (k, j)
    // rides the records head, the uniform is pass-invariant
    expect(seq.match(/runCompute\(2,bitonic,1\)/g)).toHaveLength(3)
    expect(seq.match(/runCompute\(2,sortStep,1\)/g)).toHaveLength(3)
    expect(seq.indexOf('runCompute(2,bitonic,1)')).toBeLessThan(seq.indexOf('runCompute(2,sortStep,1)'))
    expect(seq).toContain('runCompute(2,pack,1)')
    expect(seq).not.toContain('runCompute(1,pack') // the sim pack is REPLACED
    // the order: advance → sortKeys → bitonic → pack
    const order = [
      seq.indexOf('runCompute(1,advance,1)'),
      seq.indexOf('runCompute(2,sortKeys,1)'),
      seq.indexOf('runCompute(2,pack,1)'),
    ]
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1])
  })

  it('no sort/cull: the ORIGINAL sim pack (zero render-tier dispatches)', () => {
    const { backend, calls } = createRecordingGpu()
    const facade = createParticles({
      capacity: 12,
      ramp: { points: [{ t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 }] } as never,
      render: { kind: 'billboard', draw: 'instance' },
      sim: 'gpu',
    })
    const gpu = createGpuParticles(facade, backend)
    // the attach created ONLY the sim family (one compute kernel)
    const attachCount = calls.filter(c => c.startsWith('createCompute(')).length
    expect(attachCount).toBe(1)
    facade.burst(4, { shape: { kind: 'point', origin: [0, 0, 0] }, velocity: { mode: 'fixed', dir: [0, 1, 0] }, speed: [0, 0], life: [100, 100], size: [1, 1], color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 1 })
    facade.advance(0.016)
    calls.length = 0
    gpu.step(0.016)
    const seq = calls.join('\n')
    expect(seq).toContain('runCompute(1,pack,1)')
    expect(seq).not.toContain('sortKeys')
    expect(seq).not.toContain('bitonic')
  })
})
