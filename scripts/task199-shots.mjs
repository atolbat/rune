// task199-shots — the visual gate: screenshots of the occlusion demo on
// BOTH backends (the WG snapshot leg + the GL live leg), two poses each —
// whole boxes (the frontFace settlement), clean building bases (the z-fight
// fix), the city-occludes toggle (the stats shift).
import { chromium } from 'playwright'

const port = Number(process.env.PORT ?? 8911)
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({ viewport: { width: 960, height: 720 } })

async function shot(url, path, settle = 1500) {
  await page.goto(url, { waitUntil: 'networkidle' })
  // SwiftShader's WG validation is slow — wait for the gate's own verdict
  await page.waitForFunction(() => window.__hizStats && window.__hizStats.validation !== null && window.__hizStats.drawn > 0, null, { timeout: 90_000 }).catch(() => {})
  await page.waitForTimeout(settle)
  await page.screenshot({ path })
  const stats = await page.evaluate(() => window.__hizStats ? { mode: window.__hizStats.mode, drawn: window.__hizStats.drawn, occluded: window.__hizStats.occlusionCulled, validation: window.__hizStats.validation?.pass } : null)
  console.log(`${path}: mode=${stats?.mode} drawn=${stats?.drawn} occluded=${stats?.occluded} validation=${stats?.validation}`)
}

await shot(`http://localhost:${port}/demo/occlusion/`, '/home/z/my-project/rune/scripts/task199-wg.png')
await shot(`http://localhost:${port}/demo/occlusion/?mode=webgl2`, '/home/z/my-project/rune/scripts/task199-gl.png')

// the city-occludes experiment: click the toggle on the GL page (the fast
// leg), watch the stats shift
await page.goto(`http://localhost:${port}/demo/occlusion/?mode=webgl2`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__hizStats && window.__hizStats.validation !== null && window.__hizStats.drawn > 0, null, { timeout: 60_000 }).catch(() => {})
await page.waitForTimeout(1200)
const before = await page.evaluate(() => ({ drawn: window.__hizStats.drawn, occluded: window.__hizStats.occlusionCulled }))
await page.getByRole('button', { name: /City occludes/ }).click()
await page.waitForTimeout(2500)
const after = await page.evaluate(() => ({ drawn: window.__hizStats.drawn, occluded: window.__hizStats.occlusionCulled, occluders: window.__hizStats.occluders }))
console.log(`city toggle: drawn ${before.drawn} -> ${after.drawn} · occluded ${before.occluded} -> ${after.occluded} · occluders ${after.occluders}`)
await page.screenshot({ path: '/home/z/my-project/rune/scripts/task199-city.png' })

await browser.close()
console.log('done')
