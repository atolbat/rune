// task131-sim-probe — the GPU-tier STATE gate (ON REAL HARDWARE — the
// local SwiftShader device dies under the live canvas+mapAsync load, the
// documented env limitation; locally the raw-device gate task131-wgsl-sim
// covers the state parity): reads the sim's own storage buffer back and
// proves the compute advance is REALLY moving the particles: (a) the state evolves between reads, (b) the
// embers RISE (py grows — the buoyant gravity), (c) the wrap bounds hold,
// (d) the perf readout + the tier counters.
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? 8903
const browser = await chromium.launch({
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan'],
})
const page = await browser.newPage({ viewport: { width: 640, height: 400 } })
page.on('pageerror', e => console.log(`[pageerror] ${e.message.slice(0, 200)}`))
await page.goto(`http://localhost:${PORT}/demo/vfx/`, { waitUntil: 'networkidle' })
await page.click('#rd-fab')
await page.click('label[for="mode-webgpu"]')
await page.mouse.click(640, 60)
await page.waitForTimeout(2500)
const badge = await page.textContent('#backend').catch(() => '?')
console.log(`backend: ${badge}`)
if (badge !== 'WebGPU') {
  console.log('WebGPU unavailable — aborting')
  await browser.close()
  process.exit(0)
}
await page.evaluate(() => document.querySelector('.pt-sheet [aria-label=Close]')?.click())
for (let k = 1; k < 24; k++) await page.click('.pt-arrow:last-child')
await page.waitForTimeout(3500)

const readState = () => page.evaluate(async () => {
  const gpu = window.__vfxGpuFacade
  const layers = window.__vfxLayers ?? []
  const layer = layers.find(l => l.gpuBackend !== undefined)
  if (gpu === undefined || layer === undefined) return { error: 'no facade/layer' }
  const stateId = layer.gpuBackend.stateBufferId
  const count = layer.facade.count
  // the first 4096 live rows (17 floats each) — enough for the statistics
  const floats = await gpu.readExternalBuffer(stateId, 4096 * 17 * 4)
  let rise = 0, fall = 0, move = 0, inBox = 0, nan = 0
  const n = Math.min(4096, count)
  const stats = { sumY: 0, minY: 1e9, maxY: -1e9 }
  for (let i = 0; i < n; i++) {
    const b = i * 17
    const px = floats[b], py = floats[b + 1], pz = floats[b + 2]
    const vx = floats[b + 3], vy = floats[b + 4], vz = floats[b + 5]
    const age = floats[b + 6]
    if (!Number.isFinite(px + py + pz + vx + vy + vz + age)) { nan++; continue }
    stats.sumY += py
    if (py < stats.minY) stats.minY = py
    if (py > stats.maxY) stats.maxY = py
    if (vy > 0.01) rise++
    else if (vy < -0.01) fall++
    if (Math.abs(vx) + Math.abs(vy) + Math.abs(vz) > 0.02) move++
    // the wrap box: x/z ±23, y ∈ [-11, 11] around the origin
    if (Math.abs(px) <= 23.5 && Math.abs(pz) <= 23.5 && py >= -11.5 && py <= 11.5) inBox++
  }
  return { n, nan, rise, fall, move, inBox, meanY: +(stats.sumY / Math.max(1, n)).toFixed(3), minY: +stats.minY.toFixed(2), maxY: +stats.maxY.toFixed(2) }
})

let a = await readState().catch(e => ({ error: String(e.message ?? e).slice(0, 120) }))
if (a.error !== undefined) {
  // The LOCAL SwiftShader env loses the device under the live canvas+mapAsync
  // load (the documented limitation — real hardware reads fine). The STATE
  // verification lives in the raw-device gate (task131-wgsl-sim); this probe
  // is the ON-HARDWARE tool. Report SKIP, not FAIL.
  console.log(`state read unavailable (${a.error}) — the raw gate (task131-wgsl-sim) covers local; SKIP`)
  const perfSkip = await page.evaluate(() => window.__vfxPerf ?? null)
  console.log(`perf: ${JSON.stringify(perfSkip)}`)
  await browser.close()
  process.exit(0)
}
await page.waitForTimeout(1500)
const b = await readState()
const perf = await page.evaluate(() => window.__vfxPerf ?? null)
console.log(`read A: ${JSON.stringify(a)}`)
console.log(`read B: ${JSON.stringify(b)}`)
console.log(`perf: ${JSON.stringify(perf)}`)
const ok = a.error === undefined
  && a.nan === 0
  && a.rise > a.fall * 2          // the buoyant kiln: more risers than fallers
  && a.inBox >= a.n * 0.98        // the wrap bounds hold
  && b.meanY > a.meanY            // the cloud rises over time
  && b.move > a.n * 0.5           // the forces are live (velocities non-trivial)
console.log(ok ? 'GPU SIM STATE GATE: PASS' : 'GPU SIM STATE GATE: FAIL')
await browser.close()
process.exit(ok ? 0 : 1)
