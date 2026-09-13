// task194-channel-probe — THE GATE-CHANNEL HONESTY PROBE (Task 194, direction A).
//
// The suspicion: task169 (GL arrays) and task187 (GL indexed) both print the
// pixel-parity hash e71fb821e69f — on TWO DIFFERENT scenes (3 vs 4 seeded
// triangles). Identical hashes across different scenes = the channel carries
// no signal (a blank compositor region), and the gates' verdict "IDENTICAL"
// is parity-of-blanks — the same vacuity Task 193 proved for the WG gate
// (98cf6b6016ad). This probe separates the channels on the REAL stack:
//
//   1. COMPOSITOR   — page.screenshot(clip) — the channel task169/187 use;
//   2. DRAWING BUF  — canvas.toDataURL()    — the blank-check channel;
//   3. PIXEL TRUTH  — 2d-canvas readback of the WebGL canvas (getImageData):
//                     non-clear pixel count + a SHA-256 over the RGBA bytes.
//
// Run once for the task169 scene (3 triangles) and once for the task187
// scene (4 triangles): if channel 3 differs while channel 1 matches, the
// compositor channel is blank and both gates are vacuous; if channel 3
// matches too, the GL canvas really renders the same pixels (and the
// same-seed first-18-floats overlap would explain a lot).
// Usage: bun scripts/task194-channel-probe.mjs
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'

const root = '/home/z/my-project/rune'
const port = Number(process.env.TASK194CP_PORT ?? 8181)

const server = Bun.serve({
  port,
  async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname)
    if (pathname === '/gate.html') return new Response(GATE_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    const file = Bun.file(`${root}${pathname}`)
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    return new Response(await file.text(), { headers: { 'content-type': 'text/javascript; charset=utf-8' } })
  },
})

// Two scenes, one page: the task169 soup (3 triangles) and the task187 soup
// (4 indexed triangles) — the SAME seeds the gates use.
const GATE_HTML = `<!doctype html>
<html><body style="margin:0;background:#222">
<canvas id="a" width="256" height="256" style="width:256px;height:256px"></canvas>
<canvas id="b" width="256" height="256" style="width:256px;height:256px;margin-left:16px"></canvas>
<script type="module">
import { createRenderer } from '/dist/rune.esm.js?v=194p'

const VERT = \`attribute vec3 position; attribute vec3 a_color; uniform float u_x;
varying vec3 v_color; void main() { v_color = a_color;
gl_Position = vec4(position.x * u_x, position.y, position.z, 1.0); }\`
const FRAG = \`precision mediump float; varying vec3 v_color;
void main() { gl_FragColor = vec4(v_color, 1.0); }\`

let s = 0x9e3779b9
const rng = () => { s = (s ^ (s >>> 15)) * 2246822519; s = (s ^ (s >>> 13)) * 3266489917; return ((s ^= s >>> 16) >>> 0) / 4294967296 }
const data = new Float32Array(12 * 2)
for (let i = 0; i < 12; i++) data[i * 2] = rng() * 1.6 - 0.8
for (let i = 0; i < 12; i++) data[i * 2 + 1] = rng() * 1.6 - 0.8
const indices = new Uint16Array(12)
for (let t = 0; t < 4; t++) { indices[t * 3] = t * 3; indices[t * 3 + 1] = t * 3 + 1; indices[t * 3 + 2] = t * 3 + 2 }
const colors169 = new Float32Array([1, 0.25, 0.3, 0.3, 0.9, 1, 1, 0.85, 0.2])
const colors187 = new Float32Array([1, 0.25, 0.3, 0.3, 0.9, 1, 1, 0.85, 0.2, 0.55, 0.35, 0.95])

const errorsA = [], errorsB = []
async function boot(canvas, opts, errors) {
  let lastError = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const renderer = await createRenderer({
        canvas, backend: 'webgl2',
        clear: { color: [0.05, 0.06, 0.09, 1], depth: 1 },
        onGlError: m => errors.push(m),
      })
      const command = renderer.command({ ...opts, count: p => p.count })
      renderer.frame((_ctx, record) => { record(command, { count: opts.triangles }) })
      await renderer.start()
      window.__r = window.__r || {}; window.__r[canvas.id] = renderer
      return renderer
    } catch (e) { lastError = e; await new Promise(r => setTimeout(r, 700)) }
  }
  throw lastError ?? new Error('boot failed')
}
try {
  // A: the task169 shape — non-indexed, 3 triangles (9 verts, 9 colors)
  await boot(document.querySelector('#a'), {
    shader: { glsl: { vertex: VERT, fragment: FRAG } },
    attributes: { position: { data: data.subarray(0, 18), size: 3 }, a_color: { data: colors169, size: 3 } },
    uniforms: { u_x: 0.9 }, triangles: 3,
  }, errorsA)
  // B: the task187 shape — indexed, 4 triangles (12 verts, 12 colors)
  await boot(document.querySelector('#b'), {
    shader: { glsl: { vertex: VERT, fragment: FRAG } },
    attributes: { position: { data, size: 3 }, a_color: { data: colors187, size: 3 } },
    indices: { data: indices }, uniforms: { u_x: 0.9 }, triangles: 4,
  }, errorsB)
  window.__ok = true
} catch (e) { window.__fail = String(e && e.message || e) }
</script>
</body></html>`

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})
try {
  const page = await browser.newPage({ viewport: { width: 620, height: 300 } })
  await page.goto(`http://localhost:${port}/gate.html`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForFunction(() => window.__ok !== undefined || window.__fail !== undefined, null, { timeout: 90_000 })
  await page.waitForTimeout(1200)
  // rAF liveness + a forced manual step (bypasses the loop)
  const raf = await page.evaluate(() => new Promise(res => {
    let n = 0
    const t0 = performance.now()
    const tick = () => { n++; if (performance.now() - t0 < 500) requestAnimationFrame(tick); else res(n) }
    requestAnimationFrame(tick)
  }))
  console.log(`[probe] rAF ticks in 500ms: ${raf}`)
  await page.evaluate(() => { for (const r of Object.values(window.__r)) { r.stop() } })
  await page.evaluate(() => { for (const r of Object.values(window.__r)) { r.step(performance.now()); r.step(performance.now() + 16); r.step(performance.now() + 32) } })
  await page.waitForTimeout(400)

  // channel 1 — the compositor screenshot (the gates' channel)
  const shot = async (sel) => {
    const box = await page.evaluate((s) => {
      const r = document.querySelector(s).getBoundingClientRect()
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
    }, sel)
    const buf = await page.screenshot({ clip: box, timeout: 60_000 })
    return createHash('sha256').update(buf).digest('hex')
  }
  // channels 2+3 — in-page: toDataURL length + 2d readback pixel stats
  const inPage = await page.evaluate(() => {
    const out = {}
    for (const id of ['a', 'b']) {
      const c = document.querySelector('#' + id)
      const url = c.toDataURL()
      const t = document.createElement('canvas')
      t.width = c.width; t.height = c.height
      const ctx = t.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(c, 0, 0)
      const img = ctx.getImageData(0, 0, c.width, c.height)
      let nonClear = 0, distinct = new Set()
      const clear = [Math.round(0.05 * 255), Math.round(0.06 * 255), Math.round(0.09 * 255)]
      for (let i = 0; i < img.data.length; i += 4) {
        const px = img.data
        distinct.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2])
        if (Math.abs(px[i] - clear[0]) > 8 || Math.abs(px[i + 1] - clear[1]) > 8 || Math.abs(px[i + 2] - clear[2]) > 8) nonClear++
      }
      out[id] = { dataUrlLen: url.length, nonClear, distinctColors: distinct.size }
    }
    return out
  })
  const failMsg = await page.evaluate(() => window.__fail ?? null)
  if (failMsg) console.log(`[probe] BOOT FAIL: ${failMsg.slice(0, 200)}`)
  const shotA = await shot('#a'), shotB = await shot('#b')
  console.log(`[probe] A (169 scene, 3 tri): shot=${shotA.slice(0, 12)} dataUrlLen=${inPage.a.dataUrlLen} nonClear=${inPage.a.nonClear} distinct=${inPage.a.distinctColors}`)
  console.log(`[probe] B (187 scene, 4 tri): shot=${shotB.slice(0, 12)} dataUrlLen=${inPage.b.dataUrlLen} nonClear=${inPage.b.nonClear} distinct=${inPage.b.distinctColors}`)
  console.log(`[probe] compositor channel identical: ${shotA === shotB} — ${shotA === shotB ? 'NO SIGNAL (blank)' : 'carries signal'}`)
  console.log(`[probe] drawing-buffer channel: A nonClear=${inPage.a.nonClear}, B nonClear=${inPage.b.nonClear} — ${inPage.a.nonClear !== inPage.b.nonClear ? 'DIFFERS (real content)' : 'same'}`)
} catch (error) {
  console.error(`[probe] crashed: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  await browser.close()
  server.stop()
}
