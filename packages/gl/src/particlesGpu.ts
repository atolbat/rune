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
 * Task 134 — THE GPU RENDER TIER (render.sort / render.cull): step 5
 * becomes the SORT FAMILY's pack — `sortKeys` (the (key, index) pairs:
 * the negated depth key for the live, the sentinel for the culled/pads)
 * → the bitonic network (gpuSortPassSequence's canonical (k, j) passes)
 * → the sorted `pack` (records in far-to-near draw order, the sentinel
 * slots the zero record — a degenerate instance). The camera arrives as
 * step(dt, { forward, viewProj }) — the sort's axis and the cull's planes.
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
  gpuSortWgsl, GPU_SORT_UNIFORM_FLOATS, GPU_SORT_U32_FIELDS, GPU_SORT_F32_FIELDS,
  GPU_SORT_RENDER_MASK, gpuSortPadCount, gpuSortPassSequence, gpuRampMaxSize, gpuRenderFrustum,
  readGpuEmitConfig, gpuEmitPackStatic, GPU_EMIT_U32_FIELDS, GPU_EMIT_VEC4_FIELDS,
} from '@rune/particles'
import { createGpuParticlesTf } from './particlesGpuGl.ts'
import { readGpuTierConfig } from './particlesGpuConfig.ts'

/** The workgroup size of the advance/pack entries (the WGSL's own). */
const WORKGROUP = 64

/** The created GPU backend: the buffers + the compute family + the step. */
export interface GpuParticles {
  /** Runs this frame's GPU half (after facade.advance, before the draw).
   *  Task 134 — the CAMERA: render.sort needs `camera.forward` (the depth
   *  key's axis), render.cull needs `camera.viewProj` (the frustum planes'
   *  source); both are loud throws when missing — pass the frame context's
   *  basis.forward + mvp. */
  step(dt: number, camera?: GpuRenderCamera): void
  /** The external buffer id of the instance records — the layer command's
   *  i_* attributes bind it through bufferId. */
  readonly recordsBufferId: number
  /** The state buffer id (the parity probes read it back). */
  readonly stateBufferId: number
  /** Full teardown (the facade's own dispose also cleans). */
  dispose(): void
}

/** Task 134 — the render camera the GPU render tier needs at step() time:
 *  the sort's depth axis and the cull's frustum source. The vfx shell's
 *  frame context carries both (ctx.basis.forward, ctx.mvp). */
export interface GpuRenderCamera {
  /** The camera basis forward — the depth key's axis (dot(forward,
   *  position); REQUIRED by render.sort). */
  readonly forward: readonly number[]
  /** The view-projection, COLUMN-MAJOR 16 numbers (the frustum planes'
   *  source — REQUIRED by render.cull). */
  readonly viewProj?: readonly number[]
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
  // ── the shared static interpretation (particlesGpuConfig.ts — ONE read,
  //    the forces + the wrap + the tiles + Task 134's sort/cull flags)
  const cfg = readGpuTierConfig(facade)
  // ── the buffers: the interleaved state, the swap list, the records, the
  //    ramp LUT — all tracked (the tier's dispose() deletes them)
  const stateId = gpu.createBuffer(GPU_STATE_STRIDE * capacity * 4, GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_DST)
  const swapsId = gpu.createBuffer(2 * capacity * 4, GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_DST)
  const recordsId = gpu.createBuffer(16 * capacity * 4, GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.VERTEX)
  const lut = gpuRampLUT(facade.ramp.points)
  const rampId = gpu.createBuffer(lut.byteLength, GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_DST)
  gpu.writeBuffer(rampId, lut)
  const computeId = gpu.createKernel(gpuSimWgsl(), GPU_SIM_UNIFORM_FLOATS * 4, [stateId, swapsId, recordsId, rampId])
  // ── Task 134 — THE GPU RENDER TIER: render.sort / render.cull attach the
  //    sort family — a SECOND compute kernel over the SAME four buffers
  //    (one slot shifted: 1 = the pairs (rw), 2 = the state (ro), 3 = the
  //    records (rw), 4 = the ramp (ro)). The pairs buffer is the network's
  //    (key, index) array at nextPow2(capacity).
  const tiered = cfg.sort || cfg.cull
  let sortId = -1
  // the sort family's scratch + the frustum buffer (unconditional — a few
  // floats, and the step's hot path walks without null guards)
  const sortScratch = gpu.scratch(GPU_SORT_UNIFORM_FLOATS)
  const frustumScratch = new Float32Array(24)
  if (tiered) {
    const maxPadN = gpuSortPadCount(capacity)
    const pairsId = gpu.createBuffer(maxPadN * 8, GPU_BUFFER_USAGE.STORAGE)
    sortId = gpu.createKernel(gpuSortWgsl(), GPU_SORT_UNIFORM_FLOATS * 4, [pairsId, stateId, recordsId, rampId])
    if (sortId < 0 || pairsId < 0) {
      gpu.dispose()
      throw new Error('rune/gl: createGpuParticles — the facade rejected the sort family (see the GPU error log)')
    }
  }
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

  // ── Task 135 — THE GPU EMISSION: the facade's emit:'gpu' packs the
  //    spawner interpretation ONCE (the static half of the uniform's emit
  //    block — the per-frame window/origin/emitterV lands in step()).
  //    readGpuEmitConfig throws LOUDLY on the unsupported constructs (the
  //    path shape, the lattice modes, the radial modulators — the honest
  //    v1 boundary; emit:'cpu' is unaffected).
  const emitOn = facade.emitGpu
  if (emitOn) {
    gpuEmitPackStatic(uni, u32, readGpuEmitConfig(facade.spawnerDesc))
  }

  // ── the sort family's statics (tiles/frameJitter/rampMax for the pack
  //    twin — the SAME values the sim family's pack consumes)
  {
    const sUni = sortScratch.f32
    const SU = GPU_SORT_F32_FIELDS
    sUni[SU.tileU] = cfg.tiles[0]
    sUni[SU.tileV] = cfg.tiles[1]
    sUni[SU.frameJitter] = cfg.frameJitter
    sUni[SU.rampMaxSize] = gpuRampMaxSize(facade.ramp.points)
  }

  function step(dt: number, camera?: GpuRenderCamera): void {
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
    // 2. THE NEWBORNS at their pre-compaction slots. Task 135 — emit:'gpu'
    //    dispatches the hash-RNG append kernel (the rows generated ON the
    //    GPU, zero CPU traffic); emit:'cpu' uploads the handoff's row block
    //    as before. Either way this lands BEFORE the compact replay, so
    //    the GPU state ends up exactly the CPU's post-compaction structure.
    if (ho.emitCount > 0) {
      if (emitOn) {
        const EU = GPU_EMIT_U32_FIELDS
        const EV = GPU_EMIT_VEC4_FIELDS
        u32[EU.emitBase] = ho.emitBase
        u32[EU.emitCount] = ho.emitCount
        u32[EU.streamBase] = ho.emitStreamBase | 0 // the low 32 bits — the hash's own domain
        const eo = ho.emitOrigin
        uni[EV.atOrigin] = eo[0]; uni[EV.atOrigin + 1] = eo[1]; uni[EV.atOrigin + 2] = eo[2]
        const ev = ho.emitterV
        uni[EV.emitterV] = ev[0]; uni[EV.emitterV + 1] = ev[1]; uni[EV.emitterV + 2] = ev[2]
        uni[EV.sizeInherit + 2] = ho.emitInheritK
        gpu.runKernel(computeId, 'emit', uni, Math.ceil(ho.emitCount / WORKGROUP))
      } else {
        gpu.writeBuffer(stateId, ho.emitRows, ho.emitBase * GPU_STATE_STRIDE * 4, ho.emitCount * GPU_STATE_STRIDE * 4)
      }
    }
    // 3-5. the passes
    if (ho.swapCount > 0) gpu.runKernel(computeId, 'compact', uni, 1)
    const workgroups = Math.ceil(count / WORKGROUP)
    if (workgroups > 0) {
      gpu.runKernel(computeId, 'advance', uni, workgroups)
      if (tiered) {
        // Task 134 — THE GPU RENDER TIER: the camera contracts (loud, not
        // silent): sort needs the forward, cull the view-projection. The
        // throws narrow the locals — the pack sites walk assertion-free.
        let camForward: readonly number[] | null = null
        let camViewProj: readonly number[] | null = null
        if (cfg.sort) {
          const fw = camera?.forward
          if (fw === undefined || fw.length < 3) {
            throw new Error('rune/gl: render.sort needs the camera forward at step(dt, { forward, viewProj }) — the depth key is dot(forward, position)')
          }
          camForward = fw
        }
        if (cfg.cull) {
          const vp = camera?.viewProj
          if (vp === undefined || vp.length !== 16) {
            throw new Error('rune/gl: render.cull needs the view-projection at step(dt, { forward, viewProj }) — the six frustum planes come from the frame context mvp (column-major)')
          }
          camViewProj = vp
        }
        const sUni = sortScratch.f32
        const sU32 = sortScratch.u32
        const SU = GPU_SORT_F32_FIELDS
        const padN = gpuSortPadCount(count)
        sU32[GPU_SORT_U32_FIELDS.count] = count
        sU32[GPU_SORT_U32_FIELDS.padN] = padN
        sU32[GPU_SORT_U32_FIELDS.renderMask] = cfg.cull ? GPU_SORT_RENDER_MASK.cull : 0
        if (camForward !== null) {
          const fw = camForward
          sUni[SU.forward] = fw[0]; sUni[SU.forward + 1] = fw[1]; sUni[SU.forward + 2] = fw[2]
        }
        if (camViewProj !== null) {
          gpuRenderFrustum(camViewProj, frustumScratch)
          sUni.set(frustumScratch, SU.planes)
        }
        // 1. sortKeys — the (key, index) pairs for [0, padN) AND the
        //    network's initial (k, j) = (2, 1) seeded into records[0..1]
        const netWorkgroups = Math.ceil(padN / WORKGROUP)
        gpu.runKernel(sortId, 'sortKeys', sUni, netWorkgroups)
        // 2. the bitonic network — SELF-DRIVING: the (k, j) lives in the
        //    records head (sortKeys seeded it; sortStep advances it). The
        //    frame's compute dispatches share ONE encoder — a per-pass
        //    uniform would collapse to the LAST queue.writeBuffer (all the
        //    writes land before ANY dispatch runs), so the pass state must
        //    travel in a BOUND buffer. [bitonic, sortStep] × the canonical
        //    pass count — the SAME (k, j) sequence gpuSortPassSequence walks
        //    (the GLSL twin's uniforms are set at pass EXECUTION time on
        //    the immediate GL path — it takes the direct form).
        if (cfg.sort) {
          let passes = 0
          gpuSortPassSequence(padN, () => { passes++ })
          for (let p = 0; p < passes; p++) {
            gpu.runKernel(sortId, 'bitonic', sUni, netWorkgroups)
            gpu.runKernel(sortId, 'sortStep', sUni, 1)
          }
        }
        // 3. the sorted pack — the records [0, count) in draw order (the
        //    pack overwrites the network's (k, j) scratch at records[0..1])
        gpu.runKernel(sortId, 'pack', sUni, workgroups)
      } else {
        gpu.runKernel(computeId, 'pack', uni, workgroups)
      }
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
