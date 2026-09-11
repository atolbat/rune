// task175 — THE DEMO PROFILE PASS. The optimization program has been
// benchmark-first since Task 143; this pass re-measures the FIELD (the
// actual demo pages, the actual frame loops) to find where @rune CPU
// time goes NOW, after the Task 163-174 passes:
//   scenarios (each: boot → settle → 5s CDP sampling profile → save):
//     vfx-embers-gl   the GPU Embers demo on WebGL2 (TF tier, 16k patch)
//     vfx-embers-wg   the same on WebGPU (compute tier, 16k patch)
//     mv-samba-wg     model-viewer samba on WebGPU (the skinned path —
//                     the 4448-byte bone UBO of the Task-141 field report)
//     particles-gl    the particles soup demo on WebGL2 (draw:'instance')
//     particles-wg    the same on WebGPU
//   then the scan: self-time aggregated per function across OUR frames
//   (dist/rune*.esm.js) and the overall top for context.
// The SwiftShader GPU-process flake (task131/173 lesson) is handled by
// retrying whole page loads — a dead requestDevice must not read as a
// hotspot of zero.
// Usage: bun scripts/task175-profile.mjs
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'

const root = '/home/z/my-project/rune'
const port = Number(process.env.TASK175_PORT ?? 8175)
const OUT = '/tmp/prof175'
mkdirSync(OUT, { recursive: true })

const GL_ARGS = ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader']
const WG_ARGS = ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader']
const EMERS_INDEX = 23

const server = Bun.serve({
  port,
  async fetch(request) {
    let pathname = decodeURIComponent(new URL(request.url).pathname)
    if (pathname === '/') pathname = '/demo/'
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = Bun.file(`${root}${pathname}`)
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    const ext = pathname.slice(pathname.lastIndexOf('.'))
    const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }
    let body = await file.text()
    // one 16k patch on BOTH backends — the CPU sides compare apples to apples
    if (pathname.endsWith('demos/gpuEmbers.js')) {
      body = body
        .replace(/const GPU_CAPACITY = 160_000/, 'const GPU_CAPACITY = 16000')
        .replace(/const TF_CAPACITY = SOFTWARE_GL \? 16_000 : 160_000/, 'const TF_CAPACITY = 16000')
    }
    return new Response(body, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

const problems = []

async function bootPage(browser, url, { backend, settle = 2500, profileMs = 5000, label }) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } })
    const errors = []
    page.on('pageerror', e => errors.push(`PAGEERROR: ${e.message.slice(0, 160)}`))
    page.on('console', m => { if (m.type() === 'error') errors.push(`CONSOLE: ${m.text().slice(0, 160)}`) })
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 45_000 })
      if (backend) {
        await page.evaluate((b) => {
          const radio = document.querySelector(`input[name="rd-mode"][value="${b}"]`)
          if (radio != null) radio.click()
        }, backend)
        await page.waitForFunction(
          (b) => {
            const t = (document.querySelector('#backend')?.textContent ?? '')
            return b === 'webgpu' ? t.startsWith('WebGPU') : t === 'WebGL2'
          },
          backend,
          { timeout: 90_000 },
        )
        // the sheet that the backend switch opens overlays the arrows —
        // the task167 lesson: close it before anything else
        await page.evaluate(() => { document.querySelector('.pt-close')?.click() })
      }
      await page.waitForTimeout(settle)
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Profiler.enable')
      await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
      await cdp.send('Profiler.start')
      await page.waitForTimeout(profileMs)
      const { profile: prof } = await cdp.send('Profiler.stop')
      writeFileSync(`${OUT}/${label}.cpuprofile`, JSON.stringify(prof))
      const pill = await page.textContent('.pt-pill').catch(() => null)
      const stats = await page.textContent('.mv-stats').catch(() => null)
      const wallMs = (prof.timeDeltas ?? []).reduce((s, d) => s + (d > 0 ? d : 0), 0) / 1000
      console.log(`[task175] ${label}: ${prof.samples.length} samples (${wallMs.toFixed(1)}s wall) attempt ${attempt}`)
      if (pill) console.log(`[task175]   pill: ${pill.trim()}`)
      if (stats) console.log(`[task175]   stats: ${stats.trim().slice(0, 120)}`)
      if (errors.length) { console.log(`[task175]   errors (${errors.length}):`); for (const e of errors.slice(0, 5)) console.log(`    ${e}`); problems.push(`${label}: ${errors.length} errors`) }
      await page.close()
      return true
    } catch (e) {
      console.log(`[task175] ${label} attempt ${attempt} failed: ${e.message.slice(0, 140)}`)
      await page.close().catch(() => {})
      if (attempt === 3) { problems.push(`${label}: BOOT FAILED — ${e.message.slice(0, 100)}`); return false }
    }
  }
}

async function walkToEmbers(page) {
  for (let i = 0; i < EMERS_INDEX; i++) {
    // $eval-click: the handler runs directly — no actionability wait that
    // an animating carousel or an overlay can stall for 30s
    await page.$eval('.pt-arrow:last-child', el => el.click())
    await page.waitForFunction(
      () => / · [1-9][\d,]* particles · [1-9][\d,]* verts/.test(document.querySelector('.pt-pill')?.textContent ?? ''),
      null,
      { timeout: 20_000 },
    )
  }
  await page.waitForFunction(
    () => (document.querySelector('.pt-pill')?.textContent ?? '').includes('GPU Embers'),
    null,
    { timeout: 20_000 },
  )
}

// vfx embers needs the carousel walk — a dedicated boot (the walk is not
// retry-cheap, so the walk lives INSIDE the attempt loop's page)
async function bootEmbers(browser, backend, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } })
    try {
      await page.goto(`http://localhost:${port}/demo/vfx/`, { waitUntil: 'networkidle', timeout: 45_000 })
      await page.waitForFunction(() => document.querySelector('.pt-pill')?.textContent, null, { timeout: 30_000 })
      await page.evaluate((b) => {
        const radio = document.querySelector(`input[name="rd-mode"][value="${b}"]`)
        if (radio != null) radio.click()
      }, backend)
      await page.waitForFunction(
        (b) => {
          const t = (document.querySelector('#backend')?.textContent ?? '')
          return b === 'webgpu' ? t.startsWith('WebGPU') : t === 'WebGL2'
        },
        backend,
        { timeout: 90_000 },
      )
      await page.evaluate(() => { document.querySelector('.pt-close')?.click() })
      await walkToEmbers(page)
      await page.waitForTimeout(2500)
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Profiler.enable')
      await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
      await cdp.send('Profiler.start')
      await page.waitForTimeout(5000)
      const { profile: prof } = await cdp.send('Profiler.stop')
      writeFileSync(`${OUT}/${label}.cpuprofile`, JSON.stringify(prof))
      const pill = await page.textContent('.pt-pill')
      const wallMs = (prof.timeDeltas ?? []).reduce((s, d) => s + (d > 0 ? d : 0), 0) / 1000
      console.log(`[task175] ${label}: ${prof.samples.length} samples (${wallMs.toFixed(1)}s wall) attempt ${attempt}`)
      console.log(`[task175]   pill: ${pill.trim()}`)
      await page.close()
      return true
    } catch (e) {
      console.log(`[task175] ${label} attempt ${attempt} failed: ${e.message.slice(0, 140)}`)
      await page.close().catch(() => {})
      if (attempt === 3) { problems.push(`${label}: BOOT FAILED — ${e.message.slice(0, 100)}`); return false }
    }
  }
}

async function bootSamba(browser, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } })
    const errors = []
    page.on('pageerror', e => errors.push(`PAGEERROR: ${e.message.slice(0, 160)}`))
    try {
      await page.goto(`http://localhost:${port}/demo/model-viewer/`, { waitUntil: 'networkidle', timeout: 45_000 })
      await page.evaluate(() => {
        const radio = document.querySelector('input[name="rd-mode"][value="webgpu"]')
        if (radio != null) radio.click()
      })
      await page.waitForFunction(() => (document.querySelector('#backend')?.textContent ?? '').startsWith('WebGPU'), null, { timeout: 90_000 })
      await page.click('.mv-load')
      await page.waitForFunction(() => (document.querySelector('.mv-stats')?.textContent ?? '').includes('verts'), null, { timeout: 60_000 })
      await page.click('.mv-pill')
      await page.click('.mv-rows .mv-row:nth-child(2)')
      await page.waitForFunction(() => (document.querySelector('.mv-load')?.textContent ?? '').includes('Load'), null, { timeout: 60_000 })
      await page.click('.mv-load')
      await page.waitForFunction(() => (document.querySelector('.mv-stats')?.textContent ?? '').includes('joints'), null, { timeout: 60_000 })
      await page.waitForTimeout(2500)
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Profiler.enable')
      await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
      await cdp.send('Profiler.start')
      await page.waitForTimeout(5000)
      const { profile: prof } = await cdp.send('Profiler.stop')
      writeFileSync(`${OUT}/${label}.cpuprofile`, JSON.stringify(prof))
      const stats = await page.textContent('.mv-stats')
      console.log(`[task175] ${label}: ${prof.samples.length} samples (${(prof.samples.length * 0.2).toFixed(1)}s wall) attempt ${attempt}`)
      console.log(`[task175]   stats: ${stats.trim().slice(0, 120)}`)
      if (errors.length) { console.log(`[task175]   errors (${errors.length}):`); for (const e of errors.slice(0, 5)) console.log(`    ${e}`); problems.push(`${label}: ${errors.length} errors`) }
      await page.close()
      return true
    } catch (e) {
      console.log(`[task175] ${label} attempt ${attempt} failed: ${e.message.slice(0, 140)}`)
      await page.close().catch(() => {})
      if (attempt === 3) { problems.push(`${label}: BOOT FAILED — ${e.message.slice(0, 100)}`); return false }
    }
  }
}

// TASK175_LEG: gl | wg | all (default all) — the WG boots are slow enough
// that the legs are runnable apart when time-boxed
const leg = process.env.TASK175_LEG ?? 'all'

if (leg === 'gl' || leg === 'all') {
  // ── leg A: the WebGL2 browser ─────────────────────────────────────────
  const glBrowser = await chromium.launch({ headless: true, args: GL_ARGS })
  await bootEmbers(glBrowser, 'webgl2', 'vfx-embers-gl')
  await bootPage(glBrowser, `http://localhost:${port}/demo/particles/`, { backend: 'webgl2', label: 'particles-gl' })
  await glBrowser.close()
}

if (leg === 'wg' || leg === 'all') {
  // ── leg B: the WebGPU browser ─────────────────────────────────────────
  const wgBrowser = await chromium.launch({ headless: true, args: WG_ARGS })
  await bootEmbers(wgBrowser, 'webgpu', 'vfx-embers-wg')
  await bootSamba(wgBrowser, 'mv-samba-wg')
  await bootPage(wgBrowser, `http://localhost:${port}/demo/particles/`, { backend: 'webgpu', label: 'particles-wg' })
  await wgBrowser.close()
}
server.stop()

// ── the scan: self-time per function, OUR frames vs the world ─────────────
import { readdirSync, readFileSync } from 'node:fs'
console.log('\n━━━ THE SCAN (self-time per function) ━━━')
for (const f of readdirSync(OUT).filter(n => n.endsWith('.cpuprofile')).sort()) {
  const p = JSON.parse(readFileSync(`${OUT}/${f}`, 'utf8'))
  const byId = new Map()
  for (const n of p.nodes) byId.set(n.id, n)
  const self = new Map()
  let totalUs = 0
  for (let i = 0; i < p.samples.length; i++) {
    const dt = p.timeDeltas ? p.timeDeltas[i] : 0
    const us = dt > 0 ? dt : 0
    totalUs += us
    self.set(p.samples[i], (self.get(p.samples[i]) ?? 0) + us)
  }
  const rows = [...self.entries()].map(([id, us]) => {
    const n = byId.get(id)
    if (!n) return null
    const cf = n.callFrame
    const url = (cf.url || '').replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '')
    return { name: cf.functionName || '(anon)', url, us }
  }).filter(Boolean)
  const ours = rows.filter(r => /\/dist\/rune/.test(r.url))
  const ourUs = ours.reduce((s, r) => s + r.us, 0)
  console.log(`\n── ${f}: ${(totalUs / 1000).toFixed(0)} ms wall, OUR code ${(ourUs / 1000).toFixed(1)} ms (${(100 * ourUs / Math.max(totalUs, 1)).toFixed(1)}%) ──`)
  const byFn = new Map()
  for (const r of ours) {
    const key = `${r.name}  ${r.url.replace(/.*\//, '')}`
    byFn.set(key, (byFn.get(key) ?? 0) + r.us)
  }
  for (const [k, us] of [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`    ${(us / 1000).toFixed(2).padStart(8)} ms  ${k}`)
  }
  const byWorld = new Map()
  for (const r of rows) {
    const key = `${r.name || '(anon)'}  ${r.url.replace(/.*\//, '')}`
    byWorld.set(key, (byWorld.get(key) ?? 0) + r.us)
  }
  console.log(`    · · · overall top · · ·`)
  for (const [k, us] of [...byWorld.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log(`    ${(us / 1000).toFixed(2).padStart(8)} ms  ${k}`)
  }
}

console.log('\n━━━ PROBLEMS ━━━')
console.log(problems.length ? problems.map(p => `  ! ${p}`).join('\n') : '  none — all five scenarios booted clean')
process.exit(problems.length ? 1 : 0)
