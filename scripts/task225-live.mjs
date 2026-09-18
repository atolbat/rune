#!/usr/bin/env bun
/**
 * scripts/task225-live.mjs — the LIVE gate for Task 225 (THE SCREEN LOG +
 * THE LIVE COUNTERS + THE GROWING FOREST + THE SLIDER) on the deployed
 * Pages site:
 *   · the source checks — the deployed forest carries the round (the dock,
 *     the console tee, the live counters, the stall witness, the growing
 *     forest, the slider, the v=226 bust, the gallery card);
 *   · the deployed behavior — the sparse default boot (two trees, the 5
 *     sparse laws) both backends, THE SLIDER round-trip on production (a
 *     real replant + the re-run validation + the replant line on the
 *     screen dock), one-present, zero page errors.
 */
import { chromium } from 'playwright'

const LIVE = 'https://atolbat.github.io/rune/demo/forest/'
let failures = 0
function check(name, ok, detail = '') {
  console.log(`[225-live] ${name}: ${ok ? 'PASS' : 'FAIL'}${detail ? ` · ${detail}` : ''}`)
  if (!ok) failures++
}

// ── the source checks (the deployed bytes) ────────────────────────────────
const index = await (await fetch(LIVE)).text()
const main = await (await fetch(LIVE + 'main.js?v=226')).text()
const world = await (await fetch(LIVE + 'world.js?v=225')).text()
const gallery = await (await fetch('https://atolbat.github.io/rune/demo/')).text()
check('source: the deployed forest page mounts the current cache-bust (v=226)',
  index.includes('main.js?v=226'), '')
check('source: THE SCREEN LOG ships in the deployed bytes (the dock + the console tee)',
  main.includes('forest-dock') && main.includes('function slog') && main.includes('shellConsoleError')
    && index.includes('.forest-dock'),
  '')
check('source: THE LIVE COUNTERS + THE STALL WITNESS ship (the -1 window is dead)',
  main.includes('THE LIVE COUNTERS') && main.includes('function withStall') && main.includes('stallWarn'), '')
check('source: THE GROWING FOREST ships (nearest-N, no coarse thinning, maxTrees)',
  world.includes('THE GROWING FOREST') && world.includes('maxTrees') && !world.includes('const coarse'), '')
check('source: THE SLIDER ships (the default couple, the replant on release)',
  main.includes('function replant') && main.includes('Начни с парочки') && /\|\| 2\b/.test(main), '')
check('source: the gallery card carries the round',
  gallery.includes('forest') && gallery.includes('Tasks 223–226') && gallery.includes('216–226'), '')

// ── the deployed behavior ─────────────────────────────────────────────────
// (chunked legs — `--leg=a` (source + WG) / `--leg=b` (GL); the default
// runs both. The deployed legs each fetch the 7 MB asset from Pages, and
// the WG leg waits out the re-run's verdict — the two legs together can
// exceed a single 600 s shell call.)
const LEG = process.argv[2] ?? 'all'
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})
for (const [mode, awaitWalk] of LEG === 'b' ? [['webgl2', false]] : LEG === 'a' ? [['webgpu', true]] : [['webgpu', true], ['webgl2', false]]) {
  const page = await browser.newPage({ viewport: { width: 480, height: 320 } })
  const errors = []
  page.on('pageerror', e => errors.push(e.message.slice(0, 150)))
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 150)) })
  await page.goto(`${LIVE}?mode=${mode}`, { waitUntil: 'networkidle', timeout: 150_000 })
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
    validation: window.__forest.validation, dock: document.querySelector('#fd-list')?.textContent ?? '',
    f: window.__forest.frame, p: window.__forest.presents,
  }))
  check(`[${mode}] THE DEPLOYED SLIDER replants the production forest`,
    replanted && after.total === 60 && after.drawn > 0
      && (awaitWalk ? (after.validation !== null && after.validation.pass === true) : (after.validation === null || after.validation.pass === true)),
    `total ${after.total} · drawn ${after.drawn} · validation ${after.validation ? `${after.validation.pass ? 'PASS' : 'FAIL'}/${after.validation.checks}` : '—'}${awaitWalk ? '' : ' (mid-walk)'}`)
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
console.log(`[225-live] ${failures === 0 ? 'ALL PASS' : `FAILURES: ${failures}`} — the log rides the deployed screen, the forest grows on the slider`)
process.exit(failures === 0 ? 0 : 1)
