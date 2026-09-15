/**
 * scripts/task218-local.mjs — the LOCAL gate for Task 218 (THE SECOND
 * FIELD REPORT: «не работает небо и террейн на вебгпу, на вебгл норм; в
 * вебгл боксы мерцают то исчезая то появляясь; окклюжн с террейном не
 * дружит» — the WG live-canvas death + the hysteresis flicker).
 *
 *   · THE VALIDATION LEGS (both backends): the 217 legs verbatim (the
 *     14 autopilot laws, the boot, the terrain passes, the scale hook,
 *     the loop, zero errors) + THE K WIRING LAW — the tier runs the
 *     flicker cure's hysteresis K=24 (the report's blinking boxes:
 *     silhouette-edge occluded bursts up to ~23 frames blew through
 *     every K ≤ 15).
 *
 *   · THE MOBILE LEGS (both backends, ?bare, touch emulation, portrait
 *     390×780 @3x): the 217 laws verbatim — the fullscreen canvas, the
 *     sky, the terrain, the joystick trio, the look, the jump.
 *
 *   · THE FALLBACK LEG (the round's own law): ?mode=webgpu&live=1 — the
 *     container's documented present-death (the WG device dies silently
 *     right after the first canvas present — THE USER'S BLACK-SCREEN
 *     CLASS) must be CAUGHT by the watchdog and walked down the chain
 *     webgpu/live → webgpu/snapshot → webgl2, ending with a LIVING GL
 *     canvas (pixels, drawn, the loop) — the black screen self-heals.
 *
 *   · THE FLICKER EVIDENCE LEG (report): the verdict oscilloscope on the
 *     GL leg — the raw verdicts' flip counts + occluded run lengths,
 *     before/after the K=24 cure in the log's own words (the raw rate is
 *     K-independent by design; the DRAWN set is what K masks).
 */
import { chromium } from 'playwright'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})

let failures = 0
function check(name, ok, detail = '') {
  console.log(`[218] ${name}: ${ok ? 'PASS' : 'FAIL'}${detail ? ` · ${detail}` : ''}`)
  if (!ok) failures++
}

function serve(port) {
  return Bun.serve({
    port,
    async fetch(request) {
      const url = new URL(request.url)
      let pathname = decodeURIComponent(url.pathname)
      if (pathname.endsWith('/')) pathname += 'index.html'
      const file = Bun.file(join(root, pathname))
      if (!(await file.exists())) return new Response('not found', { status: 404 })
      const ext = pathname.slice(pathname.lastIndexOf('.'))
      return new Response(file, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
    },
  })
}

/** Decodes a screenshot's brightness IN-PAGE (img → 2d canvas → stats). */
// (kept above the legs — the mobile legs decode the shot in-page)
async function brightness(page, shot) {
  return await page.evaluate(async b64 => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const w = img.width, h = img.height
    const stat = (x0, y0, x1, y1) => {
      const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data
      let sum = 0, dark = 0, n = 0
      for (let k = 0; k < d.length; k += 16) {
        const v = (d[k] + d[k + 1] + d[k + 2]) / 3
        sum += v; if (v < 32) dark++; n++
      }
      return { mean: sum / n, dark: dark / n }
    }
    return { top: stat(0, 0, w, Math.floor(h * 0.3)), bottom: stat(0, Math.floor(h * 0.5), w, h) }
  }, shot.toString('base64'))
}

/** Dispatches a synthetic touch PointerEvent on an element. */
async function touch(page, type, x, y, el = '#hiz-canvas') {
  await page.evaluate(([t, px, py, sel]) => {
    const el = document.querySelector(sel)
    el.dispatchEvent(new PointerEvent(t, {
      pointerId: 7, pointerType: 'touch', isPrimary: true,
      clientX: px, clientY: py, bubbles: true, cancelable: true,
    }))
  }, [type, x, y, el])
}

async function validationLeg(mode) {
  console.log(`[218] validation leg ${mode}: goto…`)
  const server = serve(8942)
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 200)}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`) })
  await page.goto(`http://localhost:8942/demo/walker/?crowd=1500${mode === 'webgl2' ? '&mode=webgl2' : ''}`, { waitUntil: 'networkidle', timeout: 90_000 })
  await page.waitForFunction(() => window.__walker && window.__walker.frame > 100 && window.__walker.drawn > 0, null, { timeout: 240_000 })
  const boot = await page.evaluate(() => ({
    stats: window.__walker,
    graph: window.__walkerTier !== undefined ? window.__walkerTier.graphStats() : null,
  }))
  check(`[${mode}] the boot — the loop runs, the crowd culled`, boot.stats.drawn > 30 && boot.stats.drawn < boot.stats.total, `drawn=${boot.stats.drawn}/${boot.stats.total}`)
  const live = boot.graph !== null ? boot.graph.live : []
  check(`[${mode}] the terrain passes live in the moving frame`, live.includes('terrain-color') && live.includes('terrain-z-2'), `live: ${live.join(',')}`)
  // Task 218 — THE K WIRING LAW: the tier carries the flicker cure's K
  // (24 — the occluded bursts that blinked the boxes ran up to ~23 frames)
  const hystK = await page.evaluate(() => window.__walkerTier.hystFrames)
  check(`[${mode}] the hysteresis K wiring — the flicker cure is armed`, hystK === 24, `hystFrames=${hystK} (need 24)`)

  const statsV = await page.waitForFunction(
    () => (window.__walker && window.__walker.validation !== null ? window.__walker : undefined),
    null, { timeout: 420_000 },
  ).then(h => h.jsonValue()).catch(() => null)
  check(`[${mode}] the autopilot walked the course — the validation verdict`, statsV?.validation?.pass === true,
    statsV !== null ? `${statsV.validation.pass ? 'PASS' : 'FAIL'} · ${statsV.validation.checks} laws` : 'timeout')
  if (statsV !== null) {
    const verdict = await page.evaluate(() => window.__walkerGate)
    if (verdict !== null && verdict !== undefined && Array.isArray(verdict.checks)) {
      for (const c of verdict.checks) check(`[${mode}] law: ${c.name}`, c.pass, c.detail)
    } else {
      check(`[${mode}] the gate promise resolved with the law list`, false, '')
    }
  }

  const scaleProbe = await page.evaluate(() => {
    const t = window.__walkerTier
    const kind = t.kind
    const before = t.canvas !== null ? { w: t.canvas.width, h: t.canvas.height } : null
    const applied = t.setRenderScale(0.5)
    const after = t.canvas !== null ? { w: t.canvas.width, h: t.canvas.height } : null
    return { kind, before, applied, after }
  })
  if (scaleProbe.kind === 'snapshot') {
    check(`[${mode}] setRenderScale — the snapshot leg's honest null`, scaleProbe.applied === null, `kind=${scaleProbe.kind}`)
  } else {
    check(`[${mode}] setRenderScale — the live leg re-derives the backing store`,
      scaleProbe.applied !== null && scaleProbe.after.w < scaleProbe.before.w,
      `${scaleProbe.before.w}x${scaleProbe.before.h} → ${scaleProbe.after.w}x${scaleProbe.after.h}`)
    await page.evaluate(() => window.__walkerTier.setRenderScale(1))
  }
  const frameA = await page.evaluate(() => window.__walker.frame)
  await page.waitForTimeout(1200)
  const frameB = await page.evaluate(() => window.__walker.frame)
  check(`[${mode}] the loop alive after the gate's probes`, frameB > frameA, `${frameA}→${frameB}`)
  check(`[${mode}] zero page errors`, errors.length === 0, errors.slice(0, 3).join(' | '))
  await page.close()
  server.stop(true)
}

async function mobileLeg(mode) {
  console.log(`[218] mobile leg ${mode}: goto…`)
  const server = serve(8942)
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 780 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 3,
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 200)}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`) })
  // crowd=512 — the mobile legs' subject is INPUT + VISUALS, not the
  // culling showcase (the validation legs carry that at 1500); the
  // lighter crowd keeps SwiftShader's frame rate honest for the touch
  // laws' frame-count-bound waits
  await page.goto(`http://localhost:8942/demo/walker/?crowd=512&bare${mode === 'webgl2' ? '&mode=webgl2' : ''}`, { waitUntil: 'networkidle', timeout: 90_000 })
  await page.waitForFunction(() => window.__walker && window.__walker.frame > 80 && window.__walker.drawn > 0, null, { timeout: 240_000 })

  // (a) THE FULLSCREEN LAW: the canvas covers the viewport
  const fs = await page.evaluate(() => {
    const c = document.getElementById('hiz-canvas')
    const r = c.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight, bodyFs: document.body.classList.contains('rd-fs') }
  })
  check(`[${mode}:mobile] the fullscreen law — the canvas covers the viewport`,
    fs.bodyFs && fs.w >= fs.vw * 0.97 && fs.h >= fs.vh * 0.97 && Math.abs(fs.x) < 8 && Math.abs(fs.y) < 8,
    `canvas ${Math.round(fs.w)}x${Math.round(fs.h)} of ${fs.vw}x${fs.vh} · rd-fs ${fs.bodyFs}`)

  // (b) THE SKY + TERRAIN LAWS: the screenshot decodes in-page
  await page.waitForTimeout(400)
  const shot = await page.screenshot()
  const br = await brightness(page, shot)
  check(`[${mode}:mobile] the sky law — the top quarter is a SKY, not black`,
    br.top.mean >= 40 && br.top.dark < 0.25, `mean ${br.top.mean.toFixed(1)}/255 · dark ${(br.top.dark * 100).toFixed(0)}% (the old sky: ~15)`)
  check(`[${mode}:mobile] the terrain law — the bottom half visibly lit`,
    br.bottom.mean >= 40 && br.bottom.dark < 0.5, `mean ${br.bottom.mean.toFixed(1)}/255 · dark ${(br.bottom.dark * 100).toFixed(0)}%`)

  // (c) THE TOUCH TRIO — the joystick: down at the left, drag up = forward
  const cRect = await page.evaluate(() => {
    const r = document.getElementById('hiz-canvas').getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
  const jx = cRect.x + cRect.w * 0.25, jy = cRect.y + cRect.h * 0.72
  await touch(page, 'pointerdown', jx, jy)
  // THE FADE-IN WAIT: the 120 ms CSS transition can land late on a
  // loaded page — the law WAITS for the visuals, never samples a tick
  const joyShown = await page.waitForFunction(
    () => {
      const base = document.querySelector('.walker-joy')
      const knob = document.querySelector('.walker-joy-knob')
      return base !== null && knob !== null
        && parseFloat(getComputedStyle(base).opacity) > 0.5
        && window.__walker.joyActive === true
        && window.__walker.isTouch === true
    },
    null, { timeout: 10_000, polling: 120 },
  ).then(() => true).catch(() => false)
  const joy = await page.evaluate(() => {
    const base = document.querySelector('.walker-joy')
    const knob = document.querySelector('.walker-joy-knob')
    return {
      exists: base !== null && knob !== null,
      opacity: base !== null ? parseFloat(getComputedStyle(base).opacity) : 0,
      active: window.__walker.joyActive,
      isTouch: window.__walker.isTouch,
    }
  })
  check(`[${mode}:mobile] the joystick law — the visuals appear at the anchor`,
    joyShown && joy.exists && joy.active && joy.isTouch, `base ${joy.exists} · opacity ${joy.opacity.toFixed(2)} · active ${joy.active}`)
  // drag right (+x): the walker crosses the plaza — a straight −z walk
  // from the spawn grazes the first platform's corner (a wall — the
  // honest axis-separated stop), the +x lane is corridor-clean
  const before = await page.evaluate(() => ({ x: window.__walker.x, z: window.__walker.z, speed: window.__walker.speed }))
  for (let k = 1; k <= 12; k++) {
    await touch(page, 'pointermove', jx + k * 8, jy)
    await page.waitForTimeout(40)
  }
  // THE MOVE WAIT: the stick is HELD at full deflection — the walker
  // keeps walking as frames land (a frame-count law, not a wall-time
  // one: SwiftShader's GL leg can run 3 frames a second at a 3× DPR
  // canvas, and the drag's wall window held as few as four)
  const moved = await page.waitForFunction(
    startX => window.__walker.x - startX > 2.0,
    before.x,
    { timeout: 20_000, polling: 250 },
  ).then(() => true).catch(() => false)
  const afterMove = await page.evaluate(() => ({ x: window.__walker.x, z: window.__walker.z, speed: window.__walker.speed, knob: document.querySelector('.walker-joy-knob').style.transform }))
  check(`[${mode}:mobile] the joystick law — the drag walks the walker`,
    moved && afterMove.speed > 1 && afterMove.x > before.x + 1.5,
    `speed ${afterMove.speed} m/s · x ${before.x} → ${afterMove.x} · knob ${afterMove.knob || 'none'}`)
  await touch(page, 'pointerup', jx + 96, jy)
  // THE STOP WAIT: the sim advances FIXED 1/60 per rAF frame (the bare
  // loop's deterministic dt) — under SwiftShader a 700 ms wall window
  // can hold as little as ONE frame (the round's own caught trap: 6.6 =
  // 7.5 − 55/60 exactly). The law WAITS for the stop (a generous
  // frame-count budget), never assumes wall time.
  const stopped = await page.waitForFunction(
    () => window.__walker.joyActive === false
      && window.__walker.speed < 1.5
      && parseFloat(getComputedStyle(document.querySelector('.walker-joy')).opacity) < 0.5,
    null, { timeout: 20_000, polling: 250 },
  ).then(() => true).catch(() => false)
  const released = await page.evaluate(() => ({ speed: window.__walker.speed, active: window.__walker.joyActive, opacity: parseFloat(getComputedStyle(document.querySelector('.walker-joy')).opacity) }))
  check(`[${mode}:mobile] the joystick law — the release stops the walk`,
    stopped && released.active === false && released.speed < 1.5, `speed ${released.speed} · active ${released.active} · fade ${released.opacity.toFixed(2)}`)

  // the look drag: the right half turns the camera
  const yaw0 = await page.evaluate(() => window.__walker.yaw)
  const lx = cRect.x + cRect.w * 0.75, ly = cRect.y + cRect.h * 0.4
  await touch(page, 'pointerdown', lx, ly)
  for (let k = 1; k <= 10; k++) {
    await touch(page, 'pointermove', lx + k * 12, ly)
    await page.waitForTimeout(30)
  }
  await touch(page, 'pointerup', lx + 120, ly)
  await page.waitForTimeout(200)
  const yaw1 = await page.evaluate(() => window.__walker.yaw)
  check(`[${mode}:mobile] the look law — the right-half drag turns the camera`,
    Math.abs(yaw1 - yaw0) > 0.15, `yaw ${yaw0.toFixed(2)} → ${yaw1.toFixed(2)}`)

  // the JUMP button: revealed by touch, pressing leaves the ground
  const jump = await page.evaluate(() => {
    const b = document.querySelector('.walker-jump')
    return { exists: b !== null, shown: b !== null && b.classList.contains('touch') }
  })
  check(`[${mode}:mobile] the jump button law — revealed on touch`, jump.exists && jump.shown, '')
  const jbtn = await page.evaluate(() => {
    const b = document.querySelector('.walker-jump')
    const r = b.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  await touch(page, 'pointerdown', jbtn.x, jbtn.y, '.walker-jump')
  let leftGround = false
  for (let k = 0; k < 40; k++) {
    await page.waitForTimeout(50)
    const s = await page.evaluate(() => ({ g: window.__walker.grounded, y: window.__walker.y, jh: window.__walker.jumpHeld }))
    if (s.jh && !s.g) { leftGround = true; break }
  }
  await touch(page, 'pointerup', jbtn.x, jbtn.y, '.walker-jump')
  check(`[${mode}:mobile] the jump law — the button launches the body`, leftGround, '')
  check(`[${mode}:mobile] zero page errors`, errors.length === 0, errors.slice(0, 3).join(' | '))
  await ctx.close()
  server.stop(true)
}

async function fallbackLeg() {
  console.log(`[218] fallback leg (the live-WG present death): goto…`)
  const server = serve(8942)
  const ctx = await browser.newContext({ viewport: { width: 960, height: 720 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 160)}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`) })
  await page.goto('http://localhost:8942/demo/walker/?crowd=512&mode=webgpu&live=1', { waitUntil: 'networkidle', timeout: 90_000 })
  // the container's present death: the WG device dies at the first
  // present, the canvas stays transparent — the watchdog checks at
  // frames 90/180 (staged boots reset frameIndex), the chain walks to
  // webgl2. WAIT for the landing (a frame-count journey, not wall time).
  const landed = await page.waitForFunction(
    () => window.__walker && window.__walker.frame > 40 && window.__walker.drawn > 0
      && (window.__walker.backend === 'webgl2' || (window.__walker.backend === 'webgpu' && window.__walker.kind === 'snapshot')),
    null, { timeout: 420_000, polling: 500 },
  ).then(() => true).catch(() => false)
  const state = await page.evaluate(() => {
    const w = window.__walker
    const all = window.__walkerErrs ?? []
    return { backend: w.backend, kind: w.kind, frame: w.frame, drawn: w.drawn, total: w.total, errs: all.length, uncaught: all.filter(n => n.includes('uncaught')).length, notes: all.slice(0, 3) }
  })
  // the chain's landing: a LIVING tier — the WG snapshot path (the surface
  // + the 2D blit — WebGPU KEPT where the device is alive) or webgl2 (the
  // device itself dead). The container's second WG device lives → snapshot.
  check('[fallback] the watchdog walks the dead live-WG to a LIVING tier',
    landed && (state.backend === 'webgl2' || (state.backend === 'webgpu' && state.kind === 'snapshot')) && state.drawn > 0,
    JSON.stringify(state))
  // THE CANVAS LIVES: the in-page mirror proves the GL canvas presents
  const pixels = await page.evaluate(() => {
    const c = document.getElementById('hiz-canvas')
    const m = document.createElement('canvas'); m.width = 16; m.height = 16
    const x = m.getContext('2d'); x.drawImage(c, 0, 0, 16, 16)
    const d = x.getImageData(0, 0, 16, 16).data
    let lit = 0
    for (let k = 3; k < d.length; k += 4) if (d[k] >= 8) lit++
    return { litPct: Math.round(lit / 256 * 100) } // 16×16 = 256 texels
  })
  check('[fallback] the recovered canvas presents real pixels', pixels.litPct >= 90, `${pixels.litPct}% of the mirror lit (the dead leg was 0%)`)
  const sky = await page.evaluate(async () => {
    const c = document.getElementById('hiz-canvas')
    const m = document.createElement('canvas'); m.width = 64; m.height = 128
    const x = m.getContext('2d'); x.drawImage(c, 0, 0, 64, 128)
    const d = x.getImageData(0, 0, 64, 40).data
    let sum = 0, n = 0
    for (let k = 0; k < d.length; k += 16) { sum += (d[k] + d[k + 1] + d[k + 2]) / 3; n++ }
    return Math.round(sum / n)
  })
  check('[fallback] the recovered sky is the walker\'s daylight', sky >= 40, `sky ${sky}/255 (the dead leg: the page background)`)
  check('[fallback] the fallback left its evidence in the log', state.errs >= 1, state.notes.join(' | ').slice(0, 160))
  // the mid-frame dispose race's regression law: the fallback's bootTier
  // runs inside the loop callback — the frame must be forfeited cleanly,
  // no uncaught null-deref may ride the chain
  check('[fallback] no uncaught race debris on the chain', state.uncaught === 0, `uncaught=${state.uncaught}`)
  const fA = await page.evaluate(() => window.__walker.frame)
  await page.waitForTimeout(1500)
  const fB = await page.evaluate(() => window.__walker.frame)
  check('[fallback] the recovered loop keeps running', fB > fA, `${fA}→${fB}`)
  await ctx.close()
  server.stop(true)
}

async function flickerEvidenceLeg() {
  console.log(`[218] flicker evidence leg (the GL oscilloscope, report): goto…`)
  const server = serve(8942)
  const ctx = await browser.newContext({ viewport: { width: 960, height: 720 } })
  const page = await ctx.newPage()
  await page.goto('http://localhost:8942/demo/walker/?crowd=512&mode=webgl2', { waitUntil: 'networkidle', timeout: 90_000 })
  await page.waitForFunction(() => window.__walker && window.__walker.frame > 100 && window.__walker.drawn > 0, null, { timeout: 240_000 })
  const report = await page.evaluate(async () => {
    const t = window.__walkerTier
    const N = window.__walker.total
    const series = []
    let pending = false
    const t0 = performance.now()
    await new Promise(done => {
      const tick = () => {
        if (!pending) { pending = true; t.readVerdicts().then(v => { series.push(v); pending = false }).catch(() => { pending = false }) }
        if (performance.now() - t0 < 12000) requestAnimationFrame(tick); else done()
      }
      requestAnimationFrame(tick)
    })
    const framesPerSample = Math.max(1, Math.round(window.__walker.frame / series.length))
    let flips = 0, shortRuns = 0, longRuns = 0, topFlips = 0
    for (let i = 0; i < N; i++) {
      let run = 0, f = 0
      for (let s = 0; s < series.length; s++) {
        const occ = series[s][i] === 3
        if (occ) { run++ } else { if (run > 0) { if (run * framesPerSample <= 23) shortRuns++; else longRuns++ }; run = 0 }
        if (s > 0 && occ !== (series[s - 1][i] === 3)) f++
      }
      flips += f; topFlips = Math.max(topFlips, f)
    }
    return { samples: series.length, N, framesPerSample, totalFlips: flips, shortRuns, longRuns, topFlips, k: t.hystFrames }
  }, { timeout: 120_000 })
  console.log(`  [evidence] K=${report.k} · samples=${report.samples} (~${report.framesPerSample} frames apart) · raw flips=${report.totalFlips} (top id ${report.topFlips})`)
  console.log(`  [evidence] occluded runs ≤23 frames (K=24 MASKS these — the report's blinking): ${report.shortRuns} · honest runs (stay culled): ${report.longRuns}`)
  check('[evidence] the oscilloscope ran and the cure is armed', report.k === 24 && report.samples > 60, `K=${report.k} · ${report.samples} samples`)
  await ctx.close()
  server.stop(true)
}

const which = process.argv[2] ?? 'all'
if (which === 'validation' || which === 'all') {
  await validationLeg('webgpu')
  await validationLeg('webgl2')
}
if (which === 'mobile' || which === 'all') {
  await mobileLeg('webgpu')
  await mobileLeg('webgl2')
}
if (which === 'fallback' || which === 'all') {
  await fallbackLeg()
}
if (which === 'evidence' || which === 'all') {
  await flickerEvidenceLeg()
}

await browser.close()
console.log('')
if (failures === 0) {
  console.log('[218] ALL PASS — the second field report is answered: the WG death self-heals, the flicker is masked, both backends, both viewports')
  process.exit(0)
}
console.log(`[218] ${failures} FAILURES`)
process.exit(1)
