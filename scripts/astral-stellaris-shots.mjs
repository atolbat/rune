// verify the rival territory blob renders: camera over the Hegemony home
import { chromium } from 'playwright'

const root = '/home/z/my-project/rune'
const port = 8181

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
      '.woff2': 'font/woff2',
    }
    return new Response(await file.arrayBuffer(), { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--no-sandbox'],
})
const page = await (await browser.newContext({ viewport: { width: 960, height: 720 } })).newPage()
page.on('pageerror', e => console.log('PAGEERROR:', String(e).slice(0, 300)))
page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE:', m.text().slice(0, 300)) })
await page.goto(`http://localhost:${port}/demo/astral/?seed=1234`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForFunction(() => window.__astral !== undefined && window.__astral.frame > 8, null, { timeout: 30_000 })
await page.waitForTimeout(1200)

const info = await page.evaluate(() => {
  const w = window.__astral.world
  const rival = w.systems.filter(s => s.owner === 2)
  const player = w.systems.filter(s => s.owner === 1)
  return {
    rival: rival.map(s => ({ id: s.id, name: s.name, x: Math.round(s.x), y: Math.round(s.y), cls: s.cls.key })),
    player: player.map(s => ({ id: s.id, name: s.name, x: Math.round(s.x), y: Math.round(s.y) })),
    bh: w.systems.filter(s => s.cls.key === 'BH').map(s => ({ id: s.id, name: s.name, x: Math.round(s.x), y: Math.round(s.y) })),
    neutron: w.systems.filter(s => s.cls.key === 'N').map(s => ({ id: s.id, name: s.name, x: Math.round(s.x), y: Math.round(s.y) })),
  }
})
console.log('WORLD:', JSON.stringify(info, null, 1))

// camera over the Hegemony home, zoomed out enough to see the blob
await page.evaluate(() => {
  const a = window.__astral
  a.cam.x = a.cam.tx = info_rival_x()
  a.cam.y = a.cam.ty = info_rival_y()
  a.cam.z = a.cam.tz = 0.45
  function info_rival_x() { return a.world.systems.find(s => s.owner === 2).x }
  function info_rival_y() { return a.world.systems.find(s => s.owner === 2).y }
})
await page.waitForTimeout(1400)
await page.screenshot({ path: '/home/z/my-project/quarks-shots/stellaris-rival.png', timeout: 30_000 })
console.log('shot: rival home')

// camera over a black hole
if (info.bh.length > 0) {
  await page.evaluate(({ x, y }) => {
    const a = window.__astral
    a.cam.x = a.cam.tx = x; a.cam.y = a.cam.ty = y; a.cam.z = a.cam.tz = 1.1
  }, { x: info.bh[0].x, y: info.bh[0].y })
  await page.waitForTimeout(1400)
  await page.screenshot({ path: '/home/z/my-project/quarks-shots/stellaris-bh.png', timeout: 30_000 })
  console.log('shot: black hole', info.bh[0].name)
}

// camera over a neutron star
if (info.neutron.length > 0) {
  await page.evaluate(({ x, y }) => {
    const a = window.__astral
    a.cam.x = a.cam.tx = x; a.cam.y = a.cam.ty = y; a.cam.z = a.cam.tz = 0.9
  }, { x: info.neutron[0].x, y: info.neutron[0].y })
  await page.waitForTimeout(1400)
  await page.screenshot({ path: '/home/z/my-project/quarks-shots/stellaris-neutron.png', timeout: 30_000 })
  console.log('shot: neutron star', info.neutron[0].name)
}

await browser.close()
server.stop()
