// task184-live — the deployed-site gate: the vfx page (all-instance-mode)
// on https://atolbat.github.io/rune/ must boot, animate, and stay error-free.
import { chromium } from 'playwright'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-gpu-sandbox'] })
const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
const errors = []
page.on('pageerror', e => errors.push('pageerror: ' + e.message.slice(0, 150)))
await page.goto('https://atolbat.github.io/rune/demo/vfx/', { waitUntil: 'networkidle', timeout: 60_000 })
await page.waitForTimeout(2500)
const REGION = { x: 60, y: 140, width: 420, height: 420 }
const a = await page.screenshot({ clip: REGION, timeout: 60_000 })
await page.waitForTimeout(700)
const b = await page.screenshot({ clip: REGION, timeout: 30_000 })
let diff = 0
for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 24) diff++
const pill = await page.textContent('.pt-pill')
console.log('pill:', pill?.trim())
console.log('canvas diff bytes:', diff, '→', diff > 500 ? 'ANIMATES' : 'STATIC')
console.log('page errors:', errors.length === 0 ? 'none' : errors.join(' | '))
// the version marker is live
const v = await page.evaluate(() => [...document.querySelectorAll('script[type=module]')].map(s => s.src).join(','))
console.log('module srcs:', v)
const ok = diff > 500 && errors.length === 0
console.log(ok ? 'LIVE DEPLOYED GATE: PASS' : 'LIVE DEPLOYED GATE: FAIL')
await browser.close()
process.exit(ok ? 0 : 1)
