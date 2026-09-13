// task199-toggle-debug — verify the City-occludes toggle actually flips the
// policy: read aria-pressed, the stats, and the log line after the click.
import { chromium } from 'playwright'

const port = Number(process.env.PORT ?? 8911)
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
await page.goto(`http://localhost:${port}/demo/occlusion/?mode=webgl2`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__hizStats && window.__hizStats.validation !== null && window.__hizStats.drawn > 0, null, { timeout: 60_000 })

const read = () => page.evaluate(() => ({
  pressed: document.querySelectorAll('.hiz-controls button')[2]?.getAttribute('aria-pressed'),
  occluders: window.__hizStats.occluders,
  drawn: window.__hizStats.drawn,
  occluded: window.__hizStats.occlusionCulled,
}))
// pause the auto-orbit first (drag-free): stop the camera drift by pausing the loop via the shell
console.log('before:', JSON.stringify(await read()))
await page.getByRole('button', { name: /City occludes/ }).click()
await page.waitForTimeout(1200)
console.log('after click:', JSON.stringify(await read()))
const log = await page.evaluate(() => document.querySelector('#log-list')?.textContent?.slice(-400) ?? '')
console.log('log tail:', log.slice(-300))
await browser.close()
