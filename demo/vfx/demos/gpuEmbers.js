// gpuEmbers.js — the GPGPU TIER SHOWCASE (Task 131, the optimization
// program's Phase 2): ONE HUNDRED SIXTY THOUSAND embers simulated ON THE
// GPU — the compute-shader advance, the storage-buffer state, the
// GPU-side record pack, ZERO per-frame CPU→GPU particle traffic. The
// page's perf readout (the pill + window.__vfxPerf) tells the tier story.
//
//   · THE TIER SPLIT (the dual-backend contract): WebGPU runs the compute
//     tier (sim:'gpu' — 160k embers; the forces, the aging, the wrap and
//     the instance-record pack all run as compute passes; the CPU keeps
//     emission + death + compaction — a few tenths of a millisecond).
//     WebGL2 HAS NO COMPUTE — the same demo runs the CPU tier
//     (sim:'cpu', 32k: the same look, the density the software GL can
//     carry). The LOOK is the same class of storm; the COUNT is the tier.
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
import { createGpuParticles } from '../../../dist/rune.esm.js?v=131'

const GPU_CAPACITY = 160_000
const CPU_CAPACITY = 32_000
const BOX = [46, 22, 46] // the wrap volume (the kiln)

export default {
  title: 'GPU Embers',
  sub: 'the compute tier · 160k GPU-simmed embers (WebGL2: the CPU tier at 32k) · zero per-frame particle uploads',
  camera: { yaw: 0.6, pitch: 0.34, dist: 13, orbit: 0.05, target: [0, 4.5, 0] },

  make(env) {
    const gpu = env.backend === 'webgpu'
    const tier = gpu ? 'gpu' : 'cpu'
    const capacity = gpu ? GPU_CAPACITY : CPU_CAPACITY
    const counters = (typeof window !== 'undefined' && window.__vfxCounters) || {}
    counters.tier = tier
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
        render: { kind: 'billboard', draw: 'instance', mode: 'camera', spin: 0.8 },
        sim: gpu ? 'gpu' : 'cpu',
      }),
      material: env.materials.bbSprite,
      pipeline: env.pipelines.additive,
      texture: () => env.sparkTexture,
    })

    // ── the GPU tier's backend: the buffers + the compute passes ──
    let gpuBackend = null
    if (gpu) {
      gpuBackend = createGpuParticles(embers.facade, env.renderer.inner.gpu)
      embers.gpuBackend = gpuBackend
    }

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
    const perf = { tier, capacity, count: 0, ms: 0 }
    if (typeof window !== 'undefined') window.__vfxPerf = perf
    let msAvg = 16
    let last = 0

    return {
      frame(ctx) {
        // THE TIER SEQUENCE: advance (emission/death/compaction on the
        // CPU) → the GPU step (the compact replay, the force walk, the
        // record pack) → the harness draws from the external buffer.
        embers.facade.advance(ctx.dt)
        if (gpuBackend !== null) gpuBackend.step(ctx.dt)
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
        if (gpuBackend !== null) gpuBackend.dispose()
      },
    }
  },
}
