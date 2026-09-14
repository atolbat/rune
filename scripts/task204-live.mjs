/**
 * scripts/task204-live.mjs — the LIVE gate: the deployed Pages site carries
 * Task 204 and the frame graph actually runs there (the graph channel + the
 * HUD line + the cull accounting on the live particles page).
 */
import { chromium } from 'playwright'

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--no-sandbox'],
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 160)}`))
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`) })

await page.goto('https://atolbat.github.io/rune/demo/particles/', { waitUntil: 'networkidle', timeout: 45_000 })
await page.waitForFunction(
  () => (document.querySelector('.pt-graph')?.textContent ?? '').includes('frame graph:'),
  null, { timeout: 30_000 },
)
const live = await page.evaluate(() => ({
  graphLine: document.querySelector('.pt-graph')?.textContent ?? null,
  fg: window.__fgDebug?.last?.() ?? null,
  cull: window.__ptCull?.() ?? null,
  pill: document.querySelector('.pt-pill')?.textContent ?? null,
}))
console.log('[live] particles graph line:', live.graphLine)
console.log('[live] particles pill:', live.pill)
console.log('[live] live passes:', (live.fg?.live ?? []).join(' → '))
console.log('[live] cull:', JSON.stringify(live.cull))

const ok = live.fg !== null
  && live.fg.live.includes('sim') && live.fg.live.includes('present')
  && live.cull !== null && Math.abs(live.cull.alive - live.cull.baked - live.cull.culled) <= 2
  && errors.length === 0
if (errors.length > 0) console.log('[live] errors:', errors.slice(0, 4))
console.log(`[live] verdict: ${ok ? 'PASS — Task 204 is live' : 'FAIL'}`)
await browser.close()
process.exit(ok ? 0 : 1)
