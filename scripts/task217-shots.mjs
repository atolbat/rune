// task217-shots.mjs — the field-report reproduction: screenshots of the
// walker demo in BOTH orientations on BOTH backends, plus canvas pixel
// brightness stats (the "terrain is black" report's own evidence).
import { chromium } from 'playwright'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

const root = join(import.meta.dirname, '..')
const outDir = join(root, 'scripts', 'out')
mkdirSync(outDir, { recursive: true })
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})
const server = Bun.serve({
  port: 8943,
  async fetch(request) {
    let pathname = decodeURIComponent(new URL(request.url).pathname)
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = Bun.file(join(root, pathname))
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    const ext = pathname.slice(pathname.lastIndexOf('.'))
    return new Response(file, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

const cases = [
  { name: 'wg-landscape', mode: 'webgpu', vp: { width: 960, height: 720 }, touch: false },
  { name: 'gl-landscape', mode: 'webgl2', vp: { width: 960, height: 720 }, touch: false },
  { name: 'wg-portrait', mode: 'webgpu', vp: { width: 390, height: 780 }, touch: true },
  { name: 'gl-portrait', mode: 'webgl2', vp: { width: 390, height: 780 }, touch: true },
]

for (const c of cases) {
  const ctx = await browser.newContext({
    viewport: c.vp,
    hasTouch: c.touch,
    isMobile: c.touch,
    deviceScaleFactor: c.touch ? 3 : 1,
  })
  const page = await ctx.newPage()
  await page.goto(`http://localhost:8943/demo/walker/?crowd=1500${c.mode === 'webgl2' ? '&mode=webgl2' : ''}`, { waitUntil: 'networkidle', timeout: 90_000 })
  // a walking frame — let the autopilot move off the plaza a bit
  await page.waitForFunction(() => window.__walker && window.__walker.frame > 240 && window.__walker.drawn > 0, null, { timeout: 300_000 })
  const info = await page.evaluate(() => {
    const c = document.getElementById('hiz-canvas')
    return {
      canvasRect: c ? { w: c.clientWidth, h: c.clientHeight } : null,
      pageRect: { w: innerWidth, h: innerHeight },
      stats: { x: window.__walker.x, y: window.__walker.y, z: window.__walker.z, drawn: window.__walker.drawn },
    }
  })
  await page.screenshot({ path: join(outDir, `walker217-${c.name}.png`) })
  console.log(`[shot] ${c.name}: canvas ${info.canvasRect.w}x${info.canvasRect.h} of page ${info.pageRect.w}x${info.pageRect.h} · walker at (${info.stats.x},${info.stats.y},${info.stats.z}) drawn=${info.stats.drawn}`)
  await ctx.close()
}
server.stop(true)
await browser.close()
console.log('[shot] done')
