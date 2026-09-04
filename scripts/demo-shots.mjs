/**
 * scripts/demo-shots.mjs — visual check of the demos (not CI): screenshots
 * of desktop and phone, the model sheet in its states, the fullscreen viewer.
 */
import { join, resolve } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const out = resolve(root, '.shots')
const port = 8124

mkdirSync(out, { recursive: true })

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.fbx': 'application/octet-stream',
  '.wasm': 'application/wasm',
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

const gallery = await browser.newPage({ viewport: { width: 960, height: 720 } })
await gallery.goto(`http://localhost:${port}/demo/`, { waitUntil: 'networkidle' })
await gallery.screenshot({ path: join(out, 'desktop-gallery.png') })

const page = await browser.newPage({ viewport: { width: 960, height: 860 } })
await page.goto(`http://localhost:${port}/demo/hello-cube/`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => document.querySelector('#backend')?.textContent !== '…', null, { timeout: 15000 })
await page.waitForTimeout(900)
await page.screenshot({ path: join(out, 'desktop-cube.png'), fullPage: true })

// WebGPU refusal in the log + how it looks in the panel
await page.click('label[for="mode-webgpu"]')
await page.waitForTimeout(800)
await page.screenshot({ path: join(out, 'desktop-webgpu-refused.png'), fullPage: true })

// phone
const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
await phone.goto(`http://localhost:${port}/demo/hello-cube/`, { waitUntil: 'networkidle' })
await phone.waitForFunction(() => document.querySelector('#backend')?.textContent !== '…', null, { timeout: 15000 })
await phone.waitForTimeout(900)
await phone.screenshot({ path: join(out, 'mobile-cube.png'), fullPage: true })

// ─── model-viewer ───────────────────────────────────────────────────────────

const viewer = await browser.newPage({ viewport: { width: 960, height: 720 } })
await viewer.goto(`http://localhost:${port}/demo/model-viewer/`, { waitUntil: 'networkidle' })
await viewer.waitForFunction(() => document.querySelector('#backend')?.textContent !== '…', null, { timeout: 15000 })

// initial state: the sheet with the Load button is the entry point
await viewer.screenshot({ path: join(out, 'desktop-mv-initial.png') })

// load → progress → the scene takes over (the UI hides itself)
await viewer.click('.mv-load')
await viewer.waitForFunction(
  () => (document.querySelector('.mv-stats')?.textContent ?? '').includes('verts'),
  null,
  { timeout: 90_000 },
)
await viewer.waitForTimeout(1200)
await viewer.screenshot({ path: join(out, 'desktop-mv-scene.png') })

// the pill reopens the sheet (compact model switcher)
await viewer.click('.mv-pill')
await viewer.waitForTimeout(400)
await viewer.screenshot({ path: join(out, 'desktop-mv-sheet.png') })

// the shell menu (FAB): backend toggle + log
await viewer.click('#rd-fab')
await viewer.waitForTimeout(400)
await viewer.screenshot({ path: join(out, 'desktop-mv-fab-sheet.png') })

// Samba: the skinned path — load, let the clip advance, capture a dance frame
// (the model sheet from the step above is still open — select the row directly)
await viewer.click('#rd-fab') // close the shell sheet
await viewer.evaluate(() => {
  const rows = [...document.querySelectorAll('.mv-row')]
  rows.find(r => r.textContent.includes('Samba'))?.dispatchEvent(new Event('click', { bubbles: true }))
})
await viewer.waitForTimeout(300)
await viewer.click('.mv-load')
await viewer.waitForFunction(
  () => (document.querySelector('.mv-stats')?.textContent ?? '').includes('joints'),
  null,
  { timeout: 90_000 },
)
await viewer.waitForTimeout(2500) // a few seconds into the dance
await viewer.screenshot({ path: join(out, 'desktop-mv-samba.png') })

// Nefertiti: the object-space normal-map path
await viewer.click('.mv-pill')
await viewer.evaluate(() => {
  const rows = [...document.querySelectorAll('.mv-row')]
  rows.find(r => r.textContent.includes('Nefertiti'))?.dispatchEvent(new Event('click', { bubbles: true }))
})
await viewer.click('.mv-load')
await viewer.waitForFunction(
  () => (document.querySelector('.mv-stats')?.textContent ?? '').includes('verts') &&
    !((document.querySelector('.mv-stats')?.textContent ?? '').includes('joints')),
  null,
  { timeout: 90_000 },
)
await viewer.waitForTimeout(1500)
await viewer.screenshot({ path: join(out, 'desktop-mv-nefertiti.png') })

// Matcap Cube: the procedural MATCAP feature (no download)
await viewer.click('.mv-pill')
await viewer.evaluate(() => {
  const rows = [...document.querySelectorAll('.mv-row')]
  rows.find(r => r.textContent.includes('Matcap'))?.dispatchEvent(new Event('click', { bubbles: true }))
})
await viewer.click('.mv-load')
await viewer.waitForFunction(
  () => (document.querySelector('.mv-stats')?.textContent ?? '').includes('36 verts'),
  null,
  { timeout: 30_000 },
)
await viewer.waitForTimeout(1200)
await viewer.screenshot({ path: join(out, 'desktop-mv-matcap.png') })

// phone: initial sheet, then the fullscreen scene with the pill
const viewerPhone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
await viewerPhone.goto(`http://localhost:${port}/demo/model-viewer/`, { waitUntil: 'networkidle' })
await viewerPhone.waitForFunction(() => document.querySelector('#backend')?.textContent !== '…', null, { timeout: 15000 })
await viewerPhone.screenshot({ path: join(out, 'mobile-mv-initial.png') })

await viewerPhone.click('.mv-load')
await viewerPhone.waitForFunction(
  () => (document.querySelector('.mv-stats')?.textContent ?? '').includes('verts'),
  null,
  { timeout: 90_000 },
)
await viewerPhone.waitForTimeout(1200)
await viewerPhone.screenshot({ path: join(out, 'mobile-mv-scene.png') })

// the model sheet on the phone
await viewerPhone.click('.mv-pill')
await viewerPhone.waitForTimeout(400)
await viewerPhone.screenshot({ path: join(out, 'mobile-mv-sheet.png') })

// ─── particles: the eight presets (desktop) + the phone sheet ──────────
const pt = await browser.newPage({ viewport: { width: 960, height: 720 } })
pt.on('pageerror', e => console.log('PT PAGEERROR:', e.message))
pt.on('console', m => { if (m.type() === 'error') console.log('PT CONSOLE:', m.text()) })
await pt.goto(`http://localhost:${port}/demo/particles/`, { waitUntil: 'networkidle' })
await pt.waitForFunction(() => document.querySelector('#backend')?.textContent !== '…', null, { timeout: 15000 })
await pt.waitForFunction(
  () => /\/ 8,192 · [1-9][\d,]* verts/.test(document.querySelector('.pt-pill')?.textContent ?? ''),
  null,
  { timeout: 30_000 },
)
await pt.waitForTimeout(1500)
// the boot opens the preset sheet over the lower-left — close it for a clean
// full-canvas shot (the pill stays for context)
await pt.click('.pt-close').catch(() => {})
await pt.waitForTimeout(300)
await pt.screenshot({ path: join(out, 'desktop-particles-fountain.png') })

// Task 121 — THE VERIFICATION HOLE: this sweep must run FORCED on WebGL2.
// The reported regression ("particles render without transparency on
// WebGL") is backend-specific; an AUTO sweep silently picks whatever this
// machine can create (WebGPU on dev machines) and never exercises the
// broken path. The toggle reboots the demo on the WebGL2 backend; the
// remaining preset loop below then runs on it.
await pt.click('#rd-fab')
await pt.click('label[for="mode-webgl2"]')
await pt.mouse.click(480, 100) // close the FAB sheet (an outside click)
await pt.waitForFunction(() => document.querySelector('#backend')?.textContent === 'WebGL2', null, { timeout: 30000 })
await pt.waitForFunction(
  () => /\/ 8,192 · [1-9][\d,]* verts/.test(document.querySelector('.pt-pill')?.textContent ?? ''),
  null, { timeout: 30_000 },
)
await pt.waitForTimeout(1500)
await pt.screenshot({ path: join(out, 'desktop-particles-fountain-gl2.png') })

// The self-test verdict (Task 121) is itself a GATE: the demo probes the
// live GL blend state and roundtrips the sprite texture through a surface —
// both must read healthy on the WebGL2 path, or the sweep fails loudly.
await pt.waitForFunction(() => window.__runeSelfTest !== undefined, null, { timeout: 45000 })
const selfTest = await pt.evaluate(() => window.__runeSelfTest)
if (selfTest === undefined || !selfTest.stateOk || !selfTest.textureOk) {
  throw new Error(`[shots] the particles blend self-test FAILED on WebGL2: ${JSON.stringify(selfTest)}`)
}
console.log(`[shots] blend self-test (WebGL2): PASS — state ${JSON.stringify(selfTest.state)}, sprite alpha center/quarter/corner ${selfTest.texture.center[3]}/${selfTest.texture.quarter[3]}/${selfTest.texture.corner[3]}`)

// Per-preset settle times: burst/ramp presets need several shells or a full
// fill before their look reads (the galaxy steady state is rate·life ≈ 7k
// particles — 3 s shows a young sparse disc).
const SETTLE = { Fireworks: 5000, Galaxy: 10000, Embers: 4000, Drift: 5000, Snow: 5000, Orbit: 7000, Meteor: 6000 }
for (const name of ['Fireworks', 'Galaxy', 'Embers', 'Drift', 'Snow', 'Orbit', 'Meteor']) {
  console.log(`[shots] preset → ${name}`)
  await pt.evaluate((n) => {
    const rows = [...document.querySelectorAll('.pt-row')]
    rows.find(r => r.textContent.includes(n))?.dispatchEvent(new Event('click', { bubbles: true }))
  }, name)
  await pt.waitForFunction(
    (n) => (document.querySelector('.pt-pill')?.textContent ?? '').includes(n),
    name,
    { timeout: 10_000 },
  )
  await pt.waitForFunction(
    (n) => new RegExp(`${n} · [1-9][\\d,]* /`).test(document.querySelector('.pt-pill')?.textContent ?? ''),
    name,
    { timeout: 25_000 },
  )
  await pt.waitForTimeout(SETTLE[name] ?? 3000)
  const shotPath = join(out, `desktop-particles-${name.toLowerCase().replace(' ', '-')}.png`)
  await pt.screenshot({ path: shotPath })
  // the pixel gates on the transparency-critical presets (see assertNoBlackRims)
  if (name === 'Embers' || name === 'Snow' || name === 'Drift') await assertNoBlackRims(pt, shotPath, name)
}

// THE PIXEL GATES (Tasks 118+120): the background is the configured clear
// color [4,5,9]; a broken sprite alpha draws OPAQUE quads — their rims are
// EXACTLY [0,0,0] (the straight-alpha rim rgb is 0 where a≈0). PNG
// screenshots are lossless: any pure-[0,0,0] pixel = the alpha died.
// Gate 2 (Task 120, the perceptual one): additive blending can ONLY
// brighten — a pixel DARKER than [4,5,9] on ALL channels is a dark rim /
// muddy quad (the user's “black where it should be transparent”); a small
// tolerance covers the UI text over the canvas. Both gates run on the
// embers/drift/snow shots (the additive glow presets + the alpha showcase).
async function assertNoBlackRims(page, shotPath, preset) {
  const { readFile } = await import('node:fs/promises')
  const { PNG } = await import('pngjs')
  const png = PNG.sync.read(await readFile(shotPath))
  const { width: W, height: H, data } = png
  let pure = 0
  let darker = 0
  const BG = [4, 5, 9] // the configured clear color
  for (let i = 0; i < W * H * 4; i += 4) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0) pure++
    if (data[i] < BG[0] && data[i + 1] < BG[1] && data[i + 2] < BG[2]) darker++
  }
  const total = W * H
  console.log(`[shots] pixel gate (${preset}): pure-[0,0,0] = ${pure} (${(100 * pure / total).toFixed(3)}%), darker-than-bg = ${darker} (${(100 * darker / total).toFixed(3)}%)`)
  if (pure > 0) {
    throw new Error(`[shots] ${preset}: ${pure} pure-black pixels — the sprite alpha broke (opaque quad rims)`)
  }
  // the perceptual gate: 0.1% tolerance covers the UI text over the canvas
  if (darker / total > 0.001) {
    throw new Error(`[shots] ${preset}: ${darker} pixels darker than the clear color — dark rims / muddy quads (the transparency regression)`)
  }
}

// THE SPRITE CONTOUR GATE (Task 120): /demo/particles/sprite-probe.html
// renders ONE static sprite through the same bundles+material+pipeline at a
// calibrated size. The iso-brightness footprint of a healthy sprite is a
// CIRCLE: fill ≈ π/4 ≈ 78.5% of its bounding box, aspect ≈ 1.0, and the span
// SHRINKS as the threshold rises. A quad rim / opaque square / corner
// artifact breaks at least one of those. Runs on both blend modes.
async function assertSpriteContour() {
  const { readFile } = await import('node:fs/promises')
  const { PNG } = await import('pngjs')
  for (const mode of ['alpha', 'additive']) {
    const page = await browser.newPage({ viewport: { width: 480, height: 480 } })
    page.on('pageerror', (e) => console.log('PROBE PAGEERROR:', e.message))
    await page.goto(`http://localhost:${port}/demo/particles/sprite-probe.html?mode=${mode}&backend=webgl2`, { waitUntil: 'networkidle' })
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 })
    await page.waitForTimeout(500) // a drawn frame (the texture streams in on GL)
    const shotPath = join(out, `sprite-probe-${mode}.png`)
    await page.screenshot({ path: shotPath })
    await page.close()

    const png = PNG.sync.read(await readFile(shotPath))
    const { width: W, height: H, data } = png
    const bgLum = 0.3 * 4 + 0.6 * 5 + 0.1 * 9 // the clear color luminance ≈ 6.5
    const bright = (x, y) => { const i = (y * W + x) * 4; return 0.3 * data[i] + 0.6 * data[i + 1] + 0.1 * data[i + 2] }
    let prevSpan = Infinity
    for (const TH of [bgLum + 8, bgLum + 40, bgLum + 120]) {
      let minX = W, maxX = -1, minY = H, maxY = -1, count = 0
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (bright(x, y) > TH) {
            count++
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
          }
        }
      }
      if (count === 0) throw new Error(`[shots] sprite probe (${mode}): nothing visible at threshold +${TH - bgLum} — the sprite never rendered`)
      const rowSpan = maxY - minY + 1
      const colSpan = maxX - minX + 1
      const aspect = colSpan / rowSpan
      const fill = count / (rowSpan * colSpan)
      console.log(`[shots] contour gate (${mode}, +${TH - bgLum}): span=${colSpan}×${rowSpan} aspect=${aspect.toFixed(2)} fill=${(100 * fill).toFixed(1)}%`)
      // a CIRCLE: aspect ≈ 1, fill ≈ π/4; a quad reads ~1.0 fill, a clipped
      // artifact reads a wild aspect. Spans must SHRINK with the threshold.
      if (aspect < 0.9 || aspect > 1.1) {
        throw new Error(`[shots] sprite probe (${mode}): aspect ${aspect.toFixed(2)} — the footprint is not round (a clipped/sheared quad?)`)
      }
      if (fill < 0.7 || fill > 0.86) {
        throw new Error(`[shots] sprite probe (${mode}): fill ${(100 * fill).toFixed(1)}% — not the π/4 circle (an opaque quad reads ~100%, a hollow ring reads low)`)
      }
      if (rowSpan > prevSpan) {
        throw new Error(`[shots] sprite probe (${mode}): the span GROWS with the threshold — an inverted/flat profile (a hard-edged quad)`)
      }
      prevSpan = rowSpan
    }
    console.log(`[shots] contour gate (${mode}): OK — a soft round glow`)
  }
}

// run the contour gate right after the preset shots
await assertSpriteContour()

// ─── vfx: the 14-demo suite (Task 122) — a shot per demo + gates ───────
// Task 18: the sweep runs FORCED on WebGL2 (the Task 121 lesson — an AUTO
// sweep exercises whatever this machine can create, not the reported path),
// and each demo gains a MOTION gate (two screenshots, 300 ms apart: a
// frozen canvas fails even when the pill counts alive — the WebGPU
// stale-binding freeze class) — plus a BACKEND-TOGGLE round trip at the end.
{
  const vfxPage = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const qkErrors = []
  vfxPage.on('pageerror', (e) => qkErrors.push(String(e)))
  await vfxPage.goto(`http://localhost:${port}/demo/vfx/`, { waitUntil: 'networkidle' })
  // force WebGL2 via the shell FAB toggle (the demo re-boots on the backend)
  await vfxPage.click('#rd-fab')
  await vfxPage.click('label[for="mode-webgl2"]')
  await vfxPage.mouse.click(640, 60)
  await vfxPage.evaluate(() => document.querySelector('.pt-sheet [aria-label=Close]')?.click())
  for (let i = 0; i < 40; i++) {
    await vfxPage.waitForTimeout(500)
    const badge = await vfxPage.textContent('#backend').catch(() => '…')
    const pill = await vfxPage.textContent('.pt-pill').catch(() => '')
    if (badge === 'WebGL2' && /[1-9][\d,]* particles/.test(pill)) break
  }
  await vfxPage.waitForFunction(() => /Sentry Turret · [1-9][\d,]* particles/.test(document.querySelector('.pt-pill')?.textContent ?? ''), null, { timeout: 20000 })

  const VFX_NAMES = ['muzzle', 'explosion', 'shapes', 'trail', 'sequencer', 'mesh', 'subemitter',
    'noise', 'alphatest', 'plugin', 'billboard', 'soft', 'blending', 'follow',
    'rocket', 'storm', 'slash', 'vortex', 'fireflies', 'dust', 'grass', 'lightning', 'laser']
  const VFX_SETTLE = { muzzle: 2500, explosion: 2100, trail: 1300, grass: 2600, lightning: 2600, laser: 3000 }
  // The SEQUENCER is a still formation by design (hold phases) — its motion
  // pair brackets the t=6.5 s MORPH: we wait for the demo's own "morph →
  // spiral" log line, then shoot the pair mid-flight (300 ms apart).
  const shotPills = []
  for (let i = 0; i < VFX_NAMES.length; i++) {
    const name = VFX_NAMES[i]
    if (i > 0) await vfxPage.click('.pt-arrow:last-child')
    await vfxPage.waitForTimeout(VFX_SETTLE[name] ?? 1700)
    if (name === 'sequencer') {
      // The morph, caught IN-PAGE at rAF cadence (window.__seqLayer is
      // exposed for this gate): an in-page promise resolves the FRAME the
      // retarget rewrites tx[0] — no Playwright polling latency — so the
      // pixel pair brackets the actual flight (the demo is a still
      // formation by design; a plain 300 ms pair lands on a hold).
      const morphed = vfxPage.evaluate(() => new Promise(resolve => {
        const f = window.__seqLayer?.facade?.fields
        if (f === undefined) { resolve(false); return }
        const t0 = f.tx[0]
        const check = () => {
          if (Math.abs(f.tx[0] - t0) > 0.01) { resolve(true); return }
          requestAnimationFrame(check)
        }
        requestAnimationFrame(check)
      }))
      await Promise.race([morphed, vfxPage.waitForTimeout(25000)])
    }
    if (name === 'explosion') {
      // PHASE-LOCKED (the blast is periodic, the effect lives ~1.6 s of
      // every 2 — but the first frame after the switch carries the boot
      // lag and SwiftShader dilates the cadence, so a FIXED settle can
      // land the pair in the dead gap). Wait for the NEXT "explosion #"
      // log line, then shoot mid-blast: the pair always brackets live
      // fire, exactly like the explosion-shots tool's MutationObserver.
      const before = await vfxPage.evaluate(() =>
        (document.querySelector('#log-list')?.textContent ?? '').match(/explosion #(\d+)/g)?.length ?? 0)
      await vfxPage.waitForFunction(
        (n) => ((document.querySelector('#log-list')?.textContent ?? '').match(/explosion #\d+/g)?.length ?? 0) > n,
        before,
        { timeout: 15000 },
      ).catch(() => {})
      // mid-blast, CONFIRMED alive: wait until the pill itself shows live
      // particles (a slow runner's 400 ms can overshoot the whole blast
      // into the quiet tail — the pill is the truth, not the clock)
      await vfxPage.waitForFunction(
        () => /Explosion \(composed\) \u00b7 [1-9][\d,]* particles/.test(document.querySelector('.pt-pill')?.textContent ?? ''),
        null,
        { timeout: 12000 },
      ).catch(() => {})
      await vfxPage.waitForTimeout(400) // mid-blast: the flash + sparks + young smoke
    }
    if (name === 'slash') {
      // PHASE-LOCKED (the same class as the explosion): the swing cycle
      // has quiet windups by design — wait for the next action beat
      // (glints/ribbon/impact alive in the pill) before the canonical
      // shot (the demo OPENS mid-slash, but the settle can overshoot
      // into the next windup's quiet beat).
      await vfxPage.waitForFunction(
        () => /Sword Slash · [1-9][\d,]* particles/.test(document.querySelector('.pt-pill')?.textContent ?? ''),
        null,
        { timeout: 12000 },
      ).catch(() => {})
      await vfxPage.waitForTimeout(250)
    }
    if (name === 'trail') {
      // PHASE-LOCKED (the same class as the explosion): the firework burst
      // is periodic (t=0.6 then every 5 s) — wait until comets are LIVE in
      // the pill, then shoot mid-flight (a fixed settle can land the
      // pre-burst beat under the 22-demo module-load lag).
      await vfxPage.waitForFunction(
        () => /Trails & Collision · [1-9][\d,]* particles/.test(document.querySelector('.pt-pill')?.textContent ?? ''),
        null,
        { timeout: 12000 },
      ).catch(() => {})
      await vfxPage.waitForTimeout(500)
    }
    if (name === 'storm') {
      // PHASE-LOCKED (the pill-race class, seen as an intermittent "0
      // particles" flake): the rain fills ~1 s after the module boots, and
      // a loaded-down runner can burn the whole 1.7 s settle before the
      // first drop spawns — wait until drops are LIVE in the pill.
      await vfxPage.waitForFunction(
        () => /Rainstorm · [1-9][\d,]* particles/.test(document.querySelector('.pt-pill')?.textContent ?? ''),
        null,
        { timeout: 12000 },
      ).catch(() => {})
    }
    await vfxPage.screenshot({ path: join(out, `vfx-${name}.png`) })
    // the ALIVE pill is read at SHOT A's moment (the canonical shot): the
    // motion pair's later shot can legitimately land in a burst-free window
    // (the sequencer's dissolve, the trail's pre-burst beat) — that is not
    // a dead demo.
    shotPills.push(await vfxPage.textContent('.pt-pill'))
    // THE MOTION GATE: a second shot LATER — a healthy animated demo
    // changes pixels; a frozen canvas (the stale-binding class) does not.
    // THE PAIR WINDOW: wait for at least TWO NEW RENDERED FRAMES (the
    // page's own __vfxFrame tick) instead of a fixed 300 ms — a slow
    // rasterizer (SwiftShader) can take > 300 ms per frame, and a fixed
    // window would sample the SAME frame twice: a live canvas read as
    // FROZEN. Capped at 1.8 s (a genuinely frozen canvas never ticks).
    const tickA = await vfxPage.evaluate(() => window.__vfxFrame ?? 0)
    await vfxPage.waitForFunction(
      (t) => (window.__vfxFrame ?? 0) >= t + 2,
      tickA,
      { timeout: 1800 },
    ).catch(() => {})
    await vfxPage.waitForTimeout(name === 'sequencer' ? 450 : 120)
    const f2 = await vfxPage.screenshot()
    const f1 = await import('pngjs').then(m => m.PNG.sync.read(readFileSync(join(out, `vfx-${VFX_NAMES[i]}.png`))))
    const f2png = await import('pngjs').then(m => m.PNG.sync.read(f2))
    let changed = 0
    const n = f1.data.length
    for (let p = 0; p < n; p += 64) {
      const dd = Math.abs(f1.data[p] - f2png.data[p]) + Math.abs(f1.data[p + 1] - f2png.data[p + 1]) + Math.abs(f1.data[p + 2] - f2png.data[p + 2])
      if (dd > 12) changed++
    }
    const motionFrac = changed / (n / 64)
    const pill = shotPills[i]
    console.log(`[shots] vfx ${VFX_NAMES[i]}: motion ${(motionFrac * 100).toFixed(2)}% — ${pill}`)
    if (motionFrac < 0.002) {
      throw new Error(`[shots] vfx ${VFX_NAMES[i]}: FROZEN canvas (${(motionFrac * 100).toFixed(3)}% pixels changed in 300 ms) — ${pill}`)
    }
  }
  if (qkErrors.length > 0) {
    throw new Error(`[shots] vfx page errors: ${qkErrors.slice(0, 3).join(' | ')}`)
  }

  // THE GATES (the same class the particles presets use — per-demo pixel
  // liveness: every demo's shot must carry content above the clear color;
  // the SOFT shot (the knots) additionally must show the LIT meshes).
  for (const [i, name] of VFX_NAMES.entries()) {
    const { PNG } = await import('pngjs')
    const png = PNG.sync.read(readFileSync(join(out, `vfx-${name}.png`)))
    let bright = 0
    const { width, height, data } = png
    for (let p = 0; p < width * height; p++) {
      if ((data[p * 4] + data[p * 4 + 1] + data[p * 4 + 2]) / 3 > 40) bright++
    }
    const pct = (bright / (width * height)) * 100
    const alive = / · [1-9][\d,]* particles · [1-9][\d,]* verts/.test(shotPills[i])
    console.log(`[shots] vfx ${name}: bright ${pct.toFixed(2)}% — ${shotPills[i]} (${alive ? 'alive' : 'DEAD'})`)
    if (!alive) throw new Error(`[shots] vfx ${name}: the pill shows no live particles — ${shotPills[i]}`)
    if (pct < 0.15) throw new Error(`[shots] vfx ${name}: only ${pct.toFixed(2)}% bright pixels — the demo renders nothing`)
  }
  await vfxPage.close()
}

// ─── Task 18: the BACKEND-TOGGLE round trip (the stale-binding gate) ──────
// The WebGPU freeze class: switching WebGL2 → WebGPU → WebGL2 used to leave
// the layers bound to the DEAD first backend (the frozen canvas with
// "twitches"). After the round trip the canvas must ANIMATE again and no
// page error may have escaped. (On machines without a WebGPU device the
// middle leg boots or fails loudly — either way the LAST leg is WebGL2.)
{
  const vfxPage = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  vfxPage.on('pageerror', e => errors.push(String(e)))
  await vfxPage.goto(`http://localhost:${port}/demo/vfx/`, { waitUntil: 'networkidle' })
  const settleBackend = async (want, tries = 40) => {
    for (let i = 0; i < tries; i++) {
      await vfxPage.waitForTimeout(500)
      const badge = await vfxPage.textContent('#backend').catch(() => '…')
      const pill = await vfxPage.textContent('.pt-pill').catch(() => '')
      if (badge === want && /[1-9][\d,]* particles/.test(pill)) return true
    }
    return false
  }
  // leg 1: WebGL2
  await vfxPage.click('#rd-fab')
  await vfxPage.click('label[for="mode-webgl2"]')
  await vfxPage.mouse.click(640, 60)
  if (!(await settleBackend('WebGL2'))) throw new Error('[shots] toggle: WebGL2 leg never came alive')
  // leg 2: WebGPU (may fail on this machine — the badge then says so)
  await vfxPage.click('#rd-fab')
  await vfxPage.click('label[for="mode-webgpu"]')
  await vfxPage.mouse.click(640, 60)
  await vfxPage.waitForTimeout(2500)
  const midBadge = await vfxPage.textContent('#backend').catch(() => '…')
  // leg 3: back to WebGL2 — the canvas must ANIMATE (the stale-binding gate)
  await vfxPage.click('#rd-fab')
  await vfxPage.click('label[for="mode-webgl2"]')
  await vfxPage.mouse.click(640, 60)
  if (!(await settleBackend('WebGL2'))) throw new Error('[shots] toggle: the WebGL2 return leg never came alive')
  await vfxPage.waitForTimeout(1200)
  const { PNG } = await import('pngjs')
  const a = PNG.sync.read(await vfxPage.screenshot())
  await vfxPage.waitForTimeout(300)
  const b = PNG.sync.read(await vfxPage.screenshot())
  let changed = 0
  for (let p = 0; p < a.data.length; p += 64) {
    const dd = Math.abs(a.data[p] - b.data[p]) + Math.abs(a.data[p + 1] - b.data[p + 1]) + Math.abs(a.data[p + 2] - b.data[p + 2])
    if (dd > 12) changed++
  }
  const motionFrac = changed / (a.data.length / 64)
  console.log(`[shots] toggle round trip (mid=${midBadge}): motion ${(motionFrac * 100).toFixed(2)}%`)
  if (motionFrac < 0.002) {
    throw new Error(`[shots] toggle: FROZEN canvas after the backend round trip (${(motionFrac * 100).toFixed(3)}%) — the stale-binding class is back`)
  }
  if (errors.length > 0) {
    throw new Error(`[shots] toggle: page errors — ${errors.slice(0, 3).join(' | ')}`)
  }
  await vfxPage.close()
}

// phone: the preset sheet as the entry point
const ptPhone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
await ptPhone.goto(`http://localhost:${port}/demo/particles/`, { waitUntil: 'networkidle' })
await ptPhone.waitForFunction(() => document.querySelector('#backend')?.textContent !== '…', null, { timeout: 15000 })
await ptPhone.waitForTimeout(2000)
await ptPhone.screenshot({ path: join(out, 'mobile-particles-scene.png') })

await browser.close()
server.stop(true)
console.log(`[shots] screenshots in ${out}`)
