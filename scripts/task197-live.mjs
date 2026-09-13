// task197-live — the LIVE probe of the deployed occlusion demo's GL tier:
// ?probe=1&mode=webgl2 on Pages — the WG anchor leg + the GL verdict + the
// cross-tier bounded parity, on the production bundle.
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
  await page.goto('https://atolbat.github.io/rune/demo/occlusion/?probe=1&mode=webgl2', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  const gate = await page.waitForFunction(() => window.__hizGate !== undefined, null, { timeout: 240_000 })
  const verdict = await page.evaluate(() => window.__hizGate)
  if (verdict.bootFail !== undefined) {
    console.log(`[task197-live] BOOT FAILED:\n${String(verdict.bootFail).slice(0, 800)}`)
    failed = true
  } else {
    console.log(`[task197-live] tier ${verdict.tier} · errors ${verdict.errors} · cross-tier cameras ${verdict.crossChecked}`)
    for (const cam of verdict.cameras) {
      const cs = cam.crossStats
      console.log(`  yaw ${cam.yaw.toFixed(2)}: parity ${cam.parity} · cross-tier ${cam.crossParity}${cs ? ` ${cs.pct}% px, dmax ${cs.maxD}, drawn d${cs.drawnDelta}` : ''} · drawn ON ${cam.drawnOn} / OFF ${cam.drawnOff} · occluded ${cam.occludedOn}`)
      if (cam.parity !== 'IDENTICAL' || cam.crossParity === 'DIVERGED' || !cam.ok) failed = true
    }
    console.log(`[task197-live] verdict: ${verdict.pass ? 'PASS' : 'FAIL'}`)
    if (!verdict.pass) failed = true
  }
  if (pageErrors.length > 0) { console.log(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`); failed = true }
} catch (error) {
  console.error(`[task197-live] crashed: ${error instanceof Error ? error.message : String(error)}`)
  failed = true
} finally {
  await browser.close()
}
console.log(failed ? '\nTASK 197 LIVE GATE: FAIL' : '\nTASK 197 LIVE GATE: PASS')
process.exit(failed ? 1 : 0)
