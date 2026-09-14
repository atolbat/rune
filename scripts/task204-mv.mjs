/**
 * scripts/task204-mv.mjs — the live probe of the model-viewer's Task-204
 * picking: loads the Forest House, taps the canvas center (the house must
 * hit), and runs the BVH-vs-brute parity probe (both tiers). Exit 0/1.
 */
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const port = 8147

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
    if (pathname === '/') pathname = '/demo/model-viewer/'
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
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 200)}`))
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`) })

await page.setViewportSize({ width: 960, height: 720 })
await page.goto(`http://localhost:${port}/demo/model-viewer/`, { waitUntil: 'networkidle' })
await page.waitForFunction(
  () => document.querySelector('#backend')?.textContent !== '…',
  null, { timeout: 15_000 },
)
// the "Load & show" flow (the smoke's own path)
await page.click('.mv-load')
await page.waitForFunction(
  () => /meshes/.test(document.querySelector('.mv-stats')?.textContent ?? ''),
  null, { timeout: 60_000 },
)
await page.waitForTimeout(1200)
const stats = await page.textContent('.mv-stats')
console.log('[204m] scene:', stats)

// the parity probe (the BVH vs the brute sweep, both tiers)
const probe = await page.evaluate(() => window.__mvDebug?.probe?.(60) ?? null)
console.log('[204m] pick probe:', JSON.stringify(probe))

// the tap: the canvas center should hit the house
const canvas = await page.locator('#canvas')
const box = await canvas.boundingBox()
const cx = box.x + box.width / 2
const cy = box.y + box.height / 2
await page.mouse.click(cx, cy)
await page.waitForTimeout(400)
const tapHit = await page.evaluate(() => {
  const log = document.querySelector('#log-list')?.textContent ?? ''
  const picks = log.split('\n').filter(l => l.includes('Pick:'))
  return picks.length > 0 ? picks[picks.length - 1] : null
})
console.log('[204m] tap log:', tapHit)

// a corner tap: the ray clears the model — the honest miss
await page.mouse.click(box.x + 8, box.y + 8)
await page.waitForTimeout(400)
const corner = await page.evaluate(() => {
  const log = document.querySelector('#log-list')?.textContent ?? ''
  return log.split('\n').filter(l => l.includes('Pick (')).length > 0
})
console.log('[204m] corner miss logged:', corner)

const pass = []
pass.push(['model loaded', /meshes/.test(stats ?? '')])
pass.push(['probe channel', probe !== null])
pass.push(['BVH == brute force (both tiers)', probe?.pass === true])
pass.push(['probe hit rays > 0', (probe?.hits ?? 0) > 0])
pass.push(['tap hit the model', tapHit !== null && tapHit.includes('triangle #')])
pass.push(['corner tap: honest miss', corner === true])
pass.push(['zero errors', errors.length === 0])
if (errors.length > 0) console.log('[204m] errors:', errors.slice(0, 5))

let ok = true
for (const [name, good] of pass) {
  console.log(`[204m] ${name}: ${good ? 'PASS' : 'FAIL'}`)
  if (!good) ok = false
}

await browser.close()
server.stop(true)
process.exit(ok ? 0 : 1)
