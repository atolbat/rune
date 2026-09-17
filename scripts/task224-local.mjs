#!/usr/bin/env bun
/**
 * scripts/task224-local.mjs — the LOCAL gate for Task 224 (THE ONE-PRESENT
 * LAW + THE FIELD LOG — the forest's first phone field report:
 * «постоянно мигает на чёрный экран, потом появляется террейн, деревья
 * могут появиться, а могут и нет, потом могут исчезнуть и так каждый
 * полсекунды»).
 *
 *   · LEG 1 — THE SOURCE LAWS: the one-present law (exactly ONE
 *     statement-level present() call site — the fg's own present pass,
 *     blit + submit inside the frame), the present ledger (presents ===
 *     frame, measurable from the field), the field log (the on-screen
 *     tail — boot shape, verdicts, every device error).
 *   · LEG 2 — THE BEHAVIOR (both backends): the 7-law validation still
 *     walks (the fix must not regress the container legs), the one-
 *     present law holds LIVE (presents within ±1 of frame — the old bug
 *     ran presents at 2× the frames and killed every other submit on a
 *     real adapter), the field log rides the HUD, zero page errors.
 */
import { chromium } from 'playwright'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

const root = join(import.meta.dirname, '..')
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.gz': 'application/gzip', '.bin': 'application/octet-stream' }
let failures = 0
function check(name, ok, detail = '') {
  console.log(`[224] ${name}: ${ok ? 'PASS' : 'FAIL'}${detail ? ` · ${detail}` : ''}`)
  if (!ok) failures++
}

// ── LEG 1 — the source laws ───────────────────────────────────────────────
{
  console.log('[224] source leg: reading…')
  const main = await readFile(join(root, 'demo/forest/main.js'), 'utf8')
  const index = await readFile(join(root, 'demo/forest/index.html'), 'utf8')
  // THE ONE-PRESENT LAW: exactly one statement-level present() call — the
  // fg's own present pass. The regression (a trailing present() after
  // lastFrame.run(props)) opened a second canvas pass into a fresh encoder
  // with no submit of its own: it rode the NEXT frame's submit against an
  // EXPIRED canvas texture, the validation error killed the WHOLE submit,
  // and every other frame never presented — the phone answered with BLACK.
  const callSites = (main.match(/^\s*present\(\)\s*$/gm) ?? []).length
  check('source: THE ONE-PRESENT LAW — exactly ONE present() call site (the fg pass owns the boundary)',
    callSites === 1 && main.includes('THE ONE-PRESENT LAW (Task 224'),
    `${callSites} statement-level call sites`)
  check('source: the present pass submits INSIDE the frame (blit + submit, nothing after)',
    /execute: \(\) => \{\s*\n\s*present\(\)\s*\n\s*device\.submit\(\)\s*\n\s*\},/.test(main),
    '')
  check('source: the frame tail carries NO present — run(props) runs into frameIndex++ alone',
    /lastReport = lastFrame\.run\(props\)\s*\n\s*\/\/ THE ONE-PRESENT LAW/.test(main),
    '')
  // THE PRESENT LEDGER: the count is the field's own witness — presents
  // === frame (±1 mid-frame); the old bug doubled it.
  check('source: THE PRESENT LEDGER — every present() counts (presents === frame)',
    main.includes('stats.presents++') && main.includes('presents: 0'),
    '')
  // THE FIELD LOG: the shell's log panel hides behind the FAB sheet — on a
  // phone the evidence must ride the SCREEN.
  check('source: THE FIELD LOG — the ring + the HUD tail (boot shape, verdicts, errors on screen)',
    main.includes('function fieldNote') && main.includes('tail: fieldLog')
      && main.includes("fieldNote('ERR', message)") && main.includes("fieldNote('boot', ") && main.includes('${backend} ${MODE}') && main.includes("${tail}`"),
    '')
  check('source: the HUD escapes the tail (a device error owns no HTML privileges)',
    main.includes("replace(/&/g, '&amp;')"),
    '')
  check('source: the HUD rides the body from module init (a load-time failure finds the screen)',
    main.includes('document.body.appendChild(hud)'),
    '')
  check('source: the page mounts the current cache-bust (v=224)', index.includes('main.js?v=224'), '')
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

async function behaviorLeg(mode, port) {
  console.log(`[224] behavior leg ${mode}: goto…`)
  const server = serve(port)
  const page = await browser.newPage({ viewport: { width: 480, height: 320 } })
  const errors = []
  page.on('pageerror', e => errors.push(`pageerror: ${e.message.slice(0, 160)}`))
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 160)) })
  await page.goto(`http://localhost:${port}/demo/forest/?trees=150&mode=${mode}`, { waitUntil: 'networkidle', timeout: 150_000 })
  const gate = await page.waitForFunction(
    () => window.__forestGate !== undefined && typeof window.__forestGate.then === 'function',
    null, { timeout: 150_000, polling: 500 },
  ).then(() => page.evaluate(() => window.__forestGate))
  const res = await Promise.race([gate, new Promise(r => setTimeout(() => r({ err: 'GATE_TIMEOUT' }), 420_000))])
  const list = res && Array.isArray(res.list) ? res.list : []
  for (const c of list) check(`[${mode}:validation] ${c.name}`, c.pass === true, c.detail ?? '')
  check(`[${mode}:validation] the autopilot walked the forest (all 7 laws)`,
    res && res.pass === true && res.checks === 7,
    res && res.err ? res.err : `${list.filter(c => c.pass).length}/${list.length} laws`)
  // the stats lane re-arms after the validation's pause — give it a beat
  await page.waitForTimeout(4000)
  const s = await page.evaluate(() => ({
    f: window.__forest.frame, p: window.__forest.presents, drawn: window.__forest.drawn,
    total: window.__forest.total, tail: window.__forest.tail.slice(),
  }))
  check(`[${mode}] the loop lives (frames advancing, drawn landed)`,
    s.f > 100 && (s.drawn > 0 || (res && res.pass === true)), `frame ${s.f} · drawn ${s.drawn}/${s.total}`)
  // THE ONE-PRESENT LAW, LIVE: presents === frame (±1 mid-frame). The old
  // bug ran presents at 2× the frames — a measurable regression on EVERY
  // leg (the container included; the expired-texture death itself needs a
  // real adapter, the count does not).
  check(`[${mode}] THE ONE-PRESENT LAW holds live (presents within ±1 of frame)`,
    s.p >= s.f && s.p <= s.f + 1, `presents ${s.p} vs frame ${s.f}`)
  // THE FIELD LOG: the boot shape + the verdict ride the screen
  const hudText = await page.evaluate(() => document.querySelector('.walker-hud')?.textContent ?? '')
  check(`[${mode}] THE FIELD LOG rides the HUD (boot + verdict lines on screen)`,
    s.tail.length > 0 && s.tail.some(l => l.startsWith('boot ')) && s.tail.some(l => l.startsWith('valid '))
      && hudText.includes('boot ') && hudText.includes('valid '),
    s.tail.slice(0, 2).join(' | '))
  check(`[${mode}] zero page errors`, errors.length === 0, errors.slice(0, 3).join(' | '))
  await page.close()
  server.stop(true)
}

await behaviorLeg('webgpu', 8964)
await behaviorLeg('webgl2', 8965)
await browser.close()
console.log(`[224-local] ${failures === 0 ? 'ALL PASS' : `FAILURES: ${failures}`} — one frame, one blit, one submit; the field log rides the screen`)
process.exit(failures === 0 ? 0 : 1)
