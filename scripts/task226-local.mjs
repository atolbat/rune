#!/usr/bin/env bun
/**
 * scripts/task226-local.mjs — the LOCAL gate for Task 226 (THE PIXEL
 * LADDER + THE PATIENT WITNESS).
 *
 * The third field report: «Даже с двумя деревьями 100 мс на фрейм. Но не
 * мигает.» + the copied log — boot 720×1326@4x on a dpr-3 panel, the
 * replant to 74 trees, «the counts readback stalled — no landing in
 * 4000 ms» → «valid FAIL — 0/1 laws», frame gaps 674..1568 ms with
 * presents ≡ frames (the load class, not a present death).
 *
 *   · LEG 1 — THE SOURCE LAWS: the pixel ladder (the rung table, the
 *     budgets, the session's rung choice, ?res= pinning), the pixel
 *     governor (the settled descent, the jump, the one-rung ascent, the
 *     lane discipline — never mid-walk/mid-replant, the tier-owned
 *     stop), the ladder re-boot's own honesty (the verdict stands — the
 *     laws count trees, not pixels; the failed re-boot rolls back), the
 *     patient witness (the EMA-scaled budget, the stall tag, STALLED ≠
 *     FAIL, the re-arm), the sparse sweep's 12-step budget, the res chip
 *     on the HUD, the one-present law, the v=226 bust.
 *   · LEG 2 — THE BEHAVIOR (the container's honest slice): the sparse
 *     default boot (two trees, the 5 sparse laws) + the slider
 *     round-trip on WG (the standing regression), the GL light leg.
 *   · LEG 3 — THE RES-PIN LAW (the ladder's own, provable on the
 *     software legs): ?res=0 vs ?res=4 boots at DIFFERENT surface shapes
 *     (dpr 3, a small viewport — the caps bite, the res chip reads the
 *     rung), the pinned line rides the dock, and THE RUNG SURVIVES THE
 *     REPLANT (the slider re-boots the world — the rung must not move).
 *     The governor itself needs a real adapter (the phone is its
 *     witness); the container proves the rung machinery end to end.
 */
import { chromium } from 'playwright'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

const root = join(import.meta.dirname, '..')
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.gz': 'application/gzip', '.bin': 'application/octet-stream' }
let failures = 0
function check(name, ok, detail = '') {
  console.log(`[226] ${name}: ${ok ? 'PASS' : 'FAIL'}${detail ? ` · ${detail}` : ''}`)
  if (!ok) failures++
}

// ── LEG 1 — the source laws ───────────────────────────────────────────────
{
  console.log('[226] source leg: reading…')
  const main = await readFile(join(root, 'demo/forest/main.js'), 'utf8')
  const index = await readFile(join(root, 'demo/forest/index.html'), 'utf8')
  // THE PIXEL LADDER — the rung table + the two budgets + the session's
  // own choice (a dpr ≥ 2.5 panel boots two rungs down) + the ?res= pin
  check('source: THE PIXEL LADDER — the rung table + the budgets ship',
    main.includes('THE PIXEL LADDER') && main.includes('const LADDER')
      && main.includes('LADDER_HIGH_MS') && main.includes('LADDER_LOW_MS')
      && main.includes('dprCap') && main.includes('msaa'),
    '')
  check('source: the rung choice — the phone panel boots two rungs down, ?res= pins',
    main.includes('>= 2.5') && main.includes("PARAMS.get('res')") && main.includes('ladderPinned')
      && main.includes('ladderChosen') && main.includes('the governor stands down'),
    '')
  // THE PIXEL GOVERNOR — the settled descent, the jump, the ascent, the
  // lane discipline, the tier-owned stop
  check('source: THE PIXEL GOVERNOR — the EMA rides the rung (descent/ascent/hysteresis)',
    main.includes('THE PIXEL GOVERNOR') && main.includes('setInterval') && main.includes('govCost')
      && main.includes('ladderBusy || replantBusy || paused || validationActive')
      && main.includes('govStop') && main.includes('LADDER.length - 1'),
    '')
  // THE LADDER RE-BOOT's own honesty — the verdict stands, the failed
  // re-boot rolls back (a dead tier re-boots at the old rung)
  check('source: THE LADDER RE-BOOT — the verdict stands, the rollback lands',
    main.includes('KEEP_VERDICT') && main.includes('the laws count trees, not pixels')
      && main.includes('rolling back to rung') && main.includes('opts.ladderReboot'),
    '')
  // THE PATIENT WITNESS — the budget rides the load, a stall is tagged,
  // STALLED ≠ FAIL, the walk re-arms
  check('source: THE PATIENT WITNESS — the stall budget rides the load (16× the EMA)',
    main.includes('THE STALL BUDGET RIDES THE LOAD') && main.includes('frameMsEma * 16')
      && main.includes('STALL_MS, frameMsEma'),
    '')
  check('source: A STALL IS NOT A LAW DEATH — the tag, the STALLED verdict, the re-arm',
    main.includes('e.stall = true') && main.includes('A STALL IS NOT A LAW DEATH')
      && main.includes('re-arming') && main.includes('validationStalls')
      && main.includes('superseded() || stalled'),
    '')
  // the sparse sweep's own budget — a 2-law question no longer bills
  // minutes (48 steps → 12 on the real sparse legs)
  check("source: THE SPARSE SWEEP'S OWN BUDGET — twelve yaws, not forty-eight",
    main.includes('SPARSE ? 12 : 48'), '')
  // THE RES CHIP — the field reads the pixels it is paying for
  check("source: THE RES CHIP — the rung's shape rides the HUD line one",
    main.includes('stats.res') && main.includes("${stats.res !== '' ? stats.res : '…'}"),
    '')
  // the phone's own report lines ride the ladder's log (the field reads
  // every step the rung takes)
  check('source: the ladder steps ride the SCREEN LOG (steps down / climbs)',
    main.includes("'steps down'") && main.includes("'climbs'") && main.includes('the pixel ladder '),
    '')
  // THE ONE-PRESENT LAW still holds (Task 224's own — untouched)
  const callSites = (main.match(/^\s*present\(\)\s*$/gm) ?? []).length
  check('source: THE ONE-PRESENT LAW — still exactly ONE present() call site',
    callSites === 1, `${callSites} statement-level call sites`)
  check('source: the page mounts the current cache-bust (v=226)', index.includes('main.js?v=226'), '')
}

// ── the browser + the server (the container's honest slice) ───────────────
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})
function serve(port) {
  return Bun.serve({
    port,
    async fetch(request) {
      let pathname = decodeURIComponent(new URL(request.url).pathname)
      if (pathname.endsWith('/')) pathname += 'index.html'
      const file = Bun.file(join(root, pathname))
      if (!(await file.exists())) return new Response('not found', { status: 404 })
      const ext = pathname.slice(pathname.lastIndexOf('.'))
      return new Response(file, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
    },
  })
}

// ── LEG 2 — the behavior: the sparse default + the slider (the standing
// regression — the ladder must not move the laws) ─────────────────────────
async function sparseLeg(mode, port, replantTarget, waitForChecks) {
  console.log(`[226] sparse leg ${mode}: goto…`)
  const server = serve(port)
  const page = await browser.newPage({ viewport: { width: 480, height: 320 } })
  const errors = []
  page.on('pageerror', e => errors.push(`pageerror: ${e.message.slice(0, 160)}`))
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 160)) })
  await page.goto(`http://localhost:${port}/demo/forest/?mode=${mode}`, { waitUntil: 'networkidle', timeout: 150_000 })
  const gate = await page.waitForFunction(
    () => window.__forestGate !== undefined && typeof window.__forestGate.then === 'function',
    null, { timeout: 150_000, polling: 500 },
  ).then(() => page.evaluate(() => window.__forestGate))
  const res = await Promise.race([gate, new Promise(r => setTimeout(() => r({ err: 'GATE_TIMEOUT' }), 300_000))])
  const list = res && Array.isArray(res.list) ? res.list : []
  for (const c of list) check(`[${mode}:sparse] ${c.name}`, c.pass === true, c.detail ?? '')
  const total = await page.evaluate(() => window.__forest.total)
  check(`[${mode}:sparse] the default forest is a COUPLE (two trees on screen)`,
    total === 2, `total ${total}`)
  check(`[${mode}:sparse] the sparse autopilot walked (the 5 sparse laws)`,
    res && res.pass === true && res.checks === 5,
    res && res.err ? res.err : `${list.filter(c => c.pass).length}/${list.length} laws`)
  // THE RES CHIP rides the deployed-class HUD from the first boot (the
  // software legs run the top rung — the showcase shape, unchanged)
  const bootRes = await page.evaluate(() => window.__forest.res)
  check(`[${mode}:sparse] THE RES CHIP rides the HUD (the rung's own shape)`,
    /^\d+×\d+@\dx$/.test(bootRes), bootRes)
  // the slider round-trip (the standing law: a replant re-runs its own
  // validation at the new count; the rung must NOT move with the world)
  await page.evaluate(n => {
    const slider = document.querySelector('#fd-slider')
    slider.value = String(n)
    slider.dispatchEvent(new Event('change', { bubbles: true }))
  }, replantTarget)
  const wantVerdict = waitForChecks >= 5
  const replanted = await page.waitForFunction(
    ([n, verdict]) => window.__forest.total === n && window.__forest.drawn > 0
      && (verdict
        ? (window.__forest.validation !== null && window.__forest.validation.checks >= 5)
        : (window.__forest.validation === null && window.__forest.progress !== '')),
    [replantTarget, wantVerdict], { timeout: 480_000, polling: 500 },
  ).then(() => true).catch(() => false)
  const afterReplant = await page.evaluate(() => ({
    total: window.__forest.total, drawn: window.__forest.drawn,
    validation: window.__forest.validation, url: location.search,
    dock: document.querySelector('#fd-list')?.textContent ?? '',
    presents: window.__forest.presents, frame: window.__forest.frame,
    res: window.__forest.res,
  }))
  check(`[${mode}] THE SLIDER replants (${replantTarget} trees, the validation re-ran${wantVerdict ? ' to its verdict' : ' (the reset + the fresh progress line — the walk itself is the WG leg\'s proof'}, the counts live)`,
    replanted && afterReplant.total === replantTarget && afterReplant.drawn > 0
      && (wantVerdict ? (afterReplant.validation !== null && afterReplant.validation.pass === true) : (afterReplant.validation === null || afterReplant.validation.pass === true)),
    `total ${afterReplant.total} · drawn ${afterReplant.drawn} · validation ${afterReplant.validation ? `${afterReplant.validation.pass === null ? 'STALLED' : afterReplant.validation.pass ? 'PASS' : 'FAIL'}/${afterReplant.validation.checks}` : '—'}`)
  check(`[${mode}] the replant keeps the RUNG (the world re-plants, the pixels do not move)`,
    afterReplant.res === bootRes, `boot ${bootRes} → after ${afterReplant.res}`)
  check(`[${mode}] the replant rides the SCREEN LOG (the dock carries the line)`,
    afterReplant.dock.includes('replant'), '')
  await page.waitForTimeout(4000)
  const s = await page.evaluate(() => ({ f: window.__forest.frame, p: window.__forest.presents }))
  // the mid-walk frame floor is the LIVE gate's own calibration (> 10):
  // a GL leg mid-validation only advances frames in the sweep's own
  // windows between its SYNC reads (the container's readback wall) — a
  // 4 s window can honestly hold a dozen; the LAW is the ledger
  // (presents ≡ frame ±1), the floor only proves the loop is alive
  check(`[${mode}] the loop lives after the replant + ONE-PRESENT holds (presents ≡ frame ±1)`,
    s.f > (wantVerdict ? 100 : 10) && s.p >= s.f && s.p <= s.f + 1, `frame ${s.f} · presents ${s.p}`)
  check(`[${mode}] zero page errors`, errors.length === 0, errors.slice(0, 3).join(' | '))
  await page.close()
  server.stop(true)
}

// ── LEG 3 — the res-pin law (the ladder's own, on the software legs) ──────
async function resPinLeg(port) {
  // a dpr-3 context at a small viewport: the rung caps BITE (rung 0 caps
  // dpr at 2 → 480×320; rung 4 caps at 1 → 240×160 — the res chip reads
  // the rung, and the rung survives the replant)
  console.log('[226] res-pin leg: goto…')
  const server = serve(port)
  const page = await browser.newPage({ viewport: { width: 240, height: 160 }, deviceScaleFactor: 3 })
  const errors = []
  page.on('pageerror', e => errors.push(`pageerror: ${e.message.slice(0, 160)}`))
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 160)) })
  await page.goto(`http://localhost:${port}/demo/forest/?bare&res=0&mode=webgpu`, { waitUntil: 'networkidle', timeout: 150_000 })
  const top = await page.waitForFunction(
    () => typeof window.__forest?.res === 'string' && window.__forest.res !== '',
    null, { timeout: 60_000, polling: 250 },
  ).then(() => page.evaluate(() => ({ res: window.__forest.res, total: window.__forest.total, dock: document.querySelector('#fd-list')?.textContent ?? '' })))
  check('[res:0] THE RUNG ships its own shape (the top rung, dpr capped at 2)',
    top.res === '480×320@1x', `res ${top.res} · total ${top.total}`)
  check('[res:0] the pinned line rides the dock (the governor stands down)',
    top.dock.includes('pinned at rung 0') && top.dock.includes('the governor stands down'), '')
  // THE RUNG SURVIVES THE REPLANT: the slider re-boots the world — the
  // rung must not move with it (a denser forest must not re-climb from
  // the rung the session chose)
  await page.evaluate(() => {
    const slider = document.querySelector('#fd-slider')
    slider.value = '5'
    slider.dispatchEvent(new Event('change', { bubbles: true }))
  })
  const after = await page.waitForFunction(
    () => window.__forest.total === 5 && typeof window.__forest.res === 'string' && window.__forest.res !== '',
    null, { timeout: 120_000, polling: 250 },
  ).then(() => page.evaluate(() => ({ res: window.__forest.res, total: window.__forest.total, dock: document.querySelector('#fd-list')?.textContent ?? '' })))
  check('[res:0] THE RUNG SURVIVES THE REPLANT (the world re-plants, the rung stands)',
    after.res === '480×320@1x' && after.total === 5, `res ${after.res} · total ${after.total}`)
  check('[res:0] the replant line rides the dock', after.dock.includes('replant'), '')
  await page.close()
  // the floor rung — the same boot, one pin down: the shape halves
  const page2 = await browser.newPage({ viewport: { width: 240, height: 160 }, deviceScaleFactor: 3 })
  page2.on('pageerror', e => errors.push('p2 pageerror: ' + e.message.slice(0, 160)))
  page2.on('console', m => { if (m.type() === 'error') errors.push('p2 console: ' + m.text().slice(0, 160)) })
  await page2.goto(`http://localhost:${port}/demo/forest/?bare&res=4&mode=webgpu`, { waitUntil: 'networkidle', timeout: 150_000 })
  const floor = await page2.waitForFunction(
    () => typeof window.__forest?.res === 'string' && window.__forest.res !== '',
    null, { timeout: 60_000, polling: 250 },
  ).then(() => page2.evaluate(() => ({ res: window.__forest.res, dock: document.querySelector('#fd-list')?.textContent ?? '' })))
  check('[res:4] THE FLOOR RUNG ships its own shape (dpr capped at 1, MSAA off)',
    floor.res === '240×160@1x', `res ${floor.res}`)
  check('[res:4] the pinned line rides the dock', floor.dock.includes('pinned at rung 4'), '')
  await page2.close()
  check('[res] zero page errors across both pinned boots', errors.length === 0, errors.slice(0, 3).join(' | '))
  server.stop(true)
}

// ── the invocation (chunked legs — the honest container budget) ───────────
const LEG = process.argv[2] ?? 'all'
if (LEG === 'all' || LEG === '--leg=a' || LEG === 'a') {
  await sparseLeg('webgpu', 8976, 60, 5)
}
if (LEG === 'all' || LEG === '--leg=b' || LEG === 'b') {
  await sparseLeg('webgl2', 8977, 12, 1)
}
if (LEG === 'all' || LEG === '--leg=c' || LEG === 'c') {
  await resPinLeg(8978)
}
await browser.close()
console.log(`[226-local${LEG !== 'all' ? ` leg ${LEG}` : ''}] ${failures === 0 ? 'ALL PASS' : `FAILURES: ${failures}`} — the ladder rides the load, the witness rides the patience`)
process.exit(failures === 0 ? 0 : 1)
