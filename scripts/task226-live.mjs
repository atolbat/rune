#!/usr/bin/env bun
/**
 * scripts/task226-live.mjs — the LIVE gate for Task 226 (THE PIXEL
 * LADDER + THE PATIENT WITNESS) on the deployed Pages site:
 *   · the source checks — the deployed forest carries the round (the
 *     rung table, the governor, the verdict-stands re-boot, the
 *     EMA-scaled stall budget, STALLED ≠ FAIL, the 12-yaw sparse
 *     sweep, the res chip, the v=226 bust, the gallery card);
 *   · the deployed behavior — the sparse default boot (two trees, the 5
 *     sparse laws, THE RES CHIP on the deployed HUD), THE SLIDER
 *     round-trip on production (a real replant + the re-run validation
 *     + THE RUNG KEPT across the replant), one-present, zero page
 *     errors. (The governor itself needs a real adapter — the phone is
 *     its witness; the container proves the rung machinery end to end.)
 */
import { chromium } from 'playwright'

const LIVE = 'https://atolbat.github.io/rune/demo/forest/'
let failures = 0
function check(name, ok, detail = '') {
  console.log(`[226-live] ${name}: ${ok ? 'PASS' : 'FAIL'}${detail ? ` · ${detail}` : ''}`)
  if (!ok) failures++
}

// ── the source checks (the deployed bytes) ────────────────────────────────
const index = await (await fetch(LIVE)).text()
const main = await (await fetch(LIVE + 'main.js?v=226')).text()
const gallery = await (await fetch('https://atolbat.github.io/rune/demo/')).text()
check('source: the deployed forest page mounts the current cache-bust (v=226)',
  index.includes('main.js?v=226'), '')
check('source: THE PIXEL LADDER ships in the deployed bytes (the rung table + the budgets)',
  main.includes('THE PIXEL LADDER') && main.includes('const LADDER')
    && main.includes('LADDER_HIGH_MS') && main.includes('LADDER_LOW_MS')
    && main.includes('dprCap') && main.includes('msaa'), '')
check('source: THE PIXEL GOVERNOR ships (the lane discipline + the tier-owned stop)',
  main.includes('THE PIXEL GOVERNOR') && main.includes('govCost') && main.includes('govStop')
    && main.includes('ladderBusy || replantBusy || paused || validationActive'), '')
check('source: THE VERDICT-STANDS RE-BOOT ships (the laws count trees, not pixels; the rollback)',
  main.includes('KEEP_VERDICT') && main.includes('the laws count trees, not pixels')
    && main.includes('rolling back to rung'), '')
check('source: THE PATIENT WITNESS ships (the EMA-scaled budget, STALLED ≠ FAIL, the re-arm)',
  main.includes('THE STALL BUDGET RIDES THE LOAD') && main.includes('frameMsEma * 16')
    && main.includes('e.stall = true') && main.includes('A STALL IS NOT A LAW DEATH')
    && main.includes('re-arming'), '')
check('source: the 12-yaw sparse sweep + THE RES CHIP ship on the deployed bytes',
  main.includes('SPARSE ? 12 : 48') && main.includes('stats.res'), '')
check('source: the gallery card carries the round',
  gallery.includes('forest') && gallery.includes('Task 226') && gallery.includes('Tasks 223–226') && gallery.includes('216–226'), '')

// ── the deployed behavior ─────────────────────────────────────────────────
// (chunked legs — `--leg=a` (source + WG) / `--leg=b` (GL); the default
// runs both. Each leg fetches the 7 MB asset from Pages and the WG leg
// waits out the re-run's verdict — the honest container budget.)
const LEG = process.argv[2] ?? 'all'
const LEG_A = LEG === 'a' || LEG === '--leg=a'
const LEG_B = LEG === 'b' || LEG === '--leg=b'
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})
for (const [mode, awaitWalk] of LEG_B ? [['webgl2', false]] : LEG_A ? [['webgpu', true]] : [['webgpu', true], ['webgl2', false]]) {
  const page = await browser.newPage({ viewport: { width: 480, height: 320 } })
  const errors = []
  page.on('pageerror', e => errors.push(e.message.slice(0, 150)))
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 150)) })
  await page.goto(`${LIVE}?mode=${mode}`, { waitUntil: 'networkidle', timeout: 150_000 })
  // THE RES CHIP on the deployed HUD: the rung's own shape rides line one
  const resChip = await page.waitForFunction(
    () => typeof window.__forest?.res === 'string' && window.__forest.res !== '',
    null, { timeout: 60_000, polling: 250 },
  ).then(() => page.evaluate(() => window.__forest.res)).catch(() => '')
  check(`[${mode}] THE RES CHIP rides the deployed HUD (the rung's own shape)`,
    /^\d+×\d+@\dx$/.test(resChip), resChip === '' ? 'the chip never landed' : resChip)
  // THE SPARSE DEFAULT on production: two trees, the 5 sparse laws (the
  // GL leg rides the container's readback wall — the walk is proven
  // RUNNING by the live counters landing mid-sweep; the WG leg carries
  // the full verdict)
  if (awaitWalk) {
    const res = await page.waitForFunction(
      () => { const v = window.__forest?.validation; return v !== null && v.checks >= 5 },
      null, { timeout: 480_000, polling: 500 },
    ).then(() => page.evaluate(() => window.__forestGate))
      .catch(() => null)
    const total = await page.evaluate(() => window.__forest?.total ?? -1)
    check(`[${mode}] THE DEPLOYED SPARSE DEFAULT — a couple of trees, the 5 sparse laws`,
      res !== null && res.pass === true && res.checks === 5 && total === 2,
      res === null ? 'the gate never resolved' : `${res.pass ? 'PASS' : 'FAIL'} · ${res.checks} laws · total ${total}`)
  } else {
    const s = await page.waitForFunction(
      () => window.__forest?.drawn > 0 && window.__forest?.frame > 20,
      null, { timeout: 480_000, polling: 500 },
    ).then(() => page.evaluate(() => ({ t: window.__forest.total, d: window.__forest.drawn, f: window.__forest.frame })))
      .catch(() => null)
    check(`[${mode}] THE DEPLOYED SPARSE WALK is running (the live counters land mid-sweep — the GL readback wall; the verdict is the WG leg's proof)`,
      s !== null && s.t === 2 && s.d > 0 && s.d <= s.t && s.f > 20,
      s === null ? 'the drawn counter never landed' : `total ${s.t} · drawn ${s.d} · frame ${s.f}`)
  }
  // THE SLIDER on production: a real replant (the WG leg waits out the
  // re-run's verdict; the GL leg proves the re-run by the reset + the
  // fresh progress line — the readback wall)
  await page.evaluate(() => {
    const slider = document.querySelector('#fd-slider')
    slider.value = '60'
    slider.dispatchEvent(new Event('change', { bubbles: true }))
  })
  const replanted = await page.waitForFunction(
    verdict => window.__forest.total === 60 && window.__forest.drawn > 0
      && (verdict
        ? (window.__forest.validation !== null && window.__forest.validation.checks >= 5)
        : (window.__forest.validation === null && window.__forest.progress !== '')),
    awaitWalk, { timeout: 480_000, polling: 500 },
  ).then(() => true).catch(() => false)
  const after = await page.evaluate(() => ({
    total: window.__forest.total, drawn: window.__forest.drawn,
    validation: window.__forest.validation, res: window.__forest.res,
    dock: document.querySelector('#fd-list')?.textContent ?? '',
    f: window.__forest.frame, p: window.__forest.presents,
  }))
  check(`[${mode}] THE DEPLOYED SLIDER replants the production forest`,
    replanted && after.total === 60 && after.drawn > 0
      && (awaitWalk ? (after.validation !== null && after.validation.pass === true) : (after.validation === null || after.validation.pass === true)),
    `total ${after.total} · drawn ${after.drawn} · validation ${after.validation ? `${after.validation.pass === null ? 'STALLED' : after.validation.pass ? 'PASS' : 'FAIL'}/${after.validation.checks}` : '—'}${awaitWalk ? '' : ' (mid-walk)'}`)
  check(`[${mode}] the replant KEEPS THE RUNG on production (the world re-plants, the pixels do not move)`,
    after.res === resChip, `boot ${resChip} → after ${after.res}`)
  check(`[${mode}] the replant line rides the deployed SCREEN LOG`,
    after.dock.includes('replant'), '')
  await page.waitForTimeout(4000)
  const s = await page.evaluate(() => ({ f: window.__forest.frame, p: window.__forest.presents }))
  check(`[${mode}] ONE-PRESENT holds on the deployed page (presents within ±1 of frame)`,
    s.p >= s.f && s.p <= s.f + 1 && s.f > (awaitWalk ? 100 : 10), `presents ${s.p} vs frame ${s.f}`)
  check(`[${mode}] zero page errors on the deployed page`, errors.length === 0, errors.slice(0, 2).join(' | '))
  await page.close()
}
await browser.close()
console.log(`[226-live] ${failures === 0 ? 'ALL PASS' : `FAILURES: ${failures}`} — the ladder rides the load, the witness rides the patience, the rung survives the replant`)
process.exit(failures === 0 ? 0 : 1)
