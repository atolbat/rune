// task150 — THE ISOLATION WALK (Task 150: name the dropping pass family
// on the reporting device — automatically, in one visit).
//
// Three verdict cells, each presetting the walk at leg A (a fresh page,
// the renderer spoofed onto the real-GPU class, the capacity patched to
// the container's fast 16k) with a CONFIG-AWARE dropped-driver
// simulation: the zeroed getBufferSubData AND readPixels fire only when
// the live page's configuration (window.__vfxPerf — the demo's make sets
// it before any verdict) matches the cell's culprit family:
//   · 'emit'        — zero when emit === 'gpu': leg A (the GPU emission
//                     alone) DROPS, leg B (the cull family alone) is
//                     CLEAN → verdict 'emit'.
//   · 'cull'        — zero when cull === true: leg A is CLEAN, leg B
//                     DROPS → verdict 'cull'.
//   · 'interaction' — zero only when BOTH (emit === 'gpu' AND cull):
//                     both legs are CLEAN → verdict 'interaction'.
// Every cell's minimal configuration (the rung-1 heal: emit 'cpu', cull
// off) never matches a predicate → the heal lands warm and STAYS (no
// escalation — the walk's exit is exactly the v150 0→1 step).
//
// Task 151 — THE CONTAMINATED CELL ('contaminated'): the live 12:36
// session's lesson — rung 1 (the PROVEN-CLEAN minimal configuration a
// fresh page load renders at the full capacity) dropped right after the
// walk's legs did. The predicate zeroes EVERY GPU-tier context (the drop
// follows the session's context history, not the configuration): leg A
// drops, leg B drops, the verdict fires "both families" — and then the
// HEAL drops too, which must fire the CORRECTION (the verdict is
// INCONCLUSIVE — the machine-readable forensicResult.contaminated flag)
// and land the page on the CPU tier warm, exactly the chain the live
// log walked. FOUR makes (the leg-A preset skips the L0 verdict):
// leg A (1) → leg B (2) → rung 1 (3) → the CPU tier (4).
//
// Each cell MUST: walk leg A → leg B → the heal (three makes: remakes
// === 3 — the legs and the heal each re-boot the RENDERER for a fresh
// GL context, the same boot channel the 0→1 step rides), verdict the
// right family (window.__embersForensicResult === { a, b, verdict } and
// the FORENSIC VERDICT console warn naming it), clear the leg flag,
// land on rung 1 (fallbackFlag 1, perf.fallback 'tf', tier 'gpu', emit
// 'cpu', cull false, a live gpuBackend, the full patched capacity) with
// the rung's own pixel sample WARM, zero page errors, and a warm
// compositor shot.
import { join } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const root = '/home/z/my-project/rune'
const out = join(root, '.shots', 'task150')
mkdirSync(out, { recursive: true })
const port = Number(process.env.TASK150_PORT ?? 8158)

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
      body = body.replace(/const TF_CAPACITY = SOFTWARE_GL \? 16_000 : 160_000/, 'const TF_CAPACITY = 16000')
      body = body.replace(/const FALLBACK_CAPACITY = SOFTWARE_GL \? 16_000 : COARSE \? 32_000 : GPU_CAPACITY/, 'const FALLBACK_CAPACITY = 16000')
      if (body === before) { console.error('[task150] PATCH FAILED'); process.exit(1) }
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
  let w = 0
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4
    if (data[i] > 40 && data[i] > data[i + 1] * 1.15 && data[i + 1] > data[i + 2] * 1.05) w++
  }
  return { warm: +(100 * w / (W * H)).toFixed(3) }
}

// The dropped-driver simulation, CONFIG-AWARE: the zeroing (the records
// readback AND the in-frame canvas sample — both halves of the
// pixel-confirmed verdict, Task 148's lesson) fires only when the LIVE
// configuration matches the cell's culprit predicate. The predicate reads
// window.__vfxPerf — the demo's make() sets it before any verdict fires,
// so every context born on the page (the walk re-boots the renderer —
// the hooks ride the getContext prototype, Task 149's lesson) drops
// exactly the configurations the cell wants dropped.
async function cell(tag, predicateSrc, expect) {
  const context = await browser.newContext({ viewport: { width: 480, height: 320 } })
  // preset the walk at leg A (the same channel a live session reaches:
  // the level-0 verdict writes the leg flag before the re-make)
  await context.addInitScript(() => { window.__embersForensic = 'a' })
  await context.addInitScript((predSrc) => {
    const predicate = eval(predSrc)
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
        const drop = () => {
          const p = window.__vfxPerf
          return p != null && predicate(p)
        }
        const origGetBuf = ctx.getBufferSubData.bind(ctx)
        ctx.getBufferSubData = (target, srcByteOffset, dst) => {
          const r = origGetBuf(target, srcByteOffset, dst)
          if (dst instanceof Float32Array && drop()) dst.fill(0)
          return r
        }
        const origRp = ctx.readPixels.bind(ctx)
        ctx.readPixels = (x, y, w, h, format, type, dst) => {
          const r = origRp(x, y, w, h, format, type, dst)
          if (dst instanceof Uint8Array && drop()) dst.fill(0)
          return r
        }
      }
      return ctx
    }
  }, predicateSrc)
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

  // THE WALK: leg A (make 1) → leg B (make 2) → the rung-1 heal (make 3).
  // The container's slow raster makes each verdict take 15-30 s at the
  // patched 16k — the whole walk lands within a few minutes; on a real
  // GPU the same walk is ~3-5 s (the phone's expected experience).
  await page.waitForFunction(() => window.__fxRemakes >= 3, null, { timeout: 300_000 }).catch(() => { })
  // the heal's own verdict: rung 1 is the minimal configuration — never
  // zeroed by any predicate — its records read SANE and its pixel sample
  // WARM (the rung the reporting phone is expected to keep at 160k)
  await page.waitForFunction(() => window.__vfxPerf?.pixelCheck === 'warm' || window.__vfxPerf?.pixelCheck === 'cold', null, { timeout: 150_000 }).catch(() => { })
  await page.waitForTimeout(1500)
  const state = await page.evaluate(() => ({
    perf: window.__vfxPerf ? { ...window.__vfxPerf } : null,
    remakes: window.__fxRemakes,
    fallbackFlag: window.__embersFallback ?? 0,
    legFlag: window.__embersForensic ?? null,
    forensicResult: window.__embersForensicResult ? { ...window.__embersForensicResult } : null,
    gpuBackends: (window.__vfxLayers ?? []).filter((l) => l?.gpuBackend !== undefined).length,
  })).catch((e) => ({ crash: String(e).slice(0, 150) }))
  let shot = { starved: true }
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
  console.log(`[task150] ${tag}: perf ${JSON.stringify(state.perf)} · remakes ${state.remakes} · fallbackFlag ${state.fallbackFlag} · legFlag ${JSON.stringify(state.legFlag)} · gpuBackends ${state.gpuBackends}`)
  console.log(`[task150] ${tag}: forensicResult ${JSON.stringify(state.forensicResult)}`)
  console.log(`[task150] ${tag}: pixels ${JSON.stringify(shot)}`)
  const warns = consoleMsgs.filter((m) => m.includes('rune/vfx') || m.includes('rune/particles'))
  if (warns.length > 0) warns.forEach((w) => console.log(`[task150] ${tag} warn: ${w.slice(0, 260)}`))

  // ── the cell's contract ──
  const p = state.perf
  const fr = state.forensicResult
  const walkedOk = state.remakes === 3 && state.legFlag === null
    && fr != null && fr.a === expect.a && fr.b === expect.b && fr.verdict === expect.verdict
  const healedOk = state.fallbackFlag === 1 && p?.tier === 'gpu' && p?.emit === 'cpu' && p?.cull === false
    && p?.fallback === 'tf' && p?.capacity === 16000 && p?.forensic === undefined
    && p?.pixelCheck === 'warm' && state.gpuBackends === 1
  const verdictLine = consoleMsgs.find((m) => m.includes('FORENSIC VERDICT') && m.includes(expect.verdictText))
  const errs = consoleMsgs.filter((m) => m.startsWith('PAGEERROR'))
  console.log(`[task150] ${tag}: walk ${walkedOk ? '✓ (leg A → leg B → the heal, the verdict matrix ' + JSON.stringify({ a: fr?.a, b: fr?.b, verdict: fr?.verdict }) + ')' : `FAIL ${JSON.stringify(state)}`} · heal ${healedOk ? '✓ (rung 1: conservative TF, emit cpu, cull off, warm)' : `FAIL ${JSON.stringify(p)}`} · verdict line ${verdictLine != null ? 'FIRED ✓' : 'MISSING'}`)
  if (errs.length > 0) { console.log(`[task150] ${tag} PAGE ERRORS: ${JSON.stringify(errs.slice(0, 4))}`); process.exitCode = 1 }
  await page.close()
  await context.close()
  return { walkedOk, healedOk, verdictLine: verdictLine != null, warm: (shot.warm ?? -1) > 0.05, errs: errs.length === 0 }
}

// Task 151 — THE CONTAMINATED CELL: the predicate zeroes EVERY GPU-tier
// context — leg A drops, leg B drops, the verdict says "both families",
// and the heal drops too → the CORRECTION must declare the verdict
// INCONCLUSIVE (forensicResult.contaminated) and the page must land on
// the CPU tier warm (the zeroing never matches tier 'cpu').
async function contaminatedCell() {
  const context = await browser.newContext({ viewport: { width: 480, height: 320 } })
  // preset the walk at leg A (the same channel a live session reaches)
  await context.addInitScript(() => { window.__embersForensic = 'a' })
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
        const drop = () => {
          const p = window.__vfxPerf
          return p != null && p.tier === 'gpu'
        }
        const origGetBuf = ctx.getBufferSubData.bind(ctx)
        ctx.getBufferSubData = (target, srcByteOffset, dst) => {
          const r = origGetBuf(target, srcByteOffset, dst)
          if (dst instanceof Float32Array && drop()) dst.fill(0)
          return r
        }
        const origRp = ctx.readPixels.bind(ctx)
        ctx.readPixels = (x, y, w, h, format, type, dst) => {
          const r = origRp(x, y, w, h, format, type, dst)
          if (dst instanceof Uint8Array && drop()) dst.fill(0)
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

  // THE CHAIN: leg A (make 1) → leg B (make 2) → rung 1 (make 3) → the
  // CPU tier (make 4). Each GPU-tier verdict takes 15-30 s at the
  // container's slow raster; the walk's re-boots now settle 2 s each
  // (Task 151's re-boot settle).
  await page.waitForFunction(() => window.__vfxPerf?.tier === 'cpu' && window.__fxRemakes >= 4, null, { timeout: 300_000 }).catch(() => { })
  await page.waitForTimeout(2500)
  const state = await page.evaluate(() => ({
    perf: window.__vfxPerf ? { ...window.__vfxPerf } : null,
    remakes: window.__fxRemakes,
    fallbackFlag: window.__embersFallback ?? 0,
    legFlag: window.__embersForensic ?? null,
    forensicResult: window.__embersForensicResult ? { ...window.__embersForensicResult } : null,
    gpuBackends: (window.__vfxLayers ?? []).filter((l) => l?.gpuBackend !== undefined).length,
  })).catch((e) => ({ crash: String(e).slice(0, 150) }))
  let shot = { starved: true }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const clip = await page.evaluate(() => {
        const c = document.querySelector('canvas')
        const r = c.getBoundingClientRect()
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
      })
      const path = join(out, `contaminated-${attempt}.png`)
      await page.screenshot({ path, clip, timeout: 20_000 })
      shot = warmOf(PNG.sync.read(readFileSync(path)))
    } catch { break }
    if ((shot.warm ?? -1) > 0.05) break
    await page.waitForTimeout(900)
  }
  console.log(`[task150] contaminated: perf ${JSON.stringify(state.perf)} · remakes ${state.remakes} · fallbackFlag ${state.fallbackFlag} · legFlag ${JSON.stringify(state.legFlag)} · gpuBackends ${state.gpuBackends}`)
  console.log(`[task150] contaminated: forensicResult ${JSON.stringify(state.forensicResult)}`)
  console.log(`[task150] contaminated: pixels ${JSON.stringify(shot)}`)
  const warns = consoleMsgs.filter((m) => m.includes('rune/vfx') || m.includes('rune/particles'))
  if (warns.length > 0) warns.forEach((w) => console.log(`[task150] contaminated warn: ${w.slice(0, 260)}`))

  // ── the cell's contract ──
  const p = state.perf
  const fr = state.forensicResult
  const chainOk = state.remakes === 4 && state.legFlag === null
    && fr != null && fr.a === 'dropped' && fr.b === 'dropped' && fr.verdict === 'both' && fr.contaminated === true
  const landedOk = state.fallbackFlag === 2 && p?.tier === 'cpu' && p?.emit === 'cpu' && p?.cull === false
    && p?.fallback === 'cpu' && p?.capacity === 16000 && state.gpuBackends === 0
  const verdictLine = consoleMsgs.find((m) => m.includes('FORENSIC VERDICT') && m.includes('BOTH families drop independently'))
  const correctionLine = consoleMsgs.find((m) => m.includes('FORENSIC CORRECTION') && /INCONCLUSIVE/i.test(m))
  const errs = consoleMsgs.filter((m) => m.startsWith('PAGEERROR'))
  console.log(`[task150] contaminated: chain ${chainOk ? '✓ (leg A dropped → leg B dropped → verdict both → rung 1 dropped → the correction → the CPU tier)' : `FAIL ${JSON.stringify(state)}`} · landing ${landedOk ? '✓ (CPU tier, no gpuBackend)' : `FAIL ${JSON.stringify(p)}`} · verdict line ${verdictLine != null ? 'FIRED ✓' : 'MISSING'} · correction line ${correctionLine != null ? 'FIRED ✓' : 'MISSING'}`)
  if (errs.length > 0) { console.log(`[task150] contaminated PAGE ERRORS: ${JSON.stringify(errs.slice(0, 4))}`); process.exitCode = 1 }
  await page.close()
  await context.close()
  return { walkedOk: chainOk, healedOk: landedOk, verdictLine: verdictLine != null, correctionLine: correctionLine != null, warm: (shot.warm ?? -1) > 0.05, errs: errs.length === 0 }
}

const CELLS = {
  emit: ['emit-culprit', `(p) => p.emit === 'gpu'`, { a: 'dropped', b: 'clean', verdict: 'emit', verdictText: 'GPU-EMISSION FAMILY' }],
  cull: ['cull-culprit', `(p) => p.cull === true`, { a: 'clean', b: 'dropped', verdict: 'cull', verdictText: 'CULL/SORT FAMILY' }],
  interaction: ['interaction', `(p) => p.emit === 'gpu' && p.cull === true`, { a: 'clean', b: 'clean', verdict: 'interaction', verdictText: 'NEITHER family drops alone' }],
}
const only = process.env.TASK150_CELL
const results = {}
for (const [key, args] of Object.entries(CELLS)) {
  if (only !== undefined && key !== only) continue
  results[key] = await cell(...args)
}
// Task 151 — the contaminated cell runs with the full battery (skip it
// only by pinning TASK150_CELL to one of the three verdict cells)
if (only === undefined || only === 'contaminated') {
  results.contaminated = await contaminatedCell()
}
const emitCell = results.emit ?? { walkedOk: false, healedOk: false, verdictLine: false, warm: false, errs: false }
const cullCell = results.cull ?? { walkedOk: false, healedOk: false, verdictLine: false, warm: false, errs: false }
const interCell = results.interaction ?? { walkedOk: false, healedOk: false, verdictLine: false, warm: false, errs: false }
const contCell = results.contaminated ?? { walkedOk: false, healedOk: false, verdictLine: false, correctionLine: false, warm: false, errs: false }

console.log('── THE VERDICTS ──')
const rows = [['emit (leg A drops)', emitCell], ['cull (leg B drops)', cullCell], ['interaction (both clean)', interCell], ['contaminated (rung 1 drops too)', contCell]]
let ok = true
for (const [name, r] of rows) {
  const pass = r.walkedOk && r.healedOk && r.verdictLine && r.warm && r.errs && (r.correctionLine !== false)
  if (!pass) ok = false
  console.log(`${name}: ${pass ? 'PASS ✓' : `FAIL ${JSON.stringify(r)}`}`)
}
console.log(ok ? '[task150] PASS — every verdict cell walks and heals, and the contaminated cell corrects its verdict before landing the CPU tier warm' : '[task150] FAIL — see above')
if (!ok) process.exitCode = 1

await browser.close()
server.stop(true)
