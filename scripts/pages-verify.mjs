/** scripts/pages-verify.mjs — checks the LIVE demo on GitHub Pages. */
import { join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const BASE = 'https://atolbat.github.io/rune'
const OUT = resolve(import.meta.dirname, '..', '.shots')

mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--no-sandbox'],
})

const errors = []
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push(e.message))

await page.goto(`${BASE}/demo/hello-cube/`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => document.querySelector('#backend')?.textContent !== '…', null, { timeout: 20000 })
const badge = await page.textContent('#backend')
await page.waitForTimeout(800)
const shot = await page.locator('#canvas').screenshot()
const entries = await page.locator('#log-list .rd-entry').count()
await page.screenshot({ path: join(OUT, 'live-hello-cube.png'), fullPage: true })

console.log(`badge: ${badge}`)
console.log(`log entries: ${entries}`)
console.log(`page errors: ${errors.length}`)
for (const e of errors) console.log(`  ${e}`)
const cubeOk = shot.length > 5000 && errors.length === 0
console.log(cubeOk ? 'hello-cube LIVE OK' : 'hello-cube LIVE FAIL')

// ─── model-viewer: load the first model on the live page ──────────────────
let viewerOk = false
try {
  await page.goto(`${BASE}/demo/model-viewer/`, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => document.querySelector('#backend')?.textContent !== '…', null, { timeout: 20000 })
  await page.click('.mv-load')
  await page.waitForFunction(
    () => (document.querySelector('.mv-stats')?.textContent ?? '').includes('verts'),
    null,
    { timeout: 120_000 },
  )
  await page.waitForTimeout(900)
  const shotA = await page.locator('#canvas').screenshot()
  await page.waitForTimeout(900)
  const shotB = await page.locator('#canvas').screenshot()
  // The first model is the Forest House — now the Cook-Torrance PBR pipeline
  // (the assembled GLSL/WGSL variant must compile clean on the live backend)
  const logText = await page.evaluate(() => document.querySelector('#log-list')?.textContent ?? '')
  const gpuClean = !/too small|Invalid CommandBuffer|storm|rendering stopped|GL: GL_|GPU: /i.test(logText)
  viewerOk = shotA.length > 5000 && !shotA.equals(shotB) && gpuClean
  await page.screenshot({ path: join(OUT, 'live-model-viewer.png') })
  console.log(`model-viewer scene: ${await page.textContent('.mv-stats')}`)
  console.log(`house PBR GPU log: ${gpuClean ? 'clean' : 'ERRORS'}`)
} catch (error) {
  console.log(`model-viewer check failed: ${error instanceof Error ? error.message : String(error)}`)
}
console.log(viewerOk ? 'model-viewer LIVE OK (house PBR)' : 'model-viewer LIVE FAIL')

// ─── samba: the skinned FBX path on the LIVE page (stats + animation +
// a clean GPU log — no binding/storm errors) ─────────────────────────────
let sambaOk = false
try {
  await page.click('.mv-pill') // open the model sheet (auto-hidden after the first load)
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.mv-row')]
    rows.find(r => r.textContent.includes('Samba'))?.dispatchEvent(new Event('click', { bubbles: true }))
  })
  await page.waitForTimeout(300)
  await page.click('.mv-load')
  await page.waitForFunction(
    () => (document.querySelector('.mv-stats')?.textContent ?? '').includes('joints'),
    null,
    { timeout: 120_000 },
  )
  await page.waitForTimeout(2000)
  const shotA = await page.locator('#canvas').screenshot()
  await page.waitForTimeout(1200)
  const shotB = await page.locator('#canvas').screenshot()
  const stats = await page.textContent('.mv-stats')
  const logText = await page.evaluate(() => document.querySelector('#log-list')?.textContent ?? '')
  const gpuClean = !/too small|Invalid CommandBuffer|storm|rendering stopped/i.test(logText)
  await page.screenshot({ path: join(OUT, 'live-samba.png') })
  console.log(`samba scene: ${stats}`)
  console.log(`samba GPU log: ${gpuClean ? 'clean' : 'ERRORS'}`)
  sambaOk = stats.includes('joints') && !shotA.equals(shotB) && gpuClean
} catch (error) {
  console.log(`samba check failed: ${error instanceof Error ? error.message : String(error)}`)
}
console.log(sambaOk ? 'SAMBA LIVE OK' : 'SAMBA LIVE FAIL')

// ─── matcap: the procedural MATCAP feature on the LIVE page (the assembled
// shader pair + the view-space normal lookup + the generated sphere texture) ─
let matcapOk = false
try {
  await page.click('.mv-pill')
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.mv-row')]
    rows.find(r => r.textContent.includes('Matcap'))?.dispatchEvent(new Event('click', { bubbles: true }))
  })
  await page.waitForTimeout(300)
  await page.click('.mv-load')
  await page.waitForFunction(
    () => (document.querySelector('.mv-stats')?.textContent ?? '').includes('36 verts'),
    null,
    { timeout: 30_000 },
  )
  await page.waitForTimeout(800)
  const shotA = await page.locator('#canvas').screenshot()
  await page.waitForTimeout(1200)
  const shotB = await page.locator('#canvas').screenshot()
  const logText = await page.evaluate(() => document.querySelector('#log-list')?.textContent ?? '')
  const gpuClean = !/too small|Invalid CommandBuffer|storm|rendering stopped|GL: GL_|GPU: /i.test(logText)
  await page.screenshot({ path: join(OUT, 'live-matcap.png') })
  console.log(`matcap scene: ${await page.textContent('.mv-stats')}`)
  console.log(`matcap GPU log: ${gpuClean ? 'clean' : 'ERRORS'}`)
  matcapOk = !shotA.equals(shotB) && gpuClean
} catch (error) {
  console.log(`matcap check failed: ${error instanceof Error ? error.message : String(error)}`)
}
console.log(matcapOk ? 'MATCAP LIVE OK' : 'MATCAP LIVE FAIL')

// ─── particles: the @rune/particles demo on the LIVE page (the steady
// state pill, the frame-to-frame soup change, a clean GPU log) ──────────
let particlesLiveOk = false
try {
  await page.goto(`${BASE}/demo/particles/`, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => document.querySelector('#backend')?.textContent !== '…', null, { timeout: 20000 })
  await page.waitForFunction(
    () => /\/ 8,192 · [1-9][\d,]* verts/.test(document.querySelector('.pt-pill')?.textContent ?? ''),
    null,
    { timeout: 30_000 },
  )
  await page.waitForTimeout(900)
  const shotA = await page.locator('#canvas').screenshot()
  await page.waitForTimeout(900)
  const shotB = await page.locator('#canvas').screenshot()
  const pill = await page.textContent('.pt-pill')
  const logText = await page.evaluate(() => document.querySelector('#log-list')?.textContent ?? '')
  const gpuClean = !/too small|Invalid CommandBuffer|storm|rendering stopped|GL: GL_|GPU: |failed/i.test(logText)
  await page.screenshot({ path: join(OUT, 'live-particles.png') })
  console.log(`particles pill: ${pill}`)
  console.log(`particles GPU log: ${gpuClean ? 'clean' : 'ERRORS'}`)
  particlesLiveOk = pill.includes('verts') && !shotA.equals(shotB) && gpuClean
} catch (error) {
  console.log(`particles check failed: ${error instanceof Error ? error.message : String(error)}`)
}
console.log(particlesLiveOk ? 'PARTICLES LIVE OK' : 'PARTICLES LIVE FAIL')

await browser.close()
process.exit(cubeOk && viewerOk && sambaOk && matcapOk && particlesLiveOk && errors.length === 0 ? 0 : 1)
