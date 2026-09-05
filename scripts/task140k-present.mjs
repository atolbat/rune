// task140k — BUFFER vs SCREEN on ONE page (Task 140 — the presentation gap).
//
// task140j's in-frame oracle: the drawing buffer is WARM after the ember
// draw in EVERY config (16k: 2.04%, 40k conservative: 5.57%, 40k default:
// 4.87%) — yet the 40k-default screenshots read warm 0%. The pixels die
// between the drawing buffer and the screen.
//
// THIS PROBE: one page, three measurements —
//   1. the in-frame readPixels (after the ember draw — the buffer truth);
//   2. a SCREENSHOT with retries (the compositor truth);
//   3. the screenshot's lit-pixel COORDINATE MAP (what is actually lit:
//      the floor gradient? HUD chrome? scattered embers?) — clusters by
//      grid cell, so the layout tells what it is.
import { join } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const root = '/home/z/my-project/rune'
const out = join(root, '.shots', 'task140')
mkdirSync(out, { recursive: true })
const port = 8151

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
      if (body === before) { console.error('[task140k] PATCH FAILED'); process.exit(1) }
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
      const readAfter = (kind, meta) => {
        try {
          ctx.readPixels(RX, RY, RW, RH, ctx.RGBA, ctx.UNSIGNED_BYTE, px)
          let warm = 0, lit = 0
          for (let i = 0; i < px.length; i += 4) {
            const r = px[i], g = px[i + 1], b = px[i + 2]
            if (r > 40 && r > g * 1.15 && g > b * 1.05) warm++
            if (r + g + b > 90) lit++
          }
          window.__fxReads.push({ kind, meta, warm: +(100 * warm / (RW * RH)).toFixed(2), lit: +(100 * lit / (RW * RH)).toFixed(2) })
          if (window.__fxReads.length > 10) window.__fxReads.shift()
        } catch { }
      }
      const hook = (name) => {
        const fn = ctx[name].bind(ctx)
        ctx[name] = (...args) => {
          const r = fn(...args)
          if (name === 'drawArraysInstanced' && args[3] > 5000) readAfter('ember', args[3])
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
await page.waitForTimeout(3500)

// 1. the buffer truth
const state = await page.evaluate(() => ({
  perf: window.__vfxPerf ? { count: window.__vfxPerf.count, cap: window.__vfxPerf.capacity, emit: window.__vfxPerf.emit, cull: window.__vfxPerf.cull, softwareGL: window.__vfxPerf.softwareGL } : null,
  emberReads: window.__fxReads.slice(-4),
})).catch((e) => ({ crash: String(e).slice(0, 150) }))
console.log(`[task140k] perf: ${JSON.stringify(state.perf)}`)
console.log(`[task140k] IN-FRAME buffer reads (after ember draws): ${JSON.stringify(state.emberReads)}`)

// 2. the screen truth — with retries AND the coordinate map
const clip = await page.evaluate(() => {
  const c = document.querySelector('canvas')
  if (!c) return null
  const r = c.getBoundingClientRect()
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), cssW: c.style.width, cssH: c.style.height, attrW: c.width, attrH: c.height }
}).catch(() => null)
console.log(`[task140k] canvas: ${JSON.stringify(clip)}`)
for (let k = 0; k < 3; k++) {
  try {
    const path = join(out, `k-screen-${k}.png`)
    await page.screenshot({ path, clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height }, timeout: 12_000 })
    const png = PNG.sync.read(readFileSync(path))
    const { width: W, height: H, data } = png
    let warm = 0, lit = 0
    const GX = 8, GY = 8 // the lit map grid (8×8 cells)
    const cells = new Array(GX * GY).fill(0)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      const r = data[i], g = data[i + 1], b = data[i + 2]
      const isWarm = r > 40 && r > g * 1.15 && g > b * 1.05
      if (isWarm) warm++
      if (r + g + b > 90) { lit++; cells[Math.floor((y / H) * GY) * GX + Math.floor((x / W) * GX)]++ }
    }
    const map = cells.map((c) => c > W * H / 400 ? '#' : c > 0 ? '.' : ' ')
    console.log(`[task140k] SHOT ${k}: warm ${(100 * warm / (W * H)).toFixed(3)}% lit ${(100 * lit / (W * H)).toFixed(2)}% (${W}x${H})`)
    console.log(`[task140k]   lit map: ${[0, 1, 2, 3, 4, 5, 6, 7].map((row) => map.slice(row * 8, row * 8 + 8).join('')).join(' | ')}`)
  } catch { console.log(`[task140k] SHOT ${k}: starved`) }
}

await browser.close()
server.stop(true)
