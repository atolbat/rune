// task196-hiz — THE Hi-Z OCCLUSION CULLING LIVE GATE (Task 196).
//
// The demo page boots the REAL facade through the dist bundle on the
// container's WebGPU stack (SwiftShader + Vulkan) in ?probe=1 mode: the
// validation only — the pixel parity of Hi-Z ON vs OFF over three cameras,
// the accounting invariant, the culling effect — with ZERO canvas presents
// (the page never binds target 0 in probe mode; the documented Task-175
// present-death makes the canvas channel vacuous in this container).
//
// THE VERDICT (window.__hizGate):
//   · pixel parity ON vs OFF — sha256 IDENTICAL per camera (opaque +
//     depth-tested rendering is order-independent: culling occluded boxes
//     cannot change a pixel);
//   · the accounting invariant — frustum + occluded + drawn === occludees
//     (both modes: every instance lands in exactly one bucket);
//   · the effect — drawn(ON) < drawn(OFF) and occlusionCulled > 0;
//   · zero onGpuError entries (the new contracts — texture slots in the
//     compute family, drawIndexedIndirect, the r32float target-format
//     pipeline variants — validated by the real stack, not just mocks).
//
// Exit 0 — the Hi-Z tier is live-verified; 1 — it broke.
// Usage: bun scripts/task196-hiz.mjs
import { chromium } from 'playwright'

const root = '/home/z/my-project/rune'
const port = Number(process.env.TASK196_PORT ?? 8187)

const server = Bun.serve({
  port,
  async fetch(request) {
    let pathname = decodeURIComponent(new URL(request.url).pathname)
    if (pathname.endsWith('/')) pathname += 'index.html' // the demo folder URLs
    const file = Bun.file(`${root}${pathname}`)
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    return new Response(await file.arrayBuffer(), {
      headers: { 'content-type': pathname.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8' },
    })
  },
})

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})

let failed = false
try {
  const page = await browser.newPage({ viewport: { width: 500, height: 420 } })
  const pageErrors = []
  page.on('pageerror', e => pageErrors.push(String(e)))
  await page.goto(`http://localhost:${port}/demo/occlusion/?probe=1`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForFunction(() => window.__hizGate !== undefined, null, { timeout: 180_000 })
  const gate = await page.evaluate(() => window.__hizGate)
  const stats = await page.evaluate(() => window.__hizStats)

  if (gate.bootFail !== undefined) {
    console.log(`[task196] BOOT FAILED on the WG stack: ${String(gate.bootFail).slice(0, 300)}`)
    failed = true
  } else {
    console.log(`[task196] scene: ${stats.total} instances (${stats.occluders} occluders, ${stats.occludees} occludees), Hi-Z ${stats.hizW}x${stats.hizH} · ${stats.levels} mips`)
    console.log(`[task196] GPU errors: ${gate.errors}${gate.errors > 0 ? '' : ' (zero — the new contracts ride the real stack)'}`)
    if (gate.errors > 0) failed = true
    if (pageErrors.length > 0) {
      console.log(`[task196] page errors: ${pageErrors.length} — ${pageErrors.slice(0, 3).join(' | ').slice(0, 300)}`)
      failed = true
    }

    let camIdx = 0
    for (const cam of gate.cameras) {
      camIdx++
      console.log(`  camera ${camIdx} (yaw ${cam.yaw.toFixed(2)}): parity ${cam.parity} (${String(cam.hashOn).slice(0, 12)}) · drawn ON ${cam.drawnOn} / OFF ${cam.drawnOff} (${(100 * (1 - cam.drawnOn / cam.drawnOff)).toFixed(1)}% culled) · frustum ${cam.frustumOn} · occluded ${cam.occludedOn} · straddle ${cam.straddleOn}`)
      if (cam.parity !== 'IDENTICAL') {
        console.log(`  FAIL — the pixel parity diverged (${cam.hashOn} vs ${cam.hashOff}): Hi-Z culled a visible box`)
        failed = true
      }
      // Task 201 — the 'hysteresis' leg: drawnOn === drawnOff at saturation
      // is the POINT (the saturated streaks reproduce the raw buckets; the
      // decay observation rides drawnDecay). The plain/city legs keep the
      // strict invariant + culling checks.
      if (cam.policy === 'hysteresis') {
        if (cam.drawnOn !== cam.drawnOff) {
          console.log(`  FAIL — the saturated hysteresis must reproduce the raw buckets (${cam.drawnOn} vs ${cam.drawnOff})`)
          failed = true
        }
        if (!(cam.drawnDecay > cam.drawnOff)) {
          console.log(`  FAIL — the hysteresis decay did not show (${cam.drawnDecay} vs ${cam.drawnOff})`)
          failed = true
        }
      } else {
        if (!cam.invariantOn || !cam.invariantOff) {
          console.log(`  FAIL — the accounting invariant broke (frustum + occluded + drawn must equal ${stats.occludees})`)
          failed = true
        }
        if (!(cam.drawnOn < cam.drawnOff) || cam.occludedOn <= 0) {
          console.log('  FAIL — the occlusion tier is not culling anything')
          failed = true
        }
      }
    }
    console.log(`[task196] verdict: ${gate.pass ? 'PASS' : 'FAIL'} — the Hi-Z pipeline (z prepass → pyramid → cull+compact → drawIndexedIndirect) on the real facade`)
    if (!gate.pass) failed = true
  }
} catch (error) {
  console.error(`[task196] gate crashed: ${error instanceof Error ? error.message : String(error)}`)
  failed = true
} finally {
  await browser.close()
  server.stop()
}

console.log(failed ? '\nTASK 196 Hi-Z GATE: FAIL' : '\nTASK 196 Hi-Z GATE: PASS')
process.exit(failed ? 1 : 0)
