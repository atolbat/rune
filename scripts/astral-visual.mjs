/**
 * scripts/astral-visual.mjs — the Task-170 visual QA loop (dev tool).
 * Boots the demo headless (SwiftShader WebGL2), walks the views, saves
 * screenshots into quarks-shots for eyeballing:
 *   1. the galaxy view (haze + lanes + stars + nebula + sky)
 *   2. a system view (planets + orbits + rings)
 *   3. a planet closeup (zoomed system view)
 *   4. the flight clip (ship + plume)
 * Usage: bun scripts/astral-visual.mjs
 */
import { chromium } from 'playwright'

const root = '/home/z/my-project/rune'
const port = 8178
const shots = '/home/z/my-project/quarks-shots'

const server = Bun.serve({
  port,
  async fetch(request) {
    let pathname = decodeURIComponent(new URL(request.url).pathname)
    if (pathname === '/') pathname = '/demo/'
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = Bun.file(`${root}${pathname}`)
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    const ext = pathname.slice(pathname.lastIndexOf('.'))
    const MIME = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.jpg': 'image/jpeg',
      '.png': 'image/png',
    }
    return new Response(await file.arrayBuffer(), { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

const errors = []
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--no-sandbox'],
})
const context = await browser.newContext({ viewport: { width: 960, height: 720 } })
const page = await context.newPage()
page.on('pageerror', e => errors.push(String(e).slice(0, 300)))
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)) })

await page.goto(`http://localhost:${port}/demo/astral/?seed=1234`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForFunction(() => window.__astral !== undefined && window.__astral.frame > 8, null, { timeout: 30_000 })
await page.waitForTimeout(2500)

// 1. the galaxy view
await page.screenshot({ path: `${shots}/astral170-1-galaxy.png`, timeout: 60_000 })
console.log('shot 1: galaxy view')

// 2. enter the homeworld system
const homeTap = await page.evaluate(() => {
  const home = window.__astral.world.systems.find(s => s.owner === 1)
  return window.__astral.project(home.x, home.y)
})
await page.mouse.click(homeTap.x, homeTap.y)
await page.waitForTimeout(400)
await page.mouse.click(homeTap.x, homeTap.y) // second tap → enter
await page.waitForTimeout(2200)
await page.screenshot({ path: `${shots}/astral170-2-system.png`, timeout: 60_000 })
console.log('shot 2: system view')

// 3. zoom in close (pinch simulation through zoomAt's math: set cam targets)
await page.evaluate(() => {
  const cam = window.__astral.cam
  cam.tz = 28
})
await page.waitForTimeout(1500)
await page.screenshot({ path: `${shots}/astral170-3-closeup.png`, timeout: 60_000 })
console.log('shot 3: planet closeup')

// 4. twist the camera (yaw) in the system view — the 3D plane rotates
await page.evaluate(() => {
  const cam = window.__astral.cam
  cam.tyaw = 1.1
  cam.ttilt = 0.5
})
await page.waitForTimeout(1500)
await page.screenshot({ path: `${shots}/astral170-4-twist.png`, timeout: 60_000 })
console.log('shot 4: twisted system view')

// 5. back to galaxy, zoomed OUT wide (tilt + sky + nebulae)
await page.evaluate(() => {
  const cam = window.__astral.cam
  cam.tyaw = 0.6
  cam.tz = 0.3
  const actions = window.__astral.view
  actions.mode = 'galaxy'
  actions.system = null
  cam.tx = 0
  cam.ty = 0
})
await page.waitForTimeout(1800)
await page.screenshot({ path: `${shots}/astral170-5-wide.png`, timeout: 60_000 })
console.log('shot 5: wide galaxy (tilt + sky + nebulae)')

// state dump for the console
const state = await page.evaluate(() => ({
  backend: document.querySelector('#backend')?.textContent ?? '',
  frames: window.__astral.frame,
  cam: { ...window.__astral.cam },
  log: (document.querySelector('#log-list')?.textContent ?? '').slice(-600),
}))
console.log('backend:', state.backend, 'frames:', state.frames)
console.log('cam:', JSON.stringify(state.cam))
console.log('log tail:', state.log.replace(/\n+/g, ' | ').slice(0, 500))
if (errors.length > 0) {
  console.log('PAGE ERRORS:')
  for (const e of errors) console.log('  ', e)
}

await browser.close()
server.stop()
process.exit(errors.length > 0 ? 1 : 0)
