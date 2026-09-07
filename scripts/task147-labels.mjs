/**
 * scripts/task147-labels.mjs — pins the ghost-beacon question: reads every
 * .fx-label's DOM rect, crops the screenshot neighborhood (the marker +
 * halo should sit ~40-70px ABOVE each label), and counts blue-bright pixels
 * in the crop. A beacon with ~0 blue mass = an invisible marker.
 */
import { join, resolve } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const root = resolve(import.meta.dirname, '..')
const out = join(root, '.shots', 'task147')
mkdirSync(out, { recursive: true })
const port = 8136

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url)
    let p = decodeURIComponent(url.pathname)
    if (p === '/') p = '/demo/'
    if (p.endsWith('/')) p += 'index.html'
    const f = Bun.file(join(root, p))
    if (!(await f.exists())) return new Response('not found', { status: 404 })
    const ext = p.slice(p.lastIndexOf('.'))
    const mime = ext === '.html' ? 'text/html' : ext === '.css' ? 'text/css' : ext === '.png' ? 'image/png' : 'text/javascript'
    return new Response(f, { headers: { 'content-type': mime } })
  },
})

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
await page.goto(`http://localhost:${port}/demo/vfx/`, { waitUntil: 'networkidle' })
await page.waitForTimeout(2000)
await page.evaluate(() => document.querySelector('.pt-sheet [aria-label=Close]')?.click())

for (let shot = 0; shot < 6; shot++) {
  await page.waitForTimeout(2200)
  const rects = await page.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('.fx-label')) {
      const r = el.getBoundingClientRect()
      const st = getComputedStyle(el)
      out.push({ text: el.textContent, x: r.x + r.width / 2, y: r.y + r.height / 2, opacity: st.opacity })
    }
    return out
  })
  const pngPath = join(out, `labels-${shot}.png`)
  await page.screenshot({ path: pngPath })
  const png = PNG.sync.read(readFileSync(pngPath))
  const d = png.data, W = png.width
  console.log(`--- shot ${shot} (t=${(shot + 1) * 2.2}s)`)
  for (const r of rects) {
    // scan a 160×120 window ABOVE the label center (the beacon zone)
    let blue = 0, blueLum = 0
    const x0 = Math.max(0, Math.round(r.x - 80)), x1 = Math.min(W, Math.round(r.x + 80))
    const y0 = Math.max(0, Math.round(r.y - 120)), y1 = Math.round(r.y + 10)
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * W + x) * 4
        const rr = d[o], g = d[o + 1], b = d[o + 2]
        if (b > 50 && b > rr * 1.15 && b >= g) { blue++; blueLum += b }
      }
    }
    const avg = blue > 0 ? Math.round(blueLum / blue) : 0
    console.log(`  ${r.text} label@(${Math.round(r.x)},${Math.round(r.y)}) op=${r.opacity} bluePx=${blue} avgB=${avg}`)
  }
}
await browser.close()
server.stop()
