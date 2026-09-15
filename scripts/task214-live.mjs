/**
 * scripts/task214-live.mjs — the LIVE gate: the deployed Pages site carries
 * Task 214 (THE TWO-DISPATCH DOWNSAMPLER — the Granite/FidelityFX SPD
 * harvest, research A4 / bevy #22286's landed shape). Checks:
 *   (1) the served sources carry the ?v=214 cache-busts and the Task-214
 *       surface (main.js's spdParity gate wiring + the single-pass comment;
 *       tier.js's spdParity channel + the dist bump);
 *   (2) the boot validation PASSES on the live SwiftShader stack (the
 *       page's own validation now INCLUDES the SPD parity verdict — the
 *       main.js gate rides the boot);
 *   (3) THE PARITY GATE, LIVE, on the WG leg: pause (the readback
 *       discipline), spdParity() — both spellings dispatched over the
 *       live frame's own z tile, every storage word compared — PASS =
 *       zero diffs, the dispatch shape 2 vs 10, and the loop continues
 *       cleanly after the gate's readbacks (they never wedge the
 *       renderer);
 *   (4) the GL leg: spdParity() → null by contract (the FBO pyramid is
 *       the backend's own mechanism, untouched this round — the no-op
 *       must be a true no-op), the loop alive, zero errors.
 *
 * The standing laws (209/211/212/213) were re-proven locally on this
 * round's code; this gate owns the round's own proof on production.
 */
import { chromium } from 'playwright'

const BASE = 'https://atolbat.github.io/rune/demo/occlusion/'
const LEG_ARG = process.argv[2] === 'webgl2' ? ['webgl2'] : process.argv[2] === 'webgpu' ? ['webgpu'] : ['webgpu', 'webgl2']
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})

let failures = 0
function check(name, ok, detail = '') {
  console.log(`[live] ${name}: ${ok ? 'PASS' : 'FAIL'}${detail ? ` · ${detail}` : ''}`)
  if (!ok) failures++
}

async function runLeg(mode) {
  console.log(`[live] leg ${mode}: goto…`)
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
  const legErrors = []
  page.on('pageerror', (e) => legErrors.push(`pageerror: ${e.message.slice(0, 160)}`))
  page.on('console', (m) => { if (m.type() === 'error') legErrors.push(`console: ${m.text().slice(0, 160)}`) })
  await page.goto(`${BASE}${mode === 'webgl2' ? '?mode=webgl2' : ''}`, { waitUntil: 'networkidle', timeout: 60_000 })
  const stats = await page.waitForFunction(
    () => (window.__hizStats && window.__hizStats.validation !== null && window.__hizStats.drawn > 0 ? window.__hizStats : undefined),
    null,
    { timeout: 420_000 },
  ).then(h => h.jsonValue())
  // the page's own boot validation now carries the SPD parity verdict in
  // its allOk (main.js's Task-214 gate rides the boot) — the static path
  // must still PASS on both backends
  check(`[${mode}] the boot validation PASS (the static path + the page's own SPD gate)`,
    stats?.validation?.pass === true, `drawn ${stats?.drawn}/${stats?.total} · mode ${stats?.mode}`)

  // warm the pyramid: a couple of feedback frames over the live city (the
  // fixed-point law — the carry converges in one; two to be sure)
  await page.waitForTimeout(900)

  // THE GATE — pause (the readback discipline), dispatch both spellings
  // over the live frame's own z tile, compare every storage word; the
  // resume rides the finally (the page must keep rendering after the
  // gate — readbacks never wedge the renderer)
  const parity = await page.evaluate(async () => {
    window.__hizCtl.pause()
    try {
      return await window.__hizTier.spdParity()
    } finally {
      window.__hizCtl.resume()
    }
  })
  const before = await page.evaluate(() => window.__hizStats.drawn)
  if (mode === 'webgpu') {
    check(`[${mode}] THE SPD PARITY (both spellings, every storage word)`,
      parity !== null && parity.error === undefined && parity.pass === true,
      parity === null ? 'null parity' : parity.error !== undefined ? `crashed: ${parity.error}` : `${parity.diffs} diffs of ${parity.words} words${parity.diffs > 0 ? ` (first at word ${parity.first})` : ''}`)
    if (parity !== null && parity.error === undefined) {
      check(`[${mode}] the dispatch shape`, parity.spdDispatches === 2 && parity.legacyDispatches === 10,
        `spd ${parity.spdDispatches} dispatches vs the legacy chain's ${parity.legacyDispatches}`)
      check(`[${mode}] the storage shape`, parity.words === 172902, `${parity.words} words`)
    }
  } else {
    check(`[${mode}] spdParity null contract (the FBO pyramid is the GL backend's own reduce)`,
      parity === null, parity === null ? 'a true no-op' : JSON.stringify(parity).slice(0, 160))
  }

  // the loop continues cleanly after the gate's readbacks (the orbiting
  // camera moves the per-frame drawn count — any change proves frames are
  // still executing)
  await page.waitForFunction(before => window.__hizStats.drawn !== before, before, { timeout: 90_000 })
    .then(() => check(`[${mode}] the loop alive after the gate`, true))
    .catch(() => check(`[${mode}] the loop alive after the gate`, false))
  await page.waitForTimeout(400)
  check(`[${mode}] zero errors across the whole visit`, legErrors.length === 0, legErrors.slice(0, 3).join(' | '))
  await page.close()
}

try {
  // ── 1. the served sources carry the Task-214 surface ────────────────────
  const mainSrc = await (await fetch(`${BASE}main.js`)).text()
  const tierSrc = await (await fetch(`${BASE}tier.js`)).text()
  const htmlSrc = await (await fetch(BASE)).text()
  check('served main.js carries the SPD gate wiring + the ?v=214 marks',
    mainSrc.includes('THE SINGLE-PASS DOWNSAMPLER gate') && mainSrc.includes('t.spdParity') && mainSrc.includes('tier.js?v=214'))
  check('served tier.js carries the spdParity channel + the dist bump',
    tierSrc.includes('spdParity: () => spdParity()') && tierSrc.includes('rune.esm.js?v=214'))
  check('served index.html carries the ?v=214 marks',
    htmlSrc.includes('main.js?v=214') && htmlSrc.includes('demo-shell.js?v=214'))

  // ── 2. both legs, end to end ────────────────────────────────────────────
  for (const leg of LEG_ARG) await runLeg(leg)
} catch (e) {
  failures++
  console.error(`[live] CRASH: ${e instanceof Error ? e.message : String(e)}`)
} finally {
  await browser.close()
}

console.log(`\n[live] ${failures === 0 ? 'VERDICT: PASS — the two-dispatch downsampler is live: both spellings dispatched on production, every storage word bit-identical' : `VERDICT: FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
