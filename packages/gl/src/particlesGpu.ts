/**
 * particlesGpu — the GPGPU orchestrator (Task 131, Phase 2: the WebGPU
 * compute tier of @rune/particles — see docs/particles-optimization.md).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE FRAME SEQUENCE (called from the demo's frame callback, BETWEEN
 * facade.advance(dt) and the layer's record/draw — the tape contract
 * guarantees the compute passes enqueue before the render pass opens):
 *
 *   step(dt):
 *     1. upload the swap list (the CPU compaction's (to, from) pairs);
 *     2. upload the EMIT BLOCK (the newborns' rows at their pre-compaction
 *        slots — the writeBuffer lands BEFORE the compact replay, so the
 *        GPU state ends up exactly the CPU's post-compaction structure);
 *     3. dispatch `compact` (1 workgroup — the single-threaded replay in
 *        the CPU's own order);
 *     4. dispatch `advance` (ceil(count/64) workgroups — the force walk,
 *        the integration, age, the wrap);
 *     5. dispatch `pack` (the SAME 16-float instance records the CPU
 *        packer writes — the render binds the buffer as the BILLBOARD
 *        material's instance source through `recordsBufferId`).
 *
 * THE RENDER BINDING: the layer command's five i_* attributes carry
 * bufferId = recordsBufferId (the WebGPU executor binds the external
 * buffer — ZERO per-frame CPU→GPU particle traffic; the records never
 * touch a Float32Array upload path).
 *
 * DISPOSAL: the buffers and the compute family live in the GPUFacade's
 * registries — dispose() deletes them explicitly (a facade dispose also
 * cleans everything).
 * ══════════════════════════════════════════════════════════════════════════
 */

import type { GPUFacade } from '@rune/webgpu'
import type { Particles } from '@rune/particles'
import {
  gpuSimWgsl, gpuRampLUT, GPU_STATE_STRIDE, GPU_SIM_UNIFORM_FLOATS,
  GPU_SIM_U32_FIELDS, GPU_SIM_F32_FIELDS, GPU_SIM_VEC4_FIELDS, GPU_FORCE_MASK,
} from '@rune/particles'

/** The GPUBufferUsage bits (the spec's stable values — the orchestrator
 *  composes them for the external buffers; the facade stays
 *  usage-agnostic). */
const BUF = {
  /** 128 — bind as a storage buffer (read or read_write). */
  STORAGE: 128,
  /** 8 — queue.writeBuffer target. */
  COPY_DST: 8,
  /** 32 — bind as a vertex buffer (the records). */
  VERTEX: 32,
} as const

/** The workgroup size of the advance/pack entries (the WGSL's own). */
const WORKGROUP = 64

/** The created GPU backend: the buffers + the compute family + the step. */
export interface GpuParticles {
  /** Runs this frame's GPU half (after facade.advance, before the draw). */
  step(dt: number): void
  /** The external buffer id of the instance records — the layer command's
   *  i_* attributes bind it through bufferId. */
  readonly recordsBufferId: number
  /** The state buffer id (the parity probes read it back). */
  readonly stateBufferId: number
  /** Full teardown (the facade's own dispose also cleans). */
  dispose(): void
}

/** Attaches the GPU tier to a sim:'gpu' facade. The facade's handoff
 *  becomes `attached` — its advance() stops throwing. WebGL2 has no
 *  compute: call this ONLY on the WebGPU backend (the demos tier the sim
 *  by the active backend). */
export function createGpuParticles(facade: Particles, gpu: GPUFacade): GpuParticles {
  const handoff = facade.gpuHandoff
  if (handoff === null) {
    throw new Error('rune/gl: createGpuParticles needs a sim:"gpu" facade (this one runs the CPU tier)')
  }
  const ho = handoff
  const capacity = facade.capacity
  // ── the buffers: the interleaved state, the swap list, the records, the ramp LUT
  const stateId = gpu.createExternalBuffer(GPU_STATE_STRIDE * capacity * 4, BUF.STORAGE | BUF.COPY_DST)
  const swapsId = gpu.createExternalBuffer(2 * capacity * 4, BUF.STORAGE | BUF.COPY_DST)
  const recordsId = gpu.createExternalBuffer(16 * capacity * 4, BUF.STORAGE | BUF.VERTEX)
  const lut = gpuRampLUT(facade.ramp.points)
  const rampId = gpu.createExternalBuffer(lut.byteLength, BUF.STORAGE | BUF.COPY_DST)
  gpu.writeExternalBuffer(rampId, lut)
  const computeId = gpu.createCompute(gpuSimWgsl(), GPU_SIM_UNIFORM_FLOATS * 4, [stateId, swapsId, recordsId, rampId])
  if (computeId < 0 || stateId < 0 || swapsId < 0 || recordsId < 0 || rampId < 0) {
    throw new Error('rune/gl: createGpuParticles — the facade rejected a buffer (see the GPU error log)')
  }
  ho.attached = true

  // ── the uniform: one ArrayBuffer, the f32 + u32 views (the count /
  //    swapCount / forceMask are u32 fields)
  const uniBuf = new ArrayBuffer(GPU_SIM_UNIFORM_FLOATS * 4)
  const uni = new Float32Array(uniBuf)
  const u32 = new Uint32Array(uniBuf)

  // ── the STATIC force config (read once from the facade — the GPU tier
  //    runs the same forces; dynamic retargeting is rejected upstream)
  const forces = facade.forces
  const F = GPU_SIM_F32_FIELDS
  const V = GPU_SIM_VEC4_FIELDS
  const render = facade.render as { tiles?: readonly [number, number]; frameJitter?: number }
  let mask = 0
  const gravity = forces.gravity ?? [0, 0, 0]
  if (gravity[0] !== 0 || gravity[1] !== 0 || gravity[2] !== 0) {
    mask |= GPU_FORCE_MASK.gravity
    uni[V.gravity] = gravity[0]; uni[V.gravity + 1] = gravity[1]; uni[V.gravity + 2] = gravity[2]
  }
  if (forces.drag > 0) { mask |= GPU_FORCE_MASK.drag; uni[F.drag] = forces.drag }
  if (forces.turbulence !== 0) { mask |= GPU_FORCE_MASK.turbulence; uni[F.turbulence] = forces.turbulence }
  const attract = forces.attract ?? null
  if (attract !== null) {
    mask |= GPU_FORCE_MASK.attract
    uni[V.attractPoint] = attract.point[0]; uni[V.attractPoint + 1] = attract.point[1]; uni[V.attractPoint + 2] = attract.point[2]
    uni[F.attractStrength] = attract.strength
    uni[F.softening2] = (attract.softening ?? 0.25) ** 2
  }
  const noise = forces.noise ?? null
  if (noise !== null && noise.strength !== 0) {
    mask |= GPU_FORCE_MASK.noise
    uni[F.noiseStrength] = noise.strength; uni[F.noiseScale] = noise.scale; uni[F.noiseSpeed] = noise.speed
  }
  const limit = forces.limitSpeed ?? null
  if (limit !== null) { mask |= GPU_FORCE_MASK.limitSpeed; uni[F.limit] = limit.limit; uni[F.dampen] = limit.dampen }
  const wrapSize = ho.wrapSize
  if (wrapSize !== null && (wrapSize[0] > 0 || wrapSize[1] > 0 || wrapSize[2] > 0)) {
    mask |= GPU_FORCE_MASK.wrap
    uni[V.wrapSize] = wrapSize[0]; uni[V.wrapSize + 1] = wrapSize[1]; uni[V.wrapSize + 2] = wrapSize[2]
  }
  const tiles = render.tiles ?? [1, 1]
  uni[F.tileU] = tiles[0]
  uni[F.tileV] = tiles[1]
  uni[F.frameJitter] = render.frameJitter ?? 0
  u32[GPU_SIM_U32_FIELDS.forceMask] = mask
  const staticMask = mask

  function step(dt: number): void {
    const count = facade.count
    if (count <= 0 && ho.emitCount === 0 && ho.swapCount === 0) return
    u32[GPU_SIM_U32_FIELDS.count] = count
    uni[GPU_SIM_F32_FIELDS.dt] = dt
    u32[GPU_SIM_U32_FIELDS.swapCount] = ho.swapCount
    u32[GPU_SIM_U32_FIELDS.forceMask] = staticMask
    // the wrap center (the at() origin of THIS advance — the handoff carries it)
    const wc = ho.emitOrigin
    uni[V.wrapCenter] = wc[0]; uni[V.wrapCenter + 1] = wc[1]; uni[V.wrapCenter + 2] = wc[2]
    // 1. the swap list
    if (ho.swapCount > 0) {
      gpu.writeExternalBuffer(swapsId, ho.swaps, 0, ho.swapCount * 8)
    }
    // 2. the emit block (the pre-compaction slots)
    if (ho.emitCount > 0) {
      gpu.writeExternalBuffer(stateId, ho.emitRows, ho.emitBase * GPU_STATE_STRIDE * 4, ho.emitCount * GPU_STATE_STRIDE * 4)
    }
    // 3-5. the passes
    if (ho.swapCount > 0) gpu.runCompute(computeId, 'compact', uni, 1)
    const workgroups = Math.ceil(count / WORKGROUP)
    if (workgroups > 0) {
      gpu.runCompute(computeId, 'advance', uni, workgroups)
      gpu.runCompute(computeId, 'pack', uni, workgroups)
    }
  }

  return {
    step,
    get recordsBufferId() { return recordsId },
    get stateBufferId() { return stateId },
    dispose() {
      gpu.deleteExternalBuffer(stateId)
      gpu.deleteExternalBuffer(swapsId)
      gpu.deleteExternalBuffer(recordsId)
      gpu.deleteExternalBuffer(rampId)
      ho.attached = false
    },
  }
}
