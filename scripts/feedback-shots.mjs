/**
 * scripts/feedback-shots.mjs — the feedback-round visual check (dev tool):
 * walks the vfx carousel to the demos named on the command line and shoots
 * a timed sequence for each (some demos only show their point in flight —
 * the lightning strike, the explosion phases). Usage:
 *   bun scripts/feedback-shots.mjs lightning explosion dust
 */
import { join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const out = resolve(root, '.shots')
mkdirSync(out, { recursive: true })
const port = 8129

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
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
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') console.log(`[console.error]`, m.text().slice(0, 300)) })
await page.goto(`http://localhost:${port}/demo/vfx/`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => document.querySelector('#backend')?.textContent !== '…', null, { timeout: 20000 })
await page.waitForTimeout(1500)

async function switchTo(name) {
  await page.evaluate(() => document.querySelector('.pt-pill')?.click())
  await page.waitForTimeout(300)
  // the rows are in carousel order; find the one whose title starts with name
  const idx = await page.evaluate((needle) => {
    const rows = [...document.querySelectorAll('.pt-row')]
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].querySelector('b')?.textContent.toLowerCase().startsWith(needle)) return i
    }
    return -1
  }, name.toLowerCase())
  if (idx < 0) { console.log(`!! demo "${name}" not found`); return false }
  await page.evaluate((i) => document.querySelectorAll('.pt-row')[i].click(), idx)
  await page.waitForTimeout(400)
  return true
}

const wanted = process.argv.slice(2)
const DEFAULTS = ['muzzle', 'explosion', 'trail', 'soft', 'blending', 'follow', 'dust', 'grass', 'lightning', 'storm']
for (const name of (wanted.length ? wanted : DEFAULTS)) {
  const ok = await switchTo(name)
  if (!ok) continue
  const label = await page.textContent('.pt-pill').catch(() => '?')
  console.log(`── ${name} (${label.trim()})`)
  // per-demo timing: shoot a burst of frames
  const n = name === 'lightning' || name === 'storm' ? 14 : 6
  for (let k = 0; k < n; k++) {
    await page.waitForTimeout(700)
    await page.screenshot({ path: join(out, `fb-${name}-${String(k).padStart(2, '0')}.png`) })
  }
}

console.log('page errors:', errors.length ? errors : 'none')
await browser.close()
server.stop()
