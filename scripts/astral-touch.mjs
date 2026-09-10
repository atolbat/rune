/**
 * scripts/astral-touch.mjs — THE MOBILE INPUT GATE (Task 170).
 * The field report: "pinch zoom on the phone zooms the whole PAGE even on
 * the canvas". This gate drives REAL multi-touch through the CDP and proves
 * the game owns its gestures:
 *   A. the canvas carries touch-action:none (the browser must not race);
 *   B. a two-finger SPREAD pinches the GAME camera (cam.z rises) while the
 *      page's visual viewport scale stays 1.0 (the page never zooms);
 *   C. a two-finger TWIST rotates the camera (cam.yaw changes);
 *   D. a one-finger DRAG pans the camera (cam.x/y change);
 *   E. a tap still selects (the tap slop survives the gesture machinery);
 *   F. the mobile viewport (390×844) has no overflow and the top bar fits.
 * Usage: bun scripts/astral-touch.mjs
 */
import { chromium } from 'playwright'

const root = '/home/z/my-project/rune'
const port = 8185
const server = Bun.serve({
  port,
  async fetch(request) {
    let pathname = decodeURIComponent(new URL(request.url).pathname)
    if (pathname === '/') pathname = '/demo/astral/index.html'
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = Bun.file(`${root}${pathname}`)
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    const ext = pathname.slice(pathname.lastIndexOf('.'))
    const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg' }
    return new Response(await file.arrayBuffer(), { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
// a PHONE context: 390×844, DPR 3 — the field report's shape
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true })
const page = await context.newPage()
const errors = []
page.on('pageerror', e => errors.push(String(e).slice(0, 200)))
await page.goto(`http://localhost:${port}/demo/astral/?seed=1234`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForFunction(() => window.__astral !== undefined && window.__astral.frame > 5, null, { timeout: 40_000 })
await page.waitForTimeout(600)

const cdp = await context.newCDPSession(page)
const touch = async (type, points) => {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map(p => ({ x: p.x, y: p.y, id: p.id })),
  })
}
const camState = () => page.evaluate(() => {
  const c = window.__astral.cam
  const vv = window.visualViewport
  return { z: c.z, yaw: c.yaw, x: c.x, y: c.y, scale: vv ? vv.scale : 1 }
})

let failed = false
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed = true
}

// ── A. touch-action:none on the canvas ──
const ta = await page.evaluate(() => getComputedStyle(document.querySelector('#canvas')).touchAction)
check(ta === 'none', 'A: the canvas owns its gestures (touch-action)', `computed: "${ta}"`)

// ── B. the pinch: two fingers spread → the GAME zooms, the page does not ──
const before = await camState()
await touch('touchStart', [{ x: 175, y: 380, id: 1 }, { x: 215, y: 460, id: 2 }])
for (let k = 1; k <= 10; k++) {
  const spread = k * 6
  await touch('touchMove', [{ x: 195 - spread, y: 420 - spread / 2, id: 1 }, { x: 195 + spread, y: 420 + spread / 2, id: 2 }])
  await page.waitForTimeout(60)
}
await touch('touchEnd', [])
await page.waitForTimeout(400)
const after = await camState()
check(after.z > before.z * 1.15, 'B: the pinch zooms the GAME camera', `cam.z ${before.z.toFixed(2)} → ${after.z.toFixed(2)}`)
check(Math.abs(after.scale - 1) < 0.01, 'B: the PAGE stays unzoomed', `visualViewport.scale = ${after.scale}`)

// ── C. the twist: two fingers rotate → cam.yaw turns ──
// (the pair angle CONTINUES from its start orientation — a fresh angle
// would teleport the pair, not twist it)
const y0 = await camState()
const cx = 195, cy = 420, r = 55
const a0 = Math.atan2(460 - 380, 230 - 160)
await touch('touchStart', [
  { x: cx - Math.cos(a0) * r, y: cy - Math.sin(a0) * r, id: 1 },
  { x: cx + Math.cos(a0) * r, y: cy + Math.sin(a0) * r, id: 2 },
])
for (let k = 1; k <= 12; k++) {
  const a = a0 + k * 0.1
  await touch('touchMove', [
    { x: cx - Math.cos(a) * r, y: cy - Math.sin(a) * r, id: 1 },
    { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, id: 2 },
  ])
  await page.waitForTimeout(70)
}
await touch('touchEnd', [])
await page.waitForTimeout(400)
const y1 = await camState()
const yawDelta = Math.abs(y1.yaw - y0.yaw)
check(yawDelta > 0.25, 'C: the twist rotates the camera', `yaw ${y0.yaw.toFixed(2)} → ${y1.yaw.toFixed(2)} (Δ${yawDelta.toFixed(2)})`)

// ── D. the one-finger drag pans ──
const p0 = await camState()
await touch('touchStart', [{ x: 195, y: 400, id: 1 }])
for (let k = 1; k <= 8; k++) {
  await touch('touchMove', [{ x: 195 + k * 9, y: 400 + k * 7, id: 1 }])
  await page.waitForTimeout(50)
}
await touch('touchEnd', [])
await page.waitForTimeout(300)
const p1 = await camState()
check(Math.hypot(p1.x - p0.x, p1.y - p0.y) > 20, 'D: the drag pans the camera', `Δ(${(p1.x - p0.x).toFixed(1)}, ${(p1.y - p0.y).toFixed(1)})`)

// ── E. a tap still selects a system ──
const sel0 = await page.evaluate(() => window.__astral.view.selectedSystem)
const homeTap = await page.evaluate(() => {
  const home = window.__astral.world.systems.find(s => s.owner === 1)
  return window.__astral.project(home.x, home.y)
})
await touch('touchStart', [{ x: Math.round(homeTap.x), y: Math.round(homeTap.y), id: 1 }])
await page.waitForTimeout(40)
await touch('touchEnd', [])
await page.waitForTimeout(500)
const sel1 = await page.evaluate(() => ({ sel: window.__astral.view.selectedSystem, panel: document.querySelector('.as-panel')?.classList.contains('as-open') ?? false }))
check(sel1.panel, 'E: a tap selects (the panel opens)', `selectedSystem ${sel0} → ${sel1.sel}`)

// ── F. the mobile layout: no overflow, the top bar fits ──
const mob = await page.evaluate(() => {
  const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth
  const top = document.querySelector('.as-top')?.getBoundingClientRect()
  const canvas = document.querySelector('#canvas')?.getBoundingClientRect()
  return { overflow, topW: Math.round(top?.width ?? 0), topH: Math.round(top?.height ?? 0), canvasW: Math.round(canvas?.width ?? 0) }
})
check(mob.overflow <= 1 && mob.canvasW >= 380 && mob.topW <= 390, 'F: the mobile layout holds', JSON.stringify(mob))

check(errors.length === 0, 'zero page errors', errors.length ? errors[0] : 'clean')
console.log(failed ? 'ASTRAL TOUCH GATE: FAIL' : 'ASTRAL TOUCH GATE: PASS')
await browser.close()
server.stop()
process.exit(failed ? 1 : 0)
