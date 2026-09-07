// task140p — THE AUTO-FALLBACK TRIGGER, end-to-end (Task 140, Task 148,
// Task 149 — THE TWO-RUNG LADDER; Task 152 — THE RELOAD CROSSING).
//
// task140n validated the pieces: the diagnostics fire and verdict SANE on
// a healthy page (no false fallback), and the preset ladder positions
// take their rungs. THIS probe walks the REAL chain: a live page, the
// diagnostics fired — then we simulate the FULL dropped-driver signature
// (Task 148: the pixel-confirmed ladder needs BOTH halves): zero every
// getBufferSubData readback AND every readPixels return (the context
// hook rides the getContext PROTOTYPE — it survives the reload crossing,
// re-installing on every fresh document).
//
// The Task-152 default chain (the walk is opt-in now — ?forensic=1): the
// level-0 verdict fires the RELOAD CROSSING: the warn names the page
// boundary, the sessionStorage marker carries the rung + the demo index,
// and the page RELOADS ITSELF (this gate does NOT stub the reload — the
// crossing is real; the complementary stubbed-marker assertions live in
// task152-keepalive.mjs's reload-heal cell). The fresh page: the "GL
// heal" event line, the forced WebGL2 boot at rung 1 (the conservative
// TF tier — emit 'cpu', cull off, the full patched capacity, a live
// gpuBackend) pinned by the marker BEFORE the first make; the zeroing
// still matches the GPU tier → the rung's own pixel-confirmed verdict
// escalates IN-PAGE (rung 2 never crosses a boundary) → the full-CPU
// re-make (sim:'cpu', tier 'cpu', no GPU backend, fallback 'cpu') with
// warm pixels; no second reload ever fires (the loop guard). The walk
// entry warning must NOT fire on this default chain.
import { join } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const root = '/home/z/my-project/rune'
const out = join(root, '.shots', 'task140')
mkdirSync(out, { recursive: true })
const port = Number(process.env.TASK140P_PORT ?? 8156)

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
      body = body.replace(/const TF_CAPACITY = SOFTWARE_GL \? 16_000 : 160_000/, 'const TF_CAPACITY = 16000')
      // Task 148 — the re-made CPU tier's capacity (the healed branch takes
      // FALLBACK_CAPACITY — patch it to the same fast 16k budget)
      body = body.replace(/const FALLBACK_CAPACITY = SOFTWARE_GL \? 16_000 : COARSE \? 32_000 : GPU_CAPACITY/, 'const FALLBACK_CAPACITY = 16000')
    }
    return new Response(body, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})
const context = await browser.newContext({ viewport: { width: 480, height: 320 } })
await context.addInitScript(() => {
  window.__fxRemakes = 0
  // Task 152 — the page-reload counter (the loop guard's ground truth):
  // the heal crossing reloads ONCE; rung 2 is an in-page re-make.
  try {
    const n = Number(sessionStorage.getItem('fxReloads') ?? '0') + 1
    sessionStorage.setItem('fxReloads', String(n))
  } catch { /* storage-less — the loop guard degrades to the log text */ }
  let v = null
  Object.defineProperty(window, '__vfxPerf', {
    configurable: true,
    get: () => v,
    set: (nv) => { v = nv; window.__fxRemakes++ },
  })
  const SPOOF_RENDERER = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)'
  const UNMASKED_RENDERER = 37446
  // Task 149/152 — THE ZEROING RIDES THE PROTOTYPE HOOK: the reload
  // crossing creates a FRESH document — a hook installed on the old
  // context object would die with it. Every webgl2 context born on every
  // page of this session reads back zeroed, forever: the level-0 verdict
  // AND the reloaded page's rung-1 re-verdict both see the dropped-driver
  // signature; the level-2 CPU tier renders physically warm (the zeroing
  // only poisons the READBACKS, not the rasterization).
  const orig = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = orig.call(this, type, ...rest)
    if (type === 'webgl2' && ctx != null && !ctx.__fxHooked) {
      ctx.__fxHooked = true
      const origGetParameter = ctx.getParameter.bind(ctx)
      ctx.getParameter = (pname, ...pr) => (pname === UNMASKED_RENDERER ? SPOOF_RENDERER : origGetParameter(pname, ...pr))
      const origGetBuf = ctx.getBufferSubData.bind(ctx)
      ctx.getBufferSubData = (target, srcByteOffset, dst) => {
        const r = origGetBuf(target, srcByteOffset, dst)
        if (dst instanceof Float32Array) dst.fill(0)
        return r
      }
      const origRp = ctx.readPixels.bind(ctx)
      ctx.readPixels = (x, y, w, h, format, type, dst) => {
        const r = origRp(x, y, w, h, format, type, dst)
        if (dst instanceof Uint8Array) dst.fill(0)
        return r
      }
    }
    return ctx
  }
})
const page = await context.newPage()
const consoleMsgs = []
page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text().slice(0, 900)}`))
page.on('pageerror', (e) => consoleMsgs.push('PAGEERROR: ' + String(e).slice(0, 220)))

/** A Node-side poll that SURVIVES the heal reload (page.evaluate throws
 *  while the old document's execution context dies — retry through it). */
async function poll(fnSrc, timeoutMs, label) {
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

await page.goto(`http://localhost:${port}/demo/vfx/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForTimeout(1000)
await page.click('#rd-fab')
await page.click('label[for="mode-webgl2"]')
await page.waitForTimeout(400)
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('button')]
  rows.find((r) => (r.textContent ?? '').includes('GPU Embers'))?.click()
})
// wait for the tier to exist (the layer lands within the click)
await page.waitForFunction(() => (window.__vfxLayers ?? []).some((l) => l?.gpuBackend), null, { timeout: 30_000 })

const before = await page.evaluate(() => ({ perf: { ...window.__vfxPerf }, remakes: window.__fxRemakes }))
console.log(`[task140p] before: ${JSON.stringify(before)}`)

// ── THE CROSSING: the level-0 pixel-confirmed verdict writes the heal
//    marker and reloads the page FOR REAL. Wait for the reload to land
//    (the "GL heal" event line only exists on the FRESH page's log), then
//    for the rung-1 re-verdict (the zeroing still matches) and the in-page
//    escalation to the CPU tier.
const landed = await poll(`() => {
  if (!/GL heal: the reload crossing landed \\(rung 1, demo 23\\)/.test(document.querySelector('#log-list')?.textContent ?? '')) return null
  return true
}`, 300_000, 'the heal reload lands the fresh page at rung 1')

// the fresh page's FIRST make is already the conservative tier (the marker
// pinned the position BEFORE the make — no level-0 leg ever runs there)
const rung1 = await poll(`() => {
  const p = window.__vfxPerf
  if (p == null || p.tier !== 'gpu') return null
  return { tier: p.tier, emit: p.emit, cull: p.cull, fallback: p.fallback, capacity: p.capacity, remakes: window.__fxRemakes }
}`, 120_000, 'the reloaded page boots the conservative rung')
console.log(`[task140p] rung 1 (the reloaded page, pinned by the marker): ${JSON.stringify(rung1)}`)

// the rung-1 re-verdict (degenerate + cold — the zeroing never lifts) →
// the IN-PAGE escalation to the CPU tier (no second reload)
const after = await poll(`() => {
  const p = window.__vfxPerf
  if (p == null || p.tier !== 'cpu') return null
  return {
    perf: { ...p },
    fallbackFlag: window.__embersFallback ?? 0,
    gpuBackends: (window.__vfxLayers ?? []).filter((l) => l?.gpuBackend !== undefined).length,
    glHealEvent: /GL heal: the reload crossing landed/.test(document.querySelector('#log-list')?.textContent ?? ''),
    reloadedTwice: (() => { try { return Number(sessionStorage.getItem('fxReloads') ?? '0') } catch { return -1 } })(),
  }
}`, 300_000, 'the CPU tier lands in-page')
console.log(`[task140p] after (the CPU rung): ${JSON.stringify(after)}`)

// the loop guard: rung 2 must NEVER cross a boundary — settle and re-read
await page.waitForTimeout(4000)
const reloadsAfter = await page.evaluate(() => { try { return Number(sessionStorage.getItem('fxReloads') ?? '0') } catch { return -1 } }).catch(() => -1)
console.log(`[task140p] reloads: after the landing ${after.reloadedTwice} → after the settle ${reloadsAfter}`)

// the re-made (CPU-tier) page must be WARM
let shot = { starved: true }
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    const clip = await page.evaluate(() => {
      const c = document.querySelector('canvas')
      const r = c.getBoundingClientRect()
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
    })
    const path = join(out, 'p-after-fallback.png')
    await page.screenshot({ path, clip, timeout: 20_000 })
    const png = PNG.sync.read(readFileSync(path))
    const { width: W, height: H, data } = png
    let w = 0
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      if (data[i] > 40 && data[i] > data[i + 1] * 1.15 && data[i + 1] > data[i + 2] * 1.05) w++
    }
    shot = { warm: +(100 * w / (W * H)).toFixed(3) }
  } catch { }
  if ((shot.warm ?? -1) > 0.05) break
  await page.waitForTimeout(1200)
}
console.log(`[task140p] after pixels: ${JSON.stringify(shot)}`)

// The chain's console story: the crossing warn names the page boundary;
// the rung-2 escalation warning; and the WALK MUST NOT FIRE on the
// default chain (Task 152 retired it to ?forensic=1).
const warnCrossing = consoleMsgs.find((m) => m.includes('rune/vfx') && /ACROSS A PAGE RELOAD/i.test(m))
const warnCpu = consoleMsgs.find((m) => m.includes('rune/vfx') && /falling back once/i.test(m))
const warnWalk = consoleMsgs.find((m) => m.includes('rune/vfx') && /ISOLATION WALK/i.test(m))
console.log(`[task140p] crossing warning (heal across a page reload): ${warnCrossing ? 'FIRED ✓' : 'MISSING'}`)
console.log(`[task140p] rung-2 warning (falling back): ${warnCpu ? 'FIRED ✓' : 'MISSING'}`)
console.log(`[task140p] auto-walk on the default chain: ${warnWalk ? 'FIRED (WRONG)' : 'silent ✓'}`)

{
  const rung1Ok = landed === true
    && rung1.tier === 'gpu' && rung1.emit === 'cpu' && rung1.cull === false
    && rung1.fallback === 'tf' && rung1.capacity === 16000 && rung1.remakes === 1
  const cpuOk = after.perf?.emit === 'cpu' && after.perf?.cull === false && after.perf?.fallback === 'cpu'
    && after.perf?.tier === 'cpu' && after.gpuBackends === 0
    && after.fallbackFlag === 2 && after.glHealEvent === true
  const loopOk = after.reloadedTwice === 2 && reloadsAfter === 2
  const ok = rung1Ok && cpuOk && loopOk
    && (shot.warm ?? -1) > 0.05 && warnCrossing != null && warnCpu != null && warnWalk == null
  const errs = consoleMsgs.filter((m) => m.startsWith('PAGEERROR'))
  if (errs.length > 0) { console.log('[task140p] PAGE ERRORS: ' + errs.slice(0, 2).join(' | ')); process.exit(1) }
  console.log(rung1Ok ? '[task140p] rung 1 ✓ — the marker pinned the conservative tier BEFORE the reloaded page\'s first make (no level-0 leg ever ran there)' : '[task140p] rung 1 FAIL — see the rung 1 state above')
  console.log(cpuOk ? '[task140p] CPU ✓ — the rung-1 re-verdict escalated IN-PAGE (no second reload) into the full-CPU tier with no GPU backend' : '[task140p] CPU FAIL — see the after state above')
  console.log(ok ? '[task140p] PASS — the Task-152 default chain: L0 verdict → the reload crossing (marker + the self-reload) → the fresh page at rung 1 (GL heal event, conservative tier) → the in-page escalation → rung 2 CPU → warm pixels, exactly ONE reload' : '[task140p] FAIL — see above')
  if (!ok) process.exit(1)
}
await browser.close()
server.stop(true)
