import { chromium } from 'playwright'
import { join } from 'node:path'
const root = join(import.meta.dirname, '..')
const port = 8938
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
const errors = []
page.on('pageerror', e => errors.push(e.message.slice(0, 200)))
await page.goto(`http://localhost:${port}/demo/occlusion/`, { waitUntil: 'networkidle', timeout: 90_000 })
await page.waitForFunction(() => window.__hizStats && window.__hizStats.validation !== null, null, { timeout: 420_000 })
const out = await page.evaluate(() => {
  const v = window.__hizStats.validation
  const bad = (v.cameras ?? []).filter(c => !c.ok).map(c => JSON.stringify(c).slice(0, 500))
  const logBad = []
  for (const el of document.querySelectorAll('#log-list *')) {
    const t = el.textContent ?? ''
    if (/FAIL|error/i.test(t)) logBad.push(t.slice(0, 300))
  }
  return { pass: v.pass, bad, logBad: logBad.slice(0, 6), drawn: window.__hizStats.drawn }
})
console.log('pass:', out.pass, '· drawn:', out.drawn)
for (const b of out.bad) console.log('LEG FAIL:', b)
for (const l of out.logBad) console.log('LOG:', l)
console.log('pageerrors:', errors.length, errors.slice(0, 3))
await browser.close(); server.stop(true)
