/**
 * scripts/task208-occlsmoke.mjs — Task 208's targeted occlusion smoke: the
 * full demo-smoke OCCLUSION LEGS only (the WG snapshot leg + the GL leg),
 * verbatim — the rest of the suite's demos are untouched by the Task-208
 * change set (demo/occlusion/{main,tier,index}.html + the index/README
 * cards), and the full suite's other legs ran green in Task 207's round.
 * The legs here are the ones that exercise the new code: the boot
 * validation now carries the x-seed gate (fixed point, fill collapse,
 * graph shape, motion soundness) on BOTH backends.
 *
 * Run: bun run scripts/task208-occlsmoke.mjs
 */
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const port = 8149
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
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

const hizBrowser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})
let ok = true
try {
  // ── the WG leg (the smoke's own checks, verbatim) ──────────────────────
  {
    const hizPage = await hizBrowser.newPage({ viewport: { width: 960, height: 720 } })
    const hizPageErrors = []
    hizPage.on('pageerror', e => hizPageErrors.push(String(e)))
    await hizPage.goto(`http://localhost:${port}/demo/occlusion/`, { waitUntil: 'networkidle' })
    const hizStats = await hizPage.waitForFunction(
      () => (window.__hizStats && window.__hizStats.validation !== null && window.__hizStats.drawn > 0 ? window.__hizStats : undefined),
      null,
      { timeout: 420_000 },
    ).then(h => h.jsonValue())
    const hizSnapshot = hizStats?.mode === 'snapshot'
    const hizValidation = hizStats?.validation?.pass === true
    const hizDrawn = (hizStats?.drawn ?? 0) > 0
    const hizCulled = (hizStats?.occlusionCulled ?? 0) > 0
    const seedOn = hizStats?.seed === 1
    console.log(
      `[smoke] occlusion: mode ${hizStats?.mode}, validation ${hizValidation ? 'PASS' : 'FAIL'}, ` +
      `drawn ${hizStats?.drawn}/${hizStats?.total}, occluded ${hizStats?.occlusionCulled}, seed ${seedOn ? 'ON' : 'OFF'}, errors ${hizStats?.errors?.length ?? '?'}`,
    )
    const hizLogText = await hizPage.evaluate(() => document.querySelector('#log-list')?.textContent ?? '')
    const hizGpuClean = !/rendering stopped|GPU: |failed/i.test(hizLogText) && hizPageErrors.length === 0
    const xSeedLine = hizLogText.includes('cross-frame seed @dist 12') && /cross-frame seed @dist 12[^\n]*PASS/.test(hizLogText)
    console.log(`[smoke] occlusion WG: gpuClean ${hizGpuClean ? 'yes' : 'NO'} · the x-seed gate line ${xSeedLine ? 'PASS' : 'MISSING/FAIL'}`)
    if (!hizSnapshot || !hizValidation || !hizDrawn || !hizCulled || !hizGpuClean || hizPageErrors.length > 0 || !xSeedLine || !seedOn) {
      ok = false
      console.log(`[smoke] WG sub-flags: snapshot ${hizSnapshot} validation ${hizValidation} drawn ${hizDrawn} culled ${hizCulled} gpuClean ${hizGpuClean} seed ${seedOn} xSeedLine ${xSeedLine} (pageErrors ${hizPageErrors.length})`)
      if (hizPageErrors.length) console.log(hizPageErrors.slice(0, 3).join('\n'))
      // dump the failing gate lines for the diagnosis
      const bad = hizLogText.split('\n').filter(l => /FAILED|error/i.test(l)).slice(0, 8)
      if (bad.length) console.log('  failing lines:\n  ' + bad.join('\n  '))
    }
    await hizPage.close()
  }

  // ── the GL leg (verbatim) ──────────────────────────────────────────────
  {
    const glPage = await hizBrowser.newPage({ viewport: { width: 960, height: 720 } })
    const glPageErrors = []
    glPage.on('pageerror', e => glPageErrors.push(String(e)))
    await glPage.goto(`http://localhost:${port}/demo/occlusion/?mode=webgl2`, { waitUntil: 'networkidle' })
    const glStats = await glPage.waitForFunction(
      () => (window.__hizStats && window.__hizStats.validation !== null && window.__hizStats.drawn > 0 ? window.__hizStats : undefined),
      null,
      { timeout: 420_000 },
    ).then(h => h.jsonValue())
    const glValidation = glStats?.validation?.pass === true
    const glWired = await glPage.evaluate(() => {
      const el = document.querySelector('#hiz-canvas')
      return el !== null && el.getContext('webgl2') !== null
    })
    const glLogText = await glPage.evaluate(() => document.querySelector('#log-list')?.textContent ?? '')
    const glClean = !/rendering stopped|frame error|GL error|failed/i.test(glLogText) && glPageErrors.length === 0
    const glSeedLine = glLogText.includes('cross-frame seed @dist 12') && /cross-frame seed @dist 12[^\n]*PASS/.test(glLogText)
    console.log(
      `[smoke] occlusion GL: validation ${glValidation ? 'PASS' : 'FAIL'}, ` +
      `drawn ${glStats?.drawn}/${glStats?.total}, occluded ${glStats?.occlusionCulled}, seed ${glStats?.seed === 1 ? 'ON' : 'OFF'}, wiring ${glWired ? 'ok' : 'DEAD'}, log ${glClean ? 'clean' : 'DIRTY'}, x-seed line ${glSeedLine ? 'PASS' : 'MISSING/FAIL'}`,
    )
    if (!glValidation || !glWired || !glClean || glPageErrors.length > 0 || !glSeedLine) {
      ok = false
      console.log(`[smoke] GL sub-flags: validation ${glValidation} wiring ${glWired} clean ${glClean} xSeedLine ${glSeedLine} (pageErrors ${glPageErrors.length})`)
      if (glPageErrors.length) console.log(glPageErrors.slice(0, 3).join('\n'))
      const bad = glLogText.split('\n').filter(l => /FAILED|error/i.test(l)).slice(0, 8)
      if (bad.length) console.log('  failing lines:\n  ' + bad.join('\n  '))
    }
    await glPage.close()
  }
} finally {
  await hizBrowser.close()
  server.stop(true)
}
console.log(`[smoke] task208-occlsmoke ${ok ? 'PASS' : 'FAIL'}`)
process.exit(ok ? 0 : 1)
