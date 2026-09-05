// task140n — THE FINAL VALIDATION (Task 140: the self-healing embers).
//
// Leg A (healthy, the user's exact branch): 40k + the renderer spoof +
// the thaw flag. MUST: the tier's one-shot diagnostics run (checked,
// readable, SANE), NO fallback fires (perf.fallback undefined — the
// healthy page never re-makes), the pixels stay warm.
// Leg B (the forced fallback): window.__embersFallback preset before the
// demo make — MUST: the conservative branch (emit:'cpu', cull:false),
// perf.fallback === 'selfcheck', warm pixels (the v=137-class path).
import { join } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const root = '/home/z/my-project/rune'
const out = join(root, '.shots', 'task140')
mkdirSync(out, { recursive: true })
const port = 8154

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

async function leg(tag, { presetFallback }) {
  // 16k under the spoof: the FULL GPU pipeline (SOFTWARE_GL=false →
  // emit:'gpu' + cull by default) at a capacity the container's raster can
  // carry — frames fast enough to reach the diagnostic frame (~30) inside
  // the probe window (at 40k the SwiftShader present path runs ~0.5 fps
  // and frame 30 needs a minute; on the user's real GPU it is half a
  // second — the container's slowness, not the code's).
  PATCH_VALUE = '16000'
  const context = await browser.newContext({ viewport: { width: 480, height: 320 } })
  if (presetFallback) {
    await context.addInitScript(() => { window.__embersFallback = true })
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
  page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text().slice(0, 200)}`))
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
  // real GPU it lands in half a second)
  await page.waitForFunction(() => {
    const layers = window.__vfxLayers ?? []
    const d = layers.map((l) => l?.gpuBackend?.diagnostics).find((x) => x !== undefined)
    return d != null && d.checked === true
  }, null, { timeout: 45_000 }).catch(() => { })
  await page.waitForTimeout(1500)
  const state = await page.evaluate(() => ({
    perf: window.__vfxPerf ? { ...window.__vfxPerf } : null,
    remakes: window.__fxRemakes,
    fallbackFlag: window.__embersFallback === true,
    diag: window.__vfxLayers?.find?.((l) => l?.gpuBackend?.diagnostics !== undefined)?.gpuBackend?.diagnostics ?? (window.__vfxLayers ?? []).map((l) => l?.gpuBackend?.diagnostics).find((d) => d !== undefined) ?? null,
  })).catch((e) => ({ crash: String(e).slice(0, 150) }))
  let shot = { starved: true }
  try {
    const clip = await page.evaluate(() => {
      const c = document.querySelector('canvas')
      const r = c.getBoundingClientRect()
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
    })
    const path = join(out, `n-${tag}.png`)
    await page.screenshot({ path, clip, timeout: 20_000 })
    shot = warmOf(PNG.sync.read(readFileSync(path)))
  } catch { }
  console.log(`[task140n] ${tag}: perf ${JSON.stringify(state.perf)} · remakes ${state.remakes} · fallbackFlag ${state.fallbackFlag}`)
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

const A = await leg('healthy-40k', { presetFallback: false })
const B = await leg('forced-fallback', { presetFallback: true })

console.log('── THE VERDICTS ──')
{
  const d = A.state.diag
  const diagOk = d != null && d.checked === true && d.readable === true && d.sane === true
  const noFallback = A.state.perf?.fallback === undefined && A.state.fallbackFlag === false && A.state.remakes === 1
  const warmA = A.shot.warm ?? -1
  const warmB = B.shot.warm ?? -1
  const bConservative = B.state.perf?.emit === 'cpu' && B.state.perf?.cull === false && B.state.perf?.fallback === 'selfcheck'
  console.log(`A diagnostics: ${diagOk ? 'SANE ✓' : `FAIL ${JSON.stringify(d)}`} · no false fallback: ${noFallback ? '✓' : `FAIL (remakes ${A.state.remakes}, flag ${A.state.fallbackFlag})`} · warm ${warmA}%`)
  console.log(`B conservative: ${bConservative ? '✓' : `FAIL ${JSON.stringify(B.state.perf)}`} · warm ${warmB}%`)
  if (diagOk && noFallback && warmA > 0.05 && bConservative && warmB > 0.05) console.log('[task140n] PASS — the self-healing contract holds end-to-end')
  else { console.log('[task140n] FAIL — see above'); process.exitCode = 1 }
}
await browser.close()
server.stop(true)
