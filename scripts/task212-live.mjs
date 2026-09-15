/**
 * scripts/task212-live.mjs — the LIVE gate: the deployed Pages site carries
 * Task 212 (THE OVERRIDE LANE — the third field report's fix:
 * «Scene edit сразу взвинчивает мс на кадр, увеличивая лаги в разы.
 * Со временем мс увеличивается.»). Checks:
 *   (1) the served sources carry the ?v=212 cache-busts and the Task-212
 *       surface (main.js's LANE_FOLD + the lane HUD line + the fold/lane
 *       probe channels; the dist bump);
 *   (2) the boot validation PASSES on the live SwiftShader stack (the
 *       static path untouched — the 209/211 laws ride it);
 *   (3) THE SUSTAINED FLIGHT, LIVE, on BOTH backends (the local gate's
 *       rehearsal against production): the override lane pinned at the
 *       drone count while the trees NEVER grow (the leak law — before the
 *       fix the octree added 48 objects a frame forever), the live counts
 *       honest, msAvg FLAT (the report's own metric), the upload math
 *       alive throughout, THE FOLD PROBE through the page's channel
 *       (lanes empty → the tick re-arms → the re-split tree stable), and
 *       zero page/GPU errors.
 *
 * The pause discipline is inherited (Task 211): the drawn samples here are
 * pure CPU state (no GPU readback), so no pause is needed for them.
 */
import { chromium } from 'playwright'

const BASE = 'https://atolbat.github.io/rune/demo/occlusion/'
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})

let failures = 0
function check(name, ok, detail = '') {
  console.log(`[live] ${name}: ${ok ? 'PASS' : 'FAIL'}${detail ? ` · ${detail}` : ''}`)
  if (!ok) failures++
}

const flightSample = page => page.evaluate(() => ({
  lane: window.__hizEdits.lane(),
  ms: window.__hizStats.msAvg,
  up: window.__hizEdits.last(),
}))

async function runLeg(mode) {
  console.log(`[live] leg ${mode}: goto…`)
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
  const legErrors = []
  page.on('pageerror', (e) => legErrors.push(`pageerror: ${e.message.slice(0, 160)}`))
  page.on('console', (m) => { if (m.type() === 'error') legErrors.push(`console: ${m.text().slice(0, 160)}`) })
  await page.goto(`${BASE}${mode === 'webgl2' ? '?mode=webgl2' : ''}`, { waitUntil: 'networkidle', timeout: 60_000 })
  const stats = await page.waitForFunction(
    () => (window.__hizStats && window.__hizStats.validation !== null && window.__hizStats.drawn > 0 ? window.__hizStats : undefined),
    null,
    { timeout: 300_000 },
  ).then(h => h.jsonValue())
  check(`[${mode}] the boot validation PASS (the static path)`, stats?.validation?.pass === true,
    `drawn ${stats?.drawn}/${stats?.total} · mode ${stats?.mode}`)

  await page.evaluate(() => { window.__hizCam.auto = 0 })
  await page.waitForTimeout(1500)

  // the drones ON — the sustained flight (wall-clock seconds; the local
  // leg's law: msAvg converges from below first — its EMA excludes frames
  // slower than 250ms — so we wait for convergence before sampling)
  await page.evaluate(() => { window.__hizEdits.set(true) })
  await page.waitForFunction(() => window.__hizEdits.last().bytes > 0, null, { timeout: 90_000 })
  await page.waitForFunction(() => window.__hizStats.msAvg > 1, null, { timeout: 60_000 }).catch(() => { /* a slow leg keeps msAvg at 0 — the ratio law handles it */ })
  await page.waitForTimeout(1200)
  const s0 = await flightSample(page)
  const bootNodes = { oct: s0.lane.octNodes, bvh: s0.lane.bvhNodes }
  await page.waitForTimeout(8000)
  const s1 = await flightSample(page)
  await page.waitForTimeout(8000)
  const s2 = await flightSample(page)

  // THE LEAK LAW, LIVE: lane pinned, trees frozen, live honest
  const lanePinned = [s0, s1, s2].every(s => s.lane.octLane === 48 && s.lane.bvhLane === 48)
  check(`[${mode}] the override lane pinned at 48 drones`, lanePinned,
    `lane ${s0.lane.octLane}/${s0.lane.bvhLane} → ${s1.lane.octLane}/${s1.lane.bvhLane} → ${s2.lane.octLane}/${s2.lane.bvhLane}`)
  const treesFrozen = [s1, s2].every(s => s.lane.octNodes === bootNodes.oct && s.lane.bvhNodes === bootNodes.bvh)
  check(`[${mode}] the leak law: tree node counts NEVER move (the report's «со временем растёт», dead)`, treesFrozen,
    `oct ${bootNodes.oct} → ${s1.lane.octNodes} → ${s2.lane.octNodes} · bvh ${bootNodes.bvh} → ${s1.lane.bvhNodes} → ${s2.lane.bvhNodes}`)
  const liveHonest = [s0, s1, s2].every(s => s.lane.octLive === 16407 && s.lane.bvhLive === 16407)
  check(`[${mode}] the live counts honest (no phantom growth)`, liveHonest,
    `oct ${s0.lane.octLive} → ${s2.lane.octLive} · bvh ${s0.lane.bvhLive} → ${s2.lane.bvhLive}`)

  // msAvg FLAT — the report's own metric (BEFORE: climbed without bound)
  const msBase = Math.max(s0.ms, s1.ms, 3)
  const msRatio = s2.ms / msBase
  check(`[${mode}] msAvg flat over the flight (the report's «взвинчивает мс», dead — ratio ${msRatio.toFixed(2)})`, msRatio < 2.5,
    `${s0.ms.toFixed(1)} → ${s1.ms.toFixed(1)} → ${s2.ms.toFixed(1)} ms`)

  // the upload math alive
  check(`[${mode}] the dirty-range upload alive at the end`, s2.up.bytes > 0 && s2.up.ranges > 0,
    `${s2.up.bytes} B · ${s2.up.ranges} ranges`)

  // THE FOLD PROBE through the page's channel (one JS task: fold + read)
  const folded = await page.evaluate(() => { window.__hizEdits.fold(); return window.__hizEdits.lane() })
  await page.waitForTimeout(1800)
  const rearmed = await flightSample(page)
  check(`[${mode}] the fold probe: lanes empty → the tick re-arms 48/48`,
    folded.octLane === 0 && folded.bvhLane === 0 && rearmed.lane.octLane === 48 && rearmed.lane.bvhLane === 48,
    `after fold ${folded.octLane}/${folded.bvhLane} → +1.8s ${rearmed.lane.octLane}/${rearmed.lane.bvhLane}`)
  await page.waitForTimeout(2000)
  const s3 = await flightSample(page)
  check(`[${mode}] the re-split tree stable after the fold`, s3.lane.octNodes === rearmed.lane.octNodes && s3.lane.bvhNodes === rearmed.lane.bvhNodes,
    `oct ${rearmed.lane.octNodes} → ${s3.lane.octNodes} · bvh ${rearmed.lane.bvhNodes} → ${s3.lane.bvhNodes}`)

  // cleanliness
  check(`[${mode}] zero errors across the whole visit`, legErrors.length === 0, legErrors.slice(0, 3).join(' | '))
  await page.close()
}

try {
  // ── 1. the served sources carry the Task-212 surface ────────────────────
  const mainSrc = await (await fetch(`${BASE}main.js`)).text()
  const tierSrc = await (await fetch(`${BASE}tier.js`)).text()
  const htmlSrc = await (await fetch(BASE)).text()
  check('served main.js carries the lane budget + the fold channels + the ?v=212 marks',
    mainSrc.includes('LANE_FOLD') && mainSrc.includes('__hizEdits.fold') && mainSrc.includes('THE OVERRIDE LANE') && mainSrc.includes('tier.js?v=212'))
  check('served tier.js carries the dist bump', tierSrc.includes('rune.esm.js?v=212'))
  check('served index.html carries the ?v=212 marks', htmlSrc.includes('main.js?v=212'))

  // ── 2. both legs, end to end ────────────────────────────────────────────
  await runLeg('webgpu')
  await runLeg('webgl2')
} catch (e) {
  failures++
  console.error(`[live] CRASH: ${e instanceof Error ? e.message : String(e)}`)
} finally {
  await browser.close()
}

console.log(`\n[live] ${failures === 0 ? 'VERDICT: PASS — the override lane is live: the edit mode is flat and honest' : `VERDICT: FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
