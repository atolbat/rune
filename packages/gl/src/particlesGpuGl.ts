/**
 * particlesGpuGl — the GPGPU orchestrator's WebGL2 TRANSFORM-FEEDBACK tier
 * (Task 132, Phase 3 — the SSBO↔TF common point; see
 * docs/particles-optimization.md).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE COMMON POINT: particlesGpu.ts (the WebGPU compute tier) and THIS
 * module are the two backends of ONE facade contract — createGpuParticles
 * (exported from particlesGpu.ts) dispatches by the facade's shape:
 *   WebGPU  → compute dispatches over a storage buffer (the SSBO tier);
 *   WebGL2  → transform-feedback passes over a float texture (THIS tier).
 * Both read the same facade.gpuHandoff, run the same force walk in the
 * same order with the same constants and the same noise table, and write
 * the SAME 16-float instance records the BILLBOARD material's instanced
 * command draws. The DEMO code is identical for both backends — the tier
 * is the library's business, not the demo's.
 *
 * THE FRAME (step(dt), between facade.advance and the draw):
 *   1. THE EMIT BLOCK — the handoff's 17-float rows repacked into the
 *      20-float texture rows, texSubImage2D'd into the PRE-COMPACTION
 *      texel range (the WGSL tier's writeBuffer equivalent);
 *   2. THE MAP — the provenance: prov[i] = i over [0, preCount), the swap
 *      list replayed (prov[to] = prov[from] — the exact moves of the CPU
 *      compaction, applied to indices instead of data). map[i] = prov[i]
 *      for the live [0, count) — vertex i gathers the pre-state of the
 *      particle that ENDS UP at slot i after the compaction;
 *   3. compactAdvance — ONE TF pass: gather map[i] → integrate → write
 *      slot i (the WGSL compact + advance, composed);
 *   4. the PBO round-trip — the TF output becomes the new state texture
 *      (texSubImage2DBuffer — zero CPU traffic);
 *   5. pack — ONE TF pass: slot i + the ramp LUT → the 16-float record i.
 *      The records buffer is the draw's instance-attribute source
 *      (bufferId + stride 64 + divisor 1 — the same command path as the
 *      WebGPU tier's recordsBufferId).
 *
 * THE STATE TEXTURE: rgba32f, W × H flat texel array, 5 texels per
 * particle (gpuSimGl.ts's layout). WebGL2 zero-initializes new textures —
 * the first frame's untouched slots read zeros, never the map.
 *
 * DISPOSAL: deleteTransformPass + deleteBuffer/deleteTexture — the facade's
 * idempotent deletes make it safe in any order.
 * ══════════════════════════════════════════════════════════════════════════
 */

import type { GLFacade } from '@rune/webgl2'
import type { Particles } from '@rune/particles'
import {
  gpuSimGlAdvanceGlsl, gpuSimGlPackGlsl, gpuRampLUTTexture,
  GPU_GL_STATE_TEXTURE_W, gpuGlStateTextureH, GPU_GL_TEXELS_PER_PARTICLE,
  GPU_GL_ADVANCE_UNIFORMS, GPU_GL_ADVANCE_F, GPU_GL_PACK_UNIFORMS, GPU_GL_PACK_F,
  GPU_GL_ADVANCE_OUTPUTS, GPU_GL_PACK_OUTPUTS,
} from '@rune/particles'

/** The created TF backend (the same interface as the WebGPU tier's — the
 *  createGpuParticles dispatch contract). */
export interface GpuParticlesTf {
  /** Runs this frame's GPU half (after facade.advance, before the draw). */
  step(dt: number): void
  /** The GL buffer id of the instance records — the layer command's
   *  i_* attributes bind it through bufferId (stride 64, divisor 1). */
  readonly recordsBufferId: number
  /** The TF state-pass buffer (the TEXTURE is the authoritative state —
   *  this buffer is its per-frame staging; exposed for the parity probes). */
  readonly stateBufferId: number
  /** Full teardown. */
  dispose(): void
}

/** The provenance of the CPU compaction: `prov[i] = i` over the
 *  PRE-COMPACTION slots [0, preCount), then the swap list replayed —
 *  prov[to] = prov[from], the EXACT moves of the CPU's swap-remove walk
 *  applied to indices instead of data (the WGSL compact entry applies the
 *  same moves to the state itself). After the replay, prov[j] = the
 *  pre-compaction slot of the particle that ends up at post-compaction
 *  slot j — the TF gather's map. Pinned by a golden test (positions
 *  encoding their own pre-slots). */
export function gpuGlProvenance(preCount: number, swaps: Uint32Array, swapCount: number, prov: Int32Array): void {
  for (let i = 0; i < preCount; i++) prov[i] = i
  for (let s = 0; s < swapCount; s++) {
    const to = swaps[s * 2]
    const from = swaps[s * 2 + 1]
    prov[to] = prov[from]
  }
}

/** Attaches the TF tier to a sim:'gpu' facade (the WebGL2 path of
 *  createGpuParticles in particlesGpu.ts — the dispatch point). */
export function createGpuParticlesTf(facade: Particles, gl: GLFacade): GpuParticlesTf {
  const handoff = facade.gpuHandoff
  if (handoff === null) {
    throw new Error('rune/gl: createGpuParticlesTf needs a sim:"gpu" facade (this one runs the CPU tier)')
  }
  const ho = handoff
  const capacity = facade.capacity

  // ── the state texture + the ramp LUT texture ──────────────────────────
  const W = GPU_GL_STATE_TEXTURE_W
  const H = gpuGlStateTextureH(capacity)
  const stateTex = gl.createTexture(W, H, { format: 'rgba32f' })
  const lut = gpuRampLUTTexture(facade.ramp.points)
  const rampW = Math.max(2, facade.ramp.points.length * 2)
  const rampTex = gl.createTexture(rampW, 1, { format: 'rgba32f' })
  gl.texSubImage2D(rampTex, 0, 0, rampW, 1, lut) // a Float32Array — FLOAT uploads demand it (ANGLE)

  // ── the buffers: the TF state staging, the records, the map ───────────
  const stateOut = gl.createBuffer(new Float32Array(W * H * 4))
  const records = gl.createBuffer(new Float32Array(capacity * 16))
  const mapBuf = gl.createBuffer(new Float32Array(capacity))

  // ── the passes ────────────────────────────────────────────────────────
  const advPass = gl.createTransformPass({
    vertex: gpuSimGlAdvanceGlsl(),
    outputs: GPU_GL_ADVANCE_OUTPUTS,
    attributes: [{ name: 'a_map', size: 1, stride: 4 }],
    textures: ['u_state'],
    uniforms: GPU_GL_ADVANCE_UNIFORMS,
  })
  const packPass = gl.createTransformPass({
    vertex: gpuSimGlPackGlsl(),
    outputs: GPU_GL_PACK_OUTPUTS,
    textures: ['u_state', 'u_ramp'],
    uniforms: GPU_GL_PACK_UNIFORMS,
  })
  ho.attached = true

  // ── the uniforms: one packed Float32Array per pass, written once ───────
  const advUni = new Float32Array(GPU_GL_ADVANCE_UNIFORMS.reduce((n, u) => n + u.size, 0))
  const packUni = new Float32Array(GPU_GL_PACK_UNIFORMS.reduce((n, u) => n + u.size, 0))
  const packF = GPU_GL_PACK_F
  const render = facade.render as { tiles?: readonly [number, number]; frameJitter?: number }
  const tiles = render.tiles ?? [1, 1]
  packUni[packF.tileU] = tiles[0]
  packUni[packF.tileV] = tiles[1]
  packUni[packF.frameJitter] = render.frameJitter ?? 0
  packUni[packF.rampN] = facade.ramp.points.length

  // ── the STATIC force config (the same reads as the WebGPU orchestrator) ─
  const forces = facade.forces
  const A = GPU_GL_ADVANCE_F
  let fDrag = 0, fLimit = 0, fGravity = 0, fAttract = 0, fTurb = 0, fNoise = 0, fWrap = 0
  const gravity = forces.gravity ?? [0, 0, 0]
  if (gravity[0] !== 0 || gravity[1] !== 0 || gravity[2] !== 0) {
    fGravity = 1
    advUni[A.gravity] = gravity[0]; advUni[A.gravity + 1] = gravity[1]; advUni[A.gravity + 2] = gravity[2]
  }
  if (forces.drag > 0) { fDrag = 1; advUni[A.drag] = forces.drag }
  if (forces.turbulence !== 0) { fTurb = 1; advUni[A.turbulence] = forces.turbulence }
  const attract = forces.attract ?? null
  if (attract !== null) {
    fAttract = 1
    advUni[A.attractPoint] = attract.point[0]; advUni[A.attractPoint + 1] = attract.point[1]; advUni[A.attractPoint + 2] = attract.point[2]
    advUni[A.attractStrength] = attract.strength
    advUni[A.softening2] = (attract.softening ?? 0.25) ** 2
  }
  const noise = forces.noise ?? null
  if (noise !== null && noise.strength !== 0) {
    fNoise = 1
    advUni[A.noiseStrength] = noise.strength; advUni[A.noiseScale] = noise.scale; advUni[A.noiseSpeed] = noise.speed
  }
  const limit = forces.limitSpeed ?? null
  if (limit !== null) { fLimit = 1; advUni[A.limit] = limit.limit; advUni[A.dampen] = limit.dampen }
  const wrapSize = ho.wrapSize
  if (wrapSize !== null && (wrapSize[0] > 0 || wrapSize[1] > 0 || wrapSize[2] > 0)) {
    fWrap = 1
    advUni[A.wrapSize] = wrapSize[0]; advUni[A.wrapSize + 1] = wrapSize[1]; advUni[A.wrapSize + 2] = wrapSize[2]
  }
  advUni[A.fDrag] = fDrag; advUni[A.fLimit] = fLimit; advUni[A.fGravity] = fGravity
  advUni[A.fAttract] = fAttract; advUni[A.fTurb] = fTurb; advUni[A.fNoise] = fNoise; advUni[A.fWrap] = fWrap

  // ── the per-frame scratch (allocated once — the hot-path contract) ────
  const emitPacked = new Float32Array(capacity * 20)
  const prov = new Int32Array(capacity)
  const mapFloats = new Float32Array(capacity)

  function step(dt: number): void {
    const count = facade.count
    if (count <= 0 && ho.emitCount === 0 && ho.swapCount === 0) return
    advUni[A.dt] = dt
    // the wrap center (the at() origin of THIS advance — the handoff's own)
    const wc = ho.emitOrigin
    advUni[A.wrapCenter] = wc[0]; advUni[A.wrapCenter + 1] = wc[1]; advUni[A.wrapCenter + 2] = wc[2]

    // 1. THE EMIT BLOCK — repack the 17-float rows into the 20-float
    //    texture rows and upload the PRE-COMPACTION texel range.
    if (ho.emitCount > 0) {
      const rows = ho.emitRows
      const n = ho.emitCount
      for (let i = 0; i < n; i++) {
        const s = i * 17
        const d = i * 20
        for (let f = 0; f < 17; f++) emitPacked[d + f] = rows[s + f]
        emitPacked[d + 17] = 0; emitPacked[d + 18] = 0; emitPacked[d + 19] = 0
      }
      // the texel range [start, end) — split into row rects (W texels/row;
      // 16 bytes per rgba32f texel — the source offset in the packed rows)
      const start = ho.emitBase * GPU_GL_TEXELS_PER_PARTICLE
      const end = start + n * GPU_GL_TEXELS_PER_PARTICLE
      const y0 = Math.floor(start / W)
      const y1 = Math.floor((end - 1) / W)
      for (let y = y0; y <= y1; y++) {
        const x0 = y === y0 ? start - y * W : 0
        const x1 = y === y1 ? end - y * W : W
        const byteOffset = (y * W + x0 - start) * 16
        const byteLength = (x1 - x0) * 16
        gl.texSubImage2D(stateTex, x0, y, x1 - x0, 1, new Float32Array(emitPacked.buffer, byteOffset, byteLength / 4))
      }
    }

    // 2. THE MAP — the provenance of the CPU compaction, replayed on
    //    indices exactly as the WGSL compact replays it on state.
    const preCount = ho.emitBase + ho.emitCount
    gpuGlProvenance(preCount, ho.swaps, ho.swapCount, prov)
    for (let i = 0; i < count; i++) mapFloats[i] = prov[i]
    gl.updateBuffer(mapBuf, mapFloats.subarray(0, count))

    // 3. compact+advance: gather map[i] → integrate → write slot i.
    gl.runTransformPass(advPass, count, {
      bufferId: stateOut,
      attribBuffers: [mapBuf],
      textures: [stateTex],
      uniformData: advUni,
    })

    // 4. the PBO round-trip: the TF output becomes the new state texture.
    gl.texSubImage2DBuffer(stateTex, 0, 0, W, H, stateOut, 0)

    // 5. pack: slot i + the ramp LUT → the 16-float record i (the draw's
    //    instance source through recordsBufferId).
    gl.runTransformPass(packPass, count, {
      bufferId: records,
      textures: [stateTex, rampTex],
      uniformData: packUni,
    })
  }

  return {
    step,
    get recordsBufferId() { return records },
    get stateBufferId() { return stateOut },
    dispose() {
      gl.deleteTransformPass(advPass)
      gl.deleteTransformPass(packPass)
      gl.deleteBuffer(stateOut)
      gl.deleteBuffer(records)
      gl.deleteBuffer(mapBuf)
      gl.deleteTexture(stateTex)
      gl.deleteTexture(rampTex)
      ho.attached = false
    },
  }
}
