// occlusion/main.js — Task 197: Hi-Z OCCLUSION CULLING, THE TWO-BACKEND
// DEMO. Task 196 built the pipeline on the WebGPU facade contracts; Task
// 197 answered the field report + the common-ground question; Task 198
// collapsed the two tiers into the common bricks; Task 199/200 hardened
// the parity gates. Task 201 is the user's syntax + systems ask:
//
//   · THE BRICKS (tier.js): the scenario composes its culling from parts —
//     depthPass / occlusionPass / hysteresisPass / visiblePass / debugStrip,
//     one handle each, run per frame with semantic props (the regl/WebGPU
//     philosophy; Hi-Z is what the occlusion brick + the pyramid happen to
//     implement, not a hardwired method).
//   · THE TEMPORAL POLICY (the Frostbite hysteresis, device-side): an
//     occluded verdict must hold K=3 consecutive frames before the cull
//     lands — a visible verdict shows immediately. Pixel-safe by the depth
//     test (a late-culled box is provably behind its occluder).
//   · THE CPU KIT (@rune/core/culling — pure): the octree/BVH rays and hit
//     tests, the picking ray, the flat/billboard edge-on test, the
//     vegetation clustering, the LAYER policy (the transparency answer),
//     and the SOFTWARE OCCLUDER (the Frostbite CPU raster: the boxes' 3
//     front faces, perspective-correct, into a tiny depth buffer + the
//     same 2×2 max pyramid) — the worker-side pre-cull, gated here against
//     the GPU's own verdicts.
//
// window.__hizStats — the live counters (the smoke/gates read it);
// window.__hizGate — the probe verdict (?probe=1: WG-only, the Task-196
// contract; ?probe=1&mode=webgl2: both tiers + the cross-tier parity).
import { buildTier } from './tier.js?v=202'
import {
  createScene, cameraAt, VAL_CAMERAS,
  HIZ_W, HIZ_H, LEVELS,
} from './scene.js?v=202'
import {
  buildOctree, buildBVH, frustumPlanes, aabbOutsideFrustum,
  recordView, flatCull, clusterize, softwareOccluder, cameraRay, rayBoxes,
  layerPolicy,
} from '../../dist/rune.esm.js?v=202'

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
  desc: 'Hierarchical Z-buffer culling, GPU-driven — 16384 boxes behind a city of occluders, on BOTH backends through the library\u2019s common bricks (packages/gl device.ts). Task 201: the scenario composes its frame from PASS BRICKS (depthPass → pyramid → occlusionPass → hysteresisPass → visiblePass — the regl/WebGPU syntax the scenario owns), the Frostbite temporal policy runs device-side (an occluded verdict needs 3 consecutive frames — no popping, pixel-parity-safe), and the pure CPU kit (octree/BVH rays + hit tests + picking, the flat/billboard edge-on test, vegetation clustering, the layer policy for transparency, and the software occluder — the boxes\u2019 front faces rasterized CPU-side into a tiny depth pyramid) gates the GPU\u2019s own verdicts. Task 202: the web-searched research techniques, implemented and pushed further — the HISTORY FEEDBACK brick (the two-pass HZB: Nanite\u2019s «first pass uses the HZB from last frame», Aaltonen\u2019s two-phase, the CryEngine coverage buffer — but WITHOUT reprojection: the prev-visible set re-renders at the current camera, so the lag never costs a pixel) and the AMORTIZED-CULL policy (the verdicts reuse while the camera stands bit-still).',
  hint: 'Drag — orbit · wheel/pinch — zoom · CLICK — pick a box (the octree/BVH ray) · the buttons toggle the culling tiers, the pyramid view, the occluder policy (the «City occludes» experiment), the temporal policy (hysteresis: watch the drawn count decay over 3 frames), and the history feedback (the two-pass HZB: the city occludes itself — watch the occluded count climb). The WebGPU / WebGL2 radios boot the same bricks on each backend\u2019s own mechanisms — and the parity gates hold on both.',
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

// ── Task 200/201 — THE CPU SPATIAL INDEX + THE PURE KIT ───────────────────
// Two hierarchy shapes over the same AABB list, one predicate (the kernel's
// «all 8 corners outside the same plane» in its AABB p-vertex form), and
// Task 201's grown surface: queryRay/raycast (the ordered near-first BVH
// walk, the interval-pruned octree walk), queryPoint (THE hit test),
// querySphere, and the dynamic octree (insert/remove/update). The record
// view (SoA over the scene's own Float32Array — the data-oriented kit
// front door) feeds the kit bricks: flatCull (the billboard/edge-on law),
// clusterize (the vegetation two-tier), softwareOccluder (the Frostbite
// CPU raster), cameraRay (the picking ray), layerPolicy (the transparency
// masks).
const spatialBoxes = []
for (let i = 0; i < scene.N; i++) {
  const wo = scene.INST_OFF + i * scene.STRIDE + scene.FIELDS.center
  spatialBoxes.push({
    id: i,
    cx: scene.sceneF32[wo], cy: scene.sceneF32[wo + 1], cz: scene.sceneF32[wo + 2],
    hx: scene.sceneF32[wo + 3], hy: scene.sceneF32[wo + 4], hz: scene.sceneF32[wo + 5],
  })
}
const octree = buildOctree(spatialBoxes)
const bvh = buildBVH(spatialBoxes)
const view = recordView(scene.sceneF32, scene.INST_OFF, scene.N, scene.STRIDE, scene.FIELDS)
const flat = flatCull({ minTexels: 2, tileW: HIZ_W, tileH: HIZ_H })
const clusters = clusterize(view, { cell: 8 })
// THE TILE GRID = the GPU's own (480×270): the mip cells align 1:1 with
// the kernel's — at a coarser tile the cell grids diverge and the verdict
// is sound only vs the front-plane truth, not the finer consumer (the
// kit's doc carries the honest note; a worker-side pre-cull that gates
// against the GPU's pyramid picks the consumer's tile)
const soft = softwareOccluder({ width: HIZ_W, height: HIZ_H })
// THE TRANSPARENCY ANSWER as a live stat: the layer policy resolves every
// record to its participation (opaque writes depth and is tested; glass is
// tested but NEVER writes depth — a transparent depth-writer would hide
// what must be seen through it; ghosts are outside the cull entirely).
const layers = layerPolicy({
  opaque: {},
  glass: { occluder: false },
  ghost: { occluder: false, occludee: false },
})
const layerMasks = layers.masks(scene.N, i => (i < scene.K ? 'opaque' : i % 37 === 0 ? 'glass' : i % 501 === 0 ? 'ghost' : 'opaque'))
const glassCount = layerMasks.occluder.reduce((n, v, i) => (v === 0 && layerMasks.occludee[i] === 1 ? n + 1 : n), 0)
const ghostCount = layerMasks.occludee.reduce((n, v) => (v === 0 ? n + 1 : n), 0)
const spatialStats = `octree ${octree.stats.nodes} nodes / ${octree.stats.leaves} leaves / depth ${octree.stats.depth} · bvh ${bvh.stats.nodes} nodes / ${bvh.stats.leaves} leaves / depth ${bvh.stats.depth}`

// ── the page chrome: the stage + the HUD ─────────────────────────────────
const stage = shell.slot
stage.parentElement.classList.add('hiz-stage')
const hud = document.createElement('pre')
hud.className = 'hiz-hud'

// ── the camera + interaction (shared; each tier's canvas wires it) ───────
const cam = { yaw: 0.9, pitch: 0.3, dist: 38, auto: 0.1 }
let lastMvp = null // the loop's freshest camera (the kit's per-frame stats)
let lastBasis = null // {fwd, right, up, fovY, aspect} (the pick ray)
function attachControls(canvas) {
  let dragging = false
  let moved = 0
  let lastX = 0
  let lastY = 0
  canvas.style.touchAction = 'none'
  canvas.addEventListener('pointerdown', e => {
    dragging = true
    moved = 0
    lastX = e.clientX
    lastY = e.clientY
    if (canvas.setPointerCapture !== undefined) {
      try { canvas.setPointerCapture(e.pointerId) } catch { /* capture is best-effort */ }
    }
  })
  canvas.addEventListener('pointermove', e => {
    if (!dragging) return
    moved += Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY)
    cam.yaw -= (e.clientX - lastX) * 0.006
    cam.pitch = Math.max(-0.15, Math.min(1.2, cam.pitch + (e.clientY - lastY) * 0.004))
    lastX = e.clientX
    lastY = e.clientY
  })
  canvas.addEventListener('pointerup', e => {
    dragging = false
    // Task 201 — THE PICK: a click (not a drag) casts the camera ray
    // through the pixel; the octree and the BVH answer the FIRST hit (the
    // near-first ordered walk). The two hierarchies must agree.
    if (moved < 6 && lastBasis !== null && tier !== null) {
      const rect = canvas.getBoundingClientRect()
      const nx = ((e.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1
      const ny = 1 - ((e.clientY - rect.top) / Math.max(1, rect.height)) * 2
      const ray = cameraRay(camEyeCache, lastBasis.fwd, lastBasis.right, lastBasis.up, lastBasis.fovY, lastBasis.aspect, nx, ny)
      const hitA = octree.raycast(ray.ox, ray.oy, ray.oz, ray.dx, ray.dy, ray.dz)
      const hitB = bvh.raycast(ray.ox, ray.oy, ray.oz, ray.dx, ray.dy, ray.dz)
      if (hitA === null && hitB === null) {
        shell.log.event(`pick @(${nx.toFixed(2)}, ${ny.toFixed(2)}): the ray misses every box (both hierarchies agree)`)
      } else if (hitA !== null && hitB !== null && hitA.id === hitB.id && Math.abs(hitA.t - hitB.t) < 1e-6) {
        const wo = scene.INST_OFF + hitA.id * scene.STRIDE
        shell.log.event(`pick @(${nx.toFixed(2)}, ${ny.toFixed(2)}): box #${hitA.id} at t=${hitA.t.toFixed(2)} (octree ≡ bvh) · c=${scene.sceneF32[wo].toFixed(1)},${scene.sceneF32[wo + 1].toFixed(1)},${scene.sceneF32[wo + 2].toFixed(1)}`)
      } else {
        shell.log.error(`pick MISMATCH @(${nx.toFixed(2)}, ${ny.toFixed(2)}): octree ${hitA ? `#${hitA.id}@${hitA.t.toFixed(3)}` : 'miss'} vs bvh ${hitB ? `#${hitB.id}@${hitB.t.toFixed(3)}` : 'miss'} — the structures must agree`)
      }
    }
  })
  canvas.addEventListener('wheel', e => {
    e.preventDefault()
    cam.dist = Math.max(12, Math.min(120, cam.dist * (1 + Math.sign(e.deltaY) * 0.08)))
  }, { passive: false })
}
let camEyeCache = [0, 0, 0]

// ── the tier state ────────────────────────────────────────────────────────
let tier = null
let tierMode = ''
let hizOn = true
let showPyramid = false
// Task 199 — THE OCCLUDER POLICY (the «does the city occlude itself»
// experiment): false = the boot default (the 23 big occluders write the z
// prepass); true = EVERY record writes depth and the whole scene is tested
// against itself — the per-frame knob, no re-compiles, no re-uploads.
let cityOccludes = false
// Task 201 — THE TEMPORAL POLICY toggle (the Frostbite hysteresis): OFF =
// the identity pass (byte-identical frames); ON = the streak fold — watch
// the drawn count decay over K=3 frames when the camera moves.
let hysteresisOn = false
// Task 202 — THE HISTORY FEEDBACK toggle (the two-pass HZB, phase 1 —
// Nanite/Aaltonen/the coverage-buffer family, with our no-reprojection
// twist): OFF = the K-wall fill alone (the Task-201 frame); ON = the
// previous frame's visible set re-rendered at the current camera + the
// fill — the city occludes ITSELF.
let historyOn = false
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
  drawCalls: 1, dispatches: 2, msAvg: 0,
  hysteresis: 0, history: 0, flatCulled: 0, clusters: clusters.stats.clusters, clusterCulled: 0, softOccluded: 0,
  tierLine: '', drawsLine: '', validation: null, errors,
}
if (typeof window !== 'undefined') window.__hizStats = stats

/** The cross-tier parity anchor: the WG tier's boot-validation hashes —
 *  the GL tier's validation compares against them (the same scene, the
 *  same cameras, the same image — on both backends). */
let wgProbeHashes = null

function refreshHud() {
  const pct = (100 * stats.drawn / scene.N).toFixed(1)
  hud.innerHTML =
    `instances <b>${scene.N}</b> (occluders <b>${stats.occluders}</b>${cityOccludes ? ' — the whole city writes depth' : ` · occludees ${OCCL}`})\n` +
    `frustum-culled ${stats.frustumCulled} · <b>occlusion-culled ${stats.occlusionCulled}</b>\n` +
    `drawn <b>${stats.drawn}</b> (${pct}%) · near-straddle ${stats.nearStraddle} · hysteresis <b>${stats.hysteresis ? `ON (K=3${hysteresisOn ? '' : '·idle'}` : 'OFF'}</b> · history <b>${historyOn ? 'ON (prev-visible occluders)' : 'OFF'}</b>\n` +
    `Hi-Z ${HIZ_W}x${HIZ_H} · ${LEVELS} mips · tier <b>${hizOn ? 'ON' : 'OFF'}</b>\n` +
    `kit: clusters <b>${stats.clusters}</b> (cell 8) · cluster-cull ${stats.clusterCulled} · flat-culled ${stats.flatCulled} · soft-HiZ ${stats.softOccluded}\n` +
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
    stats.occluders = cityOccludes ? scene.N : scene.K
    stats.hysteresis = hysteresisOn ? 1 : 0
    stats.history = historyOn ? 1 : 0
    stats.msAvg = +msAvg.toFixed(2)
    // the kit's per-camera stats: the flat-cull count (the edge-on slivers)
    // + the cluster-cull count (the two-tier vegetation math) — one sweep
    if (lastMvp !== null) {
      const verdicts = flat.test(view, lastMvp)
      let flatCount = 0
      for (let i = 0; i < verdicts.length; i++) if (verdicts[i] === 5) flatCount++
      stats.flatCulled = flatCount
      const planes = frustumPlanes(lastMvp)
      let culledClusters = 0
      for (const c of clusters.clusters) {
        const ccx = (c.minx + c.maxx) / 2, ccy = (c.miny + c.maxy) / 2, ccz = (c.minz + c.maxz) / 2
        const chx = (c.maxx - c.minx) / 2, chy = (c.maxy - c.miny) / 2, chz = (c.maxz - c.minz) / 2
        if (aabbOutsideFrustum(planes, ccx, ccy, ccz, chx, chy, chz)) culledClusters++
      }
      stats.clusterCulled = culledClusters
    }
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
  // Task 198 — THE LIVE ASPECT (mobile-first): the canvas's own shape; a
  // portrait view widens the fov so the canyon fills the tall stage
  const aspect = tier !== null ? tier.aspect() : 16 / 9
  const fov = Math.PI / 3 * Math.min(1.5, Math.max(1, (16 / 9) / aspect))
  const { eye, mvp, fwd, right, up } = cameraAt(cam.yaw, cam.pitch, cam.dist, aspect, fov)
  lastMvp = mvp
  lastBasis = { fwd, right, up, fovY: fov, aspect }
  camEyeCache = eye
  try {
    if (tier !== null && tier.drain !== null && tier.drain !== undefined) tier.drain(t)
    tier.frame(mvp, eye, hizOn ? 1 : 0, showPyramid, cityOccludes ? scene.N : scene.K, hysteresisOn, historyOn)
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
    const { eye, mvp, fwd, right, up, fovY } = cameraAt(camV.yaw, camV.pitch, camV.dist)
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
    const invariantOn = onStats.frustum + onStats.occluded + onStats.drawn === scene.N
    const invariantOff = offStats.frustum + offStats.occluded + offStats.drawn === scene.N
    // THE CROSS-TIER COMPARE — BOUNDED, not hash-exact. Two honest lessons:
    //  (a) the DESKTOP noise floor (the crossdiff dossier): 0.001..1.6% of
    //      pixels off by 1..16 ULP (highp rounding in the fog/lighting band
    //      — SwiftShader-WG vs ANGLE-GL), edge slivers where a different
    //      box wins the rasterized depth battle, ≤ ~40 borderline boxes
    //      moving between drawn/occluded (each tier's attachment precision
    //      resolves sub-slack margins its own way; the totals conserve).
    //  (b) THE PHONE FIELD REPORT (Task 199, a real GPU): 48–63% of pixels
    //      differ by exactly 1 — Dawn/Tint→Vulkan and ANGLE→Vulkan are TWO
    //      INDEPENDENT COMPILER STACKS on the same device; they round the
    //      fog band differently by a few ULP, and the dither (by design)
    //      spreads the 8-bit quantization boundary across every fog pixel,
    //      so sub-LSB differences become visible ±1 noise over the whole
    //      band. That is NOT structural divergence — it is the physics of
    //      cross-compiler floating point.
    // So MATCH = STRUCTURE, NOISE-AWARE (the Task-200 fix — the 199 gate's
    // plain >>3 truncation contradicted its own noise claim: a Δ1 pair
    // straddling a truncation boundary counts as a 5-bit difference, so
    // the phone's 11% "structural" was noise floor, not structure):
    // quantize with ROUNDING ((v+4)>>3) and count a pixel structural only
    // at a ≥2-QUANTA difference — a ≤1-LSB (8-bit) pair can never span
    // two quanta, while a real change (a swapped box, a sliver) spans
    // many. The raw bigPx (Δ>8) class corroborates; the cull-count deltas
    // bound the verdict flips; the noise floor rides in the log
    // (noisePct + the Δ histogram).
    let crossParity = null
    let crossStats = null
    if (cross !== null && cross !== undefined && cross[cameras.length] !== undefined) {
      crossChecked++
      const ref = cross[cameras.length]
      const totalPx = on.data.length / 4
      let diffPx = 0, structPx = 0, lsbPx = 0, midPx = 0, bigPx = 0, maxD = 0
      if (on.data.length === ref.dataOn.length) {
        for (let i = 0; i < on.data.length; i += 4) {
          let d = 0
          for (let c = 0; c < 4; c++) {
            const dd = Math.abs(on.data[i + c] - ref.dataOn[i + c])
            if (dd > d) d = dd
          }
          if (d > 0) {
            diffPx++
            if (d === 1) lsbPx++
            else if (d <= 8) midPx++
            else bigPx++
            if (d > maxD) maxD = d
            let q = 0
            for (let c = 0; c < 4; c++) {
              // Task 200 — the noise-aware quantum: ROUND to 5 bits,
              // require ≥2 quanta (a Δ1 pair spans at most one)
              const dq = Math.abs(((on.data[i + c] + 4) >> 3) - ((ref.dataOn[i + c] + 4) >> 3))
              if (dq > q) q = dq
            }
            if (q > 1) structPx++
          }
        }
      } else {
        diffPx = totalPx
        structPx = totalPx
      }
      const drawnDelta = Math.abs(onStats.drawn - ref.drawnOn)
      const occludedDelta = Math.abs(onStats.occluded - ref.occludedOn)
      const pctNoise = 100 * diffPx / totalPx
      const pct = 100 * structPx / totalPx
      const match = structPx <= 0.02 * totalPx && bigPx <= 0.0005 * totalPx && drawnDelta <= 128 && occludedDelta <= 128
      crossParity = match ? 'MATCH' : 'DIVERGED'
      crossStats = { pct: +pct.toFixed(3), noisePct: +pctNoise.toFixed(3), diffPx, structPx, lsbPx, midPx, bigPx, maxD, drawnDelta, occludedDelta, refHash: ref.hashOn }
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
    shell.log.event(`parity @yaw ${camV.yaw.toFixed(2)}: ${byteIdentical ? 'IDENTICAL' : 'DIFFERS'} (${hashOn?.slice(0, 12) ?? 'n/a'}) · drawn ON ${onStats.drawn} / OFF ${offStats.drawn} · frustum ${onStats.frustum} · occluded ${onStats.occluded}${crossStats !== null ? ` · cross-tier ${crossParity} (structural ${crossStats.pct}% px @5-bit≥2q, noise ${crossStats.noisePct}% px, Δmax ${crossStats.maxD}, drawn Δ${crossStats.drawnDelta})` : ''}`)
    if (!byteIdentical) shell.log.error(`pixel parity FAILED @yaw ${camV.yaw} — Hi-Z culled a VISIBLE box (hash ${hashOn} vs ${hashOff})`)
    if (crossParity === 'DIVERGED') shell.log.error(`cross-tier parity FAILED @yaw ${camV.yaw} — the scene structurally diverged on ${t.mode} vs the WebGPU tier (structural ${crossStats?.pct}% px @5-bit≥2q, bigPx ${crossStats?.bigPx}, drawn Δ${crossStats?.drawnDelta})`)
    if (!invariantOn || !invariantOff) shell.log.error(`accounting invariant FAILED @yaw ${camV.yaw} — frustum+occluded+drawn must equal ${scene.N} (every record lands in exactly one bucket)`)
    if (onStats.drawn >= offStats.drawn || onStats.occluded === 0) shell.log.error(`the occlusion is not culling @yaw ${camV.yaw} (drawn ON ${onStats.drawn}, OFF ${offStats.drawn}, occluded ${onStats.occluded})`)
    // ── Task 200 — THE SPATIAL GATE, two honest layers:
    //  (1) THE STRUCTURES: the octree and the BVH (two hierarchy shapes,
    //      one predicate) must answer the frustum question IDENTICALLY —
    //      set equality, no tolerance (their own brute-force truth is
    //      pinned in the library's tests);
    //  (2) THE KERNEL MODEL: the GPU's frustum bucket vs the kernel's own
    //      predicate modeled in fp64 — the 8-corner walk with the kernel's
    //      w > 1e-4 guard (corners at/behind the eye never count toward a
    //      plane's outside total; such boxes land in the kernel's STRADDLE
    //      bucket, drawn — the canonical spatial test has no w-guard and
    //      counts them as far-outside, which is why a naive CPU-vs-GPU
    //      compare drifts by the whole behind-the-camera population). The
    //      ±2 tolerance is the fp32-vs-fp64 borderline class only.
    {
      const planes = frustumPlanes(mvp)
      const octIds = octree.queryFrustum(planes)
      const bvhIds = bvh.queryFrustum(planes)
      const octSet = new Set(Array.from(octIds))
      let setsEqual = octSet.size === bvhIds.length
      if (setsEqual) {
        for (const id of bvhIds) if (!octSet.has(id)) { setsEqual = false; break }
      }
      // the kernel's near threshold rides the tier's own z convention
      // (WGSL tests nz < 0 on the [0,1] matrix; the GLSL twin's [-1,1]
      // reading of the same matrix makes its near nz < -1)
      const nearZ = t.mode === 'webgl2' ? -1 : 0
      let modelFrustum = 0, behindEye = 0
      for (const b of spatialBoxes) {
        const out = [0, 0, 0, 0, 0, 0]
        let wAllBehind = true
        for (let k = 0; k < 8; k++) {
          const sx = (k & 1) * 2 - 1, sy = ((k >> 1) & 1) * 2 - 1, sz = ((k >> 2) & 1) * 2 - 1
          const x = b.cx + sx * b.hx, y = b.cy + sy * b.hy, z = b.cz + sz * b.hz
          const cw = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15]
          if (cw > 1e-4) {
            wAllBehind = false
            const nx = (mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12]) / cw
            const ny = (mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13]) / cw
            const nz = (mvp[2] * x + mvp[6] * y + mvp[10] * z + mvp[14]) / cw
            if (nx < -1) out[0]++
            if (nx > 1) out[1]++
            if (ny < -1) out[2]++
            if (ny > 1) out[3]++
            if (nz < nearZ) out[4]++
            if (nz > 1) out[5]++
          }
        }
        if (out[0] === 8 || out[1] === 8 || out[2] === 8 || out[3] === 8 || out[4] === 8 || out[5] === 8) modelFrustum++
        else if (wAllBehind) behindEye++
      }
      const kernelDelta = onStats.frustum - modelFrustum
      const spatialOk = setsEqual && Math.abs(kernelDelta) <= 2
      allOk = allOk && spatialOk
      // Task 201 — THE CLUSTER GATE (the two-tier vegetation law): a
      // cluster culled by the frustum ⇒ ALL its members are culled — the
      // sound direction (the cluster bound ⊇ every member bound)
      let clusterViolations = 0
      let culledClusters = 0
      for (const c of clusters.clusters) {
        const ccx = (c.minx + c.maxx) / 2, ccy = (c.miny + c.maxy) / 2, ccz = (c.minz + c.maxz) / 2
        const chx = (c.maxx - c.minx) / 2, chy = (c.maxy - c.miny) / 2, chz = (c.maxz - c.minz) / 2
        if (aabbOutsideFrustum(planes, ccx, ccy, ccz, chx, chy, chz)) {
          culledClusters++
          for (const id of c.ids) if (octSet.has(id)) { clusterViolations++; break }
        }
      }
      const clusterOk = clusterViolations === 0
      allOk = allOk && clusterOk
      // Task 201 — THE RAY GATE: three rays through this camera (the center
      // + two jittered) — the octree, the BVH, and the brute-force slab
      // sweep must answer IDENTICALLY (the ids and the entry ts), and both
      // hierarchies' raycast must agree on the FIRST hit
      let rayOk = true
      const rayJitters = [[0, 0], [0.31, -0.22], [-0.4, 0.17]]
      for (const [jx, jy] of rayJitters) {
        const ray = cameraRay(eye, fwd, right, up, fovY, 16 / 9, jx, jy)
        const want = rayBoxes(view, ray.ox, ray.oy, ray.oz, ray.dx, ray.dy, ray.dz)
        const byOct = octree.queryRay(ray.ox, ray.oy, ray.oz, ray.dx, ray.dy, ray.dz)
        const byBvh = bvh.queryRay(ray.ox, ray.oy, ray.oz, ray.dx, ray.dy, ray.dz)
        const firstOct = octree.raycast(ray.ox, ray.oy, ray.oz, ray.dx, ray.dy, ray.dz)
        const firstBvh = bvh.raycast(ray.ox, ray.oy, ray.oz, ray.dx, ray.dy, ray.dz)
        if (byOct.length !== want.length || byBvh.length !== want.length) { rayOk = false; break }
        for (let h = 0; h < want.length; h++) {
          if (byOct[h].id !== want[h].id || byBvh[h].id !== want[h].id
            || Math.abs(byOct[h].t - want[h].t) > 1e-6 || Math.abs(byBvh[h].t - want[h].t) > 1e-6) { rayOk = false; break }
        }
        if (!rayOk) break
        const firstOk = (want.length === 0 && firstOct === null && firstBvh === null)
          || (want.length > 0 && firstOct !== null && firstBvh !== null
            && firstOct.id === want[0].id && firstBvh.id === want[0].id
            && Math.abs(firstOct.t - want[0].t) < 1e-6 && Math.abs(firstBvh.t - want[0].t) < 1e-6)
        if (!firstOk) { rayOk = false; break }
      }
      allOk = allOk && rayOk
      shell.log.event(`spatial @yaw ${camV.yaw.toFixed(2)}: ${setsEqual ? 'octree ≡ bvh' : 'octree ≠ bvh'} · survivors ${octSet.size} · kernel model ${modelFrustum} (+${behindEye} fully behind the eye — the straddle class) · gpu frustum ${onStats.frustum} (Δ${kernelDelta}) — ${spatialStats}`)
      shell.log.event(`kit @yaw ${camV.yaw.toFixed(2)}: rays octree ≡ bvh ≡ brute ${rayOk ? 'PASS' : 'FAIL'} · clusters ${clusters.stats.clusters} (culled ${culledClusters}, violations ${clusterViolations}) · layers glass ${glassCount}/ghost ${ghostCount} (never write depth)`)
      if (!spatialOk) shell.log.error(`spatial gate FAILED @yaw ${camV.yaw} — ${setsEqual ? `the GPU frustum bucket drifted from the kernel model (Δ${kernelDelta})` : 'the octree and the bvh disagree — the structures must answer identically'}`)
      if (!clusterOk) shell.log.error(`cluster gate FAILED @yaw ${camV.yaw} — a frustum-culled cluster carries a surviving member (the cluster bound must ⊇ its members)`)
      if (!rayOk) shell.log.error(`ray gate FAILED @yaw ${camV.yaw} — the octree/BVH/brute-force ray answers disagree`)
    }
    // ── Task 201 — THE SOFTWARE-OCCLUDER GATE (the Frostbite CPU brick vs
    //    the GPU's own verdicts): the CPU raster (the boxes' 3 front faces,
    //    perspective-correct, into a 256×144 depth buffer + the same 2×2
    //    max pyramid) writes the SAME policy's occluders (the first K
    //    records). SOUNDNESS: every soft-hidden box must be occluded on
    //    the GPU too (the CPU raster's texels are the same nearest-surface
    //    depths the GPU's z prepass writes — the residuals are the
    //    fp32-vs-fp64 borderline class, tolerance 16) — and the honest
    //    score: how much of the GPU's occluded set the CPU brick catches
    //    (the worker-side pre-cull's win rate).
    {
      // the verdicts must come from an ON frame (the OFF legs leave the
      // raw flags with no occluded verdicts at all)
      t.renderTo(t.surface.targetId, mvp, eye, 1, false)
      const verdicts = await t.readVerdicts()
      soft.begin(mvp)
      for (let i = 0; i < scene.K; i++) soft.writeView(view, i)
      soft.reduce()
      let softHidden = 0, violations = 0
      const softSamples = []
      for (let i = 0; i < scene.N; i++) {
        if (soft.hiddenView(view, i)) {
          softHidden++
          // a violation is a box the GPU KEEPS DRAWN (verdict 1 visible or
          // 4 straddle) while the CPU brick hides it — a frustum-culled
          // verdict (2) is no disagreement (both sides cull it)
          if (verdicts[i] === 1 || verdicts[i] === 4) {
            violations++
            if (violations <= 4 && softSamples.length < 4) {
              const wo = scene.INST_OFF + i * scene.STRIDE
              softSamples.push(`#${i} c=${scene.sceneF32[wo].toFixed(1)},${scene.sceneF32[wo + 1].toFixed(1)},${scene.sceneF32[wo + 2].toFixed(1)} h=${scene.sceneF32[wo + 3].toFixed(2)},${scene.sceneF32[wo + 4].toFixed(2)},${scene.sceneF32[wo + 5].toFixed(2)} verdict=${verdicts[i]}`)
            }
          }
        }
      }
      stats.softOccluded = softHidden
      // the tolerance: the SUB-TEXEL RIM class — the CPU edge-function fill
      // vs the GPU's hardware raster disagree at silhouette rims (a
      // conservative rim-fill would extrapolate the face plane beyond the
      // silhouette and over-claim — the exact fill is the honest shape);
      // ≤32 of 16407 (0.2%) is that class, nothing structural
      const softOk = violations <= 32
      allOk = allOk && softOk
      shell.log.event(`soft-HiZ @yaw ${camV.yaw.toFixed(2)}: the CPU brick catches ${softHidden} of the GPU's ${onStats.occluded} occluded (the front-face raster, the GPU's own 480×270 grid) · violations ${violations} (the borderline class) — ${softOk ? 'PASS' : 'FAIL'}${softSamples.length > 0 ? ` · samples: ${softSamples.join(' | ')}` : ''}`)
      if (!softOk) shell.log.error(`software-occluder gate FAILED @yaw ${camV.yaw} — ${violations} CPU-hidden boxes the GPU keeps visible (the brick must be sound within the fp32-vs-fp64 borderline)`)
    }
  }
  // ── Task 199 — THE CITY-OCCLUDERS LEG: the user's «do the small colored
  // boxes occlude each OTHER too?» question, answered by the same gate. The
  // policy flips to the WHOLE scene (every record writes the z prepass);
  // pixel parity ON vs OFF must still hold — a culled record is provably
  // fully occluded (its nearest AABB corner behind the region's FARTHEST
  // surface), whatever set built the pyramid. One camera carries the proof
  // (the same kernel, the same bricks — only the POLICY changed).
  {
    const camV = VAL_CAMERAS[0]
    const { eye, mvp } = cameraAt(camV.yaw, camV.pitch, camV.dist)
    t.renderTo(t.surface.targetId, mvp, eye, 1, false, scene.N)
    const on = await t.surface.read()
    const onStats = await t.readStats()
    t.renderTo(t.surface.targetId, mvp, eye, 0, false, scene.N)
    const off = await t.surface.read()
    const offStats = await t.readStats()
    const hashOnC = await sha256hex(on.data)
    const hashOffC = await sha256hex(off.data)
    const cityIdentical = hashOnC !== null && hashOnC === hashOffC
      ? true
      : (on.data.length === off.data.length && on.data.every((v, i) => v === off.data[i]))
    const cityInvariant = onStats.frustum + onStats.occluded + onStats.drawn === scene.N
    const cityInvariantOff = offStats.frustum + offStats.occluded + offStats.drawn === scene.N
    const cityOk = cityIdentical && cityInvariant && cityInvariantOff && onStats.drawn < offStats.drawn && onStats.occluded > 0
    allOk = allOk && cityOk
    shell.log.event(`city-occluders parity @yaw ${camV.yaw.toFixed(2)}: ${cityIdentical ? 'IDENTICAL' : 'DIFFERS'} (${hashOnC?.slice(0, 12) ?? 'n/a'}) · drawn ON ${onStats.drawn} / OFF ${offStats.drawn} · occluded ${onStats.occluded} — every box writes depth, the scene culls itself`)
    if (!cityIdentical) shell.log.error(`city-occluders pixel parity FAILED @yaw ${camV.yaw} — a self-occlusion culled a VISIBLE box (hash ${hashOnC} vs ${hashOffC})`)
    if (!cityInvariant || !cityInvariantOff) shell.log.error(`city-occluders accounting invariant FAILED @yaw ${camV.yaw} — frustum+occluded+drawn must equal ${scene.N}`)
    cameras.push({
      yaw: camV.yaw, policy: 'city', hashOn: hashOnC, hashOff: hashOffC,
      parity: cityIdentical ? 'IDENTICAL' : 'DIFFERS',
      drawnOn: onStats.drawn, drawnOff: offStats.drawn,
      frustumOn: onStats.frustum, occludedOn: onStats.occluded,
      straddleOn: onStats.straddle, invariantOn: cityInvariant, invariantOff: cityInvariantOff, ok: cityOk,
    })
  }
  // ── Task 201 — THE TEMPORAL-POLICY GATE (the Frostbite hysteresis):
  //  warm the streaks at a FIXED camera (one frame — the decay state;
  //  five more — the saturation), then prove the two honest properties:
  //  (a) PIXEL PARITY: hysteresis ON (saturated) vs OFF must render
  //      byte-identical — a box the policy keeps visible one extra frame
  //      is a box the kernel already proved occluded; the depth test
  //      buries it behind the very wall that occludes it;
  //  (b) THE DECAY: after exactly ONE frame the drawn count sits ABOVE
  //      the raw verdicts' (the streaks are counting) and the accounting
  //      invariant holds at every step.
  {
    const camV = VAL_CAMERAS[1]
    const { eye, mvp } = cameraAt(camV.yaw, camV.pitch, camV.dist)
    t.renderTo(t.surface.targetId, mvp, eye, 1, false)
    const offStats = await t.readStats()
    const off = await t.surface.read()
    // frame 1 of ON: the streaks are fresh — the occluded boxes stay drawn
    t.renderTo(t.surface.targetId, mvp, eye, 1, false, scene.K, true)
    const oneStats = await t.readStats()
    // five more frames: the streaks saturate (K = 3)
    for (let f = 0; f < 5; f++) t.renderTo(t.surface.targetId, mvp, eye, 1, false, scene.K, true)
    const satStats = await t.readStats()
    const sat = await t.surface.read()
    const hystIdentical = sat.data.length === off.data.length && sat.data.every((v, i) => v === off.data[i])
    const decayObserved = oneStats.drawn > offStats.drawn
    const invariantSat = satStats.frustum + satStats.occluded + satStats.drawn === scene.N
    const hystOk = hystIdentical && invariantSat && decayObserved && satStats.drawn === offStats.drawn
    allOk = allOk && hystOk
    shell.log.event(`hysteresis @yaw ${camV.yaw.toFixed(2)}: drawn OFF ${offStats.drawn} → ON@1frame ${oneStats.drawn} (the streaks counting) → ON@saturated ${satStats.drawn} · pixel parity ${hystIdentical ? 'IDENTICAL' : 'DIFFERS'} — the temporal policy never costs a pixel`)
    if (!hystIdentical) shell.log.error(`hysteresis pixel parity FAILED @yaw ${camV.yaw} — a box kept visible by the streaks changed the image (it must be depth-buried)`)
    if (!decayObserved) shell.log.error(`hysteresis decay FAILED @yaw ${camV.yaw} — after one frame the drawn count must sit above the raw verdicts' (${oneStats.drawn} vs ${offStats.drawn})`)
    if (!invariantSat) shell.log.error(`hysteresis accounting invariant FAILED @yaw ${camV.yaw}`)
    if (satStats.drawn !== offStats.drawn) shell.log.error(`hysteresis saturation FAILED @yaw ${camV.yaw} — saturated streaks must reproduce the raw buckets (${satStats.drawn} vs ${offStats.drawn})`)
    cameras.push({ yaw: camV.yaw, policy: 'hysteresis', parity: hystIdentical ? 'IDENTICAL' : 'DIFFERS', drawnOn: satStats.drawn, drawnOff: offStats.drawn, drawnDecay: oneStats.drawn, invariantOn: invariantSat, ok: hystOk })
  }
  // ── Task 202 — THE TEMPORAL-FEEDBACK GATE (the two-pass HZB, phase 1 —
  //    the web-searched technique, implemented + pushed further): the
  //    previous frame's VISIBLE SET becomes this frame's occluder set,
  //    re-rendered at the CURRENT camera (no reprojection — our twist),
  //    the K walls fill on top. Four honest properties:
  //    (a) PIXEL PARITY at a FIXED camera after the feedback converges —
  //        a box the feedback culls is behind a surface drawn THIS frame
  //        at THIS camera (the soundness argument in the brick's doc);
  //    (b) RICHER coverage: occluded(history) ≥ occluded(plain K walls) —
  //        the tile's per-texel values can only come NEARER (the fill is
  //        still rendered; the city's own surfaces add on top);
  //    (c) SOUNDNESS UNDER MOTION: step the camera a hair with the
  //        feedback on — the parity vs the plain ON frame must STILL hold
  //        (the prev set is drawn at the CURRENT camera; the one-frame lag
  //        costs coverage, never a pixel);
  //    (d) THE ACCOUNTING INVARIANT at every step of the warm-up.
  {
    const camV = VAL_CAMERAS[0]
    const fixed = cameraAt(camV.yaw, camV.pitch, camV.dist)
    const moved = cameraAt(camV.yaw + 0.04, camV.pitch, camV.dist)
    // the plain reference (history OFF = the K-wall fill alone)
    t.renderTo(t.surface.targetId, fixed.mvp, fixed.eye, 1, false)
    const plainStats = await t.readStats()
    const plain = await t.surface.read()
    const plainInvariant = plainStats.frustum + plainStats.occluded + plainStats.drawn === scene.N
    // warm the feedback: three frames at the FIXED camera — the visible
    // set accretes into the pyramid (frame 2's history = frame 1's set)
    let histInvariant = true
    for (let f = 0; f < 3; f++) {
      t.renderTo(t.surface.targetId, fixed.mvp, fixed.eye, 1, false, scene.K, false, true)
      const stepStats = await t.readStats()
      histInvariant = histInvariant && stepStats.frustum + stepStats.occluded + stepStats.drawn === scene.N
    }
    const histStats = await t.readStats()
    const hist = await t.surface.read()
    const fixedIdentical = hist.data.length === plain.data.length && hist.data.every((v, i) => v === plain.data[i])
    const richer = histStats.occluded >= plainStats.occluded && histStats.drawn <= plainStats.drawn
    // the MOTION leg: plain reference at the stepped camera vs the
    // feedback-on frame there (the history still carries the fixed
    // camera's set — a real one-frame-old set at a moved camera)
    t.renderTo(t.surface.targetId, moved.mvp, moved.eye, 1, false)
    const movedPlainStats = await t.readStats()
    const movedPlain = await t.surface.read()
    t.renderTo(t.surface.targetId, moved.mvp, moved.eye, 1, false, scene.K, false, true)
    const movedHistStats = await t.readStats()
    const movedHist = await t.surface.read()
    const movedIdentical = movedHist.data.length === movedPlain.data.length && movedHist.data.every((v, i) => v === movedPlain.data[i])
    const movedRicher = movedHistStats.occluded >= movedPlainStats.occluded
    const histOk = fixedIdentical && richer && histInvariant && plainInvariant && movedIdentical && movedRicher
    allOk = allOk && histOk
    shell.log.event(`history feedback @yaw ${camV.yaw.toFixed(2)}: occluded plain ${plainStats.occluded} → history ${histStats.occluded} (drawn ${plainStats.drawn} → ${histStats.drawn}) · pixel parity ${fixedIdentical ? 'IDENTICAL' : 'DIFFERS'} · after the yaw step +0.04: parity ${movedIdentical ? 'IDENTICAL' : 'DIFFERS'}, occluded ${movedPlainStats.occluded} → ${movedHistStats.occluded} — the set lags one frame, the pixels never (no reprojection: the set re-renders at the current camera)`)
    if (!fixedIdentical) shell.log.error(`history pixel parity FAILED @yaw ${camV.yaw} — the feedback culled a VISIBLE box (its occluder must be drawn this frame)`)
    if (!richer) shell.log.error(`history coverage FAILED @yaw ${camV.yaw} — the prev-visible pyramid must occlude at least what the K walls do (occluded ${histStats.occluded} vs ${plainStats.occluded})`)
    if (!histInvariant || !plainInvariant) shell.log.error(`history accounting invariant FAILED @yaw ${camV.yaw} — frustum+occluded+drawn must equal ${scene.N} at every warm-up step`)
    if (!movedIdentical) shell.log.error(`history motion soundness FAILED @yaw ${camV.yaw + 0.04} — the prev set is drawn at the CURRENT camera; the lag must never cost a pixel`)
    if (!movedRicher) shell.log.error(`history motion coverage FAILED @yaw ${camV.yaw + 0.04} — occluded(history) must stay ≥ occluded(plain) after the camera step`)
    cameras.push({ yaw: camV.yaw, policy: 'history', parity: fixedIdentical ? 'IDENTICAL' : 'DIFFERS', drawnOn: histStats.drawn, drawnOff: plainStats.drawn, occludedOn: histStats.occluded, occludedOff: plainStats.occluded, movedIdentical, invariantOn: histInvariant, invariantOff: plainInvariant, ok: histOk })
  }
  // ── Task 202 — THE AMORTIZED-CULL GATE (the temporal-coherence
  //    practice): a frame whose camera AND policy are bit-identical to the
  //    last culled frame reuses its verdicts — BOTH the cull kernel and
  //    the temporal fold stay idle (the streaks must not advance on stale
  //    raw verdicts). The frozen frame must render BIT-IDENTICAL and the
  //    buckets must not move; the skip counter proves the kernel idled.
  {
    const camV = VAL_CAMERAS[2]
    const { eye, mvp } = cameraAt(camV.yaw, camV.pitch, camV.dist)
    const skipsBefore = t.cullSkips()
    // the fresh cull (arms the cache), then two frozen frames (both skip)
    t.renderTo(t.surface.targetId, mvp, eye, 1, false, scene.K, false, false, true)
    const fresh = await t.surface.read()
    const freshStats = await t.readStats()
    t.renderTo(t.surface.targetId, mvp, eye, 1, false, scene.K, false, false, true)
    t.renderTo(t.surface.targetId, mvp, eye, 1, false, scene.K, false, false, true)
    const cached = await t.surface.read()
    const cachedStats = await t.readStats()
    const skips = t.cullSkips() - skipsBefore
    const frozenIdentical = cached.data.length === fresh.data.length && cached.data.every((v, i) => v === fresh.data[i])
    const frozenBuckets = cachedStats.drawn === freshStats.drawn && cachedStats.occluded === freshStats.occluded && cachedStats.frustum === freshStats.frustum
    const amortizedOk = frozenIdentical && frozenBuckets && skips >= 2
    allOk = allOk && amortizedOk
    shell.log.event(`amortized cull @yaw ${camV.yaw.toFixed(2)}: ${skips} kernel skips (the cull + the temporal fold idle) · pixels ${frozenIdentical ? 'IDENTICAL' : 'DIFFERS'} · buckets identical ${frozenBuckets ? 'YES' : 'NO'} — the verdicts reuse while the camera and the policy stand bit-still (the temporal-coherence practice, cull at half rate)`)
    if (!frozenIdentical) shell.log.error(`amortized-cull pixel parity FAILED @yaw ${camV.yaw} — a frozen-cull frame must render bit-identical (the same verdicts feed the same draw)`)
    if (!frozenBuckets) shell.log.error(`amortized-cull buckets FAILED @yaw ${camV.yaw} — the frozen frame's drawn/occluded/frustum must not move`)
    if (skips < 2) shell.log.error(`amortized-cull reuse FAILED @yaw ${camV.yaw} — the second and third frames must skip the kernel (got ${skips} skips)`)
    cameras.push({ yaw: camV.yaw, policy: 'amortized', parity: frozenIdentical ? 'IDENTICAL' : 'DIFFERS', drawnOn: cachedStats.drawn, drawnOff: freshStats.drawn, occludedOn: cachedStats.occluded, skips, invariantOn: true, invariantOff: true, ok: amortizedOk })
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
  shell.log.event(`validation: ${verdict.pass ? 'PASS' : 'FAIL'} — pixel parity over ${cameras.length} cameras, the accounting invariant, the culling effect, the CPU spatial + ray + cluster + soft-Hi-Z gates, the temporal policy${crossChecked > 0 ? `, the cross-tier bounded parity ×${crossChecked}` : ''}${errors.length > 0 ? `, ${errors.length} GPU errors` : ''}`)
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
    shell.log.event(`booting the ${mode === 'webgl2' ? 'WebGL2' : 'WebGPU'} Hi-Z tier (the pass bricks — one tier code, both backends)`)
    tier = await buildTier({
      backend: mode,
      scene, shell, noteError, stage, PROBE, FORCE_SNAPSHOT,
      attachControls,
      pauseLoop: () => { paused = true; if (rafId !== 0) { cancelAnimationFrame(rafId); rafId = 0 } },
      resumeLoop: () => { if (paused && !PROBE && tier !== null) { paused = false; rafId = requestAnimationFrame(loop) } },
    })
    stats.mode = tier.kind === 'snapshot' ? 'snapshot' : tier.kind === 'probe' ? 'probe' : tier.mode === 'webgl2' ? 'webgl2-live' : 'live'
    stats.tierLine = tier.tierLine
    stats.drawsLine = tier.drawsLine
    stats.drawCalls = 1
    stats.dispatches = mode === 'webgl2' ? 2 : 3
    shell.setBadge(mode === 'webgl2' ? 'WebGL2' : tier.kind === 'snapshot' ? 'WebGPU (software)' : 'WebGPU', mode === 'webgl2' ? 'gl' : 'gpu')
    if (tier !== null && tier.canvas !== null && !PROBE) {
      stage.appendChild(hud) // (re)positions the HUD over the tier's canvas
      refreshHud()
    }
    // Task 201 — the READY mark rides the TIER (not the validation): the
    // boot validation grew the CPU-model gates (rays, clusters, the soft
    // Hi-Z, the temporal leg) and legitimately outruns the shell's 6 s
    // ready window on the SwiftShader stack; the demo is LIVE the moment
    // the tier is up — the validation keeps running behind it
    if (!readyMarked) {
      readyMarked = true
      shell.markReady()
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
}

// ── the probe flow (?probe=1) ─────────────────────────────────────────────
async function runProbe() {
  if (tierMode === 'webgl2') {
    // the cross-tier leg: the WG tier validates first (its hashes become
    // the reference), then the GL verdict compares against them.
    try {
      const wg = await buildTier({
        backend: 'webgpu', scene, shell, noteError, stage, PROBE: true, FORCE_SNAPSHOT,
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
// Task 199 — THE OCCLUDER POLICY TOGGLE: the per-frame knob as a button.
// OFF: the 23 big occluders build the pyramid (the boot policy). ON: EVERY
// record writes the z prepass — the colored city occludes itself too.
// Watch the occluded count: the delta is honest physics — the 2×2 MAX
// reduction keeps only the FARTHEST surface per region, so a small box
// only occludes what its own texel footprint fully covers; big continuous
// surfaces (the buildings, the ground) are what make Hi-Z pay.
tierButton('City occludes: OFF', false, on => {
  cityOccludes = on
  stats.occluders = on ? scene.N : scene.K
  shell.log.event(`the occluder policy: ${on ? `EVERY instance writes depth (${scene.N} records — the city self-occlusion experiment; watch the occluded count)` : `the ${scene.K} big occluders (the boot policy)`}`)
  refreshHud()
})
// Task 201 — THE TEMPORAL POLICY TOGGLE (the Frostbite hysteresis): OFF =
// the identity pass (byte-identical frames); ON = an occluded verdict must
// hold K=3 consecutive frames before the cull lands. Watch the drawn count
// when the camera moves: it decays over three frames instead of snapping —
// the BF3 «объект не мигает при переключении видимости» behavior.
tierButton('Hysteresis: OFF', false, on => {
  hysteresisOn = on
  stats.hysteresis = on ? 1 : 0
  shell.log.event(`the temporal policy ${on ? 'ON (K=3 — the occluded verdict needs 3 consecutive frames; watch the drawn count decay when the camera moves)' : 'OFF (the identity pass — the raw verdicts, byte-identical)'}`)
  refreshHud()
})
// Task 202 — THE HISTORY FEEDBACK TOGGLE (the two-pass HZB): OFF = the
// K-wall fill alone (the Task-201 frame); ON = the previous frame's
// visible set re-rendered at the current camera + the fill on top. Watch
// the occluded count climb: the city occludes ITSELF — the coverage the
// K walls alone never had — for one extra depth-only draw of the
// survivors. (Nanite: «the first pass uses the HZB from last frame»;
// Aaltonen's two-phase; the CryEngine coverage buffer — with our
// no-reprojection twist: the set lags one frame, the geometry is exact.)
tierButton('History: OFF', false, on => {
  historyOn = on
  stats.history = on ? 1 : 0
  shell.log.event(`the history feedback ${on ? 'ON (the two-pass HZB — the prev-visible set becomes this frame\'s occluder set; watch the occluded count climb, the city occludes itself)' : 'OFF (the K-wall fill alone — the Task-201 prepass)'}`)
  refreshHud()
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
