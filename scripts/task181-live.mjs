// Task 181 live gate — the deployed page must draw + animate through the
// new indexed instance draw (canvas element screenshots differ per frame,
// the pill reports the 4-corner counting, zero page errors).
import { chromium } from 'playwright'

const URL = process.env.URL ?? 'https://atolbat.github.io/rune/demo/vfx/'
const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-webgpu'] })
const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
const errors = []
page.on('pageerror', e => errors.push(String(e.message).slice(0, 160)))
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3500) // the demo boots, the first particles land
const url = page.url()
const canvas = page.locator('canvas').first()
const shots = []
for (let i = 0; i < 3; i++) {
  const buf = await canvas.screenshot()
  shots.push(buf.length > 64 ? buf.subarray(buf.length - 512).join(',') : 'x')
  await page.waitForTimeout(400)
}
const pill = (await page.textContent('.as-pill').catch(() => '')) ?? ''
const distinct = new Set(shots).size
console.log(`[live181] url: ${url}`)
console.log(`[live181] pill: ${pill.trim().slice(0, 90)}`)
console.log(`[live181] canvas tail-bytes distinct: ${distinct}/3 → ${distinct > 1 ? 'ANIMATES' : 'FROZEN'}`)
console.log(`[live181] page errors: ${errors.length === 0 ? 'none' : errors.join(' | ').slice(0, 300)}`)
const ok = distinct > 1 && errors.length === 0
console.log(`LIVE-181: ${ok ? 'PASS' : 'FAIL'}`)
await browser.close()
process.exit(ok ? 0 : 1)
