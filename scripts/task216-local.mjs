/**
 * scripts/task216-local.mjs — the LOCAL pre-deploy gate for Task 216
 * (THE FIRST-PERSON PARKOUR WALKER, both backends):
 *
 *   · THE BOOT — the page boots the tier with the TERRAIN EXTENSIONS (the
 *     surf dims + the terrain passes), the loop runs, the frame graph
 *     carries terrain-z-2 + terrain-color LIVE in a moving frame (the
 *     hills are the pyramid tile's base layer — the crowd's fill merges
 *     on top), the crowd is honestly culled (drawn < total).
 *
 *   · THE VALIDATION — the page's own deterministic autopilot walks the
 *     course (a fixed 1/60, geometry-driven script) and asserts its laws
 *     LIVE: the settle, the hop chain, the 10-step staircase (the step-up
 *     law), the elevator ride (the carry law), the feet ≡ oracle law, the
 *     culling law, the upload law (the movers' dirty ranges), the A6
 *     shape law (a still camera swaps the fill for the depth-harvest),
 *     the scale law (the governor steps under sustained load), the pixels
 *     law, zero errors. The gate waits on the page's promise and asserts
 *     EVERY check.
 *
 *   · THE SCALE HOOK — tier.setRenderScale: the WG leg boots SwiftShader
 *     → SNAPSHOT mode → the hook answers null (the documented no-op); the
 *     GL leg boots LIVE → the hook re-derives the canvas backing store
 *     (the renderer's setDpr path — the adaptive ladder's engine side).
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
  console.log(`[216] ${name}: ${ok ? 'PASS' : 'FAIL'}${detail ? ` · ${detail}` : ''}`)
  if (!ok) failures++
}

function serve(port) {
  return Bun.serve({
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
}

async function walkerLeg(mode) {
  console.log(`[216] walker leg ${mode}: goto…`)
  const server = serve(8941)
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 200)}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`) })
  await page.goto(`http://localhost:8941/demo/walker/?crowd=1500${mode === 'webgl2' ? '&mode=webgl2' : ''}`, { waitUntil: 'networkidle', timeout: 90_000 })

  // (a) THE BOOT + THE MOVING FRAME: the graph carries the terrain passes
  //     (read at a WALKING frame — the settle frames are still-camera A6
  //     frames, a different honest shape)
  await page.waitForFunction(() => window.__walker && window.__walker.frame > 100 && window.__walker.drawn > 0, null, { timeout: 240_000 })
  const boot = await page.evaluate(() => ({
    stats: window.__walker,
    graph: window.__walkerTier !== undefined ? window.__walkerTier.graphStats() : null,
  }))
  check(`[${mode}] the boot — the loop runs, the crowd culled`, boot.stats.drawn > 30 && boot.stats.drawn < boot.stats.total, `drawn=${boot.stats.drawn}/${boot.stats.total}`)
  const live = boot.graph !== null ? boot.graph.live : []
  check(`[${mode}] the terrain passes live in the moving frame`, live.includes('terrain-color') && live.includes('terrain-z-2') && live.includes('feedback-fill'), `live: ${live.join(',')}`)
  check(`[${mode}] the seed carries phase 1 (the boot warm-up left the frame)`, !live.includes('z-fill') && !live.includes('terrain-z') || live.includes('terrain-z-2'), `live: ${live.join(',')}`)

  // (b) THE VALIDATION: the autopilot's own promise (the full law list)
  const verdict = await page.evaluate(() => window.__walkerGate)
  check(`[${mode}] the validation promise resolved`, verdict !== null && verdict !== undefined && Array.isArray(verdict.checks), '')
  for (const c of verdict.checks) {
    check(`[${mode}] law: ${c.name}`, c.pass, c.detail)
  }
  check(`[${mode}] the validation verdict`, verdict.pass === true, `${verdict.checks.filter(c => c.pass).length}/${verdict.checks.length} laws`)

  // (c) THE SCALE HOOK: WG snapshot legs answer null (the fixed surface);
  //    GL live legs re-derive the canvas backing store
  const scaleProbe = await page.evaluate(() => {
    const t = window.__walkerTier
    const kind = t.kind
    const before = t.canvas !== null ? { w: t.canvas.width, h: t.canvas.height } : null
    const applied = t.setRenderScale(0.5)
    const after = t.canvas !== null ? { w: t.canvas.width, h: t.canvas.height } : null
    return { kind, before, applied, after }
  })
  if (scaleProbe.kind === 'snapshot') {
    check(`[${mode}] setRenderScale — the snapshot leg's honest null`, scaleProbe.applied === null, `kind=${scaleProbe.kind}`)
  } else {
    check(`[${mode}] setRenderScale — the live leg re-derives the backing store`,
      scaleProbe.applied !== null && scaleProbe.after.w < scaleProbe.before.w,
      `${scaleProbe.before.w}x${scaleProbe.before.h} → ${scaleProbe.after.w}x${scaleProbe.after.h}`)
    const restored = await page.evaluate(() => window.__walkerTier.setRenderScale(1))
    check(`[${mode}] setRenderScale — restored`, restored !== null, '')
  }

  // (d) the loop alive + zero errors after everything
  const frameA = await page.evaluate(() => window.__walker.frame)
  await page.waitForTimeout(1200)
  const frameB = await page.evaluate(() => window.__walker.frame)
  check(`[${mode}] the loop alive after the gate's probes`, frameB > frameA, `${frameA}→${frameB}`)
  check(`[${mode}] zero page errors`, errors.length === 0, errors.slice(0, 3).join(' | '))

  await page.close()
  server.stop(true)
}

await walkerLeg('webgpu')
await walkerLeg('webgl2')

await browser.close()
console.log('')
if (failures === 0) {
  console.log('[216] ALL PASS — the walker demo holds on both backends')
  process.exit(0)
}
console.log(`[216] ${failures} FAILURES`)
process.exit(1)
