/**
 * scripts/task209-order.mjs — Task 209: THE PARALLEL COMPACT + THE
 * NEAR-FIRST ORDER (the research-208 A1+A2 pair, landed).
 *
 * The direct-drive law (the ?bare=1 boot): no boot validation, the rAF loop
 * pauses, THIS script owns the frame. Legs per camera (the report's six):
 *   · settle ×2 — feedback+seed ON, order ON (converge the carry HERE
 *               first — the Task-208b lesson: a fresh leg over a cut carry
 *               pays the one-frame promotion bill and muddies the
 *               cross-leg drawn comparison)
 *   · off      — Hi-Z OFF (frustum only, the parity reference)
 *   · plain    — feedback OFF, seed OFF (the Task-206 shape)
 *   · unordered — feedback+seed ON, order OFF (the pure parallel compact)
 *   · ordered  — feedback+seed ON, order ON (the bitonic's product)
 *   · hyst     — hysteresis ON + order ON (the fold's bucket carry)
 * and the honest laws, headless, on BOTH backends:
 *   (1) BYTE-IDENTITY — the parallel compact's list equals the JS oracle
 *       (the verdict bytes recomputed): the running base + the in-tile
 *       stable scan IS the global ascending rank;
 *   (2) THE PERMUTATION — the ordered list carries EXACTLY the same set
 *       (drawn unchanged; the order is a permutation, never a culling
 *       policy) and ascends strictly by (depth bucket, record index);
 *   (3) PIXEL PARITY — ordered vs unordered vs off: IDENTICAL hashes (the
 *       opaque + depth-test order-invariance law — the early-Z harvest
 *       ships default-ON on its back);
 *   (4) THE TEMPORAL COMPOSITION — the hysteresis fold CARRIES the bucket
 *       (visible hist words keep their bits) and the identity holds on
 *       the folded words;
 *   (5) THE ACCOUNTING INVARIANT on every leg;
 *   (6) THE FRAME SHAPE — the order adds NO graph pass (the dispatch rides
 *       inside the color draw; the compiled frame's live set is unchanged).
 * Plus the TIMING REPORT (WG, no gate — SwiftShader's honest numbers):
 * 30-frame averages, order ON vs OFF, at the orbit camera.
 *
 * Usage: bun run scripts/task209-order.mjs [webgl2]
 */
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const MODE_ARG = process.argv[2] === 'webgl2' ? 'webgl2' : 'webgpu'

const root = resolve(import.meta.dirname, '..')
const port = 8150
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=image/svg+xml',
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
  const bootMode = await page.evaluate(() => ({ mode: window.__hizStats.mode, kind: window.__hizTier.kind, total: window.__hizStats.total }))
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
    for (let f = 0; f < cfg.frames; f++) {
      // the full 13-arg renderTo: (target, mvp, eye, hiz, debug, occluders,
      // hysteresis, history, cache, wantStats, feedback, seed, order)
      tier.renderTo(tier.surface.targetId, mvp, eye, cfg.hiz, false, cfg.occluders, cfg.hysteresis === true, false, false, false, cfg.feedback !== false, cfg.seed !== false, cfg.order !== false)
    }
    const s = await tier.readStats()
    const img = await tier.surface.read()
    let h = 2166136261
    for (let i = 0; i < img.data.length; i++) {
      h ^= img.data[i]
      h = Math.imul(h, 16777619)
    }
    // the list checks (WG only — readList is null on GL)
    let listReport = null
    if (cfg.checkList === true) {
      const lr = await tier.readList()
      if (lr !== null) {
        const N = lr.verdicts.length
        const oracle = []
        for (let i = 0; i < N; i++) {
          const f = lr.verdicts[i] & 0xFF
          if (f === 1 || f === 4) oracle.push(i)
        }
        const identity = oracle.length === lr.drawn && oracle.every((rec, k) => lr.list[k] === rec)
        // THE SET IDENTITY: the sorted copy of the list vs the oracle — the
        // ordered legs' check (the list is near-first there, not ascending)
        const listSorted = Array.from(lr.list.slice(0, lr.drawn)).sort((a, b) => a - b)
        const setIdentity = oracle.length === lr.drawn && listSorted.every((rec, k) => oracle[k] === rec)
        const bkt = rec => (lr.verdicts[rec] >> 16) & 0xFF
        let sorted = true
        for (let k = 0; k + 1 < lr.drawn; k++) {
          const a = lr.list[k], b = lr.list[k + 1]
          if (bkt(a) > bkt(b) || (bkt(a) === bkt(b) && a > b)) { sorted = false; break }
        }
        let bMin = 255, bMax = 0, bNonZero = 0
        for (const rec of oracle) {
          const b = bkt(rec)
          if (b < bMin) bMin = b
          if (b > bMax) bMax = b
          if (b > 0) bNonZero++
        }
        listReport = { identity, setIdentity, sorted, drawn: lr.drawn, oracleLen: oracle.length, bucketMin: bMin, bucketMax: bMax, bucketNonZero: bNonZero }
      } else {
        listReport = { nullList: true }
      }
    }
    return {
      stats: s,
      hash: (h >>> 0).toString(16),
      listReport,
      ms: +(performance.now() - t0).toFixed(0),
    }
  }, config)

  const N = await page.evaluate(() => window.__hizStats.total)
  const K = await page.evaluate(() => window.__hizStats.occluders)
  const IS_WG = await page.evaluate(() => window.__hizTier.mode === 'webgpu')
  console.log(`[scene] N=${N} records, K=${K} occluders · ${IS_WG ? 'the WG leg (the list + the order live here)' : 'the GL leg (no list — the collapse draw; the order is a documented no-op)'}`)

  // ── 1. the report's camera scan ─────────────────────────────────────────
  console.log('\n[scan] the report\'s cameras — settle / off / plain / unordered (the pure compact) / ordered (the bitonic) / hyst (the carry)')
  const cams = [[0, 0.1], [0, -0.05], [0.4, -0.15], [1.57, -0.15], [3.14, -0.15], [0.8, 0.05]]
  const rows = []
  for (const [yaw, pitch] of cams) {
    // the settle: converge the carry at THIS camera before any comparison
    await drive({ yaw, pitch, dist: 12, frames: 2, hiz: 1, occluders: K, feedback: true, seed: true, order: true })
    const off = await drive({ yaw, pitch, dist: 12, frames: 2, hiz: 0, occluders: K, feedback: false, seed: false, order: false })
    const plain = await drive({ yaw, pitch, dist: 12, frames: 2, hiz: 1, occluders: K, feedback: false, seed: false, order: false })
    const unordered = await drive({ yaw, pitch, dist: 12, frames: 2, hiz: 1, occluders: K, feedback: true, seed: true, order: false, checkList: true })
    const ordered = await drive({ yaw, pitch, dist: 12, frames: 2, hiz: 1, occluders: K, feedback: true, seed: true, order: true, checkList: true })
    const hyst = await drive({ yaw, pitch, dist: 12, frames: 3, hiz: 1, occluders: K, feedback: true, seed: true, order: true, hysteresis: true, checkList: true })
    const r = {
      yaw, pitch,
      plain: plain.stats.drawn, unordered: unordered.stats.drawn, ordered: ordered.stats.drawn, hyst: hyst.stats.drawn,
      identity: unordered.listReport?.nullList === true ? 'n/a (GL)' : unordered.listReport?.identity === true ? 'EXACT' : 'BROKEN',
      perm: unordered.listReport?.nullList === true ? 'n/a (GL)' : (ordered.listReport?.setIdentity === true && unordered.stats.drawn === ordered.stats.drawn ? 'EXACT' : 'BROKEN'),
      sorted: ordered.listReport?.nullList === true ? 'n/a (GL)' : ordered.listReport?.sorted === true ? 'EXACT' : 'BROKEN',
      buckets: ordered.listReport?.nullList === true ? 'n/a' : `${ordered.listReport.bucketMin}..${ordered.listReport.bucketMax} (${ordered.listReport.bucketNonZero} nonzero)`,
      carry: hyst.listReport?.nullList === true ? 'n/a (GL)' : (hyst.listReport.setIdentity === true && hyst.listReport.bucketNonZero > 0 ? 'YES' : 'NO'),
      parityUO: unordered.hash === off.hash ? 'IDENTICAL' : 'DIFFERS',
      parityOrder: ordered.hash === unordered.hash ? 'IDENTICAL' : 'DIFFERS',
      invariant: plain.stats.frustum + plain.stats.occluded + plain.stats.drawn === N
        && unordered.stats.frustum + unordered.stats.occluded + unordered.stats.drawn === N
        && ordered.stats.frustum + ordered.stats.occluded + ordered.stats.drawn === N
        && hyst.stats.frustum + hyst.stats.occluded + hyst.stats.drawn === N,
    }
    rows.push(r)
    console.log(`  yaw ${yaw.toFixed(2)} pitch ${pitch.toFixed(2)}: plain ${r.plain} · unordered ${r.unordered} · ordered ${r.ordered} · hyst ${r.hyst} · identity ${r.identity} · permutation ${r.perm} · sorted ${r.sorted} · buckets ${r.buckets} · the fold carries ${r.carry} · parity off ${r.parityUO} / order ${r.parityOrder} · invariant ${r.invariant ? 'OK' : 'BROKEN'}`)
  }

  // ── 2. the frame shape — the order adds NO pass ─────────────────────────
  const graph = await page.evaluate(() => window.__hizTier.graphStats())
  const colorLive = graph.live.includes('color')
  const passCountStable = graph.live.length === (graph.gated.includes('z-fill') ? 7 : 9) // the seeded frame: 7 live (the 208 law); the warm-up: 9
  console.log(`\n[graph] the ordered frame: ${graph.live.length} live / ${graph.gated.length} gated · color ${colorLive ? 'LIVE' : 'MISSING'} · the order rides INSIDE the color draw (no new pass) · ${passCountStable ? 'the Task-208 shape intact' : 'SHAPE DRIFT?'}`)

  // ── 3. the timing report (WG only, SwiftShader's honest numbers) ────────
  let timing = null
  if (IS_WG) {
    const time = await page.evaluate(async () => {
      const tier = window.__hizTier
      const aspect = tier.aspect()
      const fov = Math.PI / 3 * Math.min(1.5, Math.max(1, (16 / 9) / aspect))
      const yaw = 0.9, pitch = 0.3, dist = 38
      const eye = [Math.cos(pitch) * Math.sin(yaw) * dist, 5.5 + Math.sin(pitch) * dist, Math.cos(pitch) * Math.cos(yaw) * dist]
      const center = [0, 5.5, 0]
      function lookAt(e, c) {
        let fx = c[0] - e[0], fy = c[1] - e[1], fz = c[2] - e[2]
        let l = Math.hypot(fx, fy, fz); fx /= l; fy /= l; fz /= l
        let rx = -fz, ry = 0, rz = fx
        l = Math.hypot(rx, ry, rz); rx /= l; ry /= l; rz /= l
        const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx
        return new Float32Array([rx, ux, -fx, 0, ry, uy, -fy, 0, rz, uz, -fz, 0, -(rx * e[0] + ry * e[1] + rz * e[2]), -(ux * e[0] + uy * e[1] + uz * e[2]), fx * e[0] + fy * e[1] + fz * e[2], 1])
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
      const run = async order => {
        // warm to the same state, then time
        for (let f = 0; f < 3; f++) tier.renderTo(tier.surface.targetId, mvp, eye, 1, false, 23, false, false, false, false, true, true, order)
        const t0 = performance.now()
        for (let f = 0; f < 30; f++) tier.renderTo(tier.surface.targetId, mvp, eye, 1, false, 23, false, false, false, false, true, true, order)
        await tier.surface.read()
        return performance.now() - t0
      }
      const a1 = await run(true), b1 = await run(false), a2 = await run(true), b2 = await run(false)
      const on = (a1 + a2) / 60, off = (b1 + b2) / 60
      const s = await tier.readStats()
      return { onMs: +on.toFixed(2), offMs: +off.toFixed(2), drawn: s.drawn, delta: +((off - on)).toFixed(2) }
    })
    timing = time
    console.log(`\n[timing] SwiftShader, the orbit camera, drawn ${time.drawn}: order ON ${time.onMs} ms/frame vs OFF ${time.offMs} ms/frame (Δ ${time.delta > 0 ? '+' : ''}${time.delta} — the report, not a gate: the software raster's early-Z behavior is its own law; the real-GPUs harvest is the design's claim)`)
  }

  // ── the verdict ─────────────────────────────────────────────────────────
  const laws = {
    identity: rows.every(r => r.identity !== 'BROKEN'),
    permutation: rows.every(r => r.perm !== 'BROKEN'),
    sortedness: rows.every(r => r.sorted !== 'BROKEN'),
    parity: rows.every(r => r.parityUO === 'IDENTICAL' && r.parityOrder === 'IDENTICAL'),
    carry: IS_WG ? rows.every(r => r.carry === 'YES') : true,
    invariant: rows.every(r => r.invariant),
    shape: colorLive && passCountStable,
  }
  const pass = Object.values(laws).every(Boolean) && pageErrors.length === 0
  console.log(`\n[verdict] ${MODE_ARG}: ${pass ? 'PASS' : 'FAIL'} — identity ${laws.identity ? 'OK' : 'BROKEN'} · permutation ${laws.permutation ? 'OK' : 'BROKEN'} · sortedness ${laws.sortedness ? 'OK' : 'BROKEN'} · parity ${laws.parity ? 'OK' : 'BROKEN'} · the fold's carry ${laws.carry ? 'OK' : 'BROKEN'} · invariant ${laws.invariant ? 'OK' : 'BROKEN'} · shape ${laws.shape ? 'OK' : 'BROKEN'}${pageErrors.length > 0 ? ` · ${pageErrors.length} PAGE ERRORS` : ''}`)
  if (!pass) process.exitCode = 1
} finally {
  await browser.close(); server.stop(true)
}
