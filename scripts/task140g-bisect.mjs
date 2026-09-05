// task140g-bisect — THE CONTROL vs THE FORCED PIPELINE (Task 140).
//
// task140f: BOTH legs cold at 40k (first run AND the re-made run) — the
// re-make is exonerated; the DEFAULT GPU pipeline (emit:'gpu' + cull) does
// not produce visible embers even on run 1, while records read back SANE
// and the instanced draw is issued (floor visible at lit ~7%, warm 0%).
//
// THE QUESTION NOW: is anything warm AT ALL on this page's WebGL leg?
//   leg Y — the container's own default (16k, SOFTWARE_GL=true, the
//            CONSERVATIVE CPU path: emit cpu, no cull) — THE CONTROL;
//   leg X — 16k + ?emit=1&cull=1 (the Task-139 F-matrix config — was its
//            "warm pixels" verdict real?)
// No spoof, no patch — the page as the container sees it, at 480×320.
import { join } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const root = '/home/z/my-project/rune'
const out = join(root, '.shots', 'task140')
mkdirSync(out, { recursive: true })
const port = 8146

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
const context = await browser.newContext({ viewport: { width: 480, height: 320 } })
await context.addInitScript(() => {
  window.__fxErrors = []
  window.__fxFrames = 0
  window.__fxInst = []
  const orig = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = orig.call(this, type, ...rest)
    if (type === 'webgl2' && ctx != null && !ctx.__fxHooked) {
      ctx.__fxHooked = true
      const hook = (name) => {
        const fn = ctx[name].bind(ctx)
        ctx[name] = (...args) => {
          const t = performance.now()
          const r = fn(...args)
          if (name === 'drawArraysInstanced') {
            window.__fxInst.push({ t: +t.toFixed(0), inst: args[3] })
            if (window.__fxInst.length > 40) window.__fxInst.shift()
          }
          if (name === 'endTransformFeedback') window.__fxFrames++
          const err = ctx.getError()
          if (err !== 0) window.__fxErrors.push({ name, err, t: +t.toFixed(0) })
          return r
        }
      }
      for (const name of ['drawArraysInstanced', 'endTransformFeedback']) hook(name)
    }
    return ctx
  }
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

async function leg(tag, query, seconds) {
  const page = await context.newPage()
  const consoleMsgs = []
  page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text().slice(0, 160)}`))
  page.on('pageerror', (e) => consoleMsgs.push('PAGEERROR: ' + String(e).slice(0, 160)))
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
    instTail: window.__fxInst.slice(-4),
    frames: window.__fxFrames,
    errors: window.__fxErrors.slice(-4),
  })).catch((e) => ({ crash: String(e).slice(0, 120) }))
  // TWO shots a frame apart (the motion-gate class: a live canvas must
  // produce a NEW frame between the pair)
  const shots = []
  for (let k = 0; k < 2; k++) {
    const clip = await page.evaluate(() => {
      const c = document.querySelector('canvas')
      if (!c) return null
      const r = c.getBoundingClientRect()
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
    }).catch(() => null)
    if (clip == null) { shots.push({ error: 'no clip' }); continue }
    try {
      const path = join(out, `${tag}-${k}.png`)
      await page.screenshot({ path, clip, timeout: 15_000 })
      shots.push(warmOf(PNG.sync.read(readFileSync(path))))
    } catch { shots.push({ starved: true }) }
  }
  console.log(`[task140g] ${tag}${query === '' ? ' (default)' : ' ' + query}`)
  console.log(`[task140g] ${tag} state: ${JSON.stringify(state)}`)
  console.log(`[task140g] ${tag} pixels: ${JSON.stringify(shots)}`)
  await page.close()
  const warm = shots.filter((s) => s.warm !== undefined).map((s) => s.warm)
  return { tag, warmMax: warm.length > 0 ? Math.max(...warm) : -1, lit: shots[0]?.lit, state }
}

const Y = await leg('Y-control-16k', '', 4)
const X = await leg('X-forced-16k', '?emit=1&cull=1', 4)

console.log('── THE VERDICTS ──')
console.log(`Y (default 16k conservative): warm ${Y.warmMax}% · lit ${Y.lit}%`)
console.log(`X (16k ?emit=1&cull=1)     : warm ${X.warmMax}% · lit ${X.lit}%`)
if (Y.warmMax > 0.05 && X.warmMax <= 0.02) console.log('[task140g] !!! THE GPU PIPELINE IS THE INVISIBLE ROOT — the conservative CPU path is warm, the forced GPU pipeline is COLD (the F-matrix warm verdict did not cover this)')
else if (Y.warmMax <= 0.02) console.log('[task140g] !!! THE CONTROL IS COLD TOO — something more basic is broken on this page (see states)')
else if (X.warmMax > 0.05) console.log('[task140g] X warm?! — contradicts task140f: the difference is the spoof/size (investigate 40k+spoof vs 16k+flags)')
await browser.close()
server.stop(true)
