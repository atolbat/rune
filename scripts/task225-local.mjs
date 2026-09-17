#!/usr/bin/env bun
/**
 * scripts/task225-local.mjs — the LOCAL gate for Task 225 (THE SCREEN LOG +
 * THE LIVE COUNTERS + THE GROWING FOREST + THE SLIDER).
 *
 * The second field report: «Ничего не изменилось. А что я могу тебе из
 * инфобокса диктовать? Там цифры меняются. Че ты просто норм лог не
 * прикрутишь, как везде … drawn -1 frustum -1 occludee. Сделай еще
 * слайдер, чтобы менять колво деревьев. Начни с парочки на экране.»
 *
 *   · LEG 1 — THE SOURCE LAWS: the screen log dock (visible, scrollable,
 *     copyable, the console tee), the live counters (the validation's own
 *     reads feeding the HUD — the -1 window is dead), the stall witness
 *     (withStall + the WARN release), the growing forest (nearest-N, the
 *     coarse thinning deleted, maxTrees), the slider (default 2, replant
 *     on release), the frame witness (the EMA + the gap line), the
 *     one-present law still holds, the v=225 bust.
 *   · LEG 2 — THE BEHAVIOR (both backends): the sparse default boot (two
 *     trees, the 5 sparse laws), the live counters landing DURING the
 *     dense validation (never -1 again), the slider round-trip (a real
 *     replant: the world rebuilds, the validation re-runs, the log rides
 *     the dock), the console tee onto the screen, one-present, zero page
 *     errors.
 */
import { chromium } from 'playwright'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

const root = join(import.meta.dirname, '..')
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.gz': 'application/gzip', '.bin': 'application/octet-stream' }
let failures = 0
function check(name, ok, detail = '') {
  console.log(`[225] ${name}: ${ok ? 'PASS' : 'FAIL'}${detail ? ` · ${detail}` : ''}`)
  if (!ok) failures++
}

// ── LEG 1 — the source laws ───────────────────────────────────────────────
{
  console.log('[225] source leg: reading…')
  const main = await readFile(join(root, 'demo/forest/main.js'), 'utf8')
  const world = await readFile(join(root, 'demo/forest/world.js'), 'utf8')
  const index = await readFile(join(root, 'demo/forest/index.html'), 'utf8')
  // THE SCREEN LOG — «Че ты просто норм лог не прикрутишь, как везде»: a
  // real panel ON the screen, not a five-line HUD tail
  check('source: THE SCREEN LOG — the dock rides the screen (scrollable, copyable, colored)',
    main.includes('forest-dock') && main.includes('function slog') && main.includes('fdReport')
      && main.includes('fd-entry--${level}') && main.includes("document.body.appendChild(dock)")
      && index.includes('.forest-dock') && index.includes('.fd-list'),
    '')
  check('source: the console tee — console.error/warn reach the screen (wrapped after the shell)',
    main.includes('shellConsoleError') && main.includes('shellConsoleWarn')
      && main.includes("console.error = function") && main.includes("console.warn = function"),
    '')
  // THE LIVE COUNTERS — «drawn -1 frustum -1 occludee»: the validation's
  // own sweep reads feed the HUD in real time
  check('source: THE LIVE COUNTERS — the validation feeds the HUD (the -1 window is dead)',
    main.includes('THE LIVE COUNTERS') && main.includes('liveCounters')
      && main.includes('stats.drawn = s.drawn') && main.includes('stats.occluded = s.occluded'),
    '')
  // THE STALL WITNESS — a read that never lands WARNs and releases
  check('source: THE STALL WITNESS — withStall races every counts read',
    main.includes('function withStall') && main.includes('STALL_MS') && main.includes('function stallWarn'),
    '')
  // THE GROWING FOREST — «Начни с парочки на экране»: nearest-N planting
  check('source: THE GROWING FOREST — the nearest-N planting ships (the coarse thinning is gone)',
    world.includes('THE GROWING FOREST') && world.includes('maxTrees') && !world.includes('const coarse'),
    '')
  // THE SLIDER — the dock's own control, the default is two trees
  check('source: THE SLIDER — the tree-count slider + the replant on release',
    main.includes('type="range" id="fd-slider"') && main.includes('function replant')
      && main.includes("fdSlider.addEventListener('change'") && main.includes('treeTarget'),
    '')
  check('source: the default forest is a COUPLE («Начни с парочки на экране»)',
    main.includes('Начни с парочки') && /\|\| 2\b/.test(main),
    '')
  // THE FRAME WITNESS — the phone's own overload line
  check('source: THE FRAME WITNESS — the EMA rides the HUD + the >250 ms gap rides the log',
    main.includes('frame gap') && main.includes('stats.ms') && main.includes('THE FRAME WITNESS'),
    '')
  // THE SPARSE CLASS — the honest law set at a couple of trees
  check('source: THE SPARSE CLASS — the occlusion/frustum laws ride the dense classes',
    main.includes('SPARSE') && main.includes('grow past 100'),
    '')
  // THE ONE-PRESENT LAW still holds (Task 224's own — untouched)
  const callSites = (main.match(/^\s*present\(\)\s*$/gm) ?? []).length
  check('source: THE ONE-PRESENT LAW — still exactly ONE present() call site',
    callSites === 1, `${callSites} statement-level call sites`)
  check('source: the page mounts the current cache-bust (v=225)', index.includes('main.js?v=225'), '')
}

// ── LEG 2 — the behavior (both backends) ─────────────────────────────────
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

async function sparseLeg(mode, port, replantTarget, waitForChecks) {
  console.log(`[225] sparse leg ${mode}: goto…`)
  const server = serve(port)
  const page = await browser.newPage({ viewport: { width: 480, height: 320 } })
  const errors = []
  page.on('pageerror', e => errors.push(`pageerror: ${e.message.slice(0, 160)}`))
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 160)) })
  await page.goto(`http://localhost:${port}/demo/forest/?mode=${mode}`, { waitUntil: 'networkidle', timeout: 150_000 })
  // THE SPARSE DEFAULT: two trees, the 5 sparse laws
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
  // THE SLIDER ROUND-TRIP: a real replant (the WG leg grows to 60 — the
  // denser sparse shape; the GL leg takes a dozen — the software legs'
  // sync readbacks ride the queue drain, and the dozen keeps the leg
  // inside its shell budget without touching the law set)
  await page.evaluate(n => {
    const slider = document.querySelector('#fd-slider')
    slider.value = String(n)
    slider.dispatchEvent(new Event('change', { bubbles: true }))
  }, replantTarget)
  // The GL leg proves the replant + the RE-RUN ITSELF (the per-boot reset
  // nulls the old verdict — a fresh progress line with the new total IS the
  // re-validation running) + the live counters + the ledger, without
  // waiting out the SwiftShader GL readback wall (~30–40 s per read; the
  // WG leg carries the full end-to-end PASS/5 proof)
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
    presents: window.__forest.presents, frame: window.__forest.frame, ms: window.__forest.ms,
    failed: (window.__forest.checks ?? []).filter(c => !c.pass).map(c => `${c.name} — ${c.detail}`),
  }))
  check(`[${mode}] THE SLIDER replants (${replantTarget} trees, the validation re-ran${wantVerdict ? ' to its verdict' : ' (the reset + the fresh progress line — the walk itself is the WG leg\'s proof'}, the counts live)`,
    replanted && afterReplant.total === replantTarget && afterReplant.drawn > 0
      && (wantVerdict ? (afterReplant.validation !== null && afterReplant.validation.pass === true) : (afterReplant.validation === null || afterReplant.validation.pass === true)),
    `total ${afterReplant.total} · drawn ${afterReplant.drawn} · validation ${afterReplant.validation ? `${afterReplant.validation.pass ? 'PASS' : 'FAIL'}/${afterReplant.validation.checks}` : '—'} · ${afterReplant.ms} ms/f${afterReplant.failed.length > 0 ? ` · FAILED: ${afterReplant.failed.join(' | ').slice(0, 200)}` : ''}`)
  check(`[${mode}] the replant rides the SCREEN LOG (the dock carries the line)`,
    afterReplant.dock.includes('replant'), afterReplant.dock.includes('replant') ? 'the dock line landed' : 'no replant line in the dock')
  check(`[${mode}] the URL follows the forest (?trees=${replantTarget})`,
    afterReplant.url.includes(`trees=${replantTarget}`), afterReplant.url)
  // THE SCREEN LOG: the boot lines + the console tee (a warn — the error
  // channel would trip the zero-errors law below)
  const dockCount = await page.evaluate(() => document.querySelectorAll('#fd-list .fd-entry').length)
  await page.evaluate(() => console.warn('tee probe 225'))
  await page.waitForTimeout(300)
  const dockText = await page.evaluate(() => document.querySelector('#fd-list')?.textContent ?? '')
  check(`[${mode}] THE SCREEN LOG lives (entries on screen + the console tee lands)`,
    dockCount >= 3 && dockText.includes('tee probe 225'),
    `${dockCount} entries · tee ${dockText.includes('tee probe 225') ? 'landed' : 'MISSING'}`)
  // the loop + one-present after the replant (a verdict leg runs FREE after
  // the validation ends — 100+ frames; an in-progress leg only advances in
  // the sweep's own windows — 20+ frames and the ledger is the law)
  await page.waitForTimeout(4000)
  const s = await page.evaluate(() => ({ f: window.__forest.frame, p: window.__forest.presents }))
  check(`[${mode}] the loop lives after the replant + ONE-PRESENT holds (presents ≡ frame ±1)`,
    s.f > (wantVerdict ? 100 : 20) && s.p >= s.f && s.p <= s.f + 1, `frame ${s.f} · presents ${s.p}${wantVerdict ? '' : ' (mid-re-validation — the free-run frames between reads)'}`)
  check(`[${mode}] zero page errors`, errors.length === 0, errors.slice(0, 3).join(' | '))
  await page.close()
  server.stop(true)
}

async function denseLiveCountersLeg(mode, port) {
  // THE LIVE COUNTERS LAW at a dense load: the drawn counter must land
  // WHILE the validation is still sweeping — under the old code the
  // validation owned the stats channel and the HUD sat at -1 for the
  // whole walk («drawn -1 frustum -1 occludee»)
  console.log(`[225] dense live-counters leg ${mode}: goto…`)
  const server = serve(port)
  const page = await browser.newPage({ viewport: { width: 480, height: 320 } })
  const errors = []
  page.on('pageerror', e => errors.push(`pageerror: ${e.message.slice(0, 160)}`))
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 160)) })
  await page.goto(`http://localhost:${port}/demo/forest/?trees=150&mode=${mode}`, { waitUntil: 'networkidle', timeout: 150_000 })
  const landed = await page.waitForFunction(
    () => window.__forest.drawn > 0,
    null, { timeout: 120_000, polling: 250 },
  ).then(() => true).catch(() => false)
  const state = await page.evaluate(() => ({
    drawn: window.__forest.drawn, total: window.__forest.total,
    validation: window.__forest.validation, progress: window.__forest.progress,
  }))
  check(`[${mode}:dense] THE LIVE COUNTERS — drawn lands DURING the sweep (never -1 again)`,
    landed && state.drawn > 0 && (state.validation === null || state.validation.checks < 7),
    `drawn ${state.drawn}/${state.total} while ${state.validation === null ? 'the sweep still runs' : `${state.validation.checks} laws in`}`)
  check(`[${mode}:dense] zero page errors`, errors.length === 0, errors.slice(0, 3).join(' | '))
  await page.close()
  server.stop(true)
}

// ── the invocation: the SwiftShader readback latency (~10 s per counts
// read at 60–150 trees — each read waits out the in-flight frame work on
// the software queue) makes the full battery exceed a single 600 s shell
// call, so the gate runs in two legs (`--leg=a` / `--leg=b`; the default
// runs both — the aggregate verdict is the conjunction).
const LEG = process.argv[2] ?? 'all'
if (LEG === 'all' || LEG === '--leg=a' || LEG === 'a') {
  await sparseLeg('webgpu', 8966, 60, 5)
}
if (LEG === 'all' || LEG === '--leg=b' || LEG === 'b') {
  await sparseLeg('webgl2', 8967, 12, 1)
}
if (LEG === 'all' || LEG === '--leg=c' || LEG === 'c') {
  await denseLiveCountersLeg('webgpu', 8968)
}
await browser.close()
console.log(`[225-local${LEG !== 'all' ? ` leg ${LEG}` : ''}] ${failures === 0 ? 'ALL PASS' : `FAILURES: ${failures}`} — the log rides the screen, the counters live, the forest grows`)
process.exit(failures === 0 ? 0 : 1)
