/**
 * scripts/task207-live.mjs — the LIVE gate: the deployed Pages site carries
 * Task 207 (the same-frame feedback). Checks: the occlusion page serves the
 * ?v=207 cache-busts (main.js + tier.js's shaders import + the dist import),
 * the boot validation passes on the live SwiftShader stack with the feedback
 * branch asserted in the compiled graph, the drawn count reflects the
 * same-frame feedback ON by default (the Task-206 live gate read 2391 on the
 * same orbit — 207 must sit well under 2300), and the field report's own
 * camera runs against the DEPLOYED page (?bare=1 + the direct-drive channel):
 * plain vs feedback vs the brute city fill, with the ON/OFF hash identical.
 */
import { chromium } from 'playwright'

const BASE = 'https://atolbat.github.io/rune/demo/occlusion/'
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})

const errors = []
try {
  // ── 1. the served sources carry the Task-207 cache-busts ────────────────
  const mainSrc = await (await fetch(`${BASE}main.js`)).text()
  const tierSrc = await (await fetch(`${BASE}tier.js`)).text()
  const v207main = mainSrc.includes('tier.js?v=207') && /Task 207: THE SAME-FRAME FEEDBACK/.test(mainSrc)
  const v207tier = tierSrc.includes('shaders.js?v=207') && tierSrc.includes('rune.esm.js?v=207')
  const v207dist = mainSrc.includes('rune.esm.js?v=207')
  console.log('[live] served main.js carries Task 207:', v207main ? 'yes' : 'NO')
  console.log('[live] served tier.js carries shaders?v=207 + dist?v=207:', v207tier ? 'yes' : 'NO')
  console.log('[live] served main.js imports dist?v=207:', v207dist ? 'yes' : 'NO')

  // ── 2. the boot validation on the live stack ────────────────────────────
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
  const drawnOk = (stats?.drawn ?? 0) > 0 && (stats?.drawn ?? 0) < 2300 // Task-206 live read 2391 on the same orbit
  const culled = (stats?.occlusionCulled ?? 0) > 0
  const feedbackOn = stats?.feedback === 1
  console.log(`[live] validation: ${validation ? 'PASS' : 'FAIL'} · drawn ${stats?.drawn}/${stats?.total} · occluded ${stats?.occlusionCulled} · feedback ${feedbackOn ? 'ON (the boot default)' : 'OFF — FAIL'} (drawn <2300 required)`)

  // ── 3. the field report's camera on the DEPLOYED page ──────────────────
  const page2 = await browser.newPage({ viewport: { width: 960, height: 720 } })
  page2.on('pageerror', (e) => errors.push(`bare pageerror: ${e.message.slice(0, 160)}`))
  await page2.goto(`${BASE}?bare=1`, { waitUntil: 'networkidle', timeout: 45_000 })
  await page2.waitForFunction(() => window.__hizTier !== null && window.__hizTier !== undefined, null, { timeout: 180_000 })
  await page2.evaluate(() => window.__hizCtl.pause())
  const report = await page2.evaluate(async () => {
    const tier = window.__hizTier
    const K = window.__hizStats.occluders
    const N = window.__hizStats.total
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
    async function run(hiz, occluders, feedback) {
      for (let f = 0; f < 2; f++) tier.renderTo(tier.surface.targetId, mvp, eye, hiz, false, occluders, false, false, false, false, feedback)
      return { s: await tier.readStats(), img: await tier.surface.read() }
    }
    const off = await run(0, K, false)
    const plain = await run(1, K, false)
    const fb = await run(1, K, true)
    const city = await run(1, N, false)
    let hash = r => { let h = 2166136261; for (let i = 0; i < r.img.data.length; i++) { h ^= r.img.data[i]; h = Math.imul(h, 16777619) } return h >>> 0 }
    const graph = window.__fgDebug.last()
    return {
      plainDrawn: plain.s.drawn, fbDrawn: fb.s.drawn, cityDrawn: city.s.drawn,
      fbOccluded: fb.s.occluded, plainOccluded: plain.s.occluded,
      fbParity: hash(fb) === hash(off), plainParity: hash(plain) === hash(off),
      fbChainLive: graph !== null && graph.live.includes('feedback-fill') && graph.live.includes('cull-verdicts-2'),
      fbEdge: graph !== null && graph.edges.some(e => e.startsWith('cull-verdicts→feedback-fill scene@')),
    }
  })
  const closeOk = report.fbParity && report.plainParity && report.fbDrawn <= report.cityDrawn + 40 && report.fbDrawn < report.plainDrawn && report.fbChainLive && report.fbEdge
  console.log(`[live] the report's camera (dist 12, pitch 0.1): drawn plain ${report.plainDrawn} → feedback ${report.fbDrawn} (the brute city fill ${report.cityDrawn}) · occluded ${report.plainOccluded} → ${report.fbOccluded} · ON/OFF parity ${report.fbParity ? 'IDENTICAL' : 'DIFFERS'} · the graph chain ${report.fbChainLive ? 'LIVE' : 'MISSING'} + the version edge ${report.fbEdge ? 'EXISTS' : 'MISSING'} ${closeOk ? '· the same-frame feedback is live' : '· FAIL'}`)
  await page2.close()

  const ok = v207main && v207tier && v207dist && validation && drawnOk && culled && feedbackOn && closeOk && errors.length === 0
  if (errors.length > 0) console.log('[live] errors:', errors.slice(0, 4))
  console.log(`[live] verdict: ${ok ? 'PASS — Task 207 is live (the same-frame feedback, proven on the deployed page)' : 'FAIL'}`)
  process.exit(ok ? 0 : 1)
} finally {
  await browser.close()
}
