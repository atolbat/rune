/** scripts/task124-probe.mjs — the rune-originals validation (Task 124):
 *  cycles to each of the 5 new demos, polls the live layer stats over a
 *  watch window (SwiftShader's slow frames dilate short VFX moments —
 *  the slash spans real seconds; sparse sampling falls between them),
 *  screenshots each, and checks demo-specific MECHANIC invariants:
 *
 *    rocket  — the smoke's mean velocity tracks the missile's flight
 *              (inheritance); debris live during flight (rate-over-distance)
 *    storm   — rain never sinks below the floor (kill); splash rings born
 *              (onCollide sub-emission)
 *    slash   — the ribbon + glints + impact fire over the cycle
 *    vortex  — the disc DRAINS: the OLDER half of the population sits
 *              closer to the core than the younger half (decaying orbits)
 *    fireflies — the swarm gathers: the mean distance to the lantern
 *              point stays inside the spawn shell
 *
 *  A screenshot's bright-fraction catches a black screen. WebGL2 only
 *  (SwiftShader; WebGPU is not alive headless — the live site is the
 *  oracle for that backend).
 */
import { join, resolve } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const root = resolve(import.meta.dirname, '..')
const out = resolve(root, '.shots')
mkdirSync(out, { recursive: true })
const port = 8129
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary', '.fbx': 'application/octet-stream', '.wasm': 'application/wasm',
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

const NEW_DEMOS = [
  { title: 'Rocket', watchMs: 4200, shotAt: 2000 },
  { title: 'Rainstorm', watchMs: 5000, shotAt: 3400 },
  { title: 'Sword Slash', watchMs: 14000, shotAt: 7000 },
  { title: 'Vortex', watchMs: 5500, shotAt: 3500 },
  { title: 'Fireflies', watchMs: 5500, shotAt: 3500 },
]

const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 160)) })
await page.goto(`http://localhost:${port}/demo/quarks/`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => /Muzzle Flash ×100 · [1-9][\d,]* particles/.test(document.querySelector('.pt-pill')?.textContent ?? ''), null, { timeout: 30000 })
await page.evaluate(() => document.querySelector('.pt-sheet [aria-label=Close]')?.click())

/** click the next arrow until the pill shows the target title. */
async function gotoDemo(page, title) {
  for (let guard = 0; guard < 24; guard++) {
    const pill = await page.textContent('.pt-pill').catch(() => '')
    if (pill.startsWith(title + ' ·')) return true
    await page.click('.pt-arrow:last-child')
    await page.waitForFunction(
      () => /^[\w ()&'-]+ · \d[\d,]* particles/.test(document.querySelector('.pt-pill')?.textContent ?? ''),
      null, { timeout: 30000 },
    ).catch(() => {})
  }
  return (await page.textContent('.pt-pill').catch(() => '')).startsWith(title + ' ·')
}

async function layerStats(page) {
  return page.evaluate(() => (window.__quarksLayers ?? []).map(l => {
    const f = l.facade?.fields
    const n = l.facade?.count ?? 0
    if (!f || n === 0) return { id: l.id, count: 0 }
    let vx = 0, vy = 0, vz = 0, minY = 1e9
    let radYoung = 0, nYoung = 0, radOld = 0, nOld = 0
    for (let i = 0; i < n; i++) {
      vx += f.vx[i]; vy += f.vy[i]; vz += f.vz[i]
      if (f.py[i] < minY) minY = f.py[i]
      const rad = Math.hypot(f.px[i], f.py[i] - 1.8, f.pz[i])
      if (f.age[i] < 1.6) { radYoung += rad; nYoung++ } else { radOld += rad; nOld++ }
    }
    return {
      id: l.id, count: n,
      meanV: [vx / n, vy / n, vz / n],
      minY,
      radYoung: nYoung > 0 ? radYoung / nYoung : null,
      radOld: nOld > 0 ? radOld / nOld : null,
    }
  }))
}

function brightFraction(path) {
  const png = PNG.sync.read(readFileSync(path))
  let bright = 0
  const n = png.width * png.height
  for (let p = 0; p < n; p++) {
    if ((png.data[p * 4] + png.data[p * 4 + 1] + png.data[p * 4 + 2]) / 3 > 26) bright++
  }
  return bright / n
}

let failures = 0
for (let d = 0; d < NEW_DEMOS.length; d++) {
  const { title, watchMs, shotAt } = NEW_DEMOS[d]
  console.log(`\n=== ${title} (demo #${15 + d}) ===`)
  const arrived = await gotoDemo(page, title)
  if (!arrived) {
    console.log(`  FAIL — never reached the demo (pill: ${await page.textContent('.pt-pill').catch(() => '?')})`)
    failures++
    continue
  }

  // poll the whole watch window; shoot on the ACTION (a live key layer),
  // falling back to the shotAt moment for always-live demos
  const ACTION_LAYERS = {
    Rocket: ['rk-strike-flash', 'rk-smoke'],
    Rainstorm: ['st-rain'],
    // impact-only: the shock+sparks moment is the most informative frame
    // (glints fire at the slash START — the ribbon has no history yet)
    'Sword Slash': ['sl-shock', 'sl-sparks'],
    Vortex: ['vx-disc'],
    Fireflies: ['ff-flies'],
  }
  const seen = []
  const start = Date.now()
  let shotPath = ''
  let shotTaken = false
  while (Date.now() - start < watchMs) {
    const s = await layerStats(page)
    seen.push(s)
    if (!shotTaken) {
      const action = (ACTION_LAYERS[title] ?? []).some(id => {
        const x = s.find(y => y.id === id)
        if (!x) return false
        if (id === 'rk-smoke') return x.count >= 50
        if (id === 'sl-glints') return x.count >= 30
        return x.count > 0
      })
      if (action || Date.now() - start >= shotAt) {
        shotPath = join(out, `task124-${title.toLowerCase().replace(/\s+/g, '-')}.png`)
        await page.screenshot({ path: shotPath })
        shotTaken = true
      }
    }
    await page.waitForTimeout(250)
  }
  if (!shotTaken) {
    shotPath = join(out, `task124-${title.toLowerCase().replace(/\s+/g, '-')}.png`)
    await page.screenshot({ path: shotPath })
  }
  const ids = (seen[0] ?? []).map(s => s.id)
  const peaks = ids.map(id => `${id}≤${Math.max(...seen.map(s => s.find(x => x.id === id)?.count ?? 0))}`)
    .filter(p => !p.endsWith('≤0')).join(' ')
  const nonEmpty = seen.filter(s => s.some(x => x.count > 0)).length
  console.log(`  polls with live particles: ${nonEmpty}/${seen.length}; peaks: ${peaks}`)
  const frac = shotPath !== '' ? brightFraction(shotPath) : 0
  console.log(`  screenshot bright: ${(frac * 100).toFixed(2)}%`)

  const find = (s, id) => s.find(x => x.id === id)
  const ever = (id, min = 1) => seen.some(s => (find(s, id)?.count ?? 0) >= min)
  let ok = true
  const why = []
  if (frac < 0.004) { ok = false; why.push('screen nearly black') }

  if (title === 'Rocket') {
    let smokeSpeed = 0
    for (const s of seen) {
      const smoke = find(s, 'rk-smoke')
      if (smoke?.meanV) smokeSpeed = Math.max(smokeSpeed, Math.hypot(smoke.meanV[0], smoke.meanV[1], smoke.meanV[2]))
    }
    if (!(smokeSpeed > 1.5)) { ok = false; why.push(`smoke peak mean speed ${smokeSpeed.toFixed(2)} (inheritance dead?)`) }
    if (!ever('rk-debris')) { ok = false; why.push('no debris during flight (rate-over-distance dead?)') }
    if (!ever('rk-strike-flash') || !ever('rk-strike-sparks')) { ok = false; why.push('the strike never fired') }
  }
  if (title === 'Rainstorm') {
    const minY = Math.min(...seen.map(s => find(s, 'st-rain')?.minY ?? 1e9))
    if (minY < -0.05) { ok = false; why.push(`rain sank to y=${minY.toFixed(2)} (kill dead?)`) }
    const ringPeak = Math.max(...seen.map(s => find(s, 'st-ring')?.count ?? 0))
    const dropPeak = Math.max(...seen.map(s => find(s, 'st-drop')?.count ?? 0))
    if (!(ringPeak > 30 && dropPeak > 20)) { ok = false; why.push(`splashes thin (ring ≤${ringPeak}, drops ≤${dropPeak} — onCollide dead?)`) }
  }
  if (title === 'Sword Slash') {
    if (!ever('sl-ribbon')) { ok = false; why.push('ribbon never live') }
    if (!ever('sl-glints', 10)) { ok = false; why.push('glints never live (rate-over-distance)') }
    if (!ever('sl-sparks', 10)) { ok = false; why.push('impact sparks never fired') }
    if (!ever('sl-shock')) { ok = false; why.push('shock ring never fired') }
  }
  if (title === 'Vortex') {
    // steady state: the population's TOTAL mean radius is constant (inflow
    // = death), but each particle DECAYS — the older half must sit closer
    // to the core than the younger half (the drain's signature)
    let drainOk = false
    for (const s of seen) {
      const disc = find(s, 'vx-disc')
      if (disc && disc.radYoung !== null && disc.radOld !== null && disc.radOld < disc.radYoung - 0.25) { drainOk = true; break }
    }
    if (!drainOk) { ok = false; why.push('no radial drain (older half not closer to the core)') }
    if (!ever('vx-disc', 200)) { ok = false; why.push('disc thin') }
  }
  if (title === 'Fireflies') {
    const meanDist = await page.evaluate(() => {
      const l = (window.__quarksLayers ?? []).find(x => x.id === 'ff-flies')
      if (!l || l.facade.count === 0) return -1
      const f = l.facade.fields
      const halo = (window.__quarksLayers ?? []).find(x => x.id === 'ff-halo')
      const hf = halo?.facade?.fields
      const hx = halo && halo.facade.count > 0 ? hf.px[0] : 0
      const hy = halo && halo.facade.count > 0 ? hf.py[0] : 1.35
      const hz = halo && halo.facade.count > 0 ? hf.pz[0] : 0
      let dd = 0
      for (let i = 0; i < l.facade.count; i++) dd += Math.hypot(f.px[i] - hx, f.py[i] - hy, f.pz[i] - hz)
      return dd / l.facade.count
    })
    if (!(meanDist > 0 && meanDist < 3.2)) { ok = false; why.push(`swarm mean distance to lantern ${meanDist.toFixed(2)} (seek dead?)`) }
  }

  console.log(`  ${ok ? 'PASS' : 'FAIL'}${why.length ? ' — ' + why.join('; ') : ''}`)
  if (!ok) failures++
}

if (errors.length > 0) {
  console.log('\nPAGE ERRORS:', errors.slice(0, 5))
  failures++
} else {
  console.log('\npage errors: none')
}
server.stop()
await browser.close()
process.exit(failures > 0 ? 1 : 0)
