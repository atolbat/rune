/**
 * scripts/scratch-219b.mjs — Task 219: the post-surgery smoke.
 * Boots the walker on both backends in the container (WG = software →
 * snapshot; GL = SwiftShader-GL live — the new surface+blit shape), reads
 * the live channel, the canvas probe, and grabs screenshots for the VLM.
 */
import { chromium } from 'playwright'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const port = 8207
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url)
    let pathname = decodeURIComponent(url.pathname)
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = Bun.file(join(root, pathname))
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    const ext = pathname.slice(pathname.lastIndexOf('.'))
    return new Response(file, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

const ARGS = ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader']
const which = process.argv[2] ?? 'webgpu'
const url = `http://localhost:${port}/demo/walker/?crowd=512&mode=${which}&bare=1`
console.log(`[219b] ${which}: ${url}`)
const browser = await chromium.launch({ headless: true, args: ARGS })
try {
  const page = await browser.newPage({ viewport: { width: 720, height: 480 } })
  const consoleErrors = []
  page.on('console', m => { const t = m.text(); if (/error|lost|failed/i.test(t)) consoleErrors.push(t.slice(0, 200)) })
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForFunction(() => window.__walker && window.__walker.frame > 60, null, { timeout: 180_000 }).catch(() => {})
  const report = await page.evaluate(() => {
    const w = window.__walker ?? {}
    const t = window.__walkerTier
    const c = document.getElementById('hiz-canvas')
    let probeAvg = -1, topBright = -1, botBright = -1
    try {
      const p = document.createElement('canvas'); p.width = 32; p.height = 32
      const x = p.getContext('2d', { willReadFrequently: true })
      x.drawImage(c, 0, 0, 32, 32)
      const d = x.getImageData(0, 0, 32, 32).data
      let a = 0, lit = 0, top = 0, bot = 0
      for (let k = 0; k < d.length; k += 4) {
        a += d[k + 3]; if (d[k + 3] >= 8) lit++
        const row = Math.floor((k / 4) / 32)
        const lum = (d[k] + d[k + 1] + d[k + 2]) / 3
        if (row < 10) top += lum
        if (row >= 22) bot += lum
      }
      probeAvg = Math.round(a / (d.length / 4))
      topBright = Math.round(top / 320)
      botBright = Math.round(bot / 320)
    } catch { /* read refused */ }
    return {
      frame: w.frame, kind: w.kind, backend: w.backend, drawn: w.drawn,
      canvasW: c?.width, canvasH: c?.height, cssW: c?.clientWidth, cssH: c?.clientHeight,
      probeAvg, topBright, botBright, hyst: t?.hystFrames,
      errs: (window.__walkerErrs ?? []).slice(0, 4),
    }
  })
  console.log(JSON.stringify(report, null, 1))
  console.log('consoleErrors:', JSON.stringify(consoleErrors.slice(0, 4)))
  await page.screenshot({ path: `/home/z/my-project/download/walker-219-${which}.png` })
} finally {
  await Promise.race([browser.close(), new Promise(r => setTimeout(r, 8000))])
  try { browser.process()?.kill('SIGKILL') } catch { /* gone */ }
}
server.stop(true)
process.exit(0)
