// task149-debug — why did the prototype-level zeroing not reach the
// renderer's readbacks in task140p? Dump ALL console + diag + a direct
// in-page test of the zeroing on the live context.
import { join } from 'node:path'
import { chromium } from 'playwright'

const root = '/home/z/my-project/rune'
const port = 8157
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
  const SPOOF_RENDERER = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)'
  const UNMASKED_RENDERER = 37446
  const orig = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = orig.call(this, type, ...rest)
    if (type === 'webgl2' && ctx != null && !ctx.__fxHooked) {
      ctx.__fxHooked = true
      window.__hookedContexts = (window.__hookedContexts ?? 0) + 1
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
page.on('console', (m) => console.log(`[console] ${m.text().slice(0, 240)}`))
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
await page.waitForFunction(() => (window.__vfxLayers ?? []).some((l) => l?.gpuBackend), null, { timeout: 30_000 })
// let the diag + pixel check run (fast frames in this container)
await page.waitForTimeout(3000)
// INSTRUMENT: wrap the live tier's step + readBuffer to see if they run
await page.evaluate(() => {
  const gb = (window.__vfxLayers ?? []).find((l) => l?.gpuBackend)?.gpuBackend
  if (gb == null || gb.__instrumented) return
  gb.__instrumented = true
  const s = gb.step.bind(gb)
  window.__stepCalls = 0
  gb.step = (...a) => { window.__stepCalls++; return s(...a) }
  window.__diagPoll = []
})
for (let i = 0; i < 14; i++) {
  await page.waitForTimeout(1000)
  await page.evaluate((t) => {
    const gb = (window.__vfxLayers ?? []).find((l) => l?.gpuBackend)?.gpuBackend
    window.__diagPoll.push({
      t, calls: window.__stepCalls, checked: gb?.diagnostics?.checked,
      sane: gb?.diagnostics?.sane, readable: gb?.diagnostics?.readable,
      count: window.__vfxPerf?.count, ms: window.__vfxPerf?.ms,
      pixelCheck: window.__vfxPerf?.pixelCheck, fallback: window.__vfxPerf?.fallback,
    })
  }, i)
}
const state = await page.evaluate(() => {
  const canvases = [...document.querySelectorAll('canvas')]
  const first = canvases[0] ?? null
  const gl2 = first != null ? first.getContext('webgl2') : null
  // DIRECT probe: does the live context's getBufferSubData zero a Float32 dst?
  let zeroed = null
  if (gl2 != null) {
    const probe = new Float32Array(8).fill(7)
    try { gl2.getBufferSubData(gl2.ARRAY_BUFFER, 0, probe) } catch { zeroed = 'threw' }
    if (zeroed === null) zeroed = probe[0] === 7 ? 'NOT-ZEROED (wrapper absent)' : 'ZEROED (wrapper present)'
    // and readPixels?
    const px = new Uint8Array(4).fill(200)
    try { gl2.readPixels(0, 0, 1, 1, gl2.RGBA, gl2.UNSIGNED_BYTE, px) } catch { }
    window.__rpTest = px[0] === 200 ? 'readPixels NOT-ZEROED' : 'readPixels ZEROED'
    window.__bufTest = zeroed
    window.__hookFlag = gl2.__fxHooked === true
  }
  return {
    canvasCount: canvases.length,
    firstCanvasId: first?.id ?? null,
    firstCanvasParent: first?.parentElement?.id ?? null,
    perf: window.__vfxPerf ? { ...window.__vfxPerf } : null,
    diag: (window.__vfxLayers ?? []).map((l) => l?.gpuBackend?.diagnostics).find((d) => d !== undefined) ?? null,
    diagPoll: window.__diagPoll ?? [],
    hookedContexts: window.__hookedContexts ?? 0,
    ctxHooked: window.__hookFlag,
    bufTest: window.__bufTest,
    rpTest: window.__rpTest,
  }
})
console.log(JSON.stringify(state, null, 2))
await browser.close()
server.stop(true)
