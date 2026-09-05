// task140-real-config-probe — THE USER'S EXACT PAGE CONFIG, in the container.
//
// The user's live report on a REAL GPU after Task 139 (the freeze fix):
// "Не зависают, но частицы не видны, счетчик снизу работает и увеличивается."
// — no freeze anymore (the v=139 packed-slot fix landed), but ZERO particles
// while the CPU life ledger counts. Task 139's forensics validated the
// forced GPU pipeline (?emit=1&cull=1) at the CONTAINER's 16k budget; the
// user's default path differs in TWO ways the container never ran:
//   1. TF_CAPACITY = 160_000 (SOFTWARE_GL=false — the demo's hardware
//      probe takes the full tier);
//   2. the DEFAULT branch (no flags — emit:'gpu' + cull by default).
//
// THIS PROBE spoofs UNMASKED_RENDERER_WEBGL before the page boots → the
// demo's SOFTWARE_GL IIFE sees a "real GPU" string → the page takes the
// user's EXACT config (160k + GPU emission + the cull, no flags) — while
// the actual raster stays SwiftShader. The 2×2 bisect matrix over the
// escape hatches (?emit=0 / ?cull=0) pins WHICH default breaks it, IF the
// container reproduces at all. Records readback + the degenerate-record
// scan (halfMax ~0 AND alpha ~0 = the invisible signature) + the GL error
// sink + the trace's per-pass drawArrays vertex counts.
import { join } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const root = '/home/z/my-project/rune'
const out = join(root, '.shots', 'task140')
mkdirSync(out, { recursive: true })
const port = 8140

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

// THE HARNESS: the GL tracer (Task 139's) + THE RENDERER SPOOF. The spoof
// must exist before ANY page script — addInitScript runs first — so the
// demo's module-scope SOFTWARE_GL probe reads a real-GPU string and takes
// the 160k + full-pipeline default branch. The actual hardware stays
// SwiftShader (the point: the PAGE CONFIG of the user, on the only GPU we
// have).
await context.addInitScript(() => {
  window.__fxErrors = []
  window.__fxTrace = [] // the LAST 1500 calls, ring-style
  window.__fxTfBinds = []
  window.__fxFrames = 0
  const RING = 1500
  const push = (entry) => {
    window.__fxTrace.push(entry)
    if (window.__fxTrace.length > RING) window.__fxTrace.splice(0, window.__fxTrace.length - RING)
  }
  const SPOOF_RENDERER = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)'
  const UNMASKED_RENDERER = 37446
  const orig = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = orig.call(this, type, ...rest)
    if (type === 'webgl2' && ctx != null && !ctx.__fxHooked) {
      ctx.__fxHooked = true
      // ── THE SPOOF ──
      const origGetParameter = ctx.getParameter.bind(ctx)
      ctx.getParameter = (pname, ...pr) => {
        if (pname === UNMASKED_RENDERER) return SPOOF_RENDERER
        return origGetParameter(pname, ...pr)
      }
      // ── the tracer ──
      const TF_TARGET = ctx.TRANSFORM_FEEDBACK_BUFFER
      const hook = (name) => {
        const fn = ctx[name].bind(ctx)
        ctx[name] = (...args) => {
          const t0 = performance.now()
          const r = fn(...args)
          const cost = performance.now() - t0
          if (name === 'bindBufferBase' && args[0] === TF_TARGET) {
            if (args[2] !== null) {
              window.__fxTfBinds.push({ buf: args[2], t: t0 })
              if (window.__fxTfBinds.length > 24) window.__fxTfBinds.shift()
            }
          } else {
            push({ name, cost: +cost.toFixed(2), n: name === 'drawArraysInstanced' ? args[3] : (name === 'drawArrays' ? args[2] : undefined) })
          }
          if (name === 'endTransformFeedback') window.__fxFrames++
          const err = ctx.getError()
          if (err !== 0) window.__fxErrors.push({ name, err, t: +t0.toFixed(0) })
          return r
        }
      }
      for (const name of [
        'bufferData', 'bufferSubData', 'texSubImage2D', 'texImage2D',
        'drawArrays', 'drawArraysInstanced', 'bindBufferBase', 'beginTransformFeedback',
        'endTransformFeedback', 'vertexAttribPointer', 'enableVertexAttribArray',
        'getBufferSubData', 'bindVertexArray',
      ]) hook(name)
    }
    return ctx
  }
})

const consoleMsgs = []
let page = null
function fail(message) { console.error(`[task140] FAIL: ${message}`); process.exitCode = 1 }
function ok(message) { console.log(`[task140] ok — ${message}`) }

async function freshPage() {
  if (page !== null) await page.close().catch(() => {})
  page = await context.newPage()
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleMsgs.push(m.text().slice(0, 300)) })
  page.on('pageerror', (e) => consoleMsgs.push('PAGEERROR: ' + String(e).slice(0, 300)))
  return page
}

// the records/state readback + the degenerate-record scan (in-page).
// records layout (16 floats): r0=(px,py,pz,vx) r1=(vy,vz,cr,cg)
// r2=(cb,ca,halfExtent,angle) r3=(age,seed,u0,v0)
// THE INVISIBLE SIGNATURE: records present but degenerate — halfExtent ~0
// AND alpha ~0 AND positions collapsed — the state never carried a live
// particle (the TF write or its round-trip silently dropped → the texture
// stayed zeros → every record degenerate) while the CPU ledger counts.
async function readTfBuffers() {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas')
    const gl = canvas ? canvas.getContext('webgl2') : null
    if (gl == null || window.__fxTfBinds.length === 0) return { error: 'no canvas/ctx/binds' }
    const perf = window.__vfxPerf ?? {}
    const count = perf.count ?? 0
    const cap = perf.capacity ?? 0
    const uniq = []
    for (let i = window.__fxTfBinds.length - 1; i >= 0 && uniq.length < 4; i--) {
      const b = window.__fxTfBinds[i].buf
      if (!uniq.some((u) => u.buf === b)) uniq.push({ buf: b, role: ['records', 'pairsOrSort', 'state', 'emit'][uniq.length] })
    }
    const read = (buf, floats) => {
      const arr = new Float32Array(floats)
      gl.bindBuffer(gl.COPY_READ_BUFFER, buf)
      gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, arr)
      gl.bindBuffer(gl.COPY_READ_BUFFER, null)
      return arr
    }
    const scan = (arr, n, stride, label) => {
      const s = { label, n, nan: 0, inf: 0, zeroRows: 0, posMin: [1e9, 1e9, 1e9], posMax: [-1e9, -1e9, -1e9], halfMax: 0, halfMin: 1e9, ca: [1e9, -1e9], cr: [1e9, -1e9], allAtOrigin: 0, firstRow: [] }
      for (let i = 0; i < n; i++) {
        const b = i * stride
        let allZero = true
        for (let k = 0; k < stride; k++) {
          const v = arr[b + k]
          if (v !== 0) allZero = false
          if (Number.isNaN(v)) s.nan++
          else if (!Number.isFinite(v)) s.inf++
        }
        if (allZero) { s.zeroRows++; continue }
        const px = arr[b], py = arr[b + 1], pz = arr[b + 2]
        s.posMin[0] = Math.min(s.posMin[0], px); s.posMin[1] = Math.min(s.posMin[1], py); s.posMin[2] = Math.min(s.posMin[2], pz)
        s.posMax[0] = Math.max(s.posMax[0], px); s.posMax[1] = Math.max(s.posMax[1], py); s.posMax[2] = Math.max(s.posMax[2], pz)
        if (Math.abs(px) < 1e-6 && Math.abs(py) < 1e-6 && Math.abs(pz) < 1e-6) s.allAtOrigin++
        if (stride === 16) {
          s.halfMax = Math.max(s.halfMax, Math.abs(arr[b + 10]))
          s.halfMin = Math.min(s.halfMin, Math.abs(arr[b + 10]))
          const ch = (k, lo) => { s[lo][0] = Math.min(s[lo][0], arr[b + k]); s[lo][1] = Math.max(s[lo][1], arr[b + k]) }
          ch(6, 'cr'); ch(9, 'ca')
        }
      }
      if (s.halfMin === 1e9) s.halfMin = -1
      if (i0(s)) s.firstRow = Array.from(arr.slice(0, 16)).map((v) => +v.toFixed(3))
      function i0(s) { return true }
      const r2 = (v) => (Math.abs(v) > 1e8 ? 1e9 : +v.toFixed(3))
      s.posMin = s.posMin.map(r2); s.posMax = s.posMax.map(r2)
      for (const k of ['ca', 'cr']) s[k] = s[k].map(r2)
      s.halfMax = +s.halfMax.toFixed(4); s.halfMin = +s.halfMin.toFixed(4)
      return s
    }
    const results = []
    const n = Math.min(Math.max(count, 64), 16384)
    for (const u of uniq) {
      let arr
      try { arr = read(u.buf, cap * (u.role === 'records' ? 16 : 20)) } catch (e) { results.push({ role: u.role, error: String(e).slice(0, 120) }); continue }
      results.push(u.role === 'records'
        ? scan(arr, Math.max(1, n), 16, 'records')
        : { role: u.role, note: 'raw TF output', first: Array.from(arr.slice(0, 8)).map((v) => +v.toFixed(3)) })
    }
    return { count, cap, emits: perf.emit, cull: perf.cull, softwareGL: perf.softwareGL, frames: window.__fxFrames, buffers: results }
  })
}

async function leg(tag, query, seconds = 8) {
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
  // the loop-aliveness oracle: __vfxFrame must ADVANCE (the task138 lesson:
  // under a saturated raster the count is not FROZEN = alive)
  const f0 = await page.evaluate(() => window.__vfxFrame ?? -1)
  await page.waitForTimeout(seconds * 1000)
  const f1 = await page.evaluate(() => window.__vfxFrame ?? -1)

  let bufs = null
  try { bufs = await readTfBuffers() } catch (e) { bufs = { error: String(e).slice(0, 150) } }
  console.log(`[task140] ${tag}${query === '' ? ' (default)' : ` ${query}`} bufs: ${JSON.stringify(bufs)}`)

  const shots = []
  if (process.env.SHOT === '1') {
    const clip = await page.evaluate(() => {
      const c = document.querySelector('canvas')
      if (!c) return null
      const r = c.getBoundingClientRect()
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
    })
    if (clip != null) {
      const path = join(out, `${tag}.png`)
      let png = null
      try {
        await page.screenshot({ path, clip, timeout: 30_000 })
        png = PNG.sync.read(readFileSync(path))
      } catch {
        shots.push({ starved: true })
      }
      if (png != null) {
        const { width: W, height: H, data } = png
        let warm = 0, lit = 0
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const k = (y * W + x) * 4
            const r = data[k], g = data[k + 1], b = data[k + 2]
            if (r > 40 && r > g * 1.15 && g > b * 1.05) warm++
            if (r + g + b > 90) lit++
          }
        }
        shots.push({ warm: +(100 * warm / (W * H)).toFixed(2), lit: +(100 * lit / (W * H)).toFixed(2) })
      }
    }
  }

  let fx = { frames: -1, errors: [], top: [], draws: [], perf: null }
  try {
    fx = await page.evaluate(() => {
      const calls = {}
      for (const e of window.__fxTrace) {
        const c = calls[e.name] ?? (calls[e.name] = { n: 0, ms: 0, max: 0 })
        c.n++; c.ms += e.cost; c.max = Math.max(c.max, e.cost)
      }
      const top = Object.entries(calls).sort((a, b) => b[1].ms - a[1].ms).slice(0, 8)
        .map(([name, c]) => `${name}×${c.n} ${c.ms.toFixed(0)}ms (max ${c.max.toFixed(1)})`)
      const draws = window.__fxTrace.filter((e) => e.name === 'drawArrays').slice(-8).map((e) => `n=${e.n} ${e.cost}ms`)
      return { frames: window.__fxFrames, errors: window.__fxErrors.slice(-12), top, draws, perf: window.__vfxPerf ? { ...window.__vfxPerf } : null }
    })
  } catch (e) { fx.crashed = String(e).slice(0, 150) }

  console.log(`[task140] ${tag} — perf: ${JSON.stringify(fx.perf)}`)
  console.log(`[task140]   loop ${f0}→${f1} · tfFrames ${fx.frames} · shots ${JSON.stringify(shots)}`)
  console.log(`[task140]   cost: ${fx.top.join(' · ')}`)
  console.log(`[task140]   drawArrays tail: ${fx.draws.join(' | ')}`)
  console.log(`[task140]   glErrors: ${fx.errors.length === 0 ? 'NONE' : JSON.stringify(fx.errors)}`)
  return { fx, shots, bufs, loop: [f0, f1] }
}

// THE 2×2 BISECT MATRIX over the two real-GPU defaults (each leg a FRESH
// page, the spoofed renderer string active on all of them):
//   A default — the USER'S EXACT PAGE (160k, emit gpu, cull on)
//   B ?emit=0&cull=0 — the Task-137-era config (the escape hatch)
//   C ?cull=0 — GPU emission alone at 160k
//   D ?emit=0 — the cull alone at 160k
const LEGS = {
  A: () => leg('A-default', '', 8),
  B: () => leg('B-escape', '?emit=0&cull=0', 8),
  C: () => leg('C-noCull', '?cull=0', 8),
  D: () => leg('D-noEmit', '?emit=0', 8),
}
const want = process.env.LEG != null ? [process.env.LEG] : ['A', 'B', 'C', 'D']
const results = {}
for (const key of want) results[key] = await LEGS[key]()

// ── the verdicts ──
{
  const verdict = (tag, r) => {
    const p = r.fx?.perf ?? {}
    const b = r.bufs?.buffers ?? []
    const rec = b.find((x) => x.label === 'records') ?? b.find((x) => x.role === 'records')
    const cfgOk = p.capacity === 160000 ? '160k ✓' : `CAP ${p.capacity} ✗`
    if (rec == null || rec.error !== undefined) return `${tag}: ${cfgOk} — records unreadable (${rec?.error ?? 'missing'})`
    const nan = rec.nan > 0 || rec.inf > 0
    const degenerate = rec.zeroRows > rec.n * 0.9 || (rec.halfMax < 1e-4 && (rec.ca[1] ?? 0) < 1e-4)
    const garbage = nan || rec.halfMax > 0.6
    const state = garbage ? 'GARBAGE' : degenerate ? 'DEGENERATE (the invisible signature)' : 'sane'
    return `${tag}: ${cfgOk} emit=${p.emit} cull=${p.cull} — records ${state} (n ${rec.n}, zeroRows ${rec.zeroRows}, halfMax ${rec.halfMax}, halfMin ${rec.halfMin}, ca [${rec.ca}], cr [${rec.cr}], nan ${rec.nan}, inf ${rec.inf}, atOrigin ${rec.allAtOrigin})`
  }
  console.log('── THE VERDICTS ──')
  for (const key of want) console.log(verdict(key, results[key]))
  const hardErrors = consoleMsgs.filter((m) => m.startsWith('PAGEERROR:'))
  if (hardErrors.length > 0) fail(`page errors: ${hardErrors.slice(0, 3).join(' | ')}`)
  else ok('no page errors across the matrix')
  if (process.exitCode === 1) fail('see the legs above')
  else console.log('[task140] PASS — the matrix collected')
}
await browser.close()
server.stop(true)
if (process.exitCode === 1) process.exit(1)
