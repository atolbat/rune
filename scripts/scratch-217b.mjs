// scratch-217b — probe: does the GL mobile leg double-attach controls?
import { chromium } from 'playwright'
import { join } from 'node:path'
const root = join(import.meta.dirname, '..')
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})
const server = Bun.serve({
  port: 8944,
  async fetch(request) {
    let pathname = decodeURIComponent(new URL(request.url).pathname)
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = Bun.file(join(root, pathname))
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    const ext = pathname.slice(pathname.lastIndexOf('.'))
    return new Response(file, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})
const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 })
const page = await ctx.newPage()
page.on('pageerror', e => console.log('PAGEERROR:', e.message.slice(0, 120)))
await page.goto('http://localhost:8944/demo/walker/?crowd=1500&bare&mode=webgl2', { waitUntil: 'networkidle', timeout: 90_000 })
await page.waitForFunction(() => window.__walker && window.__walker.frame > 80 && window.__walker.drawn > 0, null, { timeout: 240_000 })
const probe = await page.evaluate(() => ({
  joys: document.querySelectorAll('.walker-joy').length,
  knobs: document.querySelectorAll('.walker-joy-knob').length,
  jumps: document.querySelectorAll('.walker-jump').length,
  canvases: document.querySelectorAll('#hiz-canvas').length,
  fps: window.__walker.fps,
  frame: window.__walker.frame,
}))
console.log('probe:', JSON.stringify(probe))
await page.waitForTimeout(2000)
const probe2 = await page.evaluate(() => ({ fps: window.__walker.fps, frame: window.__walker.frame, joys: document.querySelectorAll('.walker-joy').length }))
console.log('probe2:', JSON.stringify(probe2))
await ctx.close()
server.stop(true)
await browser.close()

// ── the exact joystick sequence with frame timing ──
const ctx2 = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 })
const page2 = await ctx2.newPage()
await page2.goto('http://localhost:8944/demo/walker/?crowd=1500&bare&mode=webgl2', { waitUntil: 'networkidle', timeout: 90_000 })
await page2.waitForFunction(() => window.__walker && window.__walker.frame > 80 && window.__walker.drawn > 0, null, { timeout: 240_000 })
const r = await page2.evaluate(() => { const r = document.getElementById('hiz-canvas').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
const jx = r.x + r.w * 0.25, jy = r.y + r.h * 0.72
const disp = (t, px, py) => page2.evaluate(([tt, x2, y2]) => {
  document.getElementById('hiz-canvas').dispatchEvent(new PointerEvent(tt, { pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x2, clientY: y2, bubbles: true, cancelable: true }))
}, [t, px, py])
await disp('pointerdown', jx, jy)
for (let k = 1; k <= 12; k++) { await disp('pointermove', jx + k * 8, jy); await page2.waitForTimeout(40) }
await page2.waitForTimeout(500)
console.log('after drag:', JSON.stringify(await page2.evaluate(() => ({ x: window.__walker.x, speed: window.__walker.speed, frame: window.__walker.frame }))))
await disp('pointerup', jx + 96, jy)
for (let w = 0; w < 6; w++) {
  await page2.waitForTimeout(250)
  console.log(`after up +${(w + 1) * 250}ms:`, JSON.stringify(await page2.evaluate(() => ({ speed: window.__walker.speed, frame: window.__walker.frame, active: window.__walker.joyActive, fade: parseFloat(getComputedStyle(document.querySelector('.walker-joy')).opacity) }))))
}
await ctx2.close()
