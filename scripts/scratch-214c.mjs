// scratch-214c.mjs — is the pyramid a fixed point across identical frames?
import { chromium } from 'playwright'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const port = 8923
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
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
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
const errors = []
page.on('pageerror', e => errors.push(e.message.slice(0, 200)))
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })
await page.goto(`http://localhost:${port}/demo/occlusion/?bare=1`, { waitUntil: 'networkidle', timeout: 90_000 })
await page.waitForFunction(() => window.__hizStats && window.__hizStats.drawn > 0, null, { timeout: 240_000 })
await page.waitForTimeout(500)

const report = await page.evaluate(async () => {
  window.__hizCtl.pause()
  try {
    const t = window.__hizTier
    // a fixed camera: settle twice, then read the pyramid + drawn twice
    const cam = window.__hizCam
    cam.auto = 0
    // the demo's own camera helper is not exported; drive renderTo with the
    // CURRENT camera state by reading the tier's last frame? — the demo
    // exposes __hizCam; use its yaw/pitch/dist through the internal
    // cameraAt… not exported. Instead: reuse the loop's own last camera by
    // rendering with the same mvp twice — grab it via __hizStats? Not
    // exposed. FALLBACK: drive renderTo with a FIXED mvp we compute here.
    const out = {}
    const readPyramid = async () => {
      const p = await window.__hizDebug // the WG debug channel
      // read ALL the words through the parity channel (it reads the full storage)
      return await window.__hizTier.spdParity()
    }
    // use the tier's renderTo with a simple fixed camera (the probe scripts'
    // own spelling): identity-ish view matrix
    const mvp = new Float32Array(16)
    // perspective fov 60°, aspect 16/9
    const f = 1 / Math.tan(Math.PI / 6)
    mvp[0] = f / (16 / 9); mvp[5] = f; mvp[10] = 0.02; mvp[11] = -1; mvp[14] = -0.02 * 0.1
    // camera at (0, 8, 40) looking at origin
    mvp[12] = 0; mvp[13] = -0.2; mvp[15] = 0
    const eye = [0, 8, 40]
    // settle ×2 (feedback on, seed on)
    t.renderTo(t.surface.targetId, mvp, eye, 1, false, 23, false, false, false, true, true, true, true)
    t.renderTo(t.surface.targetId, mvp, eye, 1, false, 23, false, false, false, true, true, true, true)
    out.settle = await t.readStats()
    const p1 = await readPyramid()
    out.p1 = { words: p1?.words, diffs: p1?.diffs, pass: p1?.pass }
    // two MORE identical frames — the fixed point law: the pyramid must not move
    t.renderTo(t.surface.targetId, mvp, eye, 1, false, 23, false, false, false, true, true, true, true)
    out.f1 = await t.readStats()
    t.renderTo(t.surface.targetId, mvp, eye, 1, false, 23, false, false, false, true, true, true, true)
    out.f2 = await t.readStats()
    const p2 = await readPyramid()
    out.p2 = { words: p2?.words, diffs: p2?.diffs, pass: p2?.pass }
    return out
  } finally { window.__hizCtl.resume() }
})
console.log(JSON.stringify(report, null, 1))
console.log('errors:', errors.length, errors.slice(0, 3))
await browser.close(); server.stop(true)
