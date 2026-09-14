/**
 * scripts/task204-cycle.mjs — cycles ALL 24 vfx demos and finds where the
 * pill stalls (the smoke's timeout bisect): logs each demo's pill, the
 * page errors, and the frame-graph line.
 */
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const port = 8146

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
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
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 160)}`))
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`) })

await page.goto(`http://localhost:${port}/demo/vfx/`, { waitUntil: 'networkidle' })
await page.waitForFunction(
  () => /Sentry Turret · [1-9][\d,]* particles/.test(document.querySelector('.pt-pill')?.textContent ?? ''),
  null, { timeout: 25_000 },
)
// close the bottom sheet (the smoke's own step — the sheet covers the arrows)
await page.evaluate(() => document.querySelector('.pt-sheet [aria-label=Close]')?.click())

for (let i = 1; i < 24; i++) {
  await page.click('.pt-arrow:last-child')
  try {
    await page.waitForFunction(
      () => / · [1-9][\d,]* particles · [1-9][\d,]* verts/.test(document.querySelector('.pt-pill')?.textContent ?? ''),
      null, { timeout: 15_000 },
    )
    const pill = await page.textContent('.pt-pill')
    console.log(`[cycle ${i}] OK: ${pill}`)
  } catch {
    const pill = await page.textContent('.pt-pill').catch(() => '???')
    const fg = await page.evaluate(() => window.__fgDebug?.last?.()?.live?.join(' → ') ?? null).catch(() => 'eval-failed')
    console.log(`[cycle ${i}] STALLED: pill="${pill}" fg="${fg}"`)
    console.log(`[cycle ${i}] errors so far: ${JSON.stringify(errors.slice(-4))}`)
    break
  }
  if (errors.length > 0) {
    console.log(`[cycle ${i}] errors: ${JSON.stringify(errors.slice(0, 3))}`)
    errors.length = 0
  }
}

await browser.close()
server.stop(true)
