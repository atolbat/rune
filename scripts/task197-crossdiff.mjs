// task197-crossdiff — WHAT exactly differs between the WG and GL images?
// The cross-tier hash gate says DIFFERS on all cameras while the cull
// numbers match — this dumps the byte-level diff: count, magnitude,
// positions, and the offending pixels' neighborhoods.
import { chromium } from 'playwright'

const root = '/home/z/my-project/rune'
const port = Number(process.env.XDIFF_PORT ?? 8192)
const server = Bun.serve({
  port,
  async fetch(request) {
    let pathname = decodeURIComponent(new URL(request.url).pathname)
    if (pathname.endsWith('/')) pathname += 'index.html'
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

const page = await browser.newPage({ viewport: { width: 500, height: 420 } })
page.on('pageerror', e => console.log(`[pageerror] ${String(e).slice(0, 300)}`))
await page.goto(`http://localhost:${port}/demo/occlusion/?probe=1`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__hizGate !== undefined, null, { timeout: 240_000 })

const diff = await page.evaluate(async () => {
  const { buildWgTier, buildGlTier } = await import('/demo/occlusion/main.js').catch(() => ({ buildWgTier: null, buildGlTier: null }))
  void buildWgTier; void buildGlTier
  return null
})
void diff

// drive the tiers directly through the page's own module graph is awkward;
// instead rebuild both tiers here via dynamic import of the tier modules.
const out = await page.evaluate(async () => {
  const tierMod = await import('/demo/occlusion/tier.js?v=199')
  const sceneMod = await import('/demo/occlusion/scene.js?v=199')
  const scene = sceneMod.createScene(16384)
  const shellStub = { log: { info() {}, event() {}, error() {}, warn() {} }, setBadge() {}, markReady() {}, slot: document.createElement('div') }
  const noteError = () => {}
  const deps = { scene, shell: shellStub, noteError, stage: document.createElement('div'), PROBE: true, FORCE_SNAPSHOT: false, attachControls() {}, pauseLoop() {}, resumeLoop() {} }

  const wg = await tierMod.buildTier({ ...deps, backend: 'webgpu' })
  const gl = await tierMod.buildTier({ ...deps, backend: 'webgl2' })
  const cameras = sceneMod.VAL_CAMERAS
  const report = []
  for (const cam of cameras) {
    const { eye, mvp } = sceneMod.cameraAt(cam.yaw, cam.pitch, cam.dist)
    const read = async tier => {
      tier.renderTo(tier.surface.targetId, mvp, eye, 1, false)
      const r = await tier.surface.read()
      return new Uint8Array(r.data)
    }
    const statsOf = async tier => {
      const s = await tier.readStats()
      return { drawn: s.drawn, occluded: s.occluded }
    }
    const a = await read(wg)
    const b = await read(gl)
    let count = 0, maxDelta = 0
    const samples = []
    for (let i = 0; i < a.length; i += 4) {
      let d = 0
      for (let c = 0; c < 4; c++) {
        const dd = Math.abs(a[i + c] - b[i + c])
        if (dd > d) d = dd
      }
      if (d > 0) {
        count++
        if (d > maxDelta) maxDelta = d
        if (samples.length < 12) {
          const p = i / 4
          samples.push({ x: p % 480, y: (p / 480) | 0, d, wg: [a[i], a[i + 1], a[i + 2]], gl: [b[i], b[i + 1], b[i + 2]] })
        }
      }
    }
    // also compare the culled counts
    const sWg = await wg.readStats()
    const sGl = await gl.readStats()
    report.push({ yaw: cam.yaw, pixels: a.length / 4, diffPixels: count, pct: +(100 * count / (a.length / 4)).toFixed(3), maxDelta, samples, wgDrawn: sWg.drawn, glDrawn: sGl.drawn, wgOccl: sWg.occluded, glOccl: sGl.occluded })
  }
  try { wg.dispose() } catch { /* dead */ }
  try { gl.dispose() } catch { /* dead */ }
  return report
})
for (const r of out) {
  console.log(`camera yaw ${r.yaw}: ${r.diffPixels}/${r.pixels} px differ (${r.pct}%) · maxByteDelta ${r.maxDelta} · drawn WG ${r.wgDrawn} / GL ${r.glDrawn} · occluded WG ${r.wgOccl} / GL ${r.glOccl}`)
  for (const s of r.samples) console.log(`  (${s.x},${s.y}) d=${s.d} wg=[${s.wg}] gl=[${s.gl}]`)
}
await browser.close()
server.stop()
