// task140j — THE IN-FRAME READPIXELS ORACLE (Task 140 — the deterministic
// pixel verdict, compositor-free).
//
// The screenshot path kept starving (the SwiftShader compositor saturation
// at 40k+ kills even page.screenshot). THE FIX: read the framebuffer
// INSIDE the frame — the drawArrays/drawArraysInstanced hook reads a
// center region right AFTER each draw (before the swap — the content is
// guaranteed present), stashing {t, kind, inst, warm, lit} per draw.
// The LAST draws of a frame tell the layer contributions exactly:
//   the ember draw (instanced, inst ~30k) — warm?
//   the floor (plain drawArrays) — lit?
//   the pool (instanced, inst 1)
//
//   legs (40k, spoof): P0 ?emit=0&cull=0 (conservative) vs PD (default)
//   control (16k, spoof, default) — the hook must read WARM there.
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const root = '/home/z/my-project/rune'
mkdirSync(join(root, '.shots', 'task140'), { recursive: true })
const port = 8150

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
      if (body === before) { console.error('[task140j] PATCH FAILED'); process.exit(1) }
    }
    return new Response(body, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan'],
})

async function leg(tag, { cap, query }) {
  PATCH_VALUE = String(cap)
  const context = await browser.newContext({ viewport: { width: 480, height: 320 } })
  await context.addInitScript(() => {
    window.__fxErrors = []
    window.__fxReads = [] // the last 12 post-draw readback snapshots
    const SPOOF_RENDERER = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)'
    const UNMASKED_RENDERER = 37446
    const orig = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      const ctx = orig.call(this, type, ...rest)
      if (type === 'webgl2' && ctx != null && !ctx.__fxHooked) {
        ctx.__fxHooked = true
        const origGetParameter = ctx.getParameter.bind(ctx)
        ctx.getParameter = (pname, ...pr) => (pname === UNMASKED_RENDERER ? SPOOF_RENDERER : origGetParameter(pname, ...pr))
        // THE IN-FRAME ORACLE: read the center 240×160 region right after
        // each draw call. Read BEFORE the frame's swap — the content is
        // guaranteed present; readPixels is synchronous.
        const RW = 240, RH = 160, RX = 120, RY = 80 // canvas 480×320 → center
        const px = new Uint8Array(RW * RH * 4)
        const readAfter = (kind, meta) => {
          try {
            ctx.readPixels(RX, RY, RW, RH, ctx.RGBA, ctx.UNSIGNED_BYTE, px)
            let warm = 0, lit = 0
            for (let i = 0; i < px.length; i += 4) {
              const r = px[i], g = px[i + 1], b = px[i + 2]
              if (r > 40 && r > g * 1.15 && g > b * 1.05) warm++
              if (r + g + b > 90) lit++
            }
            window.__fxReads.push({ kind, meta, warm: +(100 * warm / (RW * RH)).toFixed(2), lit: +(100 * lit / (RW * RH)).toFixed(2) })
            if (window.__fxReads.length > 12) window.__fxReads.shift()
          } catch (e) { window.__fxErrors.push({ read: String(e).slice(0, 80) }) }
        }
        const hook = (name) => {
          const fn = ctx[name].bind(ctx)
          ctx[name] = (...args) => {
            const r = fn(...args)
            if (name === 'drawArraysInstanced') readAfter('inst', args[3])
            else if (name === 'drawArrays' && args[0] === ctx.TRIANGLES) readAfter('tri', args[2])
            const err = ctx.getError() // drains (the read's own error too)
            return r
          }
        }
        for (const name of ['drawArraysInstanced', 'drawArrays']) hook(name)
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
  await page.waitForTimeout(3500)
  const state = await page.evaluate(() => ({
    perf: window.__vfxPerf ? { count: window.__vfxPerf.count, cap: window.__vfxPerf.capacity, emit: window.__vfxPerf.emit, cull: window.__vfxPerf.cull, softwareGL: window.__vfxPerf.softwareGL } : null,
    reads: window.__fxReads.slice(-8),
    errors: window.__fxErrors.slice(-3),
  })).catch((e) => ({ crash: String(e).slice(0, 150) }))
  console.log(`[task140j] ${tag}: perf ${JSON.stringify(state.perf)} · errors ${JSON.stringify(state.errors)}`)
  console.log(`[task140j] ${tag} reads: ${JSON.stringify(state.reads)}`)
  await page.close()
  await context.close()
  return { tag, reads: state.reads ?? [], perf: state.perf }
}

// ── the legs ────────────────────────────────────────────────────────────
const K16 = await leg('K16-control', { cap: 16000, query: '' }) // the hook's sanity: 16k default must read WARM
const P0 = await leg('P0-40k-conservative', { cap: 40000, query: '?emit=0&cull=0' })
const PD = await leg('PD-40k-default', { cap: 40000, query: '' })

console.log('── THE VERDICTS ──')
const warmMax = (r) => Math.max(0, ...r.map((x) => x.warm ?? 0))
console.log(`K16 (16k default):        maxWarm ${warmMax(K16.reads)}% (the hook sanity — must be warm)`)
console.log(`P0 (40k conservative):    maxWarm ${warmMax(P0.reads)}%`)
console.log(`PD (40k default):         maxWarm ${warmMax(PD.reads)}%`)
await browser.close()
server.stop(true)
