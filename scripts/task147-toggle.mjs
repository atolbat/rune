import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
const root = resolve(import.meta.dirname, '..')
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' }
const server = Bun.serve({ port: 8142, async fetch(r) {
  const u = new URL(r.url); let p = decodeURIComponent(u.pathname)
  if (p === '/') p = '/demo/'; if (p.endsWith('/')) p += 'index.html'
  const f = Bun.file(join(root, p))
  if (!(await f.exists())) return new Response('not found', { status: 404 })
  return new Response(f, { headers: { 'content-type': MIME[p.slice(p.lastIndexOf('.'))] ?? 'application/octet-stream' } })
}})
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.goto('http://localhost:8142/demo/vfx/', { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)
await page.evaluate(() => document.querySelector('.pt-sheet [aria-label=Close]')?.click())
const count = () => page.evaluate(() => document.querySelectorAll('.fx-label').length)
const backend = () => page.evaluate(() => document.querySelector('#backend')?.textContent)
const switchMode = async (mode) => {
  await page.evaluate((m) => { const el = document.querySelector(`#mode-${m}`); if (el) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })) } }, mode)
  await page.waitForTimeout(4200)
}
console.log('boot: labels=', await count(), 'backend=', await backend())
await switchMode('webgpu')
console.log('webgpu: labels=', await count(), 'backend=', await backend())
await switchMode('webgl2')
console.log('webgl2: labels=', await count(), 'backend=', await backend())
console.log('errors:', errors.length ? errors.slice(0, 3) : '(none)')
await browser.close(); server.stop()
