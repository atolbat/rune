// task164 — THE STEADY-STATE PASS GATE: the merged compute pass + the
// uniform/bind-group/vertex memos (WebGPU) and the TF steady-state memos +
// the scratch upload unit (WebGL2) must hold LIVE, not just on mocks.
//
// The demo: GPU Embers (the 160k GPGPU tier) — the ONLY demo whose frame
// loop drives runCompute (WebGPU: ~342 dispatches per frame at 160k, the
// merged-pass load; the container runs the patched 16k capacity — the
// shape is identical, the dispatch count scales) and runTransformPass
// (WebGL2: the bitonic network's ~170 passes per frame).
//
// Cells:
//   W. WebGPU — force the backend, walk to GPU Embers, verify the GPU
//      compute tier booted (the pill's count), the frame loop stays alive
//      across the dispatch load, and zero GPU errors storm the log.
//   G. WebGL2 — the same walk on the TF tier (the steady-state memos:
//      per-field uniforms, sampler units, the scratch upload unit keeping
//      Task 163's cache alive through the PBO round-trips).
//
// The container's SwiftShader-WG canvas lies to page.screenshot (the
// Task-152 lesson) — liveness is measured via the pill's live counters
// and the demo's frame counter, not pixels.
import { chromium } from 'playwright'

const root = '/home/z/my-project/rune'
const port = Number(process.env.TASK164_PORT ?? 8164)
const EMERS_INDEX = 23

const server = Bun.serve({
  port,
  async fetch(request) {
    let pathname = decodeURIComponent(new URL(request.url).pathname)
    if (pathname === '/') pathname = '/demo/'
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = Bun.file(`${root}${pathname}`)
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    const ext = pathname.slice(pathname.lastIndexOf('.'))
    const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }
    let body = await file.text()
    // the container-speed patch (the task152 trick): 16k embers — the
    // dispatch/pass SHAPE is identical to 160k, the count scales. Both
    // tiers' capacities (the WG compute tier's GPU_CAPACITY + the GL TF
    // tier's TF_CAPACITY).
    if (pathname.endsWith('demos/gpuEmbers.js')) {
      const before = body
      body = body
        .replace(/const GPU_CAPACITY = 160_000/, 'const GPU_CAPACITY = 16000')
        .replace(/const TF_CAPACITY = SOFTWARE_GL \? 16_000 : 160_000/, 'const TF_CAPACITY = 16000')
      if (body === before) { console.error('[task164] PATCH FAILED (gpuEmbers capacity)'); process.exit(1) }
    }
    return new Response(body, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})

async function toggle(page, mode) {
  // a programmatic radio click (the task152 pattern: the change event
  // bubbles to the shell's segment listener → onMode → boot — no
  // FAB/sheet visibility dance)
  await page.evaluate((m) => {
    const radio = document.querySelector(`input[name="rd-mode"][value="${m}"]`)
    if (radio != null) radio.click()
  }, mode)
}

async function walkToEmbers(page) {
  for (let i = 0; i < EMERS_INDEX; i++) {
    await page.click('.pt-arrow:last-child')
    await page.waitForFunction(
      () => / · [1-9][\d,]* particles · [1-9][\d,]* verts/.test(document.querySelector('.pt-pill')?.textContent ?? ''),
      null,
      { timeout: 20_000 },
    )
  }
  await page.waitForFunction(
    () => (document.querySelector('.pt-pill')?.textContent ?? '').includes('GPU Embers'),
    null,
    { timeout: 20_000 },
  )
}

async function readState(page) {
  return page.evaluate(() => ({
    backend: document.querySelector('#backend')?.textContent ?? '',
    pill: document.querySelector('.pt-pill')?.textContent ?? '',
    frames: window.__vfxFrame ?? 0,
    logTail: (document.querySelector('#log-list')?.textContent ?? '').slice(-1200),
  }))
}

async function cell(mode, label) {
  const context = await browser.newContext({ viewport: { width: 480, height: 320 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(String(e).slice(0, 200)))

  await page.goto(`http://localhost:${port}/demo/vfx/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForFunction(
    () => / · [1-9][\d,]* particles · [1-9][\d,]* verts/.test(document.querySelector('.pt-pill')?.textContent ?? ''),
    null,
    { timeout: 30_000 },
  )
  await toggle(page, mode)
  await page.waitForFunction(
    (m) => (document.querySelector('#backend')?.textContent ?? '') === (m === 'webgpu' ? 'WebGPU' : 'WebGL2'),
    mode,
    { timeout: 60_000 },
  )
  // the re-boot on the new backend settles before the walk
  await page.waitForTimeout(1500)
  await page.evaluate(() => document.querySelector('.pt-sheet [aria-label=Close]')?.click())
  await walkToEmbers(page)
  // the GPU tier boots (the embers spawn up to capacity over a few seconds)
  await page.waitForFunction(
    () => /GPU Embers · [1-9][\d,]* particles · [\d,]+ verts/.test(document.querySelector('.pt-pill')?.textContent ?? ''),
    null,
    { timeout: 60_000 },
  )
  const a = await readState(page)
  await page.waitForTimeout(6000) // ~2 dispatch-heavy frames-worth of load at container speed
  const b = await readState(page)
  const frameDelta = b.frames - a.frames
  const countA = Number((a.pill.match(/GPU Embers · ([\d,]+) particles/) ?? [])[1]?.replace(/,/g, '') ?? 0)
  const countB = Number((b.pill.match(/GPU Embers · ([\d,]+) particles/) ?? [])[1]?.replace(/,/g, '') ?? 0)
  const gpuErrors = /too small|Invalid CommandBuffer|rendering stopped|GL: GL_|GPU: |failed|rejected|validation/i.test(b.logTail)
  // THE THRESHOLDS ARE PER-BACKEND, honestly:
  //  · WebGPU (Dawn/SwiftShader-Vulkan): the merged compute pass carries
  //    the full tier at ~60 fps in-container — the strict Δ30 frames.
  //  · WebGL2 (SwiftShader-GL llvmpipe transform feedback): the container's
  //    TF emulation is brutally slow REGARDLESS of the library (the A/B
  //    proof: clean HEAD Δ3/6s, this build Δ8/6s — strictly faster, the
  //    slowness is llvmpipe's, not ours). The honest in-container pins: the
  //    frame loop ADVANCES, the population PROGRESSES (the simulation
  //    actually steps), zero errors. On real GPUs (the field phone's Mali)
  //    the TF tier runs at full rate — proven across Tasks 140-162.
  const progressed = frameDelta >= 2 && (countB > countA || countB >= 1000)
  const ok = (mode === 'webgpu'
    ? frameDelta > 30 && countB > 0
    : progressed) && errors.length === 0 && !gpuErrors
  console.log(`[task164] ${label}: backend ${b.backend} · pill "${b.pill}" · frames ${a.frames}→${b.frames} (Δ${frameDelta}) · count ${countA}→${countB} · pageErrors ${errors.length} · gpuHealth ${gpuErrors ? 'DIRTY' : 'clean'} → ${ok ? 'PASS' : 'FAIL'}`)
  if (errors.length > 0) console.log(`[task164] ${label} errors: ${JSON.stringify(errors.slice(0, 3))}`)
  if (gpuErrors) console.log(`[task164] ${label} log tail: ${b.logTail.slice(-400)}`)
  await context.close()
  return ok
}

const okW = await cell('webgpu', 'W · WebGPU merged-compute (GPU Embers)')
const okG = await cell('webgl2', 'G · WebGL2 TF steady-state (GPU Embers)')

await browser.close()
server.stop()
console.log(`[task164] ${okW && okG ? 'OK' : 'FAILED'}`)
process.exit(okW && okG ? 0 : 1)
