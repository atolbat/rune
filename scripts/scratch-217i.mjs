// scratch-217i — THE FLICKER BISECT: serve a PATCHED main.js per leg
// (?patch=hyst|nofeedback|noseed|noterrain) and measure the verdict
// oscillation + RUN-LENGTH structure for the top flippers. Honest silhouette
// crossings = few LONG runs; flicker = many SHORT runs (≤5 samples).
import { chromium } from 'playwright'
import { join } from 'node:path'
const root = join(import.meta.dirname, '..')
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})
const server = Bun.serve({
  port: 8950,
  async fetch(request) {
    const url = new URL(request.url)
    let pathname = decodeURIComponent(url.pathname)
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = Bun.file(join(root, pathname))
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    const ext = pathname.slice(pathname.lastIndexOf('.'))
    let body = await file.text()
    if (pathname.endsWith('main.js') && url.searchParams.has('patch')) {
      const patch = url.searchParams.get('patch')
      const before = body
      if (patch === 'hyst') body = body.replace('scene.K, 1, 0, 0, wantStats', 'scene.K, 0, 0, 0, wantStats')
      if (patch === 'nofeedback') body = body.replace('wantStats, 1, 1, 1, 1)', 'wantStats, 0, 1, 1, 1)')
      if (patch === 'noseed') body = body.replace('wantStats, 1, 1, 1, 1)', 'wantStats, 1, 0, 1, 1)')
      if (patch === 'noterrain') body = body.replace(/terrain: \{[\s\S]*?\},/, '// terrain removed for the bisect')
      if (body === before) return new Response('PATCH FAILED: ' + patch, { status: 500 })
      console.log(`  [patch ${patch}] applied`)
    }
    return new Response(body, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

async function leg(tag, patch) {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 720 } })
  const page = await ctx.newPage()
  await page.goto(`http://localhost:8950/demo/walker/?crowd=512&mode=webgl2${patch ? `&patch=${patch}` : ''}`, { waitUntil: 'networkidle', timeout: 90_000 })
  await page.waitForFunction(() => window.__walker && window.__walker.frame > 100 && window.__walker.drawn > 0, null, { timeout: 240_000 })
  const result = await page.evaluate(async () => {
    const t = window.__walkerTier
    const N = window.__walker.total
    const series = []
    let pending = false
    const t0 = performance.now()
    await new Promise(done => {
      const tick = () => {
        if (!pending) { pending = true; t.readVerdicts().then(v => { series.push(v); pending = false }).catch(() => { pending = false }) }
        if (performance.now() - t0 < 15000) requestAnimationFrame(tick); else done()
      }
      requestAnimationFrame(tick)
    })
    // run-length analysis per id: occluded runs' lengths
    const flips = new Array(N).fill(0)
    const runsShort = new Array(N).fill(0) // occluded runs of length 1..5
    const runsLong = new Array(N).fill(0)
    for (let i = 0; i < N; i++) {
      let run = 0
      for (let s = 0; s < series.length; s++) {
        const occ = series[s][i] === 3
        if (occ) { run++; if (s === series.length - 1 && run <= 5) runsShort[i]++ }
        else { if (run > 0) { if (run <= 5) runsShort[i]++; else runsLong[i]++ }; run = 0; }
      }
      let prev = series[0][i] === 3
      for (let s = 1; s < series.length; s++) { const o = series[s][i] === 3; if (o !== prev) flips[i]++; prev = o }
    }
    const top = flips.map((n, i) => ({ i, n, sh: runsShort[i], lo: runsLong[i] })).sort((a, b) => b.n - a.n).slice(0, 8)
      .map(o => ({ id: o.i, kind: o.i < 37 ? 'COURSE' : 'crowd', flips: o.n, shortRuns: o.sh, longRuns: o.lo }))
    const totShort = runsShort.reduce((a, b) => a + b, 0), totLong = runsLong.reduce((a, b) => a + b, 0)
    return { samples: series.length, top, totalShortOccludedRuns: totShort, totalLongOccludedRuns: totLong }
  }, { timeout: 120_000 })
  console.log(`[${tag}] ${JSON.stringify(result)}`)
  await ctx.close()
}

await leg('baseline', null)
await leg('hyst=0', 'hyst')
await leg('feedback=0', 'nofeedback')
await leg('seed=0', 'noseed')
await leg('terrain=off', 'noterrain')
await browser.close(); server.stop()
