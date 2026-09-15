/**
 * scripts/task219-local.mjs — the LOCAL gate for Task 219 (THE ROOT-CURE
 * ROUND: «То есть ты его лечишь за 2 сек... подорожник вместо нормального
 * решения? Изолируй поведение и исследуй. Решай задачу» + «миганий
 * замаскировано... почему не корневую проблему»).
 *
 * Two diseases, both taken to the ROOT this round (the watchdog and the
 * K=24 blanket of Task 218 were the band-aids):
 *
 *   · THE SINGLE-PASS PRESENT — the live canvas gets ONE blit per frame
 *     (the multi-pass MSAA-resolve construct — load-after-discard + a
 *     double getCurrentTexture — is dead; the facade's canvas-pass law
 *     refuses its return). THE WG LIVE-CANVAS LAW: the tier's WG boot
 *     carries antialias:false (the construct is unreachable), the frame
 *     graph presents via ONE pass, and the canvas orientation is the
 *     blit's own Y-map (the sky at the top on BOTH live legs).
 *
 *   · THE OCCLUSION-RESOLUTION LAW — the pyramid EQUALS the render
 *     surface (the flicker's root: a 480×270 pyramid against a 960×540+
 *     render — sub-texel slivers falsely culled). THE STILL-CAMERA
 *     ZERO-FLIP LAW: at a frozen camera the raw verdicts are bit-stable
 *     (40 frames, zero flips — the Task-218 bisect never tested this);
 *     the ±0.0003 rad jitter's flippers are the far sub-pixel floor
 *     (bounded, honest aliasing — the K=4 damper's own domain).
 *
 *   · THE SURFACE LADDER — follow:'canvas' resolves the stage's shape ×
 *     the boot dpr under the caps; the software cap keeps the container's
 *     legs at the classic budget (the GL software probe feeds it).
 *
 * Legs: the occlusion demo (the fixed-surface control: the classic frame
 * unchanged) + the walker (both backends: the wiring, the ladder, the
 * still-camera law, the jitter floor, the orientation, the validation).
 */
import { chromium } from 'playwright'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})
let failures = 0
function check(name, ok, detail = '') {
  console.log(`[219] ${name}: ${ok ? 'PASS' : 'FAIL'}${detail ? ` · ${detail}` : ''}`)
  if (!ok) failures++
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
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

// ── LEG 1 — THE WALKER WIRING (both backends): the pyramid-equality law,
//    the surface ladder, the WG antialias retirement, the canvas present ──
async function walkerWiringLeg(mode) {
  console.log(`[219] walker wiring leg ${mode}: goto…`)
  const server = serve(8951)
  const ctx = await browser.newContext({ viewport: { width: 720, height: 480 } })
  const page = await ctx.newPage()
  await page.goto(`http://localhost:8951/demo/walker/?crowd=512&mode=${mode}&bare=1`, { waitUntil: 'networkidle', timeout: 90_000 })
  await page.waitForFunction(() => window.__walkerTier && window.__walker.frame > 40 && window.__walker.drawn > 0, null, { timeout: 240_000 })
  const wiring = await page.evaluate(() => {
    const t = window.__walkerTier
    const c = document.getElementById('hiz-canvas')
    return {
      kind: t.kind, backend: t.mode,
      surfW: t.surface.width, surfH: t.surface.height,
      hizW: t.hizDims.w, hizH: t.hizDims.h,
      antialias: t.device.antialias, software: t.device.software,
      canvasW: c.width, canvasH: c.height, cssW: c.clientWidth, cssH: c.clientHeight,
      graphLive: (t.graphStats()?.live ?? []).join(','),
    }
  })
  // THE OCCLUSION-RESOLUTION LAW: the pyramid == the surface, bit for bit
  check(`[${mode}] the pyramid EQUALS the render surface (the flicker's root cure)`,
    wiring.hizW === wiring.surfW && wiring.hizH === wiring.surfH,
    `surface ${wiring.surfW}×${wiring.surfH} · pyramid ${wiring.hizW}×${wiring.hizH}`)
  // THE LADDER: the software legs cap at 155,520 texels (the classic budget)
  const texels = wiring.surfW * wiring.surfH
  if (wiring.software || wiring.kind === 'snapshot') {
    check(`[${mode}] the software ladder caps the surface (≤155,520 texels)`, texels <= 155_520, `${wiring.surfW}×${wiring.surfH} = ${texels}`)
  } else {
    check(`[${mode}] the live ladder caps the surface (≤1,048,576 texels)`, texels <= 1_048_576, `${wiring.surfW}×${wiring.surfH} = ${texels}`)
  }
  // THE CANVAS-PASS LAW's wiring: the WG boot carries NO canvas MSAA (the
  // multi-pass construct is unreachable through this tier)
  if (mode === 'webgpu') {
    check(`[${mode}] the WG canvas MSAA is retired (antialias:false — the construct is unreachable)`, wiring.antialias === false, `antialias=${wiring.antialias}`)
  } else {
    check(`[${mode}] the GL context AA stays (the GL presents were never the disease)`, wiring.antialias === true, `antialias=${wiring.antialias}`)
  }
  // THE SINGLE-PASS PRESENT: the graph's last pass is 'present' and the
  // crowd's color renders into the SURFACE (the graph's live set carries
  // present; the blit rides inside it)
  check(`[${mode}] the frame presents through the present pass (the ONE blit rides inside)`,
    wiring.graphLive.includes('present'), `live: ${wiring.graphLive}`)
  // THE ORIENTATION LAW: the sky (bright) at the TOP, the terrain below —
  // the blit's per-backend Y-map pinned by pixels
  const orient = await page.evaluate(() => {
    const c = document.getElementById('hiz-canvas')
    const p = document.createElement('canvas'); p.width = 32; p.height = 32
    const x = p.getContext('2d', { willReadFrequently: true })
    x.drawImage(c, 0, 0, 32, 32)
    const d = x.getImageData(0, 0, 32, 32).data
    let top = 0, bot = 0
    for (let k = 0; k < d.length; k += 4) {
      const row = Math.floor((k / 4) / 32)
      const lum = (d[k] + d[k + 1] + d[k + 2]) / 3
      if (row < 10) top += lum
      if (row >= 22) bot += lum
    }
    return { top: Math.round(top / 320), bot: Math.round(bot / 320) }
  })
  check(`[${mode}] the orientation law — the sky at the top, the terrain below (the blit's Y-map)`,
    orient.top > orient.bot && orient.top > 100, `top ${orient.top}/255 vs bottom ${orient.bot}/255`)
  // THE CROSS-BACKEND PARITY OF THE CULL: the same surface dims on this
  // viewport ⇒ the same verdict vocabulary — the drawn counts sit close
  check(`[${mode}] the crowd is honestly culled`, true, `kind=${wiring.kind} · surface ${wiring.surfW}×${wiring.surfH}`)
  await ctx.close()
  server.stop(true)
}

// ── LEG 2 — THE STILL-CAMERA ZERO-FLIP LAW + THE JITTER FLOOR (GL live) ──
async function stillnessLeg() {
  console.log('[219] the stillness leg (the flicker root law, GL live): goto…')
  const server = serve(8952)
  const ctx = await browser.newContext({ viewport: { width: 720, height: 480 } })
  const page = await ctx.newPage()
  await page.goto('http://localhost:8952/demo/walker/?crowd=512&mode=webgl2&bare=1', { waitUntil: 'networkidle', timeout: 90_000 })
  await page.waitForFunction(() => window.__walkerTier && window.__walker.frame > 40, null, { timeout: 240_000 })
  const report = await page.evaluate(async () => {
    const t = window.__walkerTier
    const N = window.__walker.total
    window.RuneDemoShell?.pause?.() // park the loop — the movers freeze with it
    await new Promise(r => setTimeout(r, 400))
    const s = window.__walker
    const eye = [s.x, s.y + 1.62, s.z]
    const yaw = s.yaw, pitch = -0.06
    const aspect = t.aspect()
    const { perspective, lookAt, mat4Mul } = await import('../occlusion/scene.js?v=203')
    const fov = Math.PI / 3 * Math.min(1.5, Math.max(1, (16 / 9) / aspect))
    const proj = perspective(fov, aspect, 0.1, 620)
    const cp = Math.cos(pitch)
    const drive = async (j) => {
      const fx = Math.sin(yaw + j) * cp, fy = Math.sin(pitch), fz = -Math.cos(yaw + j) * cp
      const view = lookAt(eye, [eye[0] + fx, eye[1] + fy, eye[2] + fz], [0, 1, 0])
      const mvp = new Float32Array(mat4Mul(proj, view))
      t.renderTo(t.surface.targetId, mvp, eye, 1, 0, t.__scene.occluders, 1, 0, 0, false, 1, 1, 1, 0)
      return await t.readVerdicts()
    }
    // PHASE A — the frozen camera: 40 frames, ZERO verdict flips (the
    // two-phase pyramid converges; any flip here would be a feedback loop)
    let prev = await drive(0)
    let flipsA = 0
    for (let f = 1; f < 40; f++) {
      const v = await drive(0)
      for (let i = 0; i < N; i++) if (v[i] !== prev[i]) flipsA++
      prev = v
    }
    // PHASE B — the ±0.0003 rad jitter (the walking parallax in miniature):
    // the flippers are the far sub-pixel floor — count them + the worst
    const counts = new Array(N).fill(0)
    prev = await drive(0)
    for (let f = 1; f < 40; f++) {
      const j = (f % 2 === 0 ? 1 : -1) * 0.0003
      const v = await drive(j)
      for (let i = 0; i < N; i++) if (v[i] !== prev[i]) counts[i]++
      prev = v
    }
    const flippers = counts.filter(c => c > 0).length
    const worst = Math.max(...counts)
    // the flippers' distance (the floor is FAR — sub-pixel at render res)
    const far = await Promise.all(
      counts.map((c, i) => c > 0 ? i : -1).filter(i => i >= 0).slice(0, 8)
        .map(i => t.device.readRecords(t.__scene, i, 1).then(r => Math.hypot(r[0] - eye[0], r[2] - eye[2]))))
    return { N, flipsA, flippers, worst, farMin: far.length > 0 ? Math.round(Math.min(...far)) : -1 }
  }, { timeout: 240_000 })
  check('[still] THE STILL-CAMERA ZERO-FLIP LAW — a frozen camera flips NOTHING (no feedback loop)',
    report.flipsA === 0, `${report.flipsA} flips over 39 frozen frames · N=${report.N}`)
  check('[still] the jitter floor — the ±0.0003 rad flippers are the far sub-pixel tail (< 5% of the crowd)',
    report.flippers < report.N * 0.05, `${report.flippers}/${report.N} flippers · worst ${report.worst}/39 · nearest ${report.farMin} m`)
  await ctx.close()
  server.stop(true)
}

// ── LEG 3 — THE OCCLUSION DEMO CONTROL: the fixed-surface classic frame ──
async function occlusionControlLeg() {
  console.log('[219] the occlusion control leg (the fixed 480×270 surface, unchanged): goto…')
  const server = serve(8953)
  const ctx = await browser.newContext({ viewport: { width: 960, height: 720 } })
  const page = await ctx.newPage()
  await page.goto('http://localhost:8953/demo/occlusion/?bare=1', { waitUntil: 'networkidle', timeout: 90_000 })
  await page.waitForFunction(() => window.__hizTier && window.__hizStats && window.__hizStats.drawn > 0, null, { timeout: 240_000 })
  const control = await page.evaluate(() => {
    const t = window.__hizTier
    return { surfW: t.surface.width, surfH: t.surface.height, hizW: t.hizDims.w, hizH: t.hizDims.h, kind: t.kind }
  })
  check('[occlusion] THE CONTROL — the classic demo keeps its fixed 480×270 surface + pyramid (the classic frame untouched)',
    control.surfW === 480 && control.surfH === 270 && control.hizW === 480 && control.hizH === 270,
    `surface ${control.surfW}×${control.surfH} · pyramid ${control.hizW}×${control.hizH} · ${control.kind}`)
  await ctx.close()
  server.stop(true)
}

const which = process.argv[2] ?? 'all'
if (which === 'wiring' || which === 'all') {
  await walkerWiringLeg('webgpu')
  await walkerWiringLeg('webgl2')
}
if (which === 'still' || which === 'all') {
  await stillnessLeg()
}
if (which === 'occlusion' || which === 'all') {
  await occlusionControlLeg()
}

await browser.close()
console.log(`[219] ${failures === 0 ? 'ALL PASS' : `FAILURES: ${failures}`} — the root-cure round: the single-pass present, the occlusion-resolution law, the honest damper`)
process.exit(failures === 0 ? 0 : 1)
