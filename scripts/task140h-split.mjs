// task140h — THE FINAL SPLIT: size vs spoof (Task 140).
//
// task140g: 16k + ?emit=1&cull=1 (no spoof) = WARM 0.52%. task140f: 40k
// (patched) + spoof + default = COLD. The booleans are identical in both
// (emitGpu=true, cullOn=true) — the remaining deltas: THE CAPACITY (16k vs
// 40k) and THE SPOOF (SOFTWARE_GL true vs false).
//
//   leg C — 40k (patched), NO spoof, ?emit=1&cull=1 → cold? = THE SIZE
//   leg D — 16k (patched to 16k in both branches), spoof, no flags → cold? = THE SOFTWARE_GL BRANCH
import { join } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const root = '/home/z/my-project/rune'
const out = join(root, '.shots', 'task140')
mkdirSync(out, { recursive: true })
const port = 8147

const PATCH_CAP = process.env.PATCH_CAP ?? '40_000'

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
      body = body.replace('const TF_CAPACITY = SOFTWARE_GL ? 16_000 : 160_000', `const TF_CAPACITY = SOFTWARE_GL ? 16_000 : ${PATCH_CAP}`)
      if (body === before) { console.error('[task140h] PATCH FAILED'); process.exit(1) }
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

async function leg(tag, { spoof, query, seconds = 4 }) {
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
  const consoleMsgs = []
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleMsgs.push(m.text().slice(0, 180)) })
  page.on('pageerror', (e) => consoleMsgs.push('PAGEERROR: ' + String(e).slice(0, 180)))
  await page.goto(`http://localhost:${port}/demo/vfx/${query}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(1000)
  await page.click('#rd-fab')
  await page.click('label[for="mode-webgl2"]')
  await page.waitForTimeout(400)
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('button')]
    rows.find((r) => (r.textContent ?? '').includes('GPU Embers'))?.click()
  })
  await page.waitForTimeout(seconds * 1000)
  const state = await page.evaluate(() => ({
    perf: window.__vfxPerf ? { ...window.__vfxPerf } : null,
  })).catch((e) => ({ crash: String(e).slice(0, 120) }))
  let shot = { error: 'no clip' }
  const clip = await page.evaluate(() => {
    const c = document.querySelector('canvas')
    if (!c) return null
    const r = c.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
  }).catch(() => null)
  if (clip != null) {
    try {
      const path = join(out, `${tag}.png`)
      await page.screenshot({ path, clip, timeout: 15_000 })
      shot = warmOf(PNG.sync.read(readFileSync(path)))
    } catch { shot = { starved: true } }
  }
  console.log(`[task140h] ${tag}: state ${JSON.stringify(state)} · pixels ${JSON.stringify(shot)}`)
  if (consoleMsgs.length > 0) console.log(`[task140h] ${tag} console: ${JSON.stringify(consoleMsgs.slice(0, 3))}`)
  await page.close()
  await context.close()
  return { tag, warm: shot.warm ?? -1, state }
}

// leg C — 40k, NO spoof, flags forced
const C = await leg('C-40k-flags', { spoof: false, query: '?emit=1&cull=1' })
// leg D — 16k (patched to 16_000), spoof, default (the SOFTWARE_GL=false branch)
const D = await leg('D-16k-spoof', { spoof: true, query: '' })

console.log('── THE VERDICTS ──')
console.log(`C (40k, no spoof, ?emit=1&cull=1): warm ${C.warm}%`)
console.log(`D (16k, spoof, default):           warm ${D.warm}% · softwareGL ${D.state?.perf?.softwareGL} · cap ${D.state?.perf?.capacity}`)
if (C.warm <= 0.02 && D.warm > 0.05) console.log('[task140h] !!! THE CAPACITY — 40k breaks, 16k works (a size-dependent root; bisect the threshold)')
else if (C.warm > 0.05 && D.warm <= 0.02) console.log('[task140h] !!! THE SOFTWARE_GL=false BRANCH (the spoof) breaks even at 16k — TF_GPU_PIPELINE default path vs flags?')
else if (C.warm <= 0.02 && D.warm <= 0.02) console.log('[task140h] !!! BOTH cold — the discriminator is elsewhere (flags query vs default?!)')
else console.log('[task140h] both warm — cannot reproduce right now (flaky?!)')
await browser.close()
server.stop(true)
