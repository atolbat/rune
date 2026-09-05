// gpuEmbers.js — the GPGPU TIER SHOWCASE (Task 131, the optimization
// program's Phase 2; Task 132 — the tier now runs on BOTH backends; Task
// 134 — THE RENDER TIER: the per-particle frustum cull rides the compute
// leg by default (?cull=1 forces it on the TF leg) and the BITONIC SORT
// is ?sort=1 (the 160k-particle painter's order — the records land
// far-to-near); Task 135 — GPU-SIDE EMISSION: the newborns are GENERATED
// ON THE GPU (the hash-RNG append pass — the same hash stream the CPU
// reference spawns through; the CPU keeps the life ledger only, and the
// 53k-particle opening burst costs ~0 CPU instead of ~11 ms): ONE
// HUNDRED SIXTY THOUSAND embers simulated AND EMITTED ON THE GPU — the
// compute-shader advance over a storage buffer (WebGPU) or the
// transform-feedback passes over a float texture (WebGL2 — the SSBO's
// twin, the SAME handoff and the SAME 16-float instance records), the
// GPU-side record pack, ZERO per-frame CPU→GPU particle traffic. The
// page's perf readout (the pill + window.__vfxPerf) tells the tier story.
//
//   · THE COMMON POINT (Task 132): createGpuParticles(facade, backend)
//     dispatches by the facade's shape — WebGPU compute (the SSBO tier,
//     160k) or WebGL2 transform feedback (the TF tier, 16k — the software
//     GL's budget; real GPUs carry the same tier). The LOOK is the same
//     class of storm; the COUNT is the backend's budget.
//
//   · THE STORM: a wrapped kiln-volume of embers — buoyant lift (negative
//     gravity), drag, the simplex flow field, the sine turbulence — embers
//     rise in curling columns, dim and brighten over long lives, re-enter
//     through the walls (the ENDLESS volume). A deep ember-lit floor
//     grounds it; a slow camera orbit reads the depth.
//
//   · THE HOOKS: window.__vfxPerf = { tier, capacity, count, ms } — the
//     probe gate (scripts/task131-sim-probe.mjs) pins the tier + the
//     frame cost; window.__vfxCounters.embers — the emission counters.
import { createGpuParticles } from '../../../dist/rune.esm.js?v=137'

// Task 137 — the WebGL2 TF budget is now HARDWARE-AWARE: the 16k cap was
// the SwiftShader/software-GL budget (the container's gate-hostile class:
// 32k at 1280×800 SwiftShader ≈ 12 fps) — but a REAL GPU carries the SAME
// 160k as the compute tier (the TF path's per-frame cost is driver-bound,
// not fill-bound). The user's report — "way fewer particles on WebGL" —
// was exactly this: a real browser hitting the software-GL budget. Probe
// the renderer string (UNMASKED_RENDERER_WEBGL — Chrome exposes it for
// debugging; Firefox 44+ too); a SwiftShader/llvmpipe/software match keeps
// the conservative 16k, anything else takes the full tier. The probe's
// own context is lost immediately (the browser's per-page context budget
// is finite — see the renderer dispose fix in the same task).
const GPU_CAPACITY = 160_000
const SOFTWARE_GL = (() => {
  try {
    if (typeof document === 'undefined') return false
    const probe = document.createElement('canvas').getContext('webgl2')
    if (probe === null) return false
    const dbg = probe.getExtension('WEBGL_debug_renderer_info')
    const name = dbg !== null ? String(probe.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? '') : ''
    const software = /swiftshader|software|llvmpipe|softpipe|basic render|angle \(google/i.test(name)
    probe.getExtension('WEBGL_lose_context')?.loseContext()
    return software
  } catch { return false }
})()
const TF_CAPACITY = SOFTWARE_GL ? 16_000 : 160_000
const BOX = [46, 22, 46] // the wrap volume (the kiln)
// Task 134 — the render tier's opt-ins: the bitonic painter's order is
// ?sort=1 (the additive blend composites order-independently; the network
// is the ALPHABLEND tier's tool); the frustum cull rides the COMPUTE leg
// by default (two cheap dispatches) and is ?cull=1 on the TF leg — the
// software GL's PBO round-trips are copied on CPU (the "TexSubImage with
// unpack buffer" performance warning — the documented container class;
// real GPUs take the hardware path). The smoke gate runs the WebGL2 leg
// AS TUNED (Task 132's 16k budget); the probe (task134-vfx-probe.mjs)
// exercises BOTH flags with generous JS-side aliveness checks.
const WANT_SORT = typeof location !== 'undefined' && new URLSearchParams(location.search).has('sort')
const FORCE_CULL = typeof location !== 'undefined' && new URLSearchParams(location.search).has('cull')
// Task 135 — the GPU emission: ON for the COMPUTE leg (WebGPU — fully
// gated: the raw-device parity gate + the live probes); the TF leg keeps
// emit:'cpu' by default with ?emit=1 as the opt-in (the software GL's
// queue serialization stalls the interleaved TF/PBO cycles — the
// documented container class; a real-GPU WebGL2 leg takes the GPU path —
// the values themselves are pinned by the in-page GLSL gate).
const FORCE_EMIT = typeof location !== 'undefined' && new URLSearchParams(location.search).has('emit')

export default {
  title: 'GPU Embers',
  sub: 'the GPGPU tier · 160k compute-simmed, GPU-EMITTED embers (WebGL2: the transform-feedback tier — 160k on real GPUs, 16k on software GL) · zero per-frame particle uploads',
  camera: { yaw: 0.6, pitch: 0.34, dist: 13, orbit: 0.05, target: [0, 4.5, 0] },

  make(env) {
    // THE TIER: WebGPU → the compute tier (160k); WebGL2 → the
    // TRANSFORM-FEEDBACK tier (Task 137: hardware-aware — 160k on a real
    // GPU, 16k on the software-GL class). Both are sim:'gpu' — the facade
    // contract is backend-neutral.
    const compute = env.backend === 'webgpu'
    const capacity = compute ? GPU_CAPACITY : TF_CAPACITY
    const counters = (typeof window !== 'undefined' && window.__vfxCounters) || {}
    counters.tier = 'gpu'
    if (typeof window !== 'undefined') window.__vfxCounters = counters

    // ── the embers: one facade, tiered by the backend ──
    const EMBER_S = {
      shape: { kind: 'disc', origin: [0, -1.5, 0], axis: [0, 1, 0], radius: [2, 16] },
      velocity: { mode: 'fixed', dir: [0.06, 1, 0.04] },
      speed: [0.4, 1.4], life: [5, 11], size: [0.03, 0.1],
      color: [[1, 0.62, 0.22, 1], [1, 0.86, 0.4, 0.9], [0.95, 0.4, 0.12, 0.95]], seed: 417,
    }
    const embers = env.addLayer({
      id: 'ge-embers',
      facade: env.createParticles({
        capacity,
        // the steady state: rate × life ≈ the standing swarm
        rate: Math.round(capacity / 8),
        bursts: [{ time: 0.02, count: Math.round(capacity / 3), cycle: 0, interval: 30, probability: 1 }],
        wrap: { size: BOX },
        ramp: env.createRamp([
          // born dark, flaring bright, dimming out — the ember's life
          { t: 0, size: 0.6, r: 0.55, g: 0.18, b: 0.05, a: 0 },
          { t: 0.12, size: 1, r: 1, g: 0.58, b: 0.16, a: 0.9 },
          { t: 0.55, size: 0.92, r: 1, g: 0.74, b: 0.28, a: 0.7 },
          { t: 1, size: 0.4, r: 0.7, g: 0.2, b: 0.06, a: 0 },
        ]),
        forces: {
          // the buoyant kiln: lift, drag, the flow field, the wander
          gravity: [0, 0.85, 0], drag: 0.22,
          turbulence: 0.35,
          noise: { strength: 1.6, scale: 0.16, speed: 0.21 },
        },
        spawner: EMBER_S,
        // Task 135 — THE GPU EMISSION: the newborns' rows are generated
        // ON the GPU (the hash-RNG append pass — the same hash stream, the
        // same salt order; the CPU keeps the life ledger only). The
        // opening 53k burst and the 20k/s stream cost ~0 CPU — on the
        // COMPUTE leg; the TF leg takes it with ?emit=1.
        emit: compute || FORCE_EMIT ? 'gpu' : 'cpu',
        // Task 134 — THE RENDER TIER: cull (the frustum gate — the
        // off-screen kiln walls stop drawing; the compute leg by default,
        // ?cull=1 forces it on the TF leg) + the opt-in sort (?sort=1).
        render: { kind: 'billboard', draw: 'instance', mode: 'camera', spin: 0.8, cull: compute || FORCE_CULL, sort: WANT_SORT },
        sim: 'gpu',
      }),
      material: env.materials.bbSprite,
      pipeline: env.pipelines.additive,
      texture: () => env.sparkTexture,
    })

    // ── the GPU tier's backend: the buffers + the passes ──
    // THE COMMON POINT: one call — the WebGPU compute tier or the WebGL2
    // transform-feedback tier, dispatched by the facade's shape.
    const backendFacade = env.renderer.inner[compute ? 'gpu' : 'gl']
    const gpuBackend = createGpuParticles(embers.facade, backendFacade)
    embers.gpuBackend = gpuBackend

    // ── the ground: a dark ember-lit floor (the storm's context) ──
    env.addMesh({
      id: 'ge-floor',
      geometry: env.geometry.plane(70, 70, 1, 1),
      material: env.materials.lambert,
      uniforms: { u_albedo: [0.09, 0.05, 0.035, 1] },
      model: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    })
    // the ember-glow pool under the storm (a faint additive disc)
    const pool = env.addLayer({
      id: 'ge-pool',
      facade: env.createParticles({
        capacity: 1,
        bursts: [{ time: 0.01, count: 1, cycle: 0, interval: 1e9, probability: 1 }],
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 0.5, b: 0.15, a: 0.32 },
          { t: 1, size: 1, r: 1, g: 0.5, b: 0.15, a: 0.32 },
        ]),
        spawner: {
          shape: { kind: 'disc', origin: [0, 0.06, 0], axis: [0, 1, 0], radius: [0, 9] },
          velocity: { mode: 'fixed', dir: [0, 1, 0] }, speed: [0, 0],
          life: [1e9, 1e9], size: [1, 1], color: [[1, 1, 1, 1]], seed: 1,
        },
        render: { kind: 'billboard', draw: 'instance', mode: 'horizontal' },
      }),
      material: env.materials.bbSprite,
      pipeline: env.pipelines.oneAdd,
      texture: () => env.glowTexture,
    })
    void pool

    // ── the perf report (the probe gate reads it) ──
    const perf = { tier: 'gpu', capacity, count: 0, ms: 0, emit: compute || FORCE_EMIT ? 'gpu' : 'cpu' }
    if (typeof window !== 'undefined') window.__vfxPerf = perf
    let msAvg = 16
    let last = 0

    return {
      frame(ctx) {
        // THE TIER SEQUENCE: advance (emission/death/compaction on the
        // CPU) → the GPU step (the compact replay, the force walk, the
        // record pack — Task 134: the sort/cull family with the CAMERA —
        // the frame context's basis forward + mvp) → the harness draws
        // from the external buffer.
        embers.facade.advance(ctx.dt)
        gpuBackend.step(ctx.dt, { forward: ctx.basis.forward, viewProj: ctx.mvp })
        // the perf: a 30-frame moving average of the frame callback's own
        // cost (the sim + the step — the rasterization rides on top)
        const now = performance.now()
        if (last > 0) {
          const dt = now - last
          if (dt < 250) msAvg = msAvg * 0.97 + dt * 0.03
        }
        last = now
        perf.count = embers.facade.count
        perf.ms = +msAvg.toFixed(2)
      },
      dispose() {
        gpuBackend.dispose()
      },
    }
  },
}
