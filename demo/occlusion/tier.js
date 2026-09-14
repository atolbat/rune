// occlusion/tier.js — THE ONE TIER. Both backends, ONE code path, and since
// Task 203: THE FRAME AS A DECLARED GRAPH.
//
// History: Task 198's common bricks (createDevice) collapsed the two
// backend tiers; Task 199 made the frame one hizFrame() call; Task 200
// wrapped the scenario into hizScene(); Task 201 answered the «именно
// КИРПИЧИ» ask — one handle per pass, the scenario owns the recipe; Task
// 202 added the research bricks (history feedback, amortized cull). THE
// NEXT QUESTION was inevitable:
//
//   «Подумай о супер рендеринге… рендер-пассы описываются декларативно:
//    каждый пас объявляет читаемые/записываемые ресурсы через
//    версионированные хэндлы. Движок строит DAG кадра и сам управляет
//    временем жизни transient-ресурсов → aliasing памяти. Автоматическая
//    вставка барьеров, автоматическое перекрытие async compute и графики,
//    отсечение целых веток пассов (отключили тени → зависимые пассы
//    исчезли из графа).»
//
// Task 203 — THE ANSWER, built as a pure @rune/core brick
// (packages/core/src/framegraph.ts — the Frostbite/UE-RDG/Unity-SRP law,
// DOM-free, backend-free) and wired HERE: the recipe is no longer a CALL
// SEQUENCE, it is a DECLARATION the engine compiles:
//
//   ── THE RESOURCES (versioned handles; the bricks' own objects) ──────
//   scene   — persistent buffer, EXPORTED (the verdicts are the world's
//             channel: readStats/readVerdicts — the graph reports their
//             staleness but never force-roots the writers; temporal reuse
//             stays the frame's own policy)
//   mesh    — persistent (the boot upload; imported content)
//   hi-z    — TRANSIENT texture 480×270 r32f: the pyramid tile + the
//             reduced levels; two versions per frame (the fill writes v1,
//             the reduce reads it and writes v2) — the planner's currency
//   target  — persistent (the presented surface / the canvas)
//
//   ── THE PASSES (declarative; the executes call the Task-201 bricks) ─
//   z-fill          render   reads [scene, mesh]        writes [hi-z]
//   pyramid-reduce  compute* reads [hi-z]               writes [hi-z]
//   cull-verdicts   compute* reads [scene, +hi-z?]      writes [scene]
//                   (the CONDITIONAL READ is the shadows-off law: with
//                   culling off the kernel stops reading the pyramid →
//                   the whole prepass branch leaves the frame)
//   hysteresis      compute* reads [scene]              writes [scene]
//   color           render   reads [scene, mesh]        writes [target]
//   pyramid-view    render   reads [hi-z, target]       writes [target]
//                   (THE OVERLAY LAW: the strip draws ON TOP of the color
//                   image — read-modify-write; a pure write would bind the
//                   present to the strip's version and CULL the color pass
//                   as a reader-less branch)
//   read-stats      copy     reads [scene]              (an export root)
//   present         present  reads [target]
//   (*) the WG leg's mechanisms are compute; the GL leg's are render-pass
//       shapes (TF/FBO quads) — the KIND feeds the barrier/overlap model,
//       the honest per-backend row of the frame's own table.
//
// WHAT THE COMPILER DOES with this (per policy state, cached):
//   · versions resolve by DECLARATION ORDER — the z-fill reads scene@prev
//     (the two-pass HZB's phase 1 is a version behind the cull's write:
//     the previous frame's visible set, LEGALLY — the pinned-handle law);
//   · the DAG + roots → BRANCH CULLING: Hi-Z off + strip off = z-fill and
//     pyramid-reduce vanish from the frame (the shadows-off law, gated on
//     the page and proven by the validation's frame-graph leg);
//   · amortized frames GATE cull+hysteresis (`when: fresh`) — the color
//     pass then reads scene@v(n−k): TEMPORAL REUSE, a first-class graph
//     concept, with the STALENESS counted (the HUD's «verdicts 2f stale»);
//   · the transient lifetimes schedule into ALIASING SLOTS (the console's
//     memory math — the honest note: the web hands us no VRAM to alias,
//     the planner's accounting is the plan a backend with memory control
//     would execute, and the pooled-scratch discipline is the hook);
//   · BARRIERS are emitted at every write crossing between lanes
//     (G/C/T) — the exact submission a D3D12 port would make; the web
//     backends satisfy them at pass boundaries implicitly (the WG frame
//     carries the barrier set, the GL frame — all one lane — needs none);
//   · the 3-LANE OVERLAP PLAN finds the legal parallelism (the stats
//     readback — the copy lane — overlaps the color render; that one is
//     REAL on the web: the async map/readback genuinely runs beside the
//     next passes' GPU work);
//   · THE COMPILE CACHE keys on the policy props the declarations actually
//     read (a recording proxy — the camera rides the RUN props, never the
//     declaration): the same gates bit-still → the SAME compiled frame.
//
// THE FRAME CONTRACT (unchanged, byte-for-byte): the executes call the
// same bricks with the same props in the same order — the compiled
// timeline IS the Task-202 recipe; the parity gates prove the graph
// changed the SCHEDULING, never a pixel.
import { createDevice, createFrameGraph } from '../../dist/rune.esm.js?v=205'
import { buildShaders } from './shaders.js?v=203'
import { BOX_VERTS, BOX_INDICES, HIZ_W, HIZ_H } from './scene.js?v=203'
const SKY = [0.045, 0.055, 0.09, 1]
const LIGHT = [0.5, 0.8, 0.35]
const SURF_W = 480, SURF_H = 270
const HYST_FRAMES = 3 // the Frostbite K: consecutive occluded frames before the cull lands

/** Builds the Hi-Z tier on EITHER backend — the same bricks, the same
 *  declared graph, the same stats. Throws the honest refusal when the
 *  backend cannot carry it (the caller falls back). */
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
  // first, then one handle per pass. Task 202 made the prepass brick the
  // HISTORY PASS (gate off = the K-wall fill; gate on = the two-pass HZB).
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

  // ═══ THE DECLARED FRAME (Task 203 — the recipe as DATA) ══════════════
  // The policy props the DECLARATIONS read: culling / pyramidView / fresh /
  // wantStats (the compile cache keys on exactly these — the camera, the
  // occluder count, the history/hysteresis gates ride the RUN props: they
  // change the executes' behavior, never the frame's SHAPE).
  const WG = device.backend === 'webgpu'
  const KERNEL = WG ? 'compute' : 'render' // the cull/hyst/reduce mechanisms' lanes
  const fg = createFrameGraph()

  const R = {
    scene: fg.resource({ name: 'scene', kind: 'buffer', bytes: sceneWords.length * 4, transient: false, external: sceneHandle, exported: true }),
    mesh: fg.resource({ name: 'mesh', kind: 'buffer', bytes: BOX_VERTS.length * 4, transient: false, external: mesh }),
    hiz: fg.resource({ name: 'hi-z', kind: 'texture', width: HIZ_W, height: HIZ_H, format: 'r32f', external: pyramid }),
    target: fg.resource({ name: 'target', kind: 'texture', width: SURF_W, height: SURF_H, transient: false, external: surface }),
  }

  let pendingStats = null // the read-stats copy pass's in-flight readback
  fg.pass({
    // the prepass: gate OFF = the K-wall fill (byte-identical to the
    // Task-201 depthPass frame); gate ON = the two-pass HZB — the
    // prev-visible set + the fill. DECLARATION-ORDER VERSION LAW: this is
    // the FIRST scene reader, so it binds the version BEFORE this frame's
    // cull write — the previous frame's verdicts, exactly what phase 1
    // consumes (no reprojection, the set re-renders at the current camera).
    name: 'z-fill', kind: 'render', cost: 3,
    reads: [R.scene, R.mesh], writes: [R.hiz],
    execute: ({ props }) => hist.run({ camera: props.camera, occluders: props.occluders, gate: props.history === true }),
  })
  fg.pass({
    name: 'pyramid-reduce', kind: KERNEL, cost: 2,
    reads: [R.hiz], writes: [R.hiz], // read-modify-write: level L reads L−1
    execute: () => pyramid.build(),
  })
  fg.pass({
    // THE VERDICT KERNEL — the conditional read is the shadows-off law:
    // culling off → no pyramid read → the prepass branch dies with it
    // (the kernel still runs: the OFF legs need fresh frustum verdicts).
    // `fresh` is THE AMORTIZED-CULL gate: a bit-still camera+policy frame
    // skips BOTH this pass and the fold — the streaks must not advance on
    // stale raw verdicts.
    name: 'cull-verdicts', kind: KERNEL, cost: 1,
    reads: props => [R.scene, ...(props.culling === true ? [R.hiz] : [])],
    writes: [R.scene],
    when: props => props.fresh === true,
    execute: ({ props }) => occl.run({ camera: props.camera, gate: props.culling === true }),
  })
  fg.pass({
    name: 'hysteresis', kind: KERNEL, cost: 1,
    reads: [R.scene], writes: [R.scene],
    when: props => props.fresh === true,
    execute: ({ props }) => smooth.run({ gate: props.hysteresis === true }),
  })
  fg.pass({
    name: 'color', kind: 'render', cost: 6,
    reads: [R.scene, R.mesh], writes: [R.target],
    execute: ({ props }) => color.run({ target: props.target, camera: props.camera, light: LIGHT }),
  })
  fg.pass({
    // the debug strip — the OVERLAY LAW: reads the target it draws on top
    // of (a pure write would cull the color pass as a reader-less branch)
    name: 'pyramid-view', kind: 'render', cost: 1,
    reads: [R.hiz, R.target], writes: [R.target],
    when: props => props.pyramidView === true,
    execute: ({ props }) => strip.run({ target: props.target }),
  })
  fg.pass({
    // THE STATS EXPORT (the copy lane): a write-less copy is a ROOT — when
    // the HUD wants numbers, the readback rides the frame's own graph (the
    // overlap plan puts it BESIDE the color render — the one web-real
    // parallelism: async readbacks genuinely overlap the GPU work)
    name: 'read-stats', kind: 'copy', cost: 1,
    reads: [R.scene],
    when: props => props.wantStats === true,
    execute: () => { pendingStats = device.readCullStats(sceneHandle) },
  })
  fg.pass({
    // the frame boundary: the WG encoder submit / the GL service boundary
    name: 'present', kind: 'present', cost: 1,
    reads: [R.target],
    execute: () => device.submit(),
  })

  // ── THE FRAME = compile(policy) + run(props) ───────────────────────────
  //    THE AMORTIZED-CULL CONTRACT (unchanged from Task 202, now a graph
  //    concept): a frame whose camera AND policy are bit-identical to the
  //    last culled frame reuses its verdicts — cull-verdicts + hysteresis
  //    are GATED out of the compiled frame, and every scene reader binds
  //    the LAST EXECUTED version (the staleness counts on the HUD). The
  //    cache keys on the mvp WORDS + the full policy tuple (hiz/occluders/
  //    hysteresis/history): a leg that flips any of them at the same
  //    camera is a NEW policy and re-culls honestly.
  let lastCulled = null // { key: string, mvp: Float32Array } — the last CULLED frame's cache key
  let cullSkips = 0
  let lastFrame = null // the last compiled frame (the graph stats' source)
  let lastReport = null // the last run report (executed + staleness)
  function renderTo(targetId, mvp, eye, hizOn, debug, occluders = K, hysteresisOn = false, historyOn = false, cacheOn = false, wantStats = false) {
    const camera = { mvp, eye }
    // NOTE the boolean hygiene (the Task-202 lesson): `historyOn !== 0`
    // with historyOn === false is TRUE — every gate answers `=== true` /
    // `props.x === true` from here on, both spellings (1/0 and booleans)
    // ride the same law.
    const key = `${hizOn ? 1 : 0}|${occluders}|${hysteresisOn ? 1 : 0}|${historyOn ? 1 : 0}`
    let cached = cacheOn && lastCulled !== null && lastCulled.key === key
    if (cached) {
      for (let i = 0; i < 16; i++) {
        if (lastCulled.mvp[i] !== mvp[i]) { cached = false; break }
      }
    }
    if (cached) cullSkips++ // the verdicts + the streaks + the draw all reuse
    else lastCulled = { key, mvp: Float32Array.from(mvp) }
    const props = {
      camera,
      occluders,
      target: targetId,
      culling: hizOn === true || hizOn === 1, // main.js passes 1/0, the probe legs booleans
      pyramidView: debug === true,
      hysteresis: hysteresisOn === true,
      history: historyOn === true,
      fresh: !cached,
      wantStats: wantStats === true,
    }
    lastFrame = fg.compile(props) // cached by policy — the declarations never see the camera
    lastReport = lastFrame.run(props)
  }

  // ── stats (the device normalizes: WG args readback / GL hist sweep).
  //    The graph's copy pass owns the LIVE loop's readback (the copy-lane
  //    root); the validation legs read DIRECTLY (their frames never arm
  //    the copy pass) — one channel, two honest arrivals.
  async function readStats() {
    if (pendingStats !== null) {
      const p = pendingStats
      pendingStats = null
      return p
    }
    return device.readCullStats(sceneHandle)
  }
  // ── the RAW per-record verdicts (the CPU-model gates' channel)
  function readVerdicts() {
    return device.readVerdicts(sceneHandle)
  }

  // ── the frame-graph channel (the HUD line + the validation's gate) ────
  function graphStats() {
    if (lastFrame === null) return null
    return {
      key: lastFrame.key,
      live: lastFrame.passes.map(p => p.name),
      gated: [...lastFrame.gated],
      culled: [...lastFrame.culled],
      barriers: lastFrame.barriers.map(b => `${b.after}→${b.before} ${b.resource} ${b.class} ${b.lanes}`),
      edges: lastFrame.edges.map(e => `${e.from ?? 'import'}→${e.to} ${e.resource}@${e.version}`),
      slots: lastFrame.slots.map(s => ({ external: s.external, peakBytes: s.peakBytes, intervals: s.intervals.map(i => `${i.resource}@${i.version}[${i.from}..${i.to}]`) })),
      overlap: {
        units: lastFrame.overlap.overlapUnits,
        parallel: lastFrame.overlap.parallel.map(p => p.pass),
        busy: { ...lastFrame.overlap.busy },
        criticalPath: lastFrame.overlap.criticalPath,
      },
      stats: { ...lastFrame.stats },
      stale: { ...(lastReport?.stale ?? {}) },
      executed: [...(lastReport?.executed ?? [])],
    }
  }
  function graphLine() {
    if (lastFrame === null) return ''
    const s = lastFrame.stats
    const g = lastFrame.gated.length > 0 ? ` · gated ${lastFrame.gated.join('+')}` : ''
    const c = lastFrame.culled.length > 0 ? ` · culled ${lastFrame.culled.join('+')}` : ''
    const par = lastFrame.overlap.parallel.map(p => `${p.pass}∥`).join(' ') || '—'
    const staleScene = lastReport?.stale?.scene ?? -1
    return `frame graph: ${s.live}/${s.declared} live${g}${c} · ${s.barriers} barriers · ${s.slots} slot${s.slots === 1 ? '' : 's'} · peak ${(s.peakBytes / 1024).toFixed(0)} KB (alias −${s.savedPct.toFixed(0)}%) · plan ∥ ${par} · verdicts ${staleScene < 0 ? 'imported' : `${staleScene}f stale`} · ${s.compiles} compile${s.compiles === 1 ? '' : 's'}`
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

  function frame(mvp, eye, hizOn, debug, occluders = K, hysteresisOn = false, historyOn = false, cacheOn = false, wantStats = false) {
    renderTo(SNAPSHOT ? surface.targetId : 0, mvp, eye, hizOn, debug, occluders, hysteresisOn, historyOn, cacheOn, wantStats)
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
  // ── Task 203 — the frame-graph diagnostics channel (the probe/gate
  //    scripts' window into the compiled frame: passes, slots, barriers,
  //    the overlap plan, the staleness)
  if (typeof window !== 'undefined') {
    window.__fgDebug = {
      note: 'the frame-graph channel — last() dumps the compiled frame (passes, slots, barriers, overlap, staleness)',
      last: () => graphStats(),
      compile: policy => fg.compile(policy), // declarations read only primitives — a policy subset compiles
    }
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
    graphStats,
    graphLine,
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
      if (typeof window !== 'undefined' && window.__fgDebug !== undefined) window.__fgDebug = undefined
    },
  }
}
