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
  viewerOk = shotA.length > 5000 && !shotA.equals(shotB)
  await page.screenshot({ path: join(OUT, 'live-model-viewer.png') })
  console.log(`model-viewer scene: ${await page.textContent('.mv-stats')}`)
} catch (error) {
  console.log(`model-viewer check failed: ${error instanceof Error ? error.message : String(error)}`)
}
console.log(viewerOk ? 'model-viewer LIVE OK' : 'model-viewer LIVE FAIL')

await browser.close()
process.exit(cubeOk && viewerOk && errors.length === 0 ? 0 : 1)
