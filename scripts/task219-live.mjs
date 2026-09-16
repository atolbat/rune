/**
 * scripts/task219-live.mjs — the LIVE gate for Task 219 (THE ROOT-CURE
 * ROUND) on the deployed Pages site:
 *   · the source checks — ?v=219, the single-pass present (blitToCanvas +
 *     the canvas-pass law in dist), the surface ladder + the
 *     pyramid-equality wiring, the honest K=4, the tightened watchdog +
 *     the snapshot predicate, the GL software probe, the gallery card;
 *   · the wiring legs (both backends) — the pyramid EQUALS the surface,
 *     the ladder caps, the orientation law (the blit's Y-map), the
 *     validation's 14 autopilot laws;
 *   · THE FALLBACK LEG on production — the container's present death
 *     caught at frame 30 (the tightened cadence) with the snapshot
 *     predicate never false-positiving.
 */
import { chromium } from 'playwright'

const LIVE = 'https://atolbat.github.io/rune/demo/walker/'
let failures = 0
function check(name, ok, detail = '') {
  console.log(`[219-live] ${name}: ${ok ? 'PASS' : 'FAIL'}${detail ? ` · ${detail}` : ''}`)
  if (!ok) failures++
}

// ── the source checks ─────────────────────────────────────────────────────
const files = {
  index: await (await fetch(LIVE)).text(),
  main: await (await fetch(LIVE + 'main.js?v=219')).text(),
  tier: await (await fetch(LIVE + '../occlusion/tier.js?v=219')).text(),
  shaders: await (await fetch(LIVE + '../occlusion/shaders.js?v=219')).text(),
  dist: await (await fetch(LIVE + '../../dist/rune.esm.js?v=219')).text(),
  gallery: await (await fetch('https://atolbat.github.io/rune/demo/')).text(),
  readme: await (await fetch('https://atolbat.github.io/rune/demo/README.md')).text(),
}
check('source: the walker page mounts the current cache-bust (v=220 — Task 220's marks)', files.index.includes('main.js?v=220'))
check('source: THE SINGLE-PASS PRESENT ships (the tier blits through the present pass)', files.tier.includes('blitToCanvas') && files.tier.includes('THE SINGLE-PASS PRESENT'))
check('source: the pyramid-equality law ships (the pyramid at the surface dims)', files.tier.includes('device.pyramid(SURF_W, SURF_H)') && files.tier.includes('THE PYRAMID EQUALS THE SURFACE'))
check('source: the surface ladder ships (the caps)', files.tier.includes('CAP_SOFTWARE') && files.tier.includes('CAP_LIVE') && files.tier.includes("follow === 'canvas'"))
check('source: the honest damper ships (hystFrames: 4)', files.main.includes('hystFrames: 4'))
check('source: the tightened watchdog + the snapshot predicate ship', files.main.includes('wdNextFrame = 30') && files.main.includes('snapshotHealth'))
// Task 220 — the two-stage verdict superseded the one-sample swap: a
// blank probe is a suspect (+6 frames to confirm), never the verdict
check('source: the two-stage verdict + the overlay swap ship (Task 220)', files.main.includes('wdSuspectFrame') && files.main.includes('overlayTier'))
check('source: THE CANVAS-PASS LAW ships in dist (the construct cannot return)', files.dist.includes('the canvas-pass law'))
check('source: the GL software probe ships in dist (the unmasked renderer)', files.dist.includes('UNMASKED_RENDERER_WEBGL'))
check('source: the blit shaders ship (the Y-map conventions)', files.shaders.includes('0.5 - q.y * 0.5') && files.shaders.includes('a_q.y * 0.5 + 0.5'))
check('source: the gallery card tells the walker tasks (219 + 220)', files.gallery.includes('Task 219') && files.gallery.includes('Task 220') && files.gallery.includes('216–220'))
check('source: the README row tells Task 219', files.readme.includes('Task 219'))

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})

// ── the wiring + validation legs (both backends) ──────────────────────────
async function wiringLeg(mode) {
  console.log(`[219-live] wiring + validation leg ${mode}: goto…`)
  const page = await browser.newPage({ viewport: { width: 720, height: 480 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 160)}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`) })
  await page.goto(`${LIVE}?crowd=512&mode=${mode}&bare=1`, { waitUntil: 'networkidle', timeout: 120_000 })
  await page.waitForFunction(() => window.__walkerTier && window.__walker.frame > 40 && window.__walker.drawn > 0, null, { timeout: 300_000 })
  const wiring = await page.evaluate(() => {
    const t = window.__walkerTier
    const c = document.getElementById('hiz-canvas')
    return {
      kind: t.kind, surfW: t.surface.width, surfH: t.surface.height, hizW: t.hizDims.w, hizH: t.hizDims.h,
      antialias: t.device.antialias, software: t.device.software, k: t.hystFrames,
      health: t.snapshotHealth(),
    }
  })
  check(`[${mode}] THE OCCLUSION-RESOLUTION LAW on production — the pyramid EQUALS the surface`,
    wiring.hizW === wiring.surfW && wiring.hizH === wiring.surfH, `surface ${wiring.surfW}×${wiring.surfH} · pyramid ${wiring.hizW}×${wiring.hizH}`)
  check(`[${mode}] the honest damper on production`, wiring.k === 4, `K=${wiring.k}`)
  if (mode === 'webgpu') {
    check(`[${mode}] the WG canvas MSAA is retired on production`, wiring.antialias === false, `antialias=${wiring.antialias}`)
  } else {
    check(`[${mode}] the GL software probe reads the truth on production`, wiring.software === true, `software=${wiring.software}`)
  }
  if (wiring.kind === 'snapshot') {
    check(`[${mode}] the snapshot predicate channel is live (blits landed)`, wiring.health.landed > 0, `landed=${wiring.health.landed}`)
  }
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
  check(`[${mode}] the orientation law on production (the blit's Y-map — the sky at the top)`,
    orient.top > orient.bot && orient.top > 100, `top ${orient.top}/255 vs bottom ${orient.bot}/255`)
  check(`[${mode}] zero page errors on the deployed page`, errors.length === 0, errors.slice(0, 2).join(' | '))
  await page.close()
}

async function validationLeg(mode) {
  console.log(`[219-live] validation leg ${mode}: goto…`)
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 160)}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`) })
  await page.goto(`${LIVE}?crowd=1500${mode === 'webgl2' ? '&mode=webgl2' : ''}`, { waitUntil: 'networkidle', timeout: 120_000 })
  const statsV = await page.waitForFunction(
    () => (window.__walker && window.__walker.validation !== null ? window.__walker : undefined),
    null, { timeout: 420_000 },
  ).then(h => h.jsonValue()).catch(() => null)
  check(`[${mode}] the autopilot walked the deployed course (14 laws)`, statsV?.validation?.pass === true,
    statsV !== null ? `${statsV.validation.pass ? 'PASS' : 'FAIL'} · ${statsV.validation.checks} laws · drawn ${statsV.drawn}/${statsV.total}` : 'timeout')
  check(`[${mode}] zero page errors on the deployed course`, errors.length === 0, errors.slice(0, 2).join(' | '))
  await page.close()
}

// ── THE FALLBACK LEG on production (the tightened cadence + the predicate) ─
async function fallbackLeg() {
  console.log('[219-live] fallback leg (the deployed present-death, the 30-frame cadence): goto…')
  const page = await browser.newPage({ viewport: { width: 720, height: 480 } })
  await page.goto(`${LIVE}?crowd=512&mode=webgpu&live=1&bare=1`, { waitUntil: 'networkidle', timeout: 120_000 })
  const landed = await page.waitForFunction(
    () => window.__walker && window.__walker.frame > 40 && window.__walker.drawn > 0
      && (window.__walker.backend === 'webgl2' || (window.__walker.backend === 'webgpu' && window.__walker.kind === 'snapshot')),
    null, { timeout: 420_000, polling: 500 },
  ).then(() => true).catch(() => false)
  const state = await page.evaluate(() => {
    const w = window.__walker
    const all = window.__walkerErrs ?? []
    return { backend: w.backend, kind: w.kind, frame: w.frame, drawn: w.drawn, notes: all.slice(0, 3), blits: window.__walkerTier.snapshotHealth?.().landed ?? -1 }
  })
  check('[fallback] the watchdog walks the dead live-WG to a LIVING tier at the TIGHTENED cadence',
    landed && (state.backend === 'webgl2' || (state.backend === 'webgpu' && state.kind === 'snapshot')) && state.drawn > 0,
    JSON.stringify(state))
  check('[fallback] the catch is the staged cadence (the Task-220 two-stage verdict or the device-lost accelerator)',
    state.notes.some(n => n.includes('suspect frame')) || state.notes.some(n => /device lost/i.test(n)), state.notes.join(' | '))
  const pixels = await page.evaluate(() => {
    const c = document.getElementById('hiz-canvas')
    const m = document.createElement('canvas'); m.width = 16; m.height = 16
    const x = m.getContext('2d'); x.drawImage(c, 0, 0, 16, 16)
    const d = x.getImageData(0, 0, 16, 16).data
    let lit = 0
    for (let k = 3; k < d.length; k += 4) if (d[k] >= 8) lit++
    return { litPct: Math.round(lit / 256 * 100) }
  })
  check('[fallback] the recovered canvas presents real pixels', pixels.litPct >= 90, `${pixels.litPct}% of the mirror lit`)
  await page.close()
}

await wiringLeg('webgpu')
await wiringLeg('webgl2')
await validationLeg('webgpu')
await validationLeg('webgl2')
await fallbackLeg()

await browser.close()
console.log(`[219-live] ${failures === 0 ? 'ALL PASS' : `FAILURES: ${failures}`} — the root-cure round holds on the deployed site`)
process.exit(failures === 0 ? 0 : 1)
