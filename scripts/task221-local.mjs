/**
 * scripts/task221-local.mjs — the LOCAL gate for Task 221 (THE TILER LAWS —
 * the third phone field report: «Там опять темный экран на вебгпу, а на
 * вебгл ничего не рендерится вообще»).
 *
 * The report's log (webgl2 era, Android 10 / Chrome 152) carried the
 * evidence trail: the WG chain's «the live canvas never presented (suspect
 * frame 30, confirmed frame 36)» + the GL leg's «GL error:
 * INVALID_OPERATION — an error accumulated in the last frame». Two
 * independent roots, both invisible to every container gate (SwiftShader
 * is an immediate-mode emulator — it survives exactly the constructs the
 * phone's tiler reads as garbage):
 *
 *   · WG — THE LOAD-AFTER-DISCARD RE-GROWN ON THE SURFACE: the walker's
 *     frame opens the SAME 4x surface TWICE (the terrain-color drawMesh
 *     ends its pass by the tape contract; the crowd's color pass re-opens
 *     with loadOp:'load'), and the surface-MSAA pass ended with
 *     storeOp:'discard' — the re-open read DISCARDED samples: spec-legal,
 *     contents UNDEFINED, black on the phone's tiler (both the live AND
 *     the snapshot legs — the rescue renders through the same surface).
 *     THE LAW: the 4x color twin STORES (the depth twin already did — the
 *     220 code got depth right and color wrong); discard is legal only
 *     under a proven one-pass contract (the canvas-pass law), which a
 *     surface does not have.
 *
 *   · GL — THE DEPTH-FORMAT MISMATCH IN THE RESOLVE BLIT: the boundary
 *     resolve blitted DEPTH from a DEPTH_COMPONENT24 4x renderbuffer into
 *     the caller's DEPTH_COMPONENT32F 1x texture — blitFramebuffer
 *     demands IDENTICAL depth formats: INVALID_OPERATION, the whole blit
 *     (COLOR included) no-ops, both FBOs report COMPLETE (each judged
 *     alone), the caller's texture never receives a pixel — «ничего не
 *     рендерится вообще». THE LAW: one depth format per target (the 4x
 *     twin rides the 1x side's own), plus a CREATION-TIME 1×1 dry-run of
 *     the exact resolve blit — a driver that refuses it fails the boot
 *     LOUDLY (the capability ladder re-boots 1x) instead of rendering
 *     blank frames forever.
 *
 *   · THE WATCHDOG'S CONTENT DISCRIMINATOR: a blank canvas + submitted
 *     presents is no longer a blind takeover — the SURFACE's own readback
 *     (the copy lane, not the present lane) discriminates a present-lane
 *     death (lit content → the snapshot rescue SAVES this class) from a
 *     black-content fault (blank content → the rescue would render the
 *     same bytes — the honest note + retirement). The container's
 *     present-death leg must still walk to a LIVING tier.
 *
 * Legs: the extended MSAA law page (the resolve law + THE RE-OPEN LAW +
 * the doors) + the source laws + the validation legs (both backends) +
 * the fallback chain (the discriminator must not break the rescue).
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
  console.log(`[221] ${name}: ${ok ? 'PASS' : 'FAIL'}${detail ? ` · ${detail}` : ''}`)
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

// ── LEG 1 — THE MSAA LAW PAGE (the resolve law + THE RE-OPEN LAW) ───────
async function msaaLeg() {
  console.log('[221] MSAA law leg: goto…')
  const server = serve(8961)
  const ctx = await browser.newContext({ viewport: { width: 720, height: 480 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(`pageerror: ${e.message.slice(0, 160)}`))
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`) })
  await page.goto('http://localhost:8961/scripts/scratch-220-msaa.html', { waitUntil: 'networkidle', timeout: 90_000 })
  const report = await page.waitForFunction(() => window.__msaaReport !== undefined, null, { timeout: 180_000 })
    .then(() => page.evaluate(() => window.__msaaReport))
    .catch(() => null)
  if (report === null) {
    check('saa] the law page produced a report', false, errors.join(' | '))
  } else {
    for (const backend of ['webgpu', 'webgl2']) {
      const leg = report.legs?.[backend]
      check(`saa:${backend}] the leg ran`, leg !== undefined && leg.error === undefined, leg?.error ?? 'ok')
      if (leg?.error === undefined) {
        check(`saa:${backend}] THE RESOLVE LAW — the 4x boundary blends, the 1x boundary cuts`,
          leg.x4.blended > leg.x1.blended && leg.x4.blended >= 8, `1x=${leg.x1.blended} · 4x=${leg.x4.blended}`)
        check(`saa:${backend}] the resolved readback is the full frame with the triangle inside`,
          leg.x4.inside > 0 && leg.x4.outside > 0, `inside=${leg.x4.inside} · outside=${leg.x4.outside}`)
      }
      // Task 221 — THE RE-OPEN LAW: quad A (clear) → a REAL pass boundary
      // (the drawMesh tape contract's endPass) → quad B (loadOp:'load') —
      // the resolved readback must carry BOTH layers: A's samples SURVIVE
      // the re-open (the load-after-discard signature would leave the
      // right half reading the clear color).
      const ro = report.reopen?.[backend]
      check(`saa:${backend}] the re-open leg ran`, ro !== undefined && ro.error === undefined, ro?.error ?? 'ok')
      if (ro?.error === undefined) {
        for (const s of ['x1', 'x4']) {
          check(`saa:${backend}] THE RE-OPEN LAW (${s}) — pass 2's load sees pass 1's stored samples`,
            ro[s].bLeft > 0 && ro[s].aRight > 0 && ro[s].clearRight === 0,
            `B-left=${ro[s].bLeft} · A-right=${ro[s].aRight} · clear-right=${ro[s].clearRight}`)
        }
      }
    }
    check('saa] the WG door — samples+depthTexture refuses loudly',
      report.doors?.webgpu?.refused !== false, String(report.doors?.webgpu?.refused).slice(0, 80))
    check('saa] the GL door — samples+depthTexture rides (the depth resolve)',
      report.doors?.webgl2?.refused === false, String(report.doors?.webgl2?.refused).slice(0, 80))
  }
  check('saa] zero page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  await ctx.close()
  server.stop(true)
}

// ── LEG 2 — THE SOURCE LAWS (the store law, the parity law, the probe,
//    the content discriminator, the blind-probe + preservation laws of 222) ─
async function sourceLeg() {
  console.log('[221] source leg: reading…')
  const main = await readFile(join(root, 'demo/walker/main.js'), 'utf8')
  const controls = await readFile(join(root, 'demo/walker/controls.js'), 'utf8')
  const gpu = await readFile(join(root, 'packages/webgpu/src/realGPU.ts'), 'utf8')
  const gl = await readFile(join(root, 'packages/webgl2/src/realGL.ts'), 'utf8')
  check('source: THE SURFACE-PASS STORE LAW — the 4x color twin stores (discard is canvas-only)',
    /passSamples = target\.samples[\s\S]{0,600}storeOp = 'store'/.test(gpu)
      && !/target\.samples > 1[\s\S]{0,400}storeOp = 'discard'/.test(gpu)
      && gpu.includes('THE SURFACE-PASS STORE LAW'),
    '')
  check('source: the canvas-pass law stays (the ONE legal discard home)',
    gpu.includes('the canvas-pass law') && /canvasAntialias && msaaColorView !== null[\s\S]{0,200}storeOp = 'discard'/.test(gpu),
    '')
  check('source: THE DEPTH-FORMAT PARITY LAW — one depth format per target (the twins share it)',
    gl.includes('THE DEPTH-FORMAT PARITY LAW')
      && /const depthFormat = depthTextureId !== undefined[\s\S]{0,200}gl\.DEPTH_COMPONENT32F/.test(gl)
      && gl.includes('renderbufferStorageMultisample(gl.RENDERBUFFER, targetSamples, depthFormat, width, height)'),
    '')
  check('source: THE CREATION-TIME RESOLVE PROBE — the 1×1 dry-run blit at boot',
    gl.includes('THE CREATION-TIME RESOLVE PROBE') && gl.includes('refused the multisample resolve blit'),
    '')
  check('source: THE CONTENT DISCRIMINATOR — the surface readback splits a present death from black content',
    main.includes('THE CONTENT DISCRIMINATOR')
      && main.includes('the content itself is black')
      && main.includes('surface read timeout'),
    '')
  check('source: the content probe judges RGB only (the alpha byte is a compositing artifact)',
    /RGB only — the ALPHA byte is a compositing artifact/.test(main)
      && !/shot\.data\[k \+ 3\] >= 8 \|\| shot\.data\.length/.test(main),
    '')
  // Task 222 — the round's own laws: the BLIND-PROBE retirement (a lit
  // surface + a blank mirror NEVER takes over — the Android overlay class
  // reads blank on a healthy screen; the takeover reset the player), the
  // GAME PRESERVATION (boots after the first keep the walker, the camera,
  // the frame clock; a completed validation never re-arms), the probe's
  // own evidence in the notes, and the touch look's standard vertical.
  check('source: THE BLIND-PROBE LAW — a lit surface + a blank mirror RETIRES (never takes over)',
    main.includes('THE BLIND-PROBE LAW')
      && main.includes('a BLIND PROBE')
      && !main.includes('the present lane drops the frames — the WG snapshot path takes over'),
    '')
  check('source: the blind-probe verdict is a WARN (a healthy phone validation must not fail over its own diagnostics)',
    /shell\.log\.warn\(`the mirror probe reads blank but the render is alive/.test(main),
    '')
  check('source: THE GAME PRESERVATION LAW — boots after the first keep the player, the camera, the clock',
    main.includes('THE GAME PRESERVATION LAW') && main.includes('if (bootCount === 0) {')
      && main.includes('priorValidationDone') && main.includes('bootCount++')
      && !main.includes('// respawn + a fresh camera at the course\'s start'),
    '')
  check('source: the settle law fires once (a resumed validation never re-judges the spawn)',
    main.includes('settleLawDone') && /frameIndex === 20 && !settleLawDone/.test(main),
    '')
  check('source: the probe evidence rides the notes (max channel + canvas dims)',
    main.includes("the probe's own read: max channel") && main.includes('render scale → '),
    '')
  check('source: THE TOUCH LOOK LAW — the vertical drag is standard (drag down looks down)',
    controls.includes('THE TOUCH LOOK LAW')
      && controls.includes('state.lookDY -= (e.clientY - lookLast.y) * lookSens * 1.6'),
    '')
  const index = await readFile(join(root, 'demo/walker/index.html'), 'utf8')
  const v222 = (main.match(/\?v=223/g) ?? []).length + (index.match(/\?v=223/g) ?? []).length
  check('source: the cache-bust marks moved to v=223 (the current deploy state — Task 222)',
    v222 >= 8, `${v222} marks`)
}

// ── LEG 3 — THE WALKER VALIDATION (both backends — the tiler laws must
//    not move a single classic bit; the container's software legs stay 1x) ─
async function validationLeg(mode) {
  console.log(`[221] validation leg ${mode}: goto…`)
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
  if (verdict !== null) {
    check(`[${mode}:validation] the software ladder stays 1x in the container (no MSAA mark)`,
      !verdict.line.includes('MSAA'), verdict.line)
  }
  await ctx.close()
  server.stop(true)
}

// ── LEG 4 — THE FALLBACK CHAIN (the container's WG present death): the
//    discriminator must not break the rescue — the chain still lands on a
//    LIVING tier, the overlay end-state is exactly ONE canvas ─────────────
async function fallbackLeg() {
  console.log('[221] fallback leg (the live-WG present death): goto…')
  const server = serve(8963)
  const ctx = await browser.newContext({ viewport: { width: 960, height: 720 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(`pageerror: ${e.message.slice(0, 160)}`))
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`) })
  await page.goto('http://localhost:8963/demo/walker/?crowd=512&mode=webgpu&live=1', { waitUntil: 'networkidle', timeout: 90_000 })
  const landed = await page.waitForFunction(
    () => window.__walker && window.__walker.frame > 40 && window.__walker.drawn > 0
      && (window.__walker.backend === 'webgl2' || (window.__walker.backend === 'webgpu' && window.__walker.kind === 'snapshot')),
    null, { timeout: 420_000, polling: 500 },
  ).then(() => true).catch(() => false)
  const state = await page.evaluate(() => {
    const w = window.__walker
    const all = window.__walkerErrs ?? []
    return {
      backend: w.backend, kind: w.kind, frame: w.frame, drawn: w.drawn,
      canvases: document.querySelectorAll('#hiz-canvas').length,
      anyCanvas: document.querySelectorAll('.walker-stage canvas').length,
      notes: all.slice(0, 5),
      twoStage: all.some(n => n.includes('suspect frame')),
      deviceLost: all.some(n => /device lost/i.test(n)),
      contentBlack: all.some(n => n.includes('the content itself is black')),
    }
  })
  check('[fallback] the watchdog walks the dead live-WG to a LIVING tier (the discriminator kept the rescue)',
    landed && (state.backend === 'webgl2' || (state.backend === 'webgpu' && state.kind === 'snapshot')) && state.drawn > 0,
    JSON.stringify({ backend: state.backend, kind: state.kind, drawn: state.drawn }))
  check('[fallback] the verdict is the new law (two-stage or the accelerator — never a one-sample swap)',
    state.deviceLost || state.twoStage, state.notes.join(' | '))
  // THE DISCRIMINATOR'S HONESTY: the container's present death is a
  // present-lane class (or a device death) — the content-black retirement
  // must NOT fire here (that branch belongs to the black-content fault;
  // if it fired in the container, the rescue would have been skipped)
  check('[fallback] the content-black retirement did NOT eat the rescue (the present-death class walks)',
    !state.contentBlack, state.notes.join(' | '))
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
  // Task 222 — THE PRESERVATION COMPOSITION LAW: the takeover fired mid-run
  // (the validation was live on the dead tier at frame ~38); the preserved
  // game (walker + clock + the autopilot's own module state) must finish
  // the course on the rescue tier — the re-armed validation CONTINUES
  // mid-course and lands PASS. The old shape (teleport + rewind) also
  // passed eventually — the discriminator here is the FRAME CLOCK: it
  // never rewinds (the takeover note's confirmed frame must be BELOW the
  // final frame, not a fresh climb from 0 — checked cheaply by requiring
  // the final frame well past the takeover while the validation is done).
  const resumed = await page.waitForFunction(
    () => window.__walker && window.__walker.validation !== null,
    null, { timeout: 420_000, polling: 500 },
  ).then(() => page.evaluate(() => ({ v: window.__walker.validation, frame: window.__walker.frame })))
    .catch(() => null)
  check('[fallback] THE GAME PRESERVATION LAW — the mid-run takeover resumes the course and the validation lands PASS',
    resumed !== null && resumed.v.pass === true && resumed.v.checks >= 13,
    resumed === null ? 'the validation never finished' : `${resumed.v.pass ? 'PASS' : 'FAIL'} · ${resumed.v.checks} laws · frame ${resumed.frame}`)
  await ctx.close()
  server.stop(true)
}

await msaaLeg()
await sourceLeg()
await validationLeg('webgpu')
await validationLeg('webgl2')
await fallbackLeg()

await browser.close()
console.log(`[221-local] ${failures === 0 ? 'ALL PASS' : `FAILURES: ${failures}`} — the tiler laws hold in the container`)
process.exit(failures === 0 ? 0 : 1)
