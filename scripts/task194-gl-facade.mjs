// task194-gl-facade — THE GL FACADE BISECT (Task 194).
//
// Raw GL rasterizes into an FBO on this stack (task194-rawgl: 9830 px);
// the rune renderer pipeline does not (canvas OR surface — blank, zero
// errors, draws ARE issued: 376+ drawArrays counted). This probe strips
// the executor/renderer away and drives the REAL facade (realGL) in the
// EXECUTOR'S pinned order over a surface:
//   bindTarget(surface, true) → createProgram → useProgram → setUniform
//   → bindVertexBuffer → drawArrays → readTargetPixels
// If this renders — the bug lives in the executor/command layer; if this
// is blank too — it lives in the facade itself.
// Usage: bun scripts/task194-gl-facade.mjs
import { chromium } from 'playwright'

const root = '/home/z/my-project/rune'
const port = Number(process.env.TASK194GF_PORT ?? 8184)

const server = Bun.serve({
  port,
  async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname)
    if (pathname === '/gate.html') return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    const file = Bun.file(`${root}${pathname}`)
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    return new Response(await file.text(), { headers: { 'content-type': 'text/javascript; charset=utf-8' } })
  },
})

const HTML = `<!doctype html><html><body style="margin:0">
<canvas id="c" width="256" height="256"></canvas>
<canvas id="c2" width="256" height="256" style="margin-left:16px"></canvas>
<script type="module">
import { createWebGL2Renderer } from '/dist/rune.esm.js?v=194f'

const DATA_MODE = new URLSearchParams(location.search).get('data')
let data
if (DATA_MODE === 'soup') {
  data = new Float32Array(3 * 3 * 2)
  let s = 0x9e3779b9
  const rng = () => { s = (s ^ (s >>> 15)) * 2246822519; s = (s ^ (s >>> 13)) * 3266489917; return ((s ^= s >>> 16) >>> 0) / 4294967296 }
  for (let i = 0; i < 9; i++) data[i * 2] = rng() * 1.6 - 0.8
  for (let i = 0; i < 9; i++) data[i * 2 + 1] = rng() * 1.6 - 0.8
} else if (DATA_MODE === 'padded') {
  // the simple triangle + 9 more floats: length 18 like the soup, values simple
  data = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
} else {
  data = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.7, 0])
}
const colors = new Float32Array([1, 0.25, 0.3, 0.3, 0.9, 1, 1, 0.85, 0.2])
const errors = []
try {
  const renderer = await createWebGL2Renderer({
    canvas: document.querySelector('#c'), backend: 'webgl2',
    clear: { color: [0.05, 0.06, 0.09, 1], depth: 1 },
    onGlError: m => errors.push(m),
  })
  const gl = renderer.gl
  // the surface: texture + target, exactly what renderer.surface() builds
  const textureId = gl.createTexture(256, 256)
  const targetId = gl.createTarget(textureId, 256, 256, true, [0.05, 0.06, 0.09, 1])

  // A: the facade draw — the executor's pinned order, verbatim
  const VERT = 'attribute vec3 position; attribute vec3 a_color; uniform float u_alpha; varying vec3 v_color; void main() { v_color = a_color; gl_Position = vec4(position.x * u_alpha, position.y, position.z, 1.0); }'
  const FRAG = 'precision mediump float; varying vec3 v_color; void main() { gl_FragColor = vec4(v_color, 1.0); }'
  const programId = gl.createProgram(VERT, FRAG)
  gl.useProgram(programId)
  const posBuf = gl.createBuffer(data)
  const colBuf = gl.createBuffer(colors)
  gl.setUniform1f(programId, 'u_alpha', 0.9)
  gl.bindVertexBuffer(posBuf, 0, 3, 12, 0, 0)
  gl.bindVertexBuffer(colBuf, 1, 3, 12, 0, 0)
  gl.bindTarget(targetId, true)
  gl.drawArrays('triangles', 0, 3, 1)
  const pxA = gl.readTargetPixels(targetId)

  // B: same but WITH the blend/depth state the executor's applyState would set
  gl.setDepthMode('less', true)
  gl.bindTarget(targetId, true)
  gl.drawArrays('triangles', 0, 3, 1)
  const pxB = gl.readTargetPixels(targetId)

  // C: the FULL pipeline — command + frame + step through the real executor
  // (the redirect: every canvas bind goes to the surface)
  const facade = renderer.inner ? renderer.inner.gl : gl
  const origBind = gl.bindTarget.bind(gl)
  gl.bindTarget = (id, clear) => origBind(id === 0 ? targetId : id, clear)
  const command = renderer.command({
    shader: { glsl: { vertex: VERT, fragment: FRAG } },
    attributes: { position: { data, size: 3 }, a_color: { data: colors, size: 3 } },
    uniforms: { u_alpha: 0.9 },
    count: p => p.count,
  })
  renderer.frame((_ctx, record) => { record(command, { count: 3 }) })
  const surfaceLike = { read: () => Promise.resolve({ width: 256, height: 256, data: gl.readTargetPixels(targetId) }) }
  renderer.step(performance.now())
  renderer.step(performance.now() + 16)
  const pxC = (await surfaceLike.read()).data

  const count = (px) => { let n = 0; for (let i = 0; i < px.length; i += 4) { if (Math.abs(px[i] - 13) > 8 || Math.abs(px[i + 1] - 15) > 8 || Math.abs(px[i + 2] - 23) > 8) n++ } return n }
  window.__res = { a: count(pxA), b: count(pxB), c: count(pxC), errors: errors.slice(0, 3), len: pxA.length }

  // D/E: the variable isolation — driven via ?mode=d / ?mode=e
  const mode = new URLSearchParams(location.search).get('mode')
  if (['d', 'e', 'f', 'g', 'h', 'i', 'j', 'k'].includes(mode)) {
    const { createRenderer: uni, createWebGL2Renderer: strict } = await import('/dist/rune.esm.js?v=194f')
    const make = ['d', 'g', 'j'].includes(mode) ? strict : uni
    const canvasSel = ['i', 'j', 'k'].includes(mode) ? '#c2' : '#c'
    const r2 = await make({ canvas: document.querySelector(canvasSel), backend: 'webgl2', clear: { color: [0.05, 0.06, 0.09, 1], depth: 1 }, onGlError: m => errors.push(m) })
    const cmd2 = r2.command({
      shader: { glsl: { vertex: VERT, fragment: FRAG } },
      attributes: { position: { data, size: 3 }, a_color: { data: colors, size: 3 } },
      uniforms: { u_alpha: 0.9 },
      count: p => p.count,
    })
    const reps = new URLSearchParams(location.search).get('reps')
    r2.frame((_ctx, record) => {
      const n = reps === '4' ? 4 : 1
      for (let i = 0; i < n; i++) record(cmd2, { count: 3 })
    })
    if (['d', 'f', 'g', 'h', 'i', 'j', 'k'].includes(mode)) {
      await r2.start() // the rAF loop
    } else {
      await r2.start().then(() => r2.stop()) // boot the inner, freeze the loop
    }
    const gl2 = (r2.inner ?? r2).gl
    const sf = r2.surface({ width: 256, height: 256, depth: true, color: [0.05, 0.06, 0.09, 1] })
    window.__trace = []
    if (mode === 'k') {
      for (const m of ['setViewport', 'bindVertexBuffer', 'useProgram', 'clear', 'drawElements', 'drawArrays', 'createElementBuffer', 'setUniform1f', 'setDepthMode', 'setUniformMatrix4', 'setUniform4fv', 'setUniform3fv', 'setUniform2fv', 'createBuffer', 'createProgram']) {
        if (typeof gl2[m] === 'function') {
          const orig = gl2[m].bind(gl2)
          gl2[m] = (...a) => { if (window.__trace.length < 40) window.__trace.push(m + '(' + a.join(',').slice(0, 60) + ')'); return orig(...a) }
        }
      }
    }
    const ob = gl2.bindTarget.bind(gl2)
    gl2.bindTarget = (id, clear) => { if (mode === 'k' && window.__trace.length < 40) window.__trace.push('bindTarget(' + id + '→' + (id === 0 ? sf.targetId : id) + ',' + clear + ')'); return ob(id === 0 ? sf.targetId : id, clear) }
    if (mode === 'e') { r2.step(performance.now()); r2.step(performance.now() + 16) }
    if (mode === 'g') { /* strict + rAF + 4x — nothing extra */ }
    await new Promise(r => setTimeout(r, 1500))
    if (mode === 'd') r2.stop()
    const pxD = (await sf.read()).data
    window.__res2 = { mode, nonClear: count(pxD), trace: mode === 'k' ? window.__trace : undefined }
  }
} catch (e) {
  window.__res = { fail: String(e && e.message || e), errors: errors.slice(0, 3) }
}
</script></body></html>`

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})
try {
  const page = await browser.newPage()
  page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 250)))
  const mode = process.env.GF_MODE
  const reps = process.env.GF_REPS
  const dataMode = process.env.GF_DATA
  await page.goto(`http://localhost:${port}/gate.html${mode ? '?mode=' + mode + (reps ? '&reps=' + reps : '') + (dataMode ? '&data=' + dataMode : '') : (dataMode ? '?data=' + dataMode : '')}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  if (mode) await page.waitForFunction(() => window.__res2 !== undefined, null, { timeout: 90_000 })
  else await page.waitForFunction(() => window.__res !== undefined, null, { timeout: 90_000 })
  const r = await page.evaluate(() => window.__res)
  const r2 = await page.evaluate(() => window.__res2).catch(() => null)
  if (r2) {
    console.log(`[gl-facade] ${r2.mode.toUpperCase()}: nonClear=${r2.nonClear}/${65536} — ${r2.nonClear > 100 ? 'RENDERS' : 'BLANK'}`)
    if (r2.trace) console.log('  trace: ' + r2.trace.slice(0, 14).join(' | '))
  }
  if (r.fail) console.log(`[gl-facade] FAIL: ${r.fail.slice(0, 250)}`)
  else {
    console.log(`[gl-facade] A (facade order):  nonClear=${r.a}/${65536}`)
    console.log(`[gl-facade] B (with state):    nonClear=${r.b}/${65536}`)
    console.log(`[gl-facade] C (full pipeline): nonClear=${r.c}/${65536}`)
    console.log(`[gl-facade] errors: ${r.errors.length}${r.errors.length ? ' — ' + r.errors.join(' | ').slice(0, 300) : ''}`)
    const facadeOk = r.a > 100 || r.b > 100
    const pipelineOk = r.c > 100
    console.log(facadeOk
      ? (pipelineOk ? '[gl-facade] BOTH RENDER — the pipeline works when driven manually?!' : '[gl-facade] FACADE RENDERS, PIPELINE BLANK — the bug is in the executor/command layer')
      : '[gl-facade] THE FACADE ITSELF IS BLANK — the bug is in realGL')
  }
} finally {
  await browser.close()
  server.stop()
}
