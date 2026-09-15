/**
 * scripts/task216-live.mjs — the LIVE gate: the deployed Pages site carries
 * Task 216 (THE FIRST-PERSON PARKOUR WALKER — the character brick, the
 * terrain passes, the adaptive scale). Checks:
 *   (1) the served sources carry the ?v=216 cache-busts and the Task-216
 *       surface (the walker page + its world/controls/shaders; the tier's
 *       terrain passes + setRenderScale + drawMesh; the dist bundle's
 *       character / scale-governor / terrain bricks; the gallery card);
 *   (2) the walker page, both backends: THE BOOT (the loop runs, the crowd
 *       honestly culled behind the hills, the terrain passes LIVE in a
 *       moving frame, the seed carries phase 1), THE VALIDATION — the
 *       page's own deterministic autopilot walks the whole course (the
 *       settle, the hop chain, the 10-step staircase, the elevator carry,
 *       the feet ≡ oracle law, the culling, the upload, the A6 shape swap,
 *       the scale ladder, the pixels, zero errors) — every law asserted
 *       from the page's own promise, THE SCALE HOOK (the WG snapshot leg's
 *       honest null; the GL live leg's re-derived backing store), the loop
 *       alive after the gate's probes, zero errors across the visit.
 */
import { chromium } from 'playwright'

const WALKER = 'https://atolbat.github.io/rune/demo/walker/'
const GALLERY = 'https://atolbat.github.io/rune/demo/'
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

async function walkerLeg(mode) {
  console.log(`[live] walker leg ${mode}: goto…`)
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 160)}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`) })
  await page.goto(`${WALKER}?crowd=1500${mode === 'webgl2' ? '&mode=webgl2' : ''}`, { waitUntil: 'networkidle', timeout: 90_000 })

  // (a) THE BOOT + THE MOVING FRAME: the graph carries the terrain passes
  //     (read at a WALKING frame — the settle frames are still-camera A6
  //     frames, a different honest shape)
  await page.waitForFunction(() => window.__walker && window.__walker.frame > 100 && window.__walker.drawn > 0, null, { timeout: 420_000 })
  const boot = await page.evaluate(() => ({
    stats: window.__walker,
    graph: window.__walkerTier !== undefined ? window.__walkerTier.graphStats() : null,
  }))
  check(`[${mode}] the boot — the loop runs, the crowd culled`,
    boot.stats.drawn > 30 && boot.stats.drawn < boot.stats.total,
    `drawn=${boot.stats.drawn}/${boot.stats.total} · ${boot.stats.backend} ${boot.stats.kind}`)
  const live = boot.graph !== null ? boot.graph.live : []
  check(`[${mode}] the terrain passes live in the moving frame`,
    live.includes('terrain-color') && live.includes('terrain-z-2') && live.includes('feedback-fill'),
    `live: ${live.join(',')}`)
  check(`[${mode}] the seed carries phase 1 (the boot warm-up left the frame)`,
    !live.includes('z-fill'), `live: ${live.join(',')}`)

  // (b) THE VALIDATION: the autopilot's own promise (the full law list) —
  //     the course rides the live loop at a fixed 1/60, so the wall time
  //     is frame-rate bound (SwiftShader's own cadence) — a patient wait
  const statsV = await page.waitForFunction(
    () => (window.__walker && window.__walker.validation !== null ? window.__walker : undefined),
    null,
    { timeout: 420_000 },
  ).then(h => h.jsonValue()).catch(() => null)
  check(`[${mode}] the autopilot walked the course — the validation verdict`,
    statsV?.validation?.pass === true, statsV !== null
      ? `${statsV.validation.pass ? 'PASS' : 'FAIL'} · ${statsV.validation.checks} laws · drawn ${statsV.drawn}/${statsV.total}`
      : 'the promise never landed (timeout)')
  if (statsV !== null) {
    const verdict = await page.evaluate(() => window.__walkerGate) // resolved by now
    if (verdict !== null && verdict !== undefined && Array.isArray(verdict.checks)) {
      for (const c of verdict.checks) check(`[${mode}] law: ${c.name}`, c.pass, c.detail)
    } else {
      check(`[${mode}] the gate promise resolved with the law list`, false, `verdict ${JSON.stringify(verdict).slice(0, 80)}`)
    }
  }

  // (c) THE SCALE HOOK: the WG snapshot leg answers null (the fixed
  //     surface); the GL live leg re-derives the canvas backing store
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
  check(`[${mode}] zero errors across the whole visit`, errors.length === 0, errors.slice(0, 3).join(' | '))
  await page.close()
}

try {
  // ── 1. the served sources carry the Task-216 surface ────────────────────
  const htmlSrc = await (await fetch(WALKER)).text()
  const mainSrc = await (await fetch(`${WALKER}main.js?v=216`)).text()
  const worldSrc = await (await fetch(`${WALKER}world.js?v=216`)).text()
  const tierSrc = await (await fetch('https://atolbat.github.io/rune/demo/occlusion/tier.js?v=216')).text()
  const bundleSrc = await (await fetch('https://atolbat.github.io/rune/dist/rune.esm.js?v=216')).text()
  const gallerySrc = await (await fetch(GALLERY)).text()
  check('served walker index.html carries the ?v=216 marks',
    htmlSrc.includes('main.js?v=216') && htmlSrc.includes('demo-shell.js?v=216') && htmlSrc.includes('demo-shell.css?v=216'))
  check('served walker main.js — the character + the governor + the gate + the tier import',
    mainSrc.includes('createCharacter') && mainSrc.includes('createScaleGovernor') && mainSrc.includes('__walkerGate') && mainSrc.includes('tier.js?v=216'))
  check('served walker world.js — the terrain grid + the oracle + the dist import',
    worldSrc.includes('terrainGrid') && worldSrc.includes('gridHeightSampler') && worldSrc.includes('rune.esm.js?v=216'))
  check('served occlusion tier.js — the terrain passes + the scale hook + the mesh brick',
    tierSrc.includes("name: 'terrain-z-2'") && tierSrc.includes("name: 'terrain-color'") && tierSrc.includes('setRenderScale') && tierSrc.includes('drawMesh') && tierSrc.includes('rune.esm.js?v=216'))
  check('served dist bundle — the Task-216 bricks (character / governor / terrain)',
    bundleSrc.includes('createCharacter') && bundleSrc.includes('createScaleGovernor') && bundleSrc.includes('terrainGrid') && bundleSrc.includes('gridHeightSampler'))
  check('the gallery carries the walker card', gallerySrc.includes('./walker/'))

  // ── 2. the walker legs, end to end ──────────────────────────────────────
  for (const leg of LEG_ARG) await walkerLeg(leg)
} catch (e) {
  failures++
  console.error(`[live] CRASH: ${e instanceof Error ? e.message : String(e)}`)
} finally {
  await browser.close()
}

const verdictText = failures === 0
  ? 'VERDICT: PASS — the first-person parkour walker is live (the terrain passes, the character brick, the carry, the adaptive scale — mobile-first, both backends)'
  : `VERDICT: FAIL (${failures})`
console.log(`\n[live] ${verdictText}`)
process.exit(failures === 0 ? 0 : 1)
