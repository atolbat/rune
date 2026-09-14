import { chromium } from 'playwright'
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--no-sandbox'] })
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 300)}`))
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 300)}`) })
await page.goto('https://atolbat.github.io/rune/demo/occlusion/', { waitUntil: 'networkidle', timeout: 60_000 })
await page.waitForTimeout(25_000)
const log = await page.evaluate(() => document.querySelector('#log-list')?.textContent ?? '(no log element)')
console.log('=== FULL LOG ===')
console.log(log)
console.log('=== ERRORS ===', errors.slice(0, 8))
console.log('=== mode ===', await page.evaluate(() => window.__hizStats?.mode))
await browser.close()
