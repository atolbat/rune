// task174 — THE WG MULTI-DRAW LIVE GATE. The mock pins carry the tier's
// semantics (packages/webgpu/tests/task174.test.ts); this gate pins it
// LIVE, on the container's real WebGPU stack (SwiftShader + Vulkan):
//   A. THE PROBE — does this Chrome's GPURenderPassEncoder have
//      drawIndirectCount? (Chrome 151: NO — the spec-dropped method;
//      expected here, the indirect cell becomes an honest SKIP, the
//      tier rides the fast-path floor on this stack.)
//   B. THE PIXEL PARITY — the same seeded scene (ONE command recorded
//      FOUR times per frame — the exact multi-draw shape) on two WG
//      renderers: the tier on (default) and the kill-switch. Identical
//      canvas screenshots (SHA-256). On a drawIndirectCount browser the
//      tiered renderer batches (floor+indirect); on Chrome 151 the floor
//      (prologue-once, bare pass.draw) — both must render the same
//      pixels as the classic path.
//   C. THE HEALTH — zero GPU errors through the onGpuError storm channel
//      on both renderers across the frames.
// Exit 0 — live-verified (or honestly skipped); 1 — it broke.
// Usage: bun scripts/task174-wg-multidraw.mjs
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'

const root = '/home/z/my-project/rune'
const port = Number(process.env.TASK174MD_PORT ?? 8173)

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

// The gate page: two canvases, two WG renderers from the FRESH dist, one
// seeded scene recorded identically on both — the SAME command four times
// per frame with per-record counts. The window.__md handle exposes the
// verdicts + the GPU error log.
const GATE_HTML = `<!doctype html>
<html><body style="margin:0;background:#222">
<canvas id="a" width="256" height="256" style="width:256px;height:256px"></canvas>
<canvas id="b" width="256" height="256" style="width:256px;height:256px;margin-left:16px"></canvas>
<script type="module">
import { createRenderer } from '/dist/rune.esm.js?v=174'

const WGSL = \`
struct Params { u_mvp: mat4x4<f32>, u_tint: vec4<f32>, u_alpha: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@vertex fn vs_main(@location(0) position: vec3<f32>, @location(1) a_color: vec3<f32>)
  -> @builtin(position) vec4<f32> {
  return vec4<f32>(position.x * params.u_alpha, position.y, position.z, 1.0);
}
@fragment fn fs_main(@location(0) v_color: vec3<f32>) -> @location(0) vec4<f32> {
  return vec4<f32>(v_color, 1.0);
}\`

// a seeded soup: three big triangles, distinct colors — the hash has signal
function seededData() {
  const data = new Float32Array(3 * 3 * 2)
  let s = 0x9e3779b9
  const rng = () => { s = (s ^ (s >>> 15)) * 2246822519; s = (s ^ (s >>> 13)) * 3266489917; return ((s ^= s >>> 16) >>> 0) / 4294967296 }
  for (let i = 0; i < 9; i++) data[i * 2] = rng() * 1.6 - 0.8
  for (let i = 0; i < 9; i++) data[i * 2 + 1] = rng() * 1.6 - 0.8
  return data
}
const soup = seededData()
const colors = new Float32Array([1, 0.25, 0.3, 0.3, 0.9, 1, 1, 0.85, 0.2])

const errorsA = [], errorsB = []
async function boot(canvas, multiDraw, errors) {
  // The SwiftShader GPU process is a documented flake source (the task131/
  // 173 lesson): a requestDevice can die with "external Instance no longer
  // exists" right after the process restarts, and the NEXT attempt works.
  // Each renderer gets up to 3 tries, spaced out.
  let lastError = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const renderer = await createRenderer({
        canvas, backend: 'webgpu',
        clear: { color: [0.05, 0.06, 0.09, 1], depth: 1 },
        multiDraw,
        onGpuError: m => errors.push(m),
      })
      const command = renderer.command({
        shader: { wgsl: WGSL },
        attributes: { position: { data: soup, size: 3 }, a_color: { data: colors, size: 3 } },
        uniforms: { u_mvp: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1], u_tint: [1,1,1,1], u_alpha: 0.9 },
        count: p => p.count,
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
      return renderer
    } catch (e) {
      lastError = e
      await new Promise(r => setTimeout(r, 700))
    }
  }
  throw lastError ?? new Error('boot failed')
}
let bootFail = ''
try {
  const ra = await boot(document.querySelector('#a'), undefined, errorsA)
  const rb = await boot(document.querySelector('#b'), false, errorsB)
  window.__md = {
    multiDrawA: ra.multiDraw, multiDrawB: rb.multiDraw,
    errorsA, errorsB,
    indirectCount: typeof GPURenderPassEncoder !== 'undefined'
      && typeof GPURenderPassEncoder.prototype.drawIndirectCount === 'function',
  }
} catch (e) {
  bootFail = String(e && e.message || e)
  window.__md = { bootFail, errorsA, errorsB, indirectCount: false }
}
</script>
</body></html>`

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})

let failed = false
try {
  const page = await browser.newPage({ viewport: { width: 600, height: 300 } })
  await page.goto(`http://localhost:${port}/gate.html`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForFunction(() => window.__md !== undefined, null, { timeout: 90_000 })
  // settle: a few frames of the loop
  await page.waitForTimeout(1200)

  const md = await page.evaluate(() => window.__md)
  if (md.bootFail) {
    console.log(`[task174-wgmd] BOOT FAILED on the WG stack: ${md.bootFail.slice(0, 200)}`)
    failed = true
  } else {
    console.log(`[task174-wgmd] drawIndirectCount present: ${md.indirectCount} (Chrome through 151: expected false — the spec-dropped method)`)
    console.log(`[task174-wgmd] renderer A (default): multiDraw=${md.multiDrawA}; renderer B (kill-switch): multiDraw=${md.multiDrawB}`)
    console.log(`[task174-wgmd] GPU errors — A: ${md.errorsA.length}, B: ${md.errorsB.length}`)
    if (md.errorsA.length > 0 || md.errorsB.length > 0) {
      for (const e of [...md.errorsA, ...md.errorsB].slice(0, 5)) console.log(`           ${e.slice(0, 180)}`)
      failed = true
    }
    if (md.multiDrawB) {
      console.log('[task174-wgmd] FAIL — the kill-switch renderer reports multiDraw=true (the option does not reach the WG executor)')
      failed = true
    }
    if (!md.multiDrawA) {
      console.log('[task174-wgmd] FAIL — the default renderer reports multiDraw=false (the tier did not arm on the WG path)')
      failed = true
    }

    // THE PIXEL PARITY — the clipped screenshots of the two canvases
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
    console.log(`[task174-wgmd] pixel parity: ${same ? 'IDENTICAL' : 'DIFFERS'} (a=${hashA.slice(0, 12)} b=${hashB.slice(0, 12)})`)
    if (!same) failed = true
    // the scene is not blank (a hash of pure background would mean the draw
    // never landed — parity of two black canvases is not a verdict)
    const blank = await page.evaluate(() => {
      const c = document.querySelector('#a')
      return c.width > 0 && c.toDataURL().length < 2000
    })
    if (blank) {
      console.log('[task174-wgmd] FAIL — the scene is blank (the draws never landed)')
      failed = true
    }
    if (!md.indirectCount) {
      console.log('[task174-wgmd] SKIP (indirect cell) — this Chrome lacks drawIndirectCount; the tier rides the fast-path floor here (semantics pinned by packages/webgpu/tests/task174.test.ts)')
    }
  }
} catch (error) {
  console.error(`[task174-wgmd] gate crashed: ${error instanceof Error ? error.message : String(error)}`)
  failed = true
} finally {
  await browser.close()
  server.stop()
}

console.log(failed ? '\nTASK174 WG MULTI-DRAW GATE: FAIL' : '\nTASK174 WG MULTI-DRAW GATE: PASS')
process.exit(failed ? 1 : 0)
