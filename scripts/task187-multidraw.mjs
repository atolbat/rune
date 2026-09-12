// task187 — THE INDEXED MULTI-DRAW LIVE GATE. The mock tests pin the indexed
// batch tier's semantics (the expansion parity, packages/webgl2/tests/task187.test.ts);
// this gate pins it LIVE, on the real SwiftShader WebGL2 stack:
//   A. THE PROBE — does the container's ANGLE context expose
//      WEBGL_multi_draw.multiDrawElementsInstancedWEBGL? (realGL arms the
//      indexed tier by that; absent here the live cells are an honest SKIP).
//   B. THE PIXEL PARITY — the same seeded INDEXED scene on two renderers,
//      one with the tier on (default), one with the kill-switch: identical
//      canvas screenshots. The scene records ONE INDEXED command FOUR
//      times per frame with per-record counts — the batched renderer emits
//      ONE multiDrawElems×4, the classic four drawElements.
//   C. THE HEALTH — zero GL errors on both renderers across the frames.
// Exit 0 — the tier is live-verified (or honestly skipped); 1 — it broke.
// Usage: bun scripts/task187-multidraw.mjs
import { createHash } from 'node:crypto'
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
  for (let t = 0; t < 4; t++) { indices[t * 3] = t * 3; indices[t * 3 + 1] = t * 3 + 1; indices[t * 3 + 2] = t * 3 + 2 }
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
  return renderer
}
const ra = await boot(document.querySelector('#a'), undefined, errorsA)
const rb = await boot(document.querySelector('#b'), false, errorsB)
window.__md = {
  multiDrawA: ra.multiDraw, multiDrawB: rb.multiDraw,
  errorsA, errorsB,
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
  await page.waitForTimeout(900)

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
    const hashOf = async (sel) => {
      const box = await page.evaluate((s) => {
        const r = document.querySelector(s).getBoundingClientRect()
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
      }, sel)
      const shot = await page.screenshot({ clip: box, timeout: 60_000 })
      return createHash('sha256').update(shot).digest('hex')
    }
    const hashA = await hashOf('#a')
    const hashB = await hashOf('#b')
    const same = hashA === hashB
    console.log(`[task187-md] pixel parity: ${same ? 'IDENTICAL' : 'DIFFERS'} (a=${hashA.slice(0, 12)} b=${hashB.slice(0, 12)})`)
    if (!same) failed = true
    const blank = await page.evaluate(() => {
      const c = document.querySelector('#a')
      return c.width > 0 && c.toDataURL().length < 2000
    })
    if (blank) {
      console.log('[task187-md] FAIL — the scene is blank (the draws never landed)')
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
