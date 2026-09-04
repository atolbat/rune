/**
 * scripts/task130-laser-check.mjs — the Task 130 one-off: jump straight to
 * the Laser Beam demo, dwell into the BURN phase, and prove the fix:
 *   1. the CONTINUITY gate — the beam's saturated-core pixels, projected on
 *      their principal axis, fill the muzzle→hit interval with no interior
 *      gaps (the old hash-random scatter left a dashed train: fill ~0.5);
 *   2. the TARGET gate — the orange sphere drones are VISIBLE (thousands of
 *      orange pixels; the old dark cubes were near-invisible);
 *   3. the counters — laserFrames / reflections / pops / beamAlive (the
 *      lattice stack: ~2 full covers of ~90 stations, vs the old ~36 blobs).
 * The canvas is read IN-PAGE at rAF cadence (the bolt-read trick — zero
 * latency, the buffer still holds the frame's draw).
 */
import { join, resolve } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const out = resolve(root, '.shots')
mkdirSync(out, { recursive: true })
const port = 8139

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
const errors = []
page.on('pageerror', e => errors.push(String(e)))
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })

await page.goto(`http://localhost:${port}/demo/vfx/`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => document.querySelector('#backend')?.textContent !== '…', null, { timeout: 20000 })
await page.waitForTimeout(600)
await page.evaluate(() => document.querySelector('.pt-sheet [aria-label=Close]')?.click())

// jump straight to the laser via the demo picker
await page.evaluate(() => document.querySelector('.pt-pill')?.click())
await page.waitForTimeout(300)
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.pt-row')]
  const i = rows.findIndex((r) => r.querySelector('b')?.textContent.toLowerCase().startsWith('laser'))
  rows[i]?.click()
})
const pill = await page.locator('.pt-pill').first().textContent().catch(() => '?')
console.log('demo:', pill)

// acquire → charge → burn (3.4s) → boom → the next drone: under SwiftShader
// the demo's internal clock outruns wall time, so POLL — 16 batches over
// ~14s covers at least two full burn cycles wherever they land.
const grabBatch = (n) => page.evaluate((count) => new Promise((resolve) => {
  const frames = []
  const grab = () => {
    const c = document.querySelector('canvas')
    const c2 = document.createElement('canvas')
    c2.width = c.width; c2.height = c.height
    try { c2.getContext('2d').drawImage(c, 0, 0) } catch (e) { /* keep going */ }
    frames.push(c2.toDataURL('image/png'))
    if (frames.length < count) requestAnimationFrame(grab)
    else resolve(frames)
  }
  requestAnimationFrame(grab)
}), n)

const batches = []
for (let k = 0; k < 16; k++) {
  batches.push(await grabBatch(4))
  if (k === 2) await page.screenshot({ path: join(out, 'laser-burn-page.png') })
  await page.waitForTimeout(700)
}

const counters = await page.evaluate(() => ({ ...window.__vfxCounters })).catch(() => ({}))
const logText = await page.evaluate(() => document.querySelector('#log-list')?.textContent ?? '')
console.log('counters:', JSON.stringify(counters))
console.log('log:', (logText.match(/laser: [^·]+/g) ?? []).slice(-4).join(' | '))
console.log('page errors:', errors.length, errors.length ? errors.slice(0, 3).join(' | ') : '(none)')
await browser.close()
server.stop()

// ── the analysis: continuity + the visible target ─────────────────────────
const { PNG } = await import('pngjs')

/** The per-batch accumulators: the temporal max of EACH channel (the orange
 *  test needs color; the continuity test needs the brightest channel). */
const accumulate = (grabs) => {
  let W = 0, H = 0, acc = null
  for (const g of grabs) {
    const png = PNG.sync.read(Buffer.from(g.split(',')[1], 'base64'))
    if (acc === null) { W = png.width; H = png.height; acc = new Float32Array(W * H * 3) }
    for (let p = 0; p < W * H; p++) {
      for (let c = 0; c < 3; c++) {
        const v = png.data[p * 4 + c]
        if (v > acc[p * 3 + c]) acc[p * 3 + c] = v
      }
    }
  }
  // the grayscale max composite for eyeballing
  const o = new PNG({ width: W, height: H })
  for (let p = 0; p < W * H; p++) {
    const v = Math.round(Math.max(acc[p * 3], acc[p * 3 + 1], acc[p * 3 + 2]))
    o.data[p * 4] = v; o.data[p * 4 + 1] = v; o.data[p * 4 + 2] = v; o.data[p * 4 + 3] = 255
  }
  return { W, H, acc, png: o }
}

const analyze = (label, grabs, keep) => {
  const { W, H, acc, png } = accumulate(grabs)
  if (keep) writeFileSync(join(out, `laser-${label}-max.png`), PNG.sync.write(png))

  // 1) the CONTINUITY gate — the saturated core (max-channel ≥ 230), PCA to
  //    the beam's own principal axis, the projection histogram, the gaps
  const core = []
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x
    if (Math.max(acc[p * 3], acc[p * 3 + 1], acc[p * 3 + 2]) >= 230) core.push([x, y])
  }
  let fill = 0, gapMax = 0, span = 0
  if (core.length > 40) {
    let mx = 0, my = 0
    for (const [x, y] of core) { mx += x; my += y }
    mx /= core.length; my /= core.length
    let sxx = 0, sxy = 0, syy = 0
    for (const [x, y] of core) { const dx = x - mx, dy = y - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy }
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy) // the principal axis
    const ux = Math.cos(theta), uy = Math.sin(theta)
    const proj = core.map(([x, y]) => (x - mx) * ux + (y - my) * uy).sort((a, b) => a - b)
    const p5 = proj[Math.floor(proj.length * 0.05)], p95 = proj[Math.floor(proj.length * 0.95)]
    span = p95 - p5
    const BIN = 4
    const bins = new Uint8Array(Math.max(1, Math.ceil(span / BIN) + 1))
    for (const v of proj) {
      const b = Math.floor((v - p5) / BIN)
      if (b >= 0 && b < bins.length) bins[b] = 1
    }
    let filled = 0, run = 0
    for (const b of bins) {
      if (b) { filled++; if (run > gapMax) gapMax = run; run = 0 } else run++
    }
    if (run > gapMax) gapMax = run
    fill = filled / bins.length
    gapMax *= BIN
  }

  // 2) the TARGET gate — the orange drone spheres (r warm, b cold; the
  //    saturated white-blue beam core excluded by the b<r-60 test)
  let orange = 0, ox = 0, oy = 0, oxMin = 1e9, oxMax = -1e9, oyMin = 1e9, oyMax = -1e9
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x, i = p * 3
    const r = acc[i], g = acc[i + 1], b = acc[i + 2]
    if (r > 120 && g > 40 && g < 170 && b < 90 && r - b > 60) {
      orange++; ox += x; oy += y
      if (x < oxMin) oxMin = x; if (x > oxMax) oxMax = x
      if (y < oyMin) oyMin = y; if (y > oyMax) oyMax = y
    }
  }
  const cx = orange > 0 ? ox / orange : -1, cy = orange > 0 ? oy / orange : -1
  console.log(`\n== ${label}: ${W}x${H}`)
  console.log(`  core pixels(≥230): ${core.length} — axis fill ${(100 * fill).toFixed(1)}% of span ${span.toFixed(0)}px, largest interior gap ${gapMax.toFixed(0)}px`)
  console.log(`  orange target pixels: ${orange} — centroid (${cx.toFixed(0)}, ${cy.toFixed(0)}), bbox ${oxMax - oxMin}x${oyMax - oyMin}px`)
  return { fill, gapMax, core: core.length, orange }
}

const results = []
let bestIdx = -1
for (let k = 0; k < batches.length; k++) {
  const r = analyze(`b${k}`, batches[k], false)
  results.push(r)
  if (r.core >= 3000 && (bestIdx < 0 || r.core > results[bestIdx].core)) bestIdx = k
}
if (bestIdx >= 0) analyze(`best`, batches[bestIdx], true)
console.log(`batch core pixels: [${results.map(r => r.core).join(', ')}]`)

// the verdict — the burn batches are those with a real core mass; require
// at least TWO of them (different burn moments) each solid, the target
// visible in every sampled batch, and no batch showing a dashed fill.
const burnBatches = results.filter(r => r.core >= 3000)
const solid = burnBatches.filter(r => r.fill >= 0.85 && r.gapMax <= 12)
const okFill = burnBatches.length >= 2 && solid.length === burnBatches.length
const okTarget = results.every(r => r.orange >= 600)
console.log(`\nVERDICT: ${burnBatches.length} burn batches sampled, ${solid.length} solid (fill ≥85%, gap ≤12px) — continuity ${okFill ? 'PASS' : 'FAIL'}; target visible ${okTarget ? 'PASS' : 'FAIL'} (orange ≥600px in every batch)`)
console.log(`counters: laserFrames ${counters.laserFrames ?? 'n/a'}, beamAlive ${counters.beamAlive ?? 'n/a'} (the lattice stack; the old sparse scatter held ~36), reflections ${counters.reflections ?? 'n/a'}, pops ${counters.pops ?? 'n/a'}, destroys ${counters.destroys ?? 'n/a'}`)
process.exit(okFill && okTarget ? 0 : 1)
