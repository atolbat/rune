// scratch-217e — THE LIVE-WG REPRO: force ?live=1 (the canvas-present path the
// user's real GPU walks) in the headless container. Three outcomes:
//  (a) presents survive → the FULL repro: brightness + console errors tell all
//  (b) the GPU process dies → collect what fired BEFORE the death
//  (c) it runs but dark → the bug is right here, reproducible
import { chromium } from 'playwright'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
const root = join(import.meta.dirname, '..')
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})
const server = Bun.serve({
  port: 8946,
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
const errors = [], infos = []
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message.slice(0, 200)))
page.on('console', m => {
  if (m.type() === 'error') errors.push('CONSOLE: ' + m.text().slice(0, 300))
  if (m.type() === 'warning' && /gpu|webgpu|dawn/i.test(m.text())) infos.push('WARN: ' + m.text().slice(0, 300))
})
page.on('crash', () => errors.push('=== PAGE CRASHED (the GPU process death class) ==='))
console.log('[live-wg] goto…')
await page.goto('http://localhost:8946/demo/walker/?mode=webgpu&live=1&crowd=1500', { waitUntil: 'networkidle', timeout: 90_000 })
try {
  await page.waitForFunction(() => window.__walker && window.__walker.frame > 60, null, { timeout: 180_000 })
} catch { console.log('[live-wg] the boot wait timed out — dumping whatever state exists') }
const stats = await page.evaluate(() => {
  const w = window.__walker ?? {}
  return { frame: w.frame, fps: w.fps, drawn: w.drawn, total: w.total, backend: w.backend, kind: w.kind, errors: w.errors }
}).catch(e => ({ crashed: true, why: String(e).slice(0, 150) }))
console.log('[live-wg] stats:', JSON.stringify(stats))
const shot = await page.screenshot().catch(e => null)
if (shot !== null) {
  writeFileSync('/home/z/my-project/download/walker-live-wg-forced.png', shot)
  const br = await page.evaluate(async b64 => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode()
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
    const x = c.getContext('2d'); x.drawImage(img, 0, 0)
    const d = x.getImageData(0, 0, c.width, Math.floor(c.height * 0.3)).data
    let sum = 0, dark = 0, n = 0
    for (let k = 0; k < d.length; k += 16) { const v = (d[k] + d[k + 1] + d[k + 2]) / 3; sum += v; if (v < 32) dark++; n++ }
    return { skyMean: +(sum / n).toFixed(1), darkPct: +((dark / n) * 100).toFixed(0) }
  }, shot.toString('base64')).catch(() => null)
  console.log('[live-wg] SKY:', JSON.stringify(br), '(saved walker-live-wg-forced.png)')
}
console.log(`[live-wg] errors (${errors.length}):`); for (const e of errors.slice(0, 12)) console.log('  ' + e)
console.log(`[live-wg] gpu-ish warnings (${infos.length}):`); for (const i of infos.slice(0, 8)) console.log('  ' + i)
await ctx.close(); await browser.close(); server.stop()
