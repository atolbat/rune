/**
 * scripts/task220-local.mjs — the LOCAL gate for Task 220 (THE HONEST AA +
 * THE QUIET WATCHDOG — the field report: «Сейчас вебгпу сразу показывает
 * норм, но потом на мгновение черный экран и потом снова начинает норм» +
 * «сглаживания я там не вижу, одни лесенки»).
 *
 * Two diseases, both to the root:
 *
 *   · THE SPURIOUS WATCHDOG SWAP — the root cure (219) worked (the live
 *     canvas presented from frame 1), but the watchdog STILL fired at
 *     frame 30: its ONE-SAMPLE alpha-only probe caught the ADAPTIVE
 *     GOVERNOR's resize-clear (a canvas.width write clears the bitmap —
 *     spec — until the next present; the governor's level drop lands
 *     exactly in the phone's slow-boot window), read the transparent
 *     gap, and swapped the healthy live tier for the snapshot — the
 *     black flash + a permanently slower path + the cascaded
 *     «validation FAIL — zero errors». The law now: a blank probe is a
 *     SUSPECT (info, +6 frames), only TWO consecutive blanks are the
 *     verdict (the message carries both frames); the probe reads ANY
 *     channel; and the rescue boots OVER the old canvas (the new one
 *     invisible until its first landed present — a rescue must never
 *     black-flash the screen it rescues).
 *
 *   · THE DEAD AA — 219's single-pass present moved the scene into the
 *     offscreen surface and retired every antialiasing path (the WG
 *     canvas MSAA was the death construct; the GL context cascade only
 *     covered the default framebuffer, now a blit target). The AA's new
 *     home: the SURFACE renders 4x and resolves into the same 1x
 *     texture (WG: the inline resolveTarget; GL: the boundary blit —
 *     which resolves DEPTH too, so the A6 harvest rides the GL MSAA leg
 *     free; the WG leg drops the harvest honestly — no spec depth
 *     resolve — and the still-camera reuse declines to the feedback
 *     fill, the capability-split A6 law).
 *
 * Legs: the MSAA law page (the facade, both backends — the container's
 * software GPUs still resolve surfaces; only presents die) + the walker
 * source laws + the validation legs (both backends) + the fallback chain
 * (the container's present death walks to a LIVING tier with the overlay
 * end-state: exactly ONE canvas).
 */
import { chromium } from 'playwright'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

const root = join(import.meta.dirname, '..')
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})
let failures = 0
function check(name, ok, detail = '') {
  console.log(`[220] ${name}: ${ok ? 'PASS' : 'FAIL'}${detail ? ` · ${detail}` : ''}`)
  if (!ok) failures++
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
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

// ── LEG 1 — THE MSAA RESOLVE LAW (the facade, both backends) ────────────
async function msaaLeg() {
  console.log('[220] MSAA law leg: goto…')
  const server = serve(8961)
  const ctx = await browser.newContext({ viewport: { width: 720, height: 480 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(`pageerror: ${e.message.slice(0, 160)}`))
  await page.goto('http://localhost:8961/scripts/scratch-220-msaa.html', { waitUntil: 'networkidle', timeout: 90_000 })
  const report = await page.waitForFunction(() => window.__msaaReport !== undefined, null, { timeout: 120_000 })
    .then(() => page.evaluate(() => window.__msaaReport))
    .catch(() => null)
  if (report === null) {
    check('[msaa] the law page produced a report', false, errors.join(' | '))
  } else {
    for (const backend of ['webgpu', 'webgl2']) {
      const leg = report.legs[backend]
      if (leg === undefined || leg.error !== undefined) {
        check(`[msaa:${backend}] the leg ran`, false, leg?.error ?? 'missing')
        continue
      }
      // THE RESOLVE LAW: 4x resolves blended coverage the 1x render cannot
      check(`[msaa:${backend}] THE RESOLVE LAW — the 4x boundary blends, the 1x boundary cuts`,
        leg.x4.blended > 20 && leg.x4.blended > leg.x1.blended * 4 && leg.x1.blended < 8,
        `1x blended=${leg.x1.blended} · 4x blended=${leg.x4.blended}`)
      // THE RESOLVED IMAGE is the full 1x frame (the readers' contract)
      check(`[msaa:${backend}] the resolved readback is the full frame with the triangle inside`,
        leg.x4.w === 128 && leg.x4.h === 128 && leg.x4.inside > 128 * 128 * 0.3 && leg.x4.outside > 128 * 128 * 0.3,
        `inside=${leg.x4.inside} outside=${leg.x4.outside} of ${leg.x4.w}×${leg.x4.h}`)
    }
    // THE DOOR LAW: WG refuses samples+depthTexture (no spec depth resolve);
    // GL takes the combo (the blit resolves depth)
    check('[msaa] the WG door — samples+depthTexture refuses loudly',
      report.doors.webgpu?.refused !== false && String(report.doors.webgpu?.refused ?? '').includes('no depth resolve'),
      String(report.doors.webgpu?.refused ?? report.doors.webgpu?.bootError ?? 'missing'))
    check('[msaa] the GL door — samples+depthTexture rides (the depth resolve)',
      report.doors.webgl2?.refused === false, String(report.doors.webgl2?.refused ?? 'missing'))
  }
  check('[msaa] zero page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  await ctx.close()
  server.stop(true)
}

// ── LEG 2 — THE WALKER SOURCE LAWS (the two-stage verdict, the overlay,
//    the MSAA ladder, the re-based error law) ────────────────────────────
async function sourceLeg() {
  console.log('[220] source leg: reading…')
  const main = await readFile(join(root, 'demo/walker/main.js'), 'utf8')
  const tier = await readFile(join(root, 'demo/occlusion/tier.js'), 'utf8')
  const index = await readFile(join(root, 'demo/walker/index.html'), 'utf8')
  check('source: the two-stage verdict ships (suspect → confirm, both frames in the message)',
    main.includes('wdSuspectFrame') && main.includes('suspect frame ${wdSuspectFrame}, confirmed frame ${frameIndex}'),
    '')
  check('source: the confirm cadence is 6 frames (past every resize-clear gap)',
    main.includes('wdNextFrame = frameIndex + 6'), '')
  check('source: the probe reads ANY channel (the alpha-only blind spot is dead)',
    // Task 222 — canvasProbe: the max scan covers R, G, B AND A (any lit
    // channel lights the probe); the old per-index shape moved into the
    // max-channel form (the evidence rides the verdict notes now)
    /if \(d\[k\] > max\) max = d\[k\]/.test(main)
      && /if \(d\[k \+ 3\] > max\) max = d\[k \+ 3\]/.test(main),
    '')
  check('source: the overlay swap ships (the underlay + the invisible-until-landed canvas)',
    main.includes('overlayTier') && main.includes("style.visibility = 'hidden'") && main.includes("style.visibility = ''"),
    '')
  check('source: the present ledger ships (livePresents + presentHealth)',
    tier.includes('livePresents++') && tier.includes('presentHealth: () => ({ presents: livePresents'), '')
  check('source: the MSAA ladder ships (4x real-GPU legs, 1x software/probe, the WG depthTexture split)',
    tier.includes('samples: SAMPLES') && tier.includes("SAMPLES === 1 || backend === 'webgl2'"), '')
  check('source: the zero-NEW-errors law ships (the re-armed validation re-bases)',
    main.includes('validationErrorsAtStart') && main.includes('zero new errors during the validation'), '')
  check('source: the overlay CSS ships (absolute stacking — both canvases over the same pixels)',
    index.includes('position: absolute; inset: 0'), '')
  check('source: the A6 capability-split law ships (harvest where the surface can, fill where it cannot)',
    main.includes('harvestCapable') && main.includes('tier.surface.depthTextureId !== undefined'), '')
  const v222 = (main.match(/\?v=222/g) ?? []).length + (index.match(/\?v=222/g) ?? []).length
  check('source: the cache-bust marks moved to v=222 (the current deploy state — Task 222)',
    v222 >= 8, `${v222} marks`)
}

// ── LEG 3 — THE WALKER VALIDATION (both backends: the 14 laws hold with
//    the capability-split A6 + the re-based error law; the container's
//    software legs stay 1x — the MSAA tier wiring is the source law above
//    and the facade law of LEG 1) ─────────────────────────────────────────
async function validationLeg(mode) {
  console.log(`[220] validation leg ${mode}: goto…`)
  const server = serve(8962)
  const ctx = await browser.newContext({ viewport: { width: 720, height: 480 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(`pageerror: ${e.message.slice(0, 160)}`))
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`) })
  await page.goto(`http://localhost:8962/demo/walker/?crowd=512&mode=${mode}`, { waitUntil: 'networkidle', timeout: 90_000 })
  const verdict = await page.waitForFunction(() => window.__walker && window.__walker.validation !== null, null, { timeout: 420_000 })
    .then(() => page.evaluate(() => ({ v: window.__walker.validation, errs: (window.__walkerErrs ?? []).length, notes: (window.__walkerErrs ?? []).slice(0, 3), kind: window.__walker.kind, line: window.__walkerTier.tierLine })))
    .catch(() => null)
  check(`[${mode}:validation] the autopilot walked the course (all laws held)`,
    verdict !== null && verdict.v.pass === true && verdict.v.checks >= 14,
    verdict === null ? 'timeout' : `${verdict.v.checks} laws · kind=${verdict.kind} · errs=${verdict.errs}`)
  check(`[${mode}:validation] zero page errors`, errors.length === 0, errors.slice(0, 3).join(' | '))
  // THE LADDER'S HONESTY in the container: software legs carry NO MSAA mark
  // (the 4x fill on SwiftShader is the caps' whole point)
  if (verdict !== null) {
    check(`[${mode}:validation] the software ladder stays 1x in the container (no MSAA mark)`,
      !verdict.line.includes('MSAA'), verdict.line)
  }
  await ctx.close()
  server.stop(true)
}

// ── LEG 4 — THE FALLBACK CHAIN (the container's WG present death): the
//    chain lands on a LIVING tier at the two-stage cadence, and the
//    overlay's end-state is exactly ONE canvas with real pixels ──────────
async function fallbackLeg() {
  console.log('[220] fallback leg (the live-WG present death): goto…')
  const server = serve(8963)
  const ctx = await browser.newContext({ viewport: { width: 960, height: 720 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(`pageerror: ${e.message.slice(0, 160)}`))
  await page.goto('http://localhost:8963/demo/walker/?crowd=512&mode=webgpu&live=1', { waitUntil: 'networkidle', timeout: 90_000 })
  const landed = await page.waitForFunction(
    () => window.__walker && window.__walker.frame > 40 && window.__walker.drawn > 0
      && (window.__walker.backend === 'webgl2' || (window.__walker.backend === 'webgpu' && window.__walker.kind === 'snapshot')),
    null, { timeout: 420_000, polling: 500 },
  ).then(() => true).catch(() => false)
  const state = await page.evaluate(() => {
    const w = window.__walker
    const all = window.__walkerErrs ?? []
    const canvases = document.querySelectorAll('#hiz-canvas').length
    const anyCanvas = document.querySelectorAll('.walker-stage canvas').length
    return {
      backend: w.backend, kind: w.kind, frame: w.frame, drawn: w.drawn,
      canvases, anyCanvas,
      notes: all.slice(0, 4),
      twoStage: all.some(n => n.includes('suspect frame')),
      deviceLost: all.some(n => /device lost/i.test(n)),
    }
  })
  check('[fallback] the watchdog walks the dead live-WG to a LIVING tier',
    landed && (state.backend === 'webgl2' || (state.backend === 'webgpu' && state.kind === 'snapshot')) && state.drawn > 0,
    JSON.stringify({ backend: state.backend, kind: state.kind, drawn: state.drawn }))
  // THE CADENCE: the container's death class walks through EITHER the
  // device-lost accelerator (immediate) OR the two-stage probe (the
  // suspect+confirm message) — both are the new law; the old one-sample
  // verdict text is gone
  check('[fallback] the verdict is the new law (two-stage or the accelerator — never a one-sample swap)',
    state.deviceLost || state.twoStage, state.notes.join(' | '))
  // THE OVERLAY END-STATE: exactly ONE canvas carries the id (the underlay
  // retired after the rescue's first present); no orphan canvases in the stage
  check('[fallback] the overlay end-state — exactly one canvas, the underlay retired',
    state.canvases === 1 && state.anyCanvas === 1, `#hiz-canvas=${state.canvases} · stage canvases=${state.anyCanvas}`)
  const pixels = await page.evaluate(() => {
    const c = document.getElementById('hiz-canvas')
    const m = document.createElement('canvas'); m.width = 16; m.height = 16
    const x = m.getContext('2d'); x.drawImage(c, 0, 0, 16, 16)
    const d = x.getImageData(0, 0, 16, 16).data
    let lit = 0
    for (let k = 0; k < d.length; k += 4) if (d[k] >= 8 || d[k + 1] >= 8 || d[k + 2] >= 8 || d[k + 3] >= 8) lit++
    return { litPct: Math.round(lit / 256 * 100), visible: c.style.visibility !== 'hidden' }
  })
  check('[fallback] the recovered canvas is VISIBLE and presents real pixels',
    pixels.litPct >= 90 && pixels.visible, `${pixels.litPct}% lit · visible=${pixels.visible}`)
  await ctx.close()
  server.stop(true)
}

await msaaLeg()
await sourceLeg()
await validationLeg('webgpu')
await validationLeg('webgl2')
await fallbackLeg()

await browser.close()
console.log(`[220-local] ${failures === 0 ? 'ALL PASS' : `FAILURES: ${failures}`} — the honest AA + the quiet watchdog hold in the container`)
process.exit(failures === 0 ? 0 : 1)
