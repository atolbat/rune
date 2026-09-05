// task140l — THE STALE-FRAME TEST (Task 140: is the screenshot composited
// fresh, and is the GL canvas the only dead layer?).
//
// task140k: the drawing buffer is WARM (in-frame readPixels 1.91% after
// the ember draw) yet every screenshot starved at 40k; task140f's earlier
// "cold" screenshot may have been a STALE composite. THIS probe:
//   · an ORANGE DOM MARKER painted right before each screenshot attempt
//     (a fresh composite MUST show it; a stale one won't);
//   · the FULL-viewport screenshot (not the canvas clip) — the DOM layers
//     (the pill, the HUD) vs the canvas area compared separately;
//   · the canvas-region warm % vs the buffer's warm % on the same page.
import { join } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const root = '/home/z/my-project/rune'
const out = join(root, '.shots', 'task140')
mkdirSync(out, { recursive: true })
const port = 8152

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
      if (body === before) { console.error('[task140l] PATCH FAILED'); process.exit(1) }
    }
    return new Response(body, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan'],
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
      const hook = (name) => {
        const fn = ctx[name].bind(ctx)
        ctx[name] = (...args) => {
          const r = fn(...args)
          if (name === 'drawArraysInstanced' && args[3] > 5000) {
            try {
              ctx.readPixels(RX, RY, RW, RH, ctx.RGBA, ctx.UNSIGNED_BYTE, px)
              let warm = 0
              for (let i = 0; i < px.length; i += 4) {
                if (px[i] > 40 && px[i] > px[i + 1] * 1.15 && px[i + 1] > px[i + 2] * 1.05) warm++
              }
              window.__fxReads.push({ inst: args[3], warm: +(100 * warm / (RW * RH)).toFixed(2) })
              if (window.__fxReads.length > 6) window.__fxReads.shift()
            } catch { }
          }
          return r
        }
      }
      for (const name of ['drawArraysInstanced']) hook(name)
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

for (let k = 0; k < 3; k++) {
  // THE MARKER: a big orange border on the demo title pill, TOGGLED per
  // attempt (k-even: on, k-odd: off) — a fresh composite reflects the
  // current state; a stale one freezes the old state
  await page.evaluate((on) => {
    const pill = document.querySelector('.pt-title') ?? document.body
    pill.style.outline = on ? '8px solid rgb(255,110,20)' : 'none'
  }, k % 2 === 0)
  await page.waitForTimeout(300)
  const buf = await page.evaluate(() => ({
    perf: window.__vfxPerf ? { count: window.__vfxPerf.count, cap: window.__vfxPerf.capacity } : null,
    reads: window.__fxReads.slice(-2),
  })).catch(() => null)
  try {
    const path = join(out, `l-marker-${k}.png`)
    await page.screenshot({ path, timeout: 15_000 })
    const png = PNG.sync.read(readFileSync(path))
    const { width: W, height: H, data } = png
    // the canvas occupies the full viewport below the top bar (~40px) —
    // analyze the WHOLE shot: marker pixels (strong orange) vs ember
    // pixels (warm) — the marker is DOM, the embers are GL
    let marker = 0, warm = 0
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      const r = data[i], g = data[i + 1], b = data[i + 2]
      if (r > 200 && g > 70 && g < 160 && b < 40) marker++
      if (r > 40 && r > g * 1.15 && g > b * 1.05 && !(r > 200 && g < 160)) warm++
    }
    console.log(`[task140l] shot ${k} (marker ${k % 2 === 0 ? 'ON' : 'OFF'}): marker ${(100 * marker / (W * H)).toFixed(3)}% · warm(embers) ${(100 * warm / (W * H)).toFixed(3)}% · buffer reads ${JSON.stringify(buf?.reads)} · count ${buf?.perf?.count}`)
  } catch {
    console.log(`[task140l] shot ${k} (marker ${k % 2 === 0 ? 'ON' : 'OFF'}): STARVED · buffer reads ${JSON.stringify(buf?.reads)} · count ${buf?.perf?.count}`)
  }
}

await browser.close()
server.stop(true)
