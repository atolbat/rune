import { chromium } from 'playwright'
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 360, height: 764 }, deviceScaleFactor: 3 })
await page.goto('https://atolbat.github.io/rune/demo/occlusion/?mode=webgl2', { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__hizStats && window.__hizStats.validation !== null, null, { timeout: 90_000 }).catch(() => {})
await page.waitForTimeout(2500)
const s = await page.evaluate(() => {
  const c = document.querySelector('#hiz-canvas')
  return { mode: window.__hizStats?.mode, drawn: window.__hizStats?.drawn, occluded: window.__hizStats?.occlusionCulled, pass: window.__hizStats?.validation?.pass, dataLen: c ? c.toDataURL('image/png').length : -1, buf: c ? `${c.width}x${c.height}` : 'n/a' }
})
await page.screenshot({ path: '/tmp/prod-gl.png' })
console.log('prod GL:', JSON.stringify(s))
await browser.close()
