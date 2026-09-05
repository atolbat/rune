// task140f-cap40k — THE DISCRIMINATING EXPERIMENT (Task 140).
//
// task140e reproduced the user's symptom on RUN2 (post-remake): records
// sane-looking, the draw issued (inst 124329), pixels COLD (warm 0.0%,
// lit 1.6% — the floor only). Run1's verdict starved (the 160k fill cliff
// froze SwiftShader's compositor before the screenshot could land).
//
// THE QUESTION: is the invisible a RE-MAKE-only bug (run1 warm, run2
// cold) or a FIRST-RUN bug at the big capacity (both cold)?
//
// THE TRICK: the local server PATCHES gpuEmbers.js — TF_CAPACITY 160_000
// → 40_000 — below SwiftShader's fill cliff, above the noise floor, with
// the renderer spoof still active (SOFTWARE_GL=false → the FULL default
// GPU pipeline: emit:'gpu' + cull, NO flags, the exact user path).
//
//   leg A — fresh page, settle, pixels + records   (the FIRST RUN verdict)
//   leg B — the demo-cycle (Fireflies and back), pixels + records (the 2nd)
import { join } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const root = '/home/z/my-project/rune'
const out = join(root, '.shots', 'task140')
mkdirSync(out, { recursive: true })
const port = 8145

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
    let body = await file.text()
    if (pathname.endsWith('demos/gpuEmbers.js')) {
      // THE CAPACITY PATCH: 160k → 40k (the freeze cliff dodge; the page's
      // policy branch unchanged — the spoof keeps SOFTWARE_GL false)
      const before = body
      body = body.replace('const TF_CAPACITY = SOFTWARE_GL ? 16_000 : 160_000', 'const TF_CAPACITY = SOFTWARE_GL ? 16_000 : 40_000')
      if (body === before) { console.error('[task140f] PATCH FAILED — the capacity line not found'); process.exit(1) }
    }
    return new Response(body, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
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
  window.__fxInst = []
  window.__fxRemakes = []
  const SPOOF_RENDERER = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)'
  const UNMASKED_RENDERER = 37446
  let vfxPerfValue = null
  Object.defineProperty(window, '__vfxPerf', {
    configurable: true,
    get: () => vfxPerfValue,
    set: (v) => {
      vfxPerfValue = v
      window.__fxRemakes.push({ t: +performance.now().toFixed(0), cap: v?.capacity ?? -1 })
    },
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
            window.__fxInst.push({ t: +t.toFixed(0), inst: args[3] })
            if (window.__fxInst.length > 40) window.__fxInst.shift()
          } else if (name === 'bindBufferBase' && args[0] === TF_TARGET && args[2] !== null) {
            if (window.__fxTfBinds == null) window.__fxTfBinds = []
            window.__fxTfBinds.push(args[2])
            if (window.__fxTfBinds.length > 16) window.__fxTfBinds.shift()
          }
          if (name === 'endTransformFeedback') window.__fxFrames++
          const err = ctx.getError()
          if (err !== 0) window.__fxErrors.push({ name, err, t: +t.toFixed(0) })
          return r
        }
      }
      for (const name of ['drawArraysInstanced', 'bindBufferBase', 'endTransformFeedback', 'bindVertexArray', 'vertexAttribPointer', 'enableVertexAttribArray', 'disableVertexAttribArray']) hook(name)
    }
    return ctx
  }
})

const consoleMsgs = []
const page = await context.newPage()
page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text().slice(0, 200)}`))
page.on('pageerror', (e) => consoleMsgs.push('PAGEERROR: ' + String(e).slice(0, 200)))

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
    await page.screenshot({ path, clip, timeout: 20_000 })
    return warmOf(PNG.sync.read(readFileSync(path)))
  } catch { return { starved: true } }
}

// THE RECORDS READBACK — SAFE: resolve the records buffer by the LAST
// distinct TF bind of a COMPLETE frame (the packSorted output, bound last
// in the frame), guarded so we never bind a possibly-deleted object on a
// live path (read via a THROWAWAY probe buffer bound to COPY_READ — a
// target the page never uses).
async function readState() {
  return page.evaluate(() => {
    const perf = window.__vfxPerf ?? {}
    const count = perf.count ?? 0
    const binds = window.__fxTfBinds ?? []
    const uniq = []
    for (let i = binds.length - 1; i >= 0 && uniq.length < 1; i--) {
      if (!uniq.some((b) => b === binds[i])) uniq.push(binds[i])
    }
    const records = []
    if (uniq.length > 0) {
      const canvas = document.querySelector('canvas')
      const gl = canvas ? canvas.getContext('webgl2') : null
      if (gl != null && uniq[0] != null) {
        const n = Math.min(Math.max(count, 256), 4096)
        const arr = new Float32Array(n * 16)
        try {
          gl.bindBuffer(gl.COPY_READ_BUFFER, uniq[0])
          const err1 = gl.getError()
          gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, arr)
          const err2 = gl.getError()
          gl.bindBuffer(gl.COPY_READ_BUFFER, null)
          let zeroRows = 0, halfMax = 0, caMax = 0
          for (let i = 0; i < n; i++) {
            const b = i * 16
            let allZero = true
            for (let k = 0; k < 16; k++) if (arr[b + k] !== 0) { allZero = false; break }
            if (allZero) { zeroRows++; continue }
            halfMax = Math.max(halfMax, Math.abs(arr[b + 10]))
            caMax = Math.max(caMax, Math.abs(arr[b + 9]))
          }
          records.push({ n, zeroRows, halfMax: +halfMax.toFixed(4), caMax: +caMax.toFixed(4), err1, err2,
            first: Array.from(arr.slice(0, 6)).map((v) => +v.toFixed(3)) })
        } catch (e) { records.push({ error: String(e).slice(0, 100) }) }
      } else records.push({ error: 'no gl' })
    } else records.push({ error: 'no binds' })
    return {
      perf: { count, cap: perf.capacity, emit: perf.emit, cull: perf.cull, ms: perf.ms },
      remakes: window.__fxRemakes,
      frames: window.__fxFrames,
      instTail: window.__fxInst.slice(-5),
      errors: window.__fxErrors.slice(-5),
      records,
    }
  }).catch((e) => ({ crash: String(e).slice(0, 150) }))
}

// ── leg A: the FIRST run ────────────────────────────────────────────────
await page.goto(`http://localhost:${port}/demo/vfx/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForTimeout(1000)
await page.click('#rd-fab')
await page.click('label[for="mode-webgl2"]')
await page.waitForTimeout(400)
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('button')]
  rows.find((r) => (r.textContent ?? '').includes('GPU Embers'))?.click()
})
await page.waitForTimeout(4500)
const A = await readState()
console.log('[task140f] A (first run): ' + JSON.stringify(A))
const Ashot = await shot('f40k-first')
console.log('[task140f] A pixels: ' + JSON.stringify(Ashot))

// ── leg B: the demo-cycle re-make ──────────────────────────────────────
await page.click('#rd-fab').catch(() => {})
await page.waitForTimeout(300)
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('button')]
  rows.find((r) => (r.textContent ?? '').includes('Fireflies'))?.click()
})
await page.waitForTimeout(1500)
await page.click('#rd-fab').catch(() => {})
await page.waitForTimeout(300)
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('button')]
  rows.find((r) => (r.textContent ?? '').includes('GPU Embers'))?.click()
})
await page.waitForTimeout(3500)
const B = await readState()
console.log('[task140f] B (2nd run): ' + JSON.stringify(B))
const Bshot = await shot('f40k-second')
console.log('[task140f] B pixels: ' + JSON.stringify(Bshot))

// ── the verdicts ────────────────────────────────────────────────────────
{
  const warmA = Ashot.warm ?? -1
  const warmB = Bshot.warm ?? -1
  console.log('── THE VERDICTS ──')
  console.log(`A first-run: warm ${warmA}% | B second-run: warm ${warmB}% (cap ${A.perf?.cap ?? '?'})`)
  if (warmA > 0.05 && warmB <= 0.02) console.log('[task140f] !!! THE RE-MAKE CLASS — first run WARM, second run COLD (the user bug root: the dispose/re-make path)')
  else if (warmA <= 0.02 && warmB <= 0.02) console.log('[task140f] !!! BOTH COLD — the DEFAULT GPU-PIPELINE path is broken even on the first run')
  else if (warmA > 0.05 && warmB > 0.05) console.log('[task140f] both WARM — no reproduction at 40k (the 160k size angle remains)')
  else console.log('[task140f] mixed/odd — see the states above')
}
console.log('[task140f] console (last 8): ' + JSON.stringify(consoleMsgs.slice(-8)))
await browser.close()
server.stop(true)
