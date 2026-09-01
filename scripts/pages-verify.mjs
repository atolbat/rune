/** scripts/pages-verify.mjs — проверка БОЕВОГО демо на GitHub Pages. */
import { chromium } from 'playwright'

const BASE = 'https://atolbat.github.io/rune'
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
await page.screenshot({ path: 'live-hello-cube.png', fullPage: true })

console.log(`бейдж: ${badge}`)
console.log(`записей в логе: ${entries}`)
console.log(`ошибок страницы: ${errors.length}`)
for (const e of errors) console.log(`  ${e}`)
console.log(shot.length > 5000 && errors.length === 0 ? 'LIVE OK' : 'LIVE FAIL')

await browser.close()
process.exit(shot.length > 5000 && errors.length === 0 ? 0 : 1)
