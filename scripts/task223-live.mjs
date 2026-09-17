#!/usr/bin/env bun
/**
 * scripts/task223-live.mjs — the LIVE gate for Task 223 (THE DENSE FOREST)
 * on the deployed Pages site:
 *   · the source checks — the deployed demo carries the round's own laws
 *     (the quantized feed + drawMeshInstanced + the occluder proxy + the
 *     tight AABB + the counts channel in the demo sources; the quantized
 *     formats + the wrap law + runCullCompact in the deployed dist);
 *   · the deployed validation — the page's own 7-law autopilot, both
 *     backends, against the deployed bytes (the software ladder's light
 *     load, exactly the local gate's shape).
 */
import { chromium } from 'playwright'

const LIVE = 'https://atolbat.github.io/rune/demo/forest/'
let failures = 0
function check(name, ok, detail = '') {
  console.log(`[223-live] ${name}: ${ok ? 'PASS' : 'FAIL'}${detail ? ` · ${detail}` : ''}`)
  if (!ok) failures++
}

// ── the source checks (the deployed bytes) ────────────────────────────────
const index = await (await fetch(LIVE)).text()
const main = await (await fetch(LIVE + 'main.js?v=225')).text()
const shaders = await (await fetch(LIVE + 'shaders.js?v=223')).text()
const world = await (await fetch(LIVE + 'world.js?v=225')).text()
const dist = await (await fetch('https://atolbat.github.io/rune/dist/rune.esm.js?v=223')).text()
const gallery = await (await fetch('https://atolbat.github.io/rune/demo/')).text()
check('source: the deployed forest page mounts the current cache-bust (v=225)', index.includes('main.js?v=225'), '')
check('source: THE QUANTIZED FEED ships in the deployed dist (the snorm formats + the GL typed lane)',
  dist.includes('snorm16x4') && dist.includes('short') && dist.includes('Int16Array'),
  '')
check('source: drawMeshInstanced + texture + runCullCompact ship in the deployed dist',
  dist.includes('drawMeshInstanced') && dist.includes('runCullCompact') && dist.includes('copyExternalImageToTextureMip'),
  '')
check('source: THE OCCLUDER PROXY ships (the depth-only core — the demo draws it, never colors it)',
  main.includes('mesh(0, 2)') && main.includes('THE OCCLUDER PROXY') && shaders.includes('THE VERDICT COLLAPSE'),
  '')
check('source: THE TIGHT AABB ships (the yaw-exact rotated footprint)',
  world.includes('THE TIGHT AABB LAW'), '')
check('source: THE COUNTS CHANNEL ships (the compact + args — never the scene mid-loop)',
  main.includes('runCullCompact') && main.includes('211-class poison'), '')
check('source: the deployed asset is the packed twin (tree.bin.gz)',
  (await fetch(LIVE + 'assets/tree.bin.gz')).headers.get('content-length') !== null,
  `${((await fetch(LIVE + 'assets/tree.bin.gz')).headers.get('content-length') ?? 0) / 1e6} MB`)
check('source: the gallery card tells the forest (the 223–225 marker rides the card)',
  gallery.includes('forest') && gallery.includes('Tasks 223–225') && gallery.includes('216–225'), '')

// ── the deployed validation (both backends) ───────────────────────────────
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})
for (const [mode, trees, awaitWalk] of [['webgpu', 150, true], ['webgl2', 100, false]]) {
  const page = await browser.newPage({ viewport: { width: 480, height: 320 } })
  const errors = []
  page.on('pageerror', e => errors.push(e.message.slice(0, 150)))
  await page.goto(`${LIVE}?trees=${trees}&mode=${mode}`, { waitUntil: 'networkidle', timeout: 150_000 })
  if (awaitWalk) {
    const res = await page.waitForFunction(
      () => { const v = window.__forest?.validation; return v !== null && v.checks >= 7 },
      null, { timeout: 420_000, polling: 500 },
    ).then(() => page.evaluate(() => window.__forestGate))
      .catch(() => null)
    check(`[${mode}] THE DEPLOYED VALIDATION — the 7-law autopilot walked the deployed forest`,
      res !== null && res.pass === true && res.checks === 7,
      res === null ? 'the gate never resolved' : `${res.pass ? 'PASS' : 'FAIL'} · ${res.checks} laws`)
  } else {
    // THE CONTAINER'S GL READBACK WALL (Task 225's re-pin): the GL leg
    // proves the walk is RUNNING on the deployed bytes (the live counters
    // land mid-sweep) + the loop; the WG leg carries the full walk.
    const s = await page.waitForFunction(
      () => window.__forest?.drawn > 0 && window.__forest.frame > 20,
      null, { timeout: 420_000, polling: 500 },
    ).then(() => page.evaluate(() => ({ f: window.__forest.frame, d: window.__forest.drawn, t: window.__forest.total })))
      .catch(() => null)
    check(`[${mode}] THE DEPLOYED WALK is running (the live counters land mid-sweep — the GL readback wall; the full walk is the WG leg's proof)`,
      s !== null && s.d > 0 && s.d < s.t && s.f > 20,
      s === null ? 'the drawn counter never landed' : `frame ${s.f} · drawn ${s.d}/${s.t}`)
  }
  check(`[${mode}] zero page errors on the deployed page`, errors.length === 0, errors.slice(0, 2).join(' | '))
  await page.close()
}
await browser.close()
console.log(`[223-live] ${failures === 0 ? 'ALL PASS' : `FAILURES: ${failures}`} — the dense forest holds on the deployed artifact`)
process.exit(failures === 0 ? 0 : 1)
