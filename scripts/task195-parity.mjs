// task195-parity — THE CROSS-BACKEND RASTER-STATE CONTRACT BENCH (Task 195).
//
// The Task-194 dig left a named candidate: the GL/WebGPU raster defaults
// diverge — GL command.ts compiled `raster?.cull ?? 'back'` while realGPU
// maps an absent cull to 'none' (the WebGPU spec default), and frontFace is
// honored on WebGPU (pipeline-baked) but DROPPED on the whole WebGL2 path
// (the DrawSpec type never declared it, readState never read it, realGL has
// no method for it). A CW-wound user scene renders on WebGPU and silently
// blanks on WebGL2 — a cross-backend contract hole, not a driver issue.
//
// This bench proves the hole and the fix on the honest channel (Task 194's
// conversion): the production pipeline (renderer -> command -> tape ->
// executor -> facade) renders into a Task-80 surface through the public
// bindTarget/beginPass redirect — no canvas present on this present-dead
// stack. Five legs per backend:
//
//   A  no pipeline field at all (the DEFAULT contract)   + CW triangle
//   B  raster { cull:'none', frontFace:'ccw' }           + CW triangle  — the explicit neutral twin of A
//   C  raster { cull:'back', frontFace:'cw' }            + CW triangle  — frontFace must be HONORED
//   D  raster { cull:'back' }                            + CCW triangle — culling still works (control)
//   E  raster { cull:'front' }                           + CCW triangle — front-face culling blanks (control)
//
// PASS (both backends): A painted; hash(A) === hash(B) — the default is
// EXACTLY the explicit neutral state; C painted; D painted; E blank;
// zero GPU/GL errors. Pre-fix WebGL2 FAILS A, C (blank) and the A/B hash
// parity; WebGPU passes everything (its defaults were already right).
//
// Winding note: CW = (-0.5,-0.5) -> (0,0.7) -> (0.5,-0.5) (signed area < 0),
// CCW = (-0.5,-0.5) -> (0.5,-0.5) -> (0,0.7) (signed area > 0) in NDC.
// Usage: bun scripts/task195-parity.mjs
import { chromium } from 'playwright'

const root = '/home/z/my-project/rune'
const port = Number(process.env.TASK195_PORT ?? 8183)

// Leg -> { pipeline (null = absent), cw (triangle winding), expectPainted }
const LEGS = {
  A: { pipeline: null, cw: true, painted: true },
  B: { pipeline: { raster: { cull: 'none', frontFace: 'ccw' } }, cw: true, painted: true },
  C: { pipeline: { raster: { cull: 'back', frontFace: 'cw' } }, cw: true, painted: true },
  D: { pipeline: { raster: { cull: 'back' } }, cw: false, painted: true },
  E: { pipeline: { raster: { cull: 'front' } }, cw: false, painted: false },
}

// Legs as plain JSON for the page (expectations stay harness-side).
const LEGS_JSON = JSON.stringify(Object.fromEntries(
  Object.entries(LEGS).map(([name, leg]) => [name, { pipeline: leg.pipeline, cw: leg.cw }]),
))

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
import { createRenderer } from '/dist/rune.esm.js?v=195r'
${shader}

// The leg's pipeline + winding, chosen by the harness through ?leg=.
const LEGS = ${LEGS_JSON}
const LEG = LEGS[new URLSearchParams(location.search).get('leg')]
if (LEG === undefined) throw new Error('unknown leg: ' + new URLSearchParams(location.search).get('leg'))
const PIPELINE = LEG.pipeline
const DATA = LEG.cw
  ? new Float32Array([-0.5, -0.5, 0, 0, 0.7, 0, 0.5, -0.5, 0])   // CW (signed area < 0)
  : new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.7, 0])   // CCW (signed area > 0)
const colors = new Float32Array([1, 0.25, 0.3, 0.3, 0.9, 1, 1, 0.85, 0.2])
const errors = []
try {
  const renderer = await createRenderer({
    canvas: document.querySelector('#c'), backend: '${wg ? 'webgpu' : 'webgl2'}',
    clear: { color: [0.05, 0.06, 0.09, 1], depth: 1 },
    ${wg ? 'onGpuError: m => errors.push(m),' : 'onGlError: m => errors.push(m),'}
  })
  const command = renderer.command({
    shader: SHADER,
    ...(PIPELINE ? { pipeline: PIPELINE } : {}),
    attributes: { position: { data: DATA, size: 3 }, a_color: { data: colors, size: 3 } },
    ${wg ? "uniforms: { u_mvp: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1], u_tint: [1,1,1,1], u_alpha: 0.9 }," : 'uniforms: { u_alpha: 0.9 },'}
    count: 3,
  })
  renderer.frame((_ctx, record) => { record(command, { count: 3 }) })
  await renderer.start()

  // The Task-194 redirect: the whole production pipeline renders into the
  // surface; the canvas is never acquired (no present on this stack).
  const surface = renderer.surface({ width: 256, height: 256, depth: true, color: [0.05, 0.06, 0.09, 1] })
  const facade = renderer.inner.${wg ? 'gpu' : 'gl'}
  const origBind = facade.bindTarget.bind(facade)
  facade.bindTarget = (id, clear) => origBind(id === 0 ? surface.targetId : id, clear)
  window.__calls = { draws: 0 }
  if (!${wg}) {
    const origDraw = facade.drawArrays.bind(facade)
    facade.drawArrays = (...a) => { window.__calls.draws++; return origDraw(...a) }
  } else {
    const origBegin = facade.beginPass.bind(facade)
    facade.beginPass = () => origBind(surface.targetId, true)
  }

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
  window.__frame = async () => {
    renderer.stop()
    const first = await readSurface()
    let retried = null
    if (first.nonClear === 0) {
      renderer.step(performance.now())
      retried = await readSurface()
    }
    const verdict = (retried ?? first)
    return { ...first, retried, nonClearFinal: verdict.nonClear, hashFinal: verdict.hash, backend: renderer.backend, calls: window.__calls, errors: errors.slice(0, 3) }
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

const results = {} // results[backend][leg] = { nonClear, hash, errors }
let failed = false
try {
  for (const backend of ['gl', 'wg']) {
    const backendHtml = `/${backend}.html`
    results[backend] = {}
    for (const [legName, leg] of Object.entries(LEGS)) {
      const page = await browser.newPage({ viewport: { width: 400, height: 320 } })
      page.on('pageerror', e => console.log(`  [pageerror ${backend}/${legName}]`, String(e && e.stack || e).slice(0, 300)))
      await page.goto(`http://localhost:${port}${backendHtml}?leg=${legName}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await page.waitForFunction(() => window.__booted !== undefined, null, { timeout: 90_000 })
      if (!await page.evaluate(() => window.__booted)) {
        console.log(`[${backend}/${legName}] BOOT FAIL: ${await page.evaluate(() => window.__err)}`)
        failed = true
        results[backend][legName] = { boot: false }
        await page.close()
        continue
      }
      await page.waitForTimeout(1200)
      const r = await page.evaluate(() => window.__frame())
      results[backend][legName] = r
      const painted = r.nonClearFinal
      const expect = leg.painted
      const verdictOk = expect ? painted > 1000 : painted < 100
      if (!verdictOk || r.errors.length > 0) failed = true
      console.log(`[${backend}/${legName}] ${expect ? 'expect-painted' : 'expect-blank '}: nonClear=${painted}/${65536} hash=${r.hashFinal} draws=${r.calls?.draws ?? '-'} errors=${r.errors.length}${r.retried ? ' (after retry)' : ''} ${verdictOk && r.errors.length === 0 ? 'OK' : 'FAIL'}`)
      if (r.errors.length > 0) console.log(`   errors: ${r.errors.join(' | ').slice(0, 200)}`)
      await page.close()
    }
  }
  // THE CONTRACT CROSS-CHECKS: default === explicit neutral (A vs B), per backend.
  for (const backend of ['gl', 'wg']) {
    const a = results[backend]?.A, b = results[backend]?.B
    if (a?.hashFinal && b?.hashFinal) {
      const same = a.hashFinal === b.hashFinal
      console.log(`[${backend}] default(A) ${same ? '===' : '!=='} explicit-neutral(B): ${a.hashFinal} vs ${b.hashFinal} — ${same ? 'the contract holds' : 'CONTRACT VIOLATION (the default is not the neutral state)'}`)
      if (!same) failed = true
    }
  }
} catch (error) {
  console.error(`[parity] crashed: ${error instanceof Error ? error.message : String(error)}`)
  failed = true
} finally {
  await browser.close()
  server.stop()
}
console.log(failed ? '\nTASK195 PARITY: FAIL' : '\nTASK195 PARITY: PASS — the raster-state contract is identical on both backends (cull none / frontFace ccw defaults, frontFace honored)')
process.exit(failed ? 1 : 0)
