// occlusion/tier.js — THE ONE TIER. Both backends, ONE code path.
//
// Pre-198 the demo carried two tier files in two API dialects — wgTier.js
// (gpu.*) and glTier.js (gl.*), ~1200 lines of parallel mechanics. Task
// 198's common bricks (createDevice) collapsed them; Task 199 made the
// frame ONE hizFrame() call; Task 200 finishes the sentence — the whole
// Hi-Z SCENARIO is one hizScene() construction and one frame() call:
//
//   const hiz = device.hizScene({ scene, shaders, geometry, pyramid, light })
//   hiz.frame({ target: 0, camera: { mvp, eye }, occluders, culling: true })
//
// The programs (from the shader dictionary), the packed uniform lanes, the
// GL dither's y-mirror height, the pyramid debug strip and the validation
// surface all live INSIDE the brick now — the tier below is boot, canvas,
// stats and gates only. A different scenario = a different dictionary +
// declaration; this file stays the shape it is.
//
// THE FRAME (what hiz.frame() runs — the recipe):
//   1. THE Z PREPASS   the first `occluders` records render into the
//                      pyramid's r32f level-0 tile (fs writes the exact
//                      depth; the tile's depth attachment keeps the NEAREST
//                      occluder per pixel)
//   2. THE PYRAMID     the 2×2 MAX chain (WG: the compute family; GL: FBO
//                      quads — the backend's own mechanism, ONE contract)
//   3. THE CULL        the per-record verdict kernel (WG: compute; GL: the
//                      transform-feedback pass)
//   4. THE COLOR PASS  the visible set (WG: compact + ONE drawIndexedIndirect,
//                      GPU-driven, zero readbacks; GL: ONE instanced draw +
//                      vertex collapse)
//   5. THE DEBUG STRIP one panel quad per pyramid level (toggled)
//
// Task 200 — THE GL SUBMIT FIX rides the device: submit() runs the
// renderer's SERVICE boundary (canvas-state heal + error drain), never the
// renderer's own recorded tape — the empty BeginPass used to CLEAR THE
// CANVAS after every frame (the «WebGL2 renders empty» field report: stats
// alive, canvas the clear color).
import { createDevice } from '../../dist/rune.esm.js?v=200'
import { buildShaders } from './shaders.js?v=200'
import { BOX_VERTS, BOX_INDICES, HIZ_W, HIZ_H } from './scene.js?v=200'
const SKY = [0.045, 0.055, 0.09, 1]
const LIGHT = [0.5, 0.8, 0.35]
const SURF_W = 480, SURF_H = 270

/** Builds the Hi-Z tier on EITHER backend — the same builder, the same
 *  frame, the same stats. Throws the honest refusal when the backend
 *  cannot carry it (the caller falls back). */
export async function buildTier(deps) {
  const { backend, scene, shell, noteError, stage, PROBE, FORCE_SNAPSHOT, attachControls, pauseLoop, resumeLoop } = deps
  const { K, N, INST_OFF, FLAGS_OFF, sceneWords, sceneF32 } = scene
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

  // ── THE SCENARIO — ONE construction (Task 200: the programs, the culler,
  //    the uniform lanes, the dither mirror and the debug strip all join
  //    the recipe inside the brick; the dictionary stays the scenario's
  //    own data — buildShaders(scene) is the whole per-scenario surface) ──
  const hiz = device.hizScene({
    scene: device.scene({
      total: N,
      occluders: K,
      words: sceneWords,
      recordsF32: sceneF32.subarray(INST_OFF),
      flagsWord: FLAGS_OFF,
      recordsWord: INST_OFF,
      stride: scene.STRIDE,
      fields: scene.FIELDS,
    }),
    shaders: buildShaders(scene),
    geometry: device.geometry(BOX_VERTS, BOX_INDICES),
    pyramid: { width: HIZ_W, height: HIZ_H },
    surface: { width: SURF_W, height: SURF_H },
    light: LIGHT,
  })
  const surface = hiz.surface
  const sceneHandle = hiz.scene

  // ── THE FRAME — one sentence (the whole Hi-Z pipeline; `occluders` is
  //    THE POLICY: how many records write the z prepass — the boot default
  //    K=23, the whole city N, anything between; `culling: false` is the
  //    parity gate's OFF leg) ──────────────────────────────────────────────
  function renderTo(targetId, mvp, eye, hizOn, debug, occluders = K) {
    hiz.frame({
      target: targetId,
      camera: { mvp, eye },
      culling: hizOn !== 0,
      pyramidView: debug === true,
      occluders,
    })
    device.submit()
  }

  // ── stats (the brick normalizes: WG args-buffer readback / GL flag sweep)
  function readStats() {
    return hiz.readStats()
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

  function frame(mvp, eye, hizOn, debug, occluders = K) {
    renderTo(SNAPSHOT ? surface.targetId : 0, mvp, eye, hizOn, debug, occluders)
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
    const pyr = hiz.pyramid
    window.__hizDebug = {
      note: 'the common-bricks tier — pyramidAt/ztile/stats read the storage pyramid',
      async pyramidAt(level) {
        try {
          const off = (pyr.offsets ?? [0])[level] ?? 0
          const f = await gpu.readExternalBuffer(pyr.storageId ?? 0, off * 4 + 64)
          return Array.from(new Float32Array(f.buffer, off * 4, 16), v => +v.toFixed(4))
        } catch (e) {
          return `readback refused: ${e instanceof Error ? e.message : String(e)}`
        }
      },
      async ztile() {
        try {
          const px = new Uint8Array(await gpu.readTargetPixels(pyr.zTarget))
          return Array.from(new Float32Array(px.buffer, 0, 16), v => +v.toFixed(4))
        } catch (e) {
          return `readback refused: ${e instanceof Error ? e.message : String(e)}`
        }
      },
      stats: () => readStats(),
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
      ? `draws: 1 (instanced, vertex-collapse) · TF passes: 1 · ${hiz.pyramid.levels - 1} reduce quads`
      : `draws: 1 (indirect, GPU-driven) · dispatches: 2 (cull + compact) · ${hiz.pyramid.levels - 1} reduce quads`,
    canvas: displayCanvas,
    surface,
    renderTo,
    frame,
    readStats,
    aspect,
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
