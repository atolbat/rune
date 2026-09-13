// task196-live — the LIVE probe of the deployed occlusion demo: the page's
// ?probe=1 validation (pixel parity, the invariant, the culling effect)
// against the real Pages bundle. Exit 0 — the live tier is verified.
import { chromium } from 'playwright'

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})
let failed = false
try {
  const page = await browser.newPage({ viewport: { width: 500, height: 420 } })
  const pageErrors = []
  page.on('pageerror', e => pageErrors.push(String(e)))
  await page.goto('https://atolbat.github.io/rune/demo/occlusion/?probe=1', { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.waitForFunction(() => window.__hizGate !== undefined, null, { timeout: 240_000 })
  const gate = await page.evaluate(() => window.__hizGate)
  console.log(`[task196-live] scene: ${gate.stats.total} instances, Hi-Z ${gate.stats.hizW}x${gate.stats.hizH} · ${gate.stats.levels} mips, mode ${gate.stats.mode}`)
  console.log(`[task196-live] GPU errors: ${gate.errors}, page errors: ${pageErrors.length}`)
  for (const cam of gate.cameras) {
    console.log(`  camera (yaw ${cam.yaw}): parity ${cam.parity} · drawn ON ${cam.drawnOn} / OFF ${cam.drawnOff} · occluded ${cam.occludedOn}`)
    if (cam.parity !== 'IDENTICAL' || !cam.ok) failed = true
  }
  console.log(`[task196-live] verdict: ${gate.pass ? 'PASS' : 'FAIL'}`)
  if (!gate.pass || pageErrors.length > 0) failed = true
} catch (error) {
  console.error(`[task196-live] probe crashed: ${error instanceof Error ? error.message : String(error)}`)
  failed = true
} finally {
  await browser.close()
}
console.log(failed ? '\nTASK 196 LIVE GATE: FAIL' : '\nTASK 196 LIVE GATE: PASS')
process.exit(failed ? 1 : 0)
