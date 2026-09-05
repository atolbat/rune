// task137-vfx-probe.mjs — THE RE-RUN GATE (the user's report: "the 2nd and
// further WebGL runs show NO particles while the pill keeps counting").
// Four legs, all on the LIVE page with the raw-context draw-drop counter
// hooked (every drawArrays is followed by getError — a drop is recorded
// with the enabled-locations' liveness):
//   A. WebGL2 → gpuEmbers: warm pixels + zero drops (the 1st run);
//   B. the DEMO-SWITCH cycle ×2 (gpuEmbers → laser → back — the tier
//      dispose/re-make on ONE facade: the dangling-enabled-attrib window):
//      warm pixels + ZERO DROPS (the Task 137 disarm);
//   C. the BACKEND round trip (WebGPU verified → WebGL2 — the user's
//      toggle path): warm pixels + zero drops;
//   D. the synthetic webglcontextlost: the zombie guard — the loop stops,
//      the report lands (not a silent black canvas with a counting pill).
import { join } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const root = '/home/z/my-project/rune'
const out = join(root, '.shots', 'task137')
mkdirSync(out, { recursive: true })
const port = 8135

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
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const consoleMsgs = []
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleMsgs.push(m.text().slice(0, 200)) })
page.on('pageerror', (e) => consoleMsgs.push('PAGEERROR: ' + String(e).slice(0, 200)))

// the draw-drop counter (the VAO forensics hook — getError after every draw)
await page.addInitScript(() => {
  window.__glDrops = []
  window.__glDraws = 0
  const orig = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = orig.call(this, type, ...rest)
    if (type === 'webgl2' && ctx != null && !ctx.__hooked) {
      ctx.__hooked = true
      const probe = (name) => {
        const fn = ctx[name].bind(ctx)
        ctx[name] = (...args) => {
          fn(...args)
          window.__glDraws++
          const err = ctx.getError()
          if (err !== 0) {
            const enabled = []
            for (let l = 0; l < 16; l++) {
              try {
                if (ctx.getVertexAttrib(l, ctx.VERTEX_ATTRIB_ARRAY_ENABLED)) {
                  const buf = ctx.getVertexAttrib(l, ctx.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING)
                  enabled.push(l + (buf === null ? ':DELETED' : ':live'))
                }
              } catch { break }
            }
            window.__glDrops.push({ f: window.__vfxFrame ?? -1, fn: name, err, enabled })
          }
        }
      }
      probe('drawArrays')
      const di = ctx.drawArraysInstanced
      if (di != null) {
        ctx.drawArraysInstanced = (...args) => {
          di.apply(ctx, args)
          window.__glDraws++
          const err = ctx.getError()
          if (err !== 0) window.__glDrops.push({ f: window.__vfxFrame ?? -1, fn: 'drawArraysInstanced', err })
        }
      }
    }
    return ctx
  }
})

async function forceMode(mode) {
  await page.click('#rd-fab')
  await page.click(`label[for="mode-${mode}"]`)
  await page.mouse.click(640, 60)
}
async function jumpToEmbers() {
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('button')]
    rows.find((r) => (r.textContent ?? '').includes('GPU Embers'))?.click()
  })
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
function fail(message) { console.error(`[task137] FAIL: ${message}`); process.exitCode = 1 }
function ok(message) { console.log(`[task137] ok — ${message}`) }

// ── A. the 1st WebGL2 run ──
await page.goto(`http://localhost:${port}/demo/vfx/`, { waitUntil: 'networkidle' })
await page.waitForTimeout(1500)
await forceMode('webgl2')
await page.evaluate(() => document.querySelector('.pt-sheet [aria-label=Close]')?.click())
await page.waitForFunction(() => (document.querySelector('#backend')?.textContent ?? '').includes('WebGL2'), null, { timeout: 30_000 })
await jumpToEmbers()
await page.waitForFunction(() => (window.__vfxPerf?.tier ?? '') !== '', null, { timeout: 30_000 })
await page.waitForTimeout(4200)
{
  const warm = await warmPct('legA')
  const drops = await page.evaluate(() => window.__glDrops.length)
  const perf = await page.evaluate(() => ({ ...window.__vfxPerf }))
  console.log(`[task137] A (1st WebGL2 run): warm ${warm}% · drops ${drops} · perf ${JSON.stringify(perf)}`)
  if (warm < 0.5) fail(`leg A: warm ${warm}% — the embers do not render on the 1st WebGL2 run`)
  else ok(`leg A: warm ${warm}%, zero drops` + (drops === 0 ? '' : ` (drops=${drops})`))
  // the container is SwiftShader → the SOFTWARE budget pins the hardware-aware branch
  if (perf.capacity !== 16000) fail(`leg A: capacity ${perf.capacity} — the SwiftShader budget should be 16000 in this container`)
  else ok('leg A: the software-GL budget 16000 (the hardware-aware branch)')
  if (drops > 0) fail(`leg A: ${drops} dropped draws on the FIRST run — not the Task 137 class, investigate`)
}

// ── B. the demo-switch cycles ×2 (one facade, tier dispose → re-make) ──
for (let c = 1; c <= 2; c++) {
  await page.evaluate(() => { window.__glDrops.length = 0 })
  await page.click('.pt-arrow:first-child')
  await page.waitForTimeout(2600)
  const awayDrops = await page.evaluate(() => window.__glDrops.length)
  if (awayDrops > 0) fail(`leg B cycle ${c}: ${awayDrops} dropped draws on the AWAY leg (the dangling class)`)
  await page.evaluate(() => { window.__glDrops.length = 0 })
  await page.click('.pt-arrow:last-child')
  await page.waitForFunction(() => (window.__vfxPerf?.tier ?? '') !== '', null, { timeout: 30_000 })
  await page.waitForTimeout(4200)
  const warm = await warmPct(`legB${c}`)
  const drops = await page.evaluate(() => window.__glDrops.length)
  const count = await page.evaluate(() => (window.__vfxLayers ?? [])[0]?.facade?.count ?? 0)
  console.log(`[task137] B${c} (back to gpuEmbers): warm ${warm}% · drops ${drops} · count ${count}`)
  if (warm < 0.5) fail(`leg B${c}: warm ${warm}% — the embers do not render after the demo-switch cycle`)
  if (drops > 0) fail(`leg B${c}: ${drops} dropped draws after the return — the dangling class`)
}
ok('leg B: the demo-switch cycles render with zero drops')

// ── C. the backend round trip (WebGPU verified → WebGL2) ──
await forceMode('webgpu')
await page.waitForFunction(() => {
  const b = document.querySelector('#backend')?.textContent ?? ''
  return b === 'WebGPU' || b.includes('unavailable') || b.includes('failed')
}, null, { timeout: 40_000 }).catch(() => {})
await page.waitForTimeout(1500)
const midBadge = await page.textContent('#backend').catch(() => '…')
const midPerf = await page.evaluate(() => window.__vfxPerf ? { ...window.__vfxPerf } : null)
console.log(`[task137] C mid: badge=${midBadge} perf=${JSON.stringify(midPerf)}`)
if (midBadge !== 'WebGPU') fail('leg C: the WebGPU middle leg did not boot (the container regression — not the Task 137 class, but the gate needs it)')
await page.evaluate(() => { window.__glDrops.length = 0 })
await forceMode('webgl2')
await page.waitForFunction(() => (document.querySelector('#backend')?.textContent ?? '').includes('WebGL2'), null, { timeout: 30_000 })
await page.waitForTimeout(4200)
{
  const warm = await warmPct('legC')
  const drops = await page.evaluate(() => window.__glDrops.length)
  console.log(`[task137] C (2nd WebGL2 run after WebGPU): warm ${warm}% · drops ${drops}`)
  if (warm < 0.5) fail(`leg C: warm ${warm}% — THE USER'S REPORT reproduced (the 2nd WebGL run is black)`)
  else ok(`leg C: the 2nd WebGL2 run renders (warm ${warm}%), zero drops`)
  if (drops > 0) fail(`leg C: ${drops} dropped draws on the round-trip leg`)
}

// ── D. the synthetic contextlost — the zombie guard ──
{
  // ATOMIC: read the frame counter and dispatch in ONE evaluate — a rAF tick
  // between two separate evaluates would read as a post-loss frame (the race
  // that produced the false 462 → 463 on the first run of this gate).
  const frameBefore = await page.evaluate(() => {
    const f = window.__vfxFrame ?? -1
    const c = document.querySelector('canvas')
    c?.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
    return f
  })
  await page.waitForTimeout(1800)
  const frameAfter = await page.evaluate(() => window.__vfxFrame ?? -1)
  const logText = await page.evaluate(() => document.querySelector('#log-list')?.textContent ?? '')
  const reported = /WebGL context lost — rendering stopped/.test(logText)
  console.log(`[task137] D: frames ${frameBefore} → ${frameAfter} · reported=${reported}`)
  if (frameAfter !== frameBefore) fail(`leg D: the loop kept running after the context loss (${frameBefore} → ${frameAfter}) — the zombie class`)
  else ok('leg D: the loop stopped after the context loss (no zombie)')
  if (!reported) fail('leg D: the context loss was not reported through the error sink')
  else ok('leg D: the context loss reported loudly')
}

const hardErrors = consoleMsgs.filter(m => m.startsWith('PAGEERROR:'))
if (hardErrors.length > 0) {
  fail(`page errors: ${hardErrors.slice(0, 3).join(' | ')}`)
} else {
  ok('no page errors across all legs')
}
console.log(`[task137] ${process.exitCode === 1 ? 'FAILED' : 'PASS'} (drops total: ${await page.evaluate(() => window.__glDrops.length)}, draws: ${await page.evaluate(() => window.__glDraws)})`)
await browser.close()
server.stop(true)
if (process.exitCode === 1) process.exit(1)
