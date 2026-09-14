/**
 * scripts/task206-closecam.mjs — Task 206: THE CLOSE-CAMERA FIELD REPORT.
 *
 * «когда я камеру передвинул вплотную к ним так, что близкие боксы
 *  перекрывали почти весь экран, там все равно писалось, что рисуются
 *  тысячи боксов» — reproduce headless, then run the policy matrix at the
 *  guilty camera to find which leg under-culls.
 *
 * The direct-drive law (the ?bare=1 boot): no boot validation (minutes of
 * SwiftShader surface reads), the rAF loop pauses, and THIS script owns the
 * frame: renderTo(camera, policy) × frames → readStats() → surface.read().
 *
 * Usage: bun run scripts/task206-closecam.mjs [webgl2] — the WG snapshot
 * tier by default; `webgl2` boots the GL tier for the same close-camera
 * proof on the other backend.
 */
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const MODE_ARG = process.argv[2] === 'webgl2' ? 'webgl2' : 'webgpu'

const root = resolve(import.meta.dirname, '..')
const port = 8146
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
  const bootMode = await page.evaluate(() => ({ mode: window.__hizStats.mode, kind: window.__hizTier.kind, total: window.__hizStats.total }))
  console.log(`[boot] ${JSON.stringify(bootMode)} · the loop is paused, the probe owns the frame`)

  /** One config at one camera: frames × renderTo, then stats + coverage. */
  const drive = config => page.evaluate(async cfg => {
    const tier = window.__hizTier
    const t0 = performance.now()
    // the scene.js camera math, inlined (the same formulas, the same f32):
    // eye = orbit(yaw, pitch, dist) around [0, 5.5, 0], near 0.5, far 300
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
      tier.renderTo(tier.surface.targetId, mvp, eye, cfg.hiz, false, cfg.occluders, cfg.hysteresis === true, cfg.history === true, false, false)
    }
    const s = await tier.readStats()
    const img = await tier.surface.read()
    // Task 206 — THE CLOSE-CAMERA ON/OFF PIXEL PARITY (the boot validation
    // only rides the far VAL_CAMERAS; the field report lived HERE): hash the
    // surface bytes so the probe can compare Hi-Z ON vs OFF — a culled box
    // must never cost a pixel.
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

  // ── 1. the close-camera scan (dist 12 — the wheel's floor) ───────────────
  console.log('\n[scan] close cameras, the K policy (the boot default) — coverage = non-sky pixels; parity = Hi-Z ON vs OFF surface hash')
  const rows = []
  for (const [yaw, pitch] of [[0, -0.15], [0.4, -0.15], [0.8, -0.15], [1.57, -0.15], [3.14, -0.15], [0, -0.05], [0, 0.1]]) {
    const r = await drive({ yaw, pitch, dist: 12, frames: 2, hiz: 1, occluders: K })
    const off = await drive({ yaw, pitch, dist: 12, frames: 2, hiz: 0, occluders: K })
    r.parity = r.hash === off.hash ? 'IDENTICAL' : 'DIFFERS'
    rows.push({ yaw, pitch, ...r })
    console.log(`  yaw ${yaw.toFixed(2)} pitch ${pitch.toFixed(2)}: coverage ${r.coverage}% · drawn ${r.stats.drawn} · occluded ${r.stats.occluded} · frustum ${r.stats.frustum} · straddle ${r.stats.straddle} · ON/OFF ${r.parity} · ${r.ms}ms`)
  }
  const parityFails = rows.filter(r => r.parity !== 'IDENTICAL')
  console.log(`[scan] close-camera pixel parity: ${parityFails.length === 0 ? 'ALL IDENTICAL (7/7)' : `${parityFails.length} DIFFERS — a culled box cost a pixel`}`)
  rows.sort((a, b) => b.coverage - a.coverage)
  const guilty = rows[0]
  console.log(`\n[guilty] yaw ${guilty.yaw} pitch ${guilty.pitch} — coverage ${guilty.coverage}% · drawn ${guilty.drawn ?? guilty.stats.drawn}`)

  // ── 2. the policy matrix at the guilty camera ───────────────────────────
  console.log('\n[matrix] the policy matrix at the guilty camera')
  const matrix = [
    { name: 'A. K policy (boot default)', cfg: { occluders: K, hiz: 1, history: false } },
    { name: 'B. City occludes (occluders=N)', cfg: { occluders: N, hiz: 1, history: false } },
    { name: 'C. City occludes + History', cfg: { occluders: N, hiz: 1, history: true } },
    { name: 'D. History only', cfg: { occluders: K, hiz: 1, history: true } },
    { name: 'E. Hi-Z OFF (frustum only)', cfg: { occluders: K, hiz: 0, history: false } },
  ]
  for (const m of matrix) {
    const r = await drive({ yaw: guilty.yaw, pitch: guilty.pitch, dist: 12, frames: m.cfg.history ? 4 : 2, ...m.cfg })
    console.log(`  ${m.name}: drawn ${r.stats.drawn} · occluded ${r.stats.occluded} · frustum ${r.stats.frustum} · straddle ${r.stats.straddle} · coverage ${r.coverage}%`)
  }

  // ── 3. the reference far camera (the validation shape, for scale) ────────
  const far = await drive({ yaw: 0.55, pitch: 0.28, dist: 34, frames: 2, hiz: 1, occluders: K })
  console.log(`\n[reference] yaw 0.55 pitch 0.28 dist 34 (the validation camera): drawn ${far.stats.drawn} · occluded ${far.stats.occluded} · frustum ${far.stats.frustum} · coverage ${far.coverage}%`)

  const logText = await page.evaluate(() => document.querySelector('#log-list')?.textContent ?? '')
  console.log(`\n[health] page errors ${pageErrors.length} · log ${/FAILED|error/i.test(logText) ? 'DIRTY' : 'clean'}`)
  if (pageErrors.length) console.log(pageErrors.slice(0, 5).join('\n'))
} finally {
  await browser.close()
  server.stop(true)
}
