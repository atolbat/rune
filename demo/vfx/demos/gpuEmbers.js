// gpuEmbers.js — the GPGPU TIER SHOWCASE (Task 131, the optimization
// program's Phase 2; Task 132 — the tier now runs on BOTH backends; Task
// 134 — THE RENDER TIER: the per-particle frustum cull and the BITONIC
// SORT (?sort=1 — the 160k-particle painter's order, the records land
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
// Task 138 — THE REAL-GPU TF PIPELINE BY DEFAULT: the hardware oracle
// (the user's live re-run confirmation on a real GPU) closed the last
// remaining item — on anything but the software-GL class, the WebGL2 TF
// leg takes the FULL GPU pipeline with no opt-ins (emit:'gpu' + the
// frustum cull — the dedicated emitOut buffer keeps the barrier
// discipline, and the PBO round-trips are hardware paths off the
// software GL); SwiftShader/llvmpipe keep the proven conservative
// defaults. The value-aware flags override BOTH branches: ?emit=1 /
// ?cull=1 force the GPU path on any hardware, ?emit=0 / ?cull=0 force
// the CPU path (the escape hatch — a real-GPU regression falls back
// without a code change).
//
//   · THE COMMON POINT (Task 132): createGpuParticles(facade, backend)
//     dispatches by the facade's shape — WebGPU compute (the SSBO tier,
//     160k) or WebGL2 transform feedback (the TF tier — 16k on the
//     software-GL class, 160k on a real GPU [Task 137]; the full GPU
//     pipeline — GPU emission + the cull — on both real legs [Task 138]).
//     The LOOK is the same class of storm; the COUNT is the backend's
//     budget.
//
//   · THE STORM: a wrapped kiln-volume of embers — buoyant lift (negative
//     gravity), drag, the simplex flow field, the sine turbulence — embers
//     rise in curling columns, dim and brighten over long lives, re-enter
//     through the walls (the ENDLESS volume). A deep ember-lit floor
//     grounds it; a slow camera orbit reads the depth.
//
//   · THE HOOKS: window.__vfxPerf = { tier, capacity, count, ms, emit,
//     cull, softwareGL } — the probe gates pin the tier + the frame cost
//     + the hardware-policy branch; window.__vfxCounters.embers — the
//     emission counters.
import { createGpuParticles } from '../../../dist/rune.esm.js?v=140'

// Task 140 — THE AUTO-FALLBACK CHANNEL (the real-GPU invisible-particles
// report: "no freeze anymore, but the particles are gone while the counter
// keeps counting"). The container validated the whole pipeline end-to-end
// (records SANE, the instanced draw issued, the framebuffer warm) — so a
// live-driver drop of the transform-feedback write (or a draw-side
// staleness the software raster never sees) is the remaining suspect
// class, and a blank screen tells the user nothing. THE CONTRACT: when this
// demo's own two-stage self-check (the tier's one-shot records readback at
// frame ~30, then the in-frame canvas pixel sample at frame ~45) verdicts
// the GPU pipeline BROKEN on this driver, the demo sets
// window.__embersFallback and asks the shell for a one-time re-make — the
// fresh make reads the flag and takes the CONSERVATIVE path (emit:'cpu',
// cull off — the Task-137-era configuration the user's GPU demonstrably
// rendered), with a console warning that says exactly what happened and
// how to retry the GPU pipeline (?emit=1). A reload clears the flag.
const FALLBACK_FLAG = '__embersFallback'

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
// Task 138 — the value-aware flags (the override mechanics for BOTH
// hardware branches): ?emit=1 / ?cull=1 force the GPU pipeline on, the
// bare ?emit / ?cull keep the old force-on meaning, and ?emit=0 /
// ?cull=0 force the conservative path off — the escape hatch for a
// real-GPU regression (no code change needed to fall back). ?sort stays
// the pure opt-in (the additive blend composites order-independently —
// the network is the ALPHABLEND tier's tool).
const PARAMS = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null
const flagOn = (name) => PARAMS !== null && PARAMS.has(name) && (PARAMS.get(name) === '' || PARAMS.get(name) === '1')
const flagOff = (name) => PARAMS !== null && PARAMS.get(name) === '0'
const WANT_SORT = flagOn('sort')
const FORCE_EMIT = flagOn('emit')
const FORCE_EMIT_OFF = flagOff('emit')
const FORCE_CULL = flagOn('cull')
const FORCE_CULL_OFF = flagOff('cull')
// Task 138 — THE REAL-GPU TF PIPELINE: a real GPU takes the full GPU
// pipeline by DEFAULT now — emit:'gpu' + the frustum cull (the hardware
// oracle: the user's live confirmation on a real GPU; the dedicated
// emitOut buffer keeps the one-producer/one-consumer barrier discipline,
// and the pairs/emit PBO round-trips are hardware paths off the software
// GL). The software-GL class keeps the proven CPU defaults (Task 135's
// queue-serialization constraint) — the flags above override both.
const TF_GPU_PIPELINE = !SOFTWARE_GL
// Task 140 — the one-time conservative re-make: after a self-check verdict
// the flag sticks until the page reloads (the fallback session stays
// conservative — no flapping between modes mid-run). READ AT MAKE TIME —
// the flag lands DURING a live session (the re-make must see it; a
// module-scope constant would freeze the import-time value).
const fellBack = () => typeof window !== 'undefined' && window[FALLBACK_FLAG] === true

export default {
  title: 'GPU Embers',
  sub: 'the GPGPU tier · 160k compute-simmed, GPU-EMITTED embers · the full GPU pipeline on BOTH backends by default (WebGL2: the transform-feedback tier — 160k + GPU emission + the frustum cull on real GPUs; SwiftShader/llvmpipe keep the conservative CPU defaults) · zero per-frame particle uploads',
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
    // Task 138 — the pipeline policy (explicit HERE, where the compute leg
    // is known): the compute leg always took the GPU pipeline; the TF leg
    // takes it by default on a real GPU (the hardware oracle) and keeps the
    // conservative CPU path on the software-GL class; the value-aware
    // flags override both branches in both directions.
    const fell = fellBack()
    const emitGpu = (compute || TF_GPU_PIPELINE || FORCE_EMIT) && !FORCE_EMIT_OFF && !fell
    const cullOn = (compute || TF_GPU_PIPELINE || FORCE_CULL) && !FORCE_CULL_OFF && !fell
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
        // Task 135/138 — THE GPU EMISSION: the newborns' rows are generated
        // ON the GPU (the hash-RNG append pass — the same hash stream, the
        // same salt order; the CPU keeps the life ledger only). The
        // opening 53k burst and the 20k/s stream cost ~0 CPU — on the
        // COMPUTE leg and on a REAL-GPU TF leg (Task 138's default); the
        // software-GL TF leg keeps emit:'cpu' (?emit=1 forces it on).
        emit: emitGpu ? 'gpu' : 'cpu',
        // Task 134/138 — THE RENDER TIER: cull (the frustum gate — the
        // off-screen kiln walls stop drawing; the compute leg and the
        // real-GPU TF leg by default, ?cull=0 the escape hatch) + the
        // opt-in sort (?sort=1 — the additive blend needs no order).
        render: { kind: 'billboard', draw: 'instance', mode: 'camera', spin: 0.8, cull: cullOn, sort: WANT_SORT },
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
    // Task 138 — the policy fields: `emit`, `cull`, `softwareGL` pin the
    // hardware branch the page took (the probe asserts the software leg
    // stays conservative in the container and the flags flip it).
    // Task 140 — `fallback: 'selfcheck'` when the one-time conservative
    // re-make happened (the two-stage self-check verdicted the GPU
    // pipeline broken on this driver).
    const perf = { tier: 'gpu', capacity, count: 0, ms: 0, emit: emitGpu ? 'gpu' : 'cpu', cull: cullOn, sort: WANT_SORT, softwareGL: SOFTWARE_GL, ...(fell ? { fallback: 'selfcheck' } : {}) }
    if (typeof window !== 'undefined') window.__vfxPerf = perf
    let msAvg = 16
    let last = 0

    // ── Task 140 — THE TWO-STAGE SELF-CHECK + THE AUTO-FALLBACK ─────────
    //    Stage 1 (records): the TF tier's one-shot diagnostic (frame ~30) —
    //    it read the records buffer back and verdicted it (a driver that
    //    dropped the transform-feedback write leaves it degenerate while
    //    the CPU ledger counts).
    //    Stage 2 (pixels): at frame ~45 — with records SANE or unreadable
    //    — sample the CANVAS itself, in-frame, right after the ember draw:
    //    a live additive ember swarm at count > 1000 leaves bright pixels
    //    in the center; a blank canvas with a counting ledger = the draw
    //    or the raster side of the pipeline died. The sample reads the
    //    SAME WebGL2 context the renderer owns (canvas.getContext returns
    //    the cached one) — a one-shot wrapper on drawArraysInstanced that
    //    snapshots the framebuffer AFTER the ember draw (pre-swap, when
    //    the content is guaranteed present), then removes itself.
    //    THE REACTION: set the fallback flag, tell the console the whole
    //    story, and ask the shell for a one-time re-make (window.
    //    __vfxRemakeRequested — the main harness polls it at frame top).
    //    Gates: the compute leg never checks (SSBOs are not the class);
    //    the already-fallen-back session never checks; a LOW count never
    //    verdicts (the swarm might legitimately be empty).
    let checkStage = 0 // 0 = waiting for the records verdict, 1 = pixels, 2 = done
    let pixelsArmed = false
    let pixelsWarm = -1
    let frameCount = 0
    function armPixelCheck() {
      if (pixelsArmed || compute) return
      pixelsArmed = true
      const canvasEl = document.querySelector('canvas')
      const gl2 = canvasEl != null ? canvasEl.getContext('webgl2') : null
      if (gl2 == null) return
      const RW = Math.min(256, gl2.drawingBufferWidth)
      const RH = Math.min(256, gl2.drawingBufferHeight)
      const px = new Uint8Array(RW * RH * 4)
      const origDraw = gl2.drawArraysInstanced.bind(gl2)
      const unwrap = () => { gl2.drawArraysInstanced = origDraw }
      gl2.drawArraysInstanced = function (mode, first, count, instances) {
        const r = origDraw(mode, first, count, instances)
        if (instances > 1000) {
          unwrap()
          try {
            gl2.readPixels(Math.floor((gl2.drawingBufferWidth - RW) / 2), Math.floor((gl2.drawingBufferHeight - RH) / 2), RW, RH, gl2.RGBA, gl2.UNSIGNED_BYTE, px)
            let warm = 0
            for (let i = 0; i < px.length; i += 4) {
              if (px[i] + px[i + 1] + px[i + 2] > 90) warm++
            }
            pixelsWarm = warm
          } catch { pixelsWarm = -1 }
        }
        return r
      }
    }
    function triggerFallback(reason) {
      if (fellBack() || compute) return
      window[FALLBACK_FLAG] = true
      window.__vfxRemakeRequested = true
      perf.fallback = 'selfcheck'
      console.warn(`[rune/vfx] GPU Embers: ${reason} — this driver is dropping the WebGL2 transform-feedback pipeline. Falling back ONCE to the conservative path (CPU emission, no cull — the proven configuration). Reload to retry the GPU pipeline, or force it with ?emit=1&cull=1.`)
    }

    return {
      frame(ctx) {
        // THE TIER SEQUENCE: advance (emission/death/compaction on the
        // CPU) → the GPU step (the compact replay, the force walk, the
        // record pack — Task 134: the sort/cull family with the CAMERA —
        // the frame context's basis forward + mvp) → the harness draws
        // from the external buffer.
        embers.facade.advance(ctx.dt)
        gpuBackend.step(ctx.dt, { forward: ctx.basis.forward, viewProj: ctx.mvp })
        // Task 140 — the self-check ladder: stage 1 polls the tier's
        // one-shot records verdict; stage 2 arms the in-frame pixel
        // sample, then polls it; either failure triggers the one-time
        // conservative re-make.
        frameCount++
        if (!fellBack() && !compute) {
          if (checkStage === 0 && gpuBackend.diagnostics !== undefined && gpuBackend.diagnostics.checked) {
            const d = gpuBackend.diagnostics
            if (!d.sane) {
              triggerFallback(`the GPU tier's records read back degenerate at frame ${d.atFrame} (count ${d.count}, zeroRows ${d.zeroRows}, nan ${d.nan})`)
            } else {
              checkStage = 1
            }
          }
          if (checkStage === 1 && frameCount >= 45) {
            if (!pixelsArmed) armPixelCheck()
            else if (pixelsWarm >= 0) {
              if (pixelsWarm === 0 && embers.facade.count > 1000) {
                triggerFallback('the ember draw left ZERO bright pixels in the canvas while the ledger counted live particles')
              }
              checkStage = 2
            }
          }
        }
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
