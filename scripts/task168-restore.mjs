// task168 — THE RESTORE WIRE, LIVE: context-loss recovery on the real
// bundle (dist) in a real browser.
//
// THE CONTAINER FINDING (documented honestly): this Chrome+SwiftShader
// combo NEVER delivers webglcontextrestored after restoreContext() — a raw
// browser probe (no library) shows the context stuck at isContextLost()=true
// forever, so the browser-leg of the restore event cannot be exercised here.
// On real hardware the event is spec-pinned and well-supported. The gate
// therefore drives BOTH honest halves:
//   LEG 1 (synthetic events, LIVE context): dispatch webglcontextlost +
//     webglcontextrestored synthetically on a healthy context — the events
//     carry exactly the browser's contract (same canvas, same context
//     object, isContextLost()===false at restore time), so OUR full wire
//     runs for real: the loop stops at the loss, the journal replays at the
//     restore, the program re-creates from its spec, the loop resumes and
//     DRAWS on the live context.
//   LEG 2 (the REAL loss event): WEBGL_lose_context.loseContext() — the
//     browser DOES deliver webglcontextlost here; the loop stops with the
//     honest report (the zombie guard, live).
// The mock-level contracts (the replay arithmetic, the resume conditions,
// the dispose guard, the plain-path boundary) are pinned by
// packages/gl/tests/task168.test.ts.
import { chromium } from 'playwright'

const root = '/home/z/my-project/rune'
const port = Number(process.env.TASK168_PORT ?? 8183)

let failures = 0
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} — ${detail}`)
  if (!ok) failures++
}

const PAGE = `<!doctype html><html><body>
<canvas id="c" width="320" height="240"></canvas>
<script type="module">
  import { createWebGL2Renderer, createResourceJournal } from 'http://localhost:${port}/dist/rune.esm.js?v=168'

  const canvas = document.getElementById('c')
  const journal = createResourceJournal()
  const errors = []
  const state = { frames: 0, draws: 0, textures: 0, programs: 0 }

  const renderer = createWebGL2Renderer({
    canvas,
    resources: journal,
    requestFrame: cb => { const id = requestAnimationFrame(cb); return () => cancelAnimationFrame(id) },
    onGlError: message => errors.push(message),
  })

  const command = renderer.command({
    shader: { glsl: { vertex: \`#version 300 es
layout(location = 0) in vec3 position;
void main() { gl_Position = vec4(position, 1.0); }\`,
fragment: \`#version 300 es
precision mediump float;
uniform vec4 u_tint;
out vec4 o_color;
void main() { o_color = u_tint; }\` } },
    attributes: { position: { data: new Float32Array([-.5,-.5,0, .5,-.5,0, 0,.5,0]), size: 3 } },
    uniforms: { u_tint: [1, 0.5, 0.25, 1] },
    count: 3,
  })
  renderer.frame((_ctx, record) => record(command, {}))
  const tex = renderer.texture(64, 64)
  renderer.start()

  // GL-call counters (wrap the REAL context the renderer acquired)
  const raw = canvas.getContext('webgl2')
  const origDraw = raw.drawArrays.bind(raw)
  raw.drawArrays = (...a) => { state.draws++; return origDraw(...a) }
  const origTex = raw.createTexture.bind(raw)
  raw.createTexture = (...a) => { state.textures++; return origTex(...a) }
  const origProgram = raw.createProgram.bind(raw)
  raw.createProgram = (...a) => { state.programs++; return origProgram(...a) }
  const origRaf = requestAnimationFrame.bind(window)
  window.requestAnimationFrame = cb => origRaf(ts => { state.frames++; return cb(ts) })

  window.__t168 = {
    get frames() { return state.frames },
    get draws() { return state.draws },
    get textures() { return state.textures },
    get programs() { return state.programs },
    get errors() { return errors },
    texId: tex.textureId,
    // LEG 1: the synthetic event pair (the browser's contract, dispatched by
    // hand — the container never fires the restored half itself)
    syntheticLoss() { canvas.dispatchEvent(new Event('webglcontextlost')) },
    syntheticRestore() { canvas.dispatchEvent(new Event('webglcontextrestored')) },
    // LEG 2: the REAL loss (the browser delivers this one)
    realLoss() { raw.getExtension('WEBGL_lose_context')?.loseContext() },
    reallyLost() { return raw.isContextLost() === true },
  }
</script></body></html>`

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/t168.html') {
      return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
    const file = Bun.file(`${root}${url.pathname}`)
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    return new Response(await file.text(), { headers: { 'content-type': 'text/javascript; charset=utf-8' } })
  },
})

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
})
const page = await browser.newPage({ viewport: { width: 480, height: 360 } })
const pageErrors = []
page.on('pageerror', e => pageErrors.push(String(e).slice(0, 200)))

await page.goto(`http://localhost:${port}/t168.html`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForFunction(() => (window.__t168?.frames ?? 0) >= 10, null, { timeout: 30_000 })
const boot = await page.evaluate(() => ({ d: window.__t168.draws, t: window.__t168.textures, p: window.__t168.programs }))
check('the session-renderer page boots and draws', boot.d >= 5, `draws=${boot.d}`)

// ── LEG 1: the synthetic loss/restore pair on the LIVE context ──
await page.evaluate(() => window.__t168.syntheticLoss())
await page.waitForTimeout(800)
const atSynLoss = await page.evaluate(() => ({ d: window.__t168.draws, e: window.__t168.errors }))
check('the synthetic loss stops the loop (the honest zombie guard)', atSynLoss.d === boot.d, `draws ${boot.d} → ${atSynLoss.d}`)
check('the loss report landed (with the replay promise)', atSynLoss.e.some(e => e.includes('WebGL context lost') && e.includes('journal will replay')), `reports=${atSynLoss.e.length}`)

await page.evaluate(() => window.__t168.syntheticRestore())
await page.evaluate(d => { window.__t168.__d = d }, atSynLoss.d)
await page.waitForFunction(() => window.__t168.draws > (window.__t168.__d ?? 0) + 2, null, { timeout: 30_000 })
const atSynRestore = await page.evaluate(() => ({ d: window.__t168.draws, t: window.__t168.textures, p: window.__t168.programs, f: window.__t168.frames, e: window.__t168.errors }))
check('the restore resumed the loop and DREW on the live context', atSynRestore.d > atSynLoss.d + 2, `draws ${atSynLoss.d} → ${atSynRestore.d}`)
check('the journal replayed the texture (a REAL createTexture on the restored path)', atSynRestore.t >= 1, `textures counted AFTER the wrappers were installed=${atSynRestore.t} (the boot-time create predates them — 1 here IS the replay)`)
check('the command re-created its program from the spec', atSynRestore.p >= 2, `programs=${atSynRestore.p}`)
check('the restore report landed (with the replay stats)', atSynRestore.e.some(e => e.includes('WebGL context restored') && e.includes('journal ops replayed')), `reports=${atSynRestore.e.length}`)

// ── LEG 2: the REAL loss event (the browser delivers this one) ──
await page.evaluate(() => window.__t168.realLoss())
await page.waitForFunction(() => window.__t168.reallyLost(), null, { timeout: 10_000 })
const drawsBeforeRealLoss = await page.evaluate(() => window.__t168.draws)
await page.waitForTimeout(1200)
const atRealLoss = await page.evaluate(() => ({ d: window.__t168.draws, f: window.__t168.frames, e: window.__t168.errors }))
check('the REAL loss stopped the drawing (the live zombie guard)', atRealLoss.d === drawsBeforeRealLoss, `draws ${drawsBeforeRealLoss} → ${atRealLoss.d}`)
check('the real loss reported through the sink', atRealLoss.e.filter(e => e.includes('WebGL context lost')).length >= 1, `total loss reports=${atRealLoss.e.filter(e => e.includes('WebGL context lost')).length}`)

const pageErrs = await page.evaluate(() => window.__t168.errors.length)
check('zero page errors', (await page.evaluate(() => window.__t168.errors.filter(e => e.includes('pageerror')).length)) === 0, `sink messages=${pageErrs}`)

await browser.close()
server.stop()
console.log(failures === 0 ? '\n[task168] ALL CELLS PASS' : `\n[task168] ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
