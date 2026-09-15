import { chromium } from 'playwright'
import { join } from 'node:path'
const root = join(import.meta.dirname, '..')
const port = 8936
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const server = Bun.serve({ port, async fetch(request) {
  const url = new URL(request.url)
  let pathname = decodeURIComponent(url.pathname)
  if (pathname.endsWith('/')) pathname += 'index.html'
  const file = Bun.file(join(root, pathname))
  if (!(await file.exists())) return new Response('not found', { status: 404 })
  const ext = pathname.slice(pathname.lastIndexOf('.'))
  return new Response(file, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
}})
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage()
page.on('console', m => { if (m.type() === 'error') console.log('[console:error]', m.text().slice(0, 300)) })
await page.goto(`http://localhost:${port}/demo/occlusion/?bare=1`, { waitUntil: 'networkidle', timeout: 90_000 })
await page.waitForFunction(() => window.__hizStats && window.__hizStats.drawn > 0, null, { timeout: 240_000 })
const out = await page.evaluate(() => {
  // compile the still-frame policy DIRECTLY through the frame-graph channel
  const fg = window.__fgDebug
  const f = fg.compile({ reuse: true, culling: true, fresh: true, feedback: true, seed: true, history: false, pyramidView: false, wantStats: false })
  const f2 = fg.compile({ reuse: false, culling: true, fresh: true, feedback: true, seed: true, history: false, pyramidView: false, wantStats: false })
  return { still: f.passes.map(p => p.name), moving: f2.passes.map(p => p.name) }
})
console.log(JSON.stringify(out, null, 1))
await browser.close(); server.stop(true)
