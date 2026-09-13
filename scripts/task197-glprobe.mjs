// task197-glprobe — THE WEBGL2 COMMON-GROUND GATE (Task 197).
//
// The occlusion demo's WebGL2 tier — the same Hi-Z pipeline on the GL
// contracts (an FBO pyramid over r32f data textures, a transform-feedback
// cull pass, a vertex-collapse instanced draw) — runs against the REAL
// ANGLE-WebGL2 stack of this container, in two channels:
//
//   · THE PROBE (?probe=1&mode=webgl2): the WG leg validates first (its
//     three camera hashes become the anchor), then the GL tier's own
//     verdict — intra-tier pixel parity (Hi-Z ON vs OFF), the accounting
//     invariant, the culling effect — AND the CROSS-TIER parity: the GL
//     hashes must equal the WG hashes (the same scene, the same cameras,
//     the same image on both backends — the common ground made testable).
//   · THE LIVE PAGE (?mode=webgl2): the canvas wiring — the displayed
//     canvas must BE the GL renderer's canvas (a live 'webgl2' context on
//     the stage node — the 197a lesson, GL-shaped), the loop running, the
//     counters alive, the log healthy.
//
// Exit 0 — the WebGL2 Hi-Z tier is live-verified; 1 — it broke.
// Usage: bun scripts/task197-glprobe.mjs
import { chromium } from 'playwright'

const root = '/home/z/my-project/rune'
const port = Number(process.env.TASK197_PORT ?? 8188)

const server = Bun.serve({
  port,
  async fetch(request) {
    let pathname = decodeURIComponent(new URL(request.url).pathname)
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = Bun.file(`${root}${pathname}`)
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    return new Response(await file.arrayBuffer(), {
      headers: {
        'content-type': pathname.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8',
      },
    })
  },
})

const browser = await chromium.launch({
  headless: true,
  // the combined set: WG needs the SwiftShader-Vulkan WebGPU flags (the
  // cross-tier anchor leg), GL rides the same browser's ANGLE stack.
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})

let failed = false
try {
  // ── leg 1: the probe — WG anchor + the GL verdict + the cross-tier gate ──
  {
    const page = await browser.newPage({ viewport: { width: 500, height: 420 } })
    const pageErrors = []
    page.on('pageerror', e => pageErrors.push(String(e)))
    page.on('console', m => { if (m.type() === 'error') pageErrors.push(m.text()) })

    await page.goto(`http://localhost:${port}/demo/occlusion/?probe=1&mode=webgl2`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    const gate = await page.waitForFunction(() => window.__hizGate !== undefined, null, { timeout: 240_000 })
    const verdict = await page.evaluate(() => window.__hizGate)
    const stats = await page.evaluate(() => window.__hizStats)

    if (verdict.bootFail !== undefined) {
      console.log(`[task197] PROBE BOOT FAILED:\n${String(verdict.bootFail).slice(0, 1600)}`)
      failed = true
    } else {
      console.log(`[task197] probe tier: ${verdict.tier} · scene ${stats.total} instances · Hi-Z ${stats.hizW}x${stats.hizH} · ${stats.levels} mips`)
      console.log(`[task197] errors: ${verdict.errors}${verdict.errors > 0 ? '' : ' (zero)'}`)
      if (verdict.errors > 0) failed = true
      if (pageErrors.length > 0) {
        console.log(`[task197] page errors: ${pageErrors.length} — ${pageErrors.slice(0, 3).join(' | ').slice(0, 300)}`)
        failed = true
      }
      console.log(`[task197] cross-tier cameras checked: ${verdict.crossChecked ?? 0}`)
      let camIdx = 0
      for (const cam of verdict.cameras) {
        camIdx++
        const cs = cam.crossStats
        console.log(`  camera ${camIdx} (yaw ${cam.yaw.toFixed(2)}): parity ${cam.parity} (${String(cam.hashOn).slice(0, 12)}) · cross-tier ${cam.crossParity ?? 'skipped'}${cs !== null && cs !== undefined ? ` ${cs.pct}% px, dmax ${cs.maxD}, drawn d${cs.drawnDelta}, occl d${cs.occludedDelta}` : ''} · drawn ON ${cam.drawnOn} / OFF ${cam.drawnOff} (${(100 * (1 - cam.drawnOn / cam.drawnOff)).toFixed(1)}% culled) · occluded ${cam.occludedOn}`)
        // Task 203 — the 'framegraph' leg is STRUCTURAL: ok is the verdict
        if (cam.policy !== 'framegraph' && cam.parity !== 'IDENTICAL') { console.log(`  FAIL — the GL intra-tier pixel parity diverged (${cam.hashOn} vs ${cam.hashOff})`); failed = true }
        if (cam.policy === 'framegraph' && !cam.ok) { console.log('  FAIL — the frame-graph leg (the compiled DAG own axioms)'); failed = true }
        if (cam.crossParity === 'DIVERGED') { console.log('  FAIL — the cross-tier (GL vs WG) bounded parity diverged'); failed = true }
        // Task 201 — the new camera shapes: the 'hysteresis' leg's whole
        // point is drawnOn === drawnOff at saturation (the streaks
        // reproduce the raw buckets — the decay number rides drawnDecay);
        // the plain/city legs keep the strict invariant + culling checks
        if (cam.policy === 'hysteresis') {
          if (cam.drawnOn !== cam.drawnOff) { console.log(`  FAIL — the saturated hysteresis must reproduce the raw buckets (${cam.drawnOn} vs ${cam.drawnOff})`); failed = true }
          if (!(cam.drawnDecay > cam.drawnOff)) { console.log(`  FAIL — the hysteresis decay did not show (${cam.drawnDecay} vs ${cam.drawnOff})`); failed = true }
        } else if (cam.policy === 'history') {
          // Task 202 — the feedback leg: culls MORE than the K walls, sound
          // under motion; drawnOn === the plain ON leg is impossible (the
          // set is richer), drawnOff here = the plain ON reference
          if (!(cam.drawnOn < cam.drawnOff) || cam.occludedOn <= 0) { console.log('  FAIL — the history feedback is not culling'); failed = true }
          if (cam.occludedOn < (cam.occludedOff ?? 0)) { console.log(`  FAIL — the feedback must occlude at least the K walls (${cam.occludedOn} vs ${cam.occludedOff})`); failed = true }
          if (!cam.movedIdentical) { console.log('  FAIL — the feedback motion soundness broke'); failed = true }
          if (!cam.invariantOn || !cam.invariantOff) { console.log('  FAIL — the feedback leg accounting invariant broke'); failed = true }
        } else if (cam.policy === 'amortized') {
          // Task 202 — the frozen-cull leg: drawnOn === drawnOff IS the
          // point (the verdicts reuse — bit-identical frame)
          if (cam.drawnOn !== cam.drawnOff) { console.log(`  FAIL — the frozen-cull frame must reproduce the fresh buckets (${cam.drawnOn} vs ${cam.drawnOff})`); failed = true }
          if (!((cam.skips ?? 0) >= 2)) { console.log(`  FAIL — the amortized frames did not skip the kernel (${cam.skips} skips)`); failed = true }
        } else if (cam.policy === 'framegraph') {
          // the structural leg: no pixels of its own — the ok flag is the verdict
        } else {
          if (!cam.invariantOn || !cam.invariantOff) { console.log('  FAIL — the accounting invariant broke'); failed = true }
          if (!(cam.drawnOn < cam.drawnOff) || cam.occludedOn <= 0) { console.log('  FAIL — the occlusion tier is not culling'); failed = true }
        }
      }
      if ((verdict.crossChecked ?? 0) !== 3) { console.log(`  FAIL — the cross-tier gate did not run all 3 cameras (checked ${verdict.crossChecked})`); failed = true }
      console.log(`[task197] probe verdict: ${verdict.pass ? 'PASS' : 'FAIL'}`)
      if (!verdict.pass) failed = true
    }
    await page.close()
  }

  // ── leg 2: the live page — the canvas wiring + the running loop ─────────
  {
    const page = await browser.newPage({ viewport: { width: 500, height: 420 } })
    const pageErrors = []
    page.on('pageerror', e => pageErrors.push(String(e)))
    page.on('console', m => { if (m.type() === 'error') pageErrors.push(m.text()) })

    await page.goto(`http://localhost:${port}/demo/occlusion/?mode=webgl2`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    const stats = await page.waitForFunction(
      () => (window.__hizStats && window.__hizStats.validation !== null && window.__hizStats.drawn > 0 ? window.__hizStats : undefined),
      null,
      { timeout: 120_000 },
    )
    const s = await stats.jsonValue()
    // THE CANVAS WIRING (the 197a lesson, GL-shaped): the stage's canvas
    // must BE the renderer's canvas — a live 'webgl2' context on the
    // displayed node. A fresh 2D-canvas blit target or an offscreen
    // present means the visible stage is dead.
    const wiring = await page.evaluate(() => {
      const el = document.querySelector('#hiz-canvas')
      if (el === null) return { wired: false, reason: 'no #hiz-canvas on the stage' }
      const ctx = el.getContext('webgl2')
      return { wired: ctx !== null && el.isConnected, reason: ctx === null ? 'the displayed canvas has no webgl2 context' : 'ok' }
    })
    const logText = await page.evaluate(() => document.querySelector('#log-list')?.textContent ?? '')
    const gpuClean = !/rendering stopped|frame error|GL error|failed/i.test(logText) && pageErrors.length === 0
    const drew = s.drawn > 0 && (s.occlusionCulled ?? 0) > 0
    console.log(
      `[task197] live: mode ${s.mode}, validation ${s.validation && s.validation.pass ? 'PASS' : 'FAIL'}, ` +
      `drawn ${s.drawn}/${s.total}, occluded ${s.occlusionCulled}, wiring ${wiring.wired ? 'ok' : wiring.reason}, log ${gpuClean ? 'clean' : 'DIRTY'}`,
    )
    if (!s.validation || !s.validation.pass) {
      const v = s.validation
      console.log(`  validation detail: pass=${v?.pass} errors=${v?.errors} cameras=${JSON.stringify((v?.cameras ?? []).map(c => ({ p: c.parity, ok: c.ok, drawnOn: c.drawnOn, drawnOff: c.drawnOff })))}`)
      failed = true
    }
    if (!wiring.wired) { console.log('  FAIL — the visible canvas is not the GL renderer canvas'); failed = true }
    if (!drew) { console.log('  FAIL — the live GL loop is not drawing/culling'); failed = true }
    if (!gpuClean) { console.log(`  the dirty log:\n${logText.slice(0, 1600)}`); failed = true }
    // the buffer size is the renderer's own CSS contract (resize at boot) —
    // a LIVE buffer is what matters, not the exact 960
    const bright = await page.evaluate(() => {
      const el = document.querySelector('#hiz-canvas')
      return el === null ? -1 : el.width
    })
    if (!(bright >= 100)) { console.log(`  FAIL — the canvas buffer is ${bright} — dead`); failed = true }
    await page.close()
  }
} catch (error) {
  console.error(`[task197] gate crashed: ${error instanceof Error ? error.message : String(error)}`)
  failed = true
} finally {
  await browser.close()
  server.stop()
}

console.log(failed ? '\nTASK 197 GL GATE: FAIL' : '\nTASK 197 GL GATE: PASS')
process.exit(failed ? 1 : 0)
