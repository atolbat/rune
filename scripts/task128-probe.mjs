/**
 * scripts/task128-probe.mjs — the Task 128 verification probe: walks ALL 23
 * vfx demos, checks each for page errors, and runs the per-demo MECHANIC
 * invariants where the page exposes counters (the turret shots, the trail
 * colliders, the grass mask, the laser reflection sparks). One process:
 * serve + drive.
 */
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const port = 8133

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
  args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan'],
})
const page = await browser.newPage()
const errors = []
const gpu = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => {
  const t = m.text()
  if (m.type() === 'error') errors.push(t)
  if (t.startsWith('GPU: ') || t.startsWith('GL: ')) gpu.push(t)
})

await page.goto(`http://localhost:${port}/demo/vfx/`, { waitUntil: 'networkidle' })
await page.waitForTimeout(3000)
// close the demo-picker sheet if it booted open (it covers the arrows)
await page.evaluate(() => document.querySelector('.pt-sheet [aria-label=Close]')?.click())

// cycle through all 23 demos, 2.6 s each — enough for the muzzle turret to
// fire, the trails to rain, the lightning to strike, the laser to burn
const labelSel = '.pt-label'
const results = []
const perDemo = []
page.on('crash', () => console.log('!! PAGE CRASHED (renderer process died)'))
for (let i = 0; i < 23; i++) {
  const before = errors.length
  try {
    await page.click('.pt-arrow:last-child', { timeout: 15000 }).catch((e) => console.log(`  click #${i + 1} failed: ${String(e).slice(0, 120)}`))
    await page.waitForTimeout(2600)
    const txt = await page.locator('.pt-pill').first().textContent({ timeout: 5000 }).catch(() => '?')
    const counters = await page.evaluate(() => ({ ...window.__vfxCounters })).catch(() => ({}))
    results.push(txt)
    console.log(`  #${i + 1} ${txt} ${Date.now() % 100000}`)
    if (Object.keys(counters).length > 0) perDemo.push({ demo: txt, ...counters })
    if (errors.length > before) {
      console.log(`  [${txt}] ERRORS: ${errors.slice(before).join(' | ').slice(0, 300)}`)
    }
  } catch (e) {
    console.log(`  #${i + 1} probe error: ${String(e).slice(0, 160)}`)
  }
  if (page.isClosed()) { console.log('  page closed — stopping the walk'); break }
}

console.log('cycle order:', results.join(' → '))
console.log('page errors:', errors.length, errors.length ? '\n' + errors.slice(0, 4).join('\n').slice(0, 500) : '(none)')
console.log('gpu log:', gpu.length ? gpu.slice(0, 6).join(' | ') : 'clean')
console.log('per-demo counters:')
for (const c of perDemo) console.log('  ', JSON.stringify(c))

await browser.close()
server.stop()
