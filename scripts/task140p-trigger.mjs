// task140p — THE AUTO-FALLBACK TRIGGER, end-to-end (Task 140, Task 148,
// Task 149 — THE TWO-RUNG LADDER).
//
// task140n validated the pieces: the diagnostics fire and verdict SANE on
// a healthy page (no false fallback), and the preset ladder positions
// take their rungs. THIS probe walks the REAL chain TWICE: a live page,
// the diagnostics fired — then we simulate the FULL dropped-driver
// signature (Task 148: the pixel-confirmed ladder needs BOTH halves):
// zero every getBufferSubData readback (the records read back ALL-ZERO at
// frame 30 — the degenerate verdict) AND zero every readPixels return
// (the in-frame canvas sample reads COLD — exactly the blank canvas a
// real TF write drop shows; zeroing only the readback would leave the
// pixels WARM and the ladder would correctly REFUSE to fall back — the
// lying-readback guard). The Task-149 discipline: the zeroing rides the
// getContext PROTOTYPE hook — it survives the ladder's 0→1 step, which
// re-boots the RENDERER (a fresh canvas + a fresh GL context must ALSO
// read back zeroed for the second verdict). The demo's frame ladder must:
// latch the suspicion, confirm it cold, set the flag to 1, request the
// re-make — the re-make channel re-boots the renderer on the same backend
// and the fresh make must run the CONSERVATIVE TF rung (tier 'gpu',
// emit:'cpu', cull off, the full patched capacity, a gpuBackend present,
// fallback 'tf'); the rung's OWN diagnostic re-verdicts degenerate (the
// records still read zeroed), its pixel sample confirms cold — the
// escalation to 2 — and the final re-make must run the FULL-CPU branch
// (sim:'cpu', tier:'cpu', no GPU backend, fallback 'cpu') with warm
// pixels. Two console.warns expected (one per rung).
import { join } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const root = '/home/z/my-project/rune'
const out = join(root, '.shots', 'task140')
mkdirSync(out, { recursive: true })
const port = 8156

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
  let v = null
  Object.defineProperty(window, '__vfxPerf', {
    configurable: true,
    get: () => v,
    set: (nv) => { v = nv; window.__fxRemakes++ },
  })
  const SPOOF_RENDERER = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)'
  const UNMASKED_RENDERER = 37446
  // Task 149 — THE ZEROING RIDES THE PROTOTYPE HOOK: the ladder's 0→1 step
  // re-boots the RENDERER (a fresh canvas element + a fresh GL context) —
  // a hook installed on the old context object would die with it and the
  // second verdict would read the REAL (healthy) records. Every webgl2
  // context born on this page reads back zeroed, forever: the level-0
  // verdict AND the level-1 re-verdict both see the dropped-driver
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

// RUNG 1 — the level-0 verdict: the ladder sees the degenerate records +
// the cold canvas on the next frame; the 0→1 step re-boots the renderer
// (a fresh context — the zeroing rides the prototype hook, so the new
// context reads zeroed too). The container's slow raster makes frame 30
// take up to ~20s at the patched 16k.
await page.waitForFunction(() => window.__fxRemakes >= 2, null, { timeout: 90_000 }).catch(() => { })
await page.waitForTimeout(2500)
const mid = await page.evaluate(() => ({
  perf: window.__vfxPerf ? { ...window.__vfxPerf } : null,
  remakes: window.__fxRemakes,
  fallbackFlag: window.__embersFallback ?? 0,
  gpuBackends: (window.__vfxLayers ?? []).filter((l) => l?.gpuBackend !== undefined).length,
  booted: document.querySelector('canvas') != null,
})).catch((e) => ({ crash: String(e).slice(0, 150) }))
console.log(`[task140p] mid (the conservative TF rung): ${JSON.stringify(mid)}`)

// RUNG 2 — the level-1 re-verdict: the fresh context's diagnostic reads
// the still-zeroed records → degenerate → the pixel sample confirms cold
// (the readPixels zeroing) → the escalation to level 2 → the full-CPU
// re-make. Settle for the warm pixels.
await page.waitForFunction(() => window.__fxRemakes >= 3, null, { timeout: 120_000 }).catch(() => { })
await page.waitForTimeout(4000)

const after = await page.evaluate(() => ({
  perf: window.__vfxPerf ? { ...window.__vfxPerf } : null,
  remakes: window.__fxRemakes,
  fallbackFlag: window.__embersFallback ?? 0,
  gpuBackends: (window.__vfxLayers ?? []).filter((l) => l?.gpuBackend !== undefined).length,
})).catch((e) => ({ crash: String(e).slice(0, 150) }))
console.log(`[task140p] after (the CPU rung): ${JSON.stringify(after)}`)

// the re-made (CPU-tier) page must be WARM
let shot = { starved: true }
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
console.log(`[task140p] after pixels: ${JSON.stringify(shot)}`)
const warnTf = consoleMsgs.find((m) => m.includes('rune/vfx') && /stepping down once/i.test(m))
const warnCpu = consoleMsgs.find((m) => m.includes('rune/vfx') && /falling back once/i.test(m))
console.log(`[task140p] rung-1 warning (stepping down): ${warnTf ? 'FIRED ✓' : 'MISSING'}`)
console.log(`[task140p] rung-2 warning (falling back): ${warnCpu ? 'FIRED ✓' : 'MISSING'}`)

{
  const midOk = mid.perf?.tier === 'gpu' && mid.perf?.emit === 'cpu' && mid.perf?.cull === false
    && mid.perf?.fallback === 'tf' && mid.perf?.capacity === 16000
    && mid.fallbackFlag === 1 && mid.gpuBackends === 1 && mid.remakes === 2 && mid.booted === true
  const ok = midOk
    && after.perf?.emit === 'cpu' && after.perf?.cull === false && after.perf?.fallback === 'cpu'
    && after.perf?.tier === 'cpu' && after.gpuBackends === 0 && after.remakes === 3
    && after.fallbackFlag === 2 && (shot.warm ?? -1) > 0.05 && warnTf != null && warnCpu != null
  const errs = consoleMsgs.filter((m) => m.startsWith('PAGEERROR'))
  if (errs.length > 0) { console.log('[task140p] PAGE ERRORS: ' + errs.slice(0, 2).join(' | ')); process.exit(1) }
  console.log(midOk ? '[task140p] rung 1 ✓ — the degenerate verdict + the cold canvas → the renderer re-boot → the CONSERVATIVE TF tier (160k budget, emit cpu, a live gpuBackend, fallback \'tf\')' : '[task140p] rung 1 FAIL — see the mid state above')
  console.log(ok ? '[task140p] PASS — the full two-rung ladder: 0 → conservative TF (re-booted, re-verdicted degenerate + cold) → 1 → the facade CPU tier (no GPU backend) → warm pixels' : '[task140p] FAIL — see above')
  if (!ok) process.exit(1)
}
await browser.close()
server.stop(true)
