import { chromium } from 'playwright'
import { join } from 'node:path'
const root = join(import.meta.dirname, '..')
const port = 8934
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const server = Bun.serve({ port, async fetch(request) {
  const url = new URL(request.url)
  let pathname = decodeURIComponent(url.pathname)
  if (pathname.endsWith('/')) pathname += 'index.html'
  const file = Bun.file(join(root, pathname))
  if (!(await file.exists())) return new Response('not found', { status: 404 })
  const ext = pathname.slice(pathname.lastIndexOf('.'))
  const headers = { 'content-type': MIME[ext] ?? 'application/octet-stream' }
  headers['cross-origin-opener-policy'] = 'same-origin'
  headers['cross-origin-embedder-policy'] = 'require-corp'
  return new Response(file, { headers })
}})
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage()
page.on('pageerror', e => console.log('[pageerror]', e.message.slice(0, 200)))
page.on('console', m => { if (m.text().includes('mirror-probe')) console.log(m.text().slice(0, 900)); else if (m.type() === 'error') console.log('[console:error]', m.text().slice(0, 200)) })
await page.goto(`http://localhost:${port}/demo/scene-mirror/?probe=1`, { waitUntil: 'networkidle', timeout: 60_000 })
await page.waitForTimeout(8000)
await browser.close(); server.stop(true)
