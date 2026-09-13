// task187 — THE INDEXED MULTI-DRAW LIVE GATE. The mock tests pin the indexed
// batch tier's semantics (the expansion parity, packages/webgl2/tests/task187.test.ts);
// this gate pins it LIVE, on the real SwiftShader WebGL2 stack:
//   A. THE PROBE — does the container's ANGLE context expose
//      WEBGL_multi_draw.multiDrawElementsInstancedWEBGL? (realGL arms the
//      indexed tier by that; absent here the live cells are an honest SKIP).
//   B. THE PIXEL PARITY — the same seeded INDEXED scene on two renderers,
//      one with the tier on (default), one with the kill-switch: identical
//      SURFACE READBACKS (Task 80). The scene records ONE INDEXED command
//      FOUR times per frame with per-record counts — the batched renderer
//      emits ONE multiDrawElems×4, the classic four drawElements.
//   C. THE HEALTH — zero GL errors on both renderers across the frames.
//
// Task 194 — THE CHANNEL FIX: the old canvas-screenshot parity was comparing
// two BLANK screenshots (this stack's compositor channel never shows rune's
// GL frames, and the seeded soup's first triangle was BACK-FACING — the GL
// pipeline culls back faces by default — so the gate had drawn NOTHING
// since Task 187). The honest channel: the Task-80 surface readback via a
// facade-level bindTarget redirect (no compositor in the verdict path), a
// CCW-wound soup, and a REAL non-clear-pixel blank check.
// Exit 0 — the tier is live-verified (or honestly skipped); 1 — it broke.
// Usage: bun scripts/task187-multidraw.mjs
import { chromium } from 'playwright'

const root = '/home/z/my-project/rune'
const port = Number(process.env.TASK187MD_PORT ?? 8174)

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

const GATE_HTML = `<!doctype html>
<html><body style="margin:0;background:#222">
<canvas id="a" width="256" height="256" style="width:256px;height:256px"></canvas>
<canvas id="b" width="256" height="256" style="width:256px;height:256px;margin-left:16px"></canvas>
<script type="module">
import { createRenderer } from '/dist/rune.esm.js?v=187'

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

// a seeded indexed soup: four triangles, a shared [0,1,2,0,2,3]-style
// pattern per triangle, distinct colors — the hash has signal
function seededIndexedSoup() {
  const data = new Float32Array(4 * 3 * 2)
  const indices = new Uint16Array(4 * 3)
  let s = 0x9e3779b9
  const rng = () => { s = (s ^ (s >>> 15)) * 2246822519; s = (s ^ (s >>> 13)) * 3266489917; return ((s ^= s >>> 16) >>> 0) / 4294967296 }
  for (let i = 0; i < 12; i++) data[i * 2] = rng() * 1.6 - 0.8
  for (let i = 0; i < 12; i++) data[i * 2 + 1] = rng() * 1.6 - 0.8
  // Task 194: wind every RENDERED triangle CCW (the attribute reads the soup
  // interleaved — size 3, tight stride — so triangle t's vertices are the
  // triples at data[9t..9t+8]; the index pattern walks them 0,1,2). The GL
  // pipeline culls back faces by DEFAULT; the seeded first triangle was CW
  // — the old gate drew NOTHING. Fix the winding in the INDEX ORDER only
  // (a data swap here would need its own index flip — and both together
  // re-reverse the triangle back to back-facing).
  for (let t = 0; t < 4; t++) {
    const o = t * 9
    const cross = (data[o + 3] - data[o]) * (data[o + 7] - data[o + 1]) - (data[o + 6] - data[o]) * (data[o + 4] - data[o + 1])
    indices[t * 3] = t * 3
    indices[t * 3 + 1] = t * 3 + (cross < 0 ? 2 : 1)
    indices[t * 3 + 2] = t * 3 + (cross < 0 ? 1 : 2)
  }
  return { data, indices }
}
const soup = seededIndexedSoup()
const colors = new Float32Array([1, 0.25, 0.3, 0.3, 0.9, 1, 1, 0.85, 0.2, 0.55, 0.35, 0.95])

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
    attributes: { position: { data: soup.data, size: 3 }, a_color: { data: colors, size: 3 } },
    uniforms: { u_x: 0.0 },
    indices: { data: soup.indices },
    count: (p) => p.count,
  })
  renderer.frame((_ctx, record) => {
    // the indexed multi-draw shape: the SAME indexed command four times,
    // per-record index counts (the soup drawn in index slices — the
    // batched renderer must collapse them into ONE multiDrawElems×4)
    record(command, { count: 3 })
    record(command, { count: 3 })
    record(command, { count: 3 })
    record(command, { count: 3 })
  })
  await renderer.start()

  // ── Task 194: THE TARGET REDIRECT (the honest verdict channel) ────────
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
  return { hash: hex, nonClear }
}
const pa = await read(ra), pb = await read(rb)
window.__md = {
  multiDrawA: ra.multiDraw, multiDrawB: rb.multiDraw,
  errorsA, errorsB,
  hashA: pa.hash, hashB: pb.hash, nonClearA: pa.nonClear, nonClearB: pb.nonClear,
  ext: (() => {
    const c = document.createElement('canvas')
    const gl = c.getContext('webgl2')
    const ext = gl?.getExtension('WEBGL_multi_draw')
    return ext !== null && ext !== undefined && typeof ext.multiDrawElementsInstancedWEBGL === 'function'
  })(),
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
  console.log(`[task187-md] elements ext present: ${md.ext}; renderer A (default): multiDraw=${md.multiDrawA}; renderer B (kill-switch): multiDraw=${md.multiDrawB}`)
  console.log(`[task187-md] GL errors — A: ${md.errorsA.length}, B: ${md.errorsB.length}`)
  if (md.errorsA.length > 0 || md.errorsB.length > 0) {
    for (const e of [...md.errorsA, ...md.errorsB].slice(0, 5)) console.log(`           ${e.slice(0, 180)}`)
    failed = true
  }

  if (!md.ext || !md.multiDrawA) {
    console.log('[task187-md] SKIP — the container context lacks multiDrawElementsInstancedWEBGL; the live pixel parity cannot run here (semantics pinned by packages/webgl2/tests/task187.test.ts)')
  } else {
    if (md.multiDrawB) {
      console.log('[task187-md] FAIL — the kill-switch renderer reports multiDraw=true (the option does not reach the executor)')
      failed = true
    }
    // THE PIXEL PARITY — the surface readbacks (Task 80), the honest channel
    const same = md.hashA === md.hashB
    console.log(`[task187-md] pixel parity (surface readback): ${same ? 'IDENTICAL' : 'DIFFERS'} (a=${md.hashA.slice(0, 12)} b=${md.hashB.slice(0, 12)}, nonClear a=${md.nonClearA} b=${md.nonClearB}/${256 * 256})`)
    if (!same) failed = true
    // THE REAL BLANK CHECK — the draws must have LANDED
    const MIN_PAINTED = 500
    if (md.nonClearA < MIN_PAINTED || md.nonClearB < MIN_PAINTED) {
      console.log(`[task187-md] FAIL — the surface is (near-)blank: nonClear a=${md.nonClearA} b=${md.nonClearB} < ${MIN_PAINTED} (the draws never landed)`)
      failed = true
    }
  }
} catch (error) {
  console.error(`[task187-md] gate crashed: ${error instanceof Error ? error.message : String(error)}`)
  failed = true
} finally {
  await browser.close()
  server.stop()
}

console.log(failed ? '\nTASK187 INDEXED MULTI-DRAW GATE: FAIL' : '\nTASK187 INDEXED MULTI-DRAW GATE: PASS')
process.exit(failed ? 1 : 0)
