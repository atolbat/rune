/**
 * scripts/task208-closecam.mjs — Task 208: THE CROSS-FRAME SEED ROUND (the
 * bevy two-phase delta: cross-frame HZB seed + the late downsample).
 *
 * The direct-drive law (the ?bare=1 boot): no boot validation, the rAF loop
 * pauses, THIS script owns the frame. Legs per camera:
 *   · off     — Hi-Z OFF (frustum only, the parity reference)
 *   · plain   — feedback OFF, seed OFF (the Task-206 shape; its drawn IS
 *               the boot frame's phase-1 pass set — the crowd the feedback
 *               fill had to raster depth-only)
 *   · boot    — feedback ON, seed OFF (the Task-207 shape: the fresh K-wall
 *               warm-up + the same-frame re-cull, every frame)
 *   · seed    — feedback ON, seed ON (the carry owns phase 1: no z-fill, no
 *               first reduce — converged after the warm-up frames)
 *   · city    — the brute all-N fill (the bound)
 * and the honest laws, headless, on BOTH backends:
 *   (1) FIXED POINT — the seeded frame's final buckets land EXACTLY on the
 *       boot frame's (drawn/occluded equal: the tile only depends on its
 *       front layer, so the seeded cull#1 passes the final set and cull#2
 *       runs the same predicate over the same tile bytes);
 *   (2) THE FILL COLLAPSE — plain.drawn (the boot phase-1 pass set) vs the
 *       seeded phase-1 pass set (= the final drawn): the ratio is the
 *       depth-only raster the seed saves EVERY frame;
 *   (3) PIXEL PARITY — every leg hashes identical to the OFF frame;
 *   (4) THE GRAPH SHAPE — the seeded frame gates z-fill + pyramid-reduce,
 *       reads import→cull-verdicts hiz-seed@v, refreshes the carry (0f
 *       stale), keeps the feedback chain live;
 *   (5) MOTION SOUNDNESS — a +0.04 rad step with the carry one frame stale
 *       in SCREEN SPACE: pixels must match the fresh reference exactly
 *       (cull#2's law — the lag costs fill, never a pixel), the drawn delta
 *       is the honest promotion bill.
 *
 * Usage: bun run scripts/task208-closecam.mjs [webgl2]
 */
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const MODE_ARG = process.argv[2] === 'webgl2' ? 'webgl2' : 'webgpu'

const root = resolve(import.meta.dirname, '..')
const port = 8148
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
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
  const bootMode = await page.evaluate(() => ({ mode: window.__hizStats.mode, kind: window.__hizTier.kind, total: window.__hizStats.total, feedback: window.__hizStats.feedback, seed: window.__hizStats.seed }))
  console.log(`[boot] ${JSON.stringify(bootMode)} · the loop is paused, the probe owns the frame`)

  /** The scene.js camera math, inlined (the same formulas, the same f32). */
  const drive = config => page.evaluate(async cfg => {
    const tier = window.__hizTier
    const t0 = performance.now()
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
    const trace = []
    for (let f = 0; f < cfg.frames; f++) {
      // the full 12-arg renderTo: (target, mvp, eye, hiz, debug, occluders,
      // hysteresis, history, cache, wantStats, feedback, seed)
      tier.renderTo(tier.surface.targetId, mvp, eye, cfg.hiz, false, cfg.occluders, false, false, false, false, cfg.feedback !== false, cfg.seed !== false)
      if (cfg.perFrame) trace.push((await tier.readStats()).drawn)
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
    const seedState = tier.seedState !== undefined ? tier.seedState() : null
    return {
      stats: s,
      trace,
      coverage: +(100 * nonSky / n).toFixed(1),
      hash: (h >>> 0).toString(16),
      seedState,
      ms: +(performance.now() - t0).toFixed(0),
    }
  }, config)

  const N = await page.evaluate(() => window.__hizStats.total)
  const K = await page.evaluate(() => window.__hizStats.occluders)
  console.log(`[scene] N=${N} records, K=${K} occluders`)

  // ── 1. the report's camera scan — the five legs + the laws ─────────────
  console.log('\n[scan] the report\'s cameras — off / plain (the boot phase-1 pass set) / boot (Task-207) / seed (the carry) / city (the brute bound)')
  const cams = [[0, 0.1], [0, -0.05], [0.4, -0.15], [1.57, -0.15], [3.14, -0.15], [0.8, 0.05]]
  const rows = []
  for (const [yaw, pitch] of cams) {
    const off = await drive({ yaw, pitch, dist: 12, frames: 2, hiz: 0, occluders: K, feedback: false, seed: false })
    const plain = await drive({ yaw, pitch, dist: 12, frames: 2, hiz: 1, occluders: K, feedback: false, seed: false })
    const boot = await drive({ yaw, pitch, dist: 12, frames: 2, hiz: 1, occluders: K, feedback: true, seed: false })
    const seed = await drive({ yaw, pitch, dist: 12, frames: 4, hiz: 1, occluders: K, feedback: true, seed: true, perFrame: true })
    const city = await drive({ yaw, pitch, dist: 12, frames: 2, hiz: 1, occluders: N, feedback: false, seed: false })
    const r = {
      yaw, pitch,
      plain: plain.stats.drawn, boot: boot.stats.drawn, seed: seed.stats.drawn, city: city.stats.drawn,
      fixedPoint: seed.stats.drawn === boot.stats.drawn && seed.stats.occluded === boot.stats.occluded,
      fillCut: plain.stats.drawn > 0 ? +(plain.stats.drawn / Math.max(1, seed.stats.drawn)).toFixed(1) : 0,
      seedParity: seed.hash === off.hash ? 'IDENTICAL' : 'DIFFERS',
      bootParity: boot.hash === off.hash ? 'IDENTICAL' : 'DIFFERS',
      seedOn: seed.seedState !== null && seed.seedState.on,
      trace: seed.trace,
    }
    rows.push(r)
    console.log(`  yaw ${yaw.toFixed(2)} pitch ${pitch.toFixed(2)}: pass-set plain ${r.plain} → boot ${r.boot} · seed ${r.seed} (city ${r.city}) · fixed-point ${r.fixedPoint ? 'EXACT' : 'DRIFT'} · fill ×${r.fillCut} less · parity boot ${r.bootParity} / seed ${r.seedParity} · carry ${r.seedOn ? 'owns phase 1' : 'IDLE'} · trace [${r.trace.join('→')}]`)
  }
  const fixedFails = rows.filter(r => !r.fixedPoint)
  const parityFails = rows.filter(r => r.seedParity !== 'IDENTICAL' || r.bootParity !== 'IDENTICAL')
  const idleFails = rows.filter(r => !r.seedOn)
  console.log(`[laws] fixed point ${fixedFails.length === 0 ? `EXACT on all ${rows.length} cameras` : `${fixedFails.length} DRIFT`} · pixel parity ${parityFails.length === 0 ? 'ALL IDENTICAL' : `${parityFails.length} DIFFERS`} · the carry ${idleFails.length === 0 ? 'owns phase 1 everywhere' : `${idleFails.length} cameras idle`}`)
  const best = rows.reduce((a, b) => b.fillCut > a.fillCut ? b : a, rows[0])
  console.log(`[laws] the biggest fill cut: yaw ${best.yaw} pitch ${best.pitch} — the feedback fill's pass set ${best.plain} → ${best.seed} (×${best.fillCut} less depth-only raster per frame, the same final buckets)`)

  // ── 2. MOTION SOUNDNESS — the harsh case: the carry from ANOTHER
  //      camera, sampled along the new rays (worse than any one-frame
  //      rotation). Converge at yaw 0.04, jump +0.30 rad, ONE seeded
  //      frame (the carry still holds A's pyramid); the OFF reference at
  //      B never touches the pyramid, so the comparison stays honest
  //      without a fresh warm-up overwriting the carry first.
  await drive({ yaw: 0.04, pitch: 0.1, dist: 12, frames: 2, hiz: 1, occluders: K, feedback: true, seed: true })
  const harshSeed = await drive({ yaw: 0.34, pitch: 0.1, dist: 12, frames: 1, hiz: 1, occluders: K, feedback: true, seed: true })
  const offB = await drive({ yaw: 0.34, pitch: 0.1, dist: 12, frames: 2, hiz: 0, occluders: K, feedback: false, seed: false })
  const freshB = await drive({ yaw: 0.34, pitch: 0.1, dist: 12, frames: 2, hiz: 1, occluders: K, feedback: true, seed: false })
  const harshParity = harshSeed.hash === offB.hash && harshSeed.hash === freshB.hash ? 'IDENTICAL' : 'DIFFERS'
  console.log(`\n[motion] the +0.30 rad jump with a cross-camera carry: pixels ${harshParity} · drawn fresh ${freshB.stats.drawn} → seeded ${harshSeed.stats.drawn} (Δ+${harshSeed.stats.drawn - freshB.stats.drawn} the promotion bill — cull#2 re-culls the stale phase-1's misses same-frame; the next frame re-converges)`)

  // ── 3. the default far view (the orbit camera — the live page's shape) ──
  const farOff = await drive({ yaw: 0.9, pitch: 0.3, dist: 38, frames: 2, hiz: 0, occluders: K, feedback: false, seed: false })
  const farBoot = await drive({ yaw: 0.9, pitch: 0.3, dist: 38, frames: 2, hiz: 1, occluders: K, feedback: true, seed: false })
  const farSeed = await drive({ yaw: 0.9, pitch: 0.3, dist: 38, frames: 3, hiz: 1, occluders: K, feedback: true, seed: true })
  console.log(`\n[reference] the default orbit view (yaw 0.9 pitch 0.3 dist 38): pass-set ${farBoot.stats.drawn} → seed ${farSeed.stats.drawn} · fixed-point ${farSeed.stats.drawn === farBoot.stats.drawn ? 'EXACT' : 'DRIFT'} · parity ${farSeed.hash === farOff.hash ? 'IDENTICAL' : 'DIFFERS'} · occluded ${farBoot.stats.occluded} → ${farSeed.stats.occluded} · carry ${farSeed.seedState !== null && farSeed.seedState.on ? 'owns phase 1' : 'IDLE'}`)

  // ── 4. the graph shape + the cross-frame edge — read AFTER the last
  //      seed frame (farSeed's final frame IS the seeded shape) ───────────
  const graph = await page.evaluate(() => window.__fgDebug.last())
  const seedGated = graph !== null && graph.gated.includes('z-fill') && graph.gated.includes('pyramid-reduce')
    && !graph.live.includes('z-fill') && !graph.live.includes('pyramid-reduce')
  const seedEdge = graph !== null && graph.edges.some(e => e.startsWith('import→cull-verdicts hiz-seed@'))
  const seedStale = graph !== null ? (graph.stale['hiz-seed'] ?? -1) : -1
  const fbLive = graph !== null && graph.live.includes('feedback-fill') && graph.live.includes('pyramid-reduce-2') && graph.live.includes('cull-verdicts-2')
  const passDelta = graph !== null ? { live: graph.live.length, gated: graph.gated.length } : null
  console.log(`\n[graph] the seeded frame: ${seedGated ? 'z-fill + pyramid-reduce GATED (the warm-up left the frame)' : 'WARM-UP STILL LIVE'} · the carry's edge ${seedEdge ? 'import→cull-verdicts hiz-seed@ EXISTS' : 'MISSING'} · staleness ${seedStale}f · the feedback chain ${fbLive ? 'LIVE' : 'MISSING'} · ${passDelta ? `${passDelta.live} live / ${passDelta.gated} gated passes` : 'n/a'}`)

  // ── the verdict ─────────────────────────────────────────────────────────
  const pass = fixedFails.length === 0 && parityFails.length === 0 && idleFails.length === 0 && seedGated && seedEdge && seedStale === 0 && fbLive && harshParity === 'IDENTICAL' && farSeed.hash === farOff.hash
  console.log(`\n[gate] task208-closecam ${pass ? 'PASS' : 'FAIL'} (${MODE_ARG}) — fixed point ${fixedFails.length === 0 ? 'EXACT' : fixedFails.length + ' drift'} · parity ${parityFails.length === 0 ? 'clean' : parityFails.length + ' differs'} · graph ${seedGated && seedEdge && fbLive ? 'the carry owns phase 1' : 'BROKEN'} · motion ${harshParity}`)
  const logText = await page.evaluate(() => document.querySelector('#log-list')?.textContent ?? '')
  console.log(`[health] page errors ${pageErrors.length} · log ${/FAILED|error/i.test(logText) ? 'DIRTY' : 'clean'}`)
  if (pageErrors.length) console.log(pageErrors.slice(0, 5).join('\n'))
  process.exitCode = pass ? 0 : 1
} finally {
  await browser.close()
  server.stop(true)
}
