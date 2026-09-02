/**
 * scripts/demo-shots.mjs — visual check of the demos (not CI): screenshots
 * of desktop and phone, the model sheet in its states, the fullscreen viewer.
 */
import { join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const out = resolve(root, '.shots')
const port = 8124

mkdirSync(out, { recursive: true })

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
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

const gallery = await browser.newPage({ viewport: { width: 960, height: 720 } })
await gallery.goto(`http://localhost:${port}/demo/`, { waitUntil: 'networkidle' })
await gallery.screenshot({ path: join(out, 'desktop-gallery.png') })

const page = await browser.newPage({ viewport: { width: 960, height: 860 } })
await page.goto(`http://localhost:${port}/demo/hello-cube/`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => document.querySelector('#backend')?.textContent !== '…', null, { timeout: 15000 })
await page.waitForTimeout(900)
await page.screenshot({ path: join(out, 'desktop-cube.png'), fullPage: true })

// WebGPU refusal in the log + how it looks in the panel
await page.click('label[for="mode-webgpu"]')
await page.waitForTimeout(800)
await page.screenshot({ path: join(out, 'desktop-webgpu-refused.png'), fullPage: true })

// phone
const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
await phone.goto(`http://localhost:${port}/demo/hello-cube/`, { waitUntil: 'networkidle' })
await phone.waitForFunction(() => document.querySelector('#backend')?.textContent !== '…', null, { timeout: 15000 })
await phone.waitForTimeout(900)
await phone.screenshot({ path: join(out, 'mobile-cube.png'), fullPage: true })

// ─── model-viewer ───────────────────────────────────────────────────────────

const viewer = await browser.newPage({ viewport: { width: 960, height: 720 } })
await viewer.goto(`http://localhost:${port}/demo/model-viewer/`, { waitUntil: 'networkidle' })
await viewer.waitForFunction(() => document.querySelector('#backend')?.textContent !== '…', null, { timeout: 15000 })

// initial state: the sheet with the Load button is the entry point
await viewer.screenshot({ path: join(out, 'desktop-mv-initial.png') })

// load → progress → the scene takes over (the UI hides itself)
await viewer.click('.mv-load')
await viewer.waitForFunction(
  () => (document.querySelector('.mv-stats')?.textContent ?? '').includes('verts'),
  null,
  { timeout: 90_000 },
)
await viewer.waitForTimeout(1200)
await viewer.screenshot({ path: join(out, 'desktop-mv-scene.png') })

// the pill reopens the sheet (compact model switcher)
await viewer.click('.mv-pill')
await viewer.waitForTimeout(400)
await viewer.screenshot({ path: join(out, 'desktop-mv-sheet.png') })

// the shell menu (FAB): backend toggle + log
await viewer.click('#rd-fab')
await viewer.waitForTimeout(400)
await viewer.screenshot({ path: join(out, 'desktop-mv-fab-sheet.png') })

// phone: initial sheet, then the fullscreen scene with the pill
const viewerPhone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
await viewerPhone.goto(`http://localhost:${port}/demo/model-viewer/`, { waitUntil: 'networkidle' })
await viewerPhone.waitForFunction(() => document.querySelector('#backend')?.textContent !== '…', null, { timeout: 15000 })
await viewerPhone.screenshot({ path: join(out, 'mobile-mv-initial.png') })

await viewerPhone.click('.mv-load')
await viewerPhone.waitForFunction(
  () => (document.querySelector('.mv-stats')?.textContent ?? '').includes('verts'),
  null,
  { timeout: 90_000 },
)
await viewerPhone.waitForTimeout(1200)
await viewerPhone.screenshot({ path: join(out, 'mobile-mv-scene.png') })

// the model sheet on the phone
await viewerPhone.click('.mv-pill')
await viewerPhone.waitForTimeout(400)
await viewerPhone.screenshot({ path: join(out, 'mobile-mv-sheet.png') })

await browser.close()
server.stop(true)
console.log(`[shots] screenshots in ${out}`)
