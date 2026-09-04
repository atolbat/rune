/**
 * scripts/task129-bolt-check.mjs — the Task 129 one-off: dwell on the Sentry
 * Turret long enough for the 3rd burst (the BEAM VOLLEY — burstN % 3 === 0)
 * and read the counters: bolts fired, bolt impacts, reflection sparks.
 * One process: serve + drive (the demo-smoke pattern).
 */
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const port = 8137
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}
const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url)
    let pathname = decodeURIComponent(url.pathname)
    if (pathname === '/') pathname = '/demo/'
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = Bun.file(join(root, pathname))
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    const ext = pathname.slice(pathname.lastIndexOf('.'))
    return new Response(file, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

const browser = await chromium.launch({
  args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan'],
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', e => errors.push(String(e)))
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })

await page.goto(`http://localhost:${port}/demo/vfx/`, { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)
await page.evaluate(() => document.querySelector('.pt-sheet [aria-label=Close]')?.click())
// wait for the renderer to actually come up (the pill fills with counts)
await page.waitForFunction(
  () => / · [1-9][\d,]* particles/.test(document.querySelector('.pt-pill')?.textContent ?? ''),
  null,
  { timeout: 30000 },
).catch(() => console.log('!! the pill never filled — the renderer did not come up'))
// the first demo IS the sentry turret — dwell 20 s (acquire → burst → dwell →
// ... → the 3rd burst = the BEAM volley → its bolts land)
await page.waitForTimeout(20000)
const pill = await page.locator('.pt-pill').first().textContent().catch(() => '?')
console.log('pill:', pill)
const counters = await page.evaluate(() => ({ ...window.__vfxCounters }))
const logText = await page.evaluate(() => document.querySelector('#log-list')?.textContent ?? '')
const volleyLines = (logText.match(/sentry BEAM volley #\d+/g) ?? []).length
console.log('counters:', JSON.stringify(counters))
console.log('BEAM volley log lines:', volleyLines)
console.log('page errors:', errors.length, errors.length ? errors.slice(0, 3).join(' | ') : '(none)')
await browser.close()
server.stop()
