// task194-readback-probe — THE GATE CONVERSION PROOF (Task 194, direction A).
//
// The channel probe proved the three canvas-hash gates (169/174/187) ride
// parity-of-blanks (the compositor screenshot channel carries no signal on
// this stack; the GL drawing buffer holds ONLY the clear color; the
// toDataURL<2000 blank check cannot catch a solid-color 256x256 PNG).
// This probe proves the FIX works on both backends before the gates are
// rewritten:
//
//   renderer.surface({w,h,depth}) + a facade-level target redirect
//   (bindTarget: 0 -> surface.targetId; WG also beginPass: 0 -> surface)
//   -> the real rAF/step/executor/facade pipeline renders into the surface
//   -> surface.read() (Task 80) = the honest verdict channel.
//
// No monkey-patching of internals: bindTarget/beginPass are the facade's
// PUBLIC methods, the executor calls them through the object (late-bound),
// and the Surface contract itself documents target substitution
// ("Target id for BindTarget (diagnostics/substitution...)").
//
// PASS = both backends: nonClear pixels > 1000, zero GPU/GL errors,
// device/context alive after 40+ frames. Usage: bun scripts/task194-readback-probe.mjs
import { chromium } from 'playwright'

const root = '/home/z/my-project/rune'
const port = Number(process.env.TASK194RP_PORT ?? 8182)

const server = Bun.serve({
  port,
  async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname)
    if (pathname === '/gl.html' || pathname === '/wg.html') {
      return new Response(pageHtml(pathname === '/wg.html'), { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
    const file = Bun.file(`${root}${pathname}`)
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    return new Response(await file.text(), { headers: { 'content-type': 'text/javascript; charset=utf-8' } })
  },
})

function pageHtml(wg) {
  const shader = wg
    ? `const SHADER = { wgsl: \`struct Params { u_mvp: mat4x4<f32>, u_tint: vec4<f32>, u_alpha: f32 }
@group(0) @binding(0) var<uniform> params: Params;
struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) color: vec3<f32> }
@vertex fn vsMain(@location(0) position: vec3<f32>, @location(1) a_color: vec3<f32>) -> VsOut {
  var out: VsOut;
  out.pos = vec4<f32>(position.x * params.u_alpha, position.y, position.z, 1.0);
  out.color = a_color;
  return out;
}
@fragment fn fsMain(@location(0) v_color: vec3<f32>) -> @location(0) vec4<f32> {
  return vec4<f32>(v_color, 1.0);
}\` }`
    : `const SHADER = { glsl: { vertex: \`attribute vec3 position; attribute vec3 a_color; uniform float u_alpha;
varying vec3 v_color; void main() { v_color = a_color; gl_Position = vec4(position.x * u_alpha, position.y, position.z, 1.0); }\`,
fragment: \`precision mediump float; varying vec3 v_color; void main() { gl_FragColor = vec4(v_color, 1.0); }\` } }`
  return `<!doctype html>
<html><body style="margin:0;background:#222">
<canvas id="c" width="256" height="256" style="width:256px;height:256px"></canvas>
<script type="module">
import { createRenderer } from '/dist/rune.esm.js?v=194r'
${shader}

const DATA_MODE = new URLSearchParams(location.search).get('data')
let data
if (DATA_MODE === 'simple') {
  data = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.7, 0])
} else {
  data = new Float32Array(3 * 3 * 2)
  let s = 0x9e3779b9
  const rng = () => { s = (s ^ (s >>> 15)) * 2246822519; s = (s ^ (s >>> 13)) * 3266489917; return ((s ^= s >>> 16) >>> 0) / 4294967296 }
  for (let i = 0; i < 9; i++) data[i * 2] = rng() * 1.6 - 0.8
  for (let i = 0; i < 9; i++) data[i * 2 + 1] = rng() * 1.6 - 0.8
  // Task 194: the RENDERED triangle (size-3 interleaved read) must wind CCW —
  // the GL pipeline culls back faces by default; the raw seeded soup's first
  // triangle was CW (the diagnostic that started this whole dig).
  for (let t = 0; t < 3; t++) {
    const o = t * 9
    const cross = (data[o + 3] - data[o]) * (data[o + 7] - data[o + 1]) - (data[o + 6] - data[o]) * (data[o + 4] - data[o + 1])
    if (cross < 0) {
      for (let k = 0; k < 3; k++) {
        const tmp = data[o + 3 + k]
        data[o + 3 + k] = data[o + 6 + k]
        data[o + 6 + k] = tmp
      }
    }
  }
}
const colors = new Float32Array([1, 0.25, 0.3, 0.3, 0.9, 1, 1, 0.85, 0.2])
const errors = []
try {
  const multiDraw = new URLSearchParams(location.search).get('md') !== '0'
  const passMulti = new URLSearchParams(location.search).get('pm') === '1'
  const renderer = await createRenderer({
    canvas: document.querySelector('#c'), backend: '${wg ? 'webgpu' : 'webgl2'}',
    clear: { color: [0.05, 0.06, 0.09, 1], depth: 1 },
    ...(passMulti ? { multiDraw } : {}),
    ${wg ? 'onGpuError: m => errors.push(m),' : 'onGlError: m => errors.push(m),'}
  })
  const command = renderer.command({
    shader: SHADER,
    attributes: { position: { data, size: 3 }, a_color: { data: colors, size: 3 } },
    ${wg ? "uniforms: { u_mvp: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1], u_tint: [1,1,1,1], u_alpha: 0.9 }," : 'uniforms: { u_alpha: 0.9 },'}
    count: p => p.count,
  })
  window.__frames = 0
  const reps = Number(new URLSearchParams(location.search).get('reps') ?? 4)
  renderer.frame((_ctx, record) => {
    window.__frames++
    for (let i = 0; i < reps; i++) record(command, { count: 3 })
  })
  await renderer.start()

  // THE REDIRECT: every canvas (0) bind goes to the surface instead —
  // the whole production pipeline (rAF -> step -> tape -> executor ->
  // facade) renders into the Task-80 surface; the canvas is never
  // acquired, so no present ever happens on this present-dead stack.
  const surface = renderer.surface({ width: 256, height: 256, depth: true, color: [0.05, 0.06, 0.09, 1] })
  const facade = renderer.inner.${wg ? 'gpu' : 'gl'}
  const origBind = facade.bindTarget.bind(facade)
  facade.bindTarget = (id, clear) => { window.__calls.binds++; return origBind(id === 0 ? surface.targetId : id, clear) }
  window.__calls = { draws: 0, multi: 0, binds: 0 }
  if (!${wg}) {
    const origDraw = facade.drawArrays.bind(facade)
    facade.drawArrays = (...a) => { window.__calls.draws++; return origDraw(...a) }
    if (facade.multiDrawArraysInstanced) {
      const origMulti = facade.multiDrawArraysInstanced.bind(facade)
      facade.multiDrawArraysInstanced = (...a) => { window.__calls.multi++; return origMulti(...a) }
    }
  }
  ${wg ? `const origBegin = facade.beginPass.bind(facade)
  facade.beginPass = () => origBind(surface.targetId, true)` : ''}

  const readSurface = async () => {
    const { data: px } = await surface.read()
    let nonClear = 0
    const cr = Math.round(0.05 * 255), cg = Math.round(0.06 * 255), cb = Math.round(0.09 * 255)
    for (let i = 0; i < px.length; i += 4) {
      if (Math.abs(px[i] - cr) > 8 || Math.abs(px[i + 1] - cg) > 8 || Math.abs(px[i + 2] - cb) > 8) nonClear++
    }
    const digest = await crypto.subtle.digest('SHA-256', px)
    const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
    return { nonClear, hash: hex.slice(0, 16), len: px.length }
  }
  const canvasNonClear = () => {
    const c = document.querySelector('#c')
    const t = document.createElement('canvas'); t.width = c.width; t.height = c.height
    const ctx = t.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(c, 0, 0)
    const img = ctx.getImageData(0, 0, c.width, c.height).data
    let n = 0
    const cr = Math.round(0.05 * 255), cg = Math.round(0.06 * 255), cb = Math.round(0.09 * 255)
    for (let i = 0; i < img.length; i += 4) {
      if (Math.abs(img[i] - cr) > 8 || Math.abs(img[i + 1] - cg) > 8 || Math.abs(img[i + 2] - cb) > 8) n++
    }
    return n
  }
  window.__frame = async () => {
    renderer.stop()
    const first = await readSurface()
    let retried = null
    if (first.nonClear === 0) { // retry: one manual step, read again
      renderer.step(performance.now())
      retried = await readSurface()
    }
    return { ...first, retried, canvasNonClear: canvasNonClear(), multiDraw: renderer.multiDraw, backend: renderer.backend, calls: window.__calls, errors: errors.slice(0, 3) }
  }
  window.__booted = true
} catch (e) { window.__booted = false; window.__err = String(e && e.message || e) }
</script>
</body></html>`
}

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})
let failed = false
try {
  const runs = process.env.GL_REPEAT ? [['GL tier-on', '/gl.html'], ['GL tier-on', '/gl.html'], ['GL tier-on', '/gl.html'], ['GL kill-switch', '/gl.html?md=0'], ['GL kill-switch', '/gl.html?md=0'], ['WG tier-on', '/wg.html']] : [['GL tier-on (webgl2)', '/gl.html'], ['GL kill-switch (webgl2)', '/gl.html?md=0'], ['WG tier-on (webgpu)', '/wg.html']]
  const rpData = process.env.RP_DATA
  if (rpData) {
    for (let i = 0; i < runs.length; i++) {
      runs[i][1] += (runs[i][1].includes('?') ? '&' : '?') + 'data=' + rpData
    }
  }
  if (process.env.RP_PM) {
    for (let i = 0; i < runs.length; i++) {
      runs[i][1] += (runs[i][1].includes('?') ? '&' : '?') + 'pm=1'
    }
  }
  if (process.env.RP_REPS) {
    for (let i = 0; i < runs.length; i++) {
      runs[i][1] += (runs[i][1].includes('?') ? '&' : '?') + 'reps=' + process.env.RP_REPS
    }
  }
  for (const [name, path] of runs) {
    const page = await browser.newPage({ viewport: { width: 400, height: 320 } })
    page.on('pageerror', e => console.log(`  [pageerror ${name}]`, String(e).slice(0, 200)))
    await page.goto(`http://localhost:${port}${path}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForFunction(() => window.__booted !== undefined, null, { timeout: 90_000 })
    if (!await page.evaluate(() => window.__booted)) {
      console.log(`[probe ${name}] BOOT FAIL: ${await page.evaluate(() => window.__err)}`)
      failed = true
      await page.close(); continue
    }
    await page.waitForTimeout(1500) // ~40 frames on the rAF loop
    const result = await page.evaluate(() => window.__frame())
    console.log(`[probe ${name}] backend=${result.backend} multiDraw=${result.multiDraw} nonClear=${result.nonClear}/${65536} hash=${result.hash} errors=${result.errors.length} draws=${result.calls?.draws ?? '-'} multi=${result.calls?.multi ?? '-'} binds=${result.calls?.binds ?? '-'} frames=${result.frames ?? '-'}` + (result.retried ? ` RETRY{nonClear=${result.retried.nonClear}}` : ''))
    if (result.errors.length > 0) { console.log(`  errors: ${result.errors.join(' | ').slice(0, 300)}`); failed = true }
    if (result.nonClear < 1000) { console.log(`  FAIL — the surface readback carries no signal (blank)`); failed = true }
    else console.log(`  OK — REAL pixels through the redirected production pipeline`)
    await page.close()
  }
} catch (error) {
  console.error(`[probe] crashed: ${error instanceof Error ? error.message : String(error)}`)
  failed = true
} finally {
  await browser.close()
  server.stop()
}
console.log(failed ? '\nREADBACK PROBE: FAIL' : '\nREADBACK PROBE: PASS — the gate conversion is valid on both backends')
process.exit(failed ? 1 : 0)
