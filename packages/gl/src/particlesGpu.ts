/**
 * particlesGpu — the GPGPU orchestrator binding (Task 131/132, rebuilt on
 * the core tier controller in Task 133).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE ARCHITECTURE (Task 133 — the extraction):
 * The SSBO↔transform-feedback COMMON POINT moved to @rune/core
 * (gpgpu.ts — createGpgpu): the dispatch by backend shape, the tracked
 * resource lifecycle (dispose() — reverse creation order, exactly once)
 * and the f32/u32 uniform scratch. It is particles-agnostic — any GPGPU
 * consumer (an ocean pass, GPU skinning) gets the same control. THIS
 * module is the particles binding: it owns the buffers' shapes, the
 * kernel/passes (the WGSL/GLSL twins live in @rune/particles) and the
 * per-frame sequence.
 *
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
 * DISPOSAL: the tier's tracked registry (reverse creation order — the
 * compute family's staging uniform buffer dies with the kernel, the
 * Task 133 leak fix: before it, only the external buffers were deleted).
 * ══════════════════════════════════════════════════════════════════════════
 */

import {
  createGpgpu, GPU_BUFFER_USAGE,
  type SsboComputeFacade, type TfComputeFacade, type SsboComputeTier,
} from '@rune/core'
import type { Particles } from '@rune/particles'
import {
  gpuSimWgsl, gpuRampLUT, GPU_STATE_STRIDE, GPU_SIM_UNIFORM_FLOATS,
  GPU_SIM_U32_FIELDS, GPU_SIM_F32_FIELDS, GPU_SIM_VEC4_FIELDS, GPU_FORCE_MASK,
} from '@rune/particles'
import { createGpuParticlesTf } from './particlesGpuGl.ts'
import { readGpuTierConfig } from './particlesGpuConfig.ts'

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

/** Attaches the GPU tier to a sim:'gpu' facade — the particles binding of
 *  THE COMMON POINT (now @rune/core's createGpgpu — the abstract
 *  dual-backend GPGPU controller): the WebGPU compute tier (the SSBO path)
 *  or the WebGL2 transform-feedback tier (the SSBO's twin), dispatched by
 *  the facade's shape. The facade's handoff becomes `attached` — its
 *  advance() stops throwing. The demo code is identical for both backends
 *  — the tier is the library's business, not the demo's. */
export function createGpuParticles(facade: Particles, backend: SsboComputeFacade | TfComputeFacade): GpuParticles {
  const tier = createGpgpu(backend)
  return tier.kind === 'transform-feedback'
    ? createGpuParticlesTf(facade, tier)
    : createGpuParticlesCompute(facade, tier)
}

/** The WebGPU compute tier (the SSBO path — the kernel dispatches of
 *  @rune/particles' WGSL twin over the tracked external buffers). */
function createGpuParticlesCompute(facade: Particles, gpu: SsboComputeTier): GpuParticles {
  const handoff = facade.gpuHandoff
  if (handoff === null) {
    throw new Error('rune/gl: createGpuParticles needs a sim:"gpu" facade (this one runs the CPU tier)')
  }
  const ho = handoff
  const capacity = facade.capacity
  // ── the buffers: the interleaved state, the swap list, the records, the
  //    ramp LUT — all tracked (the tier's dispose() deletes them)
  const stateId = gpu.createBuffer(GPU_STATE_STRIDE * capacity * 4, GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_DST)
  const swapsId = gpu.createBuffer(2 * capacity * 4, GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_DST)
  const recordsId = gpu.createBuffer(16 * capacity * 4, GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.VERTEX)
  const lut = gpuRampLUT(facade.ramp.points)
  const rampId = gpu.createBuffer(lut.byteLength, GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_DST)
  gpu.writeBuffer(rampId, lut)
  const computeId = gpu.createKernel(gpuSimWgsl(), GPU_SIM_UNIFORM_FLOATS * 4, [stateId, swapsId, recordsId, rampId])
  if (computeId < 0 || stateId < 0 || swapsId < 0 || recordsId < 0 || rampId < 0) {
    gpu.dispose() // the tracked partial state dies with the failed attach
    throw new Error('rune/gl: createGpuParticles — the facade rejected a buffer (see the GPU error log)')
  }
  ho.attached = true

  // ── the uniform: the controller's scratch — one ArrayBuffer, the f32 +
  //    u32 views (the count / swapCount / forceMask are u32 fields)
  const scratch = gpu.scratch(GPU_SIM_UNIFORM_FLOATS)
  const uni = scratch.f32
  const u32 = scratch.u32

  // ── the STATIC force config — the shared interpretation
  //    (particlesGpuConfig.ts — ONE read, both orchestrators pack it)
  const cfg = readGpuTierConfig(facade)
  const F = GPU_SIM_F32_FIELDS
  const V = GPU_SIM_VEC4_FIELDS
  const a = cfg.active
  let mask = 0
  if (a.gravity) {
    mask |= GPU_FORCE_MASK.gravity
    uni[V.gravity] = cfg.gravity[0]; uni[V.gravity + 1] = cfg.gravity[1]; uni[V.gravity + 2] = cfg.gravity[2]
  }
  if (a.drag) { mask |= GPU_FORCE_MASK.drag; uni[F.drag] = cfg.drag }
  if (a.turbulence) { mask |= GPU_FORCE_MASK.turbulence; uni[F.turbulence] = cfg.turbulence }
  if (a.attract) {
    mask |= GPU_FORCE_MASK.attract
    uni[V.attractPoint] = cfg.attract.point[0]; uni[V.attractPoint + 1] = cfg.attract.point[1]; uni[V.attractPoint + 2] = cfg.attract.point[2]
    uni[F.attractStrength] = cfg.attract.strength
    uni[F.softening2] = cfg.attract.softening2
  }
  if (a.noise) {
    mask |= GPU_FORCE_MASK.noise
    uni[F.noiseStrength] = cfg.noise.strength; uni[F.noiseScale] = cfg.noise.scale; uni[F.noiseSpeed] = cfg.noise.speed
  }
  if (a.limit) { mask |= GPU_FORCE_MASK.limitSpeed; uni[F.limit] = cfg.limit.limit; uni[F.dampen] = cfg.limit.dampen }
  if (a.wrap) {
    mask |= GPU_FORCE_MASK.wrap
    uni[V.wrapSize] = cfg.wrapSize[0]; uni[V.wrapSize + 1] = cfg.wrapSize[1]; uni[V.wrapSize + 2] = cfg.wrapSize[2]
  }
  uni[F.tileU] = cfg.tiles[0]
  uni[F.tileV] = cfg.tiles[1]
  uni[F.frameJitter] = cfg.frameJitter
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
      gpu.writeBuffer(swapsId, ho.swaps, 0, ho.swapCount * 8)
    }
    // 2. the emit block (the pre-compaction slots)
    if (ho.emitCount > 0) {
      gpu.writeBuffer(stateId, ho.emitRows, ho.emitBase * GPU_STATE_STRIDE * 4, ho.emitCount * GPU_STATE_STRIDE * 4)
    }
    // 3-5. the passes
    if (ho.swapCount > 0) gpu.runKernel(computeId, 'compact', uni, 1)
    const workgroups = Math.ceil(count / WORKGROUP)
    if (workgroups > 0) {
      gpu.runKernel(computeId, 'advance', uni, workgroups)
      gpu.runKernel(computeId, 'pack', uni, workgroups)
    }
  }

  return {
    step,
    get recordsBufferId() { return recordsId },
    get stateBufferId() { return stateId },
    dispose() {
      gpu.dispose()
      ho.attached = false
    },
  }
}
