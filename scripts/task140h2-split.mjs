// task140h2 — THE FINAL SPLIT, fixed: size vs spoof (Task 140).
//
// task140h's run was invalid: the patch only replaced the FALSE branch of
// the TF_CAPACITY ternary, so the no-spoof leg C silently ran 16k (the
// true branch); and both shots starved. THIS rewrite: the server holds a
// MUTABLE patch value (the WHOLE ternary replaced by a constant), set per
// leg; the shots go EARLY (t≈3s, pre-freeze) with retries.
//
//   leg C — cap 40000, NO spoof, ?emit=1&cull=1 → cold? = THE SIZE
//   leg D — cap 16000, spoof, no flags         → cold? = THE SOFTWARE_GL BRANCH
import { join } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const root = '/home/z/my-project/rune'
const out = join(root, '.shots', 'task140')
mkdirSync(out, { recursive: true })
const port = 8148

let PATCH_VALUE = '40000' // the whole ternary → this constant

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
      if (body === before) { console.error('[task140h2] PATCH FAILED'); process.exit(1) }
    }
    return new Response(body, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan'],
})

function warmOf(png) {
  const { width: W, height: H, data } = png
  let w = 0, lit = 0
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4
    if (data[i] > 40 && data[i] > data[i + 1] * 1.15 && data[i + 1] > data[i + 2] * 1.05) w++
    if (data[i] + data[i + 1] + data[i + 2] > 90) lit++
  }
  return { warm: +(100 * w / (W * H)).toFixed(3), lit: +(100 * lit / (W * H)).toFixed(3) }
}

async function shotWithRetry(page, tag, tries = 3) {
  for (let k = 0; k < tries; k++) {
    const clip = await page.evaluate(() => {
      const c = document.querySelector('canvas')
      if (!c) return null
      const r = c.getBoundingClientRect()
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
    }).catch(() => null)
    if (clip == null) continue
    try {
      const path = join(out, `${tag}-${k}.png`)
      await page.screenshot({ path, clip, timeout: 12_000 })
      return warmOf(PNG.sync.read(readFileSync(path)))
    } catch { /* retry */ }
  }
  return { starved: true }
}

async function leg(tag, { cap, spoof, query }) {
  PATCH_VALUE = String(cap)
  const context = await browser.newContext({ viewport: { width: 480, height: 320 } })
  if (spoof) {
    await context.addInitScript(() => {
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
  }
  const page = await context.newPage()
  await page.goto(`http://localhost:${port}/demo/vfx/${query}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(1000)
  await page.click('#rd-fab')
  await page.click('label[for="mode-webgl2"]')
  await page.waitForTimeout(400)
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('button')]
    rows.find((r) => (r.textContent ?? '').includes('GPU Embers'))?.click()
  })
  await page.waitForTimeout(2600) // EARLY — pre-freeze
  const shot = await shotWithRetry(page, tag)
  const state = await page.evaluate(() => ({
    perf: window.__vfxPerf ? { count: window.__vfxPerf.count, cap: window.__vfxPerf.capacity, emit: window.__vfxPerf.emit, cull: window.__vfxPerf.cull, softwareGL: window.__vfxPerf.softwareGL } : null,
    tick: window.__vfxFrame ?? -1,
  })).catch((e) => ({ crash: String(e).slice(0, 120) }))
  console.log(`[task140h2] ${tag}: ${JSON.stringify(state)} · pixels ${JSON.stringify(shot)}`)
  await page.close()
  await context.close()
  return { tag, warm: shot.warm ?? -1, state }
}

const C = await leg('C-40k-flags', { cap: 40000, spoof: false, query: '?emit=1&cull=1' })
const D = await leg('D-16k-spoof', { cap: 16000, spoof: true, query: '' })

console.log('── THE VERDICTS ──')
console.log(`C (40k, no spoof, flags): warm ${C.warm}% · cap ${C.state?.perf?.cap} · softwareGL ${C.state?.perf?.softwareGL}`)
console.log(`D (16k, spoof, default): warm ${D.warm}% · cap ${D.state?.perf?.cap} · softwareGL ${D.state?.perf?.softwareGL}`)
if (C.warm <= 0.02 && D.warm > 0.05) console.log('[task140h2] !!! THE CAPACITY — 40k breaks, 16k works (bisect the size threshold)')
else if (C.warm > 0.05 && D.warm <= 0.02) console.log('[task140h2] !!! THE SOFTWARE_GL=false DEFAULT BRANCH breaks even at 16k (not the spoof string — the pipeline booleans route differs?!)')
else if (C.warm <= 0.02 && D.warm <= 0.02) console.log('[task140h2] !!! BOTH cold — re-examine (the earlier 16k+flags WARM leg vs this — the flaky raster?)')
else console.log('[task140h2] both warm — the cold of task140f was the flaky/starved class?')
await browser.close()
server.stop(true)
