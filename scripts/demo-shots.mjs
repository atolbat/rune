/**
 * scripts/demo-shots.mjs — визуальная проверка демо (не CI): скриншоты
 * десктопа и телефона + развёрнутый/свёрнутый лог, отправка WebGPU-отказа.
 */
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const out = resolve(root, '.shots')
const port = 8124

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

// отказ WebGPU в логе + его вид в панели
await page.click('label[for="mode-webgpu"]')
await page.waitForTimeout(800)
await page.screenshot({ path: join(out, 'desktop-webgpu-refused.png'), fullPage: true })

// телефон
const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
await phone.goto(`http://localhost:${port}/demo/hello-cube/`, { waitUntil: 'networkidle' })
await phone.waitForFunction(() => document.querySelector('#backend')?.textContent !== '…', null, { timeout: 15000 })
await phone.waitForTimeout(900)
await phone.screenshot({ path: join(out, 'mobile-cube.png'), fullPage: true })

await browser.close()
server.stop(true)
console.log(`[shots] скриншоты в ${out}`)
