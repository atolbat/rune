// task139-embers-forensics — THE FREEZE ROOT-CAUSE HUNT (Task 139).
//
// The user's live report on a REAL GPU after Task 138's defaults flipped:
// "вебгл эмберс полностью зависают; один раз — сверхяркое зеленоватое пятно
// и всё зависло". The real-GPU default path (emit:'gpu' + cull, 160k) was
// NEVER pixel-gated in the container (task138's leg B checked only the JS
// ledger aliveness — "no pixel gate on this leg"; the warm-pixel timeline
// is the oracle the Task 136/137 lessons named). The same leg measured
// ~460 ms/frame at 16k on SwiftShader — 10× the conservative path at the
// SAME particle count, which smells like a fill-rate blowup (giant quads —
// the Task 136 records-garbage class: "halfExtent to full-screen quads,
// rgb up to ±23").
//
// THIS PROBE: the isolation matrix over the default-path flags, each leg a
// FRESH PAGE, with a FULL GL forensics harness injected before every page:
//   · EVERY GL call traced (name + cost in ms + getError) — the error sink
//     and the per-call cost profile (which call eats the frame);
//   · every bindBufferBase(TRANSFORM_FEEDBACK_BUFFER, 0, buf) captured —
//     the TF output buffers become readable via
//     getBufferSubData(COPY_READ_BUFFER) WITHOUT touching the library;
//   · the RECORDS readback + the garbage signature scan: NaN/Inf counts,
//     halfExtent magnitude (giant quads), color ranges (Task 136 saw rgb
//     ±23), position collapse (all-at-origin = the bright blob);
//   · canvas screenshots — the bright-spot check leg B never ran.
// Legs: F0 default (the control, CPU emit + no cull) · FE ?emit=1 (GPU
// emission alone) · FC ?cull=1 (the sort family alone) · FB ?emit=1&cull=1
// (the real-GPU default path, forced on the software class).
import { join } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const root = '/home/z/my-project/rune'
const out = join(root, '.shots', 'task139')
mkdirSync(out, { recursive: true })
const port = 8139

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

// THE FORENSICS HARNESS — context-level, injected into every fresh page.
// Traces every GL call (name + ms + getError), captures the TF output
// buffers, exposes window.__fx = { trace tail, errors, tfBinds, stats }.
await context.addInitScript(() => {
  window.__fxErrors = []
  window.__fxTrace = [] // the LAST 1200 calls, ring-style
  window.__fxTfBinds = [] // the LAST 16 TF output binds (buffer objects)
  window.__fxFrames = 0
  const RING = 1200
  const push = (entry) => {
    window.__fxTrace.push(entry)
    if (window.__fxTrace.length > RING) window.__fxTrace.splice(0, window.__fxTrace.length - RING)
  }
  const orig = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = orig.call(this, type, ...rest)
    if (type === 'webgl2' && ctx != null && !ctx.__fxHooked) {
      ctx.__fxHooked = true
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
              if (window.__fxTfBinds.length > 16) window.__fxTfBinds.shift()
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
        'getBufferSubData',
      ]) hook(name)
    }
    return ctx
  }
})

const consoleMsgs = []
let page = null
function fail(message) { console.error(`[task139] FAIL: ${message}`); process.exitCode = 1 }
function ok(message) { console.log(`[task139] ok — ${message}`) }

async function freshPage() {
  if (page !== null) await page.close().catch(() => { /* a saturated renderer dies loudly */ })
  page = await context.newPage()
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleMsgs.push(m.text().slice(0, 300)) })
  page.on('pageerror', (e) => consoleMsgs.push('PAGEERROR: ' + String(e).slice(0, 300)))
  return page
}

// the records/state readback + the garbage signature scan (in-page).
// records layout (16 floats): r0=(px,py,pz,vx) r1=(vy,vz,cr,cg)
// r2=(cb,ca,halfExtent,angle) r3=(age,seed,u0,v0)
async function readTfBuffers() {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas')
    const gl = canvas ? canvas.getContext('webgl2') : null
    if (gl == null || window.__fxTfBinds.length === 0) return { error: 'no canvas/ctx/binds' }
    const perf = window.__vfxPerf ?? {}
    const count = perf.count ?? 0
    const cap = perf.capacity ?? 0
    // the frame's TF bind order (sort off): emitOut, stateOut, pairsOut,
    // records — the LAST is records; dedupe by object identity.
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
      const s = { label, n, nan: 0, inf: 0, posMin: [1e9, 1e9, 1e9], posMax: [-1e9, -1e9, -1e9], halfMax: 0, cr: [1e9, -1e9], cg: [1e9, -1e9], cb: [1e9, -1e9], ca: [1e9, -1e9], allAtOrigin: 0 }
      for (let i = 0; i < n; i++) {
        const b = i * stride
        for (let k = 0; k < Math.min(stride, 12); k++) {
          const v = arr[b + k]
          if (Number.isNaN(v)) s.nan++
          else if (!Number.isFinite(v)) s.inf++
        }
        const px = arr[b], py = arr[b + 1], pz = arr[b + 2]
        s.posMin[0] = Math.min(s.posMin[0], px); s.posMin[1] = Math.min(s.posMin[1], py); s.posMin[2] = Math.min(s.posMin[2], pz)
        s.posMax[0] = Math.max(s.posMax[0], px); s.posMax[1] = Math.max(s.posMax[1], py); s.posMax[2] = Math.max(s.posMax[2], pz)
        if (Math.abs(px) < 1e-6 && Math.abs(py) < 1e-6 && Math.abs(pz) < 1e-6) s.allAtOrigin++
        if (stride === 16) {
          s.halfMax = Math.max(s.halfMax, Math.abs(arr[b + 10]))
          const ch = (k, lo) => { s[lo][0] = Math.min(s[lo][0], arr[b + k]); s[lo][1] = Math.max(s[lo][1], arr[b + k]) }
          ch(6, 'cr'); ch(7, 'cg'); ch(8, 'cb'); ch(9, 'ca')
        }
      }
      const r2 = (v) => (Math.abs(v) > 1e8 ? 1e9 : +v.toFixed(3))
      s.posMin = s.posMin.map(r2); s.posMax = s.posMax.map(r2)
      for (const k of ['cr', 'cg', 'cb', 'ca']) s[k] = s[k].map(r2)
      s.halfMax = +s.halfMax.toFixed(4)
      return s
    }
    const results = []
    const n = Math.min(count, 16384)
    for (const u of uniq) {
      let arr
      try { arr = read(u.buf, cap * (u.role === 'records' ? 16 : 20)) } catch (e) { results.push({ role: u.role, error: String(e).slice(0, 120) }); continue }
      results.push(u.role === 'records'
        ? scan(arr, Math.max(1, n), 16, 'records')
        : { role: u.role, note: 'raw TF output (scan skipped)', first: Array.from(arr.slice(0, 8)).map((v) => +v.toFixed(3)) })
    }
    return { count, cap, emits: perf.emit, cull: perf.cull, frames: window.__fxFrames, buffers: results }
  })
}

async function leg(tag, query, seconds = 5) {
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
  await page.waitForTimeout(seconds * 1000)

  // THE TF READBACK FIRST — evaluate() rides the main thread between rAFs
  // (the task138 lesson: a starved COMPOSITOR still leaves the JS loop alive);
  // a screenshot under a saturated raster can 45s-timeout and the renderer can
  // CRASH outright (the FE leg already died once mid-probe) — every step is
  // try/catch so the evidence collected before a crash still lands.
  let bufs = null
  try { bufs = await readTfBuffers() } catch (e) { bufs = { error: String(e).slice(0, 150) } }
  console.log(`[task139] ${tag}${query === '' ? ' (default)' : ` ${query}`} bufs: ${JSON.stringify(bufs)}`)

  // the screenshots — LAST and opt-in (SHOT=1): the readback/trace above is
  // the primary evidence; the pixels are the bright-spot confirmation
  const shots = []
  if (process.env.SHOT === '1') for (let i = 0; i < 3; i++) {
    const clip = await page.evaluate(() => {
      const c = document.querySelector('canvas')
      if (!c) return null
      const r = c.getBoundingClientRect()
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
    })
    if (clip == null) break
    const path = join(out, `${tag}-${i}.png`)
    let png = null
    try {
      await page.screenshot({ path, clip, timeout: 45_000 })
      png = PNG.sync.read(readFileSync(path))
    } catch {
      shots.push({ starved: true })
      break // the compositor is >45 s behind — THE FREEZE SIGNATURE
    }
    const { width: W, height: H, data } = png
    let warm = 0, blown = 0, green = 0
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const k = (y * W + x) * 4
        const r = data[k], g = data[k + 1], b = data[k + 2]
        if (r > 40 && r > g * 1.15 && g > b * 1.05) warm++
        if (r > 235 && g > 235) blown++
        if (g > 90 && g > r * 1.3 && g > b * 1.3) green++
      }
    }
    shots.push({ warm: +(100 * warm / (W * H)).toFixed(2), blown: +(100 * blown / (W * H)).toFixed(3), green: +(100 * green / (W * H)).toFixed(3) })
    if (i < 2) await page.waitForTimeout(700)
  }

  // the GL forensics: the cost profile (the top calls), the errors
  let fx = { frames: -1, errors: [], top: [], draws: [], tex: [], perf: null }
  try {
    fx = await page.evaluate(() => {
      const calls = {}
      for (const e of window.__fxTrace) {
        const c = calls[e.name] ?? (calls[e.name] = { n: 0, ms: 0, max: 0 })
        c.n++; c.ms += e.cost; c.max = Math.max(c.max, e.cost)
      }
      const top = Object.entries(calls).sort((a, b) => b[1].ms - a[1].ms).slice(0, 8)
        .map(([name, c]) => `${name}×${c.n} ${c.ms.toFixed(0)}ms (max ${c.max.toFixed(1)})`)
      const draws = window.__fxTrace.filter((e) => e.name === 'drawArraysInstanced').slice(-4).map((e) => `inst=${e.n} ${e.cost}ms`)
      const tex = window.__fxTrace.filter((e) => e.name === 'texSubImage2D').slice(-10).map((e) => `${e.cost}ms`)
      return { frames: window.__fxFrames, errors: window.__fxErrors.slice(-12), top, draws, tex, perf: window.__vfxPerf ? { ...window.__vfxPerf } : null }
    })
  } catch (e) { fx.crashed = String(e).slice(0, 150) }

  console.log(`[task139] ${tag}${query === '' ? ' (default)' : ` ${query}`} — ${JSON.stringify(fx.perf)}`)
  console.log(`[task139]   frames ${fx.frames} · shots ${JSON.stringify(shots)}`)
  console.log(`[task139]   cost: ${fx.top.join(' · ')}`)
  console.log(`[task139]   draws: ${fx.draws.join(' | ')}`)
  console.log(`[task139]   tex tail: ${fx.tex.join(' ')}`)
  console.log(`[task139]   glErrors: ${fx.errors.length === 0 ? 'NONE' : JSON.stringify(fx.errors)}`)
  console.log(`[task139]   bufs: ${JSON.stringify(bufs)}`)
  return { fx, shots, bufs }
}

// THE ISOLATION MATRIX — each leg a FRESH PAGE. LEG env: run ONE leg
// (a saturated renderer can eat minutes; one leg per process keeps a hang
// from killing the matrix). Default: all four.
const LEGS = {
  F0: () => leg('F0-default', '', 4),
  FE: () => leg('FE-emit', '?emit=1', 4),
  FC: () => leg('FC-cull', '?cull=1', 4),
  FB: () => leg('FB-both', '?emit=1&cull=1', 5),
}
const want = process.env.LEG != null ? [process.env.LEG] : ['F0', 'FE', 'FC', 'FB']
const results = {}
for (const key of want) results[key] = await LEGS[key]()

// ── the verdicts ──
{
  const verdict = (tag, r) => {
    const b = r.bufs?.buffers ?? []
    const rec = b.find((x) => x.label === 'records') ?? b.find((x) => x.role === 'records')
    if (rec == null || rec.error !== undefined) return `${tag}: records unreadable (${rec?.error ?? 'missing'})`
    const garbage = rec.nan > 0 || rec.inf > 0 || rec.halfMax > 0.6 || Math.abs(rec.cr[1]) > 2 || Math.abs(rec.cg[1]) > 2 || Math.abs(rec.cb[1]) > 2 || Math.abs(rec.ca[1]) > 2
    const collapsed = rec.allAtOrigin > rec.n * 0.5
    return `${tag}: records ${garbage ? 'GARBAGE' : 'sane'} (halfMax ${rec.halfMax}, rgb [${rec.cr}/${rec.cg}/${rec.cb}/${rec.ca}], nan ${rec.nan}, inf ${rec.inf}, atOrigin ${rec.allAtOrigin}/${rec.n})${collapsed ? ' — COLLAPSED' : ''}`
  }
  console.log('── THE VERDICTS ──')
  for (const key of want) console.log(verdict(key, results[key]))
  const hardErrors = consoleMsgs.filter((m) => m.startsWith('PAGEERROR:'))
  if (hardErrors.length > 0) fail(`page errors: ${hardErrors.slice(0, 3).join(' | ')}`)
  else ok('no page errors across the matrix')
  if (process.exitCode === 1) fail('see the legs above')
  else console.log('[task139] PASS — forensics collected')
}
await browser.close()
server.stop(true)
if (process.exitCode === 1) process.exit(1)
