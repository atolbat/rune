/**
 * scripts/scratch-219e.mjs — Task 219: THE FLICKER DISCRIMINATOR.
 * The 218 oscilloscope measured 530 raw flips/12 s (and 594 post
 * pyramid-equality — the resolution gap was NOT the driver). The question
 * this script answers: do the verdicts oscillate at a FIXED camera (a
 * feedback-loop pathology — the disease) or only under camera motion
 * (genuine occlusion dynamics — the designed hysteresis's own domain)?
 *
 *   PHASE A — a FIXED mvp, 40 frames, the loop parked (the movers frozen):
 *             ANY flip = a real oscillation (cull → fill → pyramid → cull).
 *   PHASE B — a 1-arcminute camera YAW jitter alternating every frame
 *             (the walking parallax in its smallest form): the flip count
 *             vs A separates the motion-driven class.
 *   PHASE C — the top flippers identified by RECORD (position/size/class)
 *             and their verdict time series dumped.
 */
import { chromium } from 'playwright'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const port = 8211
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const server = Bun.serve({ port, async fetch(request) {
  const url = new URL(request.url); let pathname = decodeURIComponent(url.pathname)
  if (pathname.endsWith('/')) pathname += 'index.html'
  const file = Bun.file(join(root, pathname))
  if (!(await file.exists())) return new Response('not found', { status: 404 })
  const ext = pathname.slice(pathname.lastIndexOf('.'))
  return new Response(file, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
}})
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
  await page.goto(`http://localhost:${port}/demo/walker/?crowd=512&mode=webgl2&bare=1`, { waitUntil: 'networkidle', timeout: 90_000 })
  await page.waitForFunction(() => window.__walkerTier && window.__walker.frame > 20, null, { timeout: 240_000 })
  const report = await page.evaluate(async () => {
    const t = window.__walkerTier
    const N = window.__walker.total
    // park the loop (the movers freeze with it — the world ticks inside)
    window.RuneDemoShell?.pause?.()
    window.__walkerPaused = true
    // a fixed camera at the spawn (the walker's own eye): build the mvp via
    // the page's exported math — reuse the last frame's mvp instead (exact)
    const wait = ms => new Promise(r => setTimeout(r, ms))
    const readV = async () => {
      const v = await t.readVerdicts()
      return v
    }
    const series = []
    const drive = async (mvp, eye) => {
      // the walker's own 14-arg frame policy: culling+hyst+feedback+seed+order+reuse
      t.renderTo(t.surface.targetId, mvp, eye, 1, 0, window.__walkerTier.__scene.occluders, 1, 0, 0, false, 1, 1, 1, 0)
    }
    // grab the live camera's exact mvp/eye from the CURRENT frame (the loop's own last state)
    const cam = window.__walker
    const spawnMvp = window.__MVP_CAPTURE ?? null
    // build a fixed camera through the tier's own aspect + the walker state
    const aspect = t.aspect()
    const s = window.__walker
    const eye = [s.x, s.y + 1.62, s.z]
    const yaw = s.yaw
    const pitch = -0.06
    const cp = Math.cos(pitch)
    const fx = Math.sin(yaw) * cp, fy = Math.sin(pitch), fz = -Math.cos(yaw) * cp
    // the demo's own math module (scene.js) is loaded — reuse its functions
    const { perspective, lookAt, mat4Mul } = await import('../occlusion/scene.js?v=203')
    const fov = Math.PI / 3 * Math.min(1.5, Math.max(1, (16 / 9) / aspect))
    const proj = perspective(fov, aspect, 0.1, 620)
    const view = lookAt(eye, [eye[0] + fx, eye[1] + fy, eye[2] + fz], [0, 1, 0])
    let MVP = new Float32Array(mat4Mul(proj, view))
    // PHASE A — the fixed camera, 40 frames
    for (let f = 0; f < 40; f++) { await drive(MVP, eye); series.push(await readV()) }
    const flipsA = []
    for (let i = 0; i < N; i++) {
      let f = 0
      for (let s2 = 1; s2 < series.length; s2++) if (series[s2][i] !== series[s2 - 1][i]) f++
      if (f > 0) flipsA.push({ id: i, flips: f })
    }
    // PHASE B — the ±0.0003 rad yaw jitter (≈ the head-bob scale of one step)
    const seriesB = []
    for (let f = 0; f < 40; f++) {
      const j = (f % 2 === 0 ? 1 : -1) * 0.0003
      const cpj = Math.cos(pitch)
      const fxj = Math.sin(yaw + j) * cpj, fzj = -Math.cos(yaw + j) * cpj
      const vj = lookAt(eye, [eye[0] + fxj, eye[1] + Math.sin(pitch), eye[2] + fzj], [0, 1, 0])
      const mj = new Float32Array(mat4Mul(proj, vj))
      await drive(mj, eye)
      seriesB.push(await readV())
    }
    const flipsB = []
    for (let i = 0; i < N; i++) {
      let f = 0
      for (let s2 = 1; s2 < seriesB.length; s2++) if (seriesB[s2][i] !== seriesB[s2 - 1][i]) f++
      if (f > 0) flipsB.push({ id: i, flips: f })
    }
    flipsA.sort((a, b) => b.flips - a.flips)
    flipsB.sort((a, b) => b.flips - a.flips)
    // the top flippers' records (position/size — the class by size)
    const recs = await Promise.all(flipsB.slice(0, 4).map(fl => t.device.readRecords(t.__scene, fl.id, 1).then(r => ({ id: fl.id, flips: fl.flips, cx: +r[0].toFixed(1), cy: +r[1].toFixed(1), cz: +r[2].toFixed(1), hx: +r[3].toFixed(2), hy: +r[4].toFixed(2), hz: +r[5].toFixed(2) }))))
    // one flipper's verdict series (the vocabulary over frames)
    const top = flipsB[0]
    const vocab = top ? seriesB.map(v => v[top.id]).join('') : ''
    return {
      N, samples: series.length,
      phaseA_fixed: { flippers: flipsA.length, total: flipsA.reduce((a, b) => a + b.flips, 0), top: flipsA.slice(0, 3) },
      phaseB_jitter: { flippers: flipsB.length, total: flipsB.reduce((a, b) => a + b.flips, 0), top: flipsB.slice(0, 5) },
      topRecords: recs, topVocab: vocab,
    }
  }, { timeout: 240_000 })
  console.log(JSON.stringify(report, null, 1))
} finally {
  await Promise.race([browser.close(), new Promise(r => setTimeout(r, 8000))])
  try { browser.process()?.kill('SIGKILL') } catch {}
}
server.stop(true)
process.exit(0)
