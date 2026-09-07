// t153-interlude-probe — ground truth on the WebGPU interlude state (Task 153):
// the user's v153 field log showed "Canvas: 0×0 css-px" during a WG boot with
// a parked GL context. The fix makes the line read the boot's OWN canvas
// (proven: 480×320). The OPEN question this probe answers: does the WG
// canvas actually RENDER during the interlude in this container — the
// compositor screenshot tears into white tiles, and the drawImage readback
// reads all-black. Diagnostics: frame-counter delta (is the WG loop
// running), per-canvas geometry, the drawImage readback with RAW pixel
// samples, the compositor screenshot, the log tail.
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const root = '/home/z/my-project/rune'
const out = join(root, '.shots', 't153')
const port = Number(process.env.T153_PORT ?? 8163)

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
    const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }
    return new Response(await file.text(), { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})

const page = await browser.newPage({ viewport: { width: 480, height: 320 } })
const consoleMsgs = []
page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text().slice(0, 300)}`))
page.on('pageerror', (e) => consoleMsgs.push('PAGEERROR: ' + String(e).slice(0, 220)))

await page.goto(`http://localhost:${port}/demo/vfx/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForTimeout(1500)
await page.evaluate(() => { const r = document.querySelector('input[name="rd-mode"][value="webgl2"]'); if (r != null) r.click() })
await page.waitForFunction(() => (document.querySelector('#backend')?.textContent ?? '').includes('WebGL2'), null, { timeout: 40_000 })
await page.waitForTimeout(2000)

// the GL loop rate (frames advancing on the muzzle demo, GL #1)
const glA = await page.evaluate(() => window.__vfxFrame ?? 0)
await page.waitForTimeout(1000)
const glB = await page.evaluate(() => window.__vfxFrame ?? 0)
console.log(`[t153] GL leg: frames ${glA} → ${glB} (Δ ${glB - glA}/s)`)

// THE INTERLUDE: toggle to WebGPU — the GL renderer parks, the WG boot re-makes
await page.evaluate(() => { const r = document.querySelector('input[name="rd-mode"][value="webgpu"]'); if (r != null) r.click() })
await page.waitForFunction(() => (document.querySelector('#backend')?.textContent ?? '') === 'WebGPU', null, { timeout: 60_000 })
await page.waitForTimeout(3000)

const wgA = await page.evaluate(() => window.__vfxFrame ?? 0)
await page.waitForTimeout(1000)
const wgB = await page.evaluate(() => window.__vfxFrame ?? 0)

const diagnostics = await page.evaluate(() => {
  const all = [...document.querySelectorAll('canvas')]
  const canvases = all.map((c) => {
    const r = c.getBoundingClientRect()
    const sample = (() => {
      try {
        const t = document.createElement('canvas')
        t.width = 240
        t.height = 160
        const g = t.getContext('2d', { willReadFrequently: true })
        g.drawImage(c, 0, 0, 240, 160)
        const d = g.getImageData(0, 0, 240, 160).data
        let warm = 0, bright = 0, nonzero = 0
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] > 40 && d[i] > d[i + 1] * 1.15 && d[i + 1] > d[i + 2] * 1.05) warm++
          if (d[i] + d[i + 1] + d[i + 2] > 120) bright++
          if (d[i] + d[i + 1] + d[i + 2] > 0) nonzero++
        }
        const grid = []
        for (let gy = 0; gy < 3; gy++) for (let gx = 0; gx < 3; gx++) {
          const i = ((gy * 60 + 30) * 240 + (gx * 80 + 40)) * 4
          grid.push(`${d[i]},${d[i + 1]},${d[i + 2]}`)
        }
        return { warm: +(100 * warm / 38400).toFixed(2), bright: +(100 * bright / 38400).toFixed(2), nonzero: +(100 * nonzero / 38400).toFixed(2), grid }
      } catch (e) { return { err: String(e).slice(0, 100) } }
    })()
    return {
      id: c.id, display: c.style.display || '(css)', client: `${c.clientWidth}x${c.clientHeight}`,
      attrs: `${c.width}x${c.height}`, rect: `${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.x)},${Math.round(r.y)}`,
      inDom: c.isConnected, sample,
    }
  })
  const log = document.querySelector('#log-list')?.textContent ?? ''
  const canvasLines = log.match(/Canvas: \d+×\d+ css-px/g) ?? []
  return {
    canvases,
    frames: window.__vfxFrame ?? 0,
    keep: window.__vfxGLKeep ?? null,
    keepLost: window.__vfxGLKeepLost ?? null,
    facade: window.__vfxGpuFacade != null,
    backend: document.querySelector('#backend')?.textContent ?? null,
    lastCanvasLine: canvasLines[canvasLines.length - 1] ?? null,
    logTail: log.slice(-700),
  }
})

console.log(`[t153] WG interlude: frames ${wgA} → ${wgB} (Δ ${wgB - wgA}/s)`)
console.log(`[t153] backend=${diagnostics.backend} keep=${diagnostics.keep} keepLost=${diagnostics.keepLost} facade=${diagnostics.facade}`)
console.log(`[t153] last Canvas line: ${diagnostics.lastCanvasLine}`)
for (const c of diagnostics.canvases) {
  console.log(`[t153] canvas id=${c.id} display=${c.display} client=${c.client} attrs=${c.attrs} rect=${c.rect} inDom=${c.inDom}`)
  console.log(`      drawImage: ${JSON.stringify(c.sample)}`)
}
await page.screenshot({ path: join(out, 'interlude-full.png'), timeout: 30_000 })
console.log(`[t153] compositor screenshot → ${join(out, 'interlude-full.png')}`)
console.log(`[t153] log tail: ${diagnostics.logTail.replace(/\n/g, ' | ')}`)
const errs = consoleMsgs.filter((m) => m.startsWith('PAGEERROR'))
console.log(`[t153] page errors: ${errs.length === 0 ? 'none' : JSON.stringify(errs.slice(0, 4))}`)

await browser.close()
server.stop(true)
