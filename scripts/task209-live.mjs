/**
 * scripts/task209-live.mjs — the LIVE gate: the deployed Pages site carries
 * Task 209 (the parallel compact + the near-first order). Checks: the
 * occlusion page serves the ?v=209 cache-busts, the boot validation passes
 * on the live SwiftShader stack (the validation now carries the order gate:
 * the JS-oracle identity, the sortedness, the parity, the fold's carry),
 * and the report's own camera runs against the DEPLOYED page (?bare=1 +
 * the direct-drive channel): the compact's list vs the JS oracle, the
 * ordered list's sortedness + set, and the order-ON/OFF pixel parity.
 */
import { chromium } from 'playwright'

const BASE = 'https://atolbat.github.io/rune/demo/occlusion/'
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})

const errors = []
try {
  // ── 1. the served sources carry the Task-209 cache-busts ────────────────
  const mainSrc = await (await fetch(`${BASE}main.js`)).text()
  const tierSrc = await (await fetch(`${BASE}tier.js`)).text()
  const htmlSrc = await (await fetch(BASE)).text()
  const v209main = mainSrc.includes('tier.js?v=209') && /THE PARALLEL COMPACT \+ NEAR-FIRST ORDER/.test(mainSrc)
  const v209tier = tierSrc.includes("dist/rune.esm.js?v=209") && tierSrc.includes('readList') && /the near-first order/.test(tierSrc)
  const v209html = htmlSrc.includes('main.js?v=209')
  console.log('[live] served main.js carries Task 209:', v209main ? 'yes' : 'NO')
  console.log('[live] served tier.js carries the order + readList:', v209tier ? 'yes' : 'NO')
  console.log('[live] served index.html carries the ?v=209 mark:', v209html ? 'yes' : 'NO')

  // ── 2. the boot validation on the live stack (the order gate rides it) ─
  // THE STEADY-STATE SAMPLING LAW (the Task-208b finding, unchanged): the
  // boot validation ends at a validation camera, the loop starts at the
  // orbit — the cut's one-frame promotion bill must not fool the gate.
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 160)}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`) })
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 45_000 })
  const stats = await page.waitForFunction(
    () => (window.__hizStats && window.__hizStats.validation !== null && window.__hizStats.drawn > 0 && window.__hizStats.drawn < 2300 ? window.__hizStats : undefined),
    null,
    { timeout: 300_000 },
  ).then(h => h.jsonValue())
  const validation = stats?.validation?.pass === true
  const drawnOk = (stats?.drawn ?? 0) > 0 && (stats?.drawn ?? 0) < 2300
  const culled = (stats?.occlusionCulled ?? 0) > 0
  const feedbackOn = stats?.feedback === 1
  const seedOn = stats?.seed === 1
  console.log(`[live] validation: ${validation ? 'PASS' : 'FAIL'} · drawn ${stats?.drawn}/${stats?.total} · occluded ${stats?.occlusionCulled} · feedback ${feedbackOn ? 'ON' : 'OFF — FAIL'} · seed ${seedOn ? 'ON' : 'OFF — FAIL'} (drawn <2300 required)`)
  await page.close()

  // ── 3. the report's camera on the DEPLOYED page — the order's own laws ─
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
    // the 13-arg renderTo: (…, feedback, seed, order)
    async function run(order, frames = 2) {
      for (let f = 0; f < frames; f++) tier.renderTo(tier.surface.targetId, mvp, eye, 1, false, K, false, false, false, false, true, true, order)
      return { s: await tier.readStats(), img: await tier.surface.read(), list: await tier.readList() }
    }
    // THE SETTLE DISCIPLINE (the 208b law): converge the carry HERE first
    for (let f = 0; f < 2; f++) tier.renderTo(tier.surface.targetId, mvp, eye, 1, false, K, false, false, false, false, true, true, true)
    const unordered = await run(false)
    const ordered = await run(true)
    let hash = r => { let h = 2166136261; for (let i = 0; i < r.img.data.length; i++) { h ^= r.img.data[i]; h = Math.imul(h, 16777619) } return h >>> 0 }
    // the JS oracle over the compact's own source words
    const lr = unordered.list
    const N = lr.verdicts.length
    const oracle = []
    for (let i = 0; i < N; i++) {
      const f = lr.verdicts[i] & 0xFF
      if (f === 1 || f === 4) oracle.push(i)
    }
    const identity = oracle.length === lr.drawn && oracle.every((rec, k) => lr.list[k] === rec)
    const on = ordered.list
    const listSorted = Array.from(on.list.slice(0, on.drawn)).sort((a, b) => a - b)
    const onOracle = []
    for (let i = 0; i < N; i++) {
      const f = on.verdicts[i] & 0xFF
      if (f === 1 || f === 4) onOracle.push(i)
    }
    const setIdentity = onOracle.length === on.drawn && listSorted.every((rec, k) => onOracle[k] === rec)
    const bkt = rec => (on.verdicts[rec] >> 16) & 0xFF
    let sortedOk = true
    for (let k = 0; k + 1 < on.drawn; k++) {
      const a = on.list[k], b = on.list[k + 1]
      if (bkt(a) > bkt(b) || (bkt(a) === bkt(b) && a > b)) { sortedOk = false; break }
    }
    let bucketNonZero = 0
    for (const rec of onOracle) if (bkt(rec) > 0) bucketNonZero++
    const graph = window.__fgDebug.last()
    return {
      drawnU: unordered.s.drawn, drawnO: ordered.s.drawn,
      identity, setIdentity, sortedOk, bucketNonZero,
      parity: hash(ordered) === hash(unordered),
      colorLive: graph !== null && graph.live.includes('color'),
      passDelta: graph !== null ? `${graph.live.length} live / ${graph.gated.length} gated` : 'n/a',
    }
  })
  const closeOk = report.identity && report.setIdentity && report.sortedOk && report.parity && report.drawnU === report.drawnO && report.bucketNonZero > 0 && report.colorLive
  console.log(`[live] the report's camera (dist 12, pitch 0.1): the compact's list vs the JS oracle ${report.identity ? 'IDENTICAL' : 'BROKEN'} (${report.drawnU} records) · the ordered set ${report.setIdentity ? 'EXACT' : 'BROKEN'} · sortedness ${report.sortedOk ? 'EXACT' : 'BROKEN'} (${report.bucketNonZero} nonzero buckets) · drawn ${report.drawnU}=${report.drawnO} · parity order-ON vs OFF ${report.parity ? 'IDENTICAL' : 'DIFFERS'} · the frame ${report.passDelta}, color ${report.colorLive ? 'LIVE' : 'MISSING'} ${closeOk ? '· the near-first order is live' : '· FAIL'}`)
  await page2.close()

  const ok = v209main && v209tier && v209html && validation && drawnOk && culled && feedbackOn && seedOn && closeOk && errors.length === 0
  if (errors.length > 0) console.log('[live] errors:', errors.slice(0, 4))
  console.log(`[live] verdict: ${ok ? 'PASS — Task 209 is live (the parallel compact + the near-first order, proven on the deployed page)' : 'FAIL'}`)
  process.exit(ok ? 0 : 1)
} finally {
  await browser.close()
}
