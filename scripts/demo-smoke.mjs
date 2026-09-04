/**
 * scripts/demo-smoke.mjs — headless check of the demos (run via bun).
 *
 * Starts a static server and verifies THE DEMO STANDARD in headless
 * Chromium (SwiftShader — software WebGL2):
 *
 * hello-cube (/demo/hello-cube/):
 *   1. the backend badge is filled (WebGPU or WebGL2);
 *   2. the animation is alive (two canvas screenshots differ);
 *   3. Pause freezes the frames, Resume brings them back;
 *   4. the backend toggle: forcing WebGL2 → the badge says "WebGL2",
 *      forcing WebGPU → the badge starts with "WebGPU" (works, or an
 *      honest refusal in the log);
 *   5. exactly one canvas per boot.
 *
 * model-viewer (/demo/model-viewer/):
 *   6. the "Load & show" button starts loading with a progress bar;
 *   7. the scene appears (mesh stats), the animation is alive;
 *   8. switching to a not-yet-loaded model brings the load button back;
 *   9. the log panel: entries accumulate, Copy reports into the log.
 *
 * Both demos:
 *  10. mobile viewport 390×844: no horizontal overflow, toggle touch
 *      targets >= 40 px; in model-viewer the canvas fills the viewport;
 *  11. zero console/page errors.
 *
 * Exit 0 — the demos follow the standard; 1 — they do not. Usage: bun run demo:smoke
 */
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const root = resolve(import.meta.dirname, '..')
const port = 8123

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.glb': 'model/gltf-binary',
  '.fbx': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
}

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url)
    let pathname = decodeURIComponent(url.pathname)
    if (pathname === '/') pathname = '/demo/'
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = Bun.file(join(root, pathname))
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    const ext = pathname.slice(pathname.lastIndexOf('.'))
    return new Response(file, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

const errors = []

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox',
    '--no-sandbox',
  ],
})

/** Two canvas screenshots differ → the animation is alive. */
async function framesDiffer(page) {
  const canvas = page.locator('#canvas')
  await page.waitForTimeout(700)
  const shotA = await canvas.screenshot()
  await page.waitForTimeout(700)
  const shotB = await canvas.screenshot()
  return (
    createHash('sha256').update(shotA).digest('hex') !==
    createHash('sha256').update(shotB).digest('hex')
  )
}

let failed = false

try {
  const context = await browser.newContext({
    viewport: { width: 960, height: 720 },
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  const page = await context.newPage()
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))

  await page.goto(`http://localhost:${port}/demo/hello-cube/`, { waitUntil: 'networkidle' })

  // 1. Badge: the shell/library must report the active backend
  await page.waitForFunction(
    () => document.querySelector('#backend')?.textContent !== '…',
    null,
    { timeout: 15_000 },
  )
  console.log(`[smoke] backend (auto): ${await page.textContent('#backend')}`)

  // 2. The animation is alive
  const alive = await framesDiffer(page)
  console.log(`[smoke] animation: ${alive ? 'alive (frames differ)' : 'STATIC'}`)

  // 3. Pause freezes, Resume revives
  await page.click('#pause')
  await page.waitForTimeout(300)
  const shotPausedA = await page.locator('#canvas').screenshot()
  await page.waitForTimeout(500)
  const shotPausedB = await page.locator('#canvas').screenshot()
  const pausedStill =
    createHash('sha256').update(shotPausedA).digest('hex') ===
    createHash('sha256').update(shotPausedB).digest('hex')
  console.log(`[smoke] pause: ${pausedStill ? 'frames frozen' : 'STILL RENDERING'}`)

  await page.click('#resume')
  const aliveAgain = await framesDiffer(page)
  console.log(`[smoke] resume: ${aliveAgain ? 'animation revived' : 'NOT revived'}`)

  // 4. Toggle: forced WebGL2
  await page.click('label[for="mode-webgl2"]')
  await page.waitForFunction(
    () => document.querySelector('#backend')?.textContent === 'WebGL2',
    null,
    { timeout: 10_000 },
  )
  console.log('[smoke] toggle WebGL2: badge = WebGL2')

  // Forced WebGPU: works, or an honest refusal ("WebGPU unavailable")
  await page.click('label[for="mode-webgpu"]')
  await page.waitForFunction(
    () => /^WebGPU/.test(document.querySelector('#backend')?.textContent ?? ''),
    null,
    { timeout: 10_000 },
  )
  console.log(`[smoke] toggle WebGPU: badge = ${await page.textContent('#backend')}`)

  // Exactly one canvas per boot (old ones are recreated)
  const canvasCount = await page.evaluate(() => document.querySelectorAll('#canvas').length)
  console.log(`[smoke] canvases after switching: ${canvasCount}`)

  // 5. Log panel: entries exist, Copy reports
  const logEntries = await page.locator('#log-list .rd-entry').count()
  console.log(`[smoke] log entries: ${logEntries}`)
  await page.click('#log-copy')
  await page.waitForFunction(
    () => (document.querySelector('#log-list')?.textContent ?? '').includes('Log copied'),
    null,
    { timeout: 5000 },
  )
  console.log('[smoke] log copy: report present in the panel')

  // 6. Mobile viewport: no horizontal overflow, touch targets are fine
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`http://localhost:${port}/demo/hello-cube/`, { waitUntil: 'networkidle' })
  await page.waitForFunction(
    () => document.querySelector('#backend')?.textContent !== '…',
    null,
    { timeout: 15_000 },
  )
  const mobile = await page.evaluate(() => {
    const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth
    const target = document.querySelector('label[for="mode-webgl2"]')?.getBoundingClientRect()
    return { overflow, touchTarget: Math.round(target?.height ?? 0) }
  })
  console.log(`[smoke] mobile 390x844: overflow ${mobile.overflow}px, touch target ${mobile.touchTarget}px`)
  const mobileOk = mobile.overflow <= 1 && mobile.touchTarget >= 40

  // ─── model-viewer: load button → progress → scene → animation ────────────
  await page.setViewportSize({ width: 960, height: 720 })
  await page.goto(`http://localhost:${port}/demo/model-viewer/`, { waitUntil: 'networkidle' })
  await page.waitForFunction(
    () => document.querySelector('#backend')?.textContent !== '…',
    null,
    { timeout: 15_000 },
  )
  console.log(`[smoke] model-viewer backend: ${await page.textContent('#backend')}`)

  // 6. The load button starts the progress
  const loadText = await page.textContent('.mv-load')
  console.log(`[smoke] load button: ${loadText ?? 'MISSING'}`)
  await page.click('.mv-load')
  await page.waitForFunction(
    () => document.querySelector('.mv-progress')?.classList.contains('mv-active') === true
      || (document.querySelector('.mv-stats')?.textContent ?? '').includes('verts'),
    null,
    { timeout: 10_000 },
  )
  console.log('[smoke] progress bar shown')

  // 7. The scene appeared (Draco+AVIF on SwiftShader — dozens of seconds are enough)
  await page.waitForFunction(
    () => (document.querySelector('.mv-stats')?.textContent ?? '').includes('verts'),
    null,
    { timeout: 60_000 },
  )
  console.log(`[smoke] scene: ${await page.textContent('.mv-stats')}`)
  const viewerAlive = await framesDiffer(page)
  console.log(`[smoke] model-viewer animation: ${viewerAlive ? 'alive' : 'STATIC'}`)
  // 7b. The house renders through the PBR pipeline (Cook-Torrance) — the
  // GLSL compile of the assembled variant must leave no validation errors
  const pbrLogText = await page.evaluate(() => document.querySelector('#log-list')?.textContent ?? '')
  const pbrGpuClean = !/too small|Invalid CommandBuffer|rendering stopped|GL: GL_|GPU: /i.test(pbrLogText)
  console.log(`[smoke] house PBR GPU health: ${pbrGpuClean ? 'clean (no compile/validation errors)' : 'GPU ERRORS in the log'}`)
  if (!pbrGpuClean) console.log(`[smoke] log tail: ${pbrLogText.slice(-600)}`)

  // 8. Switching to a not-yet-loaded model brings the load button back
  await page.click('.mv-pill') // open the model sheet
  await page.click('.mv-rows .mv-row:nth-child(2)')
  await page.waitForFunction(
    () => (document.querySelector('.mv-load')?.textContent ?? '').includes('Load'),
    null,
    { timeout: 5_000 },
  )
  console.log('[smoke] not-loaded model row: the "Load" button is back')

  // 8b. Load the FBX model — the skeleton/skin/clip pipeline (the loader
  // decode + the skinned draw path with the u_bones palette)
  await page.click('.mv-load')
  await page.waitForFunction(
    () => (document.querySelector('.mv-stats')?.textContent ?? '').includes('joints'),
    null,
    { timeout: 90_000 },
  )
  console.log(`[smoke] samba scene: ${await page.textContent('.mv-stats')}`)
  const sambaStats = await page.textContent('.mv-stats')
  const sambaStatsOk = sambaStats.includes('joints') && sambaStats.includes('clip')
  console.log(`[smoke] samba stats (skeleton + clip): ${sambaStatsOk ? 'ok' : 'MISSING joints/clip'}`)

  // 8c. The clip actually advances (the pose changes between frames)
  const sambaAlive = await framesDiffer(page)
  console.log(`[smoke] samba animation: ${sambaAlive ? 'alive (dance frames differ)' : 'STATIC'}`)

  // 8c2. GPU health: the skinned draw must leave no validation errors in
  // the log — the WebGPU failure mode was "bound with size 256 ... too small;
  // the pipeline requires at least 4448 bytes" → Invalid CommandBuffer →
  // "rendering stopped (storm pause)" on the whole demo
  const viewerLogText = await page.evaluate(() => document.querySelector('#log-list')?.textContent ?? '')
  const gpuHealthy = !/too small|Invalid CommandBuffer|rendering stopped/i.test(viewerLogText)
  console.log(`[smoke] samba GPU health: ${gpuHealthy ? 'clean (no binding/storm errors)' : 'GPU ERRORS in the log'}`)
  if (!gpuHealthy) console.log(`[smoke] log tail: ${viewerLogText.slice(-600)}`)

  // 8d. Pinch zoom (two synthetic touch pointers spreading apart) — the
  // camera distance shrinks, the figure visibly grows (canvas screenshots:
  // readPixels outside rAF reads a cleared buffer without preserveDrawingBuffer)
  const countFigurePixels = async () => {
    const shot = await page.locator('#canvas').screenshot()
    const png = PNG.sync.read(shot)
    let nonBg = 0
    for (let i = 0; i < png.data.length; i += 4) {
      if (!(Math.abs(png.data[i] - 18) < 12 && Math.abs(png.data[i + 1] - 20) < 12 && Math.abs(png.data[i + 2] - 24) < 12)) nonBg++
    }
    return nonBg
  }
  const figureBefore = await countFigurePixels()
  await page.evaluate(() => {
    const canvas = document.querySelector('#canvas')
    const fire = (type, id, x, y) => {
      canvas.dispatchEvent(new PointerEvent(type, {
        pointerId: id, pointerType: 'touch', isPrimary: id === 1, clientX: x, clientY: y, bubbles: true,
      }))
    }
    const cx = 480, cy = 300
    fire('pointerdown', 1, cx - 80, cy)
    fire('pointerdown', 2, cx + 80, cy)
    for (let s = 1; s <= 10; s++) {
      fire('pointermove', 1, cx - 80 - s * 9, cy)
      fire('pointermove', 2, cx + 80 + s * 9, cy)
    }
    fire('pointerup', 1, cx - 170, cy)
    fire('pointerup', 2, cx + 170, cy)
  })
  await page.waitForTimeout(500)
  const figureAfter = await countFigurePixels()
  const pinchZoomed = figureAfter > figureBefore * 1.2
  console.log(
    `[smoke] pinch zoom: figure pixels ${figureBefore} → ${figureAfter} (${pinchZoomed ? 'zoomed in' : 'NO ZOOM'})`,
  )

  // 8e. Matcap Cube — the procedural model on the MATCAP pipeline feature
  // (no download: the geometry and the matcap texture are generated client-side,
  // the shader comes from @rune/materials like every other mesh in the scene)
  await page.click('.mv-pill')
  await page.locator('.mv-rows .mv-row').nth(3).click()
  await page.click('.mv-load')
  await page.waitForFunction(
    () => (document.querySelector('.mv-stats')?.textContent ?? '').includes('verts'),
    null,
    { timeout: 30_000 },
  )
  const matcapStats = await page.textContent('.mv-stats')
  const matcapOk = matcapStats.includes('36 verts')
  console.log(`[smoke] matcap cube: ${matcapStats} (${matcapOk ? 'ok' : 'UNEXPECTED stats'})`)
  const matcapAlive = await framesDiffer(page)
  console.log(`[smoke] matcap animation: ${matcapAlive ? 'alive (turntable spins)' : 'STATIC'}`)
  const matcapLogText = await page.evaluate(() => document.querySelector('#log-list')?.textContent ?? '')
  const matcapGpuClean = !/too small|Invalid CommandBuffer|rendering stopped|GL: GL_|GPU: /i.test(matcapLogText)
  console.log(`[smoke] matcap GPU health: ${matcapGpuClean ? 'clean' : 'GPU ERRORS in the log'}`)
  if (!matcapGpuClean) console.log(`[smoke] log tail: ${matcapLogText.slice(-600)}`)

  // 9. Log: entries exist, Copy reports (the shell controls sit behind the FAB)
  const viewerLogEntries = await page.locator('#log-list .rd-entry').count()
  console.log(`[smoke] model-viewer log entries: ${viewerLogEntries}`)
  await page.click('#rd-fab')
  await page.click('#log-copy')
  await page.waitForFunction(
    () => (document.querySelector('#log-list')?.textContent ?? '').includes('Log copied'),
    null,
    { timeout: 5000 },
  )
  console.log('[smoke] log copy: report present in the panel')

  // Mobile viewport model-viewer: the canvas fills the viewport, the UI is compact
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`http://localhost:${port}/demo/model-viewer/`, { waitUntil: 'networkidle' })
  await page.waitForFunction(
    () => document.querySelector('#backend')?.textContent !== '…',
    null,
    { timeout: 15_000 },
  )
  const mobileViewer = await page.evaluate(() => {
    const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth
    const target = document.querySelector('.mv-row')?.getBoundingClientRect()
    const canvas = document.querySelector('#canvas')?.getBoundingClientRect()
    return {
      overflow,
      touchTarget: Math.round(target?.height ?? 0),
      canvasW: Math.round(canvas?.width ?? 0),
      canvasH: Math.round(canvas?.height ?? 0),
      canvasTop: Math.round(canvas?.top ?? -1),
      bodyScrolls: document.body.scrollHeight > window.innerHeight + 1,
    }
  })
  console.log(
    `[smoke] model-viewer mobile: overflow ${mobileViewer.overflow}px, touch target ${mobileViewer.touchTarget}px, ` +
    `canvas ${mobileViewer.canvasW}x${mobileViewer.canvasH} @top ${mobileViewer.canvasTop}, body scrolls: ${mobileViewer.bodyScrolls}`,
  )
  const mobileViewerOk =
    mobileViewer.overflow <= 1 &&
    mobileViewer.touchTarget >= 40 &&
    mobileViewer.canvasW === 390 &&
    mobileViewer.canvasH === 844 &&
    mobileViewer.canvasTop === 0 &&
    !mobileViewer.bodyScrolls
  await page.setViewportSize({ width: 960, height: 720 })

  // ─── particles: the @rune/particles demo — presets, one draw, clean GPU ──
  await page.goto(`http://localhost:${port}/demo/particles/`, { waitUntil: 'networkidle' })
  await page.waitForFunction(
    () => document.querySelector('#backend')?.textContent !== '…',
    null,
    { timeout: 15_000 },
  )
  console.log(`[smoke] particles backend: ${await page.textContent('#backend')}`)
  // the fountain settles into its steady state: live particles + verts in the pill
  await page.waitForFunction(
    () => /\/ 8,192 · [1-9][\d,]* verts/.test(document.querySelector('.pt-pill')?.textContent ?? ''),
    null,
    { timeout: 20_000 },
  )
  const particlesPill = await page.textContent('.pt-pill')
  console.log(`[smoke] particles pill: ${particlesPill}`)
  const particlesOk = particlesPill.includes('Fountain') && particlesPill.includes('verts')
  const particlesAlive = await framesDiffer(page)
  console.log(`[smoke] particles animation: ${particlesAlive ? 'alive (the soup re-bakes per frame)' : 'STATIC'}`)
  // preset switch: the galaxy (spiral arms + tangential orbits)
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.pt-row')]
    rows.find(r => r.textContent.includes('Galaxy'))?.dispatchEvent(new Event('click', { bubbles: true }))
  })
  await page.waitForFunction(
    () => (document.querySelector('.pt-pill')?.textContent ?? '').includes('Galaxy'),
    null,
    { timeout: 10_000 },
  )
  await page.waitForFunction(
    () => /Galaxy · [1-9][\d,]* \//.test(document.querySelector('.pt-pill')?.textContent ?? ''),
    null,
    { timeout: 20_000 },
  )
  const galaxyPill = await page.textContent('.pt-pill')
  console.log(`[smoke] particles preset switch: ${galaxyPill}`)

  // Task 119: the three new presets — Drift (the user's standing dust),
  // Snow (three-nebula's example) and Orbit (the point attractor)
  for (const name of ['Drift', 'Snow', 'Orbit']) {
    await page.evaluate((n) => {
      const rows = [...document.querySelectorAll('.pt-row')]
      rows.find(r => r.textContent.includes(n))?.dispatchEvent(new Event('click', { bubbles: true }))
    }, name)
    await page.waitForFunction(
      (n) => (document.querySelector('.pt-pill')?.textContent ?? '').includes(n),
      name,
      { timeout: 10_000 },
    )
    // the preset goes live: particles appear in the pill (each new preset
    // ramps its rate from 0 — the pill shows the count growing)
    await page.waitForFunction(
      (n) => new RegExp(`${n} · [1-9][\\d,]* /`).test(document.querySelector('.pt-pill')?.textContent ?? ''),
      name,
      { timeout: 25_000 },
    )
    const presetAlive = await framesDiffer(page)
    console.log(`[smoke] preset "${name}": ${await page.textContent('.pt-pill')} — ${presetAlive ? 'alive' : 'STATIC'}`)
  }
  // Meteor: the directional firework (kept from Task 118)
  {
    const name = 'Meteor'
    await page.evaluate((n) => {
      const rows = [...document.querySelectorAll('.pt-row')]
      rows.find(r => r.textContent.includes(n))?.dispatchEvent(new Event('click', { bubbles: true }))
    }, name)
    await page.waitForFunction(
      (n) => (document.querySelector('.pt-pill')?.textContent ?? '').includes(n),
      name,
      { timeout: 10_000 },
    )
    await page.waitForFunction(
      (n) => new RegExp(`${n} · [1-9][\\d,]* /`).test(document.querySelector('.pt-pill')?.textContent ?? ''),
      name,
      { timeout: 25_000 },
    )
    const presetAlive = await framesDiffer(page)
    console.log(`[smoke] preset "${name}": ${await page.textContent('.pt-pill')} — ${presetAlive ? 'alive' : 'STATIC'}`)
  }

  const particlesLogText = await page.evaluate(() => document.querySelector('#log-list')?.textContent ?? '')
  const particlesGpuClean = !/too small|Invalid CommandBuffer|rendering stopped|GL: GL_|GPU: |failed/i.test(particlesLogText)
  console.log(`[smoke] particles GPU health: ${particlesGpuClean ? 'clean' : 'GPU ERRORS in the log'}`)
  if (!particlesGpuClean) console.log(`[smoke] log tail: ${particlesLogText.slice(-600)}`)
  // mobile viewport: fullscreen canvas, compact pill
  await page.setViewportSize({ width: 390, height: 844 })
  const mobileParticles = await page.evaluate(() => {
    const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth
    const pill = document.querySelector('.pt-pill')?.getBoundingClientRect()
    const canvas = document.querySelector('#canvas')?.getBoundingClientRect()
    return {
      overflow,
      touchTarget: Math.round(pill?.height ?? 0),
      canvasW: Math.round(canvas?.width ?? 0),
      canvasH: Math.round(canvas?.height ?? 0),
      bodyScrolls: document.body.scrollHeight > window.innerHeight + 1,
    }
  })
  console.log(
    `[smoke] particles mobile: overflow ${mobileParticles.overflow}px, pill target ${mobileParticles.touchTarget}px, ` +
    `canvas ${mobileParticles.canvasW}x${mobileParticles.canvasH}, body scrolls: ${mobileParticles.bodyScrolls}`,
  )
  const mobileParticlesOk =
    mobileParticles.overflow <= 1 &&
    mobileParticles.touchTarget >= 40 &&
    mobileParticles.canvasW === 390 &&
    mobileParticles.canvasH === 844 &&
    !mobileParticles.bodyScrolls
  await page.setViewportSize({ width: 960, height: 720 })

  // ─── quarks: the 22-demo carousel (Task 122 + the rune originals) ──
  await page.goto(`http://localhost:${port}/demo/quarks/`, { waitUntil: 'networkidle' })
  await page.waitForFunction(
    () => document.querySelector('.pt-pill')?.textContent.includes('Muzzle'),
    null,
    { timeout: 20_000 },
  )
  await page.waitForFunction(
    () => /Muzzle Flash ×100 · [1-9][\d,]* particles/.test(document.querySelector('.pt-pill')?.textContent ?? ''),
    null,
    { timeout: 20_000 },
  )
  const quarksFirst = await framesDiffer(page)
  const quarksPill1 = await page.textContent('.pt-pill')
  console.log(`[smoke] quarks first demo: ${quarksPill1} — ${quarksFirst ? 'alive' : 'STATIC'}`)

  // cycle ALL 22 demos via the ▶ arrow; each goes live (particles > 0)
  await page.evaluate(() => document.querySelector('.pt-sheet [aria-label=Close]')?.click())
  let quarksAllLive = true
  const seenDemos = []
  for (let i = 1; i < 22; i++) {
    await page.click('.pt-arrow:last-child')
    await page.waitForFunction(
      () => / · [1-9][\d,]* particles · [1-9][\d,]* verts/.test(document.querySelector('.pt-pill')?.textContent ?? ''),
      null,
      { timeout: 20_000 },
    )
    const pill = await page.textContent('.pt-pill')
    seenDemos.push(pill.split(' · ')[0])
    const live = await framesDiffer(page)
    if (!live) quarksAllLive = false
  }
  console.log(`[smoke] quarks cycle: ${seenDemos.join(' → ')}`)
  console.log(`[smoke] quarks all 22 live: ${quarksAllLive ? 'yes' : 'SOME STATIC'}`)
  // the labels overlay (the emitter-shapes demo) projects into the viewport
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.pt-row')]
    rows.find(r => r.textContent.includes('Emitter Shapes'))?.dispatchEvent(new Event('click', { bubbles: true }))
  })
  // wait for the labels to be PROJECTED (opacity 1), not merely present:
  // they are created synchronously in make(), but their transforms land on
  // the FIRST frame callback — checking immediately after the click races
  // that frame (0/9 on a slow CI runner).
  await page.waitForFunction(
    () => [...document.querySelectorAll('.qk-label')].filter(el => el.style.opacity === '1').length >= 9,
    null,
    { timeout: 10_000 },
  )
  const quarksLabels = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.qk-label')]
    const visible = els.filter(el => el.style.opacity === '1' && el.style.transform.includes('px'))
    return { total: els.length, visible: visible.length }
  })
  console.log(`[smoke] quarks labels: ${quarksLabels.visible}/${quarksLabels.total} projected`)
  const quarksLogText = await page.evaluate(() => document.querySelector('#log-list')?.textContent ?? '')
  const quarksGpuClean = !/too small|Invalid CommandBuffer|rendering stopped|GL: GL_|GPU: |failed/i.test(quarksLogText)
  console.log(`[smoke] quarks GPU health: ${quarksGpuClean ? 'clean' : 'GPU ERRORS in the log'}`)
  if (!quarksGpuClean) console.log(`[smoke] log tail: ${quarksLogText.slice(-600)}`)
  // mobile: the arrows/pill stay in the viewport
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`http://localhost:${port}/demo/quarks/`, { waitUntil: 'networkidle' })
  await page.waitForFunction(
    () => document.querySelector('.pt-pill')?.textContent.includes('Muzzle'),
    null,
    { timeout: 20_000 },
  )
  const mobileQuarks = await page.evaluate(() => {
    const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth
    const arrow = document.querySelector('.pt-arrow')?.getBoundingClientRect()
    const canvas = document.querySelector('#canvas')?.getBoundingClientRect()
    return { overflow, touchTarget: Math.round(arrow?.height ?? 0), canvasW: Math.round(canvas?.width ?? 0) }
  })
  console.log(
    `[smoke] quarks mobile: overflow ${mobileQuarks.overflow}px, arrow target ${mobileQuarks.touchTarget}px, ` +
    `canvas width ${mobileQuarks.canvasW}`,
  )
  const mobileQuarksOk = mobileQuarks.overflow <= 1 && mobileQuarks.touchTarget >= 40
  await page.setViewportSize({ width: 960, height: 720 })

  if (errors.length) {
    console.error('[smoke] page errors:')
    for (const error of errors) console.error(`  ${error}`)
  }

  const ok =
    alive &&
    pausedStill &&
    aliveAgain &&
    canvasCount === 1 &&
    logEntries > 0 &&
    mobileOk &&
    viewerAlive &&
    pbrGpuClean &&
    loadText !== null &&
    loadText.includes('Load') &&
    sambaStatsOk &&
    sambaAlive &&
    gpuHealthy &&
    pinchZoomed &&
    matcapOk &&
    matcapAlive &&
    matcapGpuClean &&
    particlesOk &&
    particlesAlive &&
    particlesGpuClean &&
    mobileParticlesOk &&
    quarksFirst &&
    quarksAllLive &&
    quarksLabels.visible >= 9 &&
    quarksGpuClean &&
    mobileQuarksOk &&
    viewerLogEntries > 0 &&
    mobileViewerOk &&
    errors.length === 0

  console.log(ok ? '[smoke] OK' : '[smoke] FAIL')
  failed = !ok
  await context.close()
} finally {
  await browser.close()
  server.stop(true)
}

process.exit(failed ? 1 : 0)
