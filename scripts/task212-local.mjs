/**
 * scripts/task212-local.mjs — the LOCAL pre-deploy gate for Task 212 (the
 * field report's leak: «Scene edit сразу взвинчивает мс на кадр, увеличивая
 * лаги в разы. Со временем мс увеличивается.»).
 *
 * The leak script (scripts/task212-leak.mjs) already proves the law against
 * the raw structures; THIS gate proves it on the living page, both backends:
 *   · a SUSTAINED drone flight (tens of wall-clock seconds — the drones fly
 *     real seconds whatever the frame rate): the override lane stays pinned
 *     at the drone count, the tree node counts NEVER move (the leak law —
 *     before the fix the octree grew 48 objects/frame forever), the live
 *     counts stay honest, and the frame interval (msAvg) stays flat within
 *     the SwiftShader noise band;
 *   · THE FOLD PROBE through the page's own channel: __hizEdits.fold()
 *     empties both lanes, the drone tick re-arms them on the next frame,
 *     and the re-split tree is stable from there;
 *   · the upload math stays alive the whole flight (the store's dirty
 *     ranges keep landing) and the page stays error-free.
 *
 * The pause discipline: the drawn-count samples read the GPU (readStats) —
 * every such read runs under a PAUSED loop (the Task-211 lesson); the pure
 * CPU state (lane sizes, msAvg) needs no pause.
 */
import { chromium } from 'playwright'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const port = 8921
const LEG_ARG = process.argv[2] === 'webgl2' ? ['webgl2'] : process.argv[2] === 'webgpu' ? ['webgpu'] : ['webgpu', 'webgl2']
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

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})

let failures = 0
function check(name, ok, detail = '') {
  console.log(`[212] ${name}: ${ok ? 'PASS' : 'FAIL'}${detail ? ` · ${detail}` : ''}`)
  if (!ok) failures++
}

/** the pure-CPU flight sample (no GPU readback — no pause discipline) */
const flightSample = page => page.evaluate(() => ({
  lane: window.__hizEdits.lane(),
  ms: window.__hizStats.msAvg,
  frames: window.__hizStats.drawn,
  up: window.__hizEdits.last(),
}))

async function runLeg(mode) {
  console.log(`[212] leg ${mode}: goto…`)
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 160)}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`) })
  await page.goto(`http://localhost:${port}/demo/occlusion/?bare=1${mode === 'webgl2' ? '&mode=webgl2' : ''}`, { waitUntil: 'networkidle', timeout: 45_000 })
  await page.waitForFunction(() => window.__hizStats && window.__hizStats.drawn > 0, null, { timeout: 240_000 })
  await page.evaluate(() => { window.__hizCam.auto = 0 })
  await page.waitForTimeout(700)

  // the drones ON — the sustained flight
  await page.evaluate(() => { window.__hizEdits.set(true) })
  await page.waitForFunction(() => window.__hizEdits.last().bytes > 0, null, { timeout: 60_000 })
  // msAvg must CONVERGE before the first sample: the EMA excludes frames
  // slower than 250ms (the boot-validation tail on SwiftShader), so it
  // starts at 0 and climbs from below to the settled frame time — a
  // from-below climb is convergence, never a leak signal
  await page.waitForFunction(() => window.__hizStats.msAvg > 1, null, { timeout: 45_000 }).catch(() => { /* a leg slower than 250ms/frame keeps msAvg at 0 — the ratio law handles it */ })
  await page.waitForTimeout(1200)
  const s0 = await flightSample(page)
  const bootNodes = { oct: s0.lane.octNodes, bvh: s0.lane.bvhNodes }

  await page.waitForTimeout(9000)
  const s1 = await flightSample(page)
  await page.waitForTimeout(9000)
  const s2 = await flightSample(page)

  // (a) THE LEAK LAW: the lane pinned at the drone count, the trees FROZEN
  const lanePinned = [s0, s1, s2].every(s => s.lane.octLane === 48 && s.lane.bvhLane === 48)
  check(`[${mode}] the override lane pinned at 48 drones (10s · 20s of flight)`, lanePinned,
    `lane ${s0.lane.octLane}/${s0.lane.bvhLane} → ${s1.lane.octLane}/${s1.lane.bvhLane} → ${s2.lane.octLane}/${s2.lane.bvhLane}`)
  const treesFrozen = [s1, s2].every(s => s.lane.octNodes === bootNodes.oct && s.lane.bvhNodes === bootNodes.bvh)
  check(`[${mode}] the leak law: tree node counts NEVER move`, treesFrozen,
    `oct ${bootNodes.oct} → ${s1.lane.octNodes} → ${s2.lane.octNodes} · bvh ${bootNodes.bvh} → ${s1.lane.bvhNodes} → ${s2.lane.bvhNodes}`)
  const liveHonest = [s0, s1, s2].every(s => s.lane.octLive === 16407 && s.lane.bvhLive === 16407)
  check(`[${mode}] the live counts stay honest (no phantom growth)`, liveHonest,
    `oct ${s0.lane.octLive} → ${s2.lane.octLive} · bvh ${s0.lane.bvhLive} → ${s2.lane.bvhLive}`)

  // (b) the frame interval stays flat within the noise band (BEFORE the
  // fix this climbed without bound — the report's «лаги в разы»); the
  // base is the MAX of the first two samples so the EMA's from-below
  // convergence can never read as growth
  const msBase = Math.max(s0.ms, s1.ms, 3)
  const msRatio = s2.ms / msBase
  check(`[${mode}] msAvg flat over the flight (ratio ${msRatio.toFixed(2)})`, msRatio < 2.5,
    `${s0.ms.toFixed(1)} → ${s1.ms.toFixed(1)} → ${s2.ms.toFixed(1)} ms`)

  // (c) the upload math alive the whole flight
  check(`[${mode}] the dirty-range upload alive at the end`, s2.up.bytes > 0 && s2.up.ranges > 0,
    `${s2.up.bytes} B · ${s2.up.ranges} ranges`)

  // (d) THE FOLD PROBE through the page's channel: the fold and the lane
  // read run in ONE evaluate (one JS task — no rAF can interleave and
  // re-arm the lane between them); then the drone tick re-arms, and the
  // re-split tree is stable from there
  const folded = await page.evaluate(() => { window.__hizEdits.fold(); return window.__hizEdits.lane() })
  await page.waitForTimeout(1800)
  const rearmed = await flightSample(page)
  const foldOk = folded.octLane === 0 && folded.bvhLane === 0
    && rearmed.lane.octLane === 48 && rearmed.lane.bvhLane === 48
  check(`[${mode}] the fold probe: lanes empty → the tick re-arms 48/48`, foldOk,
    `after fold ${folded.octLane}/${folded.bvhLane} → +1.8s ${rearmed.lane.octLane}/${rearmed.lane.bvhLane}`)
  await page.waitForTimeout(2500)
  const s3 = await flightSample(page)
  check(`[${mode}] the re-split tree stable after the fold`, s3.lane.octNodes === rearmed.lane.octNodes && s3.lane.bvhNodes === rearmed.lane.bvhNodes,
    `oct ${rearmed.lane.octNodes} → ${s3.lane.octNodes} · bvh ${rearmed.lane.bvhNodes} → ${s3.lane.bvhNodes}`)

  // (e) cleanliness
  check(`[${mode}] zero errors across the whole flight`, errors.length === 0, errors.slice(0, 3).join(' | '))
  await page.close()
}

try {
  for (const leg of LEG_ARG) await runLeg(leg)
} catch (e) {
  failures++
  console.error(`[212] CRASH: ${e instanceof Error ? e.message : String(e)}`)
} finally {
  await browser.close()
  server.stop(true)
}

console.log(`\n[212] ${failures === 0 ? 'VERDICT: PASS — the edit mode is flat and honest on both backends' : `VERDICT: FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
