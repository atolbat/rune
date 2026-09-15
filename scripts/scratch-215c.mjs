import { chromium } from 'playwright'
import { join } from 'node:path'
const root = join(import.meta.dirname, '..')
const port = 8935
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const server = Bun.serve({ port, async fetch(request) {
  const url = new URL(request.url)
  let pathname = decodeURIComponent(url.pathname)
  if (pathname.endsWith('/')) pathname += 'index.html'
  const file = Bun.file(join(root, pathname))
  if (!(await file.exists())) return new Response('not found', { status: 404 })
  const ext = pathname.slice(pathname.lastIndexOf('.'))
  return new Response(file, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
}})
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
page.on('pageerror', e => console.log('[pageerror]', e.message.slice(0, 200)))
page.on('console', m => { if (m.type() === 'error') console.log('[console:error]', m.text().slice(0, 200)) })
await page.goto(`http://localhost:${port}/demo/occlusion/?bare=1`, { waitUntil: 'networkidle', timeout: 90_000 })
await page.waitForFunction(() => window.__hizStats && window.__hizStats.drawn > 0, null, { timeout: 240_000 })
const out = await page.evaluate(async () => {
  window.__hizCtl.pause()
  try {
    const t = window.__hizTier
    // a still camera, driven directly: frame A (move), frames B..D (still)
    const eye = [0, 30, 60]
    const f = 1 / Math.tan(Math.PI / 6)
    const nf = 1 / (0.5 - 300)
    const proj = new Float32Array([f / (16 / 9), 0, 0, 0, 0, f, 0, 0, 0, 0, 300 * nf, -1, 0, 0, 300 * 0.5 * nf, 0])
    const lookAt = (e) => {
      let fx = -e[0], fy = -e[1], fz = -e[2]
      let l = Math.hypot(fx, fy, fz); fx /= l; fy /= l; fz /= l
      const rx = fy * 0 - fz * 1, ry = 0, rz = fx * 1 - fy * 0
      const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx
      return new Float32Array([
        rx, ux, -fx, 0, ry, uy, -fy, 0, rz, uz, -fz, 0,
        -(rx * e[0] + ry * e[1] + rz * e[2]),
        -(ux * e[0] + uy * e[1] + uz * e[2]),
        fx * e[0] + fy * e[1] + fz * e[2], 1,
      ])
    }
    const mul = (a, b) => {
      const out = new Float32Array(16)
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        let s = 0
        for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]
        out[c * 4 + r] = s
      }
      return out
    }
    const mvpA = mul(proj, lookAt([0, 30, 60]))
    const mvpB = mul(proj, lookAt([0, 30, 61])) // a different camera first
    const seq = []
    const drive = (mvp, label, reuse) => {
      t.renderTo(t.surface.targetId, mvp, eye, 1, false, 23, false, false, false, false, true, true, true, reuse)
      seq.push({ label, live: window.__hizTier.graphStats().live })
    }
    drive(mvpB, 'move-1', true)
    drive(mvpA, 'still-2 (reuse ON)', true)
    drive(mvpA, 'still-3 (reuse ON)', true)
    drive(mvpA, 'still-4 (reuse OFF)', false)
    return seq
  } finally { window.__hizCtl.resume() }
})
console.log(JSON.stringify(out, null, 1))
await browser.close(); server.stop(true)
