/**
 * scripts/demo-shots.mjs — visual check of the demos (not CI): screenshots
 * of desktop and phone, the model sheet in its states, the fullscreen viewer.
 */
import { join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const out = resolve(root, '.shots')
const port = 8124

mkdirSync(out, { recursive: true })

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
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
  // the alpha gate on the ALPHA_PIPELINE presets (see assertNoBlackRims)
  if (name === 'Embers' || name === 'Snow') await assertNoBlackRims(pt, shotPath, name)
}

// THE ALPHA REGRESSION GATE (Task 118): the background is the configured
// clear color [4,5,9]; a broken sprite alpha draws OPAQUE quads — their
// rims are EXACTLY [0,0,0] (the straight-alpha rim rgb is 0 where a≈0).
// PNG screenshots are lossless: any pure-[0,0,0] pixel = the alpha died.
// Run on the embers/snow shots (the ALPHA_PIPELINE presets — the additive
// ones hide the rim black under overbright cores).
async function assertNoBlackRims(page, shotPath, preset) {
  const { readFile } = await import('node:fs/promises')
  const { PNG } = await import('pngjs')
  const png = PNG.sync.read(await readFile(shotPath))
  const { width: W, height: H, data } = png
  let pure = 0
  for (let i = 0; i < W * H * 4; i += 4) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0) pure++
  }
  console.log(`[shots] alpha gate (${preset}): pure-[0,0,0] pixels = ${pure}`)
  if (pure > 0) {
    throw new Error(`[shots] ${preset}: ${pure} pure-black pixels — the sprite alpha broke (opaque quad rims)`)
  }
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
