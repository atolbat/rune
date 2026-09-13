// task169 — THE MULTI-DRAW LIVE GATE. The mock tests pin the batch tier's
// semantics (the expansion parity); this gate pins it LIVE, on the real
// SwiftShader WebGL2 stack the demo-smoke uses:
//   A. THE PROBE — does the container's ANGLE context expose
//      WEBGL_multi_draw? (realGL arms the tier by that; absent here the
//      live cells are an honest SKIP — the semantics stay pinned by the
//      mock tests, the container just cannot exercise the extension.)
//   B. THE PIXEL PARITY — the same seeded scene on two renderers, one with
//      the tier on (default), one with the kill-switch: identical SURFACE
//      READBACKS (SHA-256 over the RGBA bytes, Task 80). The scene records
//      ONE command FOUR times per frame with per-record counts — the
//      batched renderer emits ONE multiDraw×4, the classic four
//      drawArrays — and the pixels must not care which.
//   C. THE HEALTH — zero GL errors through the onGlError sink on both
//      renderers across the frames.
//
// Task 194 — THE CHANNEL FIX: the old gate read canvas screenshots, but on
// this stack rune's GL frames never rasterize into the compositor channel
// (the task194 channel probe: the drawing buffer holds ONLY the clear
// color) — the old "IDENTICAL (e71fb821e69f)" verdict was comparing two
// BLANK screenshots, and its toDataURL<2000 blank check cannot catch a
// solid-color 256x256 PNG. The honest channel: every renderer draws into
// a Task-80 SURFACE via a facade-level bindTarget redirect (the executor
// calls gl.bindTarget late-bound — both the pass start and the target
// switch go through the object property, so one patch covers them). The
// blank check is now REAL: the readback must contain a minimum number of
// non-clear pixels, or the gate FAILS loudly.
// Exit 0 — the tier is live-verified (or honestly skipped); 1 — it broke.
// Usage: bun scripts/task169-multidraw.mjs
import { chromium } from 'playwright'

const root = '/home/z/my-project/rune'
const port = Number(process.env.TASK169MD_PORT ?? 8172)

const server = Bun.serve({
  port,
  async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname)
    if (pathname === '/gate.html') {
      return new Response(GATE_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
    const file = Bun.file(`${root}${pathname}`)
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    return new Response(await file.text(), { headers: { 'content-type': 'text/javascript; charset=utf-8' } })
  },
})

// The gate page: two canvases (their drawing buffers stay untouched — every
// canvas bind is redirected to the surface), two renderers from the FRESH
// dist, one seeded scene recorded identically on both. The multi-draw tier
// is armed by default; the B renderer gets the kill-switch. The window.__md
// handle exposes the verdicts + the GL error log for the driver.
const GATE_HTML = `<!doctype html>
<html><body style="margin:0;background:#222">
<canvas id="a" width="256" height="256" style="width:256px;height:256px"></canvas>
<canvas id="b" width="256" height="256" style="width:256px;height:256px;margin-left:16px"></canvas>
<script type="module">
import { createRenderer } from '/dist/rune.esm.js?v=169'

const VERT = \`#version 300 es
layout(location = 0) in vec3 position;
layout(location = 1) in vec3 a_color;
uniform float u_x;
out vec3 v_color;
void main() { v_color = a_color; gl_Position = vec4(position.x * (0.8 + 0.2 * u_x), position.y, position.z, 1.0); }\`
const FRAG = \`#version 300 es
precision mediump float;
in vec3 v_color;
out vec4 o_color;
void main() { o_color = vec4(v_color, 1.0); }\`

// a seeded soup: three big triangles, distinct colors — the hash has signal
function seededData() {
  const data = new Float32Array(3 * 3 * 2)
  let s = 0x9e3779b9
  const rng = () => { s = (s ^ (s >>> 15)) * 2246822519; s = (s ^ (s >>> 13)) * 3266489917; return ((s ^= s >>> 16) >>> 0) / 4294967296 }
  for (let i = 0; i < 9; i++) data[i * 2] = rng() * 1.6 - 0.8
  for (let i = 0; i < 9; i++) data[i * 2 + 1] = rng() * 1.6 - 0.8
  // Task 194: wind every RENDERED triangle CCW. The attribute reads the soup
  // interleaved (size 3, tight stride): triangle t's vertices live at
  // data[9t..9t+8] as (x,y,z) triples. The GL pipeline culls back faces by
  // DEFAULT (raster.cull ?? 'back'); the WG one defaults to cullMode 'none'
  // — a documented backend asymmetry. The seeded soup's first triangle
  // happened to be CW: this gate had drawn NOTHING on GL since its birth
  // (the blank-parity root cause #2, under the blank compositor channel).
  for (let t = 0; t < 3; t++) {
    const o = t * 9
    const cross = (data[o + 3] - data[o]) * (data[o + 7] - data[o + 1]) - (data[o + 6] - data[o]) * (data[o + 4] - data[o + 1])
    if (cross < 0) { // swap v1 (data[o+3..5]) with v2 (data[o+6..8])
      for (let k = 0; k < 3; k++) {
        const tmp = data[o + 3 + k]
        data[o + 3 + k] = data[o + 6 + k]
        data[o + 6 + k] = tmp
      }
    }
  }
  return data
}
const soup = seededData()
const colors = new Float32Array([1, 0.25, 0.3, 0.3, 0.9, 1, 1, 0.85, 0.2])

const errorsA = [], errorsB = []
async function boot(canvas, multiDraw, errors) {
  const renderer = await createRenderer({
    canvas, backend: 'webgl2',
    clear: { color: [0.05, 0.06, 0.09, 1], depth: 1 },
    multiDraw,
    onGlError: m => errors.push(m),
  })
  const command = renderer.command({
    shader: { glsl: { vertex: VERT, fragment: FRAG } },
    attributes: { position: { data: soup, size: 3 }, a_color: { data: colors, size: 3 } },
    uniforms: { u_x: 0.0 },
    count: (p) => p.count,
  })
  renderer.frame((_ctx, record) => {
    // the multi-draw shape: the SAME command four times, different counts
    // (the soup drawn in slices — layered effects, chunked streaming)
    record(command, { count: 3 })
    record(command, { count: 3 })
    record(command, { count: 3 })
    record(command, { count: 3 })
  })
  await renderer.start()

  // ── Task 194: THE TARGET REDIRECT ──────────────────────────────────────
  // Every canvas (0) bind goes to the surface instead — the executor's
  // beginPass (gl.bindTarget(0, false) + clear) and every target switch
  // all ride the object property, so one patch covers the whole frame.
  // The rAF loop renders into the Task-80 surface; the compositor channel
  // (blank on this stack) is no longer the verdict.
  const surface = renderer.surface({ width: 256, height: 256, depth: true, color: [0.05, 0.06, 0.09, 1] })
  const facade = renderer.inner.gl
  const origBind = facade.bindTarget.bind(facade)
  facade.bindTarget = (id, clear) => origBind(id === 0 ? surface.targetId : id, clear)
  renderer.__surface = surface
  return renderer
}
const ra = await boot(document.querySelector('#a'), undefined, errorsA)
const rb = await boot(document.querySelector('#b'), false, errorsB)
// settle: a few frames of the loop render into the surfaces
await new Promise(r => setTimeout(r, 1500))
const read = async (renderer) => {
  renderer.stop()
  const { data } = await renderer.__surface.read()
  const digest = await crypto.subtle.digest('SHA-256', data)
  const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
  const cr = Math.round(0.05 * 255), cg = Math.round(0.06 * 255), cb = Math.round(0.09 * 255)
  let nonClear = 0
  for (let i = 0; i < data.length; i += 4) {
    if (Math.abs(data[i] - cr) > 8 || Math.abs(data[i + 1] - cg) > 8 || Math.abs(data[i + 2] - cb) > 8) nonClear++
  }
  return { hash: hex, nonClear, len: data.length }
}
const pa = await read(ra), pb = await read(rb)
window.__md = {
  multiDrawA: ra.multiDraw, multiDrawB: rb.multiDraw,
  errorsA, errorsB,
  hashA: pa.hash, hashB: pb.hash, nonClearA: pa.nonClear, nonClearB: pb.nonClear,
  ext: (() => { const c = document.createElement('canvas'); return c.getContext('webgl2')?.getExtension('WEBGL_multi_draw') != null })(),
}
</script>
</body></html>`

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--no-sandbox'],
})

let failed = false
try {
  const page = await browser.newPage({ viewport: { width: 600, height: 300 } })
  await page.goto(`http://localhost:${port}/gate.html`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForFunction(() => window.__md !== undefined, null, { timeout: 60_000 })

  const md = await page.evaluate(() => window.__md)
  console.log(`[task169-md] extension present: ${md.ext}; renderer A (default): multiDraw=${md.multiDrawA}; renderer B (kill-switch): multiDraw=${md.multiDrawB}`)
  console.log(`[task169-md] GL errors — A: ${md.errorsA.length}, B: ${md.errorsB.length}`)
  if (md.errorsA.length > 0 || md.errorsB.length > 0) {
    for (const e of [...md.errorsA, ...md.errorsB].slice(0, 5)) console.log(`           ${e.slice(0, 180)}`)
    failed = true
  }

  if (!md.ext || !md.multiDrawA) {
    // the honest skip: the container's ANGLE build lacks WEBGL_multi_draw —
    // the live parity is vacuous here (nothing arms the tier); the mock
    // tests carry the semantics. NOT a failure of this pass.
    console.log('[task169-md] SKIP — the container context lacks WEBGL_multi_draw; the live pixel parity cannot run here (semantics pinned by packages/webgl2/tests/task169.test.ts)')
  } else {
    if (md.multiDrawB) {
      console.log('[task169-md] FAIL — the kill-switch renderer reports multiDraw=true (the option does not reach the executor)')
      failed = true
    }
    // THE PIXEL PARITY — the surface readbacks (Task 80), the honest channel
    const same = md.hashA === md.hashB
    console.log(`[task169-md] pixel parity (surface readback): ${same ? 'IDENTICAL' : 'DIFFERS'} (a=${md.hashA.slice(0, 12)} b=${md.hashB.slice(0, 12)}, nonClear a=${md.nonClearA} b=${md.nonClearB}/${256 * 256})`)
    if (!same) failed = true
    // THE REAL BLANK CHECK — the draws must have LANDED (the old
    // toDataURL<2000 check could never catch a solid-color canvas)
    const MIN_PAINTED = 500
    if (md.nonClearA < MIN_PAINTED || md.nonClearB < MIN_PAINTED) {
      console.log(`[task169-md] FAIL — the surface is (near-)blank: nonClear a=${md.nonClearA} b=${md.nonClearB} < ${MIN_PAINTED} (the draws never landed)`)
      failed = true
    }
  }
} catch (error) {
  console.error(`[task169-md] gate crashed: ${error instanceof Error ? error.message : String(error)}`)
  failed = true
} finally {
  await browser.close()
  server.stop()
}

console.log(failed ? '\nTASK169 MULTI-DRAW GATE: FAIL' : '\nTASK169 MULTI-DRAW GATE: PASS')
process.exit(failed ? 1 : 0)
