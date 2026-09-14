/**
 * scripts/task205-live.mjs — the LIVE gate: the deployed Pages site carries
 * Task 205 (the research harvest). The occlusion page boots the rebuilt
 * dist (?v=205 — checked against the SERVED source), the boot validation
 * passes on the live GPU stack (the soft-HiZ gate rides it: the CPU
 * verdicts vs the GPU's own, tolerance 32), and the gate's log line
 * carries the Task-205 timing (the tile-tier raster + the CSE projector
 * measured on the deployed page).
 */
import { chromium } from 'playwright'

const browser = await chromium.launch({
  headless: true,
  // the occlusion page's own flag set (demo-smoke.mjs's hizBrowser —
  // SwiftShader WebGPU needs --enable-unsafe-webgpu + Vulkan, else the
  // adapter answers null and the WG tier honestly refuses to boot)
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 160)}`))
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`) })

await page.goto('https://atolbat.github.io/rune/demo/occlusion/', { waitUntil: 'networkidle', timeout: 45_000 })
const stats = await page.waitForFunction(
  () => (window.__hizStats && window.__hizStats.validation !== null && window.__hizStats.drawn > 0 ? window.__hizStats : undefined),
  null,
  { timeout: 300_000 },
).then(h => h.jsonValue())

const logText = await page.evaluate(() => document.querySelector('#log-list')?.textContent ?? '')
// the served main.js must reference the rebuilt dist (?v=205)
const src = await (await fetch('https://atolbat.github.io/rune/demo/occlusion/main.js')).text()

const validation = stats?.validation?.pass === true
const drawn = (stats?.drawn ?? 0) > 0
const culled = (stats?.occlusionCulled ?? 0) > 0
const softLine = /soft-HiZ [^|]*Task 205/.test(logText)
const softTimed = /\d+(\.\d+)? ms \(Task 205/.test(logText)
const v205 = src.includes('dist/rune.esm.js?v=205')

console.log('[live] validation:', validation ? 'PASS' : 'FAIL', `· drawn ${stats?.drawn}/${stats?.total} · occluded ${stats?.occlusionCulled}`)
console.log('[live] soft-HiZ Task-205 line:', softLine ? 'present' : 'MISSING', `· timed: ${softTimed ? 'yes' : 'no'}`)
console.log('[live] served main.js ?v=205:', v205 ? 'yes' : 'NO')
const softSample = logText.match(/soft-HiZ [^·]{0,120}/)?.[0] ?? null
if (softSample) console.log('[live] the gate line:', softSample.trim())

const ok = validation && drawn && culled && softLine && softTimed && v205 && errors.length === 0
if (errors.length > 0) console.log('[live] errors:', errors.slice(0, 4))
console.log(`[live] verdict: ${ok ? 'PASS — Task 205 is live (the research harvest, measured on the deployed page)' : 'FAIL'}`)
await browser.close()
process.exit(ok ? 0 : 1)
