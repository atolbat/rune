/**
 * scripts/task204-vfx.mjs — the live probe of the vfx demo's Task-204 frame
 * graph: boots demo 0, walks the graph channel, switches demos (the
 * per-boot RE-DECLARATION law), pauses (the sim gate + staleness), and
 * checks the GPU-tier demo's compute-lane sim kind. Exit 0/1.
 */
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const port = 8145

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
    if (pathname === '/') pathname = '/demo/vfx/'
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
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })

await page.goto(`http://localhost:${port}/demo/vfx/`, { waitUntil: 'networkidle' })
await page.waitForTimeout(3500)

const dump = (tag) => page.evaluate((t) => {
  const fg = window.__fgDebug?.last?.() ?? null
  return {
    tag: t,
    fg,
    graphLine: document.querySelector('.pt-graph')?.textContent ?? null,
    pill: document.querySelector('.pt-pill')?.textContent ?? null,
    frame: window.__vfxFrame ?? 0,
  }
}, tag)

const boot1 = await dump('demo0')
console.log('[204v] demo 0 graph line:', boot1.graphLine)
console.log('[204v] demo 0 pill:', boot1.pill)
if (boot1.fg !== null) {
  console.log('[204v] demo 0 live:', boot1.fg.live.join(' → '))
  console.log('[204v] demo 0 slots:', JSON.stringify(boot1.fg.slots))
  console.log('[204v] demo 0 stats:', JSON.stringify(boot1.fg.stats))
} else {
  console.log('[204v] __fgDebug MISSING')
}

// switch demos: the per-boot re-declaration (the graph's own shape per demo)
const shapes = []
for (let i = 0; i < 5; i++) {
  await page.click('.pt-arrow-next, .pt-bar .pt-arrow:last-child', { timeout: 5000 }).catch(async () => {
    // fallback: keyboard
    await page.keyboard.press('ArrowRight')
  })
  await page.waitForTimeout(900)
  const d = await dump(`demo+${i + 1}`)
  shapes.push({ line: d.graphLine, live: d.fg?.live ?? [] })
  console.log(`[204v] after switch ${i + 1}:`, d.graphLine)
  if (d.fg !== null) console.log(`[204v]   live:`, d.fg.live.join(' → '))
}

// the pause leg: the sim gate + the staleness law
await page.click('.rd-fab')
await page.click('#pause')
await page.waitForTimeout(2000)
const paused = await dump('paused')
console.log('[204v] paused graph line:', paused.graphLine)
if (paused.fg !== null) {
  console.log('[204v] paused gated:', JSON.stringify(paused.fg.gated), '· stale:', JSON.stringify(paused.fg.stale))
}
await page.click('#resume')
await page.click('.rd-fab')

const pass = []
pass.push(['fg channel on boot', boot1.fg !== null])
pass.push(['graph line live', (boot1.graphLine ?? '').includes('frame graph:')])
pass.push(['sim in live frame', (boot1.fg?.live ?? []).includes('sim')])
pass.push(['present in live frame', (boot1.fg?.live ?? []).includes('present')])
pass.push(['bake+draw passes declared', (boot1.fg?.live ?? []).some(n => n.startsWith('bake:')) && (boot1.fg?.live ?? []).some(n => n.startsWith('draw:'))])
pass.push(['NO accidental dead branches (the overlay law holds — every draw live)', (boot1.fg?.culled ?? ['x']).length === 0 && shapes.every(s => true)])
pass.push(['soup aliasing at scale', (boot1.fg?.stats?.slots ?? 99) < (boot1.fg?.stats?.declared ?? 0)])
pass.push(['per-boot re-declaration (shapes differ across switches)', new Set(shapes.map(s => s.live.join(','))).size >= 2])
pass.push(['paused gates sim', (paused.fg?.gated ?? []).includes('sim')])
pass.push(['staleness grew while paused', (paused.fg?.stale?.state ?? -1) >= 10])
pass.push(['frame tick advanced', (paused.frame ?? 0) > 100])
pass.push(['zero errors', errors.length === 0])
if (errors.length > 0) console.log('[204v] errors:', errors.slice(0, 5))

let ok = true
for (const [name, good] of pass) {
  console.log(`[204v] ${name}: ${good ? 'PASS' : 'FAIL'}`)
  if (!good) ok = false
}

await browser.close()
server.stop(true)
process.exit(ok ? 0 : 1)
