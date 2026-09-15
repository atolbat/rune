// scratch-217g — THE LIVE-WG AUTOPSY: forced ?live=1, dump the frame graph,
// the pyramid readbacks, and THE CANVAS ITSELF (an in-page 2D copy of the WG
// canvas — if it reads transparent/empty, the "sky" was the page background).
import { chromium } from 'playwright'
import { join } from 'node:path'
const root = join(import.meta.dirname, '..')
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})
const server = Bun.serve({
  port: 8948,
  async fetch(request) {
    let pathname = decodeURIComponent(new URL(request.url).pathname)
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = Bun.file(join(root, pathname))
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    const ext = pathname.slice(pathname.lastIndexOf('.'))
    return new Response(file, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})
const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message.slice(0, 200)))
page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text().slice(0, 300)) })
await page.goto('http://localhost:8948/demo/walker/?mode=webgpu&live=1&crowd=512', { waitUntil: 'networkidle', timeout: 90_000 })
await page.waitForFunction(() => window.__walker && window.__walker.frame > 100, null, { timeout: 180_000 })

const dump = await page.evaluate(async () => {
  const out = {}
  const w = window.__walker, t = window.__walkerTier
  out.walker = { frame: w.frame, fps: w.fps, drawn: w.drawn, total: w.total, kind: w.kind, backend: w.backend, seedStale: w.seedStale }
  out.tierKeys = t ? Object.keys(t) : null
  try { out.graph = t.graphStats() } catch (e) { out.graph = 'ERR ' + e.message }
  try { out.seed = t.seedState() } catch (e) { out.seed = 'ERR ' + e.message }
  if (window.__fgDebug) { try { out.fgLast = { passes: (window.__fgDebug.last().passes ?? []).map(p => `${p.name}${p.ran === false ? '(NOT RUN)' : ''}`) } } catch (e) { out.fgLast = 'ERR ' + e.message } }
  if (window.__hizDebug) {
    try { out.ztile = await window.__hizDebug.ztile() } catch (e) { out.ztile = 'ERR ' + e.message }
    try { out.stats = await window.__hizDebug.stats() } catch (e) { out.stats = 'ERR ' + e.message }
  }
  // THE CANVAS AUTOPSY: copy the WG canvas into a 2D canvas and read pixels
  const c = document.getElementById('hiz-canvas')
  out.canvas = { w: c.width, h: c.height, css: `${c.clientWidth}x${c.clientHeight}`, ctx: c.getContext('webgpu') !== null ? 'webgpu' : (c.getContext('webgl2') !== null ? 'webgl2!' : 'none!') }
  try {
    const d = document.createElement('canvas'); d.width = 64; d.height = 128
    const x = d.getContext('2d')
    x.drawImage(c, 0, 0, 64, 128)
    const img = x.getImageData(0, 0, 64, 128).data
    let sum = 0, alpha0 = 0, n = 0
    for (let k = 0; k < img.length; k += 4) { sum += (img[k] + img[k + 1] + img[k + 2]) / 3; if (img[k + 3] < 8) alpha0++; n++ }
    out.canvasCopy = { mean: +(sum / n).toFixed(1), transparentPct: +((alpha0 / n) * 100).toFixed(0) }
  } catch (e) { out.canvasCopy = 'ERR ' + e.message }
  return out
})
console.log(JSON.stringify(dump, null, 1).slice(0, 3000))
console.log(`[autopsy] errors (${errors.length}):`); for (const e of errors.slice(0, 10)) console.log('  ' + e)
await ctx.close(); await browser.close(); server.stop()
