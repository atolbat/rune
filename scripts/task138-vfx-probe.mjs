// task138-vfx-probe.mjs — THE REAL-GPU TF PIPELINE DEFAULTS GATE (Task 138:
// the last remaining item of the optimization program — the hardware oracle
// confirmed the real-GPU TF queue behavior, so the WebGL2 transform-feedback
// leg now takes the FULL GPU pipeline (emit:'gpu' + the frustum cull) by
// DEFAULT on anything but the software-GL class; SwiftShader/llvmpipe keep
// the proven conservative CPU path).
//
// The container is SwiftShader — the SOFTWARE branch — so this gate pins:
//   A. the DEFAULT leg stays conservative: softwareGL true, emit 'cpu',
//      cull false, sort false, capacity 16000, the embers RENDER (warm
//      pixels — the flag-surgery regression guard);
//   B. ?emit=1&cull=1 force the GPU pipeline ON (the override mechanics +
//      the JS-side aliveness — the task134-vfx-probe convention: the
//      FORCED combinations saturate the software raster (~460 ms/frame at
//      16k; the compositor falls >90 s behind while the JS loop stays
//      alive — the documented busy-rasterizer class), so no pixel gate on
//      this leg; the VALUES are pinned by task135-glsl-emit / the sort
//      gates);
//   C. ?emit=0&cull=0 force it OFF explicitly (the escape hatch parses —
//      and renders: the same load as the default leg);
//   D. the BARE ?emit keeps the Task 135 force-on meaning (backward compat);
//   E. ?sort=1 parses (the pure opt-in — JS-side aliveness, leg B's class).
// The REAL-GPU branch (emit 'gpu' + cull true by default) cannot run here —
// it is the user's live confirmation (the hardware oracle) + the value gates
// (task135-glsl-emit pinned the TF emit values on a real WebGL2 context).
//
// THE HARNESS LESSONS of this gate's own development (pinned here):
//   · a leg's demo can be made SEVERAL times in quick succession (the
//     backend-toggle reboot re-makes the active demo; a stray click during
//     the toggle can switch demos) — reads that straddle two make()
//     generations see a count that "resets". THE SETTLE LOOP: read the perf
//     object's identity twice 1 s apart and only trust a STABLE generation;
//   · a saturated SwiftShader renderer chokes even a FOLLOW-UP navigation
//     (a 60 s goto timeout at domcontentloaded) — every leg gets a FRESH
//     PAGE (page.close() force-kills the busy renderer; the next page gets
//     a clean process);
//   · the aliveness oracle under a saturated raster is "the count is not
//     FROZEN" (count differs across 1 s — at ~2 fps the emission/death
//     ledger still changes every frame; an exact equality means a dead
//     loop) — NOT "the count climbs" (the burst's natural retirement
//     declines the count from ~4 s).
// The draw-drop counter rides along on every leg (a dropped draw on any
// flag combination is a regression of the Task 137 class).
import { join } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const root = '/home/z/my-project/rune'
const out = join(root, '.shots', 'task138')
mkdirSync(out, { recursive: true })
const port = 8138

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
    const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }
    return new Response(file, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan'],
})
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })

// the draw-drop counter (the Task 137 forensics hook — getError after every
// draw) — the init script is CONTEXT-level: every fresh page gets it.
await context.addInitScript(() => {
  window.__glDrops = []
  window.__glDraws = 0
  const orig = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = orig.call(this, type, ...rest)
    if (type === 'webgl2' && ctx != null && !ctx.__hooked) {
      ctx.__hooked = true
      const hook = (name, fn) => {
        ctx[name] = (...args) => {
          fn(...args)
          window.__glDraws++
          const err = ctx.getError()
          if (err !== 0) window.__glDrops.push({ fn: name, err })
        }
      }
      hook('drawArrays', ctx.drawArrays.bind(ctx))
      if (ctx.drawArraysInstanced != null) hook('drawArraysInstanced', ctx.drawArraysInstanced.bind(ctx))
    }
    return ctx
  }
})

const consoleMsgs = []
let page = null

function fail(message) { console.error(`[task138] FAIL: ${message}`); process.exitCode = 1 }
function ok(message) { console.log(`[task138] ok — ${message}`) }

async function freshPage() {
  if (page !== null) await page.close().catch(() => { /* the saturated renderer dies loudly — fine */ })
  page = await context.newPage()
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleMsgs.push(m.text().slice(0, 200)) })
  page.on('pageerror', (e) => consoleMsgs.push('PAGEERROR: ' + String(e).slice(0, 200)))
  return page
}

async function warmPct(tag) {
  let best = 0
  for (let i = 0; i < 3; i++) {
    const clip = await page.evaluate(() => {
      const c = document.querySelector('canvas')
      if (!c) return null
      const r = c.getBoundingClientRect()
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
    })
    if (clip == null) break
    const path = join(out, `${tag}-${i}.png`)
    await page.screenshot({ path, clip, timeout: 90_000 })
    const png = PNG.sync.read(readFileSync(path))
    const { width: W, height: H, data } = png
    let warm = 0
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const k = (y * W + x) * 4
        const r = data[k], g = data[k + 1], b = data[k + 2]
        if (r > 40 && r > g * 1.15 && g > b * 1.05) warm++
      }
    }
    best = Math.max(best, 100 * warm / (W * H))
    if (i < 2) await page.waitForTimeout(800)
  }
  return +best.toFixed(2)
}

// one leg = one FRESH PAGE (the flags are module-scope; a saturated
// renderer from the previous leg must not choke this leg's navigation),
// the WebGL2 backend forced, the gpuEmbers demo jumped to, the generation
// SETTLED (the perf object's identity stable across 1 s — the reboot
// re-make storm at the toggle must not straddle the reads), then the
// aliveness window (count not frozen) + the pixel gate on the pixel legs.
async function leg(tag, query, pixel) {
  await freshPage()
  await page.goto(`http://localhost:${port}/demo/vfx/${query}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(1500)
  await page.click('#rd-fab')
  await page.click('label[for="mode-webgl2"]')
  await page.mouse.click(640, 60)
  await page.evaluate(() => document.querySelector('.pt-sheet [aria-label=Close]')?.click())
  await page.waitForFunction(() => (document.querySelector('#backend')?.textContent ?? '').includes('WebGL2'), null, { timeout: 30_000 })
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('button')]
    rows.find((r) => (r.textContent ?? '').includes('GPU Embers'))?.click()
  })
  await page.waitForFunction(() => (window.__vfxPerf?.tier ?? '') !== '', null, { timeout: 30_000 })

  // THE SETTLE LOOP: the demo can be re-made several times right after the
  // toggle (the reboot path re-makes the active demo; a stray click during
  // the toggle switches it) — only trust a generation whose perf object is
  // the SAME object 1 s apart. The aliveness oracle rides the same window:
  // the count must CHANGE (the emission/death ledger writes every frame —
  // an exact equality across 1 s is a FROZEN loop, the zombie class).
  const readGen = () => page.evaluate(() => {
    const p = window.__vfxPerf
    if (p == null) return null
    if (p.__probeId === undefined) p.__probeId = Math.random()
    return { id: p.__probeId, tier: p.tier, capacity: p.capacity, count: p.count, ms: p.ms, emit: p.emit, cull: p.cull, sort: p.sort, softwareGL: p.softwareGL }
  })
  let settled = null
  for (let attempt = 0; attempt < 4 && settled === null; attempt++) {
    const a = await readGen()
    if (a === null) { await page.waitForTimeout(700); continue }
    await page.waitForTimeout(1000)
    const b = await readGen()
    if (b === null || a.id !== b.id) { await page.waitForTimeout(700); continue }
    settled = { a, b }
  }
  if (settled === null) {
    fail(`${tag}: the demo generation never stabilized (4 windows) — the re-make storm class`)
    return { a: null, b: null, warm: -1, drops: -1 }
  }
  const warm = pixel ? await warmPct(tag) : -1
  const drops = await page.evaluate(() => window.__glDrops.length)
  const { a, b } = settled
  console.log(`[task138] ${tag}${query === '' ? ' (default)' : ` ${query}`} — policy ${JSON.stringify(a)} · count ${a.count} → ${b.count} (${b.count === a.count ? 'FROZEN' : 'alive'}) · warm ${warm}% · drops ${drops}`)
  return { a, b, warm, drops }
}

// ── A. the DEFAULT leg: the software branch stays conservative ──
{
  const { a, b, warm, drops } = await leg('legA', '', true)
  if (a !== null) {
    const checks = [
      [a.softwareGL === true, 'softwareGL true (the container branch)'],
      [a.capacity === 16000, `capacity 16000 (got ${a.capacity})`],
      [a.emit === 'cpu', `emit 'cpu' (got ${a.emit})`],
      [a.cull === false, `cull false (got ${a.cull})`],
      [a.sort === false, `sort false (got ${a.sort})`],
      [warm >= 0.5, `warm ${warm}% — the embers render on the default leg`],
      [a.count > 3000 && b.count !== a.count, `the count alive (${a.count} → ${b.count})`],
      [drops === 0, `zero dropped draws (got ${drops})`],
    ]
    for (const [pass, label] of checks) (pass ? ok : fail)(`leg A: ${label}`)
  }
}

// ── B. ?emit=1&cull=1: the force-on override (the GPU pipeline on the
//      software class too — JS-side aliveness: the policy fields, the live
//      ledger, zero drops; the raster saturation is the software class's
//      own documented constraint, measured again by this leg) ──
{
  const { a, b, drops } = await leg('legB', '?emit=1&cull=1', false)
  if (a !== null) {
    const checks = [
      [a.emit === 'gpu', `emit 'gpu' (got ${a.emit})`],
      [a.cull === true, `cull true (got ${a.cull})`],
      [a.count > 3000 && b.count !== a.count, `the count alive under the forced pipeline (${a.count} → ${b.count}) — the GPU emission's ledger runs`],
      [drops === 0, `zero dropped draws (got ${drops})`],
    ]
    for (const [pass, label] of checks) (pass ? ok : fail)(`leg B: ${label}`)
  }
}

// ── C. ?emit=0&cull=0: the explicit escape hatch parses ──
{
  const { a, b, warm, drops } = await leg('legC', '?emit=0&cull=0', true)
  if (a !== null) {
    const checks = [
      [a.emit === 'cpu', `emit 'cpu' (got ${a.emit})`],
      [a.cull === false, `cull false (got ${a.cull})`],
      [warm >= 0.5, `warm ${warm}% — the escape hatch renders`],
      [a.count > 3000 && b.count !== a.count, `the count alive (${a.count} → ${b.count})`],
      [drops === 0, `zero dropped draws (got ${drops})`],
    ]
    for (const [pass, label] of checks) (pass ? ok : fail)(`leg C: ${label}`)
  }
}

// ── D. the BARE ?emit: the Task 135 force-on meaning stands ──
{
  const { a } = await leg('legD', '?emit', false)
  if (a !== null) (a.emit === 'gpu' ? ok : fail)(`leg D: the bare ?emit forces emit 'gpu' (got ${a.emit})`)
}

// ── E. ?sort=1: the pure opt-in parses (JS-side aliveness — leg B's class) ──
{
  const { a, b, drops } = await leg('legE', '?sort=1', false)
  if (a !== null) {
    const checks = [
      [a.sort === true, `sort true (got ${a.sort})`],
      [a.count > 3000 && b.count !== a.count, `the count alive under the sorted network (${a.count} → ${b.count})`],
      [drops === 0, `zero dropped draws (got ${drops})`],
    ]
    for (const [pass, label] of checks) (pass ? ok : fail)(`leg E: ${label}`)
  }
}

const hardErrors = consoleMsgs.filter((m) => m.startsWith('PAGEERROR:'))
if (hardErrors.length > 0) fail(`page errors: ${hardErrors.slice(0, 3).join(' | ')}`)
else ok('no page errors across all legs')
console.log(`[task138] ${process.exitCode === 1 ? 'FAILED' : 'PASS'}`)
await browser.close()
server.stop(true)
if (process.exitCode === 1) process.exit(1)
