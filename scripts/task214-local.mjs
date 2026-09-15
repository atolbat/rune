/**
 * scripts/task214-local.mjs — the LOCAL pre-deploy gate for Task 214 (the
 * single-pass downsampler — the Granite/FidelityFX SPD harvest, research
 * A4 / bevy #22286's landed shape).
 *
 * The bit-identity gate, on the living page, both backends:
 *   · WG leg: after a warm feedback frame (the pyramid carries the city's
 *     own depth data), pause the loop (the readback discipline) and run
 *     the tier's spdParity() — dispatch BOTH spellings (the SPD pair +
 *     the legacy sequential chain) over the same z tile and compare EVERY
 *     storage word. PASS = zero diffs, the dispatch count 2 vs the legacy
 *     10, and the page stays error-free; the frame loop must continue
 *     cleanly after the gate (the readbacks do not wedge the renderer).
 *   · GL leg: spdParity() returns null by contract (the FBO pyramid is
 *     the backend's own mechanism — untouched this round); the page must
 *     stay alive and error-free (the no-op must be a true no-op).
 */
import { chromium } from 'playwright'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const port = 8922
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url)
    let pathname = decodeURIComponent(url.pathname)
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = Bun.file(join(root, pathname))
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    const ext = pathname.slice(pathname.lastIndexOf('.'))
    return new Response(file, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})

let failures = 0
function check(name, ok, detail = '') {
  console.log(`[214] ${name}: ${ok ? 'PASS' : 'FAIL'}${detail ? ` · ${detail}` : ''}`)
  if (!ok) failures++
}

async function runLeg(mode) {
  console.log(`[214] leg ${mode}: goto…`)
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 200)}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`) })
  await page.goto(`http://localhost:${port}/demo/occlusion/?bare=1${mode === 'webgl2' ? '&mode=webgl2' : ''}`, { waitUntil: 'networkidle', timeout: 90_000 })
  await page.waitForFunction(() => window.__hizStats && window.__hizStats.drawn > 0, null, { timeout: 240_000 })
  // warm the pyramid: a couple of feedback frames (the fixed-point law —
  // the carry converges in one; two to be sure). The camera keeps
  // orbiting (the default) — the per-frame drawn count MOVES, which is
  // the loop-liveness signal below (drawn is the per-frame visible count,
  // not a frame counter).
  await page.waitForTimeout(900)

  // THE GATE — pause (the readback discipline), dispatch both spellings,
  // compare every storage word; resume is in the finally (the page must
  // keep rendering after the gate — readbacks never wedge the renderer).
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
    check(`${mode} spd parity`, parity !== null && parity.error === undefined && parity.pass === true,
      parity === null ? 'null parity' : parity.error !== undefined ? `crashed: ${parity.error}` : `${parity.diffs} diffs of ${parity.words} words${parity.diffs > 0 ? ` (first at ${parity.first})` : ''}`)
    if (parity !== null && parity.error === undefined) {
      check(`${mode} spd dispatch shape`, parity.spdDispatches === 2 && parity.legacyDispatches === 10,
        `spd ${parity.spdDispatches} dispatches vs legacy ${parity.legacyDispatches}`)
      check(`${mode} storage shape`, parity.words === 172902, `${parity.words} words`)
    }
  } else {
    check(`${mode} spd null contract`, parity === null, parity === null ? 'the FBO pyramid is the GL backend\'s own reduce' : JSON.stringify(parity).slice(0, 160))
  }
  // the loop continues cleanly after the gate's readbacks (the orbiting
  // camera moves the per-frame drawn count — any change proves frames
  // are still executing)
  await page.waitForFunction(before => window.__hizStats.drawn !== before, before, { timeout: 60_000 })
  .then(() => check(`${mode} loop alive after the gate`, true))
  .catch(() => check(`${mode} loop alive after the gate`, false))
  await page.waitForTimeout(400)
  check(`${mode} error-free`, errors.length === 0, errors.slice(0, 3).join(' | '))
  await page.close()
  return errors.length === 0
}

const wgOk = await runLeg('webgpu')
const glOk = await runLeg('webgl2')
await browser.close()
server.stop(true)
console.log(`[214] ${wgOk && glOk && failures === 0 ? 'ALL PASS' : `FAILURES: ${failures}`}`)
process.exit(wgOk && glOk && failures === 0 ? 0 : 1)
