/**
 * scripts/bolt-cast.mjs — captures the lightning bolt DURING its 0.16 s
 * life via CDP screencast (Playwright's page.screenshot is slower than the
 * bolt's whole life on SwiftShader). Streams compositor frames, fires a
 * strike, keeps the frames, writes the brightest few to .shots/cast-*.png.
 */
import { join, resolve } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const out = resolve(root, '.shots')
mkdirSync(out, { recursive: true })
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
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--no-sandbox'],
})

const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.goto(`http://localhost:${port}/demo/vfx/`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => document.querySelector('#backend')?.textContent !== '…', null, { timeout: 20000 })
await page.waitForTimeout(1000)

// switch to the lightning demo
await page.evaluate(() => document.querySelector('.pt-pill')?.click())
await page.waitForTimeout(300)
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.pt-row')]
  const i = rows.findIndex((r) => r.querySelector('b')?.textContent.toLowerCase().startsWith('lightning'))
  rows[i]?.click()
})
await page.waitForTimeout(800)

// start the screencast — every compositor frame streams to us
const cdp = await page.context().newCDPSession(page)
const frames = []
await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 })
cdp.on('Page.screencastFrame', async (ev) => {
  frames.push(Buffer.from(ev.data, 'base64'))
  try { await cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }) } catch { /* gone */ }
})

// wait for a strike to fire (the counter bumps the same frame)
await page.waitForFunction(() => window.__vfxCounters && window.__vfxCounters.strikes >= 1, null, { timeout: 20000 })
const before = await page.evaluate(() => window.__vfxCounters.strikes)
await page.waitForFunction(
  (b) => window.__vfxCounters.strikes > b,
  before,
  { timeout: 30000, polling: 8 },
)
// grab the frames from the ~0.5 s after the strike
await page.waitForTimeout(500)
await cdp.send('Page.stopScreencast').catch(() => {})

// rank the frames by total canvas brightness (the bolt is the brightest
// event in the scene) and keep the top 6
const ranked = []
for (let i = 0; i < frames.length; i++) {
  const { PNG } = await import('pngjs')
  try {
    const png = PNG.sync.read(frames[i])
    let sum = 0
    const d = png.data
    for (let p = 0; p < d.length; p += 400) sum += d[p] + d[p + 1] + d[p + 2]
    ranked.push({ i, sum, buf: frames[i] })
  } catch { /* partial frame */ }
}
ranked.sort((a, b) => b.sum - a.sum)
console.log(`captured ${frames.length} screencast frames; top brightness ${ranked[0]?.sum ?? 0}`)
for (let k = 0; k < Math.min(6, ranked.length); k++) {
  writeFileSync(join(out, `cast-${String(k).padStart(2, '0')}.png`), ranked[k].buf)
  console.log(`  cast-${k}: frame #${ranked[k].i}, brightness ${ranked[k].sum}`)
}

await browser.close()
server.stop()
