// task140o — WHY doesn't the diagnostics fire? A direct step-counter debug.
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const root = '/home/z/my-project/rune'
mkdirSync(join(root, '.shots', 'task140'), { recursive: true })
const port = 8155

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
      body = body.replace(/const TF_CAPACITY = SOFTWARE_GL \? 16_000 : 160_000/, 'const TF_CAPACITY = 40000')
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
  const SPOOF_RENDERER = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)'
  const UNMASKED_RENDERER = 37446
  const orig = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = orig.call(this, type, ...rest)
    if (type === 'webgl2' && ctx != null && !ctx.__fxHooked) {
      ctx.__fxHooked = true
      const origGetParameter = ctx.getParameter.bind(ctx)
      ctx.getParameter = (pname, ...pr) => (pname === UNMASKED_RENDERER ? SPOOF_RENDERER : origGetParameter(pname, ...pr))
      const fn = ctx.readPixels.bind(ctx)
      ctx.readPixels = (...a) => { window.__readPixelsCalls = (window.__readPixelsCalls ?? 0) + 1; return fn(...a) }
    }
    return ctx
  }
})
const page = await context.newPage()
page.on('pageerror', (e) => console.log('PAGEERROR: ' + String(e).slice(0, 200)))
await page.goto(`http://localhost:${port}/demo/vfx/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForTimeout(1000)
await page.click('#rd-fab')
await page.click('label[for="mode-webgl2"]')
await page.waitForTimeout(400)
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('button')]
  rows.find((r) => (r.textContent ?? '').includes('GPU Embers'))?.click()
})
await page.waitForFunction(() => (window.__vfxLayers ?? []).some((l) => l?.gpuBackend), null, { timeout: 20_000 })
await page.evaluate(() => {
  const layer = window.__vfxLayers.find((l) => l?.gpuBackend)
  const tier = layer.gpuBackend
  const origStep = tier.step.bind(tier)
  let n = 0
  let diagSeen = 0
  window.__diagReads = 0
  tier.step = (...a) => {
    const r = origStep(...a)
    n++
    window.__stepCount = n
    window.__stepArgs = { dt: a[0], camOk: a[1] != null }
    if (n % 10 === 0) {
      diagSeen = tier.diagnostics.checked
      window.__diagReads = diagSeen
    }
    return r
  }
})
for (let k = 0; k < 8; k++) {
  await page.waitForTimeout(5000)
  const s = await page.evaluate(() => ({
    steps: window.__stepCount ?? 0,
    diag: window.__vfxLayers.find((l) => l?.gpuBackend)?.gpuBackend?.diagnostics,
    readPixels: window.__readPixelsCalls ?? 0,
    perf: window.__vfxPerf ? { count: window.__vfxPerf.count, ms: window.__vfxPerf.ms } : null,
    tick: window.__vfxFrame ?? -1,
  })).catch((e) => ({ crash: String(e).slice(0, 120) }))
  console.log(`[task140o] t=${(k + 1) * 5}s: ${JSON.stringify(s)}`)
  if (s.diag?.checked) { console.log('[task140o] DIAGNOSTICS FIRED'); break }
}
await browser.close()
server.stop(true)
