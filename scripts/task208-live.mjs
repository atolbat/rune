/**
 * scripts/task208-live.mjs — the LIVE gate: the deployed Pages site carries
 * Task 208 (the cross-frame seed — the bevy two-phase delta). Checks: the
 * occlusion page serves the ?v=208 cache-busts, the boot validation passes
 * on the live SwiftShader stack (the validation now carries the x-seed gate:
 * the fixed-point law, the fill collapse, the motion soundness), the stats
 * report the seed ON, and the report's own camera runs against the DEPLOYED
 * page (?bare=1 + the direct-drive channel): boot (Task-207 shape) vs seed
 * (the carry) with the buckets EXACT, the ON/OFF hash identical, and the
 * carry's cross-frame edge in the compiled graph.
 */
import { chromium } from 'playwright'

const BASE = 'https://atolbat.github.io/rune/demo/occlusion/'
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})

const errors = []
try {
  // ── 1. the served sources carry the Task-208 cache-busts ────────────────
  const mainSrc = await (await fetch(`${BASE}main.js`)).text()
  const tierSrc = await (await fetch(`${BASE}tier.js`)).text()
  const v208main = mainSrc.includes('tier.js?v=208') && /Task 208: THE CROSS-FRAME SEED/.test(mainSrc)
  const v208tier = tierSrc.includes('hiz-seed') && /THE CROSS-FRAME SEED/.test(tierSrc)
  console.log('[live] served main.js carries Task 208:', v208main ? 'yes' : 'NO')
  console.log('[live] served tier.js carries the seed resource:', v208tier ? 'yes' : 'NO')

  // ── 2. the boot validation on the live stack (the x-seed gate rides it) ─
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 160)}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`) })
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 45_000 })
  const stats = await page.waitForFunction(
    () => (window.__hizStats && window.__hizStats.validation !== null && window.__hizStats.drawn > 0 ? window.__hizStats : undefined),
    null,
    { timeout: 300_000 },
  ).then(h => h.jsonValue())
  const validation = stats?.validation?.pass === true
  const drawnOk = (stats?.drawn ?? 0) > 0 && (stats?.drawn ?? 0) < 2300
  const culled = (stats?.occlusionCulled ?? 0) > 0
  const feedbackOn = stats?.feedback === 1
  const seedOn = stats?.seed === 1
  console.log(`[live] validation: ${validation ? 'PASS' : 'FAIL'} · drawn ${stats?.drawn}/${stats?.total} · occluded ${stats?.occlusionCulled} · feedback ${feedbackOn ? 'ON' : 'OFF — FAIL'} · seed ${seedOn ? 'ON (the carry owns phase 1)' : 'OFF — FAIL'} (drawn <2300 required)`)
  await page.close()

  // ── 3. the report's camera on the DEPLOYED page — boot vs seed ─────────
  const page2 = await browser.newPage({ viewport: { width: 960, height: 720 } })
  page2.on('pageerror', (e) => errors.push(`bare pageerror: ${e.message.slice(0, 160)}`))
  await page2.goto(`${BASE}?bare=1`, { waitUntil: 'networkidle', timeout: 45_000 })
  await page2.waitForFunction(() => window.__hizTier !== null && window.__hizTier !== undefined, null, { timeout: 180_000 })
  await page2.evaluate(() => window.__hizCtl.pause())
  const report = await page2.evaluate(async () => {
    const tier = window.__hizTier
    const K = window.__hizStats.occluders
    const aspect = tier.aspect()
    const fov = Math.PI / 3 * Math.min(1.5, Math.max(1, (16 / 9) / aspect))
    const eye = [0, 5.5 + Math.sin(0.1) * 12, Math.cos(0.1) * 12]
    const center = [0, 5.5, 0]
    function lookAt(e, c) {
      let fx = c[0] - e[0], fy = c[1] - e[1], fz = c[2] - e[2]
      let l = Math.hypot(fx, fy, fz); fx /= l; fy /= l; fz /= l
      let rx = -fz, ry = 0, rz = fx
      l = Math.hypot(rx, ry, rz); rx /= l; ry /= l; rz /= l
      const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx
      return new Float32Array([rx, ux, -fx, 0, ry, uy, -fy, 0, rz, uz, -fz, 0,
        -(rx * e[0] + ry * e[1] + rz * e[2]), -(ux * e[0] + uy * e[1] + uz * e[2]), fx * e[0] + fy * e[1] + fz * e[2], 1])
    }
    function perspective() {
      const f = 1 / Math.tan(fov / 2)
      const near = 0.5, far = 300, nf = 1 / (near - far)
      return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far * nf, -1, 0, 0, far * near * nf, 0])
    }
    function mul(a, b) {
      const out = new Float32Array(16)
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        let s = 0
        for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]
        out[c * 4 + r] = s
      }
      return out
    }
    const mvp = mul(perspective(), lookAt(eye, center))
    // the 12-arg renderTo: (…, feedback, seed)
    async function run(hiz, feedback, seed, frames = 2) {
      for (let f = 0; f < frames; f++) tier.renderTo(tier.surface.targetId, mvp, eye, hiz, false, K, false, false, false, false, feedback, seed)
      return { s: await tier.readStats(), img: await tier.surface.read() }
    }
    const off = await run(0, false, false)
    const plain = await run(1, false, false) // the boot phase-1 pass set
    const boot = await run(1, true, false)   // the Task-207 shape
    const seed = await run(1, true, true, 4) // the carry, converged
    // the graph snapshot while the seed frame is still the last compiled one
    const graph = window.__fgDebug.last()
    let hash = r => { let h = 2166136261; for (let i = 0; i < r.img.data.length; i++) { h ^= r.img.data[i]; h = Math.imul(h, 16777619) } return h >>> 0 }
    return {
      plainDrawn: plain.s.drawn, bootDrawn: boot.s.drawn, seedDrawn: seed.s.drawn,
      bootOccluded: boot.s.occluded, seedOccluded: seed.s.occluded,
      seedParity: hash(seed) === hash(off), bootParity: hash(boot) === hash(off),
      fixedPoint: seed.s.drawn === boot.s.drawn && seed.s.occluded === boot.s.occluded,
      fillCut: plain.s.drawn > 0 ? +(plain.s.drawn / Math.max(1, seed.s.drawn)).toFixed(1) : 0,
      seedGated: graph !== null && graph.gated.includes('z-fill') && graph.gated.includes('pyramid-reduce') && !graph.live.includes('z-fill'),
      seedEdge: graph !== null && graph.edges.some(e => e.startsWith('import→cull-verdicts hiz-seed@')),
      seedStale: graph !== null ? (graph.stale['hiz-seed'] ?? -1) : -1,
    }
  })
  const closeOk = report.seedParity && report.bootParity && report.fixedPoint && report.seedDrawn < report.plainDrawn && report.seedGated && report.seedEdge && report.seedStale === 0
  console.log(`[live] the report's camera (dist 12, pitch 0.1): pass-set ${report.plainDrawn} → boot ${report.bootDrawn} → seed ${report.seedDrawn} (fill ×${report.fillCut} less) · fixed-point ${report.fixedPoint ? 'EXACT' : 'DRIFT'} · parity ${report.seedParity ? 'IDENTICAL' : 'DIFFERS'} · the frame gates the warm-up ${report.seedGated ? 'YES' : 'NO'} + the carry edge ${report.seedEdge ? 'EXISTS' : 'MISSING'} (${report.seedStale}f stale) ${closeOk ? '· the cross-frame seed is live' : '· FAIL'}`)
  await page2.close()

  const ok = v208main && v208tier && validation && drawnOk && culled && feedbackOn && seedOn && closeOk && errors.length === 0
  if (errors.length > 0) console.log('[live] errors:', errors.slice(0, 4))
  console.log(`[live] verdict: ${ok ? 'PASS — Task 208 is live (the cross-frame seed, proven on the deployed page)' : 'FAIL'}`)
  process.exit(ok ? 0 : 1)
} finally {
  await browser.close()
}
