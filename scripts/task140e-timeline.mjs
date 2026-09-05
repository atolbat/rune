// task140e — THE DEFINITIVE 160k TIMELINE (Task 140).
//
// task140d exposed: (1) run 1 healthy (count 135k, draws flowing, zero GL
// errors, ONE make) — but the probe's phase 2 hung because the demo sheet
// had CLOSED (the 'Fireflies' button find failed silently) and a single
// 15.8-SECOND frame appeared in the draw timeline (the freeze class, at
// 480×320, count ~135k); (2) no pixel verdict was captured during the
// early fast phase.
//
// THIS PROBE: the full timeline discipline —
//   · the pixel verdict EARLY (t≈4s, the post-burst fast phase) — the
//     160k warm-pixel answer the starved 1280×800 legs could never give;
//   · the records readback at the same moment (sane/degenerate);
//   · the demo-cycle done RIGHT: the sheet REOPENED (#rd-fab) before the
//     Fireflies switch, then reopened again for the GPU Embers return;
//   · fixed sleeps only (no raf-polling waitForFunction — a saturated
//     loop starves the poll), the frame-tick deltas logged per phase;
//   · the __vfxPerf reassignment trap (the re-make log) + console.
import { join } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const root = '/home/z/my-project/rune'
const out = join(root, '.shots', 'task140')
mkdirSync(out, { recursive: true })
const port = 8144

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
const context = await browser.newContext({ viewport: { width: 480, height: 320 } })
await context.addInitScript(() => {
  window.__fxErrors = []
  window.__fxFrames = 0
  window.__fxInst = [] // last 40 drawArraysInstanced {t, inst}
  window.__fxRemakes = []
  window.__fxCtxEvents = []
  const SPOOF_RENDERER = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)'
  const UNMASKED_RENDERER = 37446
  let vfxPerfValue = null
  Object.defineProperty(window, '__vfxPerf', {
    configurable: true,
    get: () => vfxPerfValue,
    set: (v) => {
      vfxPerfValue = v
      window.__fxRemakes.push({ t: +performance.now().toFixed(0), cap: v?.capacity ?? -1, emit: v?.emit, cull: v?.cull })
    },
  })
  window.addEventListener('webglcontextlost', (e) => window.__fxCtxEvents.push({ t: Math.round(performance.now()), kind: 'lost' }))
  window.addEventListener('webglcontextrestored', () => window.__fxCtxEvents.push({ t: Math.round(performance.now()), kind: 'restored' }))
  const orig = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = orig.call(this, type, ...rest)
    if (type === 'webgl2' && ctx != null && !ctx.__fxHooked) {
      ctx.__fxHooked = true
      const origGetParameter = ctx.getParameter.bind(ctx)
      ctx.getParameter = (pname, ...pr) => (pname === UNMASKED_RENDERER ? SPOOF_RENDERER : origGetParameter(pname, ...pr))
      const TF_TARGET = ctx.TRANSFORM_FEEDBACK_BUFFER
      const hook = (name) => {
        const fn = ctx[name].bind(ctx)
        ctx[name] = (...args) => {
          const t = performance.now()
          const r = fn(...args)
          if (name === 'drawArraysInstanced') {
            window.__fxInst.push({ t: +t.toFixed(0), inst: args[3] })
            if (window.__fxInst.length > 40) window.__fxInst.shift()
          } else if (name === 'bindBufferBase' && args[0] === TF_TARGET && args[2] !== null) {
            if (window.__fxTfBinds == null) window.__fxTfBinds = []
            window.__fxTfBinds.push(args[2])
            if (window.__fxTfBinds.length > 12) window.__fxTfBinds.shift()
          }
          if (name === 'endTransformFeedback') window.__fxFrames++
          const err = ctx.getError()
          if (err !== 0) window.__fxErrors.push({ name, err, t: +t.toFixed(0) })
          return r
        }
      }
      for (const name of ['drawArraysInstanced', 'bindBufferBase', 'endTransformFeedback']) hook(name)
    }
    return ctx
  }
})

const consoleMsgs = []
const page = await context.newPage()
page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text().slice(0, 220)}`))
page.on('pageerror', (e) => consoleMsgs.push('PAGEERROR: ' + String(e).slice(0, 220)))

function warmOf(png) {
  const { width: W, height: H, data } = png
  let w = 0, lit = 0
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4
    if (data[i] > 40 && data[i] > data[i + 1] * 1.15 && data[i + 1] > data[i + 2] * 1.05) w++
    if (data[i] + data[i + 1] + data[i + 2] > 90) lit++
  }
  return { warm: +(100 * w / (W * H)).toFixed(3), lit: +(100 * lit / (W * H)).toFixed(3) }
}

async function shot(tag) {
  const clip = await page.evaluate(() => {
    const c = document.querySelector('canvas')
    if (!c) return null
    const r = c.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
  }).catch(() => null)
  if (clip == null) return { error: 'no clip' }
  try {
    const path = join(out, `${tag}.png`)
    await page.screenshot({ path, clip, timeout: 25_000 })
    return warmOf(PNG.sync.read(readFileSync(path)))
  } catch { return { starved: true } }
}

async function readState() {
  return page.evaluate(() => {
    const perf = window.__vfxPerf ?? {}
    const count = perf.count ?? 0
    const cap = perf.capacity ?? 0
    const binds = window.__fxTfBinds ?? []
    const uniq = []
    for (let i = binds.length - 1; i >= 0 && uniq.length < 1; i--) {
      if (!uniq.some((b) => b === binds[i])) uniq.push(binds[i])
    }
    const records = []
    if (uniq.length > 0) {
      const canvas = document.querySelector('canvas')
      const gl = canvas ? canvas.getContext('webgl2') : null
      if (gl != null) {
        const n = Math.min(Math.max(count, 256), 4096)
        const arr = new Float32Array(n * 16)
        try {
          gl.bindBuffer(gl.COPY_READ_BUFFER, uniq[0])
          gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, arr)
          gl.bindBuffer(gl.COPY_READ_BUFFER, null)
          let zeroRows = 0, halfMax = 0, caMax = 0, nan = 0, posSpread = 0
          const rows = n
          for (let i = 0; i < rows; i++) {
            const b = i * 16
            let allZero = true
            for (let k = 0; k < 16; k++) if (arr[b + k] !== 0) { allZero = false; break }
            if (allZero) { zeroRows++; continue }
            if (Number.isNaN(arr[b + 10]) || Number.isNaN(arr[b + 9]) || Number.isNaN(arr[b])) nan++
            halfMax = Math.max(halfMax, Math.abs(arr[b + 10]))
            caMax = Math.max(caMax, Math.abs(arr[b + 9]))
            posSpread = Math.max(posSpread, Math.abs(arr[b]) + Math.abs(arr[b + 1]) + Math.abs(arr[b + 2]))
          }
          records.push({ rows, zeroRows, halfMax: +halfMax.toFixed(4), caMax: +caMax.toFixed(4), nan, posSpread: +posSpread.toFixed(2),
            first: Array.from(arr.slice(0, 8)).map((v) => +v.toFixed(3)) })
        } catch (e) { records.push({ error: String(e).slice(0, 100) }) }
      } else records.push({ error: 'no gl' })
    } else records.push({ error: 'no tf binds' })
    return {
      perf: { count, cap, emit: perf.emit, cull: perf.cull, ms: perf.ms },
      remakes: window.__fxRemakes,
      ctx: window.__fxCtxEvents,
      frames: window.__fxFrames,
      tick: window.__vfxFrame ?? -1,
      instTail: window.__fxInst.slice(-4),
      errors: window.__fxErrors.slice(-4),
      records,
    }
  }).catch((e) => ({ crash: String(e).slice(0, 150) }))
}

// ── boot ────────────────────────────────────────────────────────────────
await page.goto(`http://localhost:${port}/demo/vfx/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForTimeout(1000)
await page.click('#rd-fab')
await page.click('label[for="mode-webgl2"]')
await page.waitForTimeout(400)
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('button')]
  rows.find((r) => (r.textContent ?? '').includes('GPU Embers'))?.click()
})
await page.waitForTimeout(4000) // the post-burst fast phase

const early = await readState()
console.log('[task140e] EARLY state: ' + JSON.stringify(early))
const earlyShot = await shot('early-160k')
console.log('[task140e] EARLY pixels: ' + JSON.stringify(earlyShot))

// ── the user's flow: away and back (the sheet REOPENED each time) ───────
await page.click('#rd-fab').catch(() => {})
await page.waitForTimeout(300)
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('button')]
  rows.find((r) => (r.textContent ?? '').includes('Fireflies'))?.click()
})
await page.waitForTimeout(1500)
const midState = await readState()
console.log('[task140e] MID (fireflies): ' + JSON.stringify({ perf: midState.perf, remakes: midState.remakes, tick: midState.tick }))

await page.click('#rd-fab').catch(() => {})
await page.waitForTimeout(300)
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('button')]
  rows.find((r) => (r.textContent ?? '').includes('GPU Embers'))?.click()
})
await page.waitForTimeout(3500)

const run2 = await readState()
console.log('[task140e] RUN2 state: ' + JSON.stringify(run2))
const run2Shot = await shot('remake-run2')
console.log('[task140e] RUN2 pixels: ' + JSON.stringify(run2Shot))

// ── the verdicts ────────────────────────────────────────────────────────
{
  const r1 = early.records[0] ?? {}
  const r2 = run2.records[0] ?? {}
  const sane1 = r1.error === undefined && r1.halfMax > 0.001 && (r1.zeroRows ?? 1) < (r1.rows ?? 1)
  const sane2 = r2.error === undefined && r2.halfMax > 0.001 && (r2.zeroRows ?? 1) < (r2.rows ?? 1)
  const warm1 = earlyShot.warm ?? -1
  const warm2 = run2Shot.warm ?? -1
  console.log('── THE VERDICTS ──')
  console.log(`early: records ${sane1 ? 'SANE' : `BROKEN(${JSON.stringify(r1)})`} · pixels warm ${warm1}%`)
  console.log(`run2 : records ${sane2 ? 'SANE' : `BROKEN(${JSON.stringify(r2)})`} · pixels warm ${warm2}%`)
  if (warm1 <= 0 && sane1) console.log('[task140e] !!! records SANE but pixels COLD at 160k — THE RASTER PATH IS THE INVISIBLE ROOT (reproduced!)')
  if (warm2 <= 0 && sane2 && warm1 > 0) console.log('[task140e] !!! run1 warm, run2 COLD — THE RE-MAKE CLASS (reproduced!)')
  if (warm1 > 0 && warm2 > 0) console.log('[task140e] both runs warm — no in-container reproduction of the invisible symptom')
}
console.log('[task140e] console (last 10): ' + JSON.stringify(consoleMsgs.slice(-10)))
await browser.close()
server.stop(true)
