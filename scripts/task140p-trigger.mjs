// task140p — THE AUTO-FALLBACK TRIGGER, end-to-end (Task 140, Task 148,
// Task 149 — THE TWO-RUNG LADDER; Task 150 — THE ISOLATION WALK).
//
// task140n validated the pieces: the diagnostics fire and verdict SANE on
// a healthy page (no false fallback), and the preset ladder positions
// take their rungs. THIS probe walks the REAL chain: a live page, the
// diagnostics fired — then we simulate the FULL dropped-driver
// signature (Task 148: the pixel-confirmed ladder needs BOTH halves):
// zero every getBufferSubData readback (the records read back ALL-ZERO at
// frame 30 — the degenerate verdict) AND zero every readPixels return
// (the in-frame canvas sample reads COLD — exactly the blank canvas a
// real TF write drop shows; zeroing only the readback would leave the
// pixels WARM and the ladder would correctly REFUSE to fall back — the
// lying-readback guard). The Task-149 discipline: the zeroing rides the
// getContext PROTOTYPE hook — it survives every renderer re-boot the
// walk performs (a fresh canvas + a fresh GL context must ALSO read
// back zeroed for every later verdict). The demo's frame ladder must:
// latch the suspicion, confirm it cold, and enter THE ISOLATION WALK
// (Task 150): leg A (the GPU emission alone) re-booted and re-verdicted
// DROPPED → leg B (the cull/sort family alone) re-booted and re-verdicted
// DROPPED → the FORENSIC VERDICT names BOTH families and heals into the
// CONSERVATIVE TF rung (tier 'gpu', emit:'cpu', cull off, the full
// patched capacity, a gpuBackend present, fallback 'tf'); the rung's OWN
// diagnostic re-verdicts degenerate (the records still read zeroed), its
// pixel sample confirms cold — the escalation to 2 fires the Task-151
// FORENSIC CORRECTION first (the verdict is INCONCLUSIVE: rung 1 is the
// proven-clean configuration, so the drop follows the session's context
// history — the machine-readable forensicResult.contaminated flag) and
// then the rung-2 warning; the final re-make must run the FULL-CPU branch
// (sim:'cpu', tier:'cpu', no GPU backend, fallback 'cpu') with warm
// pixels. FIVE makes total; the walk entry, the FORENSIC VERDICT, the
// FORENSIC CORRECTION, and the rung-2 warnings all expected.
import { join } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const root = '/home/z/my-project/rune'
const out = join(root, '.shots', 'task140')
mkdirSync(out, { recursive: true })
const port = Number(process.env.TASK140P_PORT ?? 8156)

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
      body = body.replace(/const TF_CAPACITY = SOFTWARE_GL \? 16_000 : 160_000/, 'const TF_CAPACITY = 16000')
      // Task 148 — the re-made CPU tier's capacity (the healed branch takes
      // FALLBACK_CAPACITY — patch it to the same fast 16k budget)
      body = body.replace(/const FALLBACK_CAPACITY = SOFTWARE_GL \? 16_000 : COARSE \? 32_000 : GPU_CAPACITY/, 'const FALLBACK_CAPACITY = 16000')
    }
    return new Response(body, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})
const context = await browser.newContext({ viewport: { width: 480, height: 320 } })
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
  // Task 149 — THE ZEROING RIDES THE PROTOTYPE HOOK: the ladder's 0→1 step
  // re-boots the RENDERER (a fresh canvas element + a fresh GL context) —
  // a hook installed on the old context object would die with it and the
  // second verdict would read the REAL (healthy) records. Every webgl2
  // context born on this page reads back zeroed, forever: the level-0
  // verdict AND the level-1 re-verdict both see the dropped-driver
  // signature; the level-2 CPU tier renders physically warm (the zeroing
  // only poisons the READBACKS, not the rasterization).
  const orig = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = orig.call(this, type, ...rest)
    if (type === 'webgl2' && ctx != null && !ctx.__fxHooked) {
      ctx.__fxHooked = true
      const origGetParameter = ctx.getParameter.bind(ctx)
      ctx.getParameter = (pname, ...pr) => (pname === UNMASKED_RENDERER ? SPOOF_RENDERER : origGetParameter(pname, ...pr))
      const origGetBuf = ctx.getBufferSubData.bind(ctx)
      ctx.getBufferSubData = (target, srcByteOffset, dst) => {
        const r = origGetBuf(target, srcByteOffset, dst)
        if (dst instanceof Float32Array) dst.fill(0)
        return r
      }
      const origRp = ctx.readPixels.bind(ctx)
      ctx.readPixels = (x, y, w, h, format, type, dst) => {
        const r = origRp(x, y, w, h, format, type, dst)
        if (dst instanceof Uint8Array) dst.fill(0)
        return r
      }
    }
    return ctx
  }
})
const page = await context.newPage()
const consoleMsgs = []
page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text().slice(0, 900)}`))
page.on('pageerror', (e) => consoleMsgs.push('PAGEERROR: ' + String(e).slice(0, 220)))

await page.goto(`http://localhost:${port}/demo/vfx/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForTimeout(1000)
await page.click('#rd-fab')
await page.click('label[for="mode-webgl2"]')
await page.waitForTimeout(400)
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('button')]
  rows.find((r) => (r.textContent ?? '').includes('GPU Embers'))?.click()
})
// wait for the tier to exist (the layer lands within the click)
await page.waitForFunction(() => (window.__vfxLayers ?? []).some((l) => l?.gpuBackend), null, { timeout: 30_000 })

const before = await page.evaluate(() => ({ perf: { ...window.__vfxPerf }, remakes: window.__fxRemakes }))
console.log(`[task140p] before: ${JSON.stringify(before)}`)

// Task 150 — THE EXTENDED CHAIN: the level-0 verdict now enters THE
// ISOLATION WALK before the heal — under this probe's GLOBAL zeroing
// (every context, every configuration) BOTH legs drop, the FORENSIC
// VERDICT names both families, and the walk's exit heals into rung 1;
// rung 1 re-verdicts dropped (the zeroing never lifts) and escalates
// to the CPU tier exactly as v150 did. FIVE makes total: L0 (1) → leg
// A (2) → leg B (3) → rung 1 (4) → rung 2 CPU (5). The container's
// slow raster makes each verdict 15-30s at the patched 16k.

// LEG A (remakes 2): the GPU-emission family alone (emit 'gpu', cull
// off) on a fresh re-booted context — still zeroed → degenerate + cold
// → the leg verdicts DROPPED and the walk steps to leg B.
await page.waitForFunction(() => window.__fxRemakes >= 2, null, { timeout: 150_000 }).catch(() => { })
await page.waitForTimeout(2500)
const legA = await page.evaluate(() => ({
  perf: window.__vfxPerf ? { ...window.__vfxPerf } : null,
  remakes: window.__fxRemakes,
  legFlag: window.__embersForensic ?? null,
  fallbackFlag: window.__embersFallback ?? 0,
  booted: document.querySelector('canvas') != null,
})).catch((e) => ({ crash: String(e).slice(0, 150) }))
console.log(`[task140p] leg A (the GPU emission alone): ${JSON.stringify(legA)}`)

// LEG B (remakes 3): the cull/sort family alone (emit 'cpu', cull on) —
// still zeroed → DROPPED → the FORENSIC VERDICT (both families) fires
// and the walk heals into rung 1 (the next make).
await page.waitForFunction(() => window.__fxRemakes >= 3, null, { timeout: 150_000 }).catch(() => { })
await page.waitForTimeout(2500)
const legB = await page.evaluate(() => ({
  perf: window.__vfxPerf ? { ...window.__vfxPerf } : null,
  remakes: window.__fxRemakes,
  legFlag: window.__embersForensic ?? null,
  forensicResult: window.__embersForensicResult ? { ...window.__embersForensicResult } : null,
  fallbackFlag: window.__embersFallback ?? 0,
  booted: document.querySelector('canvas') != null,
})).catch((e) => ({ crash: String(e).slice(0, 150) }))
console.log(`[task140p] leg B (the cull/sort family alone): ${JSON.stringify(legB)}`)

// RUNG 1 (remakes 4): the walk's heal — the conservative TF tier on a
// fresh context; the zeroing never lifts → the rung's own re-verdict
// goes degenerate + cold → the escalation to level 2.
await page.waitForFunction(() => window.__fxRemakes >= 4, null, { timeout: 150_000 }).catch(() => { })
await page.waitForTimeout(2500)
const mid = await page.evaluate(() => ({
  perf: window.__vfxPerf ? { ...window.__vfxPerf } : null,
  remakes: window.__fxRemakes,
  fallbackFlag: window.__embersFallback ?? 0,
  legFlag: window.__embersForensic ?? null,
  forensicResult: window.__embersForensicResult ? { ...window.__embersForensicResult } : null,
  gpuBackends: (window.__vfxLayers ?? []).filter((l) => l?.gpuBackend !== undefined).length,
  booted: document.querySelector('canvas') != null,
})).catch((e) => ({ crash: String(e).slice(0, 150) }))
console.log(`[task140p] mid (the conservative TF rung — the walk's heal): ${JSON.stringify(mid)}`)

// RUNG 2 (remakes 5): the level-1 re-verdict → the full-CPU re-make.
// Settle for the warm pixels.
await page.waitForFunction(() => window.__fxRemakes >= 5, null, { timeout: 150_000 }).catch(() => { })
await page.waitForTimeout(4000)

const after = await page.evaluate(() => ({
  perf: window.__vfxPerf ? { ...window.__vfxPerf } : null,
  remakes: window.__fxRemakes,
  fallbackFlag: window.__embersFallback ?? 0,
  forensicResult: window.__embersForensicResult ? { ...window.__embersForensicResult } : null,
  gpuBackends: (window.__vfxLayers ?? []).filter((l) => l?.gpuBackend !== undefined).length,
})).catch((e) => ({ crash: String(e).slice(0, 150) }))
console.log(`[task140p] after (the CPU rung): ${JSON.stringify(after)}`)

// the re-made (CPU-tier) page must be WARM
let shot = { starved: true }
try {
  const clip = await page.evaluate(() => {
    const c = document.querySelector('canvas')
    const r = c.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
  })
  const path = join(out, 'p-after-fallback.png')
  await page.screenshot({ path, clip, timeout: 20_000 })
  const png = PNG.sync.read(readFileSync(path))
  const { width: W, height: H, data } = png
  let w = 0
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4
    if (data[i] > 40 && data[i] > data[i + 1] * 1.15 && data[i + 1] > data[i + 2] * 1.05) w++
  }
  shot = { warm: +(100 * w / (W * H)).toFixed(3) }
} catch { }
console.log(`[task140p] after pixels: ${JSON.stringify(shot)}`)
// Task 150 — the walk's console story: the entry warning, the FORENSIC
// VERDICT naming BOTH families, and the rung-2 escalation warning. (The
// v150 'Stepping down ONCE' text no longer fires on this chain — the
// walk's exit does the 0→1 step and speaks through the FORENSIC VERDICT
// line instead; the direct rung warning still fires on the skipped-walk
// paths — the ?forensic=0 escape and the flags-narrowed configurations.)
const warnWalk = consoleMsgs.find((m) => m.includes('rune/vfx') && /ISOLATION WALK/i.test(m))
const warnForensic = consoleMsgs.find((m) => m.includes('FORENSIC VERDICT') && /both families drop independently/i.test(m))
const warnCorrection = consoleMsgs.find((m) => m.includes('FORENSIC CORRECTION') && /INCONCLUSIVE/i.test(m))
const warnCpu = consoleMsgs.find((m) => m.includes('rune/vfx') && /falling back once/i.test(m))
console.log(`[task140p] walk entry warning: ${warnWalk ? 'FIRED ✓' : 'MISSING'}`)
console.log(`[task140p] forensic verdict (both families): ${warnForensic ? 'FIRED ✓' : 'MISSING'}`)
console.log(`[task140p] forensic correction (contaminated verdict): ${warnCorrection ? 'FIRED ✓' : 'MISSING'}`)
console.log(`[task140p] rung-2 warning (falling back): ${warnCpu ? 'FIRED ✓' : 'MISSING'}`)

{
  // LEG A live: the GPU-emission family alone, pinned by the walk
  const legAOk = legA.perf?.tier === 'gpu' && legA.perf?.emit === 'gpu' && legA.perf?.cull === false
    && legA.perf?.forensic === 'a' && legA.legFlag === 'a' && legA.fallbackFlag === 0
    && legA.remakes === 2 && legA.booted === true
  // LEG B live: the cull/sort family alone, pinned by the walk
  const legBOk = legB.perf?.tier === 'gpu' && legB.perf?.emit === 'cpu' && legB.perf?.cull === true
    && legB.perf?.forensic === 'b' && legB.legFlag === 'b' && legB.fallbackFlag === 0
    && legB.remakes === 3 && legB.booted === true
  // the walk's heal: the verdict matrix + rung 1 pinned
  const midOk = mid.perf?.tier === 'gpu' && mid.perf?.emit === 'cpu' && mid.perf?.cull === false
    && mid.perf?.fallback === 'tf' && mid.perf?.capacity === 16000 && mid.perf?.forensic === undefined
    && mid.legFlag === null && mid.forensicResult?.a === 'dropped' && mid.forensicResult?.b === 'dropped'
    && mid.forensicResult?.verdict === 'both' && mid.fallbackFlag === 1
    && mid.gpuBackends === 1 && mid.remakes === 4 && mid.booted === true
  const ok = legAOk && legBOk && midOk
    && after.perf?.emit === 'cpu' && after.perf?.cull === false && after.perf?.fallback === 'cpu'
    && after.perf?.tier === 'cpu' && after.gpuBackends === 0 && after.remakes === 5
    && after.fallbackFlag === 2 && after.forensicResult?.contaminated === true
    && (shot.warm ?? -1) > 0.05 && warnWalk != null && warnForensic != null && warnCorrection != null && warnCpu != null
  const errs = consoleMsgs.filter((m) => m.startsWith('PAGEERROR'))
  if (errs.length > 0) { console.log('[task140p] PAGE ERRORS: ' + errs.slice(0, 2).join(' | ')); process.exit(1) }
  console.log(legAOk ? '[task140p] leg A ✓ — the level-0 verdict → the walk entry → the renderer re-boot → the GPU-EMISSION-alone tier (emit gpu, cull off, forensic \'a\')' : '[task140p] leg A FAIL — see the leg A state above')
  console.log(legBOk ? '[task140p] leg B ✓ — leg A verdicted dropped → the re-boot → the CULL/SORT-alone tier (emit cpu, cull on, forensic \'b\')' : '[task140p] leg B FAIL — see the leg B state above')
  console.log(midOk ? '[task140p] heal ✓ — the FORENSIC VERDICT (both families) → the walk exits into rung 1 (tier gpu, emit cpu, cull off, a live gpuBackend, fallback \'tf\')' : '[task140p] heal FAIL — see the mid state above')
  console.log(ok ? '[task140p] PASS — the full extended chain: L0 verdict → isolation walk (leg A dropped, leg B dropped, BOTH named) → rung 1 (re-verdicted degenerate + cold) → the FORENSIC CORRECTION (contaminated verdict flagged) → rung 2 CPU → warm pixels' : '[task140p] FAIL — see above')
  if (!ok) process.exit(1)
}
await browser.close()
server.stop(true)
