import { chromium } from 'playwright'
import { join } from 'node:path'
const root = join('/home/z/my-project/rune')
const port = 8208
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
  await page.goto(`http://localhost:${port}/demo/walker/?crowd=512&mode=webgl2&bare=1`, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForFunction(() => window.__walker && window.__walker.frame > 30, null, { timeout: 180_000 })
  const r = await page.evaluate(() => {
    const t = window.__walkerTier
    return { surfW: t.surface.width, surfH: t.surface.height, kind: t.kind, adapter: t.device.adapterInfo, software: t.device.software }
  })
  console.log(JSON.stringify(r))
} finally {
  await Promise.race([browser.close(), new Promise(r => setTimeout(r, 8000))])
  try { browser.process()?.kill('SIGKILL') } catch {}
}
server.stop(true)
process.exit(0)
