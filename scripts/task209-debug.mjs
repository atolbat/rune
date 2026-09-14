/**
 * scripts/task209-debug.mjs — the Task-209 stethoscope: serves the repo,
 * loads the occlusion demo, and (per --mode) either awaits the probe gate
 * (?probe=1) or samples the live loop's steady state (?bare=1).
 * Usage: bun scripts/task209-debug.mjs [webgpu|webgl2] [probe|bare]
 */
import { resolve } from 'node:path'
import { writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const port = 8157
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }
const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url)
    const path = url.pathname === '/' ? '/demo/occlusion/index.html' : decodeURIComponent(url.pathname)
    const file = Bun.file(root + path)
    if (await file.exists()) return new Response(file, { headers: { 'content-type': MIME[path.slice(path.lastIndexOf('.'))] ?? 'text/plain' } })
    return new Response('nope', { status: 404 })
  },
})

const backend = process.argv[2] ?? 'webgpu'
const mode = process.argv[3] ?? 'probe'
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage()
page.on('console', m => { if (m.type() === 'error' || /WGSL|rejected|rune:/.test(m.text())) console.log(`[${m.type()}] ${m.text().slice(0, 500)}`) })
page.on('pageerror', e => console.log(`[pageerror] ${String(e).slice(0, 300)}`))
try {
  await page.goto(`http://localhost:${port}/demo/occlusion/index.html?${mode === 'probe' ? 'probe=1' : 'bare=1'}&mode=${backend}`, { waitUntil: 'domcontentloaded' })
  let v
  if (mode === 'probe') {
    await page.waitForFunction(() => window.__hizGate ?? null, null, { timeout: 120000 })
    v = await page.evaluate(() => window.__hizGate)
  } else {
    await new Promise(r => setTimeout(r, 30000))
    v = await page.evaluate(() => {
      const s = window.__hizStats
      return { drawn: s.drawn, occluded: s.occlusionCulled, frustum: s.frustumCulled, ms: +s.msAvg.toFixed(2), seed: s.seed, stale: s.seedStale, dispatches: s.dispatches }
    })
  }
  writeFileSync('/tmp/task209-gate.json', JSON.stringify(v))
  console.log('GATE-FILE: /tmp/task209-gate.json')
  console.log(JSON.stringify(v).slice(0, 600))
} catch (e) {
  console.log('FAIL:', String(e).slice(0, 300))
} finally {
  await browser.close(); server.stop(true)
}
