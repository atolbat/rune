// task140d-remake — THE RE-MAKE FORENSICS (Task 140, the resurgent
// "2nd run shows nothing while the counter counts" class).
//
// task140c's instDraws exposed it: the ember draw's instance count ran
// 138660→141329, then the LAST entry read inst=2816 — and the final
// perf.count was 2816 at t≈9s where the steady state is ~100k+. That is
// NOT the burst's death wave (alive ≈ rate×avg-life ≈ 160k) — THE LEDGER
// RESTARTED: the demo RE-MADE mid-page. The user's live symptom ("counter
// grows, particles not visible") is the Task-137 report class verbatim —
// and the Task 137 fix (the deleteBuffer disarm) covered the CPU-tier
// layers' dangling attribs, but the GPU TIER's dispose/re-make path has
// its own surface: the old command's recordsBufferId dies with the tier,
// the new make rebuilds everything... unless something in that path
// breaks the SECOND run's records/draw.
//
// THIS PROBE pins the re-make itself:
//   · a defineProperty trap on window.__vfxPerf — every REASSIGNMENT (the
//     make() writes it) logged with a timestamp + the new capacity;
//   · webglcontextlost / webglcontextrestored listeners (the auto-renderer
//     recovery path — the silent re-make trigger);
//   · the GL error sink + the instanced-draw stream (n/inst over time);
//   · THE RECORDS READBACK on the CURRENT (post-re-make) run — sane or
//     degenerate (the invisible signature: halfMax ~0, ca ~0, zeroRows);
//   · the forced demo-cycle: switch to another demo and BACK (the user's
//     own documented flow — "the 2nd and later runs"), then read again.
import { join } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const root = '/home/z/my-project/rune'
const out = join(root, '.shots', 'task140')
mkdirSync(out, { recursive: true })
const port = 8143

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
  window.__fxInst = [] // last 30 drawArraysInstanced {t, n, inst}
  window.__fxRemakes = [] // {t, capacity} per __vfxPerf REASSIGNMENT
  window.__fxCtxEvents = []
  const SPOOF_RENDERER = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)'
  const UNMASKED_RENDERER = 37446

  // THE RE-MAKE TRAP: every make() writes window.__vfxPerf = perf
  let vfxPerfValue = null
  Object.defineProperty(window, '__vfxPerf', {
    configurable: true,
    get: () => vfxPerfValue,
    set: (v) => {
      vfxPerfValue = v
      window.__fxRemakes.push({ t: +performance.now().toFixed(0), cap: v?.capacity ?? -1, emit: v?.emit, cull: v?.cull })
    },
  })
  window.addEventListener('webglcontextlost', (e) => {
    window.__fxCtxEvents.push({ t: +performance.now().toFixed(0), kind: 'lost', prevented: e.defaultPrevented })
  })
  window.addEventListener('webglcontextrestored', () => {
    window.__fxCtxEvents.push({ t: +performance.now().toFixed(0), kind: 'restored' })
  })

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
            window.__fxInst.push({ t: +t.toFixed(0), n: args[2], inst: args[3] })
            if (window.__fxInst.length > 30) window.__fxInst.shift()
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
      for (const name of ['drawArraysInstanced', 'bindBufferBase', 'endTransformFeedback', 'drawArrays']) hook(name)
    }
    return ctx
  }
})

const consoleMsgs = []
const page = await context.newPage()
page.on('console', (m) => { consoleMsgs.push(`[${m.type()}] ${m.text().slice(0, 250)}`) })
page.on('pageerror', (e) => consoleMsgs.push('PAGEERROR: ' + String(e).slice(0, 250)))

await page.goto(`http://localhost:${port}/demo/vfx/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForTimeout(1200)
await page.click('#rd-fab')
await page.click('label[for="mode-webgl2"]')
await page.mouse.click(240, 30)
await page.evaluate(() => document.querySelector('.pt-sheet [aria-label=Close]')?.click())
await page.waitForFunction(() => (document.querySelector('#backend')?.textContent ?? '').includes('WebGL2'), null, { timeout: 30_000 })
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('button')]
  rows.find((r) => (r.textContent ?? '').includes('GPU Embers'))?.click()
})
await page.waitForFunction(() => (window.__vfxPerf?.tier ?? '') !== '', null, { timeout: 30_000 })

// ── RUN 1: settle, snapshot the draw stream + the records ──────────────
await page.waitForTimeout(5000)
const run1 = await page.evaluate(() => ({
  perf: window.__vfxPerf ? { ...window.__vfxPerf } : null,
  remakes: window.__fxRemakes,
  ctxEvents: window.__fxCtxEvents,
  instTail: window.__fxInst.slice(-6),
  errors: window.__fxErrors.slice(-6),
}))
console.log('[task140d] RUN1 perf: ' + JSON.stringify(run1.perf))
console.log('[task140d] RUN1 remakes: ' + JSON.stringify(run1.remakes))
console.log('[task140d] RUN1 ctxEvents: ' + JSON.stringify(run1.ctxEvents))
console.log('[task140d] RUN1 instTail: ' + JSON.stringify(run1.instTail))
console.log('[task140d] RUN1 glErrors: ' + (run1.errors.length === 0 ? 'NONE' : JSON.stringify(run1.errors)))

// ── THE USER'S FLOW: switch away and BACK — the 2nd run ────────────────
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('button')]
  rows.find((r) => (r.textContent ?? '').includes('Fireflies'))?.click()
})
await page.waitForTimeout(1200)
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('button')]
  rows.find((r) => (r.textContent ?? '').includes('GPU Embers'))?.click()
})
await page.waitForFunction(() => (window.__vfxPerf?.tier ?? '') !== '', null, { timeout: 30_000 })
await page.waitForTimeout(4000)

// ── RUN 2: the draw stream + THE RECORDS of the second make ────────────
const run2 = await page.evaluate(() => {
  const canvas = document.querySelector('canvas')
  const gl = canvas ? canvas.getContext('webgl2') : null
  const perf = window.__vfxPerf ?? {}
  const count = perf.count ?? 0
  const cap = perf.capacity ?? 0
  // the LAST distinct TF-bound buffers (a complete frame's four: records,
  // pairs, state, emit — newest last is records... walk backward)
  const binds = window.__fxTfBinds ?? []
  const uniq = []
  for (let i = binds.length - 1; i >= 0 && uniq.length < 4; i--) {
    if (!uniq.some((b) => b === binds[i])) uniq.push(binds[i])
  }
  const results = []
  if (gl != null && uniq.length > 0) {
    const rec = uniq[0] // the most recent TF bind = the packSorted output = records
    const n = Math.min(Math.max(count, 256), 8192)
    const arr = new Float32Array(Math.min(cap * 16, n * 16))
    try {
      gl.bindBuffer(gl.COPY_READ_BUFFER, rec)
      gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, arr)
      gl.bindBuffer(gl.COPY_READ_BUFFER, null)
    } catch (e) { results.push({ error: String(e).slice(0, 120) }) }
    if (results.length === 0) {
      let zeroRows = 0, halfMax = 0, caMax = 0, nan = 0
      const rows = Math.floor(arr.length / 16)
      for (let i = 0; i < rows; i++) {
        const b = i * 16
        let allZero = true
        for (let k = 0; k < 16; k++) { if (arr[b + k] !== 0) { allZero = false; break } }
        if (allZero) { zeroRows++; continue }
        if (Number.isNaN(arr[b + 10]) || Number.isNaN(arr[b + 9])) nan++
        halfMax = Math.max(halfMax, Math.abs(arr[b + 10]))
        caMax = Math.max(caMax, Math.abs(arr[b + 9]))
      }
      results.push({ rows, zeroRows, halfMax: +halfMax.toFixed(4), caMax: +caMax.toFixed(4), nan,
        firstRow: Array.from(arr.slice(0, 16)).map((v) => +v.toFixed(3)) })
    }
  } else results.push({ error: 'no gl/binds' })
  return {
    perf: { ...perf },
    remakes: window.__fxRemakes,
    ctxEvents: window.__fxCtxEvents,
    instTail: window.__fxInst.slice(-6),
    errors: window.__fxErrors.slice(-8),
    records: results,
  }
})
console.log('[task140d] RUN2 perf: ' + JSON.stringify(run2.perf))
console.log('[task140d] RUN2 remakes: ' + JSON.stringify(run2.remakes))
console.log('[task140d] RUN2 ctxEvents: ' + JSON.stringify(run2.ctxEvents))
console.log('[task140d] RUN2 instTail: ' + JSON.stringify(run2.instTail))
console.log('[task140d] RUN2 glErrors: ' + (run2.errors.length === 0 ? 'NONE' : JSON.stringify(run2.errors)))
console.log('[task140d] RUN2 records: ' + JSON.stringify(run2.records))

// ── the pixel verdict on the 2nd run ────────────────────────────────────
{
  const clip = await page.evaluate(() => {
    const c = document.querySelector('canvas')
    if (!c) return null
    const r = c.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
  })
  if (clip != null) {
    let warm = -1
    try {
      const path = join(out, 'remake-run2.png')
      await page.screenshot({ path, clip, timeout: 40_000 })
      const png = PNG.sync.read(readFileSync(path))
      const { width: W, height: H, data } = png
      let w = 0
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4
        if (data[i] > 40 && data[i] > data[i + 1] * 1.15 && data[i + 1] > data[i + 2] * 1.05) w++
      }
      warm = +(100 * w / (W * H)).toFixed(3)
    } catch { warm = -2 }
    console.log(`[task140d] RUN2 pixels: warm ${warm}%`)
    const rec = run2.records[0] ?? {}
    const broken = rec.error !== undefined || rec.halfMax === 0 || (rec.zeroRows ?? 1) >= (rec.rows ?? 1)
    if (warm <= 0 && broken) console.log('[task140d] VERDICT: REPRODUCED — the 2nd run draws nothing AND its records are degenerate')
    else if (warm <= 0) console.log('[task140d] VERDICT: pixels cold (records sane or unreadable — SwiftShader raster may starve)')
    else console.log('[task140d] VERDICT: the 2nd run is WARM — no reproduction')
  }
}

console.log('[task140d] console (last 12): ' + JSON.stringify(consoleMsgs.slice(-12)))
await browser.close()
server.stop(true)
