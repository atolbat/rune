/**
 * scripts/task213-live.mjs — the LIVE gate: the deployed Pages site carries
 * Task 213 (THE KIT'S OWN SoA ROUND — the trees eat the records view, the
 * drones edit through the scalar twins). Checks:
 *   (1) the served sources carry the ?v=213 cache-busts and the Task-213
 *       surface (main.js's buildOctreeRecords import + the scalar updateBox
 *       drone loop + the records comment; the spatialBoxes boxing GONE;
 *       the dist bump);
 *   (2) the boot validation PASSES on the live SwiftShader stack (the
 *       static path untouched — the 209/211/212 laws ride it);
 *   (3) THE BIT-SHAPE LAW, LIVE: the records-built trees boot to the
 *       object-built trees' own node counts (oct 55828 / bvh 4141 at
 *       N=16384 — the bit-identity gate's shape, on production);
 *   (4) THE SUSTAINED FLIGHT, LIVE, on BOTH backends (the Task-212 laws
 *       the SoA round must not disturb): the override lane pinned at the
 *       drone count, the trees NEVER growing, the live counts honest,
 *       msAvg FLAT, the upload math alive, the fold probe clean, zero
 *       page/GPU errors.
 *
 * The pause discipline is inherited (Task 211): the drawn samples here are
 * pure CPU state (no GPU readback), so no pause is needed for them.
 */
import { chromium } from 'playwright'

const BASE = 'https://atolbat.github.io/rune/demo/occlusion/'
const LEG_ARG = process.argv[2] === 'webgl2' ? ['webgl2'] : process.argv[2] === 'webgpu' ? ['webgpu'] : ['webgpu', 'webgl2']
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
    { timeout: 420_000 },
  ).then(h => h.jsonValue())
  check(`[${mode}] the boot validation PASS (the static path)`, stats?.validation?.pass === true,
    `drawn ${stats?.drawn}/${stats?.total} · mode ${stats?.mode}`)

  await page.evaluate(() => { window.__hizCam.auto = 0 })
  await page.waitForTimeout(1500)

  // THE BIT-SHAPE LAW: the records-built trees boot to the object-built
  // trees' own counts (the task213 bit-identity gate's shape, live)
  const boot = await flightSample(page)
  check(`[${mode}] the bit-shape law: the records-built trees = the object-built shape`,
    boot.lane.octNodes === 55828 && boot.lane.bvhNodes === 4141,
    `oct ${boot.lane.octNodes} nodes (want 55828) · bvh ${boot.lane.bvhNodes} (want 4141)`)

  // the drones ON — the sustained flight (wall-clock seconds; msAvg
  // converges from below first — its EMA excludes frames slower than
  // 250ms — so we wait for convergence before sampling)
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

  // THE LEAK LAW (the Task-212 laws the SoA round must not disturb)
  const lanePinned = [s0, s1, s2].every(s => s.lane.octLane === 48 && s.lane.bvhLane === 48)
  check(`[${mode}] the override lane pinned at 48 drones (the scalar twins)`, lanePinned,
    `lane ${s0.lane.octLane}/${s0.lane.bvhLane} → ${s1.lane.octLane}/${s1.lane.bvhLane} → ${s2.lane.octLane}/${s2.lane.bvhLane}`)
  const treesFrozen = [s1, s2].every(s => s.lane.octNodes === bootNodes.oct && s.lane.bvhNodes === bootNodes.bvh)
  check(`[${mode}] the leak law: tree node counts NEVER move`, treesFrozen,
    `oct ${bootNodes.oct} → ${s1.lane.octNodes} → ${s2.lane.octNodes} · bvh ${bootNodes.bvh} → ${s1.lane.bvhNodes} → ${s2.lane.bvhNodes}`)
  const liveHonest = [s0, s1, s2].every(s => s.lane.octLive === 16407 && s.lane.bvhLive === 16407)
  check(`[${mode}] the live counts honest (no phantom growth)`, liveHonest,
    `oct ${s0.lane.octLive} → ${s2.lane.octLive} · bvh ${s0.lane.bvhLive} → ${s2.lane.bvhLive}`)

  // msAvg FLAT (the report's own metric)
  const msBase = Math.max(s0.ms, s1.ms, 3)
  const msRatio = s2.ms / msBase
  check(`[${mode}] msAvg flat over the flight (ratio ${msRatio.toFixed(2)})`, msRatio < 2.5,
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
  check(`[${mode}] the compacted tree stable after the fold`, s3.lane.octNodes === rearmed.lane.octNodes && s3.lane.bvhNodes === rearmed.lane.bvhNodes,
    `oct ${rearmed.lane.octNodes} → ${s3.lane.octNodes} · bvh ${rearmed.lane.bvhNodes} → ${s3.lane.bvhNodes}`)

  // cleanliness
  check(`[${mode}] zero errors across the whole visit`, legErrors.length === 0, legErrors.slice(0, 3).join(' | '))
  await page.close()
}

try {
  // ── 1. the served sources carry the Task-213 surface ────────────────────
  const mainSrc = await (await fetch(`${BASE}main.js`)).text()
  const tierSrc = await (await fetch(`${BASE}tier.js`)).text()
  const htmlSrc = await (await fetch(BASE)).text()
  check('served main.js carries the records front door + the scalar drone loop + the ?v=213 marks',
    mainSrc.includes('buildOctreeRecords(view)') && mainSrc.includes('buildBVHRecords(view)') && mainSrc.includes('octree.updateBox(a.id') && mainSrc.includes('THE KIT EATS THE RECORDS') && mainSrc.includes('tier.js?v=213'))
  check('served main.js does NOT box the city (the spatialBoxes array gone)', !mainSrc.includes('spatialBoxes.push'))
  check('served tier.js carries the dist bump', tierSrc.includes('rune.esm.js?v=213'))
  check('served index.html carries the ?v=213 marks', htmlSrc.includes('main.js?v=213') && htmlSrc.includes('demo-shell.js?v=213'))

  // ── 2. both legs, end to end ────────────────────────────────────────────
  for (const leg of LEG_ARG) await runLeg(leg)
} catch (e) {
  failures++
  console.error(`[live] CRASH: ${e instanceof Error ? e.message : String(e)}`)
} finally {
  await browser.close()
}

console.log(`\n[live] ${failures === 0 ? 'VERDICT: PASS — the SoA kit is live: the trees eat the records, the drones edit in scalars, the laws ride through' : `VERDICT: FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
