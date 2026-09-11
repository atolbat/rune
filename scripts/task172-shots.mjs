// task172 — THE VISUAL PROBE: phone-viewport screenshots of the particle
// galaxy + the world-locked sky, saved for the VLM review.
// The instrument: WebGL2 (the SwiftShader-WG canvas lies to screenshots —
// the task152 lesson; the WG boot liveness is the task169 gate's job).
import { chromium } from 'playwright'

const root = '/home/z/my-project/rune'
const port = Number(process.env.TASK172_PORT ?? 8173)
const outDir = '/home/z/my-project/quarks-shots'

const server = Bun.serve({
  port,
  async fetch(request) {
    let pathname = decodeURIComponent(new URL(request.url).pathname)
    if (pathname === '/') pathname = '/demo/'
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = Bun.file(`${root}${pathname}`)
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    const ext = pathname.slice(pathname.lastIndexOf('.'))
    // ⚠️ .css MUST be text/css — an octet-stream stylesheet is silently
    // ignored and the whole shell layout collapses (the first shots run
    // rendered a 300×150 inline canvas and read as "black screen")
    const MIME = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.jpg': 'image/jpeg',
      '.woff2': 'font/woff2',
    }
    return new Response(await file.arrayBuffer(), { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--no-sandbox'],
})

const context = await browser.newContext({
  viewport: { width: 360, height: 663 },
  // SwiftShader is a CPU rasterizer — DPR 3 (the phone's real buffer) is
  // brutally slow HERE (the real GPU is fine); DPR 2 keeps the shots
  // honest without multi-minute waits
  deviceScaleFactor: 2,
})
const page = await context.newPage()
const errors = []
page.on('pageerror', e => errors.push(String(e).slice(0, 200)))
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })

await page.goto(`http://localhost:${port}/demo/astral/?seed=1234&mode=webgl2`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
await page.waitForFunction(() => window.__astral !== undefined && window.__astral.frame > 6, null, { timeout: 120_000 })
await page.waitForTimeout(3000) // the ESO panorama fetch settles

const shot = (name) => page.screenshot({ path: `${outDir}/t172-${name}.png` })

// 1. the full galaxy, default camera
await page.evaluate(() => { const c = window.__astral.cam; c.z = c.tz = 0.42; c.x = c.tx = 0; c.y = c.ty = 0 })
await page.waitForTimeout(1400)
await shot('galaxy-default')
console.log('[t172] shot: galaxy-default')

// 2. leaned in — the arms up close (the crispness check)
await page.evaluate(() => { const c = window.__astral.cam; c.z = c.tz = 1.5; c.x = c.tx = 240; c.y = c.ty = 160 })
await page.waitForTimeout(1400)
await shot('galaxy-zoom')
console.log('[t172] shot: galaxy-zoom')

// 3. the yaw roll — the sky must rotate WITH the galaxy
await page.evaluate(() => { const c = window.__astral.cam; c.yaw = c.tyaw = 0.9; c.z = c.tz = 0.42; c.x = c.tx = 0; c.y = c.ty = 0 })
await page.waitForTimeout(1400)
await shot('galaxy-yaw09')
console.log('[t172] shot: galaxy-yaw09')

// 4. deep zoom-out — the whole disc at once
await page.evaluate(() => { const c = window.__astral.cam; c.yaw = c.tyaw = 0; c.z = c.tz = 0.28 })
await page.waitForTimeout(1400)
await shot('galaxy-far')
console.log('[t172] shot: galaxy-far')

// 5. the system view — planets + orbits (enter it HONESTLY: the camera
// zoom + the blend crossfade need real time at SwiftShader speeds)
await page.evaluate(() => {
  const a = window.__astral
  const home = a.world.systems.find(s => s.owner === 1) ?? a.world.systems[0]
  a.cam.x = a.cam.tx = home.x
  a.cam.y = a.cam.ty = home.y
  a.cam.z = a.cam.tz = 13
  a.view.mode = 'system'
  a.view.system = home
  a.view.selectedSystem = home.id
})
await page.waitForTimeout(15000)
await shot('system-view')
console.log('[t172] shot: system-view')

// 6. back to the galaxy at label zoom (the ui.js module-instance fix);
// the exit crossfade needs the slow-frame budget too
await page.evaluate(() => {
  const a = window.__astral
  a.view.mode = 'galaxy'
  a.view.system = null
  a.cam.z = a.cam.tz = 1.1
  a.cam.x = a.cam.tx = 200
  a.cam.y = a.cam.ty = 100
})
await page.waitForTimeout(10000)
await shot('galaxy-labels')
console.log('[t172] shot: galaxy-labels')

const state = await page.evaluate(() => ({
  frames: window.__astral?.frame ?? -1,
  labels: document.querySelectorAll('.as-label').length,
  visibleLabels: [...document.querySelectorAll('.as-label')].filter(el => el.style.display !== 'none').length,
}))
console.log(`[t172] frames: ${state.frames}, labels: ${state.labels}, visible: ${state.visibleLabels}`)
if (errors.length > 0) {
  console.log(`[t172] PAGE ERRORS (${errors.length}):`)
  for (const e of errors.slice(0, 6)) console.log(`  ${e}`)
}

await browser.close()
server.stop()
console.log('TASK172 SHOTS: DONE')
