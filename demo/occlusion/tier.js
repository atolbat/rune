// occlusion/tier.js — THE ONE TIER. Both backends, ONE code path.
//
// Pre-198 the demo carried two tier files in two API dialects — wgTier.js
// (gpu.*) and glTier.js (gl.*), ~1200 lines of parallel mechanics. Task
// 198's common bricks (createDevice) collapsed them; Task 199 made the
// frame ONE hizFrame() call; Task 200 wrapped the whole scenario into one
// hizScene() construction. Task 201 answers the user's final shape —
// «именно КИРПИЧИ, из которых я мог бы создать данный куллинг. Не одной
// строкой, а комбинацией фич. Регл/вебгпу философия синтаксиса»:
//
//   ── THE RESOURCES (built once) ─────────────────────────────────────
//   const scene   = device.scene({ ... })              // the records + hist
//   const pyramid = device.pyramid(HIZ_W, HIZ_H)       // the Hi-Z tile
//   const mesh    = device.geometry(BOX_VERTS, BOX_INDICES)
//
//   ── THE PASS BRICKS (built once, run per frame — each one packs its
//      own uniform lanes, owns its own program states) ────────────────
//   const hist   = device.historyPass({ scene, mesh, pyramid, shaders: dict.hist, fill: dict.z })
//   const occl   = device.occlusionPass({ scene, pyramid, kernel: dict.cull })
//   const smooth = device.hysteresisPass({ scene, frames: 3 })   // Frostbite
//   const color  = device.visiblePass({ scene, mesh, shaders: dict.color, surface })
//   const strip  = device.debugStrip({ pyramid, shaders: dict.panel })
//
//   ── THE FRAME — the scenario's OWN recipe (the order is ours to keep,
//      change, or extend: a CPU software-occlusion brick would slot in the
//      same shape) ─────────────────────────────────────────────────────
//   hist.run({ camera, occluders, gate })  // 1. the prepass: gate OFF = the
//                                          //    K-wall fill (byte-identical
//                                          //    to depthPass); gate ON = the
//                                          //    two-pass HZB — the
//                                          //    prev-visible set + the fill
//   pyramid.build()                         // 2. the 2×2 MAX reduce
//   occl.run({ camera, gate })              // 3. frustum + Hi-Z verdicts
//   smooth.run({ gate })                    // 4. the temporal policy
//   color.run({ target, camera, light })    // 5. the visible set
//   if (debug) strip.run({ target })        // 6. the pyramid view (opt-in)
//
// THE FRAME CONTRACT (what the bricks run — the recipe stays legible in
// the calls themselves): the prepass renders the first `occluders` records
// into the pyramid's r32f level-0 tile; the reduce builds the max chain;
// the verdict kernel tests EVERY record (frustum → near-straddle → Hi-Z);
// the temporal pass folds the streaks (identity when the gate is off —
// byte-identical to the no-hysteresis frame); the visible draw runs the
// compacted set (WG: one drawIndexedIndirect; GL: one instanced draw +
// the vertex collapse).
//
// Task 202 — THE TWO RESEARCH BRICKS the frame grew (the web-searched
// techniques, found in the papers/blogs, then pushed further here):
//   · HISTORY FEEDBACK (hist.run, gate on) — the two-pass HZB's phase 1
//     (Nanite: «the first pass uses the HZB from last frame»; Aaltonen's
//     two-phase occlusion; CryEngine's coverage buffer). OUR TWIST beyond
//     the papers: NO REPROJECTION — the previous frame's visible set is
//     RE-RENDERED at the current camera (the set lags one frame, the
//     geometry is exact — no dilation heuristics, no disocclusion holes,
//     sound by construction: everything the brick draws exists this
//     frame at this camera). The city occludes ITSELF; the pyramid's
//     coverage becomes the full scene's, for one extra depth-only draw
//     of the survivors.
//   · AMORTIZED CULLING (the frame's own cache policy, cacheOn) — the
//     temporal-coherence practice (cull at half rate while the camera
//     stands still): a frame whose camera AND policy are bit-identical to
//     the last culled frame REUSES its verdicts — the cull kernel and the
//     temporal fold both stay idle (the streaks must not advance on stale
//     raw verdicts — both freeze together). The image cannot change: the
//     same verdicts feed the same draw.
//
// Task 200 — THE GL SUBMIT FIX rides the device: submit() runs the
// renderer's SERVICE boundary (canvas-state heal + error drain), never the
// renderer's own recorded tape — the empty BeginPass used to CLEAR THE
// CANVAS after every frame (the «WebGL2 renders empty» field report).
import { createDevice } from '../../dist/rune.esm.js?v=202'
import { buildShaders } from './shaders.js?v=202'
import { BOX_VERTS, BOX_INDICES, HIZ_W, HIZ_H } from './scene.js?v=202'
const SKY = [0.045, 0.055, 0.09, 1]
const LIGHT = [0.5, 0.8, 0.35]
const SURF_W = 480, SURF_H = 270
const HYST_FRAMES = 3 // the Frostbite K: consecutive occluded frames before the cull lands

/** Builds the Hi-Z tier on EITHER backend — the same bricks, the same
 *  frame, the same stats. Throws the honest refusal when the backend
 *  cannot carry it (the caller falls back). */
export async function buildTier(deps) {
  const { backend, scene, shell, noteError, stage, PROBE, FORCE_SNAPSHOT, attachControls, pauseLoop, resumeLoop } = deps
  const { K, N, INST_OFF, FLAGS_OFF, HIST_OFF, sceneWords, sceneF32 } = scene
  void pauseLoop; void resumeLoop // (the diagnostics channel's pause hooks — kept for the contract)

  // ── the device boot (one syntax; the GPU-process storm retries live in
  //    createDevice — 4 attempts, the Task-197 cadence) ────────────────────
  const bootCanvas = document.createElement('canvas')
  const device = await createDevice({
    backend,
    canvas: bootCanvas,
    clear: { color: SKY, depth: 1 },
    antialias: true,   // WG: the 4x-resolve canvas; GL: the context cascade
    dprCap: 2,         // mobile-first: supersample where it pays, cap the fill
    onError: noteError,
    onInfo: message => shell.log.info(message),
  })

  // the tier decision: a software WG adapter → snapshot mode (the documented
  // container class where a canvas present kills the software GPU process)
  const SNAPSHOT = backend === 'webgpu' && (FORCE_SNAPSHOT || device.software)
  const MODE = PROBE ? 'probe' : SNAPSHOT ? 'snapshot' : 'live'

  let displayCanvas = null
  let snapshot2d = null
  if (MODE !== 'probe') {
    if (SNAPSHOT) {
      // the honest degrade: every frame renders into the surface and blits
      // into a 2D canvas — the full pipeline, zero presents. The canvas is
      // 480×270 (the surface's own size) and CSS-stretched: a 1:1 blit, no
      // quarter-fill games.
      displayCanvas = document.createElement('canvas')
      displayCanvas.width = SURF_W
      displayCanvas.height = SURF_H
      snapshot2d = displayCanvas.getContext('2d')
    } else {
      // Task 197a — THE LIVE CANVAS IS THE DEVICE'S CANVAS: the frames
      // present into bootCanvas, so bootCanvas itself goes on the stage.
      displayCanvas = bootCanvas
    }
    displayCanvas.id = 'hiz-canvas'
    displayCanvas.className = SNAPSHOT ? 'hiz-canvas hiz-snapshot' : 'hiz-canvas'
    stage.appendChild(displayCanvas)
    attachControls(displayCanvas)
  }

  // ═══ THE BRICKS ══════════════════════════════════════════════════════
  // Task 201 — the scenario composes its culling from parts: the resources
  // first, then one handle per pass. The dictionary (buildShaders) stays
  // the scenario's own data — the per-language sources as columns; the
  // bricks build their programs and pack their lanes from it.
  // Task 202 — THE PREPASS BRICK IS THE HISTORY PASS: gate off = the K-wall
  // fill alone (byte-identical to the Task-201 depthPass frame); gate on =
  // the two-pass HZB (the prev-visible set drawn first, the fill merging
  // on top — the depth test keeps the nearest surface per texel).
  const sceneHandle = device.scene({
    total: N,
    occluders: K,
    words: sceneWords,
    recordsF32: sceneF32.subarray(INST_OFF),
    flagsWord: FLAGS_OFF,
    histWord: HIST_OFF, // Task 201 — the temporal policy's home
    recordsWord: INST_OFF,
    stride: scene.STRIDE,
    fields: scene.FIELDS,
  })
  const dict = buildShaders(scene)
  const pyramid = device.pyramid(HIZ_W, HIZ_H)
  const mesh = device.geometry(BOX_VERTS, BOX_INDICES)
  const surface = device.surface(SURF_W, SURF_H, { depth: true })

  const hist = device.historyPass({ scene: sceneHandle, mesh, pyramid, shaders: dict.hist, fill: dict.z })
  const occl = device.occlusionPass({ scene: sceneHandle, pyramid, kernel: dict.cull })
  const smooth = device.hysteresisPass({ scene: sceneHandle, frames: HYST_FRAMES })
  const color = device.visiblePass({ scene: sceneHandle, mesh, shaders: dict.color, surface })
  const strip = device.debugStrip({ pyramid, shaders: dict.panel })

  // ── THE FRAME — the recipe is THE COMPOSITION (see the file header):
  //    each brick runs with semantic props; the uniform lanes are the
  //    bricks' own business. `occluders` is THE POLICY knob (how many
  //    records write the z fill — the boot default K=23, the whole city
  //    N, anything between); `hizOn` gates the Hi-Z leg (the parity
  //    gates' OFF leg); `hysteresis` gates the temporal fold (the identity
  //    pass keeps every frame byte-identical when it is off); `historyOn`
  //    gates the two-pass HZB (the prev-visible occluder set); `cacheOn`
  //    arms the AMORTIZED-CULL policy (the verdicts reuse while the camera
  //    AND the policy stand bit-still).
  //
  //    THE AMORTIZED-CULL CONTRACT: a cached frame skips BOTH the verdict
  //    kernel and the temporal fold — the streaks must never advance on
  //    stale raw verdicts (a frozen fold + a frozen draw read the SAME
  //    frozen words — the image cannot change). The cache keys on the mvp
  //    WORDS + the full policy tuple (hiz/occluders/hysteresis/history):
  //    a leg that flips any of them at the same camera is a NEW policy and
  //    re-culls honestly.
  let lastCulled = null // { key: string, mvp: Float32Array } — the last CULLED frame's cache key
  let cullSkips = 0
  function renderTo(targetId, mvp, eye, hizOn, debug, occluders = K, hysteresisOn = false, historyOn = false, cacheOn = false) {
    const camera = { mvp, eye }
    // NOTE the boolean hygiene: `historyOn !== 0` with historyOn === false
    // is TRUE (strict compare, boolean vs number) — the feedback leaked
    // into every identity leg until this line learned `!!`. hizOn rides
    // the same law for the same reason (main.js passes 1/0, the probe
    // legs pass booleans — both spellings must answer the same gate).
    hist.run({ camera, occluders, gate: !!historyOn })
    pyramid.build()
    const key = `${hizOn ? 1 : 0}|${occluders}|${hysteresisOn ? 1 : 0}|${historyOn ? 1 : 0}`
    let cached = cacheOn && lastCulled !== null && lastCulled.key === key
    if (cached) {
      for (let i = 0; i < 16; i++) {
        if (lastCulled.mvp[i] !== mvp[i]) { cached = false; break }
      }
    }
    if (cached) {
      cullSkips++ // the verdicts + the streaks + the draw all reuse — the
      // frame's only work is the tile, the reduce, and the visible draw
    } else {
      lastCulled = { key, mvp: Float32Array.from(mvp) }
      occl.run({ camera, gate: !!hizOn })
      smooth.run({ gate: !!hysteresisOn })
    }
    color.run({ target: targetId, camera, light: LIGHT })
    if (debug === true) strip.run({ target: targetId })
    device.submit()
  }

  // ── stats (the device normalizes: WG args readback / GL hist sweep)
  function readStats() {
    return device.readCullStats(sceneHandle)
  }
  // ── the RAW per-record verdicts (the CPU-model gates' channel)
  function readVerdicts() {
    return device.readVerdicts(sceneHandle)
  }

  // ── the snapshot blit (software WG — zero presents) ─────────────────────
  let blitPending = false
  function blitSnapshot() {
    if (blitPending) return
    blitPending = true
    surface.read().then(result => {
      blitPending = false
      if (snapshot2d !== null && result.data.length === SURF_W * SURF_H * 4) {
        snapshot2d.putImageData(new ImageData(new Uint8ClampedArray(result.data.buffer, result.data.byteOffset, result.data.length), SURF_W, SURF_H), 0, 0)
      }
    }).catch(() => { blitPending = false })
  }

  function frame(mvp, eye, hizOn, debug, occluders = K, hysteresisOn = false, historyOn = false, cacheOn = false) {
    renderTo(SNAPSHOT ? surface.targetId : 0, mvp, eye, hizOn, debug, occluders, hysteresisOn, historyOn, cacheOn)
    if (SNAPSHOT) blitSnapshot()
  }

  /** The live camera aspect — the canvas's own CSS shape (portrait aware). */
  function aspect() {
    if (displayCanvas === null) return 16 / 9
    const w = displayCanvas.clientWidth
    const h = displayCanvas.clientHeight
    if (w <= 0 || h <= 0) return 16 / 9
    return w / h
  }

  // ── the WG diagnostics channel (the probe scripts' window into the
  //    pyramid; the texture-based pyramid reads per level) ─────────────────
  if (typeof window !== 'undefined' && device.gpu !== null) {
    const gpu = device.gpu
    window.__hizDebug = {
      note: 'the brick-composition tier — pyramidAt/ztile/stats/verdicts read the storage pyramid',
      async pyramidAt(level) {
        try {
          const off = (pyramid.offsets ?? [0])[level] ?? 0
          const f = await gpu.readExternalBuffer(pyramid.storageId ?? 0, off * 4 + 64)
          return Array.from(new Float32Array(f.buffer, off * 4, 16), v => +v.toFixed(4))
        } catch (e) {
          return `readback refused: ${e instanceof Error ? e.message : String(e)}`
        }
      },
      async ztile() {
        try {
          const px = new Uint8Array(await gpu.readTargetPixels(pyramid.zTarget))
          return Array.from(new Float32Array(px.buffer, 0, 16), v => +v.toFixed(4))
        } catch (e) {
          return `readback refused: ${e instanceof Error ? e.message : String(e)}`
        }
      },
      stats: () => readStats(),
      verdicts: () => readVerdicts(),
    }
  } else if (typeof window !== 'undefined') {
    window.__hizDebug = { note: 'the WebGL2 tier is active — the WG diagnostics channel is WebGPU-only; reload without ?mode=webgl2' }
  }

  return {
    mode: backend,
    kind: MODE,
    device,
    __scene: sceneHandle,
    tierLine: backend === 'webgl2'
      ? `WebGL2 — FBO pyramid + TF cull + vertex-collapse draw${device.antialias ? ' · context MSAA' : ''}`
      : `WebGPU — storage pyramid + compute cull + one drawIndexedIndirect${device.antialias ? ' · MSAA 4x resolve' : ''}`,
    drawsLine: backend === 'webgl2'
      ? `draws: 2 (fill + collapse color; +1 history set draw ON) · TF passes: 2 (cull + hysteresis) · ${pyramid.levels - 1} reduce quads`
      : `draws: 2 (fill + indirect color; +1 history set draw ON) · dispatches: 3 (cull + hysteresis + compact) · ${pyramid.levels - 1} reduce quads`,
    canvas: displayCanvas,
    surface,
    renderTo,
    frame,
    readStats,
    readVerdicts,
    aspect,
    /** Task 202 — the amortized-cull counter (the freeze leg's channel:
     *  how many frames reused the verdicts instead of re-culling). */
    cullSkips: () => cullSkips,
    // Task 200 — the submit fix lives in the device (the GL service
    // boundary: the canvas-state heal + the error drain, NO empty pass);
    // WG surfaces through the onGpuError channel — nothing to drain here.
    drain: null,
    dispose() {
      try { device.dispose() } catch { /* a lost device is already dead */ }
      if (displayCanvas !== null && displayCanvas.parentElement === stage) displayCanvas.remove()
      if (typeof window !== 'undefined' && window.__hizDebug !== undefined && window.__hizDebug !== null && 'pyramidAt' in window.__hizDebug) {
        window.__hizDebug = undefined
      }
    },
  }
}
