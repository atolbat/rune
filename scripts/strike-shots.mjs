/**
 * scripts/strike-shots.mjs — catches the lightning strike FRESH (via the
 * page's __vfxCounters.strikes handle — bumped the frame a strike fires)
 * and shoots a fast sequence (55 ms apart) through the 0.16 s bolt life.
 * For the connectivity diagnosis.
 */
import { join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const out = resolve(root, '.shots')
mkdirSync(out, { recursive: true })
const port = 8131

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
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--no-sandbox'],
})

const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.goto(`http://localhost:${port}/demo/vfx/`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => document.querySelector('#backend')?.textContent !== '…', null, { timeout: 20000 })
await page.waitForTimeout(1000)

// switch to the lightning demo (last row)
await page.evaluate(() => document.querySelector('.pt-pill')?.click())
await page.waitForTimeout(300)
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.pt-row')]
  const i = rows.findIndex((r) => r.querySelector('b')?.textContent.toLowerCase().startsWith('lightning'))
  rows[i]?.click()
})
await page.waitForTimeout(600)

// wait for the counters handle to appear (the demo instruments strikes)
await page.waitForFunction(() => window.__vfxCounters && window.__vfxCounters.strikes >= 1, null, { timeout: 20000 })

// wait for the NEXT strike to fire, then shoot fast through its life
const before = await page.evaluate(() => window.__vfxCounters.strikes)
await page.waitForFunction(
  (b) => window.__vfxCounters.strikes > b,
  before,
  { timeout: 30000, polling: 16 },
)
// the strike fired THIS frame — shoot immediately, 55 ms apart
for (let k = 0; k < 12; k++) {
  await page.screenshot({ path: join(out, `strike-${String(k).padStart(2, '0')}.png`) })
  await page.waitForTimeout(55)
}

console.log('done — strikes seen:', await page.evaluate(() => window.__vfxCounters.strikes))
await browser.close()
server.stop()
