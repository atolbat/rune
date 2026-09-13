// occlusion/tier.js — Task 198: THE ONE TIER. Both backends, ONE code path.
//
// Pre-198 the demo carried two tier files in two API dialects — wgTier.js
// (gpu.*) and glTier.js (gl.*) — ~1200 lines of parallel mechanics. The
// common bricks (packages/gl device.ts — createDevice) collapsed them:
// every frame call below executes IDENTICALLY on WebGPU and WebGL2; the
// per-backend mechanisms hide inside the bricks (compute vs transform
// feedback, drawIndexedIndirect vs vertex-collapse, the arena vs the named
// uniforms); the per-language shader SOURCES are data from shaders.js.
//
// THE FRAME (the whole pipeline — one syntax):
//   1. THE Z PREPASS   device.drawInstanced → the pyramid's r32f level-0
//                      tile (fs writes the exact depth; the target's depth
//                      attachment keeps the NEAREST occluder per pixel)
//   2. THE PYRAMID     pyr.build() — the 2×2 MAX chain: WG rides the
//                      compute family (zToMip0 + reduceL, the Task-196
//                      storage shape), GL rides FBO quads — the mechanism
//                      is the backend's own, the CONTRACT is one (level 0
//                      IS the z tile)
//   3. THE CULL        culler.run(block) — WG: the compute kernel; GL: the
//                      transform-feedback pass. Per-record verdicts.
//   4. THE COLOR PASS  device.drawVisible — WG: the compact kernel + ONE
//                      drawIndexedIndirect (GPU-driven, zero readbacks);
//                      GL: ONE instanced draw + vertex collapse
//   5. THE DEBUG STRIP device.drawQuad per pyramid level (toggled)
//
// MOBILE-FIRST (Task 198): the canvas is full-bleed (CSS 100%×100%), the
// renderers' own ResizeObservers re-derive the backing store from the live
// CSS size × DPR (capped at 2 — a dpr-3 phone renders 2x, not 3x), the
// projection takes the canvas's real aspect (portrait widens the fov), and
// the WG canvas rides the facade's new MSAA 4x resolve (antialias: true).
import { createDevice } from '../../dist/rune.esm.js?v=198'
import { buildShaders } from './shaders.js?v=198'
import { BOX_VERTS, BOX_INDICES, HIZ_W, HIZ_H, LEVELS } from './scene.js?v=198'

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

  // ── THE BRICKS — one construction syntax ───────────────────────────────
  const sceneHandle = device.scene({
    total: N,
    occluders: K,
    words: sceneWords,
    recordsF32: sceneF32.subarray(INST_OFF),
    flagsWord: FLAGS_OFF,
    recordsWord: INST_OFF,
  })
  const pyr = device.pyramid(HIZ_W, HIZ_H)
  const box = device.geometry(BOX_VERTS, BOX_INDICES)
  const surface = device.surface(SURF_W, SURF_H, { depth: true })

  const S = buildShaders(scene)
  const zPass = device.program({ depth: { test: 'less', write: true }, wg: S.z.wg, gl: S.z.gl })
  const colorPass = device.program({ depth: { test: 'less', write: true }, wg: S.color.wg, gl: S.color.gl })
  const panelPass = device.program({ depth: { test: 'always', write: false }, wg: S.panel.wg, gl: S.panel.gl })
  const culler = device.occlusionCuller(sceneHandle, pyr, {
    wgsl: S.cull.wg.code,
    glsl: S.cull.gl,
    entry: S.cull.wg.entry,
    lanes: S.cull.lanes,
    uniformBytes: S.cull.wg.uniformBytes,
  })

  // ── the packed uniform blocks (one layout per program — the lanes both
  //    backends' shaders agree on; see shaders.js) ─────────────────────────
  const zBlock = new Float32Array(16)
  const cullBlock = new Float32Array(20)
  const colorBlock = new Float32Array(28)
  const panelBlock = new Float32Array(8)

  function targetHeight(targetId) {
    if (targetId === 0 && displayCanvas !== null) return displayCanvas.height
    return SURF_H
  }

  // ── THE FRAME — ONE code path, both backends ────────────────────────────
  function renderTo(targetId, mvp, eye, hizOn, debug) {
    // 1. THE Z PREPASS — the occluders into the pyramid's level-0 tile
    zBlock.set(mvp)
    device.drawInstanced({
      target: pyr.zTarget,
      clear: true,
      program: zPass,
      geometry: box,
      records: sceneHandle,
      instances: K,
      uniforms: zBlock,
      indexCount: 36,
    })
    // 2. THE PYRAMID — the 2×2 MAX reduce chain (the backend's own
    //    mechanism inside the brick — WG: compute; GL: FBO quads)
    pyr.build()
    // 3. THE CULL — the per-record verdict kernel (compute / TF)
    cullBlock.set(mvp)
    cullBlock[16] = hizOn ? 1 : 0
    culler.run(cullBlock)
    // 4. THE COLOR PASS — the whole visible set, GPU-driven (misc.x = the
    //    GL dither's y-mirror height; the WG shader ignores the lane)
    colorBlock.set(mvp)
    colorBlock[16] = targetHeight(targetId)
    colorBlock[20] = LIGHT[0]; colorBlock[21] = LIGHT[1]; colorBlock[22] = LIGHT[2]; colorBlock[23] = 0
    colorBlock[24] = eye[0]; colorBlock[25] = eye[1]; colorBlock[26] = eye[2]; colorBlock[27] = 1
    device.drawVisible({
      target: targetId,
      clear: true,
      program: colorPass,
      geometry: box,
      records: sceneHandle,
      uniforms: colorBlock,
      indexCount: 36,
    })
    // 5. THE DEBUG STRIP — one panel quad per pyramid level (the info lane
    //    carries the level's flat offset + dims — WG reads the storage, GL
    //    clamps its texture fetch)
    if (debug) {
      const offsets = pyr.offsets ?? []
      for (let L = 0; L < LEVELS; L++) {
        const w = 2.0 / LEVELS
        panelBlock[0] = -1 + L * w + 0.01
        panelBlock[1] = -0.97
        panelBlock[2] = -1 + (L + 1) * w - 0.01
        panelBlock[3] = -0.55
        panelBlock[4] = offsets[L] ?? 0
        panelBlock[5] = pyr.dims[L].w
        panelBlock[6] = pyr.dims[L].h
        panelBlock[7] = 0
        device.drawQuad({
          target: targetId,
          clear: false,
          program: panelPass,
          pyramid: pyr,
          level: L,
          uniforms: panelBlock,
        })
      }
    }
    device.submit()
  }

  // ── stats (the brick normalizes: WG args-buffer readback / GL flag sweep)
  function readStats() {
    return device.readCullStats(sceneHandle)
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

  function frame(mvp, eye, hizOn, debug) {
    renderTo(SNAPSHOT ? surface.targetId : 0, mvp, eye, hizOn, debug)
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
      ? `draws: 1 (instanced, vertex-collapse) · TF passes: 1 · ${LEVELS - 1} reduce quads`
      : `draws: 1 (indirect, GPU-driven) · dispatches: 2 (cull + compact) · ${LEVELS - 1} reduce quads`,
    canvas: displayCanvas,
    surface,
    renderTo,
    frame,
    readStats,
    aspect,
    // the GL error drain rides device.submit() (the renderer's frame
    // boundary); WG surfaces through the onGpuError channel — nothing to
    // drain per frame here.
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
