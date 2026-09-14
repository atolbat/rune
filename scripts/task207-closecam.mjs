/**
 * scripts/task207-closecam.mjs — Task 207: THE SAME-FRAME FEEDBACK ROUND.
 *
 * «основная проблема в том, что цветные боксы все еще не окклюдят задние
 * цветные боксы. ...когда ты ставишь камеру смотреть параллельно плоскости
 * так, чтобы один из боксов был вплотную близко к камере, и куча боксов за
 * ним, то они будто все равно рисуются. Вот, например, за серыми большими
 * параллелепипедами они не рисуются.» — the colored city must occlude
 * ITSELF, by default, at the close/along-the-plane cameras.
 *
 * The direct-drive law (the ?bare=1 boot): no boot validation, the rAF loop
 * pauses, THIS script owns the frame. Legs per camera:
 *   · plain    — feedback OFF (the Task-206 shape: only the K gray walls)
 *   · feedback — ON (the Task-207 same-frame two-pass HZB)
 *   · city     — the brute all-N fill (the Task-199 experiment, the bound)
 *   and the ON/OFF pixel hash for every leg (a culled box must never cost
 * a pixel — the feedback's own soundness proof, headless).
 *
 * Usage: bun run scripts/task207-closecam.mjs [webgl2]
 */
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const MODE_ARG = process.argv[2] === 'webgl2' ? 'webgl2' : 'webgpu'

const root = resolve(import.meta.dirname, '..')
const port = 8147
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}
const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url)
    let pathname = decodeURIComponent(url.pathname)
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = Bun.file(join(root, pathname))
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    const ext = pathname.slice(pathname.lastIndexOf('.'))
    return new Response(file, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
  const pageErrors = []
  page.on('pageerror', e => pageErrors.push(String(e)))
  await page.goto(`http://localhost:${port}/demo/occlusion/?bare=1${MODE_ARG === 'webgl2' ? '&mode=webgl2' : ''}`, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => window.__hizTier !== null && window.__hizTier !== undefined, null, { timeout: 180_000 })
  await page.evaluate(() => window.__hizCtl.pause())
  const bootMode = await page.evaluate(() => ({ mode: window.__hizStats.mode, kind: window.__hizTier.kind, total: window.__hizStats.total, feedback: window.__hizStats.feedback }))
  console.log(`[boot] ${JSON.stringify(bootMode)} · the loop is paused, the probe owns the frame`)

  /** One config at one camera: frames × renderTo, then stats + coverage + hash. */
  const drive = config => page.evaluate(async cfg => {
    const tier = window.__hizTier
    const t0 = performance.now()
    // the scene.js camera math, inlined (the same formulas, the same f32)
    const aspect = tier.aspect()
    const fov = Math.PI / 3 * Math.min(1.5, Math.max(1, (16 / 9) / aspect))
    const eye = [
      Math.cos(cfg.pitch) * Math.sin(cfg.yaw) * cfg.dist,
      5.5 + Math.sin(cfg.pitch) * cfg.dist,
      Math.cos(cfg.pitch) * Math.cos(cfg.yaw) * cfg.dist,
    ]
    const center = [0, 5.5, 0]
    function lookAt(e, c) {
      let fx = c[0] - e[0], fy = c[1] - e[1], fz = c[2] - e[2]
      let l = Math.hypot(fx, fy, fz); fx /= l; fy /= l; fz /= l
      let rx = fy * 0 - fz * 1, ry = fz * 0 - fx * 0, rz = fx * 1 - fy * 0
      l = Math.hypot(rx, ry, rz); rx /= l; ry /= l; rz /= l
      const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx
      return new Float32Array([
        rx, ux, -fx, 0, ry, uy, -fy, 0, rz, uz, -fz, 0,
        -(rx * e[0] + ry * e[1] + rz * e[2]),
        -(ux * e[0] + uy * e[1] + uz * e[2]),
        fx * e[0] + fy * e[1] + fz * e[2], 1,
      ])
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
    for (let f = 0; f < cfg.frames; f++) {
      tier.renderTo(tier.surface.targetId, mvp, eye, cfg.hiz, false, cfg.occluders, cfg.hysteresis === true, cfg.history === true, false, false, cfg.feedback !== false)
    }
    const s = await tier.readStats()
    const img = await tier.surface.read()
    let h = 2166136261
    for (let i = 0; i < img.data.length; i++) {
      h ^= img.data[i]
      h = Math.imul(h, 16777619)
    }
    let nonSky = 0
    const n = img.data.length / 4
    for (let i = 0; i < n; i++) {
      const r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2]
      if (r > 26 || g > 30 || b > 44) nonSky++
    }
    return {
      stats: s,
      coverage: +(100 * nonSky / n).toFixed(1),
      hash: (h >>> 0).toString(16),
      eye: eye.map(v => +v.toFixed(2)),
      ms: +(performance.now() - t0).toFixed(0),
    }
  }, config)

  const N = await page.evaluate(() => window.__hizStats.total)
  const K = await page.evaluate(() => window.__hizStats.occluders)
  console.log(`[scene] N=${N} records, K=${K} occluders`)

  // ── 1. the report's camera scan (dist 12 — the wheel floor; pitch near
  //      zero = looking ALONG the city plane, the near boxes huge on screen)
  console.log('\n[scan] the report\'s cameras — plain (feedback OFF) vs feedback (ON) vs the brute city fill; parity vs the Hi-Z-OFF frame')
  const cams = [[0, 0.1], [0, -0.05], [0.4, -0.15], [1.57, -0.15], [3.14, -0.15], [0.8, 0.05]]
  const rows = []
  for (const [yaw, pitch] of cams) {
    const off = await drive({ yaw, pitch, dist: 12, frames: 2, hiz: 0, occluders: K, feedback: false })
    const plain = await drive({ yaw, pitch, dist: 12, frames: 2, hiz: 1, occluders: K, feedback: false })
    const fb = await drive({ yaw, pitch, dist: 12, frames: 2, hiz: 1, occluders: K, feedback: true })
    const city = await drive({ yaw, pitch, dist: 12, frames: 2, hiz: 1, occluders: N, feedback: false })
    const r = {
      yaw, pitch,
      plain: plain.stats.drawn, feedback: fb.stats.drawn, city: city.stats.drawn,
      plainParity: plain.hash === off.hash ? 'IDENTICAL' : 'DIFFERS',
      fbParity: fb.hash === off.hash ? 'IDENTICAL' : 'DIFFERS',
      occludedPlain: plain.stats.occluded, occludedFb: fb.stats.occluded, occludedCity: city.stats.occluded,
      coverage: fb.coverage,
    }
    rows.push(r)
    console.log(`  yaw ${yaw.toFixed(2)} pitch ${pitch.toFixed(2)}: drawn plain ${r.plain} → feedback ${r.feedback} (city ${r.city}) · occluded ${r.occludedPlain} → ${r.occludedFb} (${r.occludedCity}) · parity plain ${r.plainParity} · feedback ${r.fbParity} · coverage ${r.coverage}%`)
  }
  const fbParityFails = rows.filter(r => r.fbParity !== 'IDENTICAL')
  const plainParityFails = rows.filter(r => r.plainParity !== 'IDENTICAL')
  console.log(`[scan] pixel parity: plain ${plainParityFails.length === 0 ? 'ALL IDENTICAL' : `${plainParityFails.length} DIFFERS`} · feedback ${fbParityFails.length === 0 ? 'ALL IDENTICAL (' + rows.length + '/' + rows.length + ')' : `${fbParityFails.length} DIFFERS — a feedback-culled box cost a pixel`}`)
  const worst = rows.reduce((a, b) => (b.plain - b.feedback) > (a.plain - a.feedback) ? b : a, rows[0])
  console.log(`[scan] the biggest self-occlusion win: yaw ${worst.yaw} pitch ${worst.pitch} — plain ${worst.plain} → feedback ${worst.feedback} (−${worst.plain - worst.feedback} boxes, the colored city occluding itself)`)

  // ── 2. the policy matrix at the report's own camera (yaw 0, pitch 0.1) ──
  console.log('\n[matrix] the policy matrix at yaw 0 pitch 0.1 dist 12 (the Task-206 guilty camera)')
  const matrix = [
    { name: 'A. plain K walls (feedback OFF)', cfg: { occluders: K, hiz: 1, feedback: false, history: false } },
    { name: 'B. SAME-FRAME FEEDBACK (the fix)', cfg: { occluders: K, hiz: 1, feedback: true, history: false } },
    { name: 'C. brute city fill (occluders=N)', cfg: { occluders: N, hiz: 1, feedback: false, history: false } },
    { name: 'D. feedback + history (composed)', cfg: { occluders: K, hiz: 1, feedback: true, history: true } },
    { name: 'E. Hi-Z OFF (frustum only)', cfg: { occluders: K, hiz: 0, feedback: false, history: false } },
  ]
  for (const m of matrix) {
    const r = await drive({ yaw: 0, pitch: 0.1, dist: 12, frames: m.cfg.history ? 4 : 2, ...m.cfg })
    console.log(`  ${m.name}: drawn ${r.stats.drawn} · occluded ${r.stats.occluded} · frustum ${r.stats.frustum} · straddle ${r.stats.straddle} · coverage ${r.coverage}% · ${r.ms}ms`)
  }

  // ── 3. the default far view (the orbit camera — the live page's shape) ──
  const farOff = await drive({ yaw: 0.9, pitch: 0.3, dist: 38, frames: 2, hiz: 0, occluders: K, feedback: false })
  const farPlain = await drive({ yaw: 0.9, pitch: 0.3, dist: 38, frames: 2, hiz: 1, occluders: K, feedback: false })
  const farFb = await drive({ yaw: 0.9, pitch: 0.3, dist: 38, frames: 2, hiz: 1, occluders: K, feedback: true })
  console.log(`\n[reference] the default orbit view (yaw 0.9 pitch 0.3 dist 38): drawn plain ${farPlain.stats.drawn} → feedback ${farFb.stats.drawn} · occluded ${farPlain.stats.occluded} → ${farFb.stats.occluded} · parity ${farFb.hash === farOff.hash ? 'IDENTICAL' : 'DIFFERS'}`)

  // ── 4. the frame graph's own verdict (the same-frame chain, live) ───────
  const graph = await page.evaluate(() => window.__fgDebug.last())
  const fbChain = graph !== null && graph.live.includes('feedback-fill') && graph.live.includes('pyramid-reduce-2') && graph.live.includes('cull-verdicts-2')
  const fbEdge = graph !== null && graph.edges.some(e => e.startsWith('cull-verdicts→feedback-fill scene@'))
  const foldEdge = graph !== null && graph.edges.some(e => e.startsWith('cull-verdicts-2→hysteresis scene@'))
  console.log(`\n[graph] the same-frame chain on the last frame: ${fbChain ? 'LIVE (fill + reduce + cull²)' : 'MISSING'} · the version edge cull-verdicts→feedback-fill ${fbEdge ? 'EXISTS' : 'MISSING'} · cull-verdicts-2→hysteresis ${foldEdge ? 'EXISTS' : 'MISSING'} · ${graph.stats.live}/${graph.stats.declared} passes live · ${graph.stats.compiles} compiles`)

  const logText = await page.evaluate(() => document.querySelector('#log-list')?.textContent ?? '')
  console.log(`\n[health] page errors ${pageErrors.length} · log ${/FAILED|error/i.test(logText) ? 'DIRTY' : 'clean'}`)
  if (pageErrors.length) console.log(pageErrors.slice(0, 5).join('\n'))
} finally {
  await browser.close()
  server.stop(true)
}
