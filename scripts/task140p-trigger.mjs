// task140p — THE AUTO-FALLBACK TRIGGER, end-to-end (Task 140).
//
// task140n validated the pieces: the diagnostics fire and verdict SANE on
// a healthy page (no false fallback), and the preset fallback flag takes
// the conservative branch. THIS probe walks the REAL chain: a live page,
// the diagnostics fired — then we MUTATE the verdict to `sane: false`
// (simulating exactly what a dropping driver would produce — the real
// records degenerate). The demo's frame ladder must: see it, set the
// fallback flag, request the shell re-make — and the fresh make must run
// the CONSERVATIVE branch with warm pixels. One console.warn expected.
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
  const orig = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = orig.call(this, type, ...rest)
    if (type === 'webgl2' && ctx != null && !ctx.__fxHooked) {
      ctx.__fxHooked = true
      const origGetParameter = ctx.getParameter.bind(ctx)
      ctx.getParameter = (pname, ...pr) => (pname === UNMASKED_RENDERER ? SPOOF_RENDERER : origGetParameter(pname, ...pr))
    }
    return ctx
  }
})
const page = await context.newPage()
const consoleMsgs = []
page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text().slice(0, 220)}`))
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

// THE SIMULATED DROP, at the source: zero every getBufferSubData readback
// (only the tier's one-shot diagnostic uses it in-page) — the records
// read back ALL-ZERO at frame 30 exactly as a dropping driver would leave
// them: count on the ledger, degenerate rows in the buffer. Installed
// BEFORE the diagnostic frame so the verdict itself flips (mutating the
// verdict object after the fact would race the demo's one-read ladder).
await page.evaluate(() => {
  const c = document.querySelector('canvas')
  const ctx = c != null ? c.getContext('webgl2') : null
  if (ctx == null || ctx.__zeroed) return
  ctx.__zeroed = true
  const orig = ctx.getBufferSubData.bind(ctx)
  ctx.getBufferSubData = (target, srcByteOffset, dst) => {
    const r = orig(target, srcByteOffset, dst)
    if (dst instanceof Float32Array) dst.fill(0)
    return r
  }
})
const before = await page.evaluate(() => ({ perf: { ...window.__vfxPerf }, remakes: window.__fxRemakes }))
console.log(`[task140p] before: ${JSON.stringify(before)}`)
// the ladder sees it on the next frame; the re-make lands the frame after
await page.waitForFunction(() => window.__fxRemakes >= 2, null, { timeout: 30_000 }).catch(() => { })
await page.waitForTimeout(4000)

const after = await page.evaluate(() => ({
  perf: window.__vfxPerf ? { ...window.__vfxPerf } : null,
  remakes: window.__fxRemakes,
  fallbackFlag: window.__embersFallback === true,
})).catch((e) => ({ crash: String(e).slice(0, 150) }))
console.log(`[task140p] after: ${JSON.stringify(after)}`)

// the re-made (conservative) page must be WARM
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
const warn = consoleMsgs.find((m) => m.includes('rune/vfx') && /falling back/i.test(m))
console.log(`[task140p] fallback warning: ${warn ? 'FIRED ✓' : 'MISSING'}`)

{
  const ok = after.perf?.emit === 'cpu' && after.perf?.cull === false && after.perf?.fallback === 'selfcheck' && after.remakes === 2 && (shot.warm ?? -1) > 0.05 && warn != null
  const errs = consoleMsgs.filter((m) => m.startsWith('PAGEERROR'))
  if (errs.length > 0) { console.log('[task140p] PAGE ERRORS: ' + errs.slice(0, 2).join(' | ')); process.exit(1) }
  console.log(ok ? '[task140p] PASS — the degenerate verdict → the auto-fallback → the conservative re-make → warm pixels' : '[task140p] FAIL — see above')
  if (!ok) process.exit(1)
}
await browser.close()
server.stop(true)
