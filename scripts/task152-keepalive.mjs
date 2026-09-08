// task152 — THE GL CONTEXT KEEP-ALIVE (Task 152; Task 162 — THE LADDER
// RETIREMENT trims this gate to the keep-alive's own scope: the
// reload-heal / escalate / crosstab cells tested the two-rung fallback
// ladder, which is RETIRED — the Mali program-binary poison it armed
// against is dead at the root (the Task-161 TF nonce in the library; the
// upstream twin issuetracker.google.com/issues/530857248). The keep-alive
// stays on its own merits: ONE WebGL2 context per page across backend
// toggles, an instant resurrect, no context churn).
//
// TWO cells on the live page (the renderer spoofed onto the real-GPU
// class, the capacities patched to the container's fast 16k):
//
//   A1. 'promotion' — THE GL→GL RE-BOOT KEEPS THE ONE CONTEXT: the flow
//      Auto (WebGPU) → WebGL2 (GL #1, jump to GPU Embers — the full TF
//      pipeline ON the first context) → WebGPU (the PARK) → WebGL2 (the
//      RESURRECT). The page must: never create a second GL context (the
//      hook's counter stays 1), re-attach THE SAME canvas element
//      (identity-tagged), log the RESURRECT line, and keep the embers
//      rendering WARM (the pixel readback — Task 162: the pixel-confirmed
//      self-check verdicts are gone with the ladder; the gate measures
//      the pixels itself).
//
//   A2. 'interlude' — THE WG INTERLUDE: the honest degradation + Task 153's
//      canvas-truth regression. While the GL park is hidden in the slot
//      (display:none, first in tree order) the LIVE canvas is the WebGPU
//      one: the boot's own "Canvas: WxH css-px" log line must report the
//      REAL viewport (the user's v153 field log carried a false
//      "Canvas: 0×0" — the pre-153 line queried the slot's first canvas,
//      the parked one), and the interlude must stay ALIVE (the WG frame
//      loop advancing + the demo's own burst events firing — the pixel
//      claim is deliberately NOT gated: this container's SwiftShader-WG
//      canvas presents white garbage to the compositor and reads
//      all-black through drawImage, both paths lie, see
//      t153-interlude-probe). Then the honest-degradation contract: the
//      container's SwiftShader WG boot transiently kills the parked GL
//      context (loss-then-restore ~1.5 s — a restored context's objects
//      are dead): the loss-event tracker (not isContextLost) discards the
//      park, a FRESH context is born, the demo re-makes and renders WARM
//      (the post-toggle-back GL leg is pixel-gated via the in-page
//      readback — the GL canvas's buffer reads back honestly). On a
//      healthy phone the interlude may leave the park alive (the
//      resurrect branch — machinery cell A1 proves); this cell proves the
//      OTHER branch stays honest instead of resurrecting a zombie.
import { join } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const root = '/home/z/my-project/rune'
const out = join(root, '.shots', 'task152')
mkdirSync(out, { recursive: true })
const port = Number(process.env.TASK152_PORT ?? 8160)
const EMERS_INDEX = 23

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url)
    let pathname = decodeURIComponent(url.pathname)
    if (pathname === '/') pathname = '/demo/'
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = Bun.file(join(root, pathname))
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    const ext = pathname.slice(pathname.lastIndexOf('.'))
    const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }
    let body = await file.text()
    if (pathname.endsWith('demos/gpuEmbers.js')) {
      const before = body
      body = body.replace(/const TF_CAPACITY = SOFTWARE_GL \? 16_000 : 160_000/, 'const TF_CAPACITY = 16000')
      if (body === before) { console.error('[task152] PATCH FAILED'); process.exit(1) }
    }
    return new Response(body, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})

function warmOf(png) {
  const { width: W, height: H, data } = png
  let w = 0
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4
    if (data[i] > 40 && data[i] > data[i + 1] * 1.15 && data[i + 1] > data[i + 2] * 1.05) w++
  }
  return { warm: +(100 * w / (W * H)).toFixed(3) }
}

/** A Node-side poll that SURVIVES the heal reload (page.evaluate throws
 *  when the execution context dies with the old document — retry). */
async function poll(page, fnSrc, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let lastErr = null
  while (Date.now() < deadline) {
    try {
      const v = await page.evaluate(`(${fnSrc})()`)
      if (v) return v
    } catch (e) { lastErr = String(e).slice(0, 120) }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`poll timeout (${label})${lastErr !== null ? ` last error: ${lastErr}` : ''}`)
}

/** Task 153 — THE IN-PAGE CANVAS READBACK: the compositor screenshot of a
 * SwiftShader-WebGPU canvas in this container tears into white raster
 * tiles (the page.screenshot path re-rasterizes the page; the muzzle
 * demo's sparse bursts also miss a 4-attempt screenshot window — the
 * Task-138 flake class). The drawing buffer is the ground truth:
 * drawImage the VISIBLE canvas onto a small 2D canvas and count warm
 * pixels, polling at 150 ms until warm or the deadline — fast enough to
 * land inside a muzzle burst. */
async function canvasWarm(page, timeoutMs = 12_000) {
  const readOnce = () => page.evaluate(() => {
    const all = [...document.querySelectorAll('canvas')]
    const visible = all.filter((c) => { const r = c.getBoundingClientRect(); return r.width > 1 && r.height > 1 })
    const c = visible.length > 0 ? visible[visible.length - 1] : (all.length > 0 ? all[all.length - 1] : null)
    if (c === null) return null
    try {
      const r = document.createElement('canvas')
      r.width = 240
      r.height = 160
      const g = r.getContext('2d', { willReadFrequently: true })
      g.drawImage(c, 0, 0, 240, 160)
      const d = g.getImageData(0, 0, 240, 160).data
      let warm = 0
      let bright = 0
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 40 && d[i] > d[i + 1] * 1.15 && d[i + 1] > d[i + 2] * 1.05) warm++
        if (d[i] + d[i + 1] + d[i + 2] > 120) bright++
      }
      return { warm: +(100 * warm / (240 * 160)).toFixed(3), bright: +(100 * bright / (240 * 160)).toFixed(3) }
    } catch (e) { return { err: String(e).slice(0, 80) } }
  })
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const v = await readOnce()
    if (v != null && !('err' in v)) {
      last = v
      if (v.warm > 0.05) return v
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  return last ?? { cold: true }
}

async function shot(page, tag) {
  let best = { starved: true }
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      // Task 153 — the VISIBLE canvas, not the first one: while a GL park
      // hides in the slot (display:none, first in tree order) the live
      // render target is the LAST canvas with a non-zero rect — a plain
      // querySelector('canvas') would clip a 0×0 parked element mid-
      // interlude. With a single canvas (every non-interlude shot) this
      // picks exactly what the old query picked.
      const clip = await page.evaluate(() => {
        const all = [...document.querySelectorAll('canvas')]
        const visible = all.filter((c) => { const r = c.getBoundingClientRect(); return r.width > 1 && r.height > 1 })
        const c = visible.length > 0 ? visible[visible.length - 1] : (all.length > 0 ? all[all.length - 1] : null)
        if (c === null) return null
        const r = c.getBoundingClientRect()
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
      })
      if (clip == null) break
      const path = join(out, `${tag}-${attempt}.png`)
      await page.screenshot({ path, clip, timeout: 30_000 })
      best = warmOf(PNG.sync.read(readFileSync(path)))
    } catch { break }
    if ((best.warm ?? -1) > 0.05) break
    await page.waitForTimeout(1200)
  }
  return best
}

async function jumpToEmbers(page) {
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('button')]
    rows.find((r) => (r.textContent ?? '').includes('GPU Embers'))?.click()
  })
}

async function toggle(page, mode) {
  // a programmatic radio click (the change event bubbles to the shell's
  // segment listener → onMode → boot) — no FAB/sheet visibility dance, and
  // it works regardless of which sheet is open
  await page.evaluate((m) => {
    const radio = document.querySelector(`input[name="rd-mode"][value="${m}"]`)
    if (radio != null) radio.click()
  }, mode)
}

// ─── The shared init scripts ───
// The GL context counter + the real-GPU renderer spoof. (Task 162: the
// zeroing predicate, the heal-reload tripwire and the reload counter died
// with the ladder — nothing on the page reacts to a degenerate readback
// or asks for a heal reload anymore.)
function installHooks(context) {
  return context.addInitScript(() => {
    const SPOOF_RENDERER = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)'
    const UNMASKED_RENDERER = 37446
    window.__fxGLContexts = 0
    let v = null
    Object.defineProperty(window, '__vfxPerf', {
      configurable: true,
      get: () => v,
      set: (nv) => { v = nv },
    })
    const orig = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      const ctx = orig.call(this, type, ...rest)
      if (type === 'webgl2' && ctx != null && !ctx.__fxHooked) {
        ctx.__fxHooked = true
        // only the RENDERER contexts count (a canvas IN the document at
        // getContext time) — the demo module's detached SOFTWARE_GL probe
        // canvas must not inflate the counter
        if (this.isConnected) window.__fxGLContexts++
        const origGetParameter = ctx.getParameter.bind(ctx)
        ctx.getParameter = (pname, ...pr) => (pname === UNMASKED_RENDERER ? SPOOF_RENDERER : origGetParameter(pname, ...pr))
      }
      return ctx
    }
  })
}

// ═══ Cell A1 — THE PROMOTION: the GL→GL re-boot keeps THE ONE context ═══
// The deterministic keep-alive proof. navigator.gpu is removed in the init
// script (the page's Auto boot resolves to WebGL2 — GL #1), GPU Embers
// runs the full TF pipeline on it, then the auto→WebGL2 radio switch
// re-boots the GL leg: the shell must PROMOTE the active renderer to the
// park and RESURRECT it — the SAME canvas element, the SAME context
// (fxContexts stays 1), the TF tier re-made and rendering warm (Task 162:
// the gate measures the warmth itself — the page's pixel-confirmed
// self-check verdicts are gone with the ladder).
async function promotionCell() {
  const context = await browser.newContext({ viewport: { width: 480, height: 320 } })
  await installHooks(context)
  await context.addInitScript(() => {
    // no WebGPU in this page: Auto resolves to WebGL2, and the auto→GL
    // toggle exercises the GL→GL PROMOTION path
    try { delete Navigator.prototype.gpu } catch { /* best-effort */ }
  })
  const page = await context.newPage()
  const consoleMsgs = []
  page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text().slice(0, 500)}`))
  page.on('pageerror', (e) => consoleMsgs.push('PAGEERROR: ' + String(e).slice(0, 220)))

  await page.goto(`http://localhost:${port}/demo/vfx/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForFunction(() => (document.querySelector('#backend')?.textContent ?? '').includes('WebGL2'), null, { timeout: 60_000 })
  await page.waitForTimeout(600)
  await jumpToEmbers(page)
  await page.waitForFunction(() => (window.__vfxPerf?.tier ?? '') === 'gpu', null, { timeout: 40_000 })
  // tag GL #1's canvas — the resurrect must re-use THIS element
  await page.evaluate(() => { const c = document.querySelector('canvas'); if (c !== null) c.__fxFirstGL = true })
  const before = await page.evaluate(() => ({ fxContexts: window.__fxGLContexts, keep: window.__vfxGLKeep ?? null }))

  // the auto→WebGL2 switch: a GL→GL re-boot — the promotion
  await toggle(page, 'webgl2')
  await page.waitForFunction(() => (window.__vfxPerf?.tier ?? '') === 'gpu', null, { timeout: 40_000 })
  const after = await poll(page, `() => {
    const c = document.querySelector('canvas')
    if (c === null) return null
    // wait for the resurrected tier to actually RUN (the canvas exists on
    // frame 1; the warm shot needs the swarm up)
    if ((window.__vfxFrame ?? 0) < 30) return null
    return {
      fxContexts: window.__fxGLContexts,
      sameCanvas: c !== null && c.__fxFirstGL === true,
      frames: window.__vfxFrame ?? 0,
      keep: window.__vfxGLKeep ?? null,
    }
  }`, 240_000, 'the promoted (resurrected) tier re-boots and runs').catch(async (e) => {
    const dump = await page.evaluate(() => ({
      perf: window.__vfxPerf ? { ...window.__vfxPerf } : null,
      fxContexts: window.__fxGLContexts,
      keep: window.__vfxGLKeep ?? null,
      keepLost: window.__vfxGLKeepLost ?? null,
      canvasTagged: (() => { const c = document.querySelector('canvas'); return c != null && c.__fxFirstGL === true })(),
      frame: window.__vfxFrame ?? 0,
      backend: document.querySelector('#backend')?.textContent ?? null,
      log: (document.querySelector('#log-list')?.textContent ?? '').slice(-600),
    })).catch((e2) => ({ crash: String(e2).slice(0, 200) }))
    console.log(`[task152] promotion FAILURE DUMP: ${JSON.stringify(dump, null, 1)}`)
    throw e
  })
  const pixels = await shot(page, 'promotion')
  const logText = await page.evaluate(() => document.querySelector('#log-list')?.textContent ?? '')
  const resurrectLine = /RESURRECTED/.test(logText)
  const parkLine = /Parking the WebGL2 context/.test(logText)

  console.log(`[task152] promotion: before ${JSON.stringify(before)} · after ${JSON.stringify(after)} · pixels ${JSON.stringify(pixels)}`)
  console.log(`[task152] promotion: resurrect line ${resurrectLine ? 'FIRED ✓' : 'MISSING'} · park line ${parkLine ? 'FIRED ✓' : 'MISSING'}`)

  const okContext = after.fxContexts === 1 && before.fxContexts === 1
  const okSameCanvas = after.sameCanvas === true
  const okWarm = (pixels.warm ?? -1) > 0.05 && after.frames >= 30
  const errs = consoleMsgs.filter((m) => m.startsWith('PAGEERROR'))
  if (errs.length > 0) { console.log(`[task152] promotion PAGE ERRORS: ${JSON.stringify(errs.slice(0, 4))}`); process.exitCode = 1 }
  await page.close()
  await context.close()
  return { okContext, okSameCanvas, okWarm, resurrectLine, parkLine, errs: errs.length === 0 }
}

// ═══ Cell A2 — THE WG INTERLUDE: the honest degradation ═══
// The container's live reality: a SwiftShader WebGPU renderer boot parked
// next to a live GL context TRANSIENTLY loses it (a driver-level event,
// loss-then-auto-restore within ~1.5 s — a restored context's objects are
// dead). The gate proves the GRACEFUL handling: the loss-event tracker
// (not isContextLost's current value — the restore masks it) discards the
// park, a FRESH context is born (a browser-driven loss is NOT our
// disposal — the keep-alive continues), the demo re-makes and renders
// WARM. On the reporting phone the WG interlude may well leave the park
// alive (the resurrect branch — the machinery cell A1 proves); this cell
// proves the OTHER branch stays honest instead of resurrecting a zombie.
async function wgInterludeCell() {
  const context = await browser.newContext({ viewport: { width: 480, height: 320 } })
  // a healthy-driver interlude: the degradation (the transient parked
  // loss), not a poisoned readback, is what this cell tests
  await installHooks(context)
  const page = await context.newPage()
  const consoleMsgs = []
  page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text().slice(0, 500)}`))
  page.on('pageerror', (e) => consoleMsgs.push('PAGEERROR: ' + String(e).slice(0, 220)))

  await page.goto(`http://localhost:${port}/demo/vfx/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(1200)
  // the user's flow on the muzzle demo (demo 0 — the CPU-cheap tier; the
  // warm verdict does not depend on the slow full-pipeline raster here)
  await toggle(page, 'webgl2')
  await page.waitForFunction(() => (document.querySelector('#backend')?.textContent ?? '').includes('WebGL2'), null, { timeout: 40_000 })
  await page.waitForTimeout(1200)

  await toggle(page, 'webgpu')
  await page.waitForFunction(() => (document.querySelector('#backend')?.textContent ?? '') === 'WebGPU', null, { timeout: 60_000 })
  const parked = await page.evaluate(() => ({ keep: window.__vfxGLKeep ?? null, lost: window.__vfxGLKeepLost ?? null }))
  await page.waitForTimeout(2500) // let the transient loss land (and restore — the tracker keeps the flag)

  // Task 153 — THE CANVAS TRUTH OF THE INTERLUDE: the LAST "Canvas:" line
  // is the WG boot's own report — it must read the REAL viewport (480×320),
  // never the parked hidden canvas's 0×0 (the user's v153 field log). The
  // WG leg's LIVENESS is the honest measurable here: this container's
  // SwiftShader-WebGPU canvas presents WHITE garbage to the compositor
  // (page.screenshot) and reads all-black through drawImage — BOTH pixel
  // paths lie (the t153-interlude-probe ground truth: the loop runs at
  // ~40 fps, the Sentry Turret keeps bursting through the interlude, zero
  // page errors), so "warm pixels" is not a measurable claim for the WG
  // leg in-container. The measurable truth: the WG frame loop keeps
  // advancing AND the demo's own burst events keep firing (the turret
  // logs them — the log caps at 400 entries, far above this cell's use).
  const interludeCanvasLine = await page.evaluate(() => {
    const log = document.querySelector('#log-list')?.textContent ?? ''
    const lines = log.match(/Canvas: \d+×\d+ css-px/g) ?? []
    return lines.length > 0 ? lines[lines.length - 1] : null
  })
  const aliveA = await page.evaluate(() => ({ frames: window.__vfxFrame ?? 0, bursts: ((document.querySelector('#log-list')?.textContent ?? '').match(/sentry (?:burst|BEAM)/g) ?? []).length }))
  await page.waitForTimeout(3000)
  const aliveB = await page.evaluate(() => ({ frames: window.__vfxFrame ?? 0, bursts: ((document.querySelector('#log-list')?.textContent ?? '').match(/sentry (?:burst|BEAM)/g) ?? []).length }))
  const okCanvasLine = interludeCanvasLine === 'Canvas: 480×320 css-px'
  const okInterludeAlive = aliveB.frames - aliveA.frames > 60 && aliveB.bursts > aliveA.bursts
  console.log(`[task152] interlude: the WG boot's canvas line ${interludeCanvasLine ?? 'MISSING'} ${okCanvasLine ? '✓ (the real viewport, not the parked 0×0)' : 'WRONG'} · interlude liveness: frames ${aliveA.frames}→${aliveB.frames}, bursts ${aliveA.bursts}→${aliveB.bursts}`)

  await toggle(page, 'webgl2')
  await page.waitForFunction(() => (document.querySelector('#backend')?.textContent ?? '').includes('WebGL2'), null, { timeout: 60_000 })
  const after = await poll(page, `() => {
    const c = document.querySelector('canvas')
    if (c === null) return null
    return {
      fxContexts: window.__fxGLContexts,
      keep: window.__vfxGLKeep ?? null,
      frames: window.__vfxFrame ?? 0,
    }
  }`, 60_000, 'the post-interlude GL leg boots')
  await page.waitForTimeout(3500) // the fresh muzzle instance renders
  // Task 153 — the muzzle burst needs the 150 ms readback poll, not 4
  // screenshot attempts (the Task-138 sampling flake class — the shot
  // caught 0.043% vs the 0.05 threshold on the first runs of this cell)
  const readback = await canvasWarm(page, 12_000)
  const logText = await page.evaluate(() => document.querySelector('#log-list')?.textContent ?? '')
  const discardLine = /parked WebGL2 context was lost while idle/.test(logText)
  const parkLine = /Parking the WebGL2 context/.test(logText)

  console.log(`[task152] interlude: parked ${JSON.stringify(parked)} · after ${JSON.stringify(after)} · readback ${JSON.stringify(readback)}`)
  console.log(`[task152] interlude: park line ${parkLine ? 'FIRED ✓' : 'MISSING'} · discard line ${discardLine ? 'FIRED ✓' : 'MISSING (the park survived — the resurrect branch, also valid)'}`)

  // EITHER branch is honest: the resurrect (contexts stay 1 — the park
  // survived, e.g. on a real phone) or the discard (contexts 2 + the
  // discard line — the container's SwiftShader reality). Both must render
  // (the in-page readback).
  const branch = after.fxContexts === 1 ? 'resurrect' : after.fxContexts === 2 && discardLine ? 'discard' : 'INVALID'
  const okWarm = (readback?.warm ?? -1) > 0.05 && after.frames > 30
  const okBranch = branch !== 'INVALID'
  const errs = consoleMsgs.filter((m) => m.startsWith('PAGEERROR'))
  if (errs.length > 0) { console.log(`[task152] interlude PAGE ERRORS: ${JSON.stringify(errs.slice(0, 4))}`); process.exitCode = 1 }
  await page.close()
  await context.close()
  return { branch, okBranch, okWarm, parkLine, okCanvasLine, okInterludeAlive, errs: errs.length === 0 }
}

const only = process.env.TASK152_CELL
const results = {}
if (only === undefined || only === 'promotion') results.promotion = await promotionCell()
if (only === undefined || only === 'interlude') results.interlude = await wgInterludeCell()

console.log('── THE VERDICTS ──')
let ok = true
const pr = results.promotion ?? { okContext: false, okSameCanvas: false, okWarm: false, resurrectLine: false, parkLine: false, errs: true }
{
  const pass = pr.okContext && pr.okSameCanvas && pr.okWarm && pr.resurrectLine && pr.parkLine && pr.errs
  if (!pass) ok = false
  console.log(`promotion (GL→GL re-boot, ONE context, TF warm): ${pass ? 'PASS ✓' : `FAIL ${JSON.stringify(pr)}`}`)
}
const il = results.interlude ?? { branch: 'INVALID', okBranch: false, okWarm: false, parkLine: false, okCanvasLine: false, okInterludeAlive: false, errs: true }
{
  const pass = il.okBranch && il.okWarm && il.parkLine && il.okCanvasLine && il.okInterludeAlive && il.errs
  if (!pass) ok = false
  console.log(`interlude (WG park → canvas line truthful + interlude alive → the honest ${il.branch} branch, warm): ${pass ? 'PASS ✓' : `FAIL ${JSON.stringify(il)}`}`)
}
console.log(ok ? '[task152] PASS — the session keeps ONE WebGL2 context across backend cycles (park + resurrect), the canvas-truth line stays honest through a WG interlude, and both interlude branches (resurrect or honest discard) render warm' : '[task152] FAIL — see above')
if (!ok) process.exitCode = 1

await browser.close()
server.stop(true)
