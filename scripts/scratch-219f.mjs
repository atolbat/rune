import { chromium } from 'playwright'
import { join } from 'node:path'
const root = join(import.meta.dirname, '..')
const port = 8212
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
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
  page.on('console', m => { const t = m.text(); if (/error/i.test(t)) console.log(`[console] ${t.slice(0, 220)}`) })
  await page.goto(`http://localhost:${port}/demo/walker/?crowd=1500`, { waitUntil: 'networkidle', timeout: 90_000 })
  await page.waitForFunction(() => window.__walker && window.__walker.validation !== null, null, { timeout: 420_000 })
  const errs = await page.evaluate(() => window.__walkerErrs ?? [])
  console.log('walkerErrs:', JSON.stringify(errs, null, 1))
} finally {
  await Promise.race([browser.close(), new Promise(r => setTimeout(r, 8000))])
  try { browser.process()?.kill('SIGKILL') } catch {}
}
server.stop(true)
process.exit(0)
