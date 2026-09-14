/**
 * scripts/task204-probe.mjs — the quick live probe of the Task-204 demo
 * changes (particles first): boots the demo headless, walks the frame
 * graph channel, the cull accounting, and the pause gate (the staleness
 * law). Exit 0 = the bricks compose; 1 = they do not.
 */
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const port = 8144

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.fbx': 'application/octet-stream',
  '.wasm': 'application/wasm',
}

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url)
    let pathname = decodeURIComponent(url.pathname)
    if (pathname === '/') pathname = '/demo/particles/'
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = Bun.file(join(root, pathname))
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    const ext = pathname.slice(pathname.lastIndexOf('.'))
    return new Response(file, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox',
    '--no-sandbox',
  ],
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })

await page.goto(`http://localhost:${port}/demo/particles/`, { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)

const probe = await page.evaluate(() => {
  const fg = window.__fgDebug?.last?.() ?? null
  const cull = window.__ptCull?.() ?? null
  return {
    fg,
    cull,
    pill: document.querySelector('.pt-pill')?.textContent ?? null,
    graphLine: document.querySelector('.pt-graph')?.textContent ?? null,
  }
})
console.log('[204] graph line:', probe.graphLine)
console.log('[204] pill:', probe.pill)
console.log('[204] cull:', JSON.stringify(probe.cull))
if (probe.fg !== null) {
  console.log('[204] live passes:', probe.fg.live.join(' → '))
  console.log('[204] gated:', JSON.stringify(probe.fg.gated), '· culled:', JSON.stringify(probe.fg.culled))
  console.log('[204] barriers:', JSON.stringify(probe.fg.barriers))
  console.log('[204] slots:', JSON.stringify(probe.fg.slots))
  console.log('[204] overlap:', JSON.stringify(probe.fg.overlap))
  console.log('[204] stale:', JSON.stringify(probe.fg.stale), '· stats:', JSON.stringify(probe.fg.stats))
} else {
  console.log('[204] __fgDebug MISSING')
}

// the pause leg: the sim gate + the staleness law (fullscreen shell — the
// controls live behind the FAB; open the sheet first)
await page.click('.rd-fab')
await page.click('#pause')
await page.waitForTimeout(1800)
const paused = await page.evaluate(() => ({
  fg: window.__fgDebug?.last?.() ?? null,
  cull: window.__ptCull?.() ?? null,
  graphLine: document.querySelector('.pt-graph')?.textContent ?? null,
}))
console.log('[204] paused graph line:', paused.graphLine)
if (paused.fg !== null) {
  console.log('[204] paused live:', paused.fg.live.join(' → '), '· gated:', JSON.stringify(paused.fg.gated))
  console.log('[204] paused stale:', JSON.stringify(paused.fg.stale))
}
await page.click('#resume')
await page.click('.rd-fab')
await page.waitForTimeout(800)
const resumed = await page.evaluate(() => window.__ptCull?.() ?? null)
console.log('[204] resumed cull:', JSON.stringify(resumed))

const pass = []
pass.push(['fg channel', probe.fg !== null])
pass.push(['pill carries cull', (probe.pill ?? '').includes('cull')])
pass.push(['graph line live', (probe.graphLine ?? '').includes('frame graph:')])
pass.push(['sim in live frame', (probe.fg?.live ?? []).includes('sim')])
pass.push(['present in live frame', (probe.fg?.live ?? []).includes('present')])
pass.push(['the frustum gate culls (fountain, default camera)', (probe.cull?.culled ?? 0) > 100])
pass.push(['cull accounting: alive = baked + culled', Math.abs((probe.cull?.alive ?? 0) - (probe.cull?.baked ?? 0) - (probe.cull?.culled ?? 0)) <= 2])
pass.push(['paused gates sim', (paused.fg?.gated ?? []).includes('sim')])
pass.push(['staleness grew while paused', (paused.fg?.stale?.state ?? -1) >= 10])
pass.push(['resumed, stale reset', (resumed?.stale ?? -1) <= 2])
pass.push(['zero errors', errors.length === 0])
if (errors.length > 0) console.log('[204] errors:', errors.slice(0, 5))

let ok = true
for (const [name, good] of pass) {
  console.log(`[204] ${name}: ${good ? 'PASS' : 'FAIL'}`)
  if (!good) ok = false
}

await browser.close()
server.stop(true)
process.exit(ok ? 0 : 1)
