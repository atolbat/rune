// task197-tfdebug — bisect the TF capture path on the live ANGLE stack.
// The occlusion GL tier's cull pass silently captured NOTHING (the flag
// buffer stayed zero, zero GL errors). This walks the ladder: trivial →
// +attributes → +textures → the full cull shader shape.
import { chromium } from 'playwright'

const root = '/home/z/my-project/rune'
const port = Number(process.env.TFDBG_PORT ?? 8191)
const server = Bun.serve({
  port,
  async fetch(request) {
    let pathname = decodeURIComponent(new URL(request.url).pathname)
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = Bun.file(`${root}${pathname}`)
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    return new Response(await file.arrayBuffer(), {
      headers: { 'content-type': pathname.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8' },
    })
  },
})

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu-sandbox', '--use-angle=swiftshader'] })
const page = await browser.newPage()
page.on('console', m => console.log(`[page:${m.type()}] ${m.text().slice(0, 400)}`))
page.on('pageerror', e => console.log(`[pageerror] ${String(e).slice(0, 400)}`))

await page.goto(`http://localhost:${port}/demo/occlusion/`, { waitUntil: 'domcontentloaded' })
const result = await page.evaluate(async () => {
  const { createWebGL2Renderer } = await import('/dist/rune.esm.js')
  const canvas = document.createElement('canvas')
  canvas.width = 8; canvas.height = 8
  const renderer = createWebGL2Renderer({ canvas, dpr: 1, observeResize: false })
  const gl = renderer.gl
  const log = []
  const step = (name, fn) => {
    try { const r = fn(); log.push({ name, ok: true, r }); return r } catch (e) { log.push({ name, ok: false, err: String(e) }); return null }
  }

  // ── rung 1: the trivial TF pass ──
  const flags = step('createBuffer', () => gl.createBuffer(new Float32Array(64), 'dynamic'))
  const trivial = step('createTransformPass(trivial)', () => gl.createTransformPass({
    vertex: `#version 300 es
out float v_flag;
void main() { v_flag = float(gl_VertexID & 3); gl_Position = vec4(0.0, 0.0, 0.0, 1.0); }`,
    outputs: ['v_flag'],
  }))
  if (trivial !== null) {
    step('runTransformPass(trivial)', () => gl.runTransformPass(trivial, 8, { bufferId: flags }))
    const dst = new Float32Array(8)
    const ok = step('readBuffer(trivial)', () => gl.readBuffer(flags, dst))
    log.push({ name: 'trivial flags', ok: true, r: Array.from(dst).join(',') })
  }

  // ── rung 2: + attributes (stride/offset, the scene-record shape) ──
  const recs = new Float32Array(8 * 12)
  for (let i = 0; i < 8; i++) { recs[i * 12] = i * 0.25; recs[i * 12 + 1] = 1.0; recs[i * 12 + 3] = 0.5; recs[i * 12 + 12 - 1] = 0 }
  const sceneBuf = step('createBuffer(scene)', () => gl.createBuffer(recs, 'static'))
  const withAttrs = step('createTransformPass(attrs)', () => gl.createTransformPass({
    vertex: `#version 300 es
layout(location=0) in vec3 a_c;
layout(location=1) in vec3 a_h;
out float v_flag;
void main() { v_flag = 10.0 + a_c.x + a_h.x; gl_Position = vec4(0.0, 0.0, 0.0, 1.0); }`,
    outputs: ['v_flag'],
    attributes: [
      { name: 'a_c', size: 3, stride: 48, offset: 0 },
      { name: 'a_h', size: 3, stride: 48, offset: 12 },
    ],
  }))
  if (withAttrs !== null) {
    step('runTransformPass(attrs)', () => gl.runTransformPass(withAttrs, 8, { bufferId: flags, attribBuffers: [sceneBuf, sceneBuf] }))
    const dst = new Float32Array(8)
    gl.readBuffer(flags, dst)
    log.push({ name: 'attrs flags', ok: true, r: Array.from(dst).map(v => v.toFixed(2)).join(',') })
  }

  // ── rung 3: + uniforms + textures (the cull shape, small) ──
  const tex = step('createTexture r32f', () => gl.createTexture(4, 4, { format: 'r32f' }))
  const target = step('createTarget', () => gl.createTarget(tex, 4, 4, false, [0, 0, 0, 1]))
  // upload a pattern into the r32f via texSubImage2D
  step('texSubImage2D', () => gl.texSubImage2D(tex, 0, 0, 4, 4, new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65])))
  const withTex = step('createTransformPass(tex)', () => gl.createTransformPass({
    vertex: `#version 300 es
layout(location=0) in vec3 a_c;
uniform vec4 u_misc;
uniform sampler2D u_pyr[2];
out float v_flag;
float pyrAt(int L, ivec2 p) {
  if (L == 0) { return texelFetch(u_pyr[0], p, 0).r; }
  if (L == 1) { return texelFetch(u_pyr[1], p, 0).r; }
  return -1.0;
}
void main() {
  float z = pyrAt(int(u_misc.y), ivec2(gl_VertexID & 3, 0));
  v_flag = 100.0 + z * 10.0;
  gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
}`,
    outputs: ['v_flag'],
    attributes: [{ name: 'a_c', size: 3, stride: 48, offset: 0 }],
    textures: ['u_pyr[0]', 'u_pyr[1]'],
    uniforms: [{ name: 'u_misc', size: 4 }],
  }))
  if (withTex !== null) {
    const u = new Float32Array([1, 0, 0, 0])
    step('runTransformPass(tex)', () => gl.runTransformPass(withTex, 8, { bufferId: flags, attribBuffers: [sceneBuf], textures: [tex, tex], uniformData: u }))
    const dst = new Float32Array(8)
    gl.readBuffer(flags, dst)
    log.push({ name: 'tex flags', ok: true, r: Array.from(dst).map(v => v.toFixed(2)).join(',') })
  }
  renderer.step(performance.now())
  return log
})
for (const e of result) console.log(`${e.ok ? 'PASS' : 'FAIL'} ${e.name}: ${e.ok ? JSON.stringify(e.r ?? '') : e.err}`)
await browser.close()
server.stop()
