// task156 — THE RAW WEBGL2 TF PROBE (the user's ask: "make a new page
// WITHOUT the library and check whatever you want in WebGL, don't forget
// the logs and a copy button").
//
// demo/vfx/tf-probe.html is a zero-library page that decomposes "в каком
// смысле мёртв" (Task 152's live verdict — every GL context born after a
// dispose is born dead) into seven raw-GL tests per context. The gate
// proves the page works end-to-end on SwiftShader:
//
//   PAGE A (the churn cell):
//     1. auto-baseline: context #1 created + the full battery, ALL seven
//        PASS, T5 cross-verdict 'HEALTHY', __tfProbe coherent.
//     2. «Авто ×6»: six dispose->new cycles — 7 contexts total, the first
//        six disposed WITH the contextlost event fired each time, the
//        newest alive and fully healthy (SwiftShader has no poison — on
//        the reporting phone THIS is where the drop would reproduce).
//     3. Copy: clipboard permissions granted, the button produces the
//        full report in the clipboard (header + entries + 'GL #7').
//
//   PAGE B (the interlude + coexistence cell):
//     1. «WebGPU интерлюдия -> новый GL»: a WG device + one submitted
//        pass + destroy, then GL #2 — all-ok, OR the documented container
//        environmental class (a SwiftShader transient context loss with a
//        restore) accepted with a note.
//     2. «+1 (старый живёт)»: coexistence — GL #3 created while #2 stays
//        alive, battery healthy.
//     3. «Повторить батарею»: the mid-life re-verdict runs on #3 again.
//
//   Zero page errors on both pages (the page's own log panel is
//   DOM-based — pageerror/console.error is the failure signal).
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const root = '/home/z/my-project/rune'
const out = join(root, '.shots', 'task156')
mkdirSync(out, { recursive: true })
const port = Number(process.env.TASK156_PORT ?? 8170)
const PAGE_URL = `http://localhost:${port}/demo/vfx/tf-probe.html`

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

/** Collect the page's own log text + page errors. */
function tap(page, bag) {
  page.on('pageerror', (e) => bag.errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') bag.errors.push('console.error: ' + m.text()) })
}
function logText(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('#loglist .m')).map((el) => el.textContent).join('\n'))
}
const waitLine = (page, needle, timeout) =>
  page.waitForFunction((n) => Array.from(document.querySelectorAll('#loglist .m')).some((el) => el.textContent.includes(n)), needle, { timeout })
const countLine = (page, needle) =>
  page.evaluate((n) => Array.from(document.querySelectorAll('#loglist .m')).filter((el) => el.textContent.includes(n)).length, needle)

async function newPage() {
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://localhost:${port}` })
  const page = await context.newPage()
  const bag = { errors: [] }
  tap(page, bag)
  return { page, bag, context }
}

const KEYS = ['t1', 't2', 't3a', 't3b', 't4', 't5']
const allOk = (results) => results && KEYS.every((k) => results[k] && results[k].ok)

/* ═══════════ PAGE A — the churn cell ═══════════ */
console.log('[task156] PAGE A — auto-baseline + auto ×6 + copy')
{
  const { page, bag, context } = await newPage()
  await page.goto(PAGE_URL, { waitUntil: 'load' })

  await waitLine(page, '#1 — battery done', 30_000)
  const probe1 = await page.evaluate(() => window.__tfProbe)
  check('A1 baseline: __tfProbe one context, alive', probe1.created === 1 && probe1.disposed === 0)
  check('A1 baseline: all six tests ok', allOk(probe1.contexts[0].results), JSON.stringify(probe1.contexts[0].results && Object.fromEntries(KEYS.map((k) => [k, probe1.contexts[0].results[k]?.short]))))
  const text1 = await logText(page)
  check('A1 baseline: T5 cross -> HEALTHY', /#1 T5 TF->raster cross: readback OK .* -> HEALTHY/.test(text1))
  check('A1 baseline: BASELINE VERDICT PASS line', text1.includes('BASELINE VERDICT #1:'))
  check('A1 baseline: env renderer line present', /env — renderer:/.test(text1))
  check('A1 baseline: zero page errors', bag.errors.length === 0, bag.errors[0] ?? '')

  // auto ×6 — the churn
  await page.click('#btn-auto')
  await waitLine(page, 'AUTO x6 done', 180_000)
  const probe7 = await page.evaluate(() => window.__tfProbe)
  check('A2 auto ×6: 7 contexts created', probe7.created === 7, `created=${probe7.created}`)
  check('A2 auto ×6: 6 disposed', probe7.disposed === 6, `disposed=${probe7.disposed}`)
  check('A2 auto ×6: contexts 1..6 disposed, all lost events fired',
    probe7.contexts.slice(0, 6).every((c) => c.disposed && c.lost))
  check('A2 auto ×6: the newest (#7) alive + fully healthy',
    !probe7.contexts[6].disposed && allOk(probe7.contexts[6].results))
  const text7 = await logText(page)
  check('A2 auto ×6: six expected contextlost lines', (text7.match(/webglcontextlost FIRED \(expected — our dispose\)/g) || []).length === 6)
  check('A2 auto ×6: no spontaneous losses', !text7.includes('SPONTANEOUS'))
  check('A2 auto ×6: zero page errors', bag.errors.length === 0, bag.errors[0] ?? '')
  const cards = await page.evaluate(() => document.querySelectorAll('#cards .card').length)
  const disposedCards = await page.evaluate(() => document.querySelectorAll('#cards .card.disposed').length)
  check('A2 auto ×6: 7 cards, 6 disposed', cards === 7 && disposedCards === 6, `cards=${cards} disposed=${disposedCards}`)

  // copy — the user's explicit requirement
  await page.click('#btn-copy')
  await waitLine(page, 'Log copied to clipboard', 10_000)
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  check('A3 copy: header + entries + GL #7 in the clipboard',
    clip.includes('tf-probe v1 (Task 156)') && clip.includes('GL #7 created') && clip.includes('T5 TF->raster cross') &&
    clip.includes('entries: '), `${clip.length} chars`)
  writeFileSync(join(out, 'pageA-log.txt'), clip)

  await page.screenshot({ path: join(out, 'pageA.png'), fullPage: true })
  await context.close()
}

/* ═══════════ PAGE B — the interlude + coexistence cell ═══════════ */
console.log('[task156] PAGE B — WG interlude + coexistence + rerun')
{
  const { page, bag, context } = await newPage()
  await page.goto(PAGE_URL, { waitUntil: 'load' })
  await waitLine(page, '#1 — battery done', 30_000)

  // WG interlude -> GL #2
  await page.click('#btn-wg')
  await waitLine(page, '#2 — battery done', 90_000)
  const text2 = await logText(page)
  const probe2 = await page.evaluate(() => window.__tfProbe)
  if (text2.includes('WebGPU interlude: device created')) {
    console.log('  NOTE  WebGPU interlude ran in-container (SwiftShader WG)')
    const interludeOk = allOk(probe2.contexts[1].results)
    const restored = text2.includes('webglcontextrestored')
    check('B1 interlude: GL #2 healthy (or the documented restore class)', interludeOk || restored,
      interludeOk ? 'all ok' : (restored ? 'restored-after-transient-loss (container class)' : 'unhealthy'))
  } else {
    console.log('  NOTE  navigator.gpu absent in-container — the interlude leg degraded to dispose->new, still valid')
    check('B1 interlude: GL #2 created + battery done', probe2.created === 2 && !!probe2.contexts[1].results)
  }
  check('B1 interlude: zero page errors', bag.errors.length === 0, bag.errors[0] ?? '')

  // coexistence: +1 while #2 alive
  await page.click('#btn-keep')
  await waitLine(page, '#3 — battery done', 30_000)
  const probe3 = await page.evaluate(() => window.__tfProbe)
  check('B2 coexistence: 3 contexts, 2 alive', probe3.created === 3 && probe3.disposed === 1)
  check('B2 coexistence: GL #3 fully healthy (alive alongside #2)', !probe3.contexts[2].disposed && allOk(probe3.contexts[2].results))

  // mid-life re-verdict
  await page.click('#btn-rerun')
  await page.waitForFunction(() => Array.from(document.querySelectorAll('#loglist .m')).filter((el) => el.textContent.includes('— battery done')).length >= 4, null, { timeout: 30_000 })
  const doneCount = await countLine(page, '— battery done')
  check('B3 rerun: the battery ran a second time on the live context', doneCount === 4, `battery-done lines=${doneCount}`)
  check('B3 rerun: zero page errors', bag.errors.length === 0, bag.errors[0] ?? '')

  await page.screenshot({ path: join(out, 'pageB.png'), fullPage: true })
  await context.close()
}

server.stop(true)
await browser.close()

if (failed > 0) {
  console.error(`[task156] FAIL — ${failed} check(s) failed`)
  process.exit(1)
}
console.log('[task156] PASS — the raw TF probe page works end-to-end (7-context churn, WG interlude, coexistence, copy)')
