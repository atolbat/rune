/**
 * scripts/task215-local.mjs — the LOCAL pre-deploy gate for Task 215:
 *
 *   · LEG 1 — THE DEPTH-REUSE HARVEST (A6, the occlusion demo, both
 *     backends): the moving frame keeps the classic shape (feedback-fill +
 *     pyramid-reduce-2, no depth-harvest); a STILL camera swaps it honestly
 *     (feedback-fill gated out, depth-harvest live); THE PARITY GATE —
 *     reuseParity() at a fixed camera: both spellings settle, the
 *     harvested pyramid ≡ the feedback-built one (WG: every storage word;
 *     GL: the drawn/occluded counts + the pixels + the frame shapes), the
 *     loop alive after the gate's readbacks, zero errors.
 *
 *   · LEG 2 — THE SCENE STORE MIRROR (the new demo/scene-mirror page):
 *     the local server serves COOP/COEP — crossOriginIsolated — so the
 *     WORKER lane boots (the SAB crosses the thread boundary): the boot
 *     validation PASSES (the aliasing law, the exact dirt, the pool ≡
 *     snapshot, the watermark discipline, the upload math), the HUD's
 *     numbers move (the dirty ranges both directions, live), the drones
 *     fly, zero errors. A second run WITHOUT the headers exercises the T0
 *     fallback lane (the same gates, the main thread).
 */
import { chromium } from 'playwright'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})

let failures = 0
function check(name, ok, detail = '') {
  console.log(`[215] ${name}: ${ok ? 'PASS' : 'FAIL'}${detail ? ` · ${detail}` : ''}`)
  if (!ok) failures++
}

function serve(port, coi) {
  return Bun.serve({
    port,
    async fetch(request) {
      const url = new URL(request.url)
      let pathname = decodeURIComponent(url.pathname)
      if (pathname.endsWith('/')) pathname += 'index.html'
      const file = Bun.file(join(root, pathname))
      if (!(await file.exists())) return new Response('not found', { status: 404 })
      const ext = pathname.slice(pathname.lastIndexOf('.'))
      // COOP/COEP → crossOriginIsolated: the SAB may cross the worker
      // boundary — the worker lane's environment (Pages serves none — the
      // T0 lane is that environment's honest answer, gated in the live run)
      const headers = { 'content-type': MIME[ext] ?? 'application/octet-stream' }
      if (coi) {
        headers['cross-origin-opener-policy'] = 'same-origin'
        headers['cross-origin-embedder-policy'] = 'require-corp'
      }
      return new Response(file, { headers })
    },
  })
}

// ── LEG 1 — the depth-reuse harvest (the occlusion demo) ──────────────────
async function occlusionLeg(mode) {
  console.log(`[215] occlusion leg ${mode}: goto…`)
  const server = serve(8931, false)
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 160)}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`) })
  await page.goto(`http://localhost:8931/demo/occlusion/?bare=1${mode === 'webgl2' ? '&mode=webgl2' : ''}`, { waitUntil: 'networkidle', timeout: 90_000 })
  await page.waitForFunction(() => window.__hizStats && window.__hizStats.drawn > 0, null, { timeout: 240_000 })
  await page.waitForTimeout(600)

  // (a) THE MOVING FRAME keeps the classic shape (the orbit camera moves —
  //     still=false → the feedback branch owns the pyramid)
  const moving = await page.evaluate(() => window.__hizTier.graphStats())
  check(`[${mode}] the moving frame: the classic shape`,
    moving.live.includes('feedback-fill') && moving.live.includes('pyramid-reduce-2') && !moving.live.includes('depth-harvest'),
    `live: ${moving.live.join(',')}`)

  // (b) freeze the camera — the STILL frames swap the fill for the harvest.
  //     Task 219 — THE LIMITATION DISSOLVED: the live canvas loop renders
  //     into THE SURFACE now (the canvas is a one-blit presentation target),
  //     so the live leg carries the sampleable depth too — BOTH backends'
  //     still frames harvest (the Task-215 doc's own catch is history).
  await page.evaluate(() => { window.__hizCam.auto = 0 })
  await page.waitForTimeout(700)
  {
    const still1 = await page.evaluate(() => window.__hizTier.graphStats())
    check(`[${mode}] the still frame: the harvest owns the pyramid (the fill gated out — live AND snapshot legs alike)`,
      still1.live.includes('depth-harvest') && !still1.live.includes('feedback-fill'),
      `live: ${still1.live.join(',')}`)
  }

  // (c) THE PARITY GATE — both spellings at a fixed camera, compared
  const parity = await page.evaluate(async () => {
    window.__hizCtl.pause()
    try {
      // the gate's own camera (the 209 script's spelling — inline math)
      const eye = [0, 8, 40]
      const f = 1 / Math.tan(Math.PI / 6)
      const nf = 1 / (0.5 - 300)
      const proj = new Float32Array([f / (16 / 9), 0, 0, 0, 0, f, 0, 0, 0, 0, 300 * nf, -1, 0, 0, 300 * 0.5 * nf, 0])
      // lookAt(eye, origin)
      let fx = -eye[0], fy = -eye[1], fz = -eye[2]
      let l = Math.hypot(fx, fy, fz); fx /= l; fy /= l; fz /= l
      let rx = fy * 0 - fz * 1, ry = fz * 0 - fx * 0, rz = fx * 1 - fy * 0
      l = Math.hypot(rx, ry, rz); rx /= l; ry /= l; rz /= l
      const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx
      const view = new Float32Array([
        rx, ux, -fx, 0, ry, uy, -fy, 0, rz, uz, -fz, 0,
        -(rx * eye[0] + ry * eye[1] + rz * eye[2]),
        -(ux * eye[0] + uy * eye[1] + uz * eye[2]),
        fx * eye[0] + fy * eye[1] + fz * eye[2], 1,
      ])
      const mvp = new Float32Array(16)
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        let s = 0
        for (let k = 0; k < 4; k++) s += proj[k * 4 + r] * view[c * 4 + k]
        mvp[c * 4 + r] = s
      }
      return await window.__hizTier.reuseParity(mvp, eye)
    } finally {
      window.__hizCtl.resume()
    }
  })
  if (parity === null) {
    check(`[${mode}] THE DEPTH-REUSE PARITY`, false, 'null parity (the harvest bricks missing?)')
  } else if (parity.error !== undefined) {
    check(`[${mode}] THE DEPTH-REUSE PARITY`, false, `crashed: ${parity.error}`)
  } else {
    check(`[${mode}] THE DEPTH-REUSE PARITY (both spellings, the still camera)`,
      parity.pass === true,
      parity.words !== null
        ? `${parity.diffs} diffs of ${parity.words} words · drawn ${parity.drawnOff} vs ${parity.drawnOn} · pixels ${parity.hashEqual ? 'identical' : 'DIFFER'}`
        : `drawn ${parity.drawnOff} vs ${parity.drawnOn} · occluded ${parity.occludedOff} vs ${parity.occludedOn} · pixels ${parity.hashEqual ? 'identical' : 'DIFFER'}`)
    check(`[${mode}] the frame shapes: the honest swap`,
      parity.harvestLive === true && parity.fillClassic === true,
      `on: ${parity.graphOn.join(',')} · off: ${parity.graphOff.join(',')}`)
  }

  // (d) the loop continues cleanly after the gate's readbacks — the orbit
  //     back ON (a still camera + no edits legitimately freezes `drawn`)
  await page.evaluate(() => { window.__hizCam.auto = 1 })
  const before = await page.evaluate(() => window.__hizStats.drawn)
  await page.waitForFunction(before => window.__hizStats.drawn !== before, before, { timeout: 90_000 })
    .then(() => check(`[${mode}] the loop alive after the gate`, true))
    .catch(() => check(`[${mode}] the loop alive after the gate`, false))
  check(`[${mode}] zero errors`, errors.length === 0, errors.slice(0, 3).join(' | '))
  await page.close()
  server.stop(true)
  return errors.length === 0
}

// ── LEG 2 — the scene store mirror (the new page) ──────────────────────────
async function mirrorLeg(coi, label) {
  console.log(`[215] scene-mirror leg (${label}): goto…`)
  const server = serve(8932, coi)
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 160)}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`) })
  await page.goto(`http://localhost:8932/demo/scene-mirror/`, { waitUntil: 'networkidle', timeout: 90_000 })
  const stats = await page.waitForFunction(
    () => (window.__mirrorStats && window.__mirrorStats.validation !== null ? window.__mirrorStats : undefined),
    null,
    { timeout: 120_000 },
  ).then(h => h.jsonValue())
  check(`[${label}] the lane`, coi ? stats?.lane === 'worker' : stats?.lane === 't0', `lane ${stats?.lane}`)
  check(`[${label}] the boot validation PASS`, stats?.validation?.pass === true,
    `${stats?.validation?.checks?.filter(c => c.ok).length ?? '?'}/${stats?.validation?.checks?.length ?? '?'} checks`)
  // the live counters move (the dirty ranges both directions)
  await page.waitForTimeout(1200)
  const s1 = await page.evaluate(() => ({ ...window.__mirrorStats, publish: { ...window.__mirrorStats.publish }, pool: { ...window.__mirrorStats.pool }, world: { ...window.__mirrorStats.world }, visible: [...window.__mirrorStats.visible] }))
  await page.waitForTimeout(900)
  const s2 = await page.evaluate(() => ({ ...window.__mirrorStats, publish: { ...window.__mirrorStats.publish }, pool: { ...window.__mirrorStats.pool }, world: { ...window.__mirrorStats.world }, visible: [...window.__mirrorStats.visible] }))
  check(`[${label}] the publish dirt is live (the movers' bytes)`, s2.publish.bytes > 0 && s2.publish.ranges > 0,
    `${s2.publish.bytes} B · ${s2.publish.ranges} ranges (of ${Math.round(s2.publish.full / 1024)} KB full)`)
  check(`[${label}] the mirror dirt is live (the pools' bytes)`, s2.pool.bytes > 0 && s2.world.bytes > 0,
    `pools ${s2.pool.bytes} B / ${s2.pool.ranges} ranges · worlds ${s2.world.bytes} B`)
  check(`[${label}] the epochs advance`, s2.epoch > s1.epoch || s2.watermark > s1.watermark,
    `epoch ${s1.epoch} → ${s2.epoch} · wm ${s1.watermark} → ${s2.watermark}`)
  check(`[${label}] the visible counts are honest (the cull works)`, s2.visible[0] > 100 && s2.visible[0] < s2.nodes && s2.visible[1] > 100 && s2.visible[1] < s2.nodes,
    `A ${s2.visible[0]} / B ${s2.visible[1]} of ${s2.nodes}`)
  if (coi) {
    check(`[${label}] the stale-take discipline observed (the watermark rhythm)`, s2.staleTakes > 0 || s2.epoch > 3,
      `stale takes ${s2.staleTakes} · epoch ${s2.epoch}`)
  }
  check(`[${label}] zero errors`, errors.length === 0, errors.slice(0, 3).join(' | '))
  await page.close()
  server.stop(true)
  return errors.length === 0
}

const wgOk = await occlusionLeg('webgpu')
const glOk = await occlusionLeg('webgl2')
const mirrorWorkerOk = await mirrorLeg(true, 'worker lane (COI)')
const mirrorT0Ok = await mirrorLeg(false, 'T0 lane (no COI)')
await browser.close()
console.log(`[215] ${wgOk && glOk && mirrorWorkerOk && mirrorT0Ok && failures === 0 ? 'ALL PASS' : `FAILURES: ${failures}`}`)
process.exit(wgOk && glOk && mirrorWorkerOk && mirrorT0Ok && failures === 0 ? 0 : 1)
