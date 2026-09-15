// scratch-217h — THE VERDICT OSCILLOSCOPE: per-record verdict time series on
// both legs while the autopilot walks. FLICKER = an id flipping repeatedly
// between occluded(3) and visible(1). Course boxes = ids 0..36 (drawn first,
// the K occluders); crowd = 37..N. Also tracks drawn jitter.
import { chromium } from 'playwright'
import { join } from 'node:path'
const root = join(import.meta.dirname, '..')
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})
const server = Bun.serve({
  port: 8949,
  async fetch(request) {
    let pathname = decodeURIComponent(new URL(request.url).pathname)
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = Bun.file(join(root, pathname))
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    const ext = pathname.slice(pathname.lastIndexOf('.'))
    return new Response(file, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

async function leg(mode) {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 720 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message.slice(0, 150)))
  await page.goto(`http://localhost:8949/demo/walker/?crowd=512${mode === 'webgl2' ? '&mode=webgl2' : ''}`, { waitUntil: 'networkidle', timeout: 90_000 })
  await page.waitForFunction(() => window.__walker && window.__walker.frame > 100 && window.__walker.drawn > 0, null, { timeout: 240_000 })
  console.log(`[${mode}] sampling verdicts ~15 s…`)
  const result = await page.evaluate(async () => {
    const t = window.__walkerTier
    const N = window.__walker.total
    const samples = [] // { v: Uint8Array, drawn }
    let pending = false
    const t0 = performance.now()
    await new Promise(done => {
      const tick = () => {
        if (!pending) {
          pending = true
          t.readVerdicts().then(v => { samples.push({ v, drawn: window.__walker.drawn }); pending = false }).catch(() => { pending = false })
        }
        if (performance.now() - t0 < 15000) requestAnimationFrame(tick); else done()
      }
      requestAnimationFrame(tick)
    })
    // analysis: transitions per id between occluded(3) and drawn-ish (1/4)
    const trans = new Array(N).fill(0)
    const firstSeen = new Array(N).fill(0) // samples in occluded state
    for (let s = 1; s < samples.length; s++) {
      const a = samples[s - 1].v, b = samples[s].v
      for (let i = 0; i < N; i++) {
        const oa = a[i] === 3, ob = b[i] === 3
        if (oa !== ob) trans[i]++
        if (ob) firstSeen[i]++
      }
    }
    const top = trans.map((n, i) => ({ i, n })).sort((x, y) => y.n - x.n).slice(0, 15)
      .map(o => ({ id: o.i, kind: o.i < 37 ? 'COURSE' : 'crowd', flips: o.n, occPct: Math.round(firstSeen[o.i] / samples.length * 100) }))
    const drawnSeries = samples.map(s => s.drawn)
    let dFlips = 0
    for (let i = 1; i < drawnSeries.length; i++) if (Math.sign(drawnSeries[i] - drawnSeries[i - 1]) !== 0 && Math.sign(drawnSeries[i] - drawnSeries[i - 1]) !== Math.sign(drawnSeries[i - 1] - drawnSeries[i - 2] ?? 0)) dFlips++
    return { samples: samples.length, N, top, drawn: { min: Math.min(...drawnSeries), max: Math.max(...drawnSeries) }, courseFlips: trans.slice(0, 37).filter(n => n >= 4).length, crowdFlips: trans.slice(37).filter(n => n >= 4).length }
  }, { timeout: 120_000 })
  console.log(`[${mode}] ${JSON.stringify(result)}`)
  console.log(`[${mode}] errors: ${errors.length ? errors.join(' | ') : 'none'}`)
  await ctx.close()
}

await leg('webgl2')
await leg('webgpu')
await browser.close(); server.stop()
