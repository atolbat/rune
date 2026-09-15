// scratch-217f — THE GL FLICKER PROBE + THE LIVE-WG STATE DUMP.
// Part 1: the walker's GL leg, autopilot walking — sample `drawn` at rAF
//         granularity in-page for ~20s; oscillation analysis (the flicker
//         signature: rapid up-down swings beyond movement explanation).
// Part 2: the forced live-WG page's adapter/canvas state (what differs from
//         a real GPU: format, features, msaa).
import { chromium } from 'playwright'
import { join } from 'node:path'
const root = join(import.meta.dirname, '..')
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})
const server = Bun.serve({
  port: 8947,
  async fetch(request) {
    let pathname = decodeURIComponent(new URL(request.url).pathname)
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = Bun.file(join(root, pathname))
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    const ext = pathname.slice(pathname.lastIndexOf('.'))
    return new Response(file, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

// ── Part 1: the GL flicker probe ─────────────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 960, height: 720 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message.slice(0, 150)))
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 150)) })
  console.log('[gl] goto…')
  await page.goto('http://localhost:8947/demo/walker/?mode=webgl2&crowd=1500', { waitUntil: 'networkidle', timeout: 90_000 })
  await page.waitForFunction(() => window.__walker && window.__walker.frame > 100 && window.__walker.drawn > 0, null, { timeout: 240_000 })
  console.log('[gl] booted, sampling drawn at rAF granularity for ~20 s (autopilot walking)…')
  const series = await page.evaluate(() => new Promise(resolve => {
    const samples = []
    let n = 0
    const tick = () => {
      const w = window.__walker
      if (w) samples.push(w.drawn)
      if (++n < 1200) requestAnimationFrame(tick); else resolve(samples) // ~20 s at 60fps
    }
    requestAnimationFrame(tick)
  }), { timeout: 120_000 })
  // in-node analysis: oscillation = sign flips of consecutive diffs
  let flips = 0, bigSwings = 0, maxUp = 0, maxDown = 0, prevDiff = 0
  for (let i = 1; i < series.length; i++) {
    const d = series[i] - series[i - 1]
    if (d > 0) maxUp = Math.max(maxUp, d)
    if (d < 0) maxDown = Math.max(maxDown, -d)
    if (prevDiff !== 0 && d !== 0 && Math.sign(d) !== Math.sign(prevDiff)) flips++
    if (prevDiff !== 0 && d !== 0 && Math.sign(d) !== Math.sign(prevDiff) && Math.abs(d) >= 3 && Math.abs(prevDiff) >= 3) bigSwings++
    if (d !== 0) prevDiff = d
  }
  const uniq = [...new Set(series)]
  console.log(`[gl] samples=${series.length} · drawn range [${Math.min(...series)}..${Math.max(...series)}] · unique=${uniq.length}`)
  console.log(`[gl] diff sign flips=${flips} · BIG swings (±3 both ways)=${bigSwings} · maxUp=${maxUp} maxDown=${maxDown}`)
  console.log(`[gl] first 60: ${series.slice(0, 60).join(',')}`)
  console.log(`[gl] errors: ${errors.length ? errors.join(' | ') : 'none'}`)
  await ctx.close()
}

// ── Part 2: the live-WG adapter/canvas state ─────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 })
  const page = await ctx.newPage()
  await page.goto('http://localhost:8947/demo/walker/?mode=webgpu&live=1&crowd=512', { waitUntil: 'networkidle', timeout: 90_000 })
  await page.waitForFunction(() => window.__walker && window.__walker.frame > 40, null, { timeout: 180_000 })
  const state = await page.evaluate(async () => {
    const c = document.getElementById('hiz-canvas')
    const probe = {}
    try {
      probe.preferredFormat = navigator.gpu.getPreferredCanvasFormat()
      const ad = await navigator.gpu.requestAdapter()
      probe.adapterFeatures = ad.features instanceof Set ? [...ad.features].filter(f => /float32|timestamp|depth/i.test(f)) : String(ad.features)
      probe.ctxKind = c.getContext('webgpu') !== null ? 'webgpu' : (c.getContext('webgl2') !== null ? 'webgl2' : '?')
    } catch (e) { probe.err = String(e).slice(0, 120) }
    const r = c.getBoundingClientRect()
    return { ...probe, canvasCss: `${r.width}x${r.height}`, canvasPx: `${c.width}x${c.height}`, dpr: devicePixelRatio, kind: window.__walker.kind, backend: window.__walker.backend }
  })
  console.log('[live-wg state]:', JSON.stringify(state, null, 1))
  await ctx.close()
}
await browser.close(); server.stop()
