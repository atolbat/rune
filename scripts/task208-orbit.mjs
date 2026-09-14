/**
 * scripts/task208-orbit.mjs — the Task-208 live-gate diagnosis: the deployed
 * loop reads drawn 4371 (the gate wants <2300; Task 207's loop read 1701 on
 * the same orbit), while the STATIC default view reads 1697. Question: does
 * the seed inflate the MOVING-camera buckets (a per-frame promotion bill
 * that never heals), or does the orbit simply pass a high-drawn yaw?
 *
 * Legs (bare boot, direct drive, per-frame stats):
 *   · orbit seed OFF  — the boot frame's feedback at a moving camera
 *   · orbit seed ON   — the carry at a moving camera (one frame stale)
 *   · static sweep    — drawn vs yaw 0.90..0.95 at pitch 0.3 dist 38
 */
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const MODE_ARG = process.argv[2] === 'webgl2' ? 'webgl2' : 'webgpu'
const root = resolve(import.meta.dirname, '..')
const port = 8150
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' }
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
  await page.goto(`http://localhost:${port}/demo/occlusion/?bare=1${MODE_ARG === 'webgl2' ? '&mode=webgl2' : ''}`, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => window.__hizTier !== null && window.__hizTier !== undefined, null, { timeout: 180_000 })
  await page.evaluate(() => window.__hizCtl.pause())
  console.log(`[boot] ${MODE_ARG} · the probe owns the frame`)

  const run = cfg => page.evaluate(async c => {
    const tier = window.__hizTier
    const K = window.__hizStats.occluders
    const aspect = tier.aspect()
    const fov = Math.PI / 3 * Math.min(1.5, Math.max(1, (16 / 9) / aspect))
    function cam(yaw) {
      const pitch = 0.3, dist = 38
      const eye = [Math.cos(pitch) * Math.sin(yaw) * dist, 5.5 + Math.sin(pitch) * dist, Math.cos(pitch) * Math.cos(yaw) * dist]
      const center = [0, 5.5, 0]
      let fx = center[0] - eye[0], fy = center[1] - eye[1], fz = center[2] - eye[2]
      let l = Math.hypot(fx, fy, fz); fx /= l; fy /= l; fz /= l
      let rx = -fz, ry = 0, rz = fx
      l = Math.hypot(rx, ry, rz); rx /= l; ry /= l; rz /= l
      const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx
      const view = new Float32Array([rx, ux, -fx, 0, ry, uy, -fy, 0, rz, uz, -fz, 0,
        -(rx * eye[0] + ry * eye[1] + rz * eye[2]), -(ux * eye[0] + uy * eye[1] + uz * eye[2]), fx * eye[0] + fy * eye[1] + fz * eye[2], 1])
      const f = 1 / Math.tan(fov / 2)
      const near = 0.5, far = 300, nf = 1 / (near - far)
      const proj = new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far * nf, -1, 0, 0, far * near * nf, 0])
      const mvp = new Float32Array(16)
      for (let col = 0; col < 4; col++) for (let r = 0; r < 4; r++) {
        let s = 0
        for (let k = 0; k < 4; k++) s += proj[k * 4 + r] * view[col * 4 + k]
        mvp[col * 4 + r] = s
      }
      return { eye, mvp }
    }
    const trace = []
    if (c.mode === 'orbit') {
      // the live loop's exact cadence: yaw starts 0.9, +0.0016/frame
      let yaw = c.yaw0 ?? 0.9
      for (let f = 0; f < c.frames; f++) {
        const { eye, mvp } = cam(yaw)
        tier.renderTo(tier.surface.targetId, mvp, eye, 1, false, K, false, false, false, false, true, c.seed !== false)
        if (c.perFrame !== false) trace.push((await tier.readStats()).drawn)
        yaw += 0.0016
      }
    } else {
      for (const yaw of c.yaws) {
        const { eye, mvp } = cam(yaw)
        for (let f = 0; f < 3; f++) tier.renderTo(tier.surface.targetId, mvp, eye, 1, false, K, false, false, false, false, true, c.seed !== false)
        trace.push({ yaw: +yaw.toFixed(3), drawn: (await tier.readStats()).drawn })
      }
    }
    return { trace, seedState: tier.seedState !== undefined ? tier.seedState() : null }
  }, cfg)

  // 0. THE CUT LEG — the live loop's exact birth condition: the boot
  //    validation ends at the moved seed camera (yaw 0.38, dist 12, pitch
  //    0.1); the loop then starts at the orbit (yaw 0.9, pitch 0.3, dist
  //    38). Converge at A, CUT to B, read 8 frames of per-frame drawn.
  {
    const cutDrive = cfg => page.evaluate(async c => {
      const tier = window.__hizTier
      const K = window.__hizStats.occluders
      const aspect = tier.aspect()
      const fov = Math.PI / 3 * Math.min(1.5, Math.max(1, (16 / 9) / aspect))
      function cam(yaw, pitch, dist) {
        const eye = [Math.cos(pitch) * Math.sin(yaw) * dist, 5.5 + Math.sin(pitch) * dist, Math.cos(pitch) * Math.cos(yaw) * dist]
        const center = [0, 5.5, 0]
        let fx = center[0] - eye[0], fy = center[1] - eye[1], fz = center[2] - eye[2]
        let l = Math.hypot(fx, fy, fz); fx /= l; fy /= l; fz /= l
        let rx = -fz, ry = 0, rz = fx
        l = Math.hypot(rx, ry, rz); rx /= l; ry /= l; rz /= l
        const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx
        const view = new Float32Array([rx, ux, -fx, 0, ry, uy, -fy, 0, rz, uz, -fz, 0,
          -(rx * eye[0] + ry * eye[1] + rz * eye[2]), -(ux * eye[0] + uy * eye[1] + uz * eye[2]), fx * eye[0] + fy * eye[1] + fz * eye[2], 1])
        const f = 1 / Math.tan(fov / 2)
        const near = 0.5, far = 300, nf = 1 / (near - far)
        const proj = new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far * nf, -1, 0, 0, far * near * nf, 0])
        const mvp = new Float32Array(16)
        for (let col = 0; col < 4; col++) for (let r = 0; r < 4; r++) {
          let s = 0
          for (let k = 0; k < 4; k++) s += proj[k * 4 + r] * view[col * 4 + k]
          mvp[col * 4 + r] = s
        }
        return { eye, mvp }
      }
      const A = cam(0.38, 0.1, 12)
      for (let f = 0; f < 2; f++) tier.renderTo(tier.surface.targetId, A.mvp, A.eye, 1, false, K, false, false, false, false, true, c.seed !== false)
      // the CUT: to the orbit's birth camera
      let yaw = 0.9
      const trace = []
      for (let f = 0; f < 8; f++) {
        const B = cam(yaw, 0.3, 38)
        tier.renderTo(tier.surface.targetId, B.mvp, B.eye, 1, false, K, false, false, false, false, true, c.seed !== false)
        trace.push((await tier.readStats()).drawn)
        yaw += 0.0016
      }
      return trace
    }, cfg)
    const cutSeed = await cutDrive({ seed: true })
    console.log(`\n[cut seed ON ] A(0.38,12,0.1) → B(0.9,38,0.3), drawn per frame: [${cutSeed.join(' ')}]`)
    const cutOff = await cutDrive({ seed: false })
    console.log(`[cut seed OFF] the same cut, drawn per frame: [${cutOff.join(' ')}]`)
  }

  // 1. the orbit, seed OFF vs seed ON (per-frame drawn)
  const off = await run({ mode: 'orbit', frames: 24, seed: false })
  console.log(`\n[orbit seed OFF] drawn per frame: [${off.trace.join(' ')}]`)
  const on = await run({ mode: 'orbit', frames: 24, seed: true })
  console.log(`[orbit seed ON ] drawn per frame: [${on.trace.join(' ')}] · carry ${on.seedState.on ? 'owns phase 1' : 'idle'}`)

  // 2. the static yaw sweep (is 4371 just a yaw the orbit passes?)
  const sweep = await run({ mode: 'sweep', yaws: [0.9, 0.905, 0.91, 0.915, 0.92, 0.925, 0.93, 0.95, 1.0], seed: true })
  console.log(`\n[static sweep, seed ON] ${sweep.trace.map(t => `${t.yaw}:${t.drawn}`).join(' · ')}`)
  const sweepOff = await run({ mode: 'sweep', yaws: [0.9, 0.92, 0.95], seed: false })
  console.log(`[static sweep, seed OFF] ${sweepOff.trace.map(t => `${t.yaw}:${t.drawn}`).join(' · ')}`)
} finally {
  await browser.close()
  server.stop(true)
}
