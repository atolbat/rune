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
// Task 148 — THE FULL-CPU SELF-HEAL: the live Android-Chrome report
// ("the embers are invisible on WebGL2") exposed the Task-140
// conservative re-make as insufficient — emit:'cpu' + cull off still
// leaves the SIMULATION and the records pack ON the transform feedback,
// and a driver that drops the TF write drops the sim with them (the
// re-made page's own diagnostic re-verdicted degenerate at 69k live on
// the ledger — the exact log the user shipped). The one-time re-make now
// drops the TF tier ENTIRELY: the facade's own sim:'cpu' tier + the
// harness's per-frame records upload (the pre-Task-131 path — the one
// configuration every driver renders). The degenerate-records verdict is
// pixel-CONFIRMED before it fires (a lying readback no longer kills a
// demonstrably warm GPU tier — the canvas is the ground truth), and the
// healed capacity is hardware-aware (the CPU tier is per-particle JS
// work: 32k on coarse-pointer devices, the full 160k look on desktop).
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
import { createGpuParticles } from '../../../dist/rune.esm.js?v=149'

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
//
// Task 148 — THE RE-MAKE GOES FULL-CPU: the Task-140 conservative branch
// (emit:'cpu', cull off, sim STILL 'gpu') was the wrong conservative — a
// TF-broken driver drops the records pack exactly as it drops the emit
// pass, so the healed page stayed invisible (the live log: the re-made
// instance's own diagnostic re-verdicted degenerate). The flag now means:
// no transform-feedback tier AT ALL (sim:'cpu'), and the records verdict
// is only the SUSPICION — the in-frame canvas pixel sample CONFIRMS it
// (cold canvas + counting ledger → re-make; warm canvas → the readback
// lied, the GPU tier stays).
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
// Task 148 — THE SELF-HEALED CAPACITY: the CPU tier's cost is per-particle
// on the JS thread (the Task-142 etalons: ~88 ns/particle full-load,
// ~216 ns/spawn on a desktop core) — a phone's core runs that 2-4× slower,
// and the phone class is exactly where the broken-TF drivers live. The
// healed tier takes a coarse-pointer budget that stays dense AND smooth
// there (32k); the software-GL class keeps its own 16k; a desktop keeps
// the full 160k look (~16-20 ms CPU — the honest regression budget).
const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
const FALLBACK_CAPACITY = SOFTWARE_GL ? 16_000 : COARSE ? 32_000 : GPU_CAPACITY
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
  sub: 'the GPGPU tier · 160k compute-simmed, GPU-EMITTED embers · the full GPU pipeline on BOTH backends by default (WebGL2: the transform-feedback tier — 160k + GPU emission + the frustum cull on real GPUs; SwiftShader/llvmpipe keep the conservative CPU defaults) · zero per-frame particle uploads · self-heals to the CPU tier when a driver drops the transform feedback',
  camera: { yaw: 0.6, pitch: 0.34, dist: 13, orbit: 0.05, target: [0, 4.5, 0] },

  make(env) {
    // THE TIER: WebGPU → the compute tier (160k); WebGL2 → the
    // TRANSFORM-FEEDBACK tier (Task 137: hardware-aware — 160k on a real
    // GPU, 16k on the software-GL class). Both GPU legs are sim:'gpu' —
    // the facade contract is backend-neutral; the Task-148 HEALED session
    // drops to the facade's own sim:'cpu' tier instead.
    const compute = env.backend === 'webgpu'
    const counters = (typeof window !== 'undefined' && window.__vfxCounters) || {}
    // Task 148 — THE VERDICT BINDS THE TF LEG ONLY: the compute/SSBO tier is
    // a different mechanism (a backend switch after a WebGL2 verdict keeps
    // the full compute pipeline — the flag no longer conservatizes the
    // WebGPU leg), and the explicit force flags (?emit=1 / ?cull=1 — the
    // console story's "force it back on") override the session flag too: a
    // forced re-make re-takes the TF tier at the FULL capacity, and the
    // ladder is off while the flag is set, so the escape hatch cannot loop.
    const fell = fellBack()
    const forceGpu = FORCE_EMIT || FORCE_CULL
    // THE HEALED SHAPE: no TF tier at all — the facade's own CPU tier
    // (sim:'cpu': the simulation, the emission AND the records on the CPU,
    // the harness's per-frame upload path — the one configuration every
    // driver renders).
    const gpuTier = compute || (!fell || forceGpu)
    // Task 138 — the pipeline policy (explicit HERE, where the compute leg
    // is known): the compute leg always took the GPU pipeline; the TF leg
    // takes it by default on a real GPU (the hardware oracle) and keeps the
    // conservative CPU path on the software-GL class; the value-aware
    // flags override both branches in both directions.
    const emitGpu = !FORCE_EMIT_OFF && (compute || (TF_GPU_PIPELINE && !fell) || FORCE_EMIT)
    const cullOn = !FORCE_CULL_OFF && (compute || (TF_GPU_PIPELINE && !fell) || FORCE_CULL)
    const capacity = compute ? GPU_CAPACITY : (fell && !forceGpu ? FALLBACK_CAPACITY : TF_CAPACITY)
    counters.tier = gpuTier ? 'gpu' : 'cpu'
    if (typeof window !== 'undefined') window.__vfxCounters = counters
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
        emit: gpuTier && emitGpu ? 'gpu' : 'cpu',
        // Task 134/138 — THE RENDER TIER: cull (the frustum gate — the
        // off-screen kiln walls stop drawing; the compute leg and the
        // real-GPU TF leg by default, ?cull=0 the escape hatch) + the
        // opt-in sort (?sort=1 — the additive blend needs no order).
        render: { kind: 'billboard', draw: 'instance', mode: 'camera', spin: 0.8, cull: cullOn, sort: WANT_SORT },
        sim: gpuTier ? 'gpu' : 'cpu',
      }),
      material: env.materials.bbSprite,
      pipeline: env.pipelines.additive,
      texture: () => env.sparkTexture,
    })

    // ── the GPU tier's backend: the buffers + the passes ──
    // THE COMMON POINT: one call — the WebGPU compute tier or the WebGL2
    // transform-feedback tier, dispatched by the facade's shape. Task 148 —
    // the HEALED session skips it entirely: a CPU-tier facade needs no GPU
    // backend (the harness's own per-frame upload path draws it).
    let gpuBackend = null
    if (gpuTier) {
      const backendFacade = env.renderer.inner[compute ? 'gpu' : 'gl']
      gpuBackend = createGpuParticles(embers.facade, backendFacade)
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
    // Task 138 — the policy fields: `emit`, `cull`, `softwareGL` pin the
    // hardware branch the page took (the probe asserts the software leg
    // stays conservative in the container and the flags flip it).
    // Task 140 — `fallback: 'selfcheck'` when the one-time conservative
    // re-make happened (the two-stage self-check verdicted the GPU
    // pipeline broken on this driver).
    const perf = { tier: gpuTier ? 'gpu' : 'cpu', capacity, count: 0, ms: 0, emit: gpuTier && emitGpu ? 'gpu' : 'cpu', cull: cullOn, sort: WANT_SORT, softwareGL: SOFTWARE_GL, pixelCheck: (compute || !gpuTier) ? 'off' : undefined, ...(fell ? { fallback: 'selfcheck' } : {}) }
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
    //
    //    Task 148 — THE PIXEL-CONFIRMED VERDICT: a degenerate records
    //    readback alone is NOT the fallback verdict anymore. The readback
    //    itself can be the liar (the Task-140 forensics class — the
    //    compositor lied about warmth in-container; a driver can lie about
    //    getBufferSubData the same way), and downgrading a demonstrably
    //    WARM GPU tier on a lying diagnostic is a bad trade. So the
    //    degenerate verdict LATCHES a suspicion and arms the in-frame
    //    pixel sample immediately — the CANVAS settles it (the ground
    //    truth of "the user sees particles"): cold pixels + a counting
    //    ledger → the one-time full-CPU re-make; warm pixels → the readback
    //    is the liar, the GPU tier stays (a console.info carries the
    //    forensics). Sane records still walk the original Task-140 path
    //    (the pixel sample at frame ~45 — a draw-side death the records
    //    cannot see). A pixel confirmation that never lands (readPixels
    //    refused, no qualifying draw for 90 frames) falls back on the
    //    records verdict alone — the conservative choice, delayed.
    let checkStage = 0 // 0 = waiting for the records verdict, 1 = pixels, 2 = done
    let suspectReason = null // the latched degenerate-records verdict, awaiting the pixel confirmation
    let pixelsArmed = false
    let pixelsWarm = -1
    let armFrame = -1
    let frameCount = 0
    function armPixelCheck() {
      if (pixelsArmed || compute) return
      pixelsArmed = true
      armFrame = frameCount
      perf.pixelCheck = 'armed'
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
      console.warn(`[rune/vfx] GPU Embers: ${reason} — this driver is dropping the WebGL2 transform-feedback pipeline. Falling back ONCE to the facade's own CPU tier (sim:'cpu' — the simulation, the emission and the records all on the CPU, per-frame uploads, no transform feedback: the one configuration every driver renders). Reload to retry the GPU pipeline, or force it with ?emit=1&cull=1.`)
    }

    return {
      frame(ctx) {
        // THE TIER SEQUENCE: advance (emission/death/compaction on the
        // CPU) → the GPU step (the compact replay, the force walk, the
        // record pack — Task 134: the sort/cull family with the CAMERA —
        // the frame context's basis forward + mvp) → the harness draws
        // from the external buffer. Task 148 — the HEALED session has no
        // GPU step at all (the facade's own advance IS the simulation;
        // the harness's per-frame upload path draws the CPU records).
        embers.facade.advance(ctx.dt)
        gpuBackend?.step(ctx.dt, { forward: ctx.basis.forward, viewProj: ctx.mvp })
        // Task 148 — the self-check ladder (pixel-confirmed): stage 1
        // polls the tier's one-shot records verdict — degenerate LATCHES
        // the suspicion (the readback can lie; the canvas settles it),
        // sane walks the original frame-~45 draw-side check; stage 2 arms
        // the in-frame pixel sample, then polls it — cold + counting →
        // the one-time full-CPU re-make, warm → the suspicion clears.
        frameCount++
        if (gpuBackend !== null && !fellBack() && !compute) {
          if (checkStage === 0 && gpuBackend.diagnostics !== undefined && gpuBackend.diagnostics.checked) {
            const d = gpuBackend.diagnostics
            if (d.sane) {
              checkStage = 1
            } else {
              suspectReason = `the GPU tier's records read back degenerate at frame ${d.atFrame} (count ${d.count}, zeroRows ${d.zeroRows}, nan ${d.nan})`
              checkStage = 1
            }
          }
          if (checkStage === 1 && (frameCount >= 45 || suspectReason !== null)) {
            if (!pixelsArmed) armPixelCheck()
            else if (pixelsWarm >= 0) {
              const live = embers.facade.count
              if (pixelsWarm === 0 && live > 1000) {
                triggerFallback(suspectReason !== null
                  ? `${suspectReason} — and the canvas pixel sample confirmed it cold at frame ${frameCount}: ZERO bright pixels while the ledger counted ${live} live particles`
                  : 'the ember draw left ZERO bright pixels in the canvas while the ledger counted live particles')
                perf.pixelCheck = 'cold'
                checkStage = 2
              } else if (suspectReason !== null) {
                // WARM canvas (or a swarm too small to verdict) against a
                // degenerate records readback: the draw is demonstrably
                // alive — the READBACK is the liar on this driver.
                if (pixelsWarm > 0) {
                  console.info(`[rune/vfx] GPU Embers: the records readback verdicted DEGENERATE but the canvas reads WARM (${pixelsWarm} bright pixels, ledger ${live}) — the readback itself is unreliable on this driver; staying on the GPU tier.`)
                }
                perf.pixelCheck = 'warm'
                checkStage = 2
                suspectReason = null
              } else {
                perf.pixelCheck = pixelsWarm > 0 ? 'warm' : 'cold'
                checkStage = 2
              }
            } else if (suspectReason !== null && armFrame >= 0 && frameCount - armFrame > 90) {
              // the pixel confirmation never landed (readPixels refused,
              // no qualifying draw) — the records verdict stands alone
              triggerFallback(`${suspectReason} — and the pixel confirmation never landed (frame ${frameCount})`)
              perf.pixelCheck = 'cold'
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
        gpuBackend?.dispose()
      },
    }
  },
}
