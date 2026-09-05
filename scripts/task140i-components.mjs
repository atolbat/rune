// task140i — THE COMPONENT DICHOTOMY at 40k (Task 140).
//
// task140h2: 16k+spoof+default = WARM; 40k = COLD (a capacity-dependent
// break). The pipeline has exactly two new components vs the conservative
// path: the GPU EMISSION (emit pass + its PBO slice) and the CULL FAMILY
// (sortKeys + pairs PBO + packSorted). This probe isolates each at the
// breaking capacity (40k, spoof, working screenshots):
//   P0 ?emit=0&cull=0 — the conservative control at 40k
//   PE ?emit=1        — the GPU emission alone
//   PC ?cull=1        — the cull family alone
//   PD (default)      — both (known COLD — re-confirmed)
import { join } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const root = '/home/z/my-project/rune'
const out = join(root, '.shots', 'task140')
mkdirSync(out, { recursive: true })
const port = 8149

const CAP = process.env.CAP ?? '40000'
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
      body = body.replace(/const TF_CAPACITY = SOFTWARE_GL \? 16_000 : 160_000/, `const TF_CAPACITY = ${CAP}`)
      if (body === before) { console.error('[task140i] PATCH FAILED'); process.exit(1) }
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

async function leg(tag, query) {
  const context = await browser.newContext({ viewport: { width: 480, height: 320 } })
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
  await page.waitForTimeout(2600)
  const shot = await shotWithRetry(page, tag)
  const state = await page.evaluate(() => ({
    perf: window.__vfxPerf ? { count: window.__vfxPerf.count, cap: window.__vfxPerf.capacity, emit: window.__vfxPerf.emit, cull: window.__vfxPerf.cull, softwareGL: window.__vfxPerf.softwareGL } : null,
    tick: window.__vfxFrame ?? -1,
  })).catch((e) => ({ crash: String(e).slice(0, 120) }))
  console.log(`[task140i] ${tag}: ${JSON.stringify(state)} · pixels ${JSON.stringify(shot)}`)
  await page.close()
  await context.close()
  return { tag, warm: shot.warm ?? -1, lit: shot.lit ?? -1 }
}

const P0 = await leg('P0-conservative', '?emit=0&cull=0')
const PE = await leg('PE-emit-only', '?emit=1')
const PC = await leg('PC-cull-only', '?cull=1')
const PD = await leg('PD-default', '')

console.log('── THE VERDICTS ──')
console.log(`P0 conservative: warm ${P0.warm}% · PE emit-only: warm ${PE.warm}% · PC cull-only: warm ${PC.warm}% · PD default: warm ${PD.warm}%`)
const verdict = (v) => v <= 0.02 ? 'COLD' : (v >= 0.1 ? 'WARM' : 'faint')
console.log(`P0 ${verdict(P0.warm)} · PE ${verdict(PE.warm)} · PC ${verdict(PC.warm)} · PD ${verdict(PD.warm)}`)
await browser.close()
server.stop(true)
