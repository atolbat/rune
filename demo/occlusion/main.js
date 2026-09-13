// occlusion/main.js — Task 197: Hi-Z OCCLUSION CULLING, THE TWO-BACKEND
// DEMO. Task 196 built the pipeline on the WebGPU facade contracts; Task
// 197 answers the field report + the common-ground question:
//
//   THE FIELD REPORT (the 197a hotfix): on a REAL GPU (a phone) the stage
//   was BLACK with a live log — the WG tier presented into an offscreen
//   bootCanvas while the visible canvas never received a pixel; every
//   container gate ran snapshot mode (software adapters) or probe mode
//   (no canvas), so the live path had never been SEEN. Fixed: the
//   renderer's own canvas goes on the stage (wgTier.js), boot failures
//   are LOUD (a try/catch around the boot validation + window error/
//   unhandledrejection hooks into the demo log — the diagnostic channel
//   the field report was read through).
//
//   THE COMMON GROUND: the shell's WebGL2 toggle is no longer an honest
//   refusal — the SAME scene, cameras and gates run on a WebGL2 tier
//   (glTier.js) built on the library's own GL contracts (transform
//   feedback as the compute substitute, r32f data textures, float depth
//   targets — the Task 197 library growth). The pixel-parity gate runs
//   per tier (Hi-Z ON vs OFF) AND across tiers (the WG hashes vs the GL
//   hashes — the same scene must render the same image on both backends).
//
// window.__hizStats — the live counters (the smoke/gates read it);
// window.__hizGate — the probe verdict (?probe=1: WG-only, the Task-196
// contract; ?probe=1&mode=webgl2: both tiers + the cross-tier parity).
import { buildWgTier } from './wgTier.js?v=197'
import { buildGlTier } from './glTier.js?v=197'
import {
  createScene, cameraAt, VAL_CAMERAS,
  HIZ_W, HIZ_H, LEVELS,
} from './scene.js?v=197'

const PARAMS = new URLSearchParams(typeof location !== 'undefined' ? location.search : '')
const PROBE = PARAMS.has('probe')
const FORCE_SNAPSHOT = PARAMS.has('snapshot')
const OCCL = Math.max(256, Math.min(65536, Number(PARAMS.get('n')) || 16384))
const MODE_PARAM = PARAMS.get('mode')

// ── the demo shell ────────────────────────────────────────────────────────
// the late-bound pause/resume controller (the shell reads its callbacks
// from the mount options; the loop only exists after a successful boot)
const democtl = { pause() {}, resume() {} }
const shell = window.RuneDemoShell.mount({
  layout: 'page',
  title: 'Hi-Z occlusion culling',
  desc: 'Hierarchical Z-buffer culling, GPU-driven: a depth prepass, a reduced-Z pyramid, a cull pass that decides visibility, then the visible set — the whole rune facade contract, 16384 boxes behind a city of occluders, on BOTH backends: WebGPU (compute + indirect draws) and WebGL2 (a FBO pyramid + a transform-feedback cull + a vertex-collapse draw).',
  hint: 'Drag — orbit · wheel — zoom · the buttons toggle the culling tiers and the pyramid view. The WebGPU / WebGL2 radios boot the same Hi-Z on each backend\u2019s own contracts — and the parity gates hold on both.',
  defaults: { mode: MODE_PARAM === 'webgl2' ? 'webgl2' : 'webgpu' },
  onPause() { democtl.pause() },
  onResume() { democtl.resume() },
  onMode(mode) {
    const next = mode === 'webgl2' ? 'webgl2' : 'webgpu'
    void bootTier(next)
  },
})

const errors = []
function noteError(message) {
  errors.push(message)
  shell.log.error(message)
}

// Task 197a — THE LOUD FAILURE CHANNELS: an uncaught error or an unhandled
// rejection lands in the demo log (the exportable diagnostic channel). The
// field report's silent module death (buttons alive, canvas black, three
// log entries, nothing else) must never happen again: whatever kills the
// boot now NAMES itself.
if (typeof window !== 'undefined') {
  window.addEventListener('error', e => {
    if (e && typeof e.message === 'string' && e.message.length > 0) noteError(`uncaught: ${e.message}`)
  })
  window.addEventListener('unhandledrejection', e => {
    const r = e && e.reason !== undefined ? e.reason : 'unknown'
    noteError(`unhandled rejection: ${r instanceof Error ? r.message : String(r)}`)
  })
}

// ── the shared scene (identical boxes on both tiers — the cross-tier
//    pixel-parity gate depends on it) ──────────────────────────────────────
const scene = createScene(OCCL)

// ── the page chrome: the stage + the HUD ─────────────────────────────────
const stage = shell.slot
stage.parentElement.classList.add('hiz-stage')
const hud = document.createElement('pre')
hud.className = 'hiz-hud'

// ── the camera + interaction (shared; each tier's canvas wires it) ───────
const cam = { yaw: 0.9, pitch: 0.3, dist: 38, auto: 0.1 }
function attachControls(canvas) {
  let dragging = false
  let lastX = 0
  let lastY = 0
  canvas.style.touchAction = 'none'
  canvas.addEventListener('pointerdown', e => {
    dragging = true
    lastX = e.clientX
    lastY = e.clientY
    if (canvas.setPointerCapture !== undefined) {
      try { canvas.setPointerCapture(e.pointerId) } catch { /* capture is best-effort */ }
    }
  })
  canvas.addEventListener('pointermove', e => {
    if (!dragging) return
    cam.yaw -= (e.clientX - lastX) * 0.006
    cam.pitch = Math.max(-0.15, Math.min(1.2, cam.pitch + (e.clientY - lastY) * 0.004))
    lastX = e.clientX
    lastY = e.clientY
  })
  canvas.addEventListener('pointerup', () => { dragging = false })
  canvas.addEventListener('wheel', e => {
    e.preventDefault()
    cam.dist = Math.max(12, Math.min(120, cam.dist * (1 + Math.sign(e.deltaY) * 0.08)))
  }, { passive: false })
}

// ── the tier state ────────────────────────────────────────────────────────
let tier = null
let tierMode = ''
let hizOn = true
let showPyramid = false
let paused = false
let rafId = 0
let frameIndex = 0
let lastT = 0
let msAvg = 0
let readyMarked = false
let booting = false

const stats = {
  mode: 'boot', total: scene.N, occluders: scene.K, occludees: OCCL,
  hizW: HIZ_W, hizH: HIZ_H, levels: LEVELS, hizOn: 1,
  frustumCulled: 0, occlusionCulled: 0, drawn: 0, nearStraddle: 0,
  drawCalls: 2, dispatches: 2 + LEVELS, msAvg: 0,
  tierLine: '', drawsLine: '', validation: null, errors,
}
if (typeof window !== 'undefined') window.__hizStats = stats

/** The cross-tier parity anchor: the WG tier's boot-validation hashes —
 *  the GL tier's validation compares against them (the same scene, the
 *  same cameras, the same image — on both backends). */
let wgProbeHashes = null

function refreshHud() {
  const pct = (100 * stats.drawn / OCCL).toFixed(1)
  hud.innerHTML =
    `instances <b>${scene.N}</b> (occluders ${scene.K} · occludees ${OCCL})\n` +
    `frustum-culled ${stats.frustumCulled} · <b>occlusion-culled ${stats.occlusionCulled}</b>\n` +
    `drawn <b>${stats.drawn}</b> (${pct}%) · near-straddle ${stats.nearStraddle}\n` +
    `Hi-Z ${HIZ_W}x${HIZ_H} · ${LEVELS} mips · tier <b>${hizOn ? 'ON' : 'OFF'}</b>\n` +
    `${tier !== null ? tier.drawsLine : ''}\n` +
    `${tier !== null ? tier.tierLine : ''}\n` +
    `frame ${msAvg.toFixed(1)} ms CPU · ${stats.mode}`
}

async function maybeReadStats() {
  if (frameIndex % 12 !== 0 && frameIndex > 2) return
  try {
    const s = await tier.readStats()
    stats.frustumCulled = s.frustum
    stats.occlusionCulled = s.occluded
    stats.drawn = s.drawn
    stats.nearStraddle = s.straddle
    stats.hizOn = hizOn ? 1 : 0
    stats.msAvg = +msAvg.toFixed(2)
    refreshHud()
  } catch { /* a lost device surfaces through the error channels */ }
}

function loop(t) {
  rafId = requestAnimationFrame(loop)
  if (lastT > 0) {
    const dt = t - lastT
    if (dt < 250) msAvg = msAvg * 0.95 + dt * 0.05
  }
  lastT = t
  frameIndex++
  cam.yaw += cam.auto * 0.016
  const { eye, mvp } = cameraAt(cam.yaw, cam.pitch, cam.dist)
  try {
    if (tier !== null && tier.drain !== null && tier.drain !== undefined) tier.drain(t)
    tier.frame(mvp, eye, hizOn ? 1 : 0, showPyramid)
  } catch (e) {
    noteError(`frame failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  void maybeReadStats()
}

// ── the shared parity gate: Hi-Z ON vs OFF must render IDENTICAL pixels ──
async function sha256hex(bytes) {
  const subtle = typeof crypto !== 'undefined' && crypto.subtle !== undefined ? crypto.subtle : null
  if (subtle === null) return null // the page still byte-compares
  const digest = await subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

async function validate(t = tier, cross = t.mode === 'webgpu' ? null : wgProbeHashes) {
  const cameras = []
  const anchor = t.mode === 'webgpu' ? [] : null
  let allOk = true
  let crossOk = true
  let crossChecked = 0
  for (const camV of VAL_CAMERAS) {
    const { eye, mvp } = cameraAt(camV.yaw, camV.pitch, camV.dist)
    t.renderTo(t.surface.targetId, mvp, eye, 1, false)
    const on = await t.surface.read()
    const onStats = await t.readStats()
    t.renderTo(t.surface.targetId, mvp, eye, 0, false)
    const off = await t.surface.read()
    const offStats = await t.readStats()
    const hashOn = await sha256hex(on.data)
    const hashOff = await sha256hex(off.data)
    const byteIdentical = hashOn !== null && hashOn === hashOff
      ? true
      : (on.data.length === off.data.length && on.data.every((v, i) => v === off.data[i]))
    const invariantOn = onStats.frustum + onStats.occluded + onStats.drawn === OCCL
    const invariantOff = offStats.frustum + offStats.occluded + offStats.drawn === OCCL
    // THE CROSS-TIER COMPARE — BOUNDED, not hash-exact. The measured
    // difference class between the backends (the crossdiff dossier):
    // 0.001..0.65% of pixels off by 1..16 ULP (highp-float rounding in the
    // fog/lighting band — SwiftShader-WG vs ANGLE-GL), plus isolated
    // edge-sliver pixels where a different box wins the rasterized depth
    // battle, plus ≤ ~40 borderline boxes moving between drawn/occluded
    // (each tier's own attachment precision — depth24plus vs 32f — resolves
    // sub-slack margins its own way; the TOTALS conserve). An exact
    // cross-backend hash would gate on rounding luck, not structure — so
    // MATCH means: structure-level equality within measured bounds ×3.
    let crossParity = null
    let crossStats = null
    if (cross !== null && cross !== undefined && cross[cameras.length] !== undefined) {
      crossChecked++
      const ref = cross[cameras.length]
      const totalPx = on.data.length / 4
      let diffPx = 0, bigPx = 0, maxD = 0
      if (on.data.length === ref.dataOn.length) {
        for (let i = 0; i < on.data.length; i += 4) {
          let d = 0
          for (let c = 0; c < 4; c++) {
            const dd = Math.abs(on.data[i + c] - ref.dataOn[i + c])
            if (dd > d) d = dd
          }
          if (d > 0) { diffPx++; if (d > 8) bigPx++; if (d > maxD) maxD = d }
        }
      } else {
        diffPx = totalPx
      }
      const drawnDelta = Math.abs(onStats.drawn - ref.drawnOn)
      const occludedDelta = Math.abs(onStats.occluded - ref.occludedOn)
      const pct = 100 * diffPx / totalPx
      const match = diffPx <= 0.02 * totalPx && bigPx <= 0.0005 * totalPx && drawnDelta <= 128 && occludedDelta <= 128
      crossParity = match ? 'MATCH' : 'DIVERGED'
      crossStats = { pct: +pct.toFixed(3), diffPx, bigPx, maxD, drawnDelta, occludedDelta, refHash: ref.hashOn }
      if (!match) crossOk = false
    }
    const ok = byteIdentical && invariantOn && invariantOff && onStats.drawn < offStats.drawn && onStats.occluded > 0
    allOk = allOk && ok
    if (anchor !== null) {
      anchor.push({ hashOn, hashOff, dataOn: on.data, dataOff: off.data, drawnOn: onStats.drawn, drawnOff: offStats.drawn, occludedOn: onStats.occluded, occludedOff: offStats.occluded })
    }
    cameras.push({
      yaw: camV.yaw, hashOn, hashOff, parity: byteIdentical ? 'IDENTICAL' : 'DIFFERS', crossParity, crossStats,
      drawnOn: onStats.drawn, drawnOff: offStats.drawn,
      frustumOn: onStats.frustum, frustumOff: offStats.frustum,
      occludedOn: onStats.occluded, occludedOff: offStats.occluded,
      straddleOn: onStats.straddle, invariantOn, invariantOff, ok,
    })
    shell.log.event(`parity @yaw ${camV.yaw.toFixed(2)}: ${byteIdentical ? 'IDENTICAL' : 'DIFFERS'} (${hashOn?.slice(0, 12) ?? 'n/a'}) · drawn ON ${onStats.drawn} / OFF ${offStats.drawn} · frustum ${onStats.frustum} · occluded ${onStats.occluded}${crossStats !== null ? ` · cross-tier ${crossParity} (${crossStats.pct}% px, Δmax ${crossStats.maxD}, drawn Δ${crossStats.drawnDelta})` : ''}`)
    if (!byteIdentical) shell.log.error(`pixel parity FAILED @yaw ${camV.yaw} — Hi-Z culled a VISIBLE box (hash ${hashOn} vs ${hashOff})`)
    if (crossParity === 'DIVERGED') shell.log.error(`cross-tier parity FAILED @yaw ${camV.yaw} — the same scene structurally diverged on ${t.mode} vs the WebGPU tier (${JSON.stringify(crossStats)})`)
    if (!invariantOn || !invariantOff) shell.log.error(`accounting invariant FAILED @yaw ${camV.yaw} — frustum+occluded+drawn must equal ${OCCL}`)
    if (onStats.drawn >= offStats.drawn || onStats.occluded === 0) shell.log.error(`the occlusion is not culling @yaw ${camV.yaw} (drawn ON ${onStats.drawn}, OFF ${offStats.drawn}, occluded ${onStats.occluded})`)
  }
  const verdict = { pass: allOk && crossOk && errors.length === 0, tier: t.mode, cameras, crossChecked, errors: errors.length }
  stats.validation = verdict
  if (anchor !== null) wgProbeHashes = anchor
  // the GL tier's error drain: the renderer's frame boundary reads the GL
  // error queue — a validation leg must not leave pending errors unseen
  // (the 1-frame lag of the loop's drain is fine live; here it would eat
  // the LAST leg's errors)
  if (t.drain !== null && t.drain !== undefined) {
    try { t.drain(performance.now()) } catch { /* the drain itself is best-effort */ }
  }
  shell.log.event(`validation: ${verdict.pass ? 'PASS' : 'FAIL'} — pixel parity over ${cameras.length} cameras, the accounting invariant, the culling effect${crossChecked > 0 ? `, the cross-tier bounded parity ×${crossChecked}` : ''}${errors.length > 0 ? `, ${errors.length} GPU errors` : ''}`)
  return verdict
}

// ── the tier lifecycle ────────────────────────────────────────────────────
async function teardownTier() {
  if (rafId !== 0) { cancelAnimationFrame(rafId); rafId = 0 }
  paused = false
  if (tier !== null) {
    try { tier.dispose() } catch { /* already dead */ }
    tier = null
  }
}

async function bootTier(mode) {
  if (booting) return
  if (tier !== null && tierMode === mode) return
  booting = true
  const wanted = mode
  try {
    await teardownTier()
    tierMode = mode
    stats.mode = mode === 'webgl2' ? (PROBE ? 'webgl2-probe' : 'webgl2-live') : (PROBE ? 'probe' : 'boot')
    shell.log.event(`booting the ${mode === 'webgl2' ? 'WebGL2' : 'WebGPU'} Hi-Z tier`)
    const build = mode === 'webgl2'
      ? buildGlTier
      : buildWgTier
    tier = await build({
      scene, shell, noteError, stage, PROBE, FORCE_SNAPSHOT,
      attachControls,
      pauseLoop: () => { paused = true; if (rafId !== 0) { cancelAnimationFrame(rafId); rafId = 0 } },
      resumeLoop: () => { if (paused && !PROBE && tier !== null) { paused = false; rafId = requestAnimationFrame(loop) } },
    })
    stats.mode = tier.kind === 'snapshot' ? 'snapshot' : tier.kind === 'probe' ? 'probe' : tier.mode === 'webgl2' ? 'webgl2-live' : 'live'
    stats.tierLine = tier.tierLine
    stats.drawsLine = tier.drawsLine
    stats.drawCalls = mode === 'webgl2' ? 2 + (LEVELS - 1) : 2
    stats.dispatches = mode === 'webgl2' ? 1 : 2 + LEVELS
    shell.setBadge(mode === 'webgl2' ? 'WebGL2' : tier.kind === 'snapshot' ? 'WebGPU (software)' : 'WebGPU', mode === 'webgl2' ? 'gl' : 'gpu')
    if (tier !== null && tier.canvas !== null && !PROBE) {
      stage.appendChild(hud) // (re)positions the HUD over the tier's canvas
      refreshHud()
    }
    if (PROBE) {
      await runProbe()
    } else {
      // Task 197a — the boot validation is GUARDED: a validation crash
      // must not silently kill the module (the field report's silent
      // death class) — the failure lands in the log, the loop still runs.
      try {
        const v = await validate()
        void v
        // the anchor (the WG tier's hashes + bytes) is captured inside
        // validate() itself — the GL tier's validation compares against it
      } catch (e) {
        noteError(`boot validation crashed: ${e instanceof Error ? e.message : String(e)} — the live loop continues`)
      }
      rafId = requestAnimationFrame(loop)
    }
  } catch (error) {
    tier = null
    shell.setBadge(`${wanted === 'webgl2' ? 'WebGL2' : 'WebGPU'} unavailable`, 'err')
    shell.log.error(`${wanted} boot failed: ${error instanceof Error ? error.message : String(error)}`)
    // MUTATE, never replace: __hizStats must stay the SAME object — the
    // smoke/gate channels hold the reference (a replacement copy went
    // stale while the fallback tier kept writing the original — the gate
    // then waits on a dead object forever).
    if (typeof window !== 'undefined') {
      stats.mode = `no-${wanted}`
      stats.validation = null
      // the stack rides the bootFail — a bare String(error) loses the
      // exact line; the field report channel needs it
      if (PROBE) window.__hizGate = { pass: false, bootFail: error instanceof Error ? String(error.stack ?? error) : String(error), tier: wanted, errors: 1 }
    }
    // the graceful degrade: a refused WebGL2 tier falls back to WebGPU
    // (the same Hi-Z, the other backend) — the page never ends up blank.
    if (wanted === 'webgl2') {
      shell.log.info('falling back to the WebGPU tier — the same Hi-Z on the other backend')
      booting = false
      await bootTier('webgpu')
      return
    }
  } finally {
    booting = false
  }
  if (!readyMarked) {
    readyMarked = true
    shell.markReady()
  }
}

// ── the probe flow (?probe=1) ─────────────────────────────────────────────
async function runProbe() {
  if (tierMode === 'webgl2') {
    // the cross-tier leg: the WG tier validates first (its hashes become
    // the reference), then the GL verdict compares against them.
    try {
      const wg = await buildWgTier({
        scene, shell, noteError, stage, PROBE: true, FORCE_SNAPSHOT,
        attachControls, pauseLoop: () => {}, resumeLoop: () => {},
      })
      const v = await validate(wg, null)
      void v
      // wgProbeHashes (the anchor: hashes + BYTES + per-camera stats) is
      // set inside validate() itself — v.cameras is the lean verdict view
      try { wg.dispose() } catch { /* dead already */ }
      shell.log.event(`cross-tier anchor: ${wgProbeHashes !== null ? wgProbeHashes.length : 0} WG cameras captured (${(wgProbeHashes ?? []).map(c => String(c.hashOn).slice(0, 8)).join(' ')})`)
    } catch (e) {
      noteError(`the cross-tier WG leg failed: ${e instanceof Error ? e.message : String(e)} — the GL verdict runs without the anchor`)
      wgProbeHashes = null
    }
  }
  const verdict = tierMode === 'webgl2'
    ? await validate(tier, wgProbeHashes)
    : await validate(tier, null)
  window.__hizGate = { ...verdict, stats: { ...stats } }
  shell.log.event(`probe gate: ${verdict.pass ? 'PASS' : 'FAIL'} (window.__hizGate)`)
}

// ── the controls ──────────────────────────────────────────────────────────
const controls = document.createElement('div')
controls.className = 'hiz-controls'
const toolbar = document.querySelector('.rd-toolbar')
if (toolbar !== null) toolbar.appendChild(controls)
function tierButton(label, pressed, onToggle) {
  const b = document.createElement('button')
  b.type = 'button'
  b.textContent = label
  b.setAttribute('aria-pressed', String(pressed))
  b.addEventListener('click', () => {
    const next = b.getAttribute('aria-pressed') !== 'true'
    b.setAttribute('aria-pressed', String(next))
    onToggle(next)
  })
  controls.appendChild(b)
  return b
}
tierButton('Hi-Z culling: ON', true, on => {
  hizOn = on
  shell.log.event(`Hi-Z tier ${on ? 'ON (frustum + occlusion)' : 'OFF (frustum only)'} — watch the drawn count`)
  refreshHud()
})
tierButton('Pyramid view: OFF', false, on => {
  showPyramid = on
  shell.log.event(`the Hi-Z pyramid debug strip ${on ? 'ON' : 'OFF'} — ${LEVELS} mip levels, bright = near`)
})
const valButton = document.createElement('button')
valButton.type = 'button'
valButton.textContent = 'Validate pixel parity'
valButton.addEventListener('click', () => {
  if (paused || tier === null) return
  paused = true
  if (rafId !== 0) { cancelAnimationFrame(rafId); rafId = 0 }
  valButton.textContent = 'Validating…'
  validate(tier, tier.mode === 'webgpu' ? null : wgProbeHashes).then(verdict => {
    valButton.textContent = verdict.pass ? 'Validate pixel parity — PASS' : 'Validate pixel parity — FAIL'
    setTimeout(() => { valButton.textContent = 'Validate pixel parity' }, 4000)
  }).catch(e => {
    noteError(`validation crashed: ${e instanceof Error ? e.message : String(e)}`)
    valButton.textContent = 'Validate pixel parity'
  }).finally(() => {
    paused = false
    if (!PROBE && tier !== null) rafId = requestAnimationFrame(loop)
  })
})
controls.appendChild(valButton)

// the shell's pause/resume — the late-bound controller above
democtl.pause = () => {
  paused = true
  if (rafId !== 0) { cancelAnimationFrame(rafId); rafId = 0 }
}
democtl.resume = () => {
  if (paused && !PROBE && tier !== null) {
    paused = false
    rafId = requestAnimationFrame(loop)
  }
}

// ── boot: the URL mode wins (?mode=webgl2 — the smoke/probe channel) ──────
if (MODE_PARAM === 'webgl2') {
  const radio = document.querySelector('input[name="rd-mode"][value="webgl2"]')
  if (radio !== null) radio.checked = true
}
await bootTier(MODE_PARAM === 'webgl2' ? 'webgl2' : 'webgpu')
