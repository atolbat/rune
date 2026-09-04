/**
 * scripts/bolt-read.mjs — reads the CANVAS PIXELS from inside the page at
 * the frames right after a strike (page.screenshot is slower than the
 * bolt's whole life; an in-page drawImage in the same rAF tick as the
 * draw has zero latency). Grabs the 4 frames after the strike, writes
 * them + their temporal max, then prints the connectivity map.
 */
import { join, resolve } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const out = resolve(root, '.shots')
mkdirSync(out, { recursive: true })
const port = 8138

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

// wait for a strike, then grab the NEXT 4 rendered frames' canvas content
// (the bolt's life is 0.16 s — at SwiftShader's ~30-50 ms/frame that's the
// whole life including both strobe peaks). The read happens in a rAF
// registered AFTER the demo's own rAF for the same frame → the WebGL
// buffer still holds that frame's draw.
const grabs = await page.evaluate(() => new Promise((resolve) => {
  const start = window.__vfxCounters.strikes
  const timer = setInterval(() => {
    if (window.__vfxCounters.strikes > start) {
      clearInterval(timer)
      const frames = []
      const grab = () => {
        const c = document.querySelector('canvas')
        const c2 = document.createElement('canvas')
        c2.width = c.width; c2.height = c.height
        try { c2.getContext('2d').drawImage(c, 0, 0) } catch (e) { /* keep going */ }
        frames.push(c2.toDataURL('image/png'))
        if (frames.length < 4) requestAnimationFrame(grab)
        else resolve(frames)
      }
      requestAnimationFrame(grab)
    }
  }, 8)
  setTimeout(() => resolve([]), 30000) // no strike in 30 s — bail
}))

console.log(`grabbed ${grabs.length} frames post-strike`)
for (let i = 0; i < grabs.length; i++) {
  writeFileSync(join(out, `read-${String(i).padStart(2, '0')}.png`), Buffer.from(grabs[i].split(',')[1], 'base64'))
}

await browser.close()
server.stop()

// the temporal max + the connectivity map (reusing the bolt-max logic)
if (grabs.length === 0) process.exit(1)
const { PNG } = await import('pngjs')
let acc = null, W = 0, H = 0
for (const g of grabs) {
  const png = PNG.sync.read(Buffer.from(g.split(',')[1], 'base64'))
  if (acc === null) { W = png.width; H = png.height; acc = new Float32Array(W * H) }
  for (let p = 0; p < W * H; p++) {
    const i = p * 4
    const lum = Math.max(png.data[i], png.data[i + 1], png.data[i + 2])
    if (lum > acc[p]) acc[p] = lum
  }
}
const outPng = new PNG({ width: W, height: H })
for (let p = 0; p < W * H; p++) {
  const v = Math.round(acc[p])
  outPng.data[p * 4] = v; outPng.data[p * 4 + 1] = v; outPng.data[p * 4 + 2] = v; outPng.data[p * 4 + 3] = 255
}
writeFileSync('.shots/read-max.png', PNG.sync.write(outPng))
console.log(`max composite written (${W}x${H})`)

// find the bolt column: bright pixels above the ground band, y in [80, 500)
let minX = W, maxX = 0, minY = H, maxY = 0, n = 0
for (let y = 80; y < Math.min(H, 520); y++) {
  for (let x = 0; x < W; x++) {
    if (acc[y * W + x] > 100) { n++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }
  }
}
console.log(`bright(>100) pixels y in [80,520): ${n}, bbox x [${minX},${maxX}] y [${minY},${maxY}]`)
if (n === 0) { console.log('NO BOLT VISIBLE — the strike may be off-frame'); process.exit(0) }
const px0 = Math.max(0, minX - 30), px1 = Math.min(W, maxX + 30)
const py0 = Math.max(0, minY - 10), py1 = Math.min(H, maxY + 10)
const CELL = 4
const cols = Math.floor((px1 - px0) / CELL), rows = Math.floor((py1 - py0) / CELL)
const TH = [8, 32, 80, 160, 220], CH = [' ', '.', ':', '+', '*', '#']
for (let r = 0; r < rows; r++) {
  let line = ''
  for (let c = 0; c < cols; c++) {
    let max = 0
    for (let y = py0 + r * CELL; y < py0 + (r + 1) * CELL; y++) {
      for (let x = px0 + c * CELL; x < px0 + (c + 1) * CELL; x++) {
        if (acc[y * W + x] > max) max = acc[y * W + x]
      }
    }
    let ch = ' '
    for (let k = 0; k < TH.length; k++) if (max >= TH[k]) ch = CH[k + 1]
    line += ch
  }
  console.log(line)
}
let gaps = 0, covered = 0, gapRows = []
for (let y = py0; y < py1; y += 8) {
  let hit = false
  for (let x = px0; x < px1; x++) {
    if (acc[y * W + x] > 60) { hit = true; break }
  }
  if (hit) covered++; else { gaps++; gapRows.push(y) }
}
console.log(`row bands: ${covered} covered, ${gaps} GAPS${gapRows.length ? ' at y ' + gapRows.join(',') : ''}`)
