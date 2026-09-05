// task140m — THE COMPOSITOR-THAW ATTEMPT (Task 140).
//
// The pattern: the drawing buffer is WARM (in-frame readPixels) in every
// config, but screenshots at 40k+ either STARVE or read COLD — while 16k
// screenshots read WARM. Hypothesis: the Chrome launch flags (--use-
// angle=swiftshader WITHOUT --enable-unsafe-swiftshader) leave the
// compositor in a degraded state under load ("Automatic fallback to
// software WebGL has been deprecated" — the console warns every run).
// THIS probe: the flag ADDED + a rAF-settle before the shot + a 60s
// timeout. If the shot lands WARM at 40k, the "cold screen" was an
// artifact — and the real question shifts entirely to the user's GPU.
import { join } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const root = '/home/z/my-project/rune'
const out = join(root, '.shots', 'task140')
mkdirSync(out, { recursive: true })
const port = 8153

const CAP = process.env.CAP ?? '40000'
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
      body = body.replace(/const TF_CAPACITY = SOFTWARE_GL \? 16_000 : 160_000/, `const TF_CAPACITY = ${CAP}`)
      if (body === before) { console.error('[task140m] PATCH FAILED'); process.exit(1) }
    }
    return new Response(body, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

const browser = await chromium.launch({
  headless: true,
  args: [
    '--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu',
    '--use-angle=swiftshader', '--enable-features=Vulkan',
    '--enable-unsafe-swiftshader', // ← THE THAW FLAG
  ],
})
const context = await browser.newContext({ viewport: { width: 480, height: 320 } })
await context.addInitScript(() => {
  window.__fxReads = []
  const SPOOF_RENDERER = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)'
  const UNMASKED_RENDERER = 37446
  const orig = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = orig.call(this, type, ...rest)
    if (type === 'webgl2' && ctx != null && !ctx.__fxHooked) {
      ctx.__fxHooked = true
      const origGetParameter = ctx.getParameter.bind(ctx)
      ctx.getParameter = (pname, ...pr) => (pname === UNMASKED_RENDERER ? SPOOF_RENDERER : origGetParameter(pname, ...pr))
      const RW = 240, RH = 160, RX = 120, RY = 80
      const px = new Uint8Array(RW * RH * 4)
      const fn = ctx.drawArraysInstanced.bind(ctx)
      ctx.drawArraysInstanced = (...args) => {
        const r = fn(...args)
        if (args[3] > 5000) {
          try {
            ctx.readPixels(RX, RY, RW, RH, ctx.RGBA, ctx.UNSIGNED_BYTE, px)
            let warm = 0
            for (let i = 0; i < px.length; i += 4) if (px[i] > 40 && px[i] > px[i + 1] * 1.15 && px[i + 1] > px[i + 2] * 1.05) warm++
            window.__fxReads.push({ inst: args[3], warm: +(100 * warm / (RW * RH)).toFixed(2) })
            if (window.__fxReads.length > 6) window.__fxReads.shift()
          } catch { }
        }
        return r
      }
    }
    return ctx
  }
})

const page = await context.newPage()
await page.goto(`http://localhost:${port}/demo/vfx/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForTimeout(1000)
await page.click('#rd-fab')
await page.click('label[for="mode-webgl2"]')
await page.waitForTimeout(400)
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('button')]
  rows.find((r) => (r.textContent ?? '').includes('GPU Embers'))?.click()
})
await page.waitForTimeout(3000)

// settle ON a fresh rAF pair, then shoot immediately
await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))).catch(() => { })
const buf = await page.evaluate(() => ({ count: window.__vfxPerf?.count, reads: window.__fxReads.slice(-2) })).catch(() => null)
const clip = await page.evaluate(() => {
  const c = document.querySelector('canvas')
  const r = c.getBoundingClientRect()
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
}).catch(() => null)
try {
  const path = join(out, 'm-40k.png')
  await page.screenshot({ path, clip, timeout: 60_000 })
  const png = PNG.sync.read(readFileSync(path))
  const { width: W, height: H, data } = png
  let warm = 0, lit = 0
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4
    if (data[i] > 40 && data[i] > data[i + 1] * 1.15 && data[i + 1] > data[i + 2] * 1.05) warm++
    if (data[i] + data[i + 1] + data[i + 2] > 90) lit++
  }
  console.log(`[task140m] SHOT: warm ${(100 * warm / (W * H)).toFixed(3)}% lit ${(100 * lit / (W * H)).toFixed(2)}% · buffer ${JSON.stringify(buf?.reads)} · count ${buf?.count}`)
} catch {
  console.log(`[task140m] SHOT STARVED even with the thaw flag · buffer ${JSON.stringify(buf?.reads)} · count ${buf?.count}`)
}
await browser.close()
server.stop(true)
