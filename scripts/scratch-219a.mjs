/**
 * scripts/scratch-219a.mjs — Task 219 E1: THE ISOLATION MATRIX driver.
 * One fresh browser per scenario (a present-death kills the page's GPU
 * connection — the fresh process is the isolation). Scenarios on the
 * scratch page (s1..s4) + the full tier live (s5 — the walker ?live=1).
 */
import { chromium } from 'playwright'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const port = 8199
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

const ARGS = ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader']

async function runScenario(name, url, readout) {
  const browser = await chromium.launch({ headless: true, args: ARGS })
  let result = null
  try {
    const page = await browser.newPage()
    page.on('console', m => { const t = m.text(); if (/error|lost|died|warning/i.test(t)) console.log(`  [${name} console] ${t.slice(0, 160)}`) })
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    result = await readout(page)
  } catch (e) {
    result = { crash: e instanceof Error ? e.message : String(e) }
  } finally {
    // a present-death kills the GPU connection — browser.close() can hang
    // forever after it; race it and force-kill the process
    await Promise.race([browser.close(), new Promise(r => setTimeout(r, 8000))])
    try { browser.process()?.kill('SIGKILL') } catch { /* already gone */ }
  }
  console.log(`[${name}] ${JSON.stringify(result)}`)
  return result
}

// s1..s4 — the scratch matrix (one scenario per process — a present-death's
// force-kill can take the driver process down with it; bash sequences them)
const ONLY = process.env.ISO_ONLY ?? ''
const ALL = ['s1', 's2', 's3', 's4']
for (const s of ONLY !== '' && ONLY !== 's5' ? [ONLY] : ONLY === '' ? ALL : []) {
  await runScenario(s, `http://localhost:${port}/scripts/scratch-219a-isolate.html?s=${s}&n=40`, async page => {
    const t0 = Date.now()
    while (Date.now() - t0 < 20000) {
      const done = await page.evaluate(() => window.__iso?.done === true)
      if (done) return await page.evaluate(() => ({ ...window.__iso, errors: window.__iso.errors.slice(0, 4) }))
      const dead = await page.evaluate(() => window.__iso === undefined)
      if (dead) return { pageDead: true }
      await new Promise(r => setTimeout(r, 400))
    }
    return await page.evaluate(() => ({ ...window.__iso, timeout: true, errors: (window.__iso?.errors ?? []).slice(0, 4) })).catch(e => ({ crash: String(e) }))
  })
}

// s5 — the full tier, live canvas, as deployed (the known-death baseline)
if (ONLY === '' || ONLY === 's5') await runScenario('s5-tier-live', `http://localhost:${port}/demo/walker/index.html?mode=webgpu&live=1&bare=1&crowd=512`, async page => {
  await new Promise(r => setTimeout(r, 6000))
  return await page.evaluate(() => {
    const w = window.__walker ?? {}
    const c = document.getElementById('hiz-canvas')
    const probe = document.createElement('canvas'); probe.width = 16; probe.height = 16
    let avg = -1, lit = -1
    try {
      const x = probe.getContext('2d', { willReadFrequently: true })
      x.clearRect(0, 0, 16, 16); x.drawImage(c, 0, 0, 16, 16)
      const d = x.getImageData(0, 0, 16, 16).data
      let sum = 0; lit = 0
      for (let k = 3; k < d.length; k += 4) { sum += d[k]; if (d[k] >= 8) lit++ }
      avg = +(sum / 64).toFixed(1)
    } catch { /* read refused */ }
    return { frame: w.frame, kind: w.kind, drawn: w.drawn, probeAvg: avg, probeLit: lit, errs: (window.__walkerErrs ?? []).slice(0, 5) }
  }).catch(e => ({ crash: String(e) }))
})

server.stop(true)
process.exit(0)
