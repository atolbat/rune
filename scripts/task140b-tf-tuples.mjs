// task140b-tf-tuples — THE PASS→BUFFER ROTATION HUNT (Task 140, leg A root).
//
// task140's leg A (the user's exact config: 160k + emit:'gpu' + cull) showed
// the records buffer containing EMIT-SHAPED 20-float rows (py=-1.5 the disc,
// life in [5,11], size in [0.03,0.1], age 0) while emitOut held ADVANCED
// rows (age 3.68) — the TF pass outputs landing in the WRONG buffers. The GL
// error stream was CLEAN (only the probe's own over-requests) — a silent
// rotation, not a dropped write.
//
// THIS PROBE: hook useProgram/bindTransformFeedback/bindBufferBase(TF)/
// begin/drawArrays/end — assemble per-pass TUPLES {prog, tf, buf, n} pushed
// at endTransformFeedback — and read the buffers EARLY (t≈2.5s, before the
// readback's own main-thread stall wrecks the ledger's dt). Plus the raw
// first rows of every TF buffer + the emit/advance vertex counts over time.
import { join } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const root = '/home/z/my-project/rune'
const out = join(root, '.shots', 'task140')
mkdirSync(out, { recursive: true })
const port = 8141

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

await context.addInitScript(() => {
  window.__fxErrors = []
  window.__fxTuples = [] // the last 40 {prog, tf, buf, n} per endTransformFeedback
  window.__fxCounts = [] // the last 60 drawArrays vertex counts (all)
  window.__fxTexRects = [] // the last 40 texSubImage2D rects (x,y,w,h,offset)
  window.__fxFrames = 0
  const SPOOF_RENDERER = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)'
  const UNMASKED_RENDERER = 37446
  const orig = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = orig.call(this, type, ...rest)
    if (type === 'webgl2' && ctx != null && !ctx.__fxHooked) {
      ctx.__fxHooked = true
      const origGetParameter = ctx.getParameter.bind(ctx)
      ctx.getParameter = (pname, ...pr) => {
        if (pname === UNMASKED_RENDERER) return SPOOF_RENDERER
        return origGetParameter(pname, ...pr)
      }
      // ── the per-pass tuple assembly ──
      let curProg = null, curTf = null, curBuf = null, curN = 0
      const seen = new Map() // object → short id
      let nextId = 1
      const tag = (o) => {
        if (o == null) return 'null'
        if (!seen.has(o)) seen.set(o, '#' + (nextId++))
        return seen.get(o)
      }
      const TF_TARGET = ctx.TRANSFORM_FEEDBACK_BUFFER
      const hook = (name) => {
        const fn = ctx[name].bind(ctx)
        ctx[name] = (...args) => {
          const r = fn(...args)
          if (name === 'useProgram') curProg = args[0]
          else if (name === 'bindTransformFeedback') curTf = args[0]
          else if (name === 'bindBufferBase' && args[0] === TF_TARGET) curBuf = args[2]
          else if (name === 'drawArrays') { curN = args[2]; window.__fxCounts.push(args[2]); if (window.__fxCounts.length > 60) window.__fxCounts.shift() }
          else if (name === 'texSubImage2D') {
            window.__fxTexRects.push({ x: args[3], y: args[4], w: args[5], h: args[6], off: args[10] })
            if (window.__fxTexRects.length > 40) window.__fxTexRects.shift()
          }
          if (name === 'endTransformFeedback') {
            window.__fxFrames++
            window.__fxTuples.push({ prog: tag(curProg), tf: tag(curTf), buf: tag(curBuf), n: curN })
            if (window.__fxTuples.length > 40) window.__fxTuples.shift()
          }
          const err = ctx.getError()
          if (err !== 0) window.__fxErrors.push({ name, err, t: Math.round(performance.now()) })
          return r
        }
      }
      for (const name of [
        'useProgram', 'bindTransformFeedback', 'bindBufferBase', 'drawArrays',
        'beginTransformFeedback', 'endTransformFeedback', 'texSubImage2D',
        'drawArraysInstanced', 'bufferSubData', 'getBufferSubData',
      ]) hook(name)
    }
    return ctx
  }
})

const consoleMsgs = []
let page = null
async function freshPage() {
  if (page !== null) await page.close().catch(() => {})
  page = await context.newPage()
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleMsgs.push(m.text().slice(0, 300)) })
  page.on('pageerror', (e) => consoleMsgs.push('PAGEERROR: ' + String(e).slice(0, 300)))
  return page
}

// THE EARLY READBACK — t≈2.5s (the burst fired at 0.02s; the population is
// alive; the readback's own main-thread stall has NOT yet wrecked the
// ledger's dt). Reads each buffer at its OWN size; dumps raw first rows.
async function readTfBuffers() {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas')
    const gl = canvas ? canvas.getContext('webgl2') : null
    if (gl == null) return { error: 'no canvas/ctx' }
    const perf = window.__vfxPerf ?? {}
    // the TF tuples' buffer tags → the buffer OBJECTS (the tuples carry
    // tagged ids; re-derive by replaying the LAST bindBufferBase objects —
    // simpler: read by scanning the tuples' DISTINCT bufs in bind order)
    const seen = new Map()
    for (const t of window.__fxTuples) if (t.buf !== 'null' && !seen.has(t.buf)) seen.set(t.buf, t)
    const bufsInOrder = [...seen.keys()] // oldest → newest
    const roles = ['first', 'second', 'third', 'fourth', 'fifth']
    const read = (bufTag, floats) => {
      // resolve the buffer object from the tuple stream is impossible after
      // the fact — instead the hook kept the LAST bound buffer per tag? We
      // re-read via a second hook channel: window.__fxBufObjs
      const obj = window.__fxBufObjs?.[bufTag]
      if (obj == null) return { error: 'no object for ' + bufTag }
      const arr = new Float32Array(floats)
      gl.bindBuffer(gl.COPY_READ_BUFFER, obj)
      gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, arr)
      gl.bindBuffer(gl.COPY_READ_BUFFER, null)
      return { arr }
    }
    // sizes per position-from-last: records=cap*16, the rest cap*20 or padN*4
    const cap = perf.capacity ?? 160000
    const results = []
    const fromLast = bufsInOrder.slice(-4).reverse() // newest first
    const sizes = [cap * 16, 1024 * 1024, cap * 20, cap * 20]
    for (let i = 0; i < fromLast.length; i++) {
      const r = read(fromLast[i], sizes[i] ?? cap * 20)
      if (r.error !== undefined) { results.push({ role: roles[i], tag: fromLast[i], error: r.error }); continue }
      const arr = r.arr
      const rows = []
      for (let k = 0; k < 3; k++) rows.push(Array.from(arr.slice(k * 16, k * 16 + 16)).map((v) => +v.toFixed(3)))
      results.push({ role: roles[i], tag: fromLast[i], floats: arr.length, row0: rows[0], row1: rows[1], row2: rows[2] })
    }
    return {
      count: perf.count, cap, emit: perf.emit, cull: perf.cull, softwareGL: perf.softwareGL,
      frames: window.__fxFrames,
      tuples: window.__fxTuples.slice(-24),
      drawCounts: window.__fxCounts.slice(-30),
      texRects: window.__fxTexRects.slice(-12),
      buffers: results,
    }
  })
}

await freshPage()
await page.goto(`http://localhost:${port}/demo/vfx/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
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
await page.waitForTimeout(2500)

// keep the buffer OBJECTS reachable for the in-page readback: expose a map
// tag → WebGLBuffer from the tuple stream (the hook must record them).
await page.evaluate(() => { window.__fxBufObjs = window.__fxBufObjsMap ?? null })
let bufs = null
try { bufs = await readTfBuffers() } catch (e) { bufs = { error: String(e).slice(0, 200) } }
console.log('[task140b] tuples+bufs: ' + JSON.stringify(bufs, null, 1))

const fx = await page.evaluate(() => ({
  perf: window.__vfxPerf ? { ...window.__vfxPerf } : null,
  errors: window.__fxErrors.slice(-12),
  frames: window.__fxFrames,
}))
console.log('[task140b] perf: ' + JSON.stringify(fx.perf))
console.log('[task140b] glErrors: ' + (fx.errors.length === 0 ? 'NONE' : JSON.stringify(fx.errors)))

await browser.close()
server.stop(true)
