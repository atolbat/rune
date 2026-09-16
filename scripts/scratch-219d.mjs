import { chromium } from 'playwright'
import { join } from 'node:path'
const root = join(import.meta.dirname, '..')
const port = 8209
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const server = Bun.serve({ port, async fetch(request) {
  const url = new URL(request.url); let pathname = decodeURIComponent(url.pathname)
  if (pathname.endsWith('/')) pathname += 'index.html'
  const file = Bun.file(join(root, pathname))
  if (!(await file.exists())) return new Response('not found', { status: 404 })
  const ext = pathname.slice(pathname.lastIndexOf('.'))
  return new Response(file, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
}})
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage({ viewport: { width: 720, height: 480 } })
  await page.goto(`http://localhost:${port}/demo/walker/?crowd=512&mode=webgpu&live=1&bare=1`, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForFunction(() => window.__walker && window.__walker.frame > 90, null, { timeout: 240_000 })
  const r = await page.evaluate(() => {
    const w = window.__walker; const c = document.getElementById('hiz-canvas')
    const p = document.createElement('canvas'); p.width = 16; p.height = 16
    const x = p.getContext('2d', { willReadFrequently: true })
    x.clearRect(0, 0, 16, 16); x.drawImage(c, 0, 0, 16, 16)
    const d = x.getImageData(0, 0, 16, 16).data
    let lit = 0; for (let k = 3; k < d.length; k += 4) if (d[k] >= 8) lit++
    return { frame: w.frame, kind: w.kind, drawn: w.drawn, probeLit: lit, errs: (window.__walkerErrs ?? []).slice(0, 3) }
  })
  console.log(JSON.stringify(r))
} finally {
  await Promise.race([browser.close(), new Promise(r => setTimeout(r, 8000))])
  try { browser.process()?.kill('SIGKILL') } catch {}
}
server.stop(true)
process.exit(0)
