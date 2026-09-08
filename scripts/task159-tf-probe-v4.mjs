// task159 — TF-PROBE V4: THE CACHE MATRIX.
//
// The v3 field log came back ALL GREEN (loss cycles no longer kill TF,
// restore works, WGPU alive) — but v3's salts are unique per run, so it
// NEVER links the same source twice: the program-cache path is never
// exercised. And the v2 audit found the hole: v2's "unique" salts
// (11.5/23.5/37.5) were constants — unique within a load, identical
// ACROSS loads — so v2's "unique salt still dead → cache ruled out" was
// built on a false premise. demo/vfx/tf-probe-v4.html links the SAME
// source DELIBERATELY in every cache-relevant position:
//   anchor (FIXED salt — fresh on load #1, cross-load cache-hit from
//   load #2) → base (random salt) → relink (same source, 2nd link) →
//   parallel (new context, same source) → post-loss (v1 condition,
//   same source) → restore+relink (same source) → control (random).
//
// The gate proves the page mechanics end-to-end on SwiftShader (which
// has no poison — every cell healthy → verdict X4):
//
//   PAGE A (load #1 — the matrix cell):
//     1. auto-matrix: 5 contexts (якорь/база/кеш-паралл/кеш-после-лосса/
//        контроль), #2 disposed with the lost event, every battery's
//        T1/TF/T4 ok, the relink + restore-кеш sub-cells ok, AUTO
//        VERDICT branch X4-with-reload-prompt (load #1 wording), link
//        queries 'TF varyings=1/1', zero ANOMALY lines, per-context
//        renderer lines ×5, WGPU line present, zero page errors.
//     2. Copy: the clipboard round trip carries the header + AUTO
//        VERDICT.
//     3. «+1 контекст (ТОТ ЖЕ код)»: 6th context, battery ok.
//
//   PAGE B (the reload cell — SAME browser context so localStorage
//   carries):
//     1. After page.reload(): "загрузка №2", the plan line says the
//        anchor is now a КЕШ-ХИТ, hist prints run #1's verdicts, the
//        matrix re-runs clean, the verdict is the load≥2 X4 wording.
//     2. Zero page errors.
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const root = '/home/z/my-project/rune'
const out = join(root, '.shots', 'task159')
mkdirSync(out, { recursive: true })
const port = Number(process.env.TASK159_PORT ?? 8173)
const PAGE_URL = `http://localhost:${port}/demo/vfx/tf-probe-v4.html`

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url)
    let pathname = decodeURIComponent(url.pathname)
    if (pathname === '/') pathname = '/demo/'
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = Bun.file(join(root, pathname))
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    const ext = pathname.slice(pathname.lastIndexOf('.'))
    const MIME = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
    }
    return new Response(file, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader',
    '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})

let failed = 0
function check(name, ok, note = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${note ? ' — ' + note : ''}`)
  if (!ok) failed++
}

function tap(page, bag) {
  page.on('pageerror', (e) => bag.errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') bag.errors.push('console.error: ' + m.text()) })
}
function logText(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('#loglist .m')).map((el) => el.textContent).join('\n'))
}
const waitLine = (page, needle, timeout) =>
  page.waitForFunction((n) => Array.from(document.querySelectorAll('#loglist .m')).some((el) => el.textContent.includes(n)), needle, { timeout })

async function newPage() {
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://localhost:${port}` })
  const page = await context.newPage()
  const bag = { errors: [] }
  tap(page, bag)
  return { page, bag, context }
}

const HEALTHY = (r) => r && r.t1 && r.t1.ok && r.tf && r.tf.ok && r.t4 && r.t4.ok

/* ═══════════ PAGE A — load #1: the matrix cell ═══════════ */
console.log('[task159] PAGE A — load #1: the auto matrix + copy + same-code button')
{
  const { page, bag, context } = await newPage()
  await page.goto(PAGE_URL, { waitUntil: 'load' })

  await waitLine(page, 'AUTO MATRIX завершена', 120_000)
  const probe = await page.evaluate(() => window.__tfProbe4)
  check('A1 matrix: 5 contexts created', probe.created === 5, `created=${probe.created}`)
  check('A1 matrix: 1 disposed (#2 база), lost fired', probe.disposed === 1 &&
    probe.contexts.some((c) => c.label === 'база' && c.disposed && c.lost))
  check('A1 matrix: labels are якорь/база/кеш-паралл(-restored)/кеш-после-лосса/контроль',
    ['якорь', 'база', 'кеш-паралл', 'кеш-после-лосса', 'контроль'].every((l) => probe.contexts.some((c) => c.label.startsWith(l))),
    JSON.stringify(probe.contexts.map((c) => c.label)))
  check('A1 matrix: loads=1 (fresh browser context)', probe.loads === 1, `loads=${probe.loads}`)
  check('A1 matrix: every battery T1/TF/T4 fully healthy (SwiftShader — no poison here)',
    probe.contexts.every((c) => HEALTHY(c.results)),
    JSON.stringify(probe.contexts.map((c) => ({ i: c.index, tf: c.results?.tf?.ok }))))
  check('A1 matrix: the FIXED anchor salt went into the first battery',
    probe.contexts[0].results?.salt === '31337.0', `salt=${probe.contexts[0].results?.salt}`)
  check('A1 matrix: the random base salt differs from the anchor and the control',
    probe.contexts[1].results.salt !== '31337.0' && probe.contexts[1].results.salt !== probe.contexts[4].results.salt,
    `${probe.contexts[1].results.salt} / ${probe.contexts[4].results.salt}`)
  check('A1 matrix: lastRun states all ok (anchor/fresh/relink/par/loss/restore/ctrl)',
    ['anchor', 'fresh', 'relink', 'par', 'loss', 'restore', 'ctrl'].every((k) => probe.lastRun.states[k] === 'ok'),
    JSON.stringify(probe.lastRun.states))
  check('A1 matrix: renderer recorded for EVERY context', probe.contexts.every((c) => c.renderer && c.renderer !== '(masked)'))
  check('A1 matrix: hist recorded exactly 1 run', probe.hist.length === 1 && probe.hist[0].anchor === 'ok')

  const text = await logText(page)
  check('A1 matrix: AUTO VERDICT line lists all 7 cells', /AUTO VERDICT — якорь\(фикс 31337\.0\): ok · база\(случ\): ok · relink: ok · кеш-паралл: ok · после-лосса: ok · restore-кеш: ok · контроль: ok/.test(text))
  check('A1 matrix: verdict is X4 with the load-#1 reload prompt', text.includes('ВЫВОД X4') && text.includes('ЯКОРЬ ещё СВЕЖИЙ'))
  check('A1 matrix: relink sub-cell ran and passed', /R-relink\(тот же код\) @#2 — TF-check: ok/.test(text))
  check('A1 matrix: restore-кеш sub-cell landed webglcontextrestored and passed',
    /#3 webglcontextrestored/.test(text) && /RESTORE-КЕШ VERDICT: relink того же кода на восстановленном #3 — ok/.test(text))
  check('A1 matrix: link queries say TF varyings=1/1 (7 links: 5 batteries + relink + restore)',
    (text.match(/TF varyings=1\/1/g) || []).length >= 7, `${(text.match(/TF varyings=1\/1/g) || []).length} links`)
  check('A1 matrix: zero TF-metadata ANOMALY lines', !text.includes('АНОМАЛИЯ'))
  check('A1 matrix: per-context created lines ×5', (text.match(/created \(/g) || []).length === 5)
  check('A1 matrix: no spontaneous losses', !text.includes('SPONTANEOUS'))
  check('A1 matrix: the v1-condition loss line present', text.includes('v1-условие: loseContext + detach'))
  check('A1 matrix: WGPU probe line present (any classification)', /WGPU compute roundtrip:/.test(text))
  check('A1 matrix: zero page errors', bag.errors.length === 0, bag.errors[0] ?? '')
  check('A1 matrix: 5 table rows', await page.evaluate(() => document.querySelectorAll('#sumbody tr').length) === 5)
  check('A1 matrix: 5 canvas slots', await page.evaluate(() => document.querySelectorAll('#cvrow .slot').length) === 5)

  // copy — the user's explicit requirement
  await page.click('#btn-copy')
  await waitLine(page, 'Log copied to clipboard', 10_000)
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  check('A2 copy: header names the CACHE matrix', clip.includes('tf-probe v4 (Task 159) — raw WebGL2 TF probe, the CACHE matrix'))
  check('A2 copy: carries AUTO VERDICT + restart marker line',
    clip.includes('AUTO VERDICT — якорь') && clip.includes('restart marker pressed this run: no'))

  // +1 (ТОТ ЖЕ код) — the manual cache cell
  await page.click('#btn-same')
  await waitLine(page, '+1-тот-же-код', 10_000)
  await waitLine(page, '#6 [+1-тот-же-код] — battery done', 30_000)
  const probe6 = await page.evaluate(() => window.__tfProbe4)
  check('A3 +1 same-code: 6th context, battery healthy, salt = the run\'s random F1',
    probe6.created === 6 && HEALTHY(probe6.contexts[5].results) &&
    probe6.contexts[5].results.salt === probe6.contexts[1].results.salt,
    `salt=${probe6.contexts[5].results.salt}`)
  check('A3 +1 same-code: zero page errors after the button', bag.errors.length === 0, bag.errors[0] ?? '')

  await page.screenshot({ path: join(out, 'pageA.png'), fullPage: true })
  await context.close()
}

/* ═══════════ PAGE B — reload in the SAME browser context: the cross-load anchor cell ═══════════ */
console.log('[task159] PAGE B — reload: the anchor becomes a cross-load cache-hit')
{
  const { page, bag, context } = await newPage()
  await page.goto(PAGE_URL, { waitUntil: 'load' })
  await waitLine(page, 'AUTO MATRIX завершена', 120_000)

  await page.click('#btn-reload')
  // the reload fires 400ms after the click — the ONLY reliable post-reload
  // sentinel is the fresh boot line «page loaded (загрузка №2» (the old
  // page's log still contains the old AUTO VERDICT line)
  await waitLine(page, 'page loaded (загрузка №2', 30_000)
  await waitLine(page, 'AUTO MATRIX завершена', 120_000)
  const probe = await page.evaluate(() => window.__tfProbe4)
  check('B1 reload: loads=2 (localStorage carried)', probe.loads === 2, `loads=${probe.loads}`)

  const text = await logText(page)
  check('B1 reload: page-loaded line says загрузка №2', /page loaded \(загрузка №2/.test(text))
  check('B1 reload: plan line marks the anchor as КЕШ-ХИТ с прошлой загрузки', text.includes('КЕШ-ХИТ с прошлой загрузки'))
  check('B1 reload: hist prints run #1 verdicts before the matrix',
    /hist — прогон №1 .*: якорь ok · база ok · relink ok · кеш-паралл ok · после-лосса ok · restore-кеш ok · контроль ok/.test(text))
  check('B1 reload: the re-run matrix is fully healthy again',
    probe.contexts.every((c) => HEALTHY(c.results)) && probe.lastRun.states.anchor === 'ok')
  check('B1 reload: verdict is the load≥2 X4 wording (крест-лоад кеш исключён)',
    text.includes('ВЫВОД X4') && text.includes('якорь уже был кеш-хитом и ЖИВ'))
  check('B1 reload: zero page errors', bag.errors.length === 0, bag.errors[0] ?? '')

  await page.screenshot({ path: join(out, 'pageB.png'), fullPage: true })
  await context.close()
}

await browser.close()
server.stop()

console.log(failed === 0 ? '\n[task159] ALL CHECKS PASSED' : `\n[task159] ${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
