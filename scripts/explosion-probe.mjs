/** scripts/explosion-probe.mjs — per-layer live counts + soup verts, timed
 *  against a fresh instance's log line (the burst debugging tool). */
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const port = 8127
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary', '.fbx': 'application/octet-stream', '.wasm': 'application/wasm',
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
page.on('pageerror', (e) => console.log('PAGE ERROR:', String(e).slice(0, 300)))
await page.goto(`http://localhost:${port}/demo/vfx/`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => /Sentry Turret · [1-9][\d,]* particles/.test(document.querySelector('.pt-pill')?.textContent ?? ''), null, { timeout: 20000 })
await page.evaluate(() => document.querySelector('.pt-sheet [aria-label=Close]')?.click())
await page.keyboard.press('ArrowRight')
await page.waitForFunction(() => /Explosion \(composed\) · [1-9][\d,]* particles/.test(document.querySelector('.pt-pill')?.textContent ?? ''), null, { timeout: 20000 })

async function freshInstance() {
  await page.evaluate(() => {
      const t = document.querySelector('#log-list')?.textContent ?? ''
      const m = t.match(/explosion #(\d+)/g)
      window.__lastExp = m ? parseInt(m[m.length - 1].match(/(\d+)/)[1], 10) : 0
    })
  await page.waitForFunction(() => {
    const t = document.querySelector('#log-list')?.textContent ?? ''
    const m = t.match(/explosion #(\d+)/g)
    const last = m ? parseInt(m[m.length - 1].match(/(\d+)/)[1], 10) : 0
    if (last > (window.__lastExp ?? 0)) { window.__lastExp = last; return true }
    return false
  }, null, { timeout: 30000 })
}

for (const [ms, label] of [[150, 't≈0.15'], [450, 't≈0.45'], [1250, 't≈1.25']]) {
  await freshInstance()
  await page.waitForTimeout(ms)
  const layers = await page.evaluate(() => (window.__vfxLayers ?? []).map(l => ({
    id: l.id, count: l.facade?.count ?? 0,
  })))
  console.log(`${label}:`, JSON.stringify(layers))
}
server.stop()
await browser.close()
