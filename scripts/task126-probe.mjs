/** scripts/task126-probe.mjs — the Task 126 visual probe: screenshots of the
 *  demos this batch touched (WebGL2 + a WebGPU toggle leg), so a fix can be
 *  SEEN before the full demo-shots sweep. Not a gate — a dev aid. */
import { join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const out = resolve(root, '.shots')
mkdirSync(out, { recursive: true })
const port = 8131
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary', '.fbx': 'application/octet-stream', '.wasm': 'application/wasm',
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
await page.goto(`http://localhost:${port}/demo/quarks/`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => /Muzzle Flash ×100 · [1-9][\d,]* particles/.test(document.querySelector('.pt-pill')?.textContent ?? ''), null, { timeout: 30000 })
await page.evaluate(() => document.querySelector('.pt-sheet [aria-label=Close]')?.click())

async function gotoDemo(title) {
  for (let guard = 0; guard < 26; guard++) {
    const pill = await page.textContent('.pt-pill').catch(() => '')
    if (pill.startsWith(title + ' ·')) return true
    await page.click('.pt-arrow:last-child')
    await page.waitForFunction(
      () => /^[\w ()&'-]+ · \d[\d,]* particles/.test(document.querySelector('.pt-pill')?.textContent ?? ''),
      null, { timeout: 30000 },
    ).catch(() => {})
  }
  return false
}

const targets = [
  { title: 'Soft Particles', settle: 2600, name: 'soft' },
  { title: 'Custom Blending', settle: 2400, name: 'blending' },
  { title: 'Follow Object', settle: 5200, name: 'follow' },
  { title: 'Rocket', settle: 3800, name: 'rocket' },
  { title: 'Rainstorm', settle: 4200, name: 'storm' },
  { title: 'Sword Slash', settle: 8200, name: 'slash' },
  { title: 'Vortex', settle: 4200, name: 'vortex' },
  { title: 'Alpha Test (leaves)', settle: 4200, name: 'alphatest' },
]

for (const t of targets) {
  const ok = await gotoDemo(t.title)
  if (!ok) { console.log(`MISS ${t.title}`); continue }
  await page.waitForTimeout(t.settle)
  await page.screenshot({ path: join(out, `t126-${t.name}-gl2.png`) })
  const log = await page.evaluate(() => (document.querySelector('#log-list')?.textContent ?? '').slice(-400))
  const gpu = /GPU: |GL: |rendering stopped/i.test(log) ? 'GPU-ERRORS' : 'gpu-clean'
  console.log(`${t.title}: shot + ${gpu}`)
}

// the soft demo's backend round trip on THIS page (the GL error repro)
await gotoDemo('Soft Particles')
await page.waitForTimeout(2000)
await page.click('#rd-fab')
await page.click('label[for="mode-webgpu"]')
await page.mouse.click(640, 60)
await page.waitForTimeout(3000)
const badge = await page.textContent('#backend').catch(() => '…')
await page.screenshot({ path: join(out, 't126-soft-wgpu.png') })
await page.click('#rd-fab')
await page.click('label[for="mode-webgl2"]')
await page.mouse.click(640, 60)
await page.waitForTimeout(2500)
const badge2 = await page.textContent('#backend').catch(() => '…')
await page.screenshot({ path: join(out, 't126-soft-roundtrip.png') })
const log2 = await page.evaluate(() => (document.querySelector('#log-list')?.textContent ?? '').slice(-800))
console.log(`soft round trip: ${badge} → ${badge2}; log tail: ${log2.slice(-300).replace(/\n/g, ' | ')}`)
if (errors.length) console.log('PAGE ERRORS:', errors.slice(0, 5))
server.stop()
await browser.close()
