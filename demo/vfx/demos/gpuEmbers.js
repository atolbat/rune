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
// Task 149 — THE TWO-RUNG LADDER: the user's decisive live experiment
// (?emit=0&cull=0 on a COLD page load — the exact Task-137 configuration:
// 160k TF, emit:'cpu', cull off) rendered the FULL swarm, records SANE,
// canvas WARM: the driver lands the MINIMAL tier's transform-feedback
// writes perfectly, and only the FULL pipeline's passes (the GPU
// emission + the cull family) drop. Task 148's straight-to-CPU jump
// treated a ONE-RUNG problem with a TWO-RUNG drop and cost this phone
// its 160k. The heal now steps down ONE RUNG PER VERDICT: level 0 (the
// full pipeline) fails → level 1 — the CONSERVATIVE TF tier (emit:'cpu',
// cull off, the sim and the records pack still on the GPU at the FULL
// capacity), re-booted on a FRESH GL context (the re-make channel
// re-boots the renderer — the exact cell the live proof validated: a
// context the full pipeline never ran on) and re-verdicted live by the
// same pixel-confirmed ladder; level 1 fails → level 2 — Task 148's
// full-CPU safe harbor. Each rung fires at most once per session (no
// flapping, no loop); ?emit=1&cull=1 re-take the full pipeline at level
// 0; a reload clears the ladder.
//
// Task 150 — THE ISOLATION WALK: the ladder heals, but the phone's log
// still cannot say WHICH pass family drops the transform feedback (the
// candidates: the GPU-emission TF pass with its PBO slice round-trips,
// or the cull/sort family — sortKeys' pairsOut round-trip + the sorted
// pack). Before the 0→1 heal fires, the demo now runs the two-leg
// bisect ON THE REPORTING DEVICE itself, automatically: leg A = the
// full pipeline MINUS the cull family (the GPU emission alone), leg B =
// the full pipeline MINUS the emission (the cull family alone) — each
// re-booted on a FRESH GL context (the same full re-boot channel the
// 0→1 step rides) and re-verdicted live by the same pixel-confirmed
// self-check. Both legs complete → the FORENSIC VERDICT names the
// family ('emit' / 'cull' / 'both' / 'interaction' — the console warn
// carries the human story, window.__embersForensicResult the machine
// one), then the walk heals into rung 1 exactly as v150 did. Once per
// session; ?forensic=0 skips the walk (the heal fires immediately);
// the force flags keep it off entirely (manual mode wins); the compute
// leg never runs it.
//
// Task 151 — THE HONEST WALK (the 12:36 live log's lesson): the user's
// session caught the drop AND completed the walk — leg A DROPPED, leg B
// DROPPED, the verdict said "BOTH families drop independently" — and
// then the HEAL ITSELF (rung 1: the minimal configuration the user's
// own fresh-load experiment rendered clean at the full 160k) dropped
// exactly the same way. When the KNOWN-GOOD configuration drops, the
// variable is not the pass family: the session's CONTEXT-CREATION
// state is poisoned (that log entered the dropping state right after
// four renderer re-boots in 3.4 s — and the first wg→gl switch of the
// SAME session ran the full pipeline clean and visible for 10+ s).
// Three demo-tier fixes, the library untouched:
//   · THE CONTAMINATED-VERDICT CORRECTION — rung 1 dropping after a
//     completed walk fires a follow-up warn that declares the verdict
//     INCONCLUSIVE (the drop follows the context history, not the pass
//     family) + the machine-readable forensicResult.contaminated flag;
//   · THE MID-RUN WATCHDOG — the one-shot check (frames 30-45) verdicts
//     the tier's BIRTH, not its LIFE: that session's swarm died ~10 s
//     in with the machine silent. The pixel sample now re-arms
//     periodically (every ~300 frames): cold canvas + a counting
//     ledger TWICE in a row → the same pixel-confirmed ladder;
//   · THE RE-BOOT SETTLE (main.js) — the walk's re-boots take a 2 s
//     settle before the next context is born (Chrome reaps torn-down
//     GL contexts asynchronously; rapid create/destroy cycles are the
//     poisoning suspect) + a per-boot context index line in the log
//     (the next dropping log carries the correlate directly).
//
// Task 152 — THE KEEP-ALIVE + THE RELOAD CROSSING (the 13:27 live log's
// verdict): the context-index lines nailed the correlate — the session's
// FOURTH boot (WebGL2 #2, after GL #1 was disposed at the WG interlude)
// was born dead, and the walk's legs on fresh contexts #5/#6 (2 s settles
// between them) were born dead the same way, WHILE the first GL context
// of each fresh page renders the full pipeline clean (11:48: 26 s, 12:36:
// 10.6 s). The poison is PAGE-SCOPED and follows a prior GL context's
// DISPOSAL — WEBGL_lose_context included (Task 137's own eviction fix is
// the trigger on this driver class), and it does not cross a page reload.
// Two demo-tier moves, the library untouched:
//   · THE GL CONTEXT KEEP-ALIVE (main.js): the shell never disposes the
//     session's WebGL2 renderer — leaving GL toward WebGPU PARKS it
//     (stop() + the canvas and the boot's textures kept reachable) and
//     coming back RESURRECTS the very same context (the canvas
//     re-attached, the demo re-made, start()). The GL context count per
//     page stays ONE — the user's WG→GL→WG→GL flow re-enters the proven
//     clean cell instead of birthing a poisoned context #2. The
//     diagnostic re-boots (the walk's legs, the storage-less rung-1)
//     still take deliberately fresh contexts (boot('webgl2', {fresh})).
//   · THE RELOAD CROSSING (this file): a level-0 pixel-confirmed verdict
//     writes the sessionStorage heal marker (the rung + the demo index +
//     the drop reason) and reloads the page — the fresh page's FIRST GL
//     context is the one cell the conservative TF tier has rendered at
//     the full 160k in, live-verified. The fresh page boots straight
//     into WebGL2 at rung 1; if THAT drops too, its own ladder lands the
//     CPU tier in-page (rung 2 never crosses a boundary — loop-free by
//     construction). The auto isolation walk is retired from the default
//     path (?forensic=1 opts in — its fresh in-page contexts can only
//     echo the poisoned history on the reporting class); the mid-run
//     watchdog, the pixel-confirmed ladder and the ?emit=1&cull=1 escape
//     hatch are unchanged.
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
import { createGpuParticles } from '../../../dist/rune.esm.js?v=150'

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
//
// Task 149 — THE FLAG IS THE LADDER POSITION NOW: 1 = the conservative TF
// tier (Task 137's proven configuration — re-booted on a fresh context,
// re-verdicted live), 2 = the facade's own CPU tier (Task 148's terminal
// safe harbor). The verdict binds the TF leg ONLY (the compute/SSBO leg
// is a different mechanism — a backend switch after a WebGL2 verdict
// keeps the full compute pipeline), and the explicit force flags
// (?emit=1 / ?cull=1) treat the position as 0 (the retry re-takes the
// full pipeline at the FULL capacity, and the ladder is off while a flag
// is set, so the escape hatch cannot loop).
const FALLBACK_FLAG = '__embersFallback'
// Task 150 — THE ISOLATION WALK's session state (all on window — the
// walk spans re-boots, so it lives above any single make): __embersForensic
// is 'a' | 'b' while a leg is live (the fresh make reads it and PINS that
// leg's configuration: leg A = emit:'gpu' + cull off, leg B = emit:'cpu' +
// cull on — each the full pipeline minus one suspect family);
// __embersForensicDone — the walk already ran this session (once; a later
// 1→2 escalation never re-enters it); __embersForensicResult = { a, b,
// verdict } — 'clean' | 'dropped' per leg, the verdict ∈ 'emit' | 'cull' |
// 'both' | 'interaction' (the gates assert it, the user's log carries it).
const FORENSIC_FLAG = '__embersForensic'
const forensicLeg = () => {
  if (typeof window === 'undefined') return null
  const v = window[FORENSIC_FLAG]
  return v === 'a' || v === 'b' ? v : null
}
const forensicDone = () => typeof window !== 'undefined' && window.__embersForensicDone === true
// Task 150 — completeLeg: a leg's self-check reached its verdict → record
// it, then advance the walk. Leg A completes → leg B on the NEXT fresh
// context; leg B completes → THE FORENSIC VERDICT (which family drops on
// this driver) + the heal into rung 1 — the walk's exit IS the ladder's
// original 0→1 step: whatever the verdict says, the user's page heals to
// the proven minimal configuration at the full capacity.
function completeLeg(leg, verdict, detail) {
  if (typeof window === 'undefined') return
  const res = window.__embersForensicResult ?? (window.__embersForensicResult = { a: 'pending', b: 'pending', verdict: 'incomplete' })
  // Task 151 — a leg verdicts ONCE: the mid-run watchdog can re-fire on
  // an instance that is still alive during the re-boot settle (its own
  // birth verdict already completed the leg) — a second completion must
  // not rewind the walk's state machine
  if (res[leg] !== 'pending') return
  res[leg] = verdict
  if (leg === 'a') {
    window[FORENSIC_FLAG] = 'b'
    window.__vfxRemakeRequested = true
    console.warn(`[rune/vfx] GPU Embers FORENSIC leg A (the GPU emission alone, fresh context): ${verdict === 'dropped' ? `DROPPED — ${detail}` : `CLEAN — ${detail}`}. Stepping to leg B (the cull/sort family alone) on the next fresh context.`)
    return
  }
  const a = res.a === 'dropped' ? 'dropped' : 'clean'
  const b = verdict
  res.verdict = a === 'dropped' && b === 'dropped' ? 'both' : a === 'dropped' ? 'emit' : b === 'dropped' ? 'cull' : 'interaction'
  const bLine = `leg B (the cull/sort family alone, fresh context): ${b === 'dropped' ? `DROPPED — ${detail}` : `CLEAN — ${detail}`}`
  const verdictText = res.verdict === 'both'
    ? 'BOTH families drop independently on this driver — the GPU-emission pass AND the cull/sort family each break the transform feedback on their own'
    : res.verdict === 'emit'
      ? 'THE GPU-EMISSION FAMILY is the dropper — the emission TF pass (the emitOut append + its PBO slice round-trips into the state texture) breaks the transform feedback; the cull/sort family is clean'
      : res.verdict === 'cull'
        ? 'THE CULL/SORT FAMILY is the dropper — the sortKeys TF pass (the pairsOut buffer + its PBO round-trip into the pairs texture) with the sorted pack breaks the records; the GPU emission is clean'
        : 'NEITHER family drops alone on a fresh context — the failure needs the full combination (the interaction of both families together, or a residue only the complete pipeline leaves on the context)'
  window[FORENSIC_FLAG] = undefined
  // THE HEAL: rung 1 — the conservative TF tier, the exact v150 step
  window[FALLBACK_FLAG] = 1
  window.__vfxRemakeRequested = true
  console.warn(`[rune/vfx] GPU Embers FORENSIC VERDICT: ${verdictText}. (${bLine}.) Healing into the conservative TF tier now — the proven minimal configuration at the full capacity. Paste this log back for the follow-up fix.`)
}

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
// Task 152 — THE WALK IS OPT-IN NOW (?forensic=1): the 13:27 session
// settled the open question — the walk's fresh in-page contexts are born
// dead after ANY prior GL context disposal (both legs "drop", the verdict
// 'both', contaminated by the session's context history), so the default
// auto-walk could only ever echo that history back. The DEFAULT level-0
// heal crosses a page RELOAD instead (the one provably-clean cell — see
// triggerFallback); the walk machinery stays for the manual mode and the
// preset gates.
const WANT_FORENSIC = flagOn('forensic')
// Task 138 — THE REAL-GPU TF PIPELINE: a real GPU takes the full GPU
// pipeline by DEFAULT now — emit:'gpu' + the frustum cull (the hardware
// oracle: the user's live confirmation on a real GPU; the dedicated
// emitOut buffer keeps the one-producer/one-consumer barrier discipline,
// and the pairs/emit PBO round-trips are hardware paths off the software
// GL). The software-GL class keeps the proven CPU defaults (Task 135's
// queue-serialization constraint) — the flags above override both.
// Task 150 — an isolation leg PINS its family: leg A runs the GPU
// emission alone (emit on, cull off), leg B the cull/sort family alone
// (emit cpu, cull on) — each isolating one of the two deltas between
// the full pipeline and the proven minimal configuration.
const TF_GPU_PIPELINE = !SOFTWARE_GL
// Task 140 — the one-time conservative re-make: after a self-check verdict
// the flag sticks until the page reloads (the fallback session stays
// conservative — no flapping between modes mid-run). READ AT MAKE TIME —
// the flag lands DURING a live session (the re-make must see it; a
// module-scope constant would freeze the import-time value).
// Task 149 — the flag is the LADDER POSITION (0 = fresh, 1 = the
// conservative TF tier, 2 = the CPU tier); the make reads it, the
// self-check escalates it one rung at a time, a reload clears it.
const fallbackLevel = () => {
  if (typeof window === 'undefined') return 0
  const v = window[FALLBACK_FLAG]
  return v === 1 ? 1 : v === 2 ? 2 : 0
}

/* Task 152 — THE RELOAD CROSSING: the level-0 heal's page boundary. The
 * marker lands in sessionStorage (main.js consumes it at module scope:
 * the fresh page boots straight into WebGL2 at the carried rung + demo);
 * the reload itself goes through a small indirection so the gates can
 * intercept it. Storage unavailable → the v150 in-page rung step takes
 * over. */
const HEAL_KEY = 'rune:vfx:glheal'
const healReload = () => {
  if (typeof window !== 'undefined' && typeof window.__vfxHealReload === 'function') window.__vfxHealReload()
  else if (typeof location !== 'undefined' && typeof location.reload === 'function') location.reload()
}

export default {
  title: 'GPU Embers',
  sub: 'the GPGPU tier · 160k compute-simmed, GPU-EMITTED embers · the full GPU pipeline on BOTH backends by default (WebGL2: the transform-feedback tier — 160k + GPU emission + the frustum cull on real GPUs; SwiftShader/llvmpipe keep the conservative CPU defaults) · zero per-frame particle uploads · the session NEVER disposes its WebGL2 context (backend toggles park and resurrect it) · a driver drop self-heals ACROSS A PAGE RELOAD into the conservative TF tier on the fresh page\'s first context, then the CPU tier as the floor · ?forensic=1 runs the pass-family isolation walk · the mid-run watchdog keeps watching',
  camera: { yaw: 0.6, pitch: 0.34, dist: 13, orbit: 0.05, target: [0, 4.5, 0] },

  make(env) {
    // THE TIER: WebGPU → the compute tier (160k); WebGL2 → the
    // TRANSFORM-FEEDBACK tier (Task 137: hardware-aware — 160k on a real
    // GPU, 16k on the software-GL class). Both GPU legs are sim:'gpu' —
    // the facade contract is backend-neutral; the Task-149 ladder steps
    // the TF leg down one rung per verdict (level 1: the conservative
    // tier; level 2: the facade's own sim:'cpu' tier).
    const compute = env.backend === 'webgpu'
    const counters = (typeof window !== 'undefined' && window.__vfxCounters) || {}
    // Task 149 — THE LADDER POSITION: 0 = the full pipeline (Task 138's
    // real-GPU default — the GPU emission + the cull), 1 = the
    // conservative TF tier (Task 137's proven configuration — emit:'cpu',
    // cull off, the sim and the records pack STILL on the GPU at the FULL
    // capacity: the live ?emit=0&cull=0 proof rendered exactly this at
    // 160k), 2 = the facade's own CPU tier (Task 148's terminal safe
    // harbor — sim:'cpu', per-frame uploads, the healed budget). The
    // compute leg and the force flags ignore the position entirely (the
    // verdict binds the TF leg only; a forced re-make re-takes the FULL
    // pipeline, and the ladder is off while a flag is set — no loop).
    const forceGpu = FORCE_EMIT || FORCE_CULL
    const lvl = (compute || forceGpu) ? 0 : fallbackLevel()
    // Task 150 — THE ISOLATION LEG: while the walk is live the make PINS
    // the leg's configuration regardless of the ladder position (a leg IS
    // a level-0-family config on a fresh context — the full pipeline minus
    // one suspect family; the position stays 0 and the capacity stays the
    // full TF budget). The compute leg and the force flags ignore the walk
    // entirely (it cannot start under either — the verdict binds the TF
    // leg, and manual mode wins).
    const leg = (compute || forceGpu) ? null : forensicLeg()
    const gpuTier = compute || lvl < 2
    // Task 138 — the pipeline policy (explicit HERE, where the compute leg
    // is known): the compute leg always took the GPU pipeline; the TF leg
    // takes it by default on a real GPU (the hardware oracle) and keeps the
    // conservative CPU path on the software-GL class; the value-aware
    // flags override both branches in both directions. Task 149 — only the
    // LEVEL-0 TF leg runs the full pipeline; the level-1 rung is the
    // conservative tier by construction.
    const emitGpu = leg === 'a' ? true : leg === 'b' ? false : (!FORCE_EMIT_OFF && (compute || (TF_GPU_PIPELINE && lvl === 0) || FORCE_EMIT))
    const cullOn = leg === 'a' ? false : leg === 'b' ? true : (!FORCE_CULL_OFF && (compute || (TF_GPU_PIPELINE && lvl === 0) || FORCE_CULL))
    const capacity = compute ? GPU_CAPACITY : (lvl === 2 ? FALLBACK_CAPACITY : TF_CAPACITY)
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
    // transform-feedback tier, dispatched by the facade's shape. The
    // ladder's LEVEL-1 rung runs it too (the conservative tier is still
    // the TF tier — fresh buffers, fresh passes, a fresh live verdict);
    // the level-2 (CPU) session skips it entirely: a CPU-tier facade
    // needs no GPU backend (the harness's own per-frame upload path
    // draws it).
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
    // Task 149 — `fallback`: 'tf' when the ladder stepped down to the
    // conservative TF tier (level 1 — the re-booted, re-verdicted rung),
    // 'cpu' when it reached the facade's own CPU tier (level 2, Task
    // 148's full-CPU safe harbor).
    const perf = { tier: gpuTier ? 'gpu' : 'cpu', capacity, count: 0, ms: 0, emit: gpuTier && emitGpu ? 'gpu' : 'cpu', cull: cullOn, sort: WANT_SORT, softwareGL: SOFTWARE_GL, pixelCheck: (compute || !gpuTier) ? 'off' : undefined, ...(leg !== null ? { forensic: leg } : {}), ...(lvl > 0 ? { fallback: lvl === 1 ? 'tf' : 'cpu' } : {}) }
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
    // Task 151 — ONE VERDICT PER INSTANCE (the mid-run watchdog can fire
    // while the re-boot settle still runs this instance — a second
    // trigger would double-escalate the ladder or rewind the walk), and
    // the watchdog's own state: arms at frame ~60 (just past the one-shot
    // window), re-arms every ~300 frames, cold canvas + counting ledger
    // TWICE in a row → the pixel-confirmed ladder
    let verdictFired = false
    let watchdogArmed = false
    let watchdogNext = 60
    let watchdogColdRun = 0
    // Task 149 — the TOO-SMALL re-arm budget: a death-wave dip colliding
    // with the one-shot pixel sample (pixelsWarm === 0 at live ≤ 1000) is
    // INCONCLUSIVE, not a verdict — it must neither clear a latched
    // suspicion nor report a false 'cold'. Three re-arms, then the
    // degenerate-records verdict stands alone (a sane tier simply
    // passes).
    let smallRetries = 0
    function armPixelCheck() {
      if (pixelsArmed || compute) return
      pixelsArmed = true
      armFrame = frameCount
      // Task 151 — a concluded one-shot verdict ('warm'/'cold') must not
      // be clobbered when the mid-run watchdog re-arms the sample (the
      // gates poll the field; the watchdog writes perf.watchdog instead)
      if (perf.pixelCheck !== 'warm' && perf.pixelCheck !== 'cold') perf.pixelCheck = 'armed'
      // Task 153 — THIS instance's OWN canvas, never a document query: while
      // a GL context is parked (a WebGPU interlude — the Task-152 keep-alive
      // keeps the hidden canvas in the slot, first in tree order), a
      // document.querySelector('canvas') grab can hit the parked element and
      // sample its stale drawingBuffer instead of the live render target.
      // env.canvas is threaded at boot (both the fresh and the resurrect
      // paths) and is captured HERE, at arm time — even if a re-boot swaps
      // canvases later, this instance's one-shot wrapper stays bound to the
      // canvas it was drawing on (the re-boot settle keeps the old instance
      // alive for ~2 s).
      const canvasEl = env.canvas ?? null
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
      if (compute || forceGpu) return
      // Task 151 — ONE VERDICT PER INSTANCE: the mid-run watchdog can
      // fire while a re-boot settle (main.js gives the walk's re-boots a
      // 2 s settle — the old instance keeps rendering through it) is
      // still running an instance that already verdicted
      if (verdictFired) return
      verdictFired = true
      // Task 150 — THE LEG'S OWN DROP: this instance IS an isolation leg and
      // its configuration just verdicted broken on a fresh context — the
      // verdict IS the diagnostic answer for that family; the walk advances
      // (leg A → leg B; leg B → the FORENSIC VERDICT + the heal into rung
      // 1). The ladder position itself is NOT touched here — the walk's
      // exit does the 0→1 step.
      if (leg !== null) {
        completeLeg(leg, 'dropped', reason)
        return
      }
      const from = fallbackLevel()
      // Task 150 — THE ISOLATION WALK's entry: the level-0 verdict fired
      // from the FULL pipeline (emit gpu + cull on — the flags-narrowed or
      // software-GL level-0 configurations go straight to the rungs: there
      // is nothing left to bisect). Before the heal, run the two-leg
      // bisect — ON THIS DEVICE, automatically, once per session: leg A
      // isolates the GPU-emission family, leg B the cull/sort family, each
      // on a fresh context re-verdicted live by this same pixel-confirmed
      // check. The walk's exit heals into rung 1 (the v150 step — the user
      // keeps the 160k); the verdict tells the NEXT fix which family to
      // restructure or default off on this driver class.
      if (from === 0 && WANT_FORENSIC && !forensicDone() && emitGpu && cullOn) {
        window.__embersForensicDone = true
        window[FORENSIC_FLAG] = 'a'
        window.__vfxRemakeRequested = true
        perf.forensic = 'a'
        console.warn(`[rune/vfx] GPU Embers: ${reason} — the full pipeline's passes are what this driver drops. Before healing, running THE ISOLATION WALK (once per session, a few seconds of re-boots): leg A isolates the GPU-emission family, leg B the cull/sort family — each on a fresh context, re-verdicted live by this same check; the walk then heals into the conservative TF tier at the full capacity.`)
        return
      }
      // Task 152 — THE RELOAD CROSSING (the DEFAULT level-0 heal now): the
      // 13:27 session's verdict — an in-page FRESH context is born dead on
      // this driver class (the walk's legs proved it: every configuration,
      // both families, after one prior GL dispose), and the session's OWN
      // context — kept alive by the shell's park/resurrect keep-alive —
      // just verdicted. The one provably-clean cell left is the FIRST
      // WebGL2 context of a FRESH PAGE (the Task 149 fresh-load proof:
      // the conservative tier at the full 160k, records SANE, canvas WARM),
      // so the heal CROSSES the page boundary: the marker carries the rung
      // + this demo's index, the reload lands the fresh page straight on
      // the conservative tier. Storage unavailable → the v150 in-page
      // rung step below takes over (the old semantics, a fresh context).
      if (from === 0) {
        let crossed = false
        try {
          sessionStorage.setItem(HEAL_KEY, JSON.stringify({
            v: 1, rung: 1, demo: env.demoIndex ?? 0, at: Date.now(),
            why: String(reason).slice(0, 240),
          }))
          crossed = true
        } catch { crossed = false }
        if (crossed) {
          if (typeof window !== 'undefined') window.__vfxHeal = { rung: 1, demo: env.demoIndex ?? 0 }
          perf.heal = 'reload'
          console.warn(`[rune/vfx] GPU Embers: ${reason} — the session's WebGL2 context (never disposed — the shell's Task 152 keep-alive parks and resurrects it across backend toggles) still drops its transform feedback. Healing ACROSS A PAGE RELOAD: the FIRST WebGL2 context of a fresh page is the one cell this driver class has rendered the conservative TF tier at the full 160k in, live-verified — the reload re-enters THIS demo at that tier automatically (emit:'cpu', cull off, the simulation and the records pack still on the GPU at the full capacity). If the fresh page drops too, its own ladder lands the CPU tier — the one configuration every driver renders. The reload fires NOW (about a second of blank); the fresh page's log opens with the "GL heal" event line. Paste that log back if anything still looks wrong.`)
          healReload()
          return
        }
      }
      // Task 149 — ONE RUNG PER VERDICT: level 0 steps down to the
      // CONSERVATIVE TF tier (the minimal configuration this hardware
      // class demonstrably renders — the live ?emit=0&cull=0 proof: 160k,
      // records SANE, canvas WARM), level 1 steps down to the facade's
      // own CPU tier (Task 148's terminal safe harbor). Each rung fires
      // at most once per session (the fresh make reads the position;
      // checkStage pins the dying instance) — no flapping, no loop. The
      // re-make channel gives the level-1 rung a FRESH GL context (the
      // renderer re-boot — a context the full pipeline never ran on, the
      // exact cell the live proof validated).
      const to = from >= 2 ? 2 : from + 1
      window[FALLBACK_FLAG] = to
      window.__vfxRemakeRequested = true
      perf.fallback = to === 1 ? 'tf' : 'cpu'
      if (to === 1) {
        // Task 152 — this branch is the STORAGE-LESS level-0 fallback now
        // (the default path crossed the reload above): the same v150 step
        // with one honest caveat — a fresh in-page context is born dead on
        // the reporting driver class, so this rung's re-verdict is expected
        // to escalate; it fires only where sessionStorage is unavailable.
        console.warn(`[rune/vfx] GPU Embers: ${reason} — the FULL pipeline's passes (the GPU emission + the frustum cull) are what this driver is dropping; the transform feedback itself may still be sound (the minimal tier — emit:'cpu', cull off — is the configuration this hardware class ran at the full 160k, live-verified). Stepping down ONCE to the conservative TF tier (emit:'cpu', cull off, the sim and the records pack still on the GPU at the full capacity) on a FRESH context, re-verdicted by the same pixel-confirmed ladder: if its own records read back degenerate AND its canvas reads cold, the page drops to the facade's CPU tier. Reload to retry the full pipeline, or force it with ?emit=1&cull=1.`)
      } else {
        // Task 151 — THE CONTAMINATED-VERDICT CORRECTION: rung 1 is the
        // PROVEN-CLEAN configuration (the live fresh-load experiment
        // rendered it at the full 160k) — if IT drops too, the session's
        // contexts are dropping regardless of configuration, and the
        // walk's legs ran inside that poisoned state. The 12:36 live log:
        // leg A dropped, leg B dropped, the verdict said "both families"
        // — and then rung 1, which no family touches, dropped exactly
        // the same way; the correlate is the session's context-creation
        // history (four re-boots in 3.4 s preceded the first drop), not
        // the pass family. Declare the verdict inconclusive — in the log
        // AND machine-readably (forensicResult.contaminated).
        const fr = typeof window !== 'undefined' ? window.__embersForensicResult : null
        if (fr != null && fr.verdict !== 'incomplete') {
          fr.contaminated = true
          console.warn(`[rune/vfx] GPU Embers FORENSIC CORRECTION: the conservative TF tier — the minimal configuration a FRESH page load rendered clean at the full capacity — is dropping too. The walk's legs ran on contexts born into an already-poisoned session (this driver class degrades every subsequently created context after a run of rapid re-boots), so the "${fr.verdict}" verdict above is INCONCLUSIVE: the drop follows the session's CONTEXT HISTORY, not the pass family. A page reload is the clean retest — the first WebGL2 context of a fresh session has rendered the full pipeline clean, live-verified.`)
        }
        console.warn(`[rune/vfx] GPU Embers: ${reason} — the conservative TF tier itself is dropping its writes on this driver. Falling back ONCE to the facade's own CPU tier (sim:'cpu' — the simulation, the emission and the records all on the CPU, per-frame uploads, no transform feedback: the one configuration every driver renders). Reload to retry the GPU pipeline, or force it with ?emit=1&cull=1.`)
      }
    }

    return {
      frame(ctx) {
        // THE TIER SEQUENCE: advance (emission/death/compaction on the
        // CPU) → the GPU step (the compact replay, the force walk, the
        // record pack — Task 134: the sort/cull family with the CAMERA —
        // the frame context's basis forward + mvp) → the harness draws
        // from the external buffer. The level-2 (CPU) session has no GPU
        // step at all (the facade's own advance IS the simulation;
        // the harness's per-frame upload path draws the CPU records).
        embers.facade.advance(ctx.dt)
        gpuBackend?.step(ctx.dt, { forward: ctx.basis.forward, viewProj: ctx.mvp })
        // Task 149 — the self-check ladder (pixel-confirmed, TWO RUNGS):
        // stage 1 polls the tier's one-shot records verdict — degenerate
        // LATCHES the suspicion (the readback can lie; the canvas settles
        // it), sane walks the original frame-~45 draw-side check; stage 2
        // arms the in-frame pixel sample, then polls it — cold + counting
        // → step down one rung (a level-0 verdict re-boots into the
        // conservative TF tier on a fresh context; a level-1 verdict
        // re-makes into the CPU tier), warm → the suspicion clears. The
        // gate runs on EVERY GPU rung (the level-1 tier re-verdicts
        // itself live); the force flags disable it (the escape hatch
        // cannot loop); the CPU tier has no gpuBackend to check.
        frameCount++
        if (gpuBackend !== null && !compute && !forceGpu) {
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
              } else if (pixelsWarm > 0) {
                // WARM canvas — either against a degenerate records
                // readback (the draw is demonstrably alive: the READBACK
                // is the liar on this driver, the rung stays) or the
                // healthy draw-side check passing.
                const liar = suspectReason !== null
                if (liar) {
                  console.info(`[rune/vfx] GPU Embers: the records readback verdicted DEGENERATE but the canvas reads WARM (${pixelsWarm} bright pixels, ledger ${live}) — the readback itself is unreliable on this driver; staying on the GPU tier.`)
                  suspectReason = null
                }
                perf.pixelCheck = 'warm'
                checkStage = 2
                // Task 150 — the isolation leg's CLEAN completion (a leg
                // that renders on a fresh context exonerates its family):
                // leg A → leg B; leg B → the verdict + the heal.
                if (leg !== null) {
                  completeLeg(leg, 'clean', liar
                    ? `the records read back degenerate but the canvas reads WARM (${pixelsWarm} bright, ledger ${live}) — the readback lies, this configuration renders`
                    : `the records verdicted SANE and the canvas pixel sample read WARM at frame ${frameCount} (${pixelsWarm} bright pixels, ledger ${live})`)
                }
              } else {
                // pixelsWarm === 0 with a swarm TOO SMALL to verdict
                // (live ≤ 1000): INCONCLUSIVE — Task 149: a death-wave
                // dip colliding with the one-shot sample must not clear
                // a latched suspicion (nor report a false 'cold' on the
                // healthy leg). RE-ARM the sample — bounded: after three
                // too-small samples the degenerate-records verdict stands
                // alone (the conservative semantics of a confirmation
                // that never landed); a sane tier simply passes.
                smallRetries++
                if (smallRetries > 3) {
                  if (suspectReason !== null) {
                    triggerFallback(`${suspectReason} — and the canvas never held a swarm large enough to verdict (frame ${frameCount})`)
                    perf.pixelCheck = 'cold'
                  } else {
                    perf.pixelCheck = 'warm'
                    // Task 150 — the healthy-tier pass completes a clean leg
                    // too (no suspicion ever latched, the tier simply runs)
                    if (leg !== null) {
                      completeLeg(leg, 'clean', `no suspicion ever latched and the canvas never held a swarm large enough to sample by frame ${frameCount} — this configuration passes`)
                    }
                  }
                  checkStage = 2
                } else {
                  pixelsArmed = false
                  pixelsWarm = -1
                }
              }
            } else if (suspectReason !== null && armFrame >= 0 && frameCount - armFrame > 90) {
              // the pixel confirmation never landed (readPixels refused,
              // no qualifying draw) — the records verdict stands alone
              triggerFallback(`${suspectReason} — and the pixel confirmation never landed (frame ${frameCount})`)
              perf.pixelCheck = 'cold'
              checkStage = 2
            }
          }
          // Task 151 — THE MID-RUN WATCHDOG: the one-shot window (frames
          // 30-45) verdicts the tier's BIRTH; this re-arms the pixel
          // sample periodically for the tier's LIFE. The live 12:36
          // session: the full pipeline ran clean and visibly for 10+
          // seconds past its check, then the swarm died MID-RUN with the
          // machine silent (the user watched it go sparse; the log said
          // nothing). A cold canvas with a counting ledger TWICE in a
          // row → the same pixel-confirmed ladder (a mid-run death on an
          // isolation leg verdicts that leg's family dropped); warm
          // resets the streak silently — no console noise on a healthy
          // page; a sample that never lands just re-arms.
          if (checkStage === 2) {
            if (!watchdogArmed && frameCount >= watchdogNext) {
              watchdogArmed = true
              pixelsArmed = false
              pixelsWarm = -1
              armPixelCheck()
            } else if (watchdogArmed && pixelsWarm >= 0) {
              watchdogArmed = false
              watchdogNext = frameCount + 300
              const live = embers.facade.count
              if (pixelsWarm === 0 && live > 1000) {
                watchdogColdRun++
                if (watchdogColdRun >= 2) {
                  perf.watchdog = 'cold'
                  triggerFallback(`the swarm died MID-RUN at frame ${frameCount}: the periodic canvas sample read cold (ZERO bright pixels) while the ledger counted ${live} live particles — the tier ran clean past its one-shot check and died in flight`)
                } else {
                  // one cold reading is not a verdict — confirm it quickly
                  watchdogNext = frameCount + 30
                }
              } else {
                if (watchdogColdRun > 0) watchdogColdRun = 0
                if (pixelsWarm > 0) perf.watchdog = 'warm'
              }
            } else if (watchdogArmed && armFrame >= 0 && frameCount - armFrame > 90) {
              // the periodic sample never landed (no qualifying draw) —
              // inconclusive, not cold: re-arm, no verdict
              watchdogArmed = false
              watchdogNext = frameCount + 300
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
