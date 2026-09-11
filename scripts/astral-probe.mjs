/**
 * scripts/astral-probe.mjs — the astral demo gate (run via bun).
 *
 * The full gameplay loop, headless (SwiftShader ANGLE — WebGPU on):
 *
 *   A. boot: the badge filled, the seeded world is sane (72 systems, a
 *      connected lane graph, 3 starting ships, 1 player + 2 rival systems);
 *   B. liveness: __astral.frame advances; idle ships visibly keep station
 *      (their positions move frame to frame);
 *   C. the galaxy view: the travel lanes render — a pixel walk along an
 *      on-screen lane must find lit samples (the alpha-0.3 bake);
 *   D. tap the homeworld → the system panel (planets + ship buttons);
 *   E. tap it again → the system view (mode flips, planets live);
 *   F. tap a planet → the planet panel with build buttons;
 *   G. build a Deep Mine → the queue opens, the minerals drop;
 *   H. speed 4× → the building completes (planet.buildings gains 'mine');
 *   I. exit to the galaxy;
 *   J. tap an unowned system → send the nearest colony ship → the ship
 *      enters the move state with a multi-hop path; a zoomed clip of the
 *      ship mid-flight (engine plume) is shot for the VLM pass;
 *   K. the WebGL2 leg: toggle the backend, re-boot, the lane check + a tap.
 *
 * Exit 0 — the demo plays; 1 — it does not.
 */
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const root = resolve(import.meta.dirname, '..')
const port = 8177

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
    const MIME = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.jpg': 'image/jpeg',
      '.woff2': 'font/woff2',
    }
    return new Response(file, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

const errors = []
const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox',
    '--no-sandbox',
  ],
})

const shots = '/home/z/my-project/quarks-shots'
let failed = false
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed = true
}

/** world→screen through the LIVE camera (read at evaluate time).
 * Task 170: the camera is a tilted perspective now — the gates project
 * through the demo's own __astral.project (ray-cast through the MVP),
 * never a re-derived ortho formula. */
function screenOf(page, wx, wy) {
  return page.evaluate(([x, y]) => {
    const pt = window.__astral.project(x, y)
    return { x: pt.x, y: pt.y }
  }, [wx, wy])
}

/** Sample the PNG at (x, y) — returns [r,g,b] (pngjs reads RGBA). */
function pixelOf(png, x, y) {
  const i = (png.width * Math.round(y) + Math.round(x)) * 4
  return [png.data[i], png.data[i + 1], png.data[i + 2]]
}

async function runFlow(page, label) {
  // ── A. the world is sane ──
  const world0 = await page.evaluate(() => {
    const w = window.__astral.world
    return {
      systems: w.systems.length,
      lanes: w.lanes.length,
      ships: w.ships.length,
      player: w.systems.filter(s => s.owner === 1).length,
      rival: w.systems.filter(s => s.owner === 2).length,
      colonizable: w.colonizableCount,
    }
  })
  check(world0.systems === 72, `${label}: 72 systems`, JSON.stringify(world0))
  check(world0.lanes >= 72, `${label}: connected lanes`, `${world0.lanes} lanes`)
  check(world0.ships === 3 && world0.player === 1 && world0.rival === 2, `${label}: the starting setup`, JSON.stringify(world0))

  // ── B. liveness + idle ships keep station ──
  const ships0 = await page.evaluate(() => window.__astral.world.ships.map(s => [s.x, s.y]))
  const frame0 = await page.evaluate(() => window.__astral.frame)
  await page.waitForTimeout(900)
  const live = await page.evaluate(([f0, s0]) => {
    const w = window.__astral.world
    const moved = s0.filter((p, i) => {
      const s = w.ships[i]
      return s === undefined ? false : Math.hypot(s.x - p[0], s.y - p[1]) > 0.02
    }).length
    return { frames: window.__astral.frame - f0, moved }
  }, [frame0, ships0])
  check(live.frames >= 4, `${label}: the frame loop runs`, `${live.frames} frames in ~0.9s (SwiftShader ≈ 10fps)`)
  check(live.moved === 3, `${label}: idle ships patrol (orbit)`, `${live.moved}/3 moved`)

  return world0
}

async function laneCheck(page, label) {
  // ── C. the lanes render: walk an on-screen lane, count lit samples ──
  // (a minimum SCREEN length — a 2px hop between neighbors is entirely
  // inside the stars' glow and proves nothing). Task 171: the lanes are
  // BÉZIERS now — the probe replays the bake's OWN seeded sag (mulberry
  // 0x1ace ^ seed, two draws per lane in world.lanes order) and samples
  // ON THE CURVE, never the straight chord; the pixels must read TEAL
  // (g and b over r — the lane tint) over the local background
  const lane = await page.evaluate(() => {
    const { world } = window.__astral
    const seed = world.seed
    let a = (seed ^ 0x1ace) >>> 0
    const rng = () => {
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const w = window.innerWidth, h = window.innerHeight
    const P = window.__astral.project
    let best = null
    for (const L of world.lanes) {
      const A = world.systems[L.a], B = world.systems[L.b]
      const pa = P(A.x, A.y), pb = P(B.x, B.y)
      const ax = pa.x, ay = pa.y, bx = pb.x, by = pb.y
      const sag = (0.06 + rng() * 0.06) * (rng() < 0.5 ? -1 : 1)
      const len = Math.hypot(bx - ax, by - ay)
      const mid = { x: (ax + bx) / 2 + (by - ay) / len * sag * len, y: (ay + by) / 2 - (bx - ax) / len * sag * len }
      if (len < 90) continue
      if (ax > 30 && ax < w - 30 && bx > 30 && bx < w - 30 && ay > 130 && by > 130 && ay < h - 160 && by < h - 160
        && mid.x > 20 && mid.x < w - 20 && mid.y > 130 && mid.y < h - 160) { best = { ax, ay, bx, by, mx: mid.x, my: mid.y }; break }
    }
    return best
  })
  check(lane !== null, `${label}: a long on-screen lane found`)
  if (lane === null) return

  const shot = await page.screenshot({ timeout: 60_000 })
  const png = PNG.sync.read(shot)
  let lit = 0
  const samples = []
  const bez = (t) => {
    const u = 1 - t
    const x = u * u * lane.ax + 2 * u * t * lane.mx + t * t * lane.bx
    const y = u * u * lane.ay + 2 * u * t * lane.my + t * t * lane.by
    return [x, y]
  }
  for (const t of [0.2, 0.35, 0.5, 0.65, 0.8]) {
    const [x, y] = bez(t)
    // a 5×5 neighborhood max — the 1.15px thread can sit between pixels,
    // and the tilt's foreshortening bends the replayed control point a
    // couple of pixels off the true screen-space curve
    let bestPx = [0, 0, 0]
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const px = pixelOf(png, x + dx, y + dy)
        if (px[1] + px[2] > bestPx[1] + bestPx[2]) bestPx = px
      }
    }
    const [r, g, b] = bestPx
    samples.push(`(${r},${g},${b})`)
    // the lane read: TEAL — green AND blue channels over red by a margin,
    // with a floor that survives the subtle Task-171 recalibration
    if (g > r + 3 && b > r + 3 && (g + b) > 44) lit++
  }
  check(lit >= 3, `${label}: the lane pixels light up`, `lit ${lit}/5: ${samples.join(' ')}`)
}

try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  page.on('pageerror', e => errors.push(String(e)))
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })

  await page.goto(`http://localhost:${port}/demo/astral/?seed=1234`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)

  const badge = await page.textContent('#backend')
  check(badge !== '…' && badge.trim() !== '', 'badge filled', badge.trim())
  await runFlow(page, 'A/B')

  await page.screenshot({ path: `${shots}/astral-1-galaxy.png`, timeout: 60_000 })
  await laneCheck(page, 'C')

  // ── D. tap the homeworld (its live screen position) → the system panel ──
  const homeTap = await page.evaluate(() => {
    const home = window.__astral.world.systems.find(s => s.owner === 1)
    return window.__astral.project(home.x, home.y)
  })
  await page.mouse.click(Math.round(homeTap.x), Math.round(homeTap.y))
  await page.waitForTimeout(500)
  const d = await page.evaluate(() => {
    const panel = document.querySelector('.as-panel')
    return {
      open: panel?.classList.contains('as-open') ?? false,
      title: document.querySelector('.as-panel-title')?.textContent ?? '',
      planetRows: panel?.querySelectorAll('.as-planet-row').length ?? 0,
      shipBtns: [...(panel?.querySelectorAll('.as-btn') ?? [])].map(b => b.textContent),
    }
  })
  check(d.open && d.planetRows > 0 && d.shipBtns.length === 2, 'D: tap → the system panel', `${d.title}: ${d.planetRows} planets, ${d.shipBtns.length} ship buttons`)

  // ── E. tap again → the system view ──
  await page.mouse.click(Math.round(homeTap.x), Math.round(homeTap.y))
  await page.waitForTimeout(1400) // the camera eases in
  const e = await page.evaluate(() => {
    const v = window.__astral.view
    return { mode: v.mode, planets: v.system?.planets.length ?? 0, back: !document.querySelector('.as-back').hidden }
  })
  check(e.mode === 'system' && e.planets > 0 && e.back, 'E: enter the system view', `mode=${e.mode}, ${e.planets} planets`)
  await page.screenshot({ path: `${shots}/astral-3-system.png`, timeout: 60_000 })

  // ── F. tap the first planet → the build panel ──
  const planetTap = await page.evaluate(() => {
    const { view, clock } = window.__astral
    const sys = view.system
    const p = sys.planets[0]
    const ang = p.phase + clock * p.speed
    const wx = sys.x + Math.cos(ang) * p.orbit
    const wy = sys.y + Math.sin(ang) * p.orbit
    return window.__astral.project(wx, wy)
  })
  await page.mouse.click(Math.round(planetTap.x), Math.round(planetTap.y))
  await page.waitForTimeout(500)
  const f = await page.evaluate(() => {
    const v = window.__astral.view
    const btns = [...document.querySelectorAll('.as-panel .as-btn')].map(b => b.textContent)
    return { sel: v.selectedPlanet, btns }
  })
  check(f.sel === 0 && f.btns.length === 3, 'F: tap → the planet panel', `sel=${f.sel}, ${f.btns.length} build buttons: ${f.btns.map(b => b.split('·')[0].trim()).join(' / ')}`)

  // ── G. build a Deep Mine (a direct DOM click — the panel refreshes every
  // 0.2s and rebuilds the buttons, which starves Playwright's stability wait) ──
  const minerals0 = await page.evaluate(() => window.__astral.world.econ.minerals)
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.as-panel .as-btn')].find(b => b.textContent.includes('Deep Mine'))
    btn?.click()
  })
  await page.waitForTimeout(400)
  const g = await page.evaluate(() => {
    const v = window.__astral.view
    const p = v.system.planets[v.selectedPlanet]
    return { queued: p.queue?.building ?? null, minerals: window.__astral.world.econ.minerals }
  })
  check(g.queued === 'mine' && g.minerals <= minerals0 - 60, 'G: the build queue opens', `queued=${g.queued}, minerals ${minerals0.toFixed(0)}→${g.minerals.toFixed(0)}`)

  // ── H. speed 4× → the building completes (POLL: the beauty pass slowed
  // SwiftShader's fps, and the game clock accumulates wall time per frame —
  // a fixed 2.6s wait starved the build; the OUTCOME is the gate, not the
  // timing; a real phone runs 60fps and finishes in a blink) ──
  await page.locator('.as-speed button[data-speed="4"]').click()
  let h = null
  for (let i = 0; i < 24; i++) {
    h = await page.evaluate(() => {
      const v = window.__astral.view
      const p = v.system.planets[v.selectedPlanet]
      return { buildings: p.buildings, queue: p.queue }
    })
    if (h.buildings.includes('mine') && h.queue === null) break
    await page.waitForTimeout(500)
  }
  check(h !== null && h.buildings.includes('mine') && h.queue === null, 'H: the building completes', `buildings=[${h?.buildings}]`)

  // ── I. exit to the galaxy ──
  await page.locator('.as-back').click()
  await page.waitForTimeout(600)
  const i = await page.evaluate(() => window.__astral.view.mode)
  check(i === 'galaxy', 'I: back to the galaxy')

  // ── J. send a colony ship to an unowned system ──
  // (settle the camera first: at SwiftShader's ~5fps the exit ease is
  // still mid-flight after 600ms — a projection taken now drifts)
  for (let i = 0; i < 30; i++) {
    const settled = await page.evaluate(() => {
      const c = window.__astral.cam
      return Math.abs(c.x - c.tx) + Math.abs(c.y - c.ty) + Math.abs(c.z - c.tz) < 0.02
    })
    if (settled) break
    await page.waitForTimeout(300)
  }
  const target = await page.evaluate(() => {
    const { world, cam } = window.__astral
    const home = world.systems.find(s => s.owner === 1)
    let best = null, bestD = Infinity
    for (const s of world.systems) {
      if (s.owner !== 0 || s.planets.length === 0) continue
      const d = Math.hypot(s.x - home.x, s.y - home.y)
      if (d < bestD) { bestD = d; best = s }
    }
    const pt = window.__astral.project(best.x, best.y)
    return { id: best.id, name: best.name, x: pt.x, y: pt.y }
  })
  await page.mouse.click(Math.round(target.x), Math.round(target.y))
  await page.waitForTimeout(500)
  const sendBtnFound = await page.evaluate(() =>
    [...document.querySelectorAll('.as-panel .as-btn')].some(b => b.textContent.includes('Send nearest colony ship')))
  check(sendBtnFound, 'J: the send-colony button appears', `target ${target.name}`)
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.as-panel .as-btn')].find(b => b.textContent.includes('Send nearest colony ship'))
    btn?.click()
  })
  await page.waitForTimeout(600)
  const j = await page.evaluate(() => {
    const w = window.__astral.world
    const ship = w.ships.find(s => s.state === 'move')
    return ship === undefined ? null : { id: ship.id, kind: ship.kind, hops: ship.path.length - 1, at: ship.at }
  })
  check(j !== null && j.kind === 'colony' && j.hops >= 1, 'J: the colony ship flies', j === null ? 'no moving ship' : `${j.hops} hops from system ${j.at}`)

  // a zoomed clip of the ship mid-flight (the engine plume shot)
  await page.locator('.as-speed button[data-speed="2"]').click()
  await page.waitForTimeout(1200)
  const shipPos = await page.evaluate(() => {
    const s = window.__astral.world.ships.find(sh => sh.state === 'move')
    if (s === undefined) return null
    return window.__astral.project(s.x, s.y)
  })
  if (shipPos !== null) {
    const clip = {
      x: Math.max(0, shipPos.x - 130), y: Math.max(0, shipPos.y - 130),
      width: 260, height: 260,
    }
    // keep the clip inside the page
    clip.width = Math.min(clip.width, 390 - clip.x)
    clip.height = Math.min(clip.height, 844 - clip.y)
    if (clip.width > 60 && clip.height > 60) {
      await page.screenshot({ path: `${shots}/astral-4-flight.png`, clip, timeout: 60_000 })
      console.log('INFO  the mid-flight clip shot')
    }
  }
  await page.screenshot({ path: `${shots}/astral-2-tapped.png`, timeout: 60_000 })

  // ── K. the WebGL2 leg: open the fullscreen sheet (the toggle hides behind
  // the FAB), toggle, re-boot, lanes + a tap ──
  await page.click('#rd-fab')
  await page.waitForTimeout(300)
  await page.click('label[for="mode-webgl2"]')
  await page.waitForTimeout(1800)
  const badge2 = await page.textContent('#backend')
  check(badge2 === 'WebGL2', 'K: toggle → WebGL2', badge2)
  await laneCheck(page, 'K')
  const homeTap2 = await page.evaluate(() => {
    const home = window.__astral.world.systems.find(s => s.owner === 1)
    return window.__astral.project(home.x, home.y)
  })
  await page.mouse.click(Math.round(homeTap2.x), Math.round(homeTap2.y))
  await page.waitForTimeout(500)
  const k = await page.evaluate(() => document.querySelector('.as-panel')?.classList.contains('as-open') ?? false)
  check(k, 'K: WebGL2 tap → the panel opens')

  check(errors.length === 0, 'zero page errors', errors.length ? errors.slice(0, 4).join(' | ') : 'clean')
  await page.close()
} catch (err) {
  console.log(`FAIL  probe crashed: ${err.message}`)
  failed = true
}

await browser.close()
server.stop(true)
process.exit(failed ? 1 : 0)
