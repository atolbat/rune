/**
 * scripts/task147-muzzle-probe.mjs — the sentry-turret visual diagnosis:
 * serves the repo, opens the vfx page (demo #0 IS the turret), rides ~30 s
 * of burst cycles, and captures:
 *   · screenshots every ~1.5 s (aim → fire → volley → impacts)
 *   · the __vfxCounters (shots / bolts / impacts / reflections)
 *   · the shell log's sentry lines (the exact target coords per burst)
 *   · the live layer table (window.__vfxLayers — per-layer alive counts)
 * Then prints a per-shot summary so we can see WHERE the fire lands.
 */
import { join, resolve } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const out = join(root, '.shots', 'task147')
mkdirSync(out, { recursive: true })
const port = 8135

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
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
const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

await page.goto(`http://localhost:${port}/demo/vfx/`, { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)
// close the picker sheet if it booted open
await page.evaluate(() => document.querySelector('.pt-sheet [aria-label=Close]')?.click())
await page.waitForTimeout(500)

const label = await page.locator('.pt-pill').first().textContent().catch(() => '?')
console.log('active demo:', label)

const shots = []
const t0 = Date.now()
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(1500)
  const counters = await page.evaluate(() => ({ ...window.__vfxCounters })).catch(() => ({}))
  const logText = await page.evaluate(() => {
    const el = document.querySelector('.log, .pt-log, #log')
    return el ? el.textContent : ''
  }).catch(() => '')
  const sentryLines = (logText.match(/sentry [^\n]*/g) ?? []).slice(-2)
  shots.push({ i, ms: Date.now() - t0, counters, sentryLines })
  await page.screenshot({ path: join(out, `muzzle-${String(i).padStart(2, '0')}.png`) })
  console.log(`t=${((Date.now() - t0) / 1000).toFixed(1)}s`, JSON.stringify(counters), sentryLines.join(' // '))
}

// the layer table — per-layer counts (are the markers ALIVE?)
const layers = await page.evaluate(() => {
  const rows = []
  for (const l of window.__vfxLayers ?? []) {
    rows.push({ id: l.id, kind: l.facade?.stats ? 'facade' : '?', alive: l.facade?.alive ?? null })
  }
  return rows
}).catch(() => [])
console.log('layers:', JSON.stringify(layers))

// the full sentry log — every burst's target
const fullLog = await page.evaluate(() => document.querySelector('.log, .pt-log, #log')?.textContent ?? '').catch(() => '')
const allSentry = fullLog.match(/sentry [^\n]*/g) ?? []
console.log(`sentry bursts logged: ${allSentry.length}`)
for (const l of allSentry) console.log('  ', l)
console.log('page errors:', errors.length, errors.length ? errors.slice(0, 3).join(' | ').slice(0, 300) : '(none)')

writeFileSync(join(out, 'summary.json'), JSON.stringify({ label, shots, allSentry, errors }, null, 2))
await browser.close()
server.stop()
console.log('done — shots in', out)
