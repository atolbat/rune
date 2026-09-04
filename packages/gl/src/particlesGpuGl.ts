/**
 * particlesGpuGl — the GPGPU orchestrator's WebGL2 TRANSFORM-FEEDBACK tier
 * (Task 132, rebuilt on the core tier controller in Task 133).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE ARCHITECTURE (Task 133 — the extraction): the SSBO↔TF common point
 * (the dispatch, the tracked lifecycle, the uniform scratch) lives in
 * @rune/core's gpgpu.ts now; THIS module takes a TfComputeTier and owns
 * only the particles half — the state-texture shapes, the two passes
 * (the GLSL twins of the WGSL entries) and the per-frame sequence.
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
 * DISPOSAL: the tier's tracked registry (the buffers, the two textures,
 * the two passes — reverse creation order, once).
 * ══════════════════════════════════════════════════════════════════════════
 */

import type { TfComputeTier, TfRunBindings } from '@rune/core'
import type { Particles } from '@rune/particles'
import {
  gpuSimGlAdvanceGlsl, gpuSimGlPackGlsl, gpuRampLUTTexture,
  GPU_GL_STATE_TEXTURE_W, gpuGlStateTextureH, GPU_GL_TEXELS_PER_PARTICLE,
  GPU_GL_ADVANCE_UNIFORMS, GPU_GL_ADVANCE_F, GPU_GL_PACK_UNIFORMS, GPU_GL_PACK_F,
  GPU_GL_ADVANCE_OUTPUTS, GPU_GL_PACK_OUTPUTS,
} from '@rune/particles'
import { readGpuTierConfig } from './particlesGpuConfig.ts'

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
 *  createGpuParticles in particlesGpu.ts — the core controller's tier). */
export function createGpuParticlesTf(facade: Particles, gpu: TfComputeTier): GpuParticlesTf {
  const handoff = facade.gpuHandoff
  if (handoff === null) {
    throw new Error('rune/gl: createGpuParticlesTf needs a sim:"gpu" facade (this one runs the CPU tier)')
  }
  const ho = handoff
  const capacity = facade.capacity

  // ── the state texture + the ramp LUT texture (tracked) ──────────────
  const W = GPU_GL_STATE_TEXTURE_W
  const H = gpuGlStateTextureH(capacity)
  const stateTex = gpu.createTexture(W, H, { format: 'rgba32f' })
  const lut = gpuRampLUTTexture(facade.ramp.points)
  const rampW = Math.max(2, facade.ramp.points.length * 2)
  const rampTex = gpu.createTexture(rampW, 1, { format: 'rgba32f' })
  gpu.texSubImage2D(rampTex, 0, 0, rampW, 1, lut) // a Float32Array — FLOAT uploads demand it (ANGLE)

  // ── the buffers: the TF state staging, the records, the map (tracked) ─
  const stateOut = gpu.createBuffer(new Float32Array(W * H * 4))
  const records = gpu.createBuffer(new Float32Array(capacity * 16))
  const mapBuf = gpu.createBuffer(new Float32Array(capacity))

  // ── the passes (tracked) ────────────────────────────────────────────
  const advPass = gpu.createPass({
    vertex: gpuSimGlAdvanceGlsl(),
    outputs: GPU_GL_ADVANCE_OUTPUTS,
    attributes: [{ name: 'a_map', size: 1, stride: 4 }],
    textures: ['u_state'],
    uniforms: GPU_GL_ADVANCE_UNIFORMS,
  })
  const packPass = gpu.createPass({
    vertex: gpuSimGlPackGlsl(),
    outputs: GPU_GL_PACK_OUTPUTS,
    textures: ['u_state', 'u_ramp'],
    uniforms: GPU_GL_PACK_UNIFORMS,
  })
  ho.attached = true

  // ── the uniforms: the controller's scratch (one packed block per pass) ─
  const advUni = gpu.scratch(GPU_GL_ADVANCE_UNIFORMS.reduce((n, u) => n + u.size, 0)).f32
  const packUni = gpu.scratch(GPU_GL_PACK_UNIFORMS.reduce((n, u) => n + u.size, 0)).f32
  const packF = GPU_GL_PACK_F
  const cfg = readGpuTierConfig(facade)
  packUni[packF.tileU] = cfg.tiles[0]
  packUni[packF.tileV] = cfg.tiles[1]
  packUni[packF.frameJitter] = cfg.frameJitter
  packUni[packF.rampN] = facade.ramp.points.length

  // ── the STATIC force config (the shared interpretation) ─────────────
  const A = GPU_GL_ADVANCE_F
  const a = cfg.active
  advUni[A.fDrag] = a.drag ? 1 : 0
  advUni[A.fLimit] = a.limit ? 1 : 0
  advUni[A.fGravity] = a.gravity ? 1 : 0
  advUni[A.fAttract] = a.attract ? 1 : 0
  advUni[A.fTurb] = a.turbulence ? 1 : 0
  advUni[A.fNoise] = a.noise ? 1 : 0
  advUni[A.fWrap] = a.wrap ? 1 : 0
  if (a.gravity) {
    advUni[A.gravity] = cfg.gravity[0]; advUni[A.gravity + 1] = cfg.gravity[1]; advUni[A.gravity + 2] = cfg.gravity[2]
  }
  if (a.drag) { advUni[A.drag] = cfg.drag }
  if (a.turbulence) { advUni[A.turbulence] = cfg.turbulence }
  if (a.attract) {
    advUni[A.attractPoint] = cfg.attract.point[0]; advUni[A.attractPoint + 1] = cfg.attract.point[1]; advUni[A.attractPoint + 2] = cfg.attract.point[2]
    advUni[A.attractStrength] = cfg.attract.strength
    advUni[A.softening2] = cfg.attract.softening2
  }
  if (a.noise) {
    advUni[A.noiseStrength] = cfg.noise.strength; advUni[A.noiseScale] = cfg.noise.scale; advUni[A.noiseSpeed] = cfg.noise.speed
  }
  if (a.limit) { advUni[A.limit] = cfg.limit.limit; advUni[A.dampen] = cfg.limit.dampen }
  if (a.wrap) {
    advUni[A.wrapSize] = cfg.wrapSize[0]; advUni[A.wrapSize + 1] = cfg.wrapSize[1]; advUni[A.wrapSize + 2] = cfg.wrapSize[2]
  }

  // ── the per-frame scratch (allocated once — the hot-path contract) ───
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
        gpu.texSubImage2D(stateTex, x0, y, x1 - x0, 1, new Float32Array(emitPacked.buffer, byteOffset, byteLength / 4))
      }
    }

    // 2. THE MAP — the provenance of the CPU compaction, replayed on
    //    indices exactly as the WGSL compact replays it on state.
    const preCount = ho.emitBase + ho.emitCount
    gpuGlProvenance(preCount, ho.swaps, ho.swapCount, prov)
    for (let i = 0; i < count; i++) mapFloats[i] = prov[i]
    gpu.updateBuffer(mapBuf, mapFloats.subarray(0, count))

    // 3. compact+advance: gather map[i] → integrate → write slot i.
    gpu.runPass(advPass, count, {
      bufferId: stateOut,
      attribBuffers: [mapBuf],
      textures: [stateTex],
      uniformData: advUni,
    } satisfies TfRunBindings)

    // 4. the PBO round-trip: the TF output becomes the new state texture.
    gpu.texSubImage2DBuffer(stateTex, 0, 0, W, H, stateOut, 0)

    // 5. pack: slot i + the ramp LUT → the 16-float record i (the draw's
    //    instance source through recordsBufferId).
    gpu.runPass(packPass, count, {
      bufferId: records,
      textures: [stateTex, rampTex],
      uniformData: packUni,
    } satisfies TfRunBindings)
  }

  return {
    step,
    get recordsBufferId() { return records },
    get stateBufferId() { return stateOut },
    dispose() {
      gpu.dispose()
      ho.attached = false
    },
  }
}
