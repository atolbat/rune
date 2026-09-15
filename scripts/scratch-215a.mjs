import { chromium } from 'playwright'
import { join } from 'node:path'
const root = join(import.meta.dirname, '..')
const port = 8933
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
const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
page.on('pageerror', e => console.log('[pageerror]', e.message.slice(0, 300)))
page.on('console', m => console.log(`[console:${m.type()}]`, m.text().slice(0, 300)))
page.on('requestfailed', r => console.log('[reqfail]', r.url().slice(-60), r.failure()?.errorText))
await page.goto(`http://localhost:${port}/demo/occlusion/?bare=1`, { waitUntil: 'networkidle', timeout: 60_000 })
await page.waitForTimeout(15000)
console.log('stats:', JSON.stringify(await page.evaluate(() => window.__hizStats ? { drawn: window.__hizStats.drawn, mode: window.__hizStats.mode, errors: window.__hizStats.errors } : null)))
await browser.close(); server.stop(true)
