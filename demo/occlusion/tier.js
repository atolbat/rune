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
//
// Task 208 — THE CROSS-FRAME SEED (the bevy two-phase delta, research
// round 207's ranked candidate #1: bevy PR #17413's «phase 1 seeded by
// the previous frame's HZB», adapted to our no-reprojection law). The
// boot two-pass frame pays phase 1 in FULL every frame: the K-wall
// z-fill + the first reduce chain rebuild a WEAK pyramid (23 walls),
// cull#1 passes almost everything, and the feedback fill then renders
// that whole candidate crowd depth-only. The seed replaces the warm-up
// with a VERSIONED CARRY: the pyramid object already survives the frame
// boundary, so `pyramid-reduce-2` — the LATE downsample, after the
// phase-1 depth writers, bevy issue #18711's tracked position — doubles
// writer of a PERSISTENT `hiz-seed` resource, and the next frame's FIRST
// cull reads it as the imported version (the framegraph's own staleness
// channel counts the lag). Phase 1 goes from the 23-wall pyramid to the
// converged FULL-SCENE tile for zero extra passes — and the feedback
// fill collapses with it: the tile only depends on its FRONT LAYER (an
// occluded contributor's nearest corner is farther than the region max,
// so it wins no texel — tile(P(X)) ≡ tile(X), the fixed-point law the
// Task-207 brute-match already evidenced), so the seeded cull#1 passes
// exactly the final set (V1: 2767 → 428 at the report's camera, a 6.5×
// cut in depth-only raster) while the final verdicts land BIT-IDENTICAL
// to the fresh warm-up's (the same predicate over the same tile bytes).
// SOUNDNESS UNDER STALENESS (the load-bearing law, unchanged): a stale
// seed can only err in phase 1 — over-claiming wrongly culls a box there
// — but cull#2 re-tests EVERY record against the SAME-FRAME pyramid
// built from the drawn V1, and that pyramid never wrongly culls a
// visible box (its own rect holds either background 1.0 or surfaces
// behind it), so the final verdicts stay pixel-exact at any camera,
// however old the seed. The one-frame lag costs fill, never a pixel.
import { createDevice, createFrameGraph } from '../../dist/rune.esm.js?v=220'
import { buildShaders } from './shaders.js?v=210'
import { BOX_VERTS, BOX_INDICES } from './scene.js?v=203'
const SKY = [0.045, 0.055, 0.09, 1]
const LIGHT = [0.5, 0.8, 0.35]
// ── Task 219 — THE SURFACE LADDER (the render-resolution caps) ──────────
// The crowd renders into THE SURFACE at every mode/backend; the canvas is
// a presentation target (ONE blit pass per frame — the canonical present).
// The caps keep every leg honest: a software adapter (SwiftShader — the
// gates' container) gets the classic ~155k-texel budget whatever the
// viewport; a real GPU's LIVE leg renders native-class (≤ 1 MP); a real
// GPU's SNAPSHOT fallback (a present-death survivor) degrades to ≤ 553k —
// the phone's «норм»-class picture at half the present-independent cost.
const CAP_SOFTWARE = 155_520
const CAP_SNAPSHOT = 552_960
const CAP_LIVE = 1_048_576
// Task 218 — the hysteresis K is the CALLER's now (the occlusion demo
// keeps the Frostbite classic 3 — its frames stay bit-identical; the
// walker's field report «боксы мерцают то исчезая то появляясь» measured
// silhouette-edge occluded bursts up to ~23 frames — every K ≤ 15 blew
// through — the walker passes 24, the kernel's new 31 cap carries it)
const HYST_FRAMES_BASE = 3 // the Frostbite K: consecutive occluded frames before the cull lands

/** Builds the Hi-Z tier on EITHER backend — the same bricks, the same
 *  declared graph, the same stats. Throws the honest refusal when the
 *  backend cannot carry it (the caller falls back). */
export async function buildTier(deps) {
  const { backend, scene, shell, noteError, stage, PROBE, FORCE_SNAPSHOT, attachControls, pauseLoop, resumeLoop } = deps
  const { K, N, INST_OFF, FLAGS_OFF, HIST_OFF, sceneWords, sceneF32 } = scene
  void pauseLoop; void resumeLoop // (the diagnostics channel's pause hooks — kept for the contract)
  // ── Task 216 — THE WALKER EXTENSIONS (both optional, both defaulting to
  //    the occlusion demo's own shape — the classic tier's compiled frames
  //    stay BIT-IDENTICAL when neither is given):
  //    · surf {w, h} — the render surface's own dims (the walker is a GAME:
  //      a higher base resolution than the culling visualization's 480×270)
  //    · terrain {geometry, color, z} — the TERRAIN PASSES: a static
  //      @rune/prims soup (parallel positions/normals/uvs) drawn as ONE
  //      plain mesh (drawMesh — Task 216's device brick) twice per frame:
  //      depth-only into the pyramid tile (the hills OCCLUDE — the tile's
  //      base layer, the crowd's fill merges on top through the depth
  //      test) and lit into the target. The bricks the crowd rides
  //      (history/feedback) stop clearing the tile (noClear) — the
  //      terrain-z pass owns the clear; the crowd's color pass stops
  //      clearing the target — terrain-color owns it.
  const surfSpec = deps.surf ?? { w: 480, h: 270 }
  const terrainSpec = deps.terrain ?? null
  // Task 217 — THE SKY (the walker's field report: the occlusion demo's
  // near-black navy read as «всё чёрное» in a game viewport). The clear
  // color is the CALLER's now — the occlusion demo keeps its own SKY
  // (bit-identical classic frame), the walker passes the fog's own
  // daytime blue so the horizon blends seamless.
  const SKY_COLOR = deps.sky ?? SKY
  const HYST_FRAMES = deps.hystFrames ?? HYST_FRAMES_BASE

  // ── the device boot (one syntax; the GPU-process storm retries live in
  //    createDevice — 4 attempts, the Task-197 cadence) ────────────────────
  const bootCanvas = document.createElement('canvas')
  const device = await createDevice({
    backend,
    canvas: bootCanvas,
    clear: { color: SKY_COLOR, depth: 1 },
    // Task 219 — THE CANVAS MSAA RETIRES on the WG leg: the live canvas
    // gets exactly ONE 1x blit pass per frame now (the multi-pass
    // MSAA-resolve construct — load-after-discard + a double
    // getCurrentTexture — was the WG live-canvas field death; the facade's
    // canvas-pass law refuses it outright). GL keeps the context cascade
    // (its canvas presents were never the disease).
    antialias: backend === 'webgl2',
    dprCap: 2,         // mobile-first: supersample where it pays, cap the fill
    onError: noteError,
    onInfo: message => shell.log.info(message),
  })

  // the tier decision: a software WG adapter → snapshot mode (the documented
  // container class where a canvas present kills the software GPU process).
  // Task 218 — `forceLive` is the FIELD DEBUG hatch: a real-GPU device the
  // software probe mislabels (or a human forcing the path a phone report
  // walked) can demand the true canvas-present legs; the gates use it to
  // exercise the live pipeline where the container survives presents.
  const FORCE_LIVE = deps.forceLive === true
  const SNAPSHOT = backend === 'webgpu' && !FORCE_LIVE && (FORCE_SNAPSHOT || device.software)
  const MODE = PROBE ? 'probe' : SNAPSHOT ? 'snapshot' : 'live'

  // ── Task 219 — THE SURFACE RESOLUTION (the render target every mode
  //    renders into; the pyramid equals it — the occlusion-resolution
  //    law). `follow:'canvas'` sizes it to the STAGE's own shape × the
  //    boot dpr (the renderer's formula, dprCap 2) under the ladder's
  //    caps; a fixed spec {w, h} rides as given (the caller's own
  //    budget). The camera's ASPECT is the stage's CSS shape either way —
  //    the projection and the surface agree by construction at boot.
  let SURF_W, SURF_H
  if (surfSpec.follow === 'canvas' && MODE !== 'probe') {
    const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio ?? 1 : 1, 2)
    let w = Math.max(2, Math.round((stage.clientWidth || 480) * dpr))
    let h = Math.max(2, Math.round((stage.clientHeight || 270) * dpr))
    const cap = device.software ? CAP_SOFTWARE : SNAPSHOT ? CAP_SNAPSHOT : CAP_LIVE
    const area = w * h
    if (area > cap) {
      const s = Math.sqrt(cap / area)
      w = Math.max(2, Math.floor(w * s))
      h = Math.max(2, Math.floor(h * s))
    }
    SURF_W = w
    SURF_H = h
  } else {
    SURF_W = surfSpec.w
    SURF_H = surfSpec.h
  }

  let displayCanvas = null
  let snapshot2d = null
  if (MODE !== 'probe') {
    if (SNAPSHOT) {
      // the honest degrade: every frame renders into the surface and blits
      // into a 2D canvas — the full pipeline, zero presents. The canvas is
      // the surface's own size and CSS-stretched: a 1:1 blit, no
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
  // Task 219 — THE PYRAMID EQUALS THE SURFACE (the occlusion-resolution
  // law): every texel of occlusion proof maps to a render pixel, so a
  // visible sliver at render res is a full texel to the cull — the
  // sub-texel false-cull class (the field flicker «боксы мерцают то
  // исчезая то появляясь» — the pyramid was 480×270 against a 960×540+
  // render) cannot exist by construction.
  const dict = buildShaders(scene, { w: SURF_W, h: SURF_H })
  const pyramid = device.pyramid(SURF_W, SURF_H)
  const mesh = device.geometry(BOX_VERTS, BOX_INDICES)
  // ── Task 216 — THE TERRAIN BRICKS: one depth-only column into the
  //    pyramid's tile + one lit column into the target, both over the
  //    SAME parallel soup (the exact-mesh sampler's own bytes — the feet
  //    and the pixels read one source of truth)
  let terrainZ = null
  let terrainColor = null
  if (terrainSpec !== null) {
    const zBlock = new Float32Array(16)
    const colorBlock = new Float32Array(28) // mvp(16) + misc(4) + light(4) + eye(4)
    // THE TAPE CONTRACT (the pyramid's own build() pattern): a drawMesh
    // leaves the WG render pass OPEN (the facade's bindTarget memo); the
    // next brick's COMPUTE — the history pass's compact, the crowd's
    // compact in drawVisible, the pyramid's reduce — refuses to run under
    // an open render pass. Every terrain draw therefore ENDS its pass on
    // the WG leg (GL has no passes — gpu is null there, the natural guard)
    const endTilePass = () => { if (device.gpu !== null) device.gpu.endPass() }
    terrainZ = {
      run(call) {
        zBlock.set(call.camera.mvp, 0)
        device.drawMesh({ target: pyramid.zTarget, clear: call.clear !== false, program: terrainZProg, geometry: terrainSpec.geometry, uniforms: zBlock })
        endTilePass()
      },
    }
    terrainColor = {
      run(call) {
        colorBlock.set(call.camera.mvp, 0)
        colorBlock[16] = SURF_H
        colorBlock[17] = call.fogNear ?? 240
        colorBlock[18] = call.fogFar ?? 620
        colorBlock[19] = 0
        colorBlock[20] = LIGHT[0]; colorBlock[21] = LIGHT[1]; colorBlock[22] = LIGHT[2]; colorBlock[23] = 0
        colorBlock[24] = call.camera.eye[0]; colorBlock[25] = call.camera.eye[1]; colorBlock[26] = call.camera.eye[2]; colorBlock[27] = 1
        device.drawMesh({ target: call.target, clear: call.clear !== false, program: terrainColorProg, geometry: terrainSpec.geometry, uniforms: colorBlock })
        endTilePass()
      },
    }
  }
  const terrainZProg = terrainSpec !== null
    ? device.program({ depth: { test: 'less', write: true }, cull: 'back', wg: terrainSpec.z.wg, gl: terrainSpec.z.gl })
    : null
  const terrainColorProg = terrainSpec !== null
    ? device.program({ depth: { test: 'less', write: true }, cull: 'back', wg: terrainSpec.color.wg, gl: terrainSpec.color.gl })
    : null
  // ── Task 220 — THE MSAA LADDER (the field report's «одни лесенки»):
  //    the single-pass present of Task 219 moved the whole scene into the
  //    offscreen surface — and quietly retired every antialiasing path
  //    with it (the WG canvas MSAA was the field death's construct; the GL
  //    context cascade only ever covered the default framebuffer, which
  //    now receives nothing but the presentation blit). The AA's new home
  //    is the SURFACE itself: 4x samples on every real-GPU leg, resolved
  //    into the same 1x texture the blit presents (WG: the pass's inline
  //    resolveTarget; GL: the boundary blit) — the single-resolve shape
  //    the Task-219 matrix proved healthy, now pointed at a surface.
  //    · probe legs stay 1x (the validation's exact-pixel laws);
  //    · software adapters stay 1x (the 4x fill on SwiftShader — the
  //      caps' whole point — and the snapshot path is the degrade);
  //    · WG cannot resolve DEPTH (no spec shape) — a multisampled WG
  //      surface drops the sampleable-depth harvest texture: the
  //      still-camera reuse declines honestly to the feedback fill (the
  //      pre-A6 shape, ~1 extra depth-only draw of the visible set);
  //    · GL resolves depth too (blitFramebuffer DEPTH_BUFFER_BIT) — the
  //      harvest rides the multisampled leg for free;
  //    · a driver that refuses the 4x storage falls to 1x LOUDLY (the
  //      capability ladder's own note, never a silent degrade).
  let SAMPLES = MODE === 'probe' || device.software ? 1 : 4
  let surface = null
  for (;;) {
    const depthTex = SAMPLES === 1 || backend === 'webgl2'
    try {
      surface = device.surface(SURF_W, SURF_H, { depth: true, depthTexture: depthTex, samples: SAMPLES })
      break
    } catch (e) {
      if (SAMPLES === 1) throw e
      noteError(`the ${SAMPLES}x MSAA surface was refused (${e instanceof Error ? e.message : String(e)}) — the surface re-boots at 1x (no AA, everything else intact)`)
      SAMPLES = 1
    }
  }
  // Task 215 (A6 — the depth-reuse harvest): the surface's depth attachment
  // is a SAMPLEABLE depth texture (WG: depth32float / GL: DEPTH_COMPONENT32F)
  // — the color pass's own depth survives the pass, and a STILL camera can
  // rebuild the pyramid from it instead of re-rendering the survivors
  // depth-only (the presented frame IS the front layer — the fixed-point
  // law's own product). Absent on the WG MSAA legs (the spec has no depth
  // resolve — the Task-220 trade documented above).
  // Task 219 — THE PRESENTATION BLIT: the live canvas's whole interaction
  // with the frame — ONE fullscreen quad sampling the surface's color
  // texture (the canonical single-pass present; the multi-pass canvas is
  // dead and the facade's canvas-pass law guards its return).
  const blitProg = device.program({ depth: { test: 'less', write: false }, cull: 'none', wg: dict.blit.wg, gl: dict.blit.gl })

  const hist = device.historyPass({ scene: sceneHandle, mesh, pyramid, shaders: dict.hist, fill: dict.z, noClear: terrainSpec !== null })
  // Task 207 — THE SAME-FRAME FEEDBACK BRICK: the first cull's fresh RAW
  // visible set, depth-only into the tile (the second cull's seed — the
  // colored city occludes ITSELF within the frame; the field report's own
  // ask, answered with the survivors' depth instead of the whole scene's)
  const fbfill = device.feedbackPass({ scene: sceneHandle, mesh, pyramid, shaders: dict.fbfill, noClear: terrainSpec !== null })
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
    // Task 215 (A6) — hi-z is now PERSISTENT (transient: false): the
    // pyramid physically survives the frame boundary (the storage buffer
    // / the texture ladder — the seed's own law), and the still-frame path
    // reads the CARRIED version (cull#2 with the feedback branch gated out
    // — the staleness channel counts it, exactly like cull#1's seed read).
    hiz: fg.resource({ name: 'hi-z', kind: 'texture', width: SURF_W, height: SURF_H, format: 'r32f', transient: false, external: pyramid }),
    // Task 208 — THE CROSS-FRAME SEED: the pyramid's carry across the
    // frame boundary, as its OWN persistent resource. Physically the
    // SAME object as hi-z (bytes: 0 — counting it would double the
    // frame's memory math); logically the version that survives: every
    // pyramid build (the boot reduce or the feedback reduce-2) writes
    // it, the next frame's first cull reads the imported version, and
    // the staleness channel counts the lag. This is the bevy two-phase
    // delta expressed in the graph's own vocabulary — a research
    // technique as ZERO new mechanisms, pure scheduling.
    seed: fg.resource({ name: 'hiz-seed', kind: 'texture', bytes: 0, transient: false, external: pyramid }),
    target: fg.resource({ name: 'target', kind: 'texture', width: SURF_W, height: SURF_H, transient: false, external: surface }),
  }
  // Task 216 — the terrain's soup, a persistent buffer (the exact-mesh
  // sampler's own bytes; the walker's feet and the pixels read one source)
  if (terrainSpec !== null) {
    const g = terrainSpec.geometry
    R.terrainMesh = fg.resource({
      name: 'terrain-mesh', kind: 'buffer',
      bytes: (g.positions.length + (g.normals?.length ?? 0) + (g.uvs?.length ?? 0)) * 4,
      transient: false, external: { mesh: true, vertexCount: g.vertexCount },
    })
  }

  // Task 208 — when the seed OWNS phase 1: the policy asks for it, the
  // pyramid carries a written version (frame 1 boots the honest way — an
  // unwritten seed is uninitialized memory, and a zero-filled pyramid
  // would cull the world), the two-pass frame is on (a single-cull frame
  // has NO phase 2 to correct a stale seed — the plain leg keeps its
  // fresh z-fill), the culling gate is up, the frame is fresh (a frozen
  // frame must keep the strip's classic shape), and the history policy
  // hasn't claimed phase 1 for itself (the prev-visible re-render is the
  // fresher seed — the seed idles when history runs).
  const seedActive = p => p.seed === true && p.feedback === true && p.culling === true && p.fresh === true && p.history !== true

  let pendingStats = null // the read-stats copy pass's in-flight readback
  if (terrainSpec !== null) {
    fg.pass({
      // Task 216 — THE TERRAIN'S OWN DEPTH: the hills occlude — the
      // pyramid tile's BASE layer, drawn before the crowd's warm-up fill
      // (which stops clearing: the depth test merges the boxes on top)
      name: 'terrain-z', kind: 'render', cost: 2,
      reads: [R.terrainMesh], writes: [R.hiz],
      when: p => !seedActive(p),
      execute: ({ props }) => terrainZ.run({ camera: props.camera, clear: true }),
    })
  }
  fg.pass({
    // the prepass: gate OFF = the K-wall fill (byte-identical to the
    // Task-201 depthPass frame); gate ON = the two-pass HZB — the
    // prev-visible set + the fill. DECLARATION-ORDER VERSION LAW: this is
    // the FIRST scene reader, so it binds the version BEFORE this frame's
    // cull write — the previous frame's verdicts, exactly what phase 1
    // consumes (no reprojection, the set re-renders at the current camera).
    // Task 208 — THE SEED GATE: when the cross-frame seed owns phase 1
    // this whole warm-up (the fill + the reduce below) leaves the frame —
    // the first cull reads the carried pyramid instead, and the feedback
    // branch rebuilds everything it needs from its own fill.
    // Task 216 — with a terrain present this pass READS hi-z too (the
    // overlay law: the crowd's depth MERGES onto the terrain's base layer
    // through the depth test — a read-modify-write, never a blind write)
    name: 'z-fill', kind: 'render', cost: 3,
    reads: terrainSpec !== null ? [R.scene, R.mesh, R.hiz] : [R.scene, R.mesh],
    writes: [R.hiz],
    when: p => !seedActive(p),
    execute: ({ props }) => hist.run({ camera: props.camera, occluders: props.occluders, gate: props.history === true }),
  })
  fg.pass({
    name: 'pyramid-reduce', kind: KERNEL, cost: 2,
    reads: [R.hiz], writes: [R.hiz, R.seed], // read-modify-write: level L reads L−1; the build IS the seed's writer
    when: p => !seedActive(p),
    execute: () => pyramid.build(),
  })
  fg.pass({
    // THE VERDICT KERNEL — the conditional read is the shadows-off law:
    // culling off → no pyramid read → the prepass branch dies with it
    // (the kernel still runs: the OFF legs need fresh frustum verdicts).
    // `fresh` is THE AMORTIZED-CULL gate: a bit-still camera+policy frame
    // skips BOTH this pass and the fold — the streaks must not advance on
    // stale raw verdicts.
    // Task 208 — THE SEEDED READ: with the seed active, phase 1 reads the
    // PERSISTENT carry (the imported version — the edge the graph now
    // carries as `import→cull-verdicts hiz-seed@v`), not the within-frame
    // hi-z: the same physical pyramid, the CROSS-FRAME version contract.
    name: 'cull-verdicts', kind: KERNEL, cost: 1,
    reads: props => [R.scene, ...(props.culling === true ? [seedActive(props) ? R.seed : R.hiz] : [])],
    writes: [R.scene],
    when: props => props.fresh === true,
    execute: ({ props }) => occl.run({ camera: props.camera, gate: props.culling === true }),
  })
  // ══ Task 207 — THE SAME-FRAME FEEDBACK BRANCH (the two-pass HZB's
  // CURRENT-FRAME phase 2: the user's «the colored boxes still don't occlude
  // the rear colored boxes» answered in-graph) ════════════════════════════
  // The first cull's fresh visible set V1 writes depth, the pyramid rebuilds,
  // a SECOND cull lands — the city occludes ITSELF at the current camera for
  // the survivors' depth price. THE VERSION LAW'S OWN SHOWCASE: this is the
  // FIRST same-frame reader that binds the scene version AFTER a cull write
  // (the edge cull-verdicts→feedback-fill scene@v1), where the z-fill above
  // binds the imported one — the DAG now carries a real two-phase chain.
  // Gating: the branch needs the cull's fresh verdicts (fresh), the pyramid
  // (culling) and the policy bit itself — with any of them off the whole
  // branch leaves the frame exactly like the shadows-off law.
  if (terrainSpec !== null) {
    fg.pass({
      // Task 216 — THE TERRAIN'S OWN DEPTH, phase-2 spelling: the tile's
      // base layer before the feedback fill (the seed frame's ONLY tile
      // writer pair — the boot branch above left the frame)
      name: 'terrain-z-2', kind: 'render', cost: 2,
      reads: [R.terrainMesh], writes: [R.hiz],
      when: props => props.feedback === true && props.culling === true && props.fresh === true && props.reuse !== true,
      execute: ({ props }) => terrainZ.run({ camera: props.camera, clear: true }),
    })
  }
  fg.pass({
    name: 'feedback-fill', kind: 'render', cost: 3,
    reads: terrainSpec !== null ? [R.scene, R.mesh, R.hiz] : [R.scene, R.mesh], writes: [R.hiz],
    // Task 215 (A6) — the still-frame skip: a bit-identical camera + the
    // reuse policy means the presented frame's own depth can stand in for
    // the fill (the depth-harvest pass below) — the branch leaves the
    // frame exactly like any gate-off leg, and cull-verdicts-2 falls back
    // to the carried pyramid (the Task-208 staleness law: the lag costs
    // fill, never a pixel — and the K=3 hysteresis fold absorbs a verdict
    // flicker through the transition anyway)
    when: props => props.feedback === true && props.culling === true && props.fresh === true && props.reuse !== true,
    execute: ({ props }) => fbfill.run({ camera: props.camera }),
  })
  fg.pass({
    name: 'pyramid-reduce-2', kind: KERNEL, cost: 2,
    // read-modify-write over the feedback fill's tile — AND THE SEED'S
    // WRITER (Task 208): the late downsample, after the phase-1 depth
    // writers, in bevy issue #18711's tracked position — the built pyramid IS
    // the next frame's carry
    reads: [R.hiz], writes: [R.hiz, R.seed],
    when: props => props.feedback === true && props.culling === true && props.fresh === true && props.reuse !== true,
    execute: () => pyramid.build(),
  })
  fg.pass({
    name: 'cull-verdicts-2', kind: KERNEL, cost: 1,
    reads: [R.scene, R.hiz], writes: [R.scene],
    when: props => props.feedback === true && props.culling === true && props.fresh === true,
    execute: ({ props }) => occl.run({ camera: props.camera, gate: true }),
  })
  fg.pass({
    name: 'hysteresis', kind: KERNEL, cost: 1,
    reads: [R.scene], writes: [R.scene],
    when: props => props.fresh === true,
    execute: ({ props }) => smooth.run({ gate: props.hysteresis === true }),
  })
  if (terrainSpec !== null) {
    fg.pass({
      // Task 216 — THE TERRAIN'S OWN COLOR: the lit soup INTO the target,
      // clearing it (the crowd's color pass then draws WITHOUT the clear —
      // the depth test interleaves the two opaque layers honestly)
      name: 'terrain-color', kind: 'render', cost: 3,
      reads: [R.terrainMesh], writes: [R.target],
      execute: ({ props }) => terrainColor.run({ target: props.target, camera: props.camera, clear: true, fogNear: terrainSpec.fogNear, fogFar: terrainSpec.fogFar }),
    })
  }
  fg.pass({
    name: 'color', kind: 'render', cost: 6,
    // Task 216 — with a terrain present this pass READS the target too (the
    // OVERLAY LAW: the crowd draws OVER the terrain's color, a read-modify-
    // write — a pure second write would leave terrain-color's version
    // reader-less and the branch-culling law would drop it from the frame,
    // an invisible terrain with working collision)
    reads: terrainSpec !== null ? [R.scene, R.mesh, R.target] : [R.scene, R.mesh],
    writes: [R.target],
    // Task 209 — the near-first order rides the color draw (the early-Z
    // harvest; the set/history draws keep the plain compact — a depth-only
    // fill has no overdraw to save)
    // Task 216 — with a terrain present the crowd does NOT clear (the
    // terrain-color pass owns the target's clear + depth base)
    execute: ({ props }) => color.run({ target: props.target, camera: props.camera, light: LIGHT, order: props.order === true, clear: terrainSpec === null }),
  })
  fg.pass({
    // Task 215 (A6) — THE DEPTH-REUSE HARVEST: the presented frame's OWN
    // depth becomes the pyramid (the "late downsample" — after ALL the
    // frame's depth writers, bevy #18711's own position). The still-camera
    // fixed-point law: the color pass renders the final visible set, its
    // depth attachment IS the front layer, and the front layer is ALL the
    // pyramid ever depended on (Task 208's own proof) — so the harvested
    // pyramid ≡ the feedback-built one, bit for bit at a converged camera
    // (the reuse gate's dispatch). The fill render it replaces is the
    // whole point: a still camera + live edits (the drones) used to pay
    // the depth-only re-render of the survivor crowd every frame.
    name: 'depth-harvest', kind: KERNEL, cost: 2,
    reads: [R.target], writes: [R.hiz, R.seed],
    // KEEP: the harvest is the SEED'S AUTHOR — its consumers live in the
    // NEXT frame (cull#1's imported read), not in this one; without the
    // keep the branch-culling law (a reader-less write is a dead branch —
    // the same law that would take the color pass without the strip's
    // overlay read) would drop it from the frame as unreachable
    keep: true,
    when: props => props.reuse === true && props.culling === true && props.fresh === true,
    execute: () => { if (pyramid.harvestDepth !== undefined && surface.depthTextureId !== undefined) pyramid.harvestDepth(surface.depthTextureId) },
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
    // the frame boundary: the WG encoder submit / the GL service boundary.
    // Task 219 — THE SINGLE-PASS PRESENT: on the live legs the canvas gets
    // exactly ONE blit draw (the surface's color texture → the canvas)
    // before the submit; the snapshot legs keep the 2D putImageData path
    // (blitSnapshot, zero GPU presents — the software degrade).
    name: 'present', kind: 'present', cost: 1,
    reads: [R.target],
    execute: () => {
      // Task 220 — the live present ledger: the tier's own frame counter
      // (the overlay swap waits for the FIRST landed present before
      // retiring the old canvas — a fallback boot must never black-flash
      // the screen it is rescuing).
      if (MODE === 'live') { device.blitToCanvas({ program: blitProg, surface }); livePresents++ }
      device.submit()
    },
  })

  // ── THE FRAME = compile(policy) + run(props) ───────────────────────────
  //    THE AMORTIZED-CULL CONTRACT (unchanged from Task 202, now a graph
  //    concept): a frame whose camera AND policy are bit-identical to the
  //    last culled frame reuses its verdicts — cull-verdicts + hysteresis
  //    are GATED out of the compiled frame, and every scene reader binds
  //    the LAST EXECUTED version (the staleness counts on the HUD). The
  //    cache keys on the mvp WORDS + the full policy tuple (hiz/occluders/
  //    hysteresis/history/feedback/seed): a leg that flips any of them at
  //    the same camera is a NEW policy and re-culls honestly.
  let lastCulled = null // { key: string, mvp: Float32Array } — the last CULLED frame's cache key
  let cullSkips = 0
  let lastFrame = null // the last compiled frame (the graph stats' source)
  let lastReport = null // the last run report (executed + staleness)
  let seedLive = false // Task 208 — did the seed own the last frame's phase 1
  // Task 215 (A6) — the still-camera detector: the previous renderTo's mvp
  // WORDS. A bit-identical mvp means the camera did not move — the
  // presented frame's own depth can stand in for the feedback fill (the
  // reuse policy). The orbit camera recomputes the mvp every frame — the
  // same state produces the same floats (deterministic math), so a frozen
  // camera (auto=0, no drag) reads still from frame 2 on.
  let lastMvpSeen = null // Float32Array — the previous renderTo's mvp words
  function renderTo(targetId, mvp, eye, hizOn, debug, occluders = K, hysteresisOn = false, historyOn = false, cacheOn = false, wantStats = false, feedbackOn = true, seedOn = true, orderOn = true, reuseOn = true) {
    const camera = { mvp, eye }
    // NOTE the boolean hygiene (the Task-202 lesson): `historyOn !== 0`
    // with historyOn === false is TRUE — every gate answers `=== true` /
    // `props.x === true` from here on, both spellings (1/0 and booleans)
    // ride the same law. Task 207: `feedbackOn` defaults TRUE — the
    // same-frame feedback is the BOOT POLICY now (the field report's ask);
    // the plain single-cull frame is the explicit `false` leg. Task 208:
    // `seedOn` defaults TRUE — the cross-frame seed rides ON TOP of the
    // feedback frame (it needs phase 2); the resolved prop ALSO requires
    // the pyramid to carry a WRITTEN version (lastReport's staleness
    // channel: −1 = never built — frame 1 boots the honest K-wall way,
    // a zero-filled pyramid would cull the world).
    const feedback = feedbackOn === true || feedbackOn === 1
    const seedWanted = seedOn === true || seedOn === 1
    const seed = seedWanted && lastReport !== null && (lastReport.stale['hiz-seed'] ?? -1) >= 0
    // Task 215 (A6) — the reuse policy: a STILL camera + a surface frame
    // (the canvas present path carries no samplable depth — the doc's own
    // catch; snapshot/probe/validation legs all render to the surface) +
    // the harvest bricks present. With all that, the feedback FILL leaves
    // the frame and the depth-harvest pass (after color) becomes the
    // pyramid's author — the fill's render cost traded for two dispatches.
    let still = false
    if (lastMvpSeen !== null && mvp.length === 16) {
      still = true
      for (let i = 0; i < 16; i++) {
        if (lastMvpSeen[i] !== mvp[i]) { still = false; break }
      }
    }
    lastMvpSeen = Float32Array.from(mvp)
    const reuse = (reuseOn === true || reuseOn === 1) && still && feedback
      && targetId === surface.targetId
      && surface.depthTextureId !== undefined
      && pyramid.harvestDepth !== undefined
    const key = `${hizOn ? 1 : 0}|${occluders}|${hysteresisOn ? 1 : 0}|${historyOn ? 1 : 0}|${feedback ? 1 : 0}|${seed ? 1 : 0}`
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
      feedback,
      seed,
      fresh: !cached,
      wantStats: wantStats === true,
      // Task 209 — the near-first order (the early-Z harvest): a COLOR-pass
      // draw option, not a culling policy — the verdicts never change with
      // it, so it rides the run props only (the compiled frame's shape and
      // the amortized-cull cache key both stay untouched)
      order: orderOn === true || orderOn === 1,
      // Task 215 (A6) — the depth-reuse policy bits: `still` is the camera's
      // own state (a fact, not a policy), `reuse` is the resolved leg
      still,
      reuse,
    }
    lastFrame = fg.compile(props) // cached by policy — the declarations never see the camera
    lastReport = lastFrame.run(props)
    seedLive = seed && !cached // the seed owned THIS frame's phase 1 (the frozen frame reuses verdicts)
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

  // ── Task 209 — THE COMPACT'S OWN READBACK (the identity/order gates'
  //    channel): the visible list + the verdict words the compact READ
  //    (hist-aware) + the drawn count. WG only — null on the GL leg (the
  //    collapse draw keeps no list; the order is a WG-leg harvest).
  function readList() {
    return device.readList(sceneHandle)
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
    // Task 208 — the seed's own staleness: how many frames ago the carried
    // pyramid was built (0 = this frame's late downsample; −1 = never —
    // the boot frame's honest K-wall warm-up still owns phase 1)
    const staleSeed = lastReport?.stale?.['hiz-seed'] ?? -1
    const seedTxt = seedLive ? ` · seed ${staleSeed < 0 ? 'cold' : `${staleSeed}f stale`}` : ''
    return `frame graph: ${s.live}/${s.declared} live${g}${c} · ${s.barriers} barriers · ${s.slots} slot${s.slots === 1 ? '' : 's'} · peak ${(s.peakBytes / 1024).toFixed(0)} KB (alias −${s.savedPct.toFixed(0)}%) · plan ∥ ${par} · verdicts ${staleScene < 0 ? 'imported' : `${staleScene}f stale`}${seedTxt} · ${s.compiles} compile${s.compiles === 1 ? '' : 's'}`
  }

  // ── the snapshot blit (software WG — zero presents) ─────────────────────
  let livePresents = 0 // Task 220 — the live leg's own present ledger (the
  // overlay swap's predicate — see the present pass)
  let blitPending = false
  let blitLanded = 0 // Task 219 — the snapshot's own "present" counter: the
  let blitRefused = 0 // async readback+putImageData IS this leg's present —
  // the watchdog must judge it only after its first LANDING (a SwiftShader
  // readback can take dozens of frames to arrive — an empty canvas before
  // the first landing is LATENCY, not death — the frame-217 predicate law)
  function blitSnapshot() {
    if (blitPending) return
    blitPending = true
    surface.read().then(result => {
      blitPending = false
      if (snapshot2d !== null && result.data.length === SURF_W * SURF_H * 4) {
        snapshot2d.putImageData(new ImageData(new Uint8ClampedArray(result.data.buffer, result.data.byteOffset, result.data.length), SURF_W, SURF_H), 0, 0)
        blitLanded++
      }
    }).catch(() => { blitRefused++; blitPending = false })
  }

  // ── Task 214 — THE SPD PARITY GATE (the single-pass downsampler's
  //    bit-identity channel): dispatch BOTH spellings over the same z tile
  //    — the SPD pair (the live form) and the legacy sequential chain (the
  //    Task-196 spelling) — and compare EVERY storage word. THE POISON
  //    DISCIPLINE: the storage is pre-filled with NaN before EACH build —
  //    an under-budgeted phase (a hole the cascade never writes) shows up
  //    as a stale/NaN word instead of silently inheriting the previous
  //    build's value (the static-camera trap the first draft fell into:
  //    the holes matched because the previous COMPLETE build of the SAME
  //    tile had written the right numbers there). The z tile is untouched
  //    between the builds (both read the same r32f texture), so any diff
  //    is a real bug. WG only — null on the GL leg (its FBO pyramid is
  //    the backend's own mechanism, untouched this round).
  async function spdParity() {
    if (pyramid.buildLegacy === undefined || pyramid.readWords === undefined || device.gpu === null) return null
    try {
      const gpu = device.gpu
      const probe = await pyramid.readWords()
      const poison = new Float32Array(probe.length).fill(NaN)
      // poison FIRST, build, submit, then read — THE SUBMIT DISCIPLINE:
      // readExternalBuffer submits only ITS OWN copy encoder, while the
      // builds' dispatches sit in the facade's MERGED compute pass on the
      // main encoder — without this submit the readback lands on the queue
      // BEFORE the dispatches and both spellings read back the SAME stale
      // bytes (the vacuous-comparison trap the first draft of this gate
      // fell into: 0 diffs that proved nothing)
      const buildPoisoned = async buildFn => {
        gpu.writeExternalBuffer(pyramid.storageId ?? 0, poison)
        buildFn()
        device.submit()
        return await pyramid.readWords()
      }
      const a = await buildPoisoned(() => pyramid.build())
      const b = await buildPoisoned(() => pyramid.buildLegacy())
      pyramid.build() // the belt-and-braces rebuild (the bytes are identical by the proof)
      let diffs = 0
      let first = -1
      const n = Math.min(a.length, b.length)
      for (let i = 0; i < n; i++) {
        if (a[i] !== b[i]) {
          diffs++
          if (first < 0) first = i
        }
      }
      return {
        words: n,
        diffs,
        first,
        pass: diffs === 0 && a.length === b.length,
        spdDispatches: 1 + (pyramid.levels >= 8 ? 1 : 0),
        legacyDispatches: 1 + (pyramid.levels - 1),
      }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }

  // ── Task 215 (A6) — THE DEPTH-REUSE PARITY GATE: at a still converged
  //    camera, the harvested pyramid (the color pass's own depth — the
  //    reuse path) must equal the feedback-built one (the survivors'
  //    depth-only re-render) BIT FOR BIT, the drawn counts equal, the
  //    presented pixels equal, and the frame shapes must show the honest
  //    swap (feedback-fill gated out, depth-harvest live). The caller
  //    supplies the camera (the validation/gate legs' own mvp) and pauses
  //    the loop (the readback discipline).
  async function reuseParity(mvp, eye) {
    if (surface.depthTextureId === undefined || pyramid.harvestDepth === undefined) return null
    try {
      const settle = async reuseOn => {
        // four frames at the camera under the given spelling: frame 1 is a
        // camera move (the classic path converges the carry), the rest ride
        // the still camera — the spelling's own frame shape
        for (let f = 0; f < 4; f++) {
          renderTo(surface.targetId, mvp, eye, 1, false, K, false, false, false, false, true, true, true, reuseOn)
        }
        device.submit() // the readback discipline (the frame's own present already submitted — belt and braces)
        const stats = await readStats()
        const img = await surface.read()
        let h = 2166136261
        for (let i = 0; i < img.data.length; i++) {
          h ^= img.data[i]
          h = Math.imul(h, 16777619)
        }
        const words = pyramid.readWords !== undefined ? await pyramid.readWords() : null
        return { stats, hash: h, words, graph: lastFrame !== null ? lastFrame.passes.map(p => p.name) : [] }
      }
      const off = await settle(false)
      const on = await settle(true)
      let diffs = 0
      let first = -1
      let words = null
      if (off.words !== null && on.words !== null && off.words.length === on.words.length) {
        words = off.words.length
        for (let i = 0; i < words; i++) {
          if (off.words[i] !== on.words[i]) {
            diffs++
            if (first < 0) first = i
          }
        }
      }
      const harvestLive = on.graph.includes('depth-harvest') && !on.graph.includes('feedback-fill') && !on.graph.includes('pyramid-reduce-2')
      const fillClassic = off.graph.includes('feedback-fill') && off.graph.includes('pyramid-reduce-2') && !off.graph.includes('depth-harvest')
      const drawnEqual = on.stats.drawn === off.stats.drawn
      const occludedEqual = on.stats.occluded === off.stats.occluded
      const hashEqual = on.hash === off.hash
      return {
        // WG: the words compare rides the verdict (the storage pyramid);
        // GL: no storage pyramid — the drawn/occluded/pixel laws + the
        // honest frame-shape swap carry the gate
        pass: (words === null || diffs === 0) && drawnEqual && occludedEqual && hashEqual && harvestLive && fillClassic,
        words,
        diffs: words === null ? null : diffs,
        first,
        drawnOff: off.stats.drawn,
        drawnOn: on.stats.drawn,
        occludedOff: off.stats.occluded,
        occludedOn: on.stats.occluded,
        hashEqual,
        harvestLive,
        fillClassic,
        graphOn: on.graph,
        graphOff: off.graph,
      }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }

  function frame(mvp, eye, hizOn, debug, occluders = K, hysteresisOn = false, historyOn = false, cacheOn = false, wantStats = false, feedbackOn = true, seedOn = true, orderOn = true, reuseOn = true) {
    // Task 219 — EVERY mode renders into THE SURFACE (the crowd, the
    // terrain, the strip — the graph's target); the live canvas is a
    // presentation surface reached by the present pass's ONE blit (the
    // multi-pass direct-to-canvas frame — the WG field death — is gone).
    // The A6 depth-reuse rides free now: the live frame's target IS the
    // surface with its sampleable depth (the Task-215 limitation — «the
    // canvas present path carries no samplable depth» — dissolves).
    renderTo(surface.targetId, mvp, eye, hizOn, debug, occluders, hysteresisOn, historyOn, cacheOn, wantStats, feedbackOn, seedOn, orderOn, reuseOn)
    if (SNAPSHOT) blitSnapshot()
  }

  // ── Task 216 — THE ADAPTIVE RENDER-SCALE HOOK (mobile-first): the
  //    walker's governor (a @rune/core brick) decides the LEVEL; this is
  //    the engine side — the live canvas's backing store re-derived at
  //    bootDpr × scale through the renderer's own setDpr path (both
  //    renderers grew it this round). The snapshot/probe legs render to
  //    the FIXED surface — the scale is a documented no-op there (null).
  let bootDpr = null
  function setRenderScale(scale) {
    if (MODE !== 'live' || displayCanvas === null || displayCanvas.clientWidth <= 0) return null
    if (bootDpr === null) {
      const d = displayCanvas.width / displayCanvas.clientWidth
      if (!(d > 0) || !Number.isFinite(d)) return null
      bootDpr = d
    }
    const dpr = Math.max(0.2, Math.min(8, bootDpr * scale))
    device.renderer.setDpr(dpr)
    return { w: displayCanvas.width, h: displayCanvas.height, dpr }
  }

  /** The live camera aspect — the canvas's own CSS shape (portrait aware). */
  function aspect() {
    if (displayCanvas === null) return 16 / 9
    const w = displayCanvas.clientWidth
    const h = displayCanvas.clientHeight
    if (w <= 0 || h <= 0) return 16 / 9
    return w / h
  }

  // ── Task 211 — THE PARTIAL UPLOAD CHANNEL (the unified data surface's
  //    GPU leg): the demo's store (adopted over the scene words, zero
  //    copies) hands COALESCED, 4-aligned dirty byte ranges; the device
  //    brick pushes them into the mirror BEFORE the frame's passes read
  //    it — WG: one writeExternalBuffer per range (the 5-arg form over
  //    the words' own bytes); GL: one bufferSubData per range into the
  //    records buffer. Returns the uploaded bytes (the HUD's honest
  //    number — KBs against the whole-buffer write's ~1 MB).
  function applyEdits(ranges) {
    return sceneHandle.updateRecords(ranges)
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
      // Task 214 — the SPD parity channel (the probe scripts' window into
      // the single-pass downsampler's bit-identity gate)
      spdParity: () => spdParity(),
      // Task 215 (A6) — the depth-reuse parity channel (the gate's window
      // into the harvest law: both spellings at a still camera, compared)
      reuseParity: (mvp, eye) => reuseParity(mvp, eye),
      // Task 211 — the record mirror's readback (the edit-mode gate's
      // channel): the GPU's own copy of record `id`, vs __hizEdits.record
      records: id => device.readRecords(sceneHandle, id, 1),
    }
  } else if (typeof window !== 'undefined') {
    window.__hizDebug = {
      note: 'the WebGL2 tier is active — pyramidAt/ztile are WG-only (the texture pyramid), but records() reads the mirror',
      // Task 211 — the same channel on the GL leg: the records buffer's
      // own copy, read back through the facade's COPY_READ path
      records: id => device.readRecords(sceneHandle, id, 1),
    }
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
      ? `WebGL2 — FBO pyramid + TF cull + vertex-collapse draw${SAMPLES > 1 ? ` · MSAA ${SAMPLES}x surface (blit resolve)` : ''}`
      : `WebGPU — storage pyramid + compute cull + one drawIndexedIndirect${SAMPLES > 1 ? ` · MSAA ${SAMPLES}x surface (inline resolve)` : ''}`,
    drawsLine: backend === 'webgl2'
      ? `draws: 2 (fill + collapse color; +1 history set draw ON; +1 feedback fill ON — the same-frame city self-occlusion; the seed frame drops the fill + the first reduce — phase 1 reads the carried pyramid; Task 215 — a STILL camera swaps the fill for the depth harvest: 1 quad + the ladder, the presented frame's own depth) · TF passes: 2 (cull + hysteresis; +1 cull ON the feedback) · ${pyramid.levels - 1} reduce quads (×2 the feedback frame; ×1 the seed frame)`
      : `draws: 2 (fill + indirect color; +1 history set draw ON; +1 feedback fill ON — the same-frame city self-occlusion; the seed frame drops the fill + the first reduce — phase 1 reads the carried pyramid; Task 215 — a STILL camera swaps the fill for TWO DISPATCHES: the SPD pair over the presented frame's own depth32float) · dispatches: 3 (cull + hysteresis + compact; +1 cull ON the feedback; +1 order ON the near-first list — the early-Z harvest) · Task 214 — the pyramid builds in ONE SPD DISPATCH PAIR (${Math.ceil(SURF_W / 64) * Math.ceil(SURF_H / 64)} region workgroups + the top reduce) where the legacy chain spent ${pyramid.levels} (×2 the feedback frame; ×1 the seed frame)`,
    canvas: displayCanvas,
    surface,
    /** Task 219 — THE OCCLUSION-RESOLUTION LAW's own channel: the pyramid's
     * dims (== the surface's — the cull's proof resolution equals the
     * render's; the gate asserts the equality and the ladder's caps). */
    hizDims: { w: SURF_W, h: SURF_H },
    /** Task 218 — the hysteresis K this tier runs with (the wiring law's
     * channel: the walker passes 4 — Task 219's honest damper, the
     * pyramid-equality root cure rides above it). */
    hystFrames: HYST_FRAMES,
    /** Task 219 — THE SNAPSHOT PRESENT HEALTH (the watchdog's predicate):
     * `landed` = completed readback+putImageData cycles (the async present
     * path's own frame counter), `refused` = rejected readbacks (a dead
     * device's signature). A live canvas presents synchronously — the
     * watchdog judges it at the frame cadence; a snapshot canvas is judged
     * only once a blit has LANDED or been REFUSED. */
    snapshotHealth: () => ({ landed: blitLanded, refused: blitRefused }),
    /** Task 220 — THE PRESENT LEDGER (the overlay swap's predicate): the
     * live leg's `presents` counts submitted canvas blits (synchronous —
     * the first one means the new tier is ALREADY on screen); the
     * snapshot's `landed`/`refused` ride the async readback. The overlay
     * boot keeps the OLD canvas visible until this channel says the new
     * one has landed its first frame — the fallback never black-flashes. */
    presentHealth: () => ({ presents: livePresents, landed: blitLanded, refused: blitRefused }),
    renderTo,
    frame,
    applyEdits,
    /** Task 216 — the adaptive render-scale hook (see above; null on the
     *  fixed-surface legs). */
    setRenderScale,
    readStats,
    readVerdicts,
    readList,
    spdParity,
    reuseParity,
    aspect,
    graphStats,
    graphLine,
    /** Task 208 — the seed's live channel (the HUD/probe readout): `on`
     *  = the cross-frame carry owned the LAST frame's phase 1 (z-fill +
     *  the first reduce left the frame), `stale` = the carry's own age in
     *  frames (the graph's persistent-version staleness, −1 = never
     *  written — the honest cold boot). */
    seedState: () => ({ on: seedLive, stale: lastReport?.stale?.['hiz-seed'] ?? -1 }),
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
