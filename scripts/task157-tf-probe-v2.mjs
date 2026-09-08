// task157 — TF-PROBE V2: THE DISCRIMINATING MATRIX.
//
// v1 (Task 156) proved the phone's phenomenon raw (first context healthy,
// post-dispose contexts TF-dead silently) but could not TELL APART the
// competing explanations — every dead context had both a prior dispose AND
// prior identical program links, and coexistence was never exercised.
// demo/vfx/tf-probe-v2.html auto-runs the 4-cell matrix:
//   ctx1 base (unique salt) → ctx2 THE SAME source PARALLEL (program-cache
//   cell) → ctx3 unique source PARALLEL (any-2nd-context cell) → dispose
//   ctx2 → 5s → ctx4 unique source (the v1 condition, cache defeated),
// plus the read ladder (imm/fence/+350ms/copy), the sep + relink
// cache-collision probes, per-context renderer strings and the localStorage
// reload counter.
//
// The gate proves the page mechanics end-to-end on SwiftShader (which has
// no poison — all four cells healthy → verdict branch E):
//
//   PAGE A (the matrix cell):
//     1. auto-matrix: 4 contexts, #2 disposed with the lost event, #1/#3/#4
//        alive, every battery's TF ladder fully ok, AUTO VERDICT present
//        (branch E on SwiftShader), link queries 'TF varyings=1/1', zero
//        ANOMALY lines, per-context renderer lines ×4, BASELINE PASS.
//     2. Copy: the clipboard round trip carries header + AUTO VERDICT +
//        the loads line.
//
//   PAGE B (the buttons cell):
//     1. «+1 контекст (старый живёт)»: #5 parallel, battery ok.
//     2. «Dispose → 300мс»: #4-chain eviction → #6 fast cell, battery ok.
//     3. «Restore-путь на #1»: webglcontextrestored lands, the re-run
//        battery on the RESTORED #1 is TF-healthy (or the documented
//        container class is accepted with a note).
//     4. «⟳ Перезагрузить»: the page reloads, localStorage loads=2, the
//        matrix re-runs clean on the fresh load.
//
//   Zero page errors on both pages (the page's own log panel is DOM-based
//   — pageerror/console.error is the failure signal).
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const root = '/home/z/my-project/rune'
const out = join(root, '.shots', 'task157')
mkdirSync(out, { recursive: true })
const port = Number(process.env.TASK157_PORT ?? 8171)
const PAGE_URL = `http://localhost:${port}/demo/vfx/tf-probe-v2.html`

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

const LADDER = (r) => r && r.t1 && r.t1.ok && r.tfImm && r.tfImm.ok && r.tfFence && r.tfFence.ok &&
  r.tfDelay && r.tfDelay.ok && r.tfCopy && r.tfCopy.ok && r.tfSep && r.tfSep.ok && r.tfRelink && r.tfRelink.ok &&
  r.t5 && r.t5.ok && r.t4 && r.t4.ok

/* ═══════════ PAGE A — the matrix cell ═══════════ */
console.log('[task157] PAGE A — the auto matrix + copy')
{
  const { page, bag, context } = await newPage()
  await page.goto(PAGE_URL, { waitUntil: 'load' })

  await waitLine(page, 'AUTO VERDICT', 120_000)
  const probe = await page.evaluate(() => window.__tfProbe2)
  check('A1 matrix: 4 contexts created', probe.created === 4, `created=${probe.created}`)
  check('A1 matrix: 1 disposed (#2), lost fired', probe.disposed === 1 && probe.contexts[1].disposed && probe.contexts[1].lost)
  check('A1 matrix: #1/#3/#4 alive', probe.contexts.filter((c) => !c.disposed).length === 3)
  check('A1 matrix: loads=1 (fresh browser context)', probe.loads === 1, `loads=${probe.loads}`)
  check('A1 matrix: every cell TF-ladder fully healthy (SwiftShader — no poison here)',
    probe.contexts.every((c) => LADDER(c.results)),
    JSON.stringify(probe.contexts.map((c) => ({ i: c.index, imm: c.results?.tfImm?.ok, relink: c.results?.tfRelink?.ok, t5: c.results?.t5?.sense }))))
  check('A1 matrix: renderer recorded for EVERY context', probe.contexts.every((c) => c.renderer && c.renderer !== '(masked)'))
  const text = await logText(page)
  check('A1 matrix: AUTO VERDICT branch E (no poison in-container)', text.includes('ВЫВОД E'))
  check('A1 matrix: link queries say TF varyings=1/1', (text.match(/TF varyings=1\/1/g) || []).length >= 12, `${(text.match(/TF varyings=1\/1/g) || []).length} links`)
  check('A1 matrix: zero TF-metadata ANOMALY lines', !text.includes('АНОМАЛИЯ'))
  check('A1 matrix: per-context created lines ×4', (text.match(/created \(/g) || []).length === 4)
  check('A1 matrix: no spontaneous losses', !text.includes('SPONTANEOUS'))
  check('A1 matrix: BASELINE line PASS', /BASELINE #1: первый контекст полностью здоров/.test(text))
  check('A1 matrix: zero page errors', bag.errors.length === 0, bag.errors[0] ?? '')
  check('A1 matrix: 4 table rows', await page.evaluate(() => document.querySelectorAll('#sumbody tr').length) === 4)
  check('A1 matrix: 4 canvas slots', await page.evaluate(() => document.querySelectorAll('#cvrow .slot').length) === 4)

  // copy — the user's explicit requirement
  await page.click('#btn-copy')
  await waitLine(page, 'Log copied to clipboard', 10_000)
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  check('A2 copy: header + AUTO VERDICT + loads line in the clipboard',
    clip.includes('tf-probe v2 (Task 157)') && clip.includes('AUTO VERDICT') && clip.includes('page loads of this url (localStorage): 1') &&
    clip.includes('T2f TF-roundtrip IDENTICAL relink'), `${clip.length} chars`)
  writeFileSync(join(out, 'pageA-log.txt'), clip)

  await page.screenshot({ path: join(out, 'pageA.png'), fullPage: true })
  await context.close()
}

/* ═══════════ PAGE B — the buttons cell ═══════════ */
console.log('[task157] PAGE B — +1 parallel + fast cycle + restore path + reload')
{
  const { page, bag, context } = await newPage()
  await page.goto(PAGE_URL, { waitUntil: 'load' })
  await waitLine(page, 'AUTO VERDICT', 120_000)

  // +1 parallel (no dispose)
  await page.click('#btn-plus')
  await waitLine(page, '#5 [+1-параллельно] — battery done', 60_000)
  let probe = await page.evaluate(() => window.__tfProbe2)
  check('B1 +1 parallel: 5 contexts, still only 1 disposed', probe.created === 5 && probe.disposed === 1)
  check('B1 +1 parallel: #5 healthy next to three live contexts', LADDER(probe.contexts[4].results))

  // fast cycle: dispose newest (#5) -> 300ms -> #6
  await page.click('#btn-fast')
  await waitLine(page, '#6 [fast-300ms] — battery done', 60_000)
  probe = await page.evaluate(() => window.__tfProbe2)
  check('B2 fast: 6 contexts, 2 disposed (#5 lost fired)', probe.created === 6 && probe.disposed === 2 &&
    probe.contexts[4].disposed && probe.contexts[4].lost)
  check('B2 fast: the post-300ms context healthy (SwiftShader)', LADDER(probe.contexts[5].results))

  // restore path on #1
  await page.click('#btn-restore')
  await waitLine(page, 'RESTORE VERDICT', 90_000)
  const text = await logText(page)
  if (text.includes('webglcontextrestored — все старые GL-объекты мертвы')) {
    check('B3 restore: webglcontextrestored landed + re-run battery healthy', /RESTORE VERDICT: TF на восстановленном #1 — ok/.test(text))
  } else {
    console.log('  NOTE  restore path hit the documented container class — see the log line')
    check('B3 restore: the failure was REPORTED honestly (no silent skip)', text.includes('RESTORE-ПУТЬ'))
  }
  check('B3 restore: zero page errors so far', bag.errors.length === 0, bag.errors[0] ?? '')

  // reload — the persistence test machinery
  // (wait for the ACTUAL navigation: the old page already has an AUTO VERDICT
  // line, so the only trustworthy sentinel is the loads counter rising)
  const loadsBefore = await page.evaluate(() => window.__tfProbe2.loads)
  await page.click('#btn-reload')
  await page.waitForFunction((b) => window.__tfProbe2 && window.__tfProbe2.loads > b, loadsBefore, { timeout: 30_000 })
  await page.waitForLoadState('load')
  await waitLine(page, 'AUTO VERDICT', 120_000)
  probe = await page.evaluate(() => window.__tfProbe2)
  const text2 = await logText(page)
  check('B4 reload: loads=2 counted via localStorage', probe.loads === 2, `loads=${probe.loads}`)
  check('B4 reload: the matrix re-ran clean on the fresh load (4 contexts)', probe.created === 4 && probe.contexts.every((c) => LADDER(c.results)))
  check('B4 reload: the boot counter line of the SECOND load present', text2.includes('page loaded (загрузка №2'))
  check('B4 reload: zero page errors', bag.errors.length === 0, bag.errors[0] ?? '')

  await page.screenshot({ path: join(out, 'pageB.png'), fullPage: true })
  await context.close()
}

server.stop(true)
await browser.close()

if (failed > 0) {
  console.error(`[task157] FAIL — ${failed} check(s) failed`)
  process.exit(1)
}
console.log('[task157] PASS — tf-probe v2 works end-to-end (matrix, read ladder, cache probes, restore, reload counter, copy)')
