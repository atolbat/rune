// task134-vfx-probe.mjs — the GPU RENDER TIER's live-page gate: the vfx
// page's GPU Embers demo with BOTH Task 134 flags ON (?sort=1&cull=1 —
// the bitonic painter's order + the per-particle frustum gate) on the
// WebGL2 transform-feedback leg (the SwiftShader container's default).
// The aliveness check is JS-side (window.__vfxPerf.count advancing + the
// pill) — NOT screenshots: the software rasterizer's compositor readback
// starves under the render tier's extra passes (the documented container
// class — the page's own frame callbacks stay ~16ms; the count climbs).
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? 8099
const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--disable-webgpu'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = []
page.on('console', msg => {
  const text = msg.text()
  if (msg.type() === 'error') errors.push(`[error] ${text.slice(0, 300)}`)
})
page.on('pageerror', err => errors.push(`[pageerror] ${String(err).slice(0, 300)}`))

await page.goto(`http://localhost:${PORT}/demo/vfx/?sort=1&cull=1`, { waitUntil: 'networkidle' })
await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('.pt-row'))
  const row = rows.find(r => (r.textContent ?? '').toLowerCase().includes('gpu'))
  if (row !== undefined) row.click()
  document.querySelector('.pt-sheet [aria-label=Close]')?.click()
})

// the pill reaches the live state (generous — the render tier slows the
// SwiftShader leg; the count still climbs)
await page.waitForFunction(
  () => /GPU Embers · [1-9][\d,]* particles/.test(document.querySelector('.pt-pill')?.textContent ?? ''),
  null,
  { timeout: 45_000 },
)
const pill = await page.textContent('.pt-pill')
const countA = await page.evaluate(() => window.__vfxPerf?.count ?? -1)
await page.waitForTimeout(2500)
const countB = await page.evaluate(() => window.__vfxPerf?.count ?? -1)
const perf = await page.evaluate(() => window.__vfxPerf ?? null)

console.log(`pill: ${pill}`)
console.log(`perf: ${JSON.stringify(perf)}`)
console.log(`count advancing: ${countA} → ${countB}`)
const alive = countB !== countA && countB > 100
const clean = errors.length === 0
if (!clean) for (const e of errors.slice(0, 10)) console.log(' ', e)
console.log(alive && clean ? 'GPU RENDER TIER (sort+cull) LIVE GATE: PASS' : 'GPU RENDER TIER (sort+cull) LIVE GATE: FAIL')
await browser.close()
process.exit(alive && clean ? 0 : 1)
