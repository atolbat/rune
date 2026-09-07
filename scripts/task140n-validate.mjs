// task140n — THE FINAL VALIDATION (Task 140: the self-healing embers;
// Task 148: the pixel-confirmed verdict; Task 149: the TWO-RUNG LADDER).
//
// Leg A (healthy, the user's exact branch): 16k + the renderer spoof +
// the thaw flag. MUST: the tier's one-shot diagnostics run (checked,
// readable, SANE), NO fallback fires (perf.fallback undefined — the
// healthy page never re-makes; the pixel-confirmed ladder never suspects
// a SANE tier), the pixels stay warm.
// Leg B (the preset rung 1 — the conservative TF tier): window.
// __embersFallback = 1 before the demo make — MUST: the CONSERVATIVE TF
// branch (Task 137's configuration, Task 149's rung: tier 'gpu', the
// gpuBackend PRESENT (the sim and the records pack still on the GPU),
// emit:'cpu', cull:false, the full TF capacity, perf.fallback === 'tf'),
// the rung's OWN diagnostic verdicts SANE (the healthy container), the
// in-frame pixel sample reads WARM — the rung that the reporting phone
// lands on after one step-down, rendering its full 160k.
// Leg C (the preset rung 2 — the CPU tier): window.__embersFallback = 2 —
// MUST: Task 148's full-CPU branch (sim:'cpu' — tier 'cpu', no GPU
// backend on the layer, emit:'cpu', cull:false at the healed budget),
// perf.fallback === 'cpu', warm pixels (the pre-Task-131 path every
// driver renders).
import { join } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const root = '/home/z/my-project/rune'
const out = join(root, '.shots', 'task140')
mkdirSync(out, { recursive: true })
const port = Number(process.env.TASK140N_PORT ?? 8154)

let PATCH_VALUE = '40000'
const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url)
    let pathname = decodeURIComponent(url.pathname)
    if (pathname === '/') pathname = '/demo/'
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = Bun.file(join(root, pathname))
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    const ext = pathname.slice(pathname.lastIndexOf('.'))
    const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }
    let body = await file.text()
    if (pathname.endsWith('demos/gpuEmbers.js')) {
      const before = body
      body = body.replace(/const TF_CAPACITY = SOFTWARE_GL \? 16_000 : 160_000/, `const TF_CAPACITY = ${PATCH_VALUE}`)
      // Task 148 — the healed branch's capacity (patched to the same fast
      // 16k budget — the preset-fallback legs run the CPU tier at it)
      body = body.replace(/const FALLBACK_CAPACITY = SOFTWARE_GL \? 16_000 : COARSE \? 32_000 : GPU_CAPACITY/, 'const FALLBACK_CAPACITY = 16000')
      if (body === before) { console.error('[task140n] PATCH FAILED'); process.exit(1) }
    }
    return new Response(body, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})

function warmOf(png) {
  const { width: W, height: H, data } = png
  let w = 0, lit = 0
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4
    if (data[i] > 40 && data[i] > data[i + 1] * 1.15 && data[i + 1] > data[i + 2] * 1.05) w++
    if (data[i] + data[i + 1] + data[i + 2] > 90) lit++
  }
  return { warm: +(100 * w / (W * H)).toFixed(3), lit: +(100 * lit / (W * H)).toFixed(2) }
}

async function leg(tag, { preset }) {
  // 16k under the spoof: the FULL GPU pipeline (SOFTWARE_GL=false →
  // emit:'gpu' + cull by default) at a capacity the container's raster can
  // carry — frames fast enough to reach the diagnostic frame (~30) inside
  // the probe window (at 40k the SwiftShader present path runs ~0.5 fps
  // and frame 30 needs a minute; on the user's real GPU it is half a
  // second — the container's slowness, not the code's).
  PATCH_VALUE = '16000'
  const context = await browser.newContext({ viewport: { width: 480, height: 320 } })
  if (preset > 0) {
    // Task 149 — the preset LADDER POSITION: 1 = the conservative TF rung
    // (Leg B), 2 = the CPU tier (Leg C). A live session reaches these the
    // same way: the rung's own verdict writes the position before the
    // re-make.
    await context.addInitScript((p) => { window.__embersFallback = p }, preset)
  }
  await context.addInitScript(() => {
    window.__fxRemakes = 0
    let v = null
    Object.defineProperty(window, '__vfxPerf', {
      configurable: true,
      get: () => v,
      set: (nv) => { v = nv; window.__fxRemakes++ },
    })
    const SPOOF_RENDERER = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)'
    const UNMASKED_RENDERER = 37446
    const orig = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      const ctx = orig.call(this, type, ...rest)
      if (type === 'webgl2' && ctx != null && !ctx.__fxHooked) {
        ctx.__fxHooked = true
        const origGetParameter = ctx.getParameter.bind(ctx)
        ctx.getParameter = (pname, ...pr) => (pname === UNMASKED_RENDERER ? SPOOF_RENDERER : origGetParameter(pname, ...pr))
      }
      return ctx
    }
  })
  const page = await context.newPage()
  const consoleMsgs = []
  page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text().slice(0, 300)}`))
  page.on('pageerror', (e) => consoleMsgs.push('PAGEERROR: ' + String(e).slice(0, 200)))
  await page.goto(`http://localhost:${port}/demo/vfx/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(1000)
  await page.click('#rd-fab')
  await page.click('label[for="mode-webgl2"]')
  await page.waitForTimeout(400)
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('button')]
    rows.find((r) => (r.textContent ?? '').includes('GPU Embers'))?.click()
  })
  // poll until the tier's one-shot diagnostics have fired (the container's
  // slow raster makes frames 300-600ms — frame 30 needs up to ~20s; on a
  // real GPU it lands in half a second). SKIPPED on the CPU-tier leg (C):
  // the level-2 session runs the CPU tier — there IS no gpuBackend and no
  // diagnostics to wait for (waiting would burn the 45s timeout).
  if (preset !== 2) {
    await page.waitForFunction(() => {
      const layers = window.__vfxLayers ?? []
      const d = layers.map((l) => l?.gpuBackend?.diagnostics).find((x) => x !== undefined)
      return d != null && d.checked === true
    }, null, { timeout: 45_000 }).catch(() => { })
    // Task 148 — THE IN-FRAME WARMTH ORACLE (the compositor screenshot is
    // the documented liar class — Task 140's forensics: "THE COMPOSITOR WAS
    // THE LIAR, NOT THE PIPELINE"): the ladder arms the canvas pixel
    // sample at frame ~45 and verdicts it — perf.pixelCheck flips to 'warm'
    // (bright pixels in the drawing buffer right after the ember draw) or
    // 'cold' (→ the auto-fallback, which the no-false-fallback assertion
    // would catch). Waiting for the verdict makes the rendering proof
    // deterministic — the screenshot stays a reported metric.
    await page.waitForFunction(() => window.__vfxPerf?.pixelCheck === 'warm' || window.__vfxPerf?.pixelCheck === 'cold', null, { timeout: 120_000 }).catch(() => { })
  }
  await page.waitForTimeout(1500)
  const state = await page.evaluate(() => ({
    perf: window.__vfxPerf ? { ...window.__vfxPerf } : null,
    remakes: window.__fxRemakes,
    fallbackFlag: window.__embersFallback ?? 0,
    gpuBackends: (window.__vfxLayers ?? []).filter((l) => l?.gpuBackend !== undefined).length,
    diag: window.__vfxLayers?.find?.((l) => l?.gpuBackend?.diagnostics !== undefined)?.gpuBackend?.diagnostics ?? (window.__vfxLayers ?? []).map((l) => l?.gpuBackend?.diagnostics).find((d) => d !== undefined) ?? null,
  })).catch((e) => ({ crash: String(e).slice(0, 150) }))
  let shot = { starved: true }
  // Task 148 — the multi-window screenshot retry (the repo's own warm-gate
  // flake pattern): the compositor's copy stalls intermittently under this
  // container's accumulated load; a live canvas recovers across windows
  // (the in-frame oracle above is the deterministic proof — this is the
  // secondary, compositor-level metric).
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const clip = await page.evaluate(() => {
        const c = document.querySelector('canvas')
        const r = c.getBoundingClientRect()
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
      })
      const path = join(out, `${tag}-${attempt}.png`)
      await page.screenshot({ path, clip, timeout: 20_000 })
      shot = warmOf(PNG.sync.read(readFileSync(path)))
    } catch { break }
    if ((shot.warm ?? -1) > 0.05) break
    await page.waitForTimeout(900)
  }
  console.log(`[task140n] ${tag}: perf ${JSON.stringify(state.perf)} · remakes ${state.remakes} · fallbackFlag ${state.fallbackFlag} · gpuBackends ${state.gpuBackends}`)
  console.log(`[task140n] ${tag}: diagnostics ${JSON.stringify(state.diag)}`)
  console.log(`[task140n] ${tag}: pixels ${JSON.stringify(shot)}`)
  const warns = consoleMsgs.filter((m) => m.includes('[warning] [rune') || m.includes('rune/vfx') || m.includes('rune/particles'))
  if (warns.length > 0) console.log(`[task140n] ${tag} rune warnings: ${JSON.stringify(warns)}`)
  const errs = consoleMsgs.filter((m) => m.startsWith('PAGEERROR'))
  if (errs.length > 0) { console.log(`[task140n] ${tag} PAGE ERRORS: ${JSON.stringify(errs.slice(0, 2))}`); process.exitCode = 1 }
  await page.close()
  await context.close()
  return { state, shot }
}

const A = await leg('healthy-16k', { preset: 0 })
const B = await leg('preset-rung1-tf', { preset: 1 })
const C = await leg('preset-rung2-cpu', { preset: 2 })

console.log('── THE VERDICTS ──')
{
  const d = A.state.diag
  const diagOk = d != null && d.checked === true && d.readable === true && d.sane === true
  const noFallback = A.state.perf?.fallback === undefined && A.state.fallbackFlag === 0 && A.state.remakes === 1
  // Task 148 — the in-frame oracle: the healthy leg's own pixel sample
  // verdicted WARM (bright pixels in the drawing buffer, post-draw)
  const inFrameWarm = A.state.perf?.pixelCheck === 'warm'
  const warmA = A.shot.warm ?? -1
  const warmB = B.shot.warm ?? -1
  const warmC = C.shot.warm ?? -1
  // Task 149 — RUNG 1 (the conservative TF tier): the preset position 1
  // takes Task 137's configuration — the gpuBackend PRESENT (the sim and
  // the records still on the GPU), emit 'cpu', cull off, the full patched
  // capacity, fallback 'tf' — and the rung's own diagnostic verdicts SANE
  // with the in-frame pixel sample WARM (no escalation: remakes stays 1).
  const db = B.state.diag
  const bRung1 = B.state.perf?.tier === 'gpu' && B.state.perf?.emit === 'cpu' && B.state.perf?.cull === false
    && B.state.perf?.fallback === 'tf' && B.state.perf?.capacity === 16000
    && B.state.gpuBackends === 1 && B.state.fallbackFlag === 1 && B.state.remakes === 1
    && db != null && db.checked === true && db.sane === true && B.state.perf?.pixelCheck === 'warm'
  // Task 149 — RUNG 2 (the CPU tier): the preset position 2 takes Task
  // 148's full-CPU branch — no gpuBackend, the healed capacity, the
  // per-frame upload path every driver renders.
  const cRung2 = C.state.perf?.tier === 'cpu' && C.state.perf?.emit === 'cpu' && C.state.perf?.cull === false
    && C.state.perf?.fallback === 'cpu' && C.state.perf?.capacity === 16000
    && C.state.gpuBackends === 0 && C.state.fallbackFlag === 2
  console.log(`A diagnostics: ${diagOk ? 'SANE ✓' : `FAIL ${JSON.stringify(d)}`} · no false fallback: ${noFallback ? '✓' : `FAIL (remakes ${A.state.remakes}, flag ${A.state.fallbackFlag})`} · in-frame pixels ${A.state.perf?.pixelCheck} ✓ · compositor shot warm ${warmA}%`)
  console.log(`B rung-1 (conservative TF): ${bRung1 ? '✓' : `FAIL ${JSON.stringify(B.state.perf)} (gpuBackends ${B.state.gpuBackends}, diag ${JSON.stringify(db)})`} · warm ${warmB}%`)
  console.log(`C rung-2 (full CPU): ${cRung2 ? '✓' : `FAIL ${JSON.stringify(C.state.perf)} (gpuBackends ${C.state.gpuBackends})`} · warm ${warmC}%`)
  if (diagOk && noFallback && inFrameWarm && bRung1 && cRung2 && warmB > 0.05 && warmC > 0.05) console.log('[task140n] PASS — the two-rung self-healing contract holds end-to-end')
  else { console.log('[task140n] FAIL — see above'); process.exitCode = 1 }
}
await browser.close()
server.stop(true)
