/**
 * scripts/task221-live.mjs — the LIVE gate for Task 221 (THE TILER LAWS)
 * on the deployed Pages site — the round's own deployed-artifact evidence:
 *   · the source checks — the deployed dist carries THE PARITY LAW (the
 *     multisampled depth twin rides the target's own depthFormat), THE
 *     CREATION-TIME RESOLVE PROBE (the loud refusal string), and the
 *     deployed law page carries THE RE-OPEN LAW;
 *   · THE LAW PAGE on the deployed bytes — the resolve law (the 4x
 *     boundary blends) + THE RE-OPEN LAW (pass 2's load sees pass 1's
 *     stored samples) on both backends, driven against the deployed
 *     dist bundle in a headless browser;
 *   · the walker's 14 autopilot laws on the deployed page were just
 *     proven by the 219-live run against this same deploy (b9e0b68) —
 *     this gate does not repeat them.
 */
import { chromium } from 'playwright'

const LIVE = 'https://atolbat.github.io/rune'
let failures = 0
function check(name, ok, detail = '') {
  console.log(`[221-live] ${name}: ${ok ? 'PASS' : 'FAIL'}${detail ? ` · ${detail}` : ''}`)
  if (!ok) failures++
}

// ── the source checks (the deployed bytes) ────────────────────────────────
const dist = await (await fetch(`${LIVE}/dist/rune.esm.js?v=221`)).text()
const scratch = await (await fetch(`${LIVE}/scripts/scratch-220-msaa.html`)).text()
check('source: THE DEPTH-FORMAT PARITY LAW ships in the deployed dist (the twin rides the target depthFormat)',
  /renderbufferStorageMultisample\(gl\.RENDERBUFFER, targetSamples, depthFormat\w*, width, height\)/.test(dist)
    && !/renderbufferStorageMultisample\(gl\.RENDERBUFFER, targetSamples, gl\.DEPTH_COMPONENT24, width, height\)/.test(dist),
  '')
check('source: THE CREATION-TIME RESOLVE PROBE ships in the deployed dist (the loud refusal)',
  dist.includes('refused the multisample resolve blit'), '')
check('source: the re-open law ships on the deployed law page',
  scratch.includes('THE RE-OPEN LAW') && scratch.includes('__msaaReport'), '')

// ── THE LAW PAGE on the deployed bytes ────────────────────────────────────
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({ viewport: { width: 720, height: 480 } })
const errors = []
page.on('pageerror', e => errors.push(`pageerror: ${e.message.slice(0, 160)}`))
page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`) })
await page.goto(`${LIVE}/scripts/scratch-220-msaa.html`, { waitUntil: 'networkidle', timeout: 120_000 })
const report = await page.waitForFunction(() => window.__msaaReport !== undefined, null, { timeout: 180_000 })
  .then(() => page.evaluate(() => window.__msaaReport))
  .catch(() => null)
if (report === null) {
  check('the deployed law page produced a report', false, errors.join(' | '))
} else {
  for (const backend of ['webgpu', 'webgl2']) {
    const leg = report.legs?.[backend]
    const ro = report.reopen?.[backend]
    check(`[${backend}] the deployed resolve law — the 4x boundary blends, the 1x cuts`,
      leg?.error === undefined && leg.x4.blended > leg.x1.blended && leg.x4.blended >= 8,
      leg?.error ?? `1x=${leg.x1.blended} · 4x=${leg.x4.blended}`)
    check(`[${backend}] THE DEPLOYED RE-OPEN LAW — pass 2's load sees pass 1's stored samples (1x and 4x)`,
      ro?.error === undefined && ro.x1.bLeft > 0 && ro.x1.aRight > 0 && ro.x1.clearRight === 0
        && ro.x4.bLeft > 0 && ro.x4.aRight > 0 && ro.x4.clearRight === 0,
      ro?.error ?? `4x: B-left=${ro.x4.bLeft} · A-right=${ro.x4.aRight} · clear-right=${ro.x4.clearRight}`)
  }
  check('the deployed doors (WG refuses the depth combo, GL rides it)',
    report.doors?.webgpu?.refused !== false && report.doors?.webgl2?.refused === false, '')
}
check('zero page errors on the deployed law page', errors.length === 0, errors.slice(0, 3).join(' | '))
await page.close()
await browser.close()
console.log(`[221-live] ${failures === 0 ? 'ALL PASS' : `FAILURES: ${failures}`} — the tiler laws hold on the deployed artifact`)
process.exit(failures === 0 ? 0 : 1)
