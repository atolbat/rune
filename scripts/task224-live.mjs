#!/usr/bin/env bun
/**
 * scripts/task224-live.mjs — the LIVE gate for Task 224 (THE ONE-PRESENT
 * LAW + THE FIELD LOG) on the deployed Pages site:
 *   · the source checks — the deployed forest carries the round's own laws
 *     (exactly one present() call site, the present pass's in-frame
 *     submit, the present ledger, the field log's tail, the v=226 bust);
 *   · the deployed behavior — both backends: the 7-law autopilot, the
 *     one-present law LIVE (presents within ±1 of frame), the field log
 *     riding the HUD, zero page errors.
 */
import { chromium } from 'playwright'

const LIVE = 'https://atolbat.github.io/rune/demo/forest/'
let failures = 0
function check(name, ok, detail = '') {
  console.log(`[224-live] ${name}: ${ok ? 'PASS' : 'FAIL'}${detail ? ` · ${detail}` : ''}`)
  if (!ok) failures++
}

// ── the source checks (the deployed bytes) ────────────────────────────────
const index = await (await fetch(LIVE)).text()
const main = await (await fetch(LIVE + 'main.js?v=226')).text()
const gallery = await (await fetch('https://atolbat.github.io/rune/demo/')).text()
check('source: the deployed forest page mounts the current cache-bust (v=226)',
  index.includes('main.js?v=226'), '')
const callSites = (main.match(/^\s*present\(\)\s*$/gm) ?? []).length
check('source: THE ONE-PRESENT LAW — exactly ONE present() call site in the deployed bytes',
  callSites === 1 && main.includes('THE ONE-PRESENT LAW (Task 224'),
  `${callSites} statement-level call sites`)
check('source: the present pass submits INSIDE the frame (the deployed boundary)',
  /execute: \(\) => \{\s*\n\s*present\(\)\s*\n\s*device\.submit\(\)\s*\n\s*\},/.test(main),
  '')
check("source: THE PRESENT LEDGER ships (presents === frame — the field's own witness)",
  main.includes('stats.presents++') && main.includes('presents: 0'), '')
check('source: THE FIELD LOG ships (the on-screen tail — boot, verdicts, errors)',
  main.includes('function fieldNote') && main.includes('tail: fieldLog') && main.includes("fieldNote('ERR', message)"),
  '')
check('source: the gallery card carries the round',
  gallery.includes('forest') && gallery.includes('Task 224') && gallery.includes('216–226'), '')

// ── the deployed behavior (both backends) ─────────────────────────────────
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})
const LEG = process.argv[2] ?? 'all'
for (const [mode, trees, awaitWalk] of LEG === 'b' ? [['webgl2', 100, false]] : LEG === 'a' ? [['webgpu', 150, true]] : [['webgpu', 150, true], ['webgl2', 100, false]]) {
  const page = await browser.newPage({ viewport: { width: 480, height: 320 } })
  const errors = []
  page.on('pageerror', e => errors.push(e.message.slice(0, 150)))
  await page.goto(`${LIVE}?trees=${trees}&mode=${mode}`, { waitUntil: 'networkidle', timeout: 150_000 })
  if (awaitWalk) {
    const res = await page.waitForFunction(
      () => { const v = window.__forest?.validation; return v !== null && v.checks >= 7 },
      null, { timeout: 420_000, polling: 500 },
    ).then(() => page.evaluate(() => window.__forestGate))
      .catch(() => null)
    check(`[${mode}] THE DEPLOYED VALIDATION — the 7-law autopilot walked the deployed forest`,
      res !== null && res.pass === true && res.checks === 7,
      res === null ? 'the gate never resolved' : `${res.pass ? 'PASS' : 'FAIL'} · ${res.checks} laws`)
  } else {
    // THE CONTAINER'S GL READBACK WALL (Task 225's re-pin): the GL leg
    // proves the walk is RUNNING on the deployed bytes (the live counters
    // land mid-sweep); the WG leg carries the full walk.
    const landed = await page.waitForFunction(
      () => window.__forest?.drawn > 0 && window.__forest.frame > 20,
      null, { timeout: 420_000, polling: 500 },
    ).then(() => true).catch(() => false)
    check(`[${mode}] THE DEPLOYED WALK is running (the live counters land mid-sweep — the GL readback wall; the full walk is the WG leg's proof)`,
      landed, 'the drawn counter never landed')
  }
  await page.waitForTimeout(4000)
  const s = await page.evaluate(() => ({
    f: window.__forest.frame, p: window.__forest.presents, tail: window.__forest.tail.slice(),
  }))
  check(`[${mode}] THE ONE-PRESENT LAW holds on the deployed page (presents within ±1 of frame)`,
    s.p >= s.f && s.p <= s.f + 1, `presents ${s.p} vs frame ${s.f}`)
  check(`[${mode}] THE FIELD LOG rides the deployed HUD`,
    s.tail.length > 0 && s.tail.some(l => l.startsWith('boot '))
      && (!awaitWalk || s.tail.some(l => l.startsWith('valid '))),
    s.tail.slice(0, 2).join(' | '))
  check(`[${mode}] zero page errors on the deployed page`, errors.length === 0, errors.slice(0, 2).join(' | '))
  await page.close()
}
await browser.close()
console.log(`[224-live] ${failures === 0 ? 'ALL PASS' : `FAILURES: ${failures}`} — one frame, one blit, one submit on the deployed artifact`)
process.exit(failures === 0 ? 0 : 1)
