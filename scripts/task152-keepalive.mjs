// task152 — THE GL CONTEXT KEEP-ALIVE + THE RELOAD CROSSING (Task 152: the
// 13:27 live log's verdict — the drop follows the session's GL-context
// CREATION history: the first WebGL2 context of a page renders the full TF
// pipeline clean, every context born after a prior GL dispose is born
// dead).
//
// THREE cells on the live page (the renderer spoofed onto the real-GPU
// class, the capacities patched to the container's fast 16k):
//
//   A1. 'promotion' — THE USER'S EXACT FLOW, poisoned-driver simulation:
//      the zeroing predicate (getBufferSubData AND readPixels — both
//      halves of the pixel-confirmed verdict) fires ONLY when the page's
//      WebGL2 CONTEXT COUNT exceeds one (the born-dead second context —
//      exactly what the old flow produced on every WG→GL→WG→GL cycle).
//      The flow: Auto (WebGPU) → WebGL2 (GL #1, jump to GPU Embers — the
//      full pipeline ON the first context) → WebGPU (the PARK) → WebGL2
//      (the RESURRECT). The page must: never create a second GL context
//      (the hook's counter stays 1), re-attach THE SAME canvas element
//      (identity-tagged), log the RESURRECT line, keep the embers WARM
//      (the predicate never matches — GL #1 is the clean cell), verdict
//      pixelCheck 'warm', and never touch the heal reload (the stub is a
//      tripwire). With the OLD dispose-per-toggle flow this cell would
//      reproduce the user's black screen — GL #2 would be born dead.
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
//      readback — the GL canvas's buffer reads back honestly). On the
//      reporting phone the interlude may leave the park alive (the
//      resurrect branch — machinery cell A1 proves); this cell proves the
//      OTHER branch stays honest instead of resurrecting a zombie.
//
//   B. 'reload-heal' — THE DEFAULT LADDER, end-to-end: the predicate
//      zeroes EVERY GPU-tier verdict (the task140p signature). The flow:
//      WebGL2 (GL #1) → GPU Embers → the level-0 pixel-confirmed verdict
//      → the RELOAD CROSSING: the warn names the page boundary, the
//      sessionStorage marker carries { v:1, rung:1, demo:23 }, the reload
//      (stubbed the first time — the gate verifies the marker, then fires
//      the REAL reload itself) → the fresh page: the "GL heal" event
//      line, the forced WebGL2 boot, rung 1 pinned (perf.fallback 'tf',
//      emit 'cpu', cull false) → its own verdict drops (the predicate
//      still matches the GPU tier) → rung 2 IN-PAGE (the CPU tier, warm —
//      the zeroing never matches tier 'cpu') → NO second reload (the
//      sessionStorage reload counter pins at 2 — loop-free by
//      construction) → Task 155: the level-1 verdict must ALSO have
//      ARMED the rung-2 DEVICE verdict in localStorage (the next reload
//      AND every fresh tab of this browser land the CPU floor directly).
//
//   C. 'escalate' — Task 154/155, THE DEVICE VERDICT (the v154 field
//      verdict: on the reporting phone the poison SURVIVES page reloads —
//      rung 1 dropped on five-plus consecutive fresh pages; the v155
//      field log added the worse half: every FRESH TAB re-ran the whole
//      doomed circus too, because the verdict lived in per-tab
//      sessionStorage). The verdict is localStorage now; these legs run
//      the no-WebGPU device class (the init script deletes
//      Navigator.prototype.gpu — auto boots straight into WebGL2):
//      C1 'direct' — a fresh rung-2 verdict (seeded as a legacy v155
//      session marker, exercising the HARVEST path): the page boots the
//      CPU tier with NO GPU attempt (no verdict WARNs, pixelCheck 'off',
//      ONE GL context, loop-free), the heal event names the device
//      verdict + the CPU floor, the harvest persisted the verdict with
//      the SAME `at`, and the session marker is GONE (localStorage is the
//      memory now), warm.
//      C2 'reprobe' — the device verdict aged past VERDICT_TTL (patched
//      to ~7 h old): the reload lands rung 1 (the heal event names the
//      RE-PROBE), the predicate still drops the GPU tier → the in-page
//      CPU fallback AND a FRESH rung-2 verdict (a new `at`).
//      C3 'recovery' — a CLEAN driver (the predicate never drops): a
//      stale rung-2 verdict → the re-probe lands rung 1 → verdicts WARM
//      → the verdict DOWNGRADES to rung 1 (the standing knowledge: level 0
//      dead, the rung alive — the next reload keeps the 160k conservative
//      tier; the full ladder re-opens only when rung 1 ages out).
//   D. 'crosstab' — Task 155, THE HEADLINE (the reporting user's exact
//      complaint: every fresh tab = the circus): page A runs the REAL
//      full ladder on a poisoned driver (level-0 → the crossing reload →
//      rung-1 drop → the CPU floor + the rung-2 device verdict), then
//      DIES. Page B — a FRESH TAB of the same browser (sessionStorage
//      empty, localStorage carried): boots with the device-verdict heal
//      event, the WG-capable default runs the compute tier (the verdict
//      does NOT hijack the boot mode), and ONE WebGL2 toggle lands the
//      CPU floor INSTANTLY — zero verdict WARNs since the tab opened,
//      zero reloads, ONE GL context, warm pixels. The circus is over.
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
      body = body.replace(/const FALLBACK_CAPACITY = SOFTWARE_GL \? 16_000 : COARSE \? 32_000 : GPU_CAPACITY/, 'const FALLBACK_CAPACITY = 16000')
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
  await page.evaluate((idx) => {
    const rows = [...document.querySelectorAll('button')]
    rows.find((r) => (r.textContent ?? '').includes('GPU Embers'))?.click()
    if (idx >= 0) { /* the marker path needs no click — the demo index rides the marker */ }
  }, -1)
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
// The zeroing predicate + the GL context counter + the reload tripwire.
function installHooks(context, predicateSrc) {
  return context.addInitScript((predSrc) => {
    const predicate = eval(predSrc)
    // the heal-reload tripwire: STUB the reload (cell B verifies the
    // marker, then fires the real reload itself; cell A asserts it never
    // fires)
    window.__vfxHealReload = () => { window.__vfxHealStubbed = true }
    // the page-reload counter (the loop guard's ground truth)
    try {
      const n = Number(sessionStorage.getItem('fxReloads') ?? '0') + 1
      sessionStorage.setItem('fxReloads', String(n))
    } catch { /* storage-less — the loop guard degrades to the warn text */ }
    let v = null
    Object.defineProperty(window, '__vfxPerf', {
      configurable: true,
      get: () => v,
      set: (nv) => { v = nv },
    })
    const SPOOF_RENDERER = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)'
    const UNMASKED_RENDERER = 37446
    window.__fxGLContexts = 0
    const orig = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      const ctx = orig.call(this, type, ...rest)
      if (type === 'webgl2' && ctx != null && !ctx.__fxHooked) {
        ctx.__fxHooked = true
        // only the RENDERER contexts count (a canvas IN the document at
        // getContext time) — the demo module's detached SOFTWARE_GL probe
        // canvas must not poison the born-dead predicate's ordinal
        if (this.isConnected) window.__fxGLContexts++
        const origGetParameter = ctx.getParameter.bind(ctx)
        ctx.getParameter = (pname, ...pr) => (pname === UNMASKED_RENDERER ? SPOOF_RENDERER : origGetParameter(pname, ...pr))
        const drop = () => {
          const p = window.__vfxPerf
          return p != null && predicate(p)
        }
        const origGetBuf = ctx.getBufferSubData.bind(ctx)
        ctx.getBufferSubData = (target, srcByteOffset, dst) => {
          const r = origGetBuf(target, srcByteOffset, dst)
          if (dst instanceof Float32Array && drop()) dst.fill(0)
          return r
        }
        const origRp = ctx.readPixels.bind(ctx)
        ctx.readPixels = (x, y, w, h, format, type, dst) => {
          const r = origRp(x, y, w, h, format, type, dst)
          if (dst instanceof Uint8Array && drop()) dst.fill(0)
          return r
        }
      }
      return ctx
    }
  }, predicateSrc)
}

// ═══ Cell A1 — THE PROMOTION: the GL→GL re-boot keeps THE ONE context ═══
// The deterministic keep-alive proof. navigator.gpu is removed in the init
// script (the page's Auto boot resolves to WebGL2 — GL #1), GPU Embers
// runs the full TF pipeline on it, then the auto→WebGL2 radio switch
// re-boots the GL leg: the shell must PROMOTE the active renderer to the
// park and RESURRECT it — the SAME canvas element, the SAME context
// (fxContexts stays 1), the TF tier re-made and verdicting warm. The
// born-dead predicate (contexts > 1) stays silent — no second context is
// ever born.
async function promotionCell() {
  const context = await browser.newContext({ viewport: { width: 480, height: 320 } })
  await installHooks(context, `(p) => window.__fxGLContexts > 1`)
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
    if (window.__vfxPerf?.pixelCheck !== 'warm') return null
    const c = document.querySelector('canvas')
    return {
      fxContexts: window.__fxGLContexts,
      sameCanvas: c !== null && c.__fxFirstGL === true,
      pixelCheck: window.__vfxPerf.pixelCheck,
      fallback: window.__vfxPerf.fallback ?? null,
      healStubbed: window.__vfxHealStubbed === true,
    }
  }`, 240_000, 'the promoted (resurrected) tier verdicts warm').catch(async (e) => {
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
  const okWarm = (pixels.warm ?? -1) > 0.05 && after.pixelCheck === 'warm'
  const okNoHeal = after.healStubbed === false
  const okNoFallback = after.fallback === null || after.fallback === undefined
  const errs = consoleMsgs.filter((m) => m.startsWith('PAGEERROR'))
  if (errs.length > 0) { console.log(`[task152] promotion PAGE ERRORS: ${JSON.stringify(errs.slice(0, 4))}`); process.exitCode = 1 }
  await page.close()
  await context.close()
  return { okContext, okSameCanvas, okWarm, okNoHeal, okNoFallback, resurrectLine, parkLine, errs: errs.length === 0 }
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
  // NO zeroing predicate: a healthy-driver interlude (the degradation —
  // not the born-dead class — is what this cell tests)
  await installHooks(context, `(p) => false`)
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

// ═══ Cell B — the default ladder crosses the page boundary ═══
async function reloadHealCell() {
  const context = await browser.newContext({ viewport: { width: 480, height: 320 } })
  // the task140p signature: EVERY GPU-tier verdict reads degenerate+black
  await installHooks(context, `(p) => p.tier === 'gpu'`)
  const page = await context.newPage()
  const consoleMsgs = []
  page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text().slice(0, 700)}`))
  page.on('pageerror', (e) => consoleMsgs.push('PAGEERROR: ' + String(e).slice(0, 220)))

  await page.goto(`http://localhost:${port}/demo/vfx/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(1200)
  await toggle(page, 'webgl2')
  await page.waitForFunction(() => (document.querySelector('#backend')?.textContent ?? '').includes('WebGL2'), null, { timeout: 40_000 })
  await jumpToEmbers(page)
  await page.waitForFunction(() => (window.__vfxPerf?.tier ?? '') === 'gpu', null, { timeout: 40_000 })

  // the level-0 verdict → the reload crossing (the reload is STUBBED:
  // verify the marker, then fire the real one)
  const marker = await poll(page, `() => {
    if (window.__vfxHealStubbed !== true) return null
    try { return sessionStorage.getItem('rune:vfx:glheal') } catch { return 'NO_STORAGE' }
  }`, 300_000, 'the level-0 verdict crosses to the heal marker')
  const healWarn = consoleMsgs.find((m) => m.includes('ACROSS A PAGE RELOAD'))
  const walkWarn = consoleMsgs.find((m) => m.includes('ISOLATION WALK'))
  console.log(`[task152] reload-heal: marker ${String(marker).slice(0, 220)}`)
  console.log(`[task152] reload-heal: the crossing warn ${healWarn != null ? 'FIRED ✓' : 'MISSING'} · the auto-walk ${walkWarn != null ? 'FIRED (WRONG — default must not walk)' : 'silent ✓'}`)

  // fire the REAL reload — the marker's landing is main.js's module-scope read
  await page.evaluate(() => { location.reload() })
  await page.waitForLoadState('domcontentloaded', { timeout: 120_000 }).catch(() => { })
  console.log('[task152] reload-heal: the fresh document landed (domcontentloaded)')
  // the fresh page: the GL heal event line + the forced WebGL2 boot at
  // rung 1 → its own verdict → the CPU tier IN-PAGE (no second crossing)
  const landed = await poll(page, `() => {
    const p = window.__vfxPerf
    if (p == null || p.tier !== 'cpu') return null
    return {
      tier: p.tier, fallback: p.fallback, capacity: p.capacity,
      healEvent: /GL heal: the reload crossing landed/.test(document.querySelector('#log-list')?.textContent ?? ''),
      glContexts: window.__fxGLContexts,
      reloadedTwice: (() => { try { return Number(sessionStorage.getItem('fxReloads') ?? '0') } catch { return -1 } })(),
    }
  }`, 300_000, 'the fresh page lands the CPU tier').catch(async (e) => {
    const dump = await page.evaluate(`(() => {
      const p = window.__vfxPerf
      return {
        perf: p != null ? { ...p } : null,
        fxContexts: window.__fxGLContexts,
        fallbackFlag: window.__embersFallback ?? 0,
        frame: window.__vfxFrame ?? 0,
        url: location.href,
        reloads: (() => { try { return sessionStorage.getItem('fxReloads') } catch { return 'x' } })(),
        log: (document.querySelector('#log-list')?.textContent ?? '').slice(-500),
      }
    })()`).catch((e2) => ({ crash: String(e2).slice(0, 200) }))
    console.log(`[task152] reload-heal FAILURE DUMP: ${JSON.stringify(dump, null, 1)}`)
    throw e
  })
  await page.waitForTimeout(4000) // the loop guard: no further reloads
  const reloadsAfter = await page.evaluate(() => { try { return Number(sessionStorage.getItem('fxReloads') ?? '0') } catch { return -1 } })
  // Task 155 — the level-1 verdict (the in-page CPU fallback above) must
  // have ARMED the rung-2 DEVICE verdict in localStorage: this browser's
  // next reload AND every fresh tab land the CPU floor directly instead
  // of re-running the doomed level-0 → level-1 cycle. The session marker
  // stays GONE (localStorage is the memory now — no per-reload re-arm).
  const marker2 = await page.evaluate(() => { try { return localStorage.getItem('rune:vfx:glverdict') } catch { return 'NO_STORAGE' } })
  const sessionMarker2 = await page.evaluate(() => { try { return sessionStorage.getItem('rune:vfx:glheal') } catch { return 'NO_STORAGE' } })
  let marker2Ok = false
  try {
    const m2 = JSON.parse(String(marker2))
    marker2Ok = m2.v === 1 && m2.rung === 2 && m2.demo === EMERS_INDEX && typeof m2.why === 'string' && m2.why.length > 0 && typeof m2.at === 'number' && m2.at > 0 && typeof m2.major === 'number'
  } catch { marker2Ok = false }
  const sessionGone = sessionMarker2 === null
  console.log(`[task152] reload-heal: the Task-155 rung-2 device verdict ${marker2Ok ? 'ARMED ✓' : `MISSING/BAD — ${String(marker2).slice(0, 200)}`} · the session marker ${sessionGone ? 'consumed ✓' : `LINGERS (WRONG) — ${String(sessionMarker2).slice(0, 160)}`}`)
  const pixels = await shot(page, 'reload-heal')

  console.log(`[task152] reload-heal: landed ${JSON.stringify(landed)} · reloads after the settle ${reloadsAfter} · pixels ${JSON.stringify(pixels)}`)

  let markerOk = false
  try {
    const m = JSON.parse(String(marker))
    markerOk = m.v === 1 && m.rung === 1 && m.demo === EMERS_INDEX && typeof m.why === 'string' && m.why.length > 0
  } catch { markerOk = false }
  const okLanding = landed.tier === 'cpu' && landed.fallback === 'cpu' && landed.capacity === 16000
  const okHealEvent = landed.healEvent === true
  const okOneContext = landed.glContexts === 1
  const okLoopFree = reloadsAfter === landed.reloadedTwice && reloadsAfter === 2
  const okWarm = (pixels.warm ?? -1) > 0.05
  const okNoAutoWalk = walkWarn == null
  const errs = consoleMsgs.filter((m) => m.startsWith('PAGEERROR'))
  if (errs.length > 0) { console.log(`[task152] reload-heal PAGE ERRORS: ${JSON.stringify(errs.slice(0, 4))}`); process.exitCode = 1 }
  await page.close()
  await context.close()
  return { markerOk, marker2Ok, sessionGone, healWarn: healWarn != null, okLanding, okHealEvent, okOneContext, okLoopFree, okWarm, okNoAutoWalk, errs: errs.length === 0 }
}

// ═══ Cell C — Task 154/155: the device verdict (the direct landing + the re-probe) ═══
async function escalationCell() {
  const out = { directOk: false, rearmOk: false, sessionGoneOk: false, reprobeOk: false, freshVerdictOk: false, recoveryOk: false, warmOk: false, errs: true }

  // ── C1 + C2: the poisoned driver (the task140p signature) ──
  {
    const context = await browser.newContext({ viewport: { width: 480, height: 320 } })
    // Task 155 — the no-WebGPU device class: auto boots straight into
    // WebGL2 (the device-verdict landing must NOT depend on a WG detour)
    await context.addInitScript(() => { try { delete Navigator.prototype.gpu } catch { /* best-effort */ } })
    await installHooks(context, `(p) => p.tier === 'gpu'`)
    const page = await context.newPage()
    const consoleMsgs = []
    page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text().slice(0, 700)}`))
    page.on('pageerror', (e) => consoleMsgs.push('PAGEERROR: ' + String(e).slice(0, 220)))

    await page.goto(`http://localhost:${port}/demo/vfx/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(1500) // the plain flow settles (demo 0 — a CPU-tier make, no GPU verdict)
    // seed a FRESH legacy-v155 rung-2 SESSION marker (the simulated previous
    // page's level-1 verdict, pre-Task-155 format) — C1 exercises the
    // HARVEST: the fresh page promotes it into the device verdict
    const seededAt = await page.evaluate(() => {
      const at = Date.now()
      sessionStorage.setItem('rune:vfx:glheal', JSON.stringify({ v: 1, rung: 2, demo: 23, at, why: 'the gate seed — a simulated level-1 verdict (the conservative tier dropped across a reload)' }))
      return at
    })
    const markC1 = consoleMsgs.length
    await page.evaluate(() => { location.reload() })
    await page.waitForLoadState('domcontentloaded', { timeout: 120_000 }).catch(() => { })

    const direct = await poll(page, `() => {
      const p = window.__vfxPerf
      if (p == null || p.tier !== 'cpu' || p.fallback !== 'cpu') return null
      return {
        tier: p.tier, fallback: p.fallback, capacity: p.capacity, pixelCheck: p.pixelCheck,
        healR2: /GL heal: the device verdict remembered \\(rung 2, demo 23\\)[\\s\\S]*CPU floor DIRECTLY/.test(document.querySelector('#log-list')?.textContent ?? ''),
        glContexts: window.__fxGLContexts,
        verdict: (() => { try { return localStorage.getItem('rune:vfx:glverdict') } catch { return 'NO_STORAGE' } })(),
        session: (() => { try { return sessionStorage.getItem('rune:vfx:glheal') } catch { return 'NO_STORAGE' } })(),
      }
    }`, 300_000, 'the rung-2 device verdict lands the CPU floor directly').catch(async (e) => {
      const dump = await page.evaluate(`(() => ({ perf: window.__vfxPerf ?? null, fxContexts: window.__fxGLContexts, fallbackFlag: window.__embersFallback ?? 0, log: (document.querySelector('#log-list')?.textContent ?? '').slice(-600) }))()`).catch((e2) => ({ crash: String(e2).slice(0, 200) }))
      console.log(`[task152] escalate-direct FAILURE DUMP: ${JSON.stringify(dump, null, 1)}`)
      throw e
    })
    await page.waitForTimeout(4000) // the loop guard: a CPU-direct page never verdicts, never reloads
    const reloadsAfterDirect = await page.evaluate(() => { try { return Number(sessionStorage.getItem('fxReloads') ?? '0') } catch { return -1 } })
    const pixelsDirect = await shot(page, 'escalate-direct')
    const verdictWarnsC1 = consoleMsgs.slice(markC1).filter((m) => m.includes('Falling back ONCE') || m.includes('ACROSS A PAGE RELOAD') || m.includes('DEGENERATE'))

    let rearm = null
    try { rearm = JSON.parse(String(direct.verdict)) } catch { rearm = null }
    out.directOk = direct.tier === 'cpu' && direct.fallback === 'cpu' && direct.capacity === 16000
      && direct.pixelCheck === 'off' && direct.healR2 === true && direct.glContexts === 1
      && reloadsAfterDirect === 2 && verdictWarnsC1.length === 0
    // the HARVEST: the legacy session marker became the device verdict
    // verbatim (the SAME verdict `at` — the clock ticks from the verdict,
    // not from the landings), and the session marker is consumed
    out.rearmOk = rearm !== null && rearm.rung === 2 && rearm.at === seededAt
    out.sessionGoneOk = direct.session === null
    out.warmOk = (pixelsDirect.warm ?? -1) > 0.05
    console.log(`[task152] escalate-direct: ${JSON.stringify({ tier: direct.tier, fallback: direct.fallback, capacity: direct.capacity, pixelCheck: direct.pixelCheck, healR2: direct.healR2, gl: direct.glContexts, reloads: reloadsAfterDirect, verdictWarns: verdictWarnsC1.length })} · device verdict at ${rearm?.at} (harvested from the seed ${seededAt}) · session marker ${direct.session === null ? 'consumed ✓' : 'LINGERS (WRONG)'} · pixels ${JSON.stringify(pixelsDirect)}`)

    // C2 — age the device verdict past the ~6 h TTL, reload: the re-probe
    const patchedAt = await page.evaluate(() => {
      const m = JSON.parse(localStorage.getItem('rune:vfx:glverdict'))
      const at = Date.now() - 7 * 60 * 60_000
      m.at = at
      localStorage.setItem('rune:vfx:glverdict', JSON.stringify(m))
      return at
    })
    const markC2 = consoleMsgs.length
    await page.evaluate(() => { location.reload() })
    await page.waitForLoadState('domcontentloaded', { timeout: 120_000 }).catch(() => { })
    const reprobe = await poll(page, `() => {
      const p = window.__vfxPerf
      if (p == null || p.tier !== 'cpu' || p.fallback !== 'cpu') return null
      return {
        tier: p.tier, fallback: p.fallback, capacity: p.capacity,
        healProbe: /RE-PROBE/.test(document.querySelector('#log-list')?.textContent ?? ''),
        verdict: (() => { try { return localStorage.getItem('rune:vfx:glverdict') } catch { return 'NO_STORAGE' } })(),
      }
    }`, 300_000, 'the stale rung-2 verdict re-probes rung 1, which drops to the CPU floor in-page').catch(async (e) => {
      const dump = await page.evaluate(`(() => ({ perf: window.__vfxPerf ?? null, fallbackFlag: window.__embersFallback ?? 0, log: (document.querySelector('#log-list')?.textContent ?? '').slice(-700) }))()`).catch((e2) => ({ crash: String(e2).slice(0, 200) }))
      console.log(`[task152] escalate-reprobe FAILURE DUMP: ${JSON.stringify(dump, null, 1)}`)
      throw e
    })
    await page.waitForTimeout(4000) // the loop guard
    const reloadsAfterReprobe = await page.evaluate(() => { try { return Number(sessionStorage.getItem('fxReloads') ?? '0') } catch { return -1 } })
    const fallbackWarnC2 = consoleMsgs.slice(markC2).filter((m) => m.includes('Falling back ONCE')).length
    let fresh = null
    try { fresh = JSON.parse(String(reprobe.verdict)) } catch { fresh = null }
    out.reprobeOk = reprobe.tier === 'cpu' && reprobe.fallback === 'cpu' && reprobe.healProbe === true
      && fallbackWarnC2 >= 1 && reloadsAfterReprobe === 3
    out.freshVerdictOk = fresh !== null && fresh.rung === 2 && typeof fresh.at === 'number' && fresh.at > patchedAt + 6 * 60 * 60_000
    const errs1 = consoleMsgs.filter((m) => m.startsWith('PAGEERROR'))
    if (errs1.length > 0) { console.log(`[task152] escalate C1/C2 PAGE ERRORS: ${JSON.stringify(errs1.slice(0, 4))}`); process.exitCode = 1; out.errs = false }
    console.log(`[task152] escalate-reprobe: ${JSON.stringify({ tier: reprobe.tier, fallback: reprobe.fallback, healProbe: reprobe.healProbe, fallbackWarn: fallbackWarnC2, reloads: reloadsAfterReprobe })} · fresh device verdict at ${fresh?.at} vs patched ${patchedAt}`)
    await page.close()
    await context.close()
  }

  // ── C3: the recovery door — a CLEAN driver + a stale rung-2 verdict ──
  {
    const context = await browser.newContext({ viewport: { width: 480, height: 320 } })
    // the no-WebGPU device class (auto boots straight into WebGL2)
    await context.addInitScript(() => { try { delete Navigator.prototype.gpu } catch { /* best-effort */ } })
    await installHooks(context, `(p) => false`) // the healed driver: nothing ever drops
    const page = await context.newPage()
    const consoleMsgs = []
    page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text().slice(0, 700)}`))
    page.on('pageerror', (e) => consoleMsgs.push('PAGEERROR: ' + String(e).slice(0, 220)))
    await page.goto(`http://localhost:${port}/demo/vfx/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(1500)
    // seed a STALE rung-2 device verdict (7 h old — past the ~6 h TTL, the
    // re-probe window is open)
    const staleAt = await page.evaluate(() => {
      const major = Number((/(?:Chrome|Chromium)\/(\d+)/.exec(navigator.userAgent) ?? [])[1] ?? 0)
      const at = Date.now() - 7 * 60 * 60_000
      localStorage.setItem('rune:vfx:glverdict', JSON.stringify({ v: 1, rung: 2, demo: 23, at, major, why: 'the gate seed — a stale level-1 verdict (the re-probe window is open)' }))
      return at
    })
    await page.evaluate(() => { location.reload() })
    await page.waitForLoadState('domcontentloaded', { timeout: 120_000 }).catch(() => { })
    const recovery = await poll(page, `() => {
      const p = window.__vfxPerf
      if (p == null || p.tier !== 'gpu' || p.fallback !== 'tf' || p.pixelCheck !== 'warm') return null
      return {
        tier: p.tier, fallback: p.fallback, pixelCheck: p.pixelCheck,
        healProbe: /RE-PROBE/.test(document.querySelector('#log-list')?.textContent ?? ''),
        verdict: (() => { try { return localStorage.getItem('rune:vfx:glverdict') } catch { return 'NO_STORAGE' } })(),
      }
    }`, 300_000, 'the clean re-probe verdicts the conservative tier WARM').catch(async (e) => {
      const dump = await page.evaluate(`(() => ({ perf: window.__vfxPerf ?? null, fallbackFlag: window.__embersFallback ?? 0, log: (document.querySelector('#log-list')?.textContent ?? '').slice(-700) }))()`).catch((e2) => ({ crash: String(e2).slice(0, 200) }))
      console.log(`[task152] escalate-recovery FAILURE DUMP: ${JSON.stringify(dump, null, 1)}`)
      throw e
    })
    // THE RECOVERY DOOR, Task 155 semantics: a WARM conservative tier
    // DOWNGRADES the device verdict to rung 1 with a FRESH `at` (the
    // standing knowledge: level 0 dead, the rung alive — the next reload
    // keeps the 160k conservative tier directly; the full ladder re-opens
    // only when rung 1 itself ages out ~6 h later)
    let recovered = null
    try { recovered = JSON.parse(String(recovery.verdict)) } catch { recovered = null }
    const verdictDowngraded = recovered !== null && recovered.rung === 1 && typeof recovered.at === 'number' && recovered.at > staleAt
    out.recoveryOk = recovery.tier === 'gpu' && recovery.fallback === 'tf' && recovery.pixelCheck === 'warm' && recovery.healProbe === true && verdictDowngraded
    const errs2 = consoleMsgs.filter((m) => m.startsWith('PAGEERROR'))
    if (errs2.length > 0) { console.log(`[task152] escalate-recovery PAGE ERRORS: ${JSON.stringify(errs2.slice(0, 4))}`); process.exitCode = 1; out.errs = false }
    console.log(`[task152] escalate-recovery: ${JSON.stringify({ tier: recovery.tier, fallback: recovery.fallback, pixelCheck: recovery.pixelCheck, healProbe: recovery.healProbe, verdict: recovered?.rung, at: recovered?.at })} (seeded rung 2 @ ${staleAt})`)
    await page.close()
    await context.close()
  }

  return out
}

// ═══ Cell D — Task 155: THE CROSS-TAB SILENCE (the headline) ═══
async function crossTabCell() {
  const out = { pageAOk: false, healLineOk: false, wgBootOk: false, floorOk: false, noWarnsOk: false, noReloadsOk: false, oneContextOk: false, warmOk: false, errs: true }
  const context = await browser.newContext({ viewport: { width: 480, height: 320 } })
  // the WebGPU-CAPABLE device (navigator.gpu intact — the reporting class)
  // with the poisoned TF driver
  await installHooks(context, `(p) => p.tier === 'gpu'`)
  const consoleMsgs = []
  // ── page A: the REAL full ladder, exactly as the reporting phone lived
  //    it — level-0 → the crossing reload → rung 1 → the drop → the CPU
  //    floor + the rung-2 DEVICE verdict — then the tab dies
  {
    const page = await context.newPage()
    page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text().slice(0, 700)}`))
    page.on('pageerror', (e) => consoleMsgs.push('PAGEERROR: ' + String(e).slice(0, 220)))
    await page.goto(`http://localhost:${port}/demo/vfx/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(1200)
    await toggle(page, 'webgl2')
    await page.waitForFunction(() => (document.querySelector('#backend')?.textContent ?? '').includes('WebGL2'), null, { timeout: 40_000 })
    await jumpToEmbers(page)
    await page.waitForFunction(() => (window.__vfxPerf?.tier ?? '') === 'gpu', null, { timeout: 40_000 })
    // the level-0 verdict → the stubbed crossing (verify the marker, then
    // fire the REAL reload — the same protocol as cell B)
    const crossing = await poll(page, `() => {
      if (window.__vfxHealStubbed !== true) return null
      try { return sessionStorage.getItem('rune:vfx:glheal') } catch { return 'NO_STORAGE' }
    }`, 300_000, 'page A: the level-0 verdict crosses to the heal marker')
    let crossedOk = false
    try { const m = JSON.parse(String(crossing)); crossedOk = m.rung === 1 && m.demo === EMERS_INDEX } catch { crossedOk = false }
    await page.evaluate(() => { location.reload() })
    await page.waitForLoadState('domcontentloaded', { timeout: 120_000 }).catch(() => { })
    const settled = await poll(page, `() => {
      const p = window.__vfxPerf
      if (p == null || p.tier !== 'cpu' || p.fallback !== 'cpu') return null
      return {
        tier: p.tier, fallback: p.fallback,
        verdict: (() => { try { return localStorage.getItem('rune:vfx:glverdict') } catch { return 'NO_STORAGE' } })(),
      }
    }`, 300_000, 'page A: the fresh page escalates to the CPU floor in-page').catch(async (e) => {
      const dump = await page.evaluate(`(() => ({ perf: window.__vfxPerf ?? null, fallbackFlag: window.__embersFallback ?? 0, log: (document.querySelector('#log-list')?.textContent ?? '').slice(-600) }))()`).catch((e2) => ({ crash: String(e2).slice(0, 200) }))
      console.log(`[task152] crosstab-A FAILURE DUMP: ${JSON.stringify(dump, null, 1)}`)
      throw e
    })
    let verdictA = null
    try { verdictA = JSON.parse(String(settled.verdict)) } catch { verdictA = null }
    out.pageAOk = settled.tier === 'cpu' && settled.fallback === 'cpu' && crossedOk
      && verdictA !== null && verdictA.rung === 2 && verdictA.demo === EMERS_INDEX
    console.log(`[task152] crosstab-A: the full ladder ran (${crossedOk ? 'crossing ✓' : 'crossing BAD'}) → CPU floor + the rung-2 device verdict ${out.pageAOk ? 'ARMED ✓' : `BAD — ${String(settled.verdict).slice(0, 200)}`}`)
    await page.close() // the tab dies WITH its sessionStorage; localStorage rides on
  }
  // ── page B: a FRESH TAB of the same browser — sessionStorage empty,
  //    the device verdict carried. The circus must NOT re-run.
  {
    const markB = consoleMsgs.length
    const page = await context.newPage()
    page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text().slice(0, 700)}`))
    page.on('pageerror', (e) => consoleMsgs.push('PAGEERROR: ' + String(e).slice(0, 220)))
    await page.goto(`http://localhost:${port}/demo/vfx/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    // the landing: the device-verdict heal event at module scope — the
    // verdict does NOT hijack the boot mode (a WG-capable browser boots
    // the user's own Auto default: GPU Embers on the COMPUTE tier)
    const landed = await poll(page, `() => {
      const p = window.__vfxPerf
      const log = document.querySelector('#log-list')?.textContent ?? ''
      if (!/GL heal: the device verdict remembered \\(rung 2, demo 23\\)[\\s\\S]*CPU floor DIRECTLY/.test(log)) return null
      if (p == null || p.tier !== 'gpu') return null // the compute tier is live
      return {
        tier: p.tier, capacity: p.capacity, fallbackFlag: window.__embersFallback ?? 0,
        glContexts: window.__fxGLContexts,
        healLine: true,
      }
    }`, 300_000, 'page B: the fresh tab boots the WG compute tier with the device-verdict landing').catch(async (e) => {
      const dump = await page.evaluate(`(() => ({ perf: window.__vfxPerf ?? null, fallbackFlag: window.__embersFallback ?? 0, log: (document.querySelector('#log-list')?.textContent ?? '').slice(-700) }))()`).catch((e2) => ({ crash: String(e2).slice(0, 200) }))
      console.log(`[task152] crosstab-B FAILURE DUMP: ${JSON.stringify(dump, null, 1)}`)
      throw e
    })
    out.healLineOk = landed.healLine === true
    out.wgBootOk = landed.tier === 'gpu' && landed.capacity === 160_000 && landed.fallbackFlag === 2 && landed.glContexts === 0
    // ONE WebGL2 press: the floor lands INSTANTLY (the re-make reads the
    // window flag — zero GPU attempts, zero verdicts, zero reloads)
    await toggle(page, 'webgl2')
    const floor = await poll(page, `() => {
      const p = window.__vfxPerf
      if (p == null || p.tier !== 'cpu' || p.fallback !== 'cpu') return null
      return {
        tier: p.tier, fallback: p.fallback, pixelCheck: p.pixelCheck,
        glContexts: window.__fxGLContexts,
        reloads: (() => { try { return Number(sessionStorage.getItem('fxReloads') ?? '0') } catch { return -1 } })(),
      }
    }`, 300_000, 'page B: ONE WebGL2 toggle lands the CPU floor').catch(async (e) => {
      const dump = await page.evaluate(`(() => ({ perf: window.__vfxPerf ?? null, fallbackFlag: window.__embersFallback ?? 0, log: (document.querySelector('#log-list')?.textContent ?? '').slice(-600) }))()`).catch((e2) => ({ crash: String(e2).slice(0, 200) }))
      console.log(`[task152] crosstab-B2 FAILURE DUMP: ${JSON.stringify(dump, null, 1)}`)
      throw e
    })
    await page.waitForTimeout(4000) // the loop guard: the floor never verdicts, never reloads
    const reloadsFinal = await page.evaluate(() => { try { return Number(sessionStorage.getItem('fxReloads') ?? '0') } catch { return -1 } })
    const verdictWarnsB = consoleMsgs.slice(markB).filter((m) => m.includes('Falling back ONCE') || m.includes('ACROSS A PAGE RELOAD') || m.includes('DEGENERATE') || m.includes('GL heal: the reload crossing'))
    const pixelsB = await shot(page, 'crosstab-b')
    out.floorOk = floor.tier === 'cpu' && floor.fallback === 'cpu' && floor.pixelCheck === 'off'
    out.noWarnsOk = verdictWarnsB.length === 0
    out.noReloadsOk = floor.reloads === 1 && reloadsFinal === 1
    out.oneContextOk = floor.glContexts === 1
    out.warmOk = (pixelsB.warm ?? -1) > 0.05
    const errsB = consoleMsgs.filter((m) => m.startsWith('PAGEERROR'))
    if (errsB.length > 0) { console.log(`[task152] crosstab PAGE ERRORS: ${JSON.stringify(errsB.slice(0, 4))}`); process.exitCode = 1; out.errs = false }
    console.log(`[task152] crosstab-B: WG compute ${out.wgBootOk ? '✓' : 'BAD'} → the WebGL2 toggle → CPU floor ${out.floorOk ? '✓' : 'BAD'} (pixelCheck ${floor.pixelCheck}, GL contexts ${floor.glContexts}, reloads ${reloadsFinal}, verdict WARNs ${verdictWarnsB.length}) · pixels ${JSON.stringify(pixelsB)}`)
    await page.close()
  }
  await context.close()
  return out
}

const only = process.env.TASK152_CELL
const results = {}
if (only === undefined || only === 'promotion') results.promotion = await promotionCell()
if (only === undefined || only === 'interlude') results.interlude = await wgInterludeCell()
if (only === undefined || only === 'reload') results.reload = await reloadHealCell()
if (only === undefined || only === 'escalate') results.escalate = await escalationCell()
if (only === undefined || only === 'crosstab') results.crosstab = await crossTabCell()

console.log('── THE VERDICTS ──')
let ok = true
const pr = results.promotion ?? { okContext: false, okSameCanvas: false, okWarm: false, okNoHeal: false, okNoFallback: true, resurrectLine: false, parkLine: false, errs: true }
{
  const pass = pr.okContext && pr.okSameCanvas && pr.okWarm && pr.okNoHeal && pr.okNoFallback && pr.resurrectLine && pr.parkLine && pr.errs
  if (!pass) ok = false
  console.log(`promotion (GL→GL re-boot, ONE context, TF warm): ${pass ? 'PASS ✓' : `FAIL ${JSON.stringify(pr)}`}`)
}
const il = results.interlude ?? { branch: 'INVALID', okBranch: false, okWarm: false, parkLine: false, okCanvasLine: false, okInterludeAlive: false, errs: true }
{
  const pass = il.okBranch && il.okWarm && il.parkLine && il.okCanvasLine && il.okInterludeAlive && il.errs
  if (!pass) ok = false
  console.log(`interlude (WG park → canvas line truthful + interlude alive → the honest ${il.branch} branch, warm): ${pass ? 'PASS ✓' : `FAIL ${JSON.stringify(il)}`}`)
}
const rh = results.reload ?? { markerOk: false, marker2Ok: false, sessionGone: false, healWarn: false, okLanding: false, okHealEvent: false, okOneContext: false, okLoopFree: false, okWarm: false, okNoAutoWalk: false, errs: true }
{
  const pass = rh.markerOk && rh.marker2Ok && rh.sessionGone && rh.healWarn && rh.okLanding && rh.okHealEvent && rh.okOneContext && rh.okLoopFree && rh.okWarm && rh.okNoAutoWalk && rh.errs
  if (!pass) ok = false
  console.log(`reload-heal (L0 → the crossing → rung 1 → CPU warm + the rung-2 DEVICE verdict ARMED in localStorage, loop-free): ${pass ? 'PASS ✓' : `FAIL ${JSON.stringify(rh)}`}`)
}
const es = results.escalate ?? { directOk: false, rearmOk: false, sessionGoneOk: false, reprobeOk: false, freshVerdictOk: false, recoveryOk: false, warmOk: false, errs: true }
{
  const pass = es.directOk && es.rearmOk && es.sessionGoneOk && es.reprobeOk && es.freshVerdictOk && es.recoveryOk && es.warmOk && es.errs
  if (!pass) ok = false
  console.log(`escalate (the device verdict → CPU DIRECT + the session marker consumed; the stale verdict RE-PROBES rung 1 → a fresh rung-2 verdict on a drop, a rung-1 re-arm on a clean re-probe): ${pass ? 'PASS ✓' : `FAIL ${JSON.stringify(es)}`}`)
}
const ct = results.crosstab ?? { pageAOk: false, healLineOk: false, wgBootOk: false, floorOk: false, noWarnsOk: false, noReloadsOk: false, oneContextOk: false, warmOk: false, errs: true }
{
  const pass = ct.pageAOk && ct.healLineOk && ct.wgBootOk && ct.floorOk && ct.noWarnsOk && ct.noReloadsOk && ct.oneContextOk && ct.warmOk && ct.errs
  if (!pass) ok = false
  console.log(`crosstab (a FRESH TAB after the ladder: the device verdict lands it silently — WG compute boots unhijacked, ONE WebGL2 press = the CPU floor, zero warns/reloads): ${pass ? 'PASS ✓' : `FAIL ${JSON.stringify(ct)}`}`)
}
console.log(ok ? '[task152] PASS — the session keeps ONE WebGL2 context across backend cycles, the default heal crosses the page boundary into the fresh page\'s first context (the best cell this driver class has — NOT a guaranteed one: the v153/v154 field logs dropped rung 1 there too), and the verdict is DEVICE-SCOPED now: once the conservative tier verdicts dead, every reload AND every fresh tab of this browser lands the surviving rung directly — the CPU floor with ZERO GPU attempts, no self-reload, no verdict WARN pair — with the ~6 h / browser-update re-probe as the recovery door, the CPU floor catching everything else' : '[task152] FAIL — see above')
if (!ok) process.exitCode = 1

await browser.close()
server.stop(true)
