/**
 * scripts/task206-live.mjs — the LIVE gate: the deployed Pages site carries
 * Task 206 (the close-camera round). Checks: the occlusion page serves the
 * ?v=206 cache-busts (main.js + the tier's shaders.js import — both files
 * changed), the boot validation passes on the live SwiftShader stack, the
 * drawn count reflects the clip-space fix + the fine pass (the Task-205
 * live gate read 4388 on the same default orbit — 206 must sit well under
 * 3000), and the close-camera reproduction itself runs against the DEPLOYED
 * page (?bare=1 + the direct-drive channel) with the ON/OFF hash identical.
 */
import { chromium } from 'playwright'

const BASE = 'https://atolbat.github.io/rune/demo/occlusion/'
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})

const errors = []
try {
  // ── 1. the served sources carry the Task-206 cache-busts ────────────────
  const mainSrc = await (await fetch(`${BASE}main.js`)).text()
  const tierSrc = await (await fetch(`${BASE}tier.js`)).text()
  const v206main = mainSrc.includes('rune.esm.js?v=205') && /Task 206: THE CLOSE-CAMERA ROUND/.test(mainSrc)
  const v206shaders = tierSrc.includes('shaders.js?v=206')
  console.log('[live] served main.js carries Task 206:', v206main ? 'yes' : 'NO')
  console.log('[live] served tier.js imports shaders.js?v=206:', v206shaders ? 'yes' : 'NO')

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
  const drawnOk = (stats?.drawn ?? 0) > 0 && (stats?.drawn ?? 0) < 3000 // Task-205 live read 4388 on the same orbit
  const culled = (stats?.occlusionCulled ?? 0) > 0
  console.log(`[live] validation: ${validation ? 'PASS' : 'FAIL'} · drawn ${stats?.drawn}/${stats?.total} · occluded ${stats?.occlusionCulled} (the fix+fine pass: <3000 required)`)

  // ── 3. the close-camera reproduction on the DEPLOYED page ───────────────
  const page2 = await browser.newPage({ viewport: { width: 960, height: 720 } })
  page2.on('pageerror', (e) => errors.push(`bare pageerror: ${e.message.slice(0, 160)}`))
  await page2.goto(`${BASE}?bare=1`, { waitUntil: 'networkidle', timeout: 45_000 })
  await page2.waitForFunction(() => window.__hizTier !== null && window.__hizTier !== undefined, null, { timeout: 180_000 })
  await page2.evaluate(() => window.__hizCtl.pause())
  const close = await page2.evaluate(async () => {
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
    async function run(hiz, occluders) {
      for (let f = 0; f < 2; f++) tier.renderTo(tier.surface.targetId, mvp, eye, hiz, false, occluders, false, false, false, false)
      return { s: await tier.readStats(), img: await tier.surface.read() }
    }
    const on = await run(1, N)
    const off = await run(0, N)
    let h1 = 2166136261, h0 = 2166136261
    for (let i = 0; i < on.img.data.length; i++) { h1 ^= on.img.data[i]; h1 = Math.imul(h1, 16777619) }
    for (let i = 0; i < off.img.data.length; i++) { h0 ^= off.img.data[i]; h0 = Math.imul(h0, 16777619) }
    return { drawn: on.s.drawn, straddle: on.s.straddle, frustum: on.s.frustum, parity: (h1 >>> 0) === (h0 >>> 0) }
  })
  const closeOk = close.parity && close.drawn < 800 && close.straddle <= 4
  console.log(`[live] close-camera (city-occludes, dist 12): drawn ${close.drawn} · straddle ${close.straddle} · ON/OFF ${close.parity ? 'IDENTICAL' : 'DIFFERS'} ${closeOk ? '· the fix is live' : '· FAIL'}`)
  await page2.close()

  const ok = v206main && v206shaders && validation && drawnOk && culled && closeOk && errors.length === 0
  if (errors.length > 0) console.log('[live] errors:', errors.slice(0, 4))
  console.log(`[live] verdict: ${ok ? 'PASS — Task 206 is live (the close-camera round, proven on the deployed page)' : 'FAIL'}`)
  process.exit(ok ? 0 : 1)
} finally {
  await browser.close()
}
