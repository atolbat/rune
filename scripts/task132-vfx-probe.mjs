// task132-vfx-probe.mjs — open the vfx page (backend-forced), step to a
// target demo, dump the pill + the console errors. Usage:
//   bun scripts/task132-vfx-probe.mjs [demoIndex] [backend]
import { chromium } from 'playwright'

const port = Number(process.env.PORT ?? 8099)
const target = Number(process.argv[2] ?? 1) // 0 = boot demo (sentry), 1 = explosion…
const backend = process.argv[3] ?? 'webgl2'

const browser = await chromium.launch({
  args: [
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    ...(backend === 'webgl2' ? ['--disable-webgpu'] : ['--enable-features=Vulkan', '--enable-unsafe-webgpu']),
  ],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = []
page.on('console', msg => {
  const text = msg.text()
  if (msg.type() === 'error' || msg.type() === 'warning') errors.push(`[${msg.type()}] ${text.slice(0, 300)}`)
})
page.on('pageerror', err => errors.push(`[pageerror] ${String(err).slice(0, 300)}`))

await page.goto(`http://localhost:${port}/demo/vfx/`, { waitUntil: 'networkidle' })
// force the backend via the boot select
await page.evaluate(b => {
  const sel = document.querySelector('select')
  if (sel !== null) {
    const opt = Array.from(sel.options).find(o => o.textContent.toLowerCase().includes(b === 'webgl2' ? 'webgl' : 'webgpu'))
    if (opt !== null) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })) }
  }
}, backend)
await page.waitForTimeout(2500)
await page.waitForTimeout(500)
// jump DIRECTLY to the demo by its sheet row (no 23-click walk)
const demoName = process.argv[4] ?? 'gpu'
if (demoName === 'walk') {
  await page.evaluate(() => document.querySelector('.pt-sheet [aria-label=Close]')?.click())
  await page.waitForTimeout(300)
  for (let i = 0; i < target; i++) {
    await page.click('.pt-arrow:last-child').catch(() => page.evaluate(() => document.querySelector('.pt-arrow:last-child')?.click()))
    await page.waitForTimeout(2200)
  }
} else {
  await page.evaluate((name) => {
    const rows = Array.from(document.querySelectorAll('.pt-row'))
    const row = rows.find(r => (r.textContent ?? '').toLowerCase().includes(name.toLowerCase()))
    if (row !== undefined) row.click()
    document.querySelector('.pt-sheet [aria-label=Close]')?.click()
  }, demoName)
  await page.waitForTimeout(3000)
}
// THE SMOKE's framesDiffer: the ELEMENT screenshot with a timed log
const t0 = Date.now()
try {
  const shotA = await page.screenshot({ timeout: 20_000 })
  await page.waitForTimeout(700)
  const shotB = await page.screenshot({ timeout: 20_000 })
  console.log('FRAMESDIFFER(page):', Date.now() - t0, 'ms, differ =', !shotA.equals(shotB))
} catch (e) {
  console.log('FRAMESDIFFER FAILED after', Date.now() - t0, 'ms:', String(e).slice(0, 200))
}
const pill = await page.textContent('.pt-pill').catch(() => 'no pill')
const logText = await page.evaluate(() => document.querySelector('#log-list')?.textContent ?? '').catch(() => 'no log')
const frame = await page.evaluate(() => window.__vfxFrame ?? -1)
const perf = await page.evaluate(() => window.__vfxPerf ?? null)
// the canvas liveness: two screenshots 300ms apart, compare bytes
const shot1 = await page.screenshot()
await page.waitForTimeout(300)
const shot2 = await page.screenshot()
const alive = !shot1.equals(shot2)
console.log('PILL:', pill)
console.log('FRAME:', frame, 'CANVAS-ALIVE:', alive)
console.log('PERF:', JSON.stringify(perf))
console.log('CONSOLE ERRORS/WARNINGS (unique):')
const uniq = [...new Set(errors)]
for (const e of uniq.slice(-12)) console.log('  ', e)
console.log(`(${errors.length} total, ${uniq.length} unique)`)
await page.screenshot({ path: `/home/z/my-project/scripts/task132-probe-${backend}-${target}.png` })
await browser.close()
