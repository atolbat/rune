// task183-shots — the packed record's visual verification: screenshots of
// THREE instance-mode vfx demos (billboard modes — all five orientation
// modes live; explosion — stretched + atlas; sentry — the default page)
// through the NEW dist, for the VLM eyeball gate (the f16 quantization
// must be invisible: the sprites render correctly, not just animate).
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const out = resolve(root, '.shots')
mkdirSync(out, { recursive: true })
const PORT = 8917

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg', '.woff2': 'font/woff2',
}
Bun.serve({
  port: PORT,
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
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
await page.goto(`http://localhost:${PORT}/demo/vfx/`, { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)

const REGION = { x: 60, y: 140, width: 500, height: 500 }
async function shot(demoName, file) {
  await page.evaluate((n) => {
    const rows = [...document.querySelectorAll('.pt-row')]
    rows.find(r => r.textContent.includes(n))?.dispatchEvent(new Event('click', { bubbles: true }))
  }, demoName)
  await page.waitForFunction(
    (n) => (document.querySelector('.pt-pill')?.textContent ?? '').includes(n),
    demoName, { timeout: 20_000 },
  )
  await page.waitForTimeout(2000)
  await page.screenshot({ path: join(out, file), clip: REGION, timeout: 60_000 })
  console.log(`[shot] ${demoName} → ${file}`)
}

await shot('Billboard Modes', 'task183-billboard.png')
await shot('Explosion', 'task183-explosion.png')
await shot('Fireflies', 'task183-fireflies.png')
await browser.close()
console.log('DONE')
