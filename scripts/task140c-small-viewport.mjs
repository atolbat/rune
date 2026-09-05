// task140c-small-viewport — THE DECISIVE RASTER EXPERIMENT (Task 140).
//
// task140's leg A (the user's exact config: 160k + emit:'gpu' + cull) proved
// the DATA path sane in-container (records halfMax ~0.04, colors in range,
// the cull sentinels zeroing ~57% rows as designed) — but the PIXEL verdict
// starved: at 1280×800 SwiftShader cannot rasterize 160k additive sprites,
// so the screenshot 30s-timed-out and the draw itself was never verified.
//
// THIS PROBE: the SAME spoof (the user's exact page config) at a SMALL
// VIEWPORT (320×200) — the fill budget SwiftShader CAN carry — plus the one
// call every prior probe missed: drawArraysInstanced (the ember draw's
// VERTEX/INSTANCE counts — is the draw even issued with count > 0?). The
// warm-pixel gate on the canvas clip then answers end-to-end: does the full
// GPU pipeline produce VISIBLE embers when the raster can keep up?
//
//   leg S — the spoof (160k, gpu emit, cull) at 320×200  → warm?
//   leg K — the control: no spoof (the container default 16k cpu path)
import { join } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const root = '/home/z/my-project/rune'
const out = join(root, '.shots', 'task140')
mkdirSync(out, { recursive: true })
const port = 8142

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
    return new Response(file, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan'],
})

const consoleMsgs = []
let page = null

async function leg(tag, { spoof, w, h, seconds }) {
  const context = await browser.newContext({ viewport: { width: w, height: h } })
  if (spoof) {
    await context.addInitScript(() => {
      window.__fxErrors = []
      window.__fxFrames = 0
      window.__fxInstDraws = [] // the LAST 40 drawArraysInstanced (first, count, inst)
      window.__fxTfBinds = []
      const RING = 40
      const SPOOF_RENDERER = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)'
      const UNMASKED_RENDERER = 37446
      const orig = HTMLCanvasElement.prototype.getContext
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        const ctx = orig.call(this, type, ...rest)
        if (type === 'webgl2' && ctx != null && !ctx.__fxHooked) {
          ctx.__fxHooked = true
          const origGetParameter = ctx.getParameter.bind(ctx)
          ctx.getParameter = (pname, ...pr) => (pname === UNMASKED_RENDERER ? SPOOF_RENDERER : origGetParameter(pname, ...pr))
          const TF_TARGET = ctx.TRANSFORM_FEEDBACK_BUFFER
          const hook = (name) => {
            const fn = ctx[name].bind(ctx)
            ctx[name] = (...args) => {
              const r = fn(...args)
              if (name === 'drawArraysInstanced') {
                window.__fxInstDraws.push({ f: args[1], n: args[2], inst: args[4] ?? args[3] })
                if (window.__fxInstDraws.length > RING) window.__fxInstDraws.shift()
              } else if (name === 'bindBufferBase' && args[0] === TF_TARGET && args[2] !== null) {
                window.__fxTfBinds.push(args[2])
                if (window.__fxTfBinds.length > RING) window.__fxTfBinds.shift()
              }
              if (name === 'endTransformFeedback') window.__fxFrames++
              const err = ctx.getError()
              if (err !== 0) window.__fxErrors.push({ name, err })
              return r
            }
          }
          for (const name of ['drawArraysInstanced', 'bindBufferBase', 'endTransformFeedback']) hook(name)
        }
        return ctx
      }
    })
  }
  page = await context.newPage()
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleMsgs.push(m.text().slice(0, 200)) })
  page.on('pageerror', (e) => consoleMsgs.push('PAGEERROR: ' + String(e).slice(0, 200)))

  await page.goto(`http://localhost:${port}/demo/vfx/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(1200)
  await page.click('#rd-fab')
  await page.click('label[for="mode-webgl2"]')
  await page.mouse.click(w / 2, 40)
  await page.evaluate(() => document.querySelector('.pt-sheet [aria-label=Close]')?.click())
  await page.waitForFunction(() => (document.querySelector('#backend')?.textContent ?? '').includes('WebGL2'), null, { timeout: 30_000 })
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('button')]
    rows.find((r) => (r.textContent ?? '').includes('GPU Embers'))?.click()
  })
  await page.waitForFunction(() => (window.__vfxPerf?.tier ?? '') !== '', null, { timeout: 30_000 })

  // the settle window (the identity-settle class: let the burst + growth run)
  const f0 = await page.evaluate(() => window.__vfxFrame ?? -1)
  await page.waitForTimeout(seconds * 1000)
  const f1 = await page.evaluate(() => window.__vfxFrame ?? -1)

  const fx = await page.evaluate(() => ({
    perf: window.__vfxPerf ? { ...window.__vfxPerf } : null,
    frames: window.__fxFrames,
    instDraws: window.__fxInstDraws.slice(-10),
    tfBinds: window.__fxTfBinds.length,
    errors: window.__fxErrors.slice(-8),
  }))

  // THE PIXEL VERDICT — the canvas clip, a fresh frame between shots
  const clip = await page.evaluate(() => {
    const c = document.querySelector('canvas')
    if (!c) return null
    const r = c.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
  })
  const shots = []
  let warmTotal = 0
  if (clip != null) {
    for (let k = 0; k < 2; k++) {
      const path = join(out, `${tag}-${k}.png`)
      let png = null
      try {
        await page.screenshot({ path, clip, timeout: 45_000 })
        png = PNG.sync.read(readFileSync(path))
      } catch {
        shots.push({ starved: true })
        continue
      }
      const { width: W, height: H, data } = png
      let warm = 0, lit = 0
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4
          const r = data[i], g = data[i + 1], b = data[i + 2]
          if (r > 40 && r > g * 1.15 && g > b * 1.05) warm++
          if (r + g + b > 90) lit++
        }
      }
      warmTotal += warm
      shots.push({ warm: +(100 * warm / (W * H)).toFixed(2), lit: +(100 * lit / (W * H)).toFixed(2) })
    }
  }

  console.log(`[task140c] ${tag} (${w}x${h}${spoof ? ' spoof' : ''}) — perf: ${JSON.stringify(fx.perf)}`)
  console.log(`[task140c]   loop ${f0}→${f1} · tfFrames ${fx.frames} · shots ${JSON.stringify(shots)}`)
  console.log(`[task140c]   instDraws: ${JSON.stringify(fx.instDraws)}`)
  console.log(`[task140c]   glErrors: ${fx.errors.length === 0 ? 'NONE' : JSON.stringify(fx.errors)}`)
  await page.close()
  await context.close()
  return { fx, shots, warmTotal, loop: [f0, f1] }
}

const spoofLeg = await leg('S-spoof-small', { spoof: true, w: 320, h: 200, seconds: 6 })
const ctrlLeg = await leg('K-control-small', { spoof: false, w: 320, h: 200, seconds: 4 })

// ── the verdict ──
{
  const warmS = spoofLeg.shots.filter((s) => s.warm !== undefined).reduce((a, s) => a + s.warm, 0)
  const warmK = ctrlLeg.shots.filter((s) => s.warm !== undefined).reduce((a, s) => a + s.warm, 0)
  const instMax = Math.max(0, ...spoofLeg.fx.instDraws.map((d) => d.inst ?? 0))
  console.log('── THE VERDICT ──')
  console.log(`spoof@160k gpu-pipeline: warm ${warmS.toFixed(2)}% | control@16k cpu: warm ${warmK.toFixed(2)}% | spoof instMax ${instMax}`)
  if (instMax <= 0) console.log('[task140c] FAIL — the ember instanced draw NEVER ran with inst > 0')
  else if (warmS <= 0.01 && warmK > 0.01) console.log('[task140c] FAIL — REPRODUCED: the gpu pipeline draws nothing while the control is warm')
  else if (warmS > 0.01) console.log('[task140c] PASS — the full gpu pipeline is warm end-to-end at 160k (the container cannot reproduce the user symptom)')
  else console.log('[task140c] INCONCLUSIVE — neither leg warm (control starved too?)')
  const hard = consoleMsgs.filter((m) => m.startsWith('PAGEERROR:'))
  if (hard.length > 0) { console.log('[task140c] page errors: ' + hard.slice(0, 3).join(' | ')); process.exitCode = 1 }
}

await browser.close()
server.stop(true)
