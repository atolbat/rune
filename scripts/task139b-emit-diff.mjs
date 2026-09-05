// task139b-emit-diff — THE EMIT DIFFERENTIAL (Task 139, part 2).
//
// The forensics (task139) pinned the freeze's signature on ?emit=1: the
// RECORDS are garbage (halfMax 2.2 vs 0.05, dark greenish colors, alpha 0)
// and emitOut's own row 0 = (415.5, 0, 0, vx, vy, vz, age 0, life 0.78) —
// while the ember spawner's valid domain is: disc origin [0,-1.5,0] radius
// [2,16], life [5,11]. THIS probe discriminates the two hypotheses:
//   H1 — the emit TF pass OUTPUT is wrong (uniforms/shader/run) → compare
//        emitOut against the JS reference model (gpuEmitRowModel) for the
//        EXACT window (handoff.emitStreamBase + i, the same atOrigin/
//        emitterV/inheritK the orchestrator fed);
//   H2 — the emit pass is right and the PBO round-trip misplaces the rows
//        into the state texture → the differential comes out CLEAN and the
//        hunt moves to the round-trip offsets.
// The handoff and emitOut are read in ONE synchronous evaluate (the rAF
// cannot interleave) — the handoff's window fields and emitOut's content
// always update together in the same frame's step().
// Bonus: dump the advance output's first rows too (the state the pack
// reads) and re-run the demo's own emit shader on a scratch buffer with
// uniforms rebuilt EXACTLY as the orchestrator packs them.
import { chromium } from 'playwright'

const PORT = 8139

const server = Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url)
    let pathname = decodeURIComponent(url.pathname)
    if (pathname === '/') pathname = '/demo/'
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = Bun.file('/home/z/my-project/rune' + pathname)
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    const ext = pathname.slice(pathname.lastIndexOf('.'))
    const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }
    return new Response(file, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--use-angle=swiftshader'],
})
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })

// capture the TF output buffer objects (the bindBufferBase hook)
await context.addInitScript(() => {
  window.__fxTfBinds = []
  const orig = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = orig.call(this, type, ...rest)
    if (type === 'webgl2' && ctx != null && !ctx.__fxHooked) {
      ctx.__fxHooked = true
      const TF = ctx.TRANSFORM_FEEDBACK_BUFFER
      const origB3 = ctx.bindBufferBase.bind(ctx)
      ctx.bindBufferBase = (target, index, buffer) => {
        if (target === TF && buffer !== null) {
          window.__fxTfBinds.push(buffer)
          if (window.__fxTfBinds.length > 24) window.__fxTfBinds.shift()
        }
        return origB3(target, index, buffer)
      }
    }
    return ctx
  }
})

const page = await context.newPage()
page.on('pageerror', (e) => console.log('[pageerror] ' + String(e).slice(0, 200)))
await page.goto(`http://localhost:${PORT}/demo/vfx/?emit=1`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
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
await page.waitForTimeout(4000)

// ONE synchronous evaluate: the handoff window + emitOut readback + the
// model rows + a scratch re-run of the demo's own emit shader.
const diff = await page.evaluate(async (port) => {
  const P = await import(`http://localhost:${port}/dist/rune-particles.esm.js?v=138`)
  const layers = window.__vfxLayers ?? []
  const layer = layers.find((l) => l?.gpuBackend != null) ?? null
  const facade = layer?.facade ?? null
  const ho = facade?.gpuHandoff ?? null
  if (ho === null) return { error: 'no gpuHandoff (layers: ' + layers.length + ')' }
  const canvas = document.querySelector('canvas')
  const gl = canvas.getContext('webgl2')

  // the LAST frame's TF bind sequence: emit → advance → pack (cull off)
  const binds = window.__fxTfBinds.slice(-3)
  const emitBuf = binds[0]
  const advBuf = binds[1]
  const packBuf = binds[2]
  const read = (buf, floats) => {
    const arr = new Float32Array(floats)
    gl.bindBuffer(gl.COPY_READ_BUFFER, buf)
    gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, arr)
    gl.bindBuffer(gl.COPY_READ_BUFFER, null)
    return arr
  }

  // 1. THE WINDOW (read BEFORE and AFTER for rAF-interleave detection)
  const h1 = { emitBase: ho.emitBase, emitCount: ho.emitCount, streamBase: ho.emitStreamBase, origin: [...ho.emitOrigin], emitterV: [...ho.emitterV], inheritK: ho.emitInheritK, count: facade.count }
  const emitRows = read(emitBuf, ho.emitCount * 20 || 20)
  const advRows = read(advBuf, 80)
  const h2 = { emitBase: ho.emitBase, emitCount: ho.emitCount, streamBase: ho.emitStreamBase }
  const interleaved = h1.emitBase !== h2.emitBase || h1.emitCount !== h2.emitCount || h1.streamBase !== h2.streamBase

  // 2. THE MODEL for the same window
  const cfg = P.readGpuEmitConfig(facade.spawnerDesc)
  const model = new Float32Array(P.GPU_STATE_STRIDE)
  const at = h1.origin, ev = h1.emitterV, ik = h1.inheritK
  const n = Math.min(4, h1.emitCount)
  const modelRows = []
  for (let i = 0; i < n; i++) {
    P.gpuEmitRowModel(cfg, h1.streamBase + i, at, ev, ik, model)
    modelRows.push(Array.from(model.slice(0, 17)).map((v) => +v.toFixed(4)))
  }

  // 3. THE SCRATCH RE-RUN: the demo's own emit shader, uniforms rebuilt
  // exactly as the orchestrator packs them (packGlEmitStatic + step's
  // per-frame half) — a scratch buffer, a scratch program.
  const E = P.GPU_GL_EMIT_F
  const uni = new Float32Array(67)
  uni[E.shapeKind] = cfg.shapeKind
  uni[E.velMode] = cfg.velMode
  const sd = cfg.seed >>> 0
  uni[E.seedLo] = sd & 0xffff; uni[E.seedHi] = (sd >>> 16) & 0xffff
  const p3 = (b, v) => { uni[b] = v[0]; uni[b + 1] = v[1]; uni[b + 2] = v[2] }
  const p4 = (b, v) => { uni[b] = v[0]; uni[b + 1] = v[1]; uni[b + 2] = v[2]; uni[b + 3] = v[3] }
  p3(E.shapeOrigin, cfg.shapeOrigin); p3(E.atOrigin, at); p3(E.axis, cfg.axis); p3(E.t1, cfg.t1); p3(E.t2, cfg.t2); p3(E.fixedDir, cfg.fixedDir)
  if (cfg.lineTo !== null) p3(E.lineTo, cfg.lineTo)
  p4(E.radius, [cfg.rMin, cfg.rMax, cfg.hemArc, cfg.donR])
  p4(E.cone, [cfg.cosHalf, cfg.baseRadius, cfg.lenMin, cfg.lenMax])
  p4(E.donut, [cfg.tubeMin, cfg.tubeMax, cfg.donArc, cfg.arms])
  p4(E.misc, [cfg.armSpread, cfg.twist, cfg.rectW, cfg.rectH])
  p4(E.misc2, [cfg.gridW, cfg.gridH, cfg.gridRows, cfg.gridCols])
  p4(E.speed, [cfg.speedMin, cfg.speedMax, cfg.lifeMin, cfg.lifeMax])
  uni[E.sizeInherit] = cfg.sizeMin; uni[E.sizeInherit + 1] = cfg.sizeMax
  p4(E.color0, cfg.color0); p4(E.color1, cfg.color1)
  uni[E.emitBase] = h1.emitBase; uni[E.emitCount] = h1.emitCount
  const sb = h1.streamBase | 0
  uni[E.streamLo] = sb & 0xffff; uni[E.streamHi] = (sb >>> 16) & 0xffff
  p3(E.emitterV, ev); uni[E.sizeInherit + 2] = ik

  const scratch = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, scratch)
  gl.bufferData(gl.ARRAY_BUFFER, n * 80, gl.DYNAMIC_COPY)
  gl.bindBuffer(gl.ARRAY_BUFFER, null)
  const compile = (type, src) => {
    const sh = gl.createShader(type)
    gl.shaderSource(sh, src); gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) return null
    return sh
  }
  const vs = compile(gl.VERTEX_SHADER, P.gpuSimGlEmitGlsl())
  const prog = gl.createProgram()
  gl.attachShader(prog, vs)
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, '#version 300 es\nprecision lowp float;\nvoid main() {}\n'))
  gl.transformFeedbackVaryings(prog, P.GPU_GL_ADVANCE_OUTPUTS, gl.INTERLEAVED_ATTRIBS)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return { error: 'scratch link: ' + gl.getProgramInfoLog(prog) }
  gl.useProgram(prog)
  let at2 = 0
  for (const u of P.GPU_GL_EMIT_UNIFORMS) {
    const loc = gl.getUniformLocation(prog, u.name)
    if (loc === null) continue
    if (u.size === 1) gl.uniform1f(loc, uni[at2])
    else if (u.size === 2) gl.uniform2f(loc, uni[at2], uni[at2 + 1])
    else if (u.size === 3) gl.uniform3f(loc, uni[at2], uni[at2 + 1], uni[at2 + 2])
    else gl.uniform4f(loc, uni[at2], uni[at2 + 1], uni[at2 + 2], uni[at2 + 3])
    at2 += u.size
  }
  const tf = gl.createTransformFeedback()
  const vao = gl.createVertexArray()
  gl.bindVertexArray(vao)
  gl.enable(gl.RASTERIZER_DISCARD)
  gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, tf)
  gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, scratch)
  gl.beginTransformFeedback(gl.POINTS)
  gl.drawArrays(gl.POINTS, 0, n)
  gl.endTransformFeedback()
  const scratchErr = gl.getError()
  gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null)
  gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null)
  gl.disable(gl.RASTERIZER_DISCARD)
  gl.bindVertexArray(null)
  const scratchRows = read(scratch, n * 20)

  const dump = (arr, k) => Array.from(arr.slice(0, k * 20)).map((v) => +v.toFixed(4))
  return {
    window: h1, interleaved,
    emitOut: dump(emitRows, n),
    model: modelRows,
    scratch: dump(scratchRows, n),
    advanceOut_head: dump(advRows, 2),
    scratchErr,
  }
}, PORT)

console.log(JSON.stringify(diff, null, 1))
await browser.close()
server.stop(true)
