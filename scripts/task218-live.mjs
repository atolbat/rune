/**
 * scripts/task218-live.mjs — the LIVE gate for Task 218 on the deployed
 * Pages site: the source checks (?v=218, the watchdog, hystFrames 24, the
 * kernel caps in dist, the gallery card) + the validation legs (the 14
 * autopilot laws + the K wiring, both backends) + THE FALLBACK LEG — the
 * live canvas-present death (?live=1) caught by the watchdog and
 * resurrected, ON THE DEPLOYED SITE.
 */
import { chromium } from 'playwright'

const LIVE = 'https://atolbat.github.io/rune/demo/walker/'
let failures = 0
function check(name, ok, detail = '') {
  console.log(`[218-live] ${name}: ${ok ? 'PASS' : 'FAIL'}${detail ? ` · ${detail}` : ''}`)
  if (!ok) failures++
}

// ── the source checks ─────────────────────────────────────────────────────
const files = {
  index: await (await fetch(LIVE)).text(),
  main: await (await fetch(LIVE + 'main.js?v=218')).text(),
  tier: await (await fetch(LIVE + '../occlusion/tier.js?v=218')).text(),
  dist: await (await fetch(LIVE + '../../dist/rune.esm.js?v=218')).text(),
  gallery: await (await fetch('https://atolbat.github.io/rune/demo/')).text(),
  readme: await (await fetch('https://atolbat.github.io/rune/demo/README.md')).text(),
}
check('source: the walker page mounts main.js?v=218', files.index.includes('main.js?v=218'))
check('source: the watchdog ships (the mirror probe + the chain)', files.main.includes('watchdogStep') && files.main.includes('canvasHasPixels'))
check('source: the flicker cure ships (hystFrames: 24)', files.main.includes('hystFrames: 24'))
check('source: the tier carries the K parameter + the live hatch', files.tier.includes('hystFrames') && files.tier.includes('forceLive'))
check('source: the kernel caps rose to 31 in dist', files.dist.includes('31u') && files.dist.includes('31.0'))
check('source: the gallery card tells Task 218', files.gallery.includes('Task 218') && files.gallery.includes('216–218'))
check('source: the README row tells Task 218', files.readme.includes('Task 218'))

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})

// ── the validation legs (both backends) ───────────────────────────────────
async function validationLeg(mode) {
  console.log(`[218-live] validation leg ${mode}: goto…`)
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 160)}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`) })
  await page.goto(`${LIVE}?crowd=1500${mode === 'webgl2' ? '&mode=webgl2' : ''}`, { waitUntil: 'networkidle', timeout: 120_000 })
  await page.waitForFunction(() => window.__walker && window.__walker.frame > 60 && window.__walker.drawn > 0, null, { timeout: 300_000 })
  const hystK = await page.evaluate(() => window.__walkerTier.hystFrames)
  check(`[${mode}] the K wiring on the deployed page`, hystK === 24, `hystFrames=${hystK}`)
  const statsV = await page.waitForFunction(
    () => (window.__walker && window.__walker.validation !== null ? window.__walker : undefined),
    null, { timeout: 420_000 },
  ).then(h => h.jsonValue()).catch(() => null)
  check(`[${mode}] the autopilot walked the deployed course`, statsV?.validation?.pass === true,
    statsV !== null ? `${statsV.validation.pass ? 'PASS' : 'FAIL'} · ${statsV.validation.checks} laws · drawn ${statsV.drawn}/${statsV.total}` : 'timeout')
  check(`[${mode}] zero page errors on the deployed page`, errors.length === 0, errors.slice(0, 2).join(' | '))
  await page.close()
}

// ── THE FALLBACK LEG on the deployed site ────────────────────────────────
async function fallbackLeg() {
  console.log('[218-live] fallback leg (the deployed present-death): goto…')
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
  await page.goto(`${LIVE}?crowd=512&mode=webgpu&live=1`, { waitUntil: 'networkidle', timeout: 120_000 })
  const landed = await page.waitForFunction(
    () => window.__walker && window.__walker.frame > 40 && window.__walker.drawn > 0
      && (window.__walker.backend === 'webgl2' || (window.__walker.backend === 'webgpu' && window.__walker.kind === 'snapshot')),
    null, { timeout: 420_000, polling: 500 },
  ).then(() => true).catch(() => false)
  const state = await page.evaluate(() => {
    const w = window.__walker, all = window.__walkerErrs ?? []
    return { backend: w.backend, kind: w.kind, frame: w.frame, drawn: w.drawn, errs: all.length, uncaught: all.filter(n => n.includes('uncaught')).length, note: (all[0] ?? '').slice(0, 120) }
  })
  check('the deployed watchdog walks the dead live-WG to a LIVING tier',
    landed && (state.backend === 'webgl2' || (state.backend === 'webgpu' && state.kind === 'snapshot')) && state.drawn > 0,
    JSON.stringify(state))
  const pixels = await page.evaluate(() => {
    const c = document.getElementById('hiz-canvas')
    const m = document.createElement('canvas'); m.width = 16; m.height = 16
    const x = m.getContext('2d'); x.drawImage(c, 0, 0, 16, 16)
    const d = x.getImageData(0, 0, 16, 16).data
    let lit = 0
    for (let k = 3; k < d.length; k += 4) if (d[k] >= 8) lit++
    return Math.round(lit / 256 * 100)
  })
  check('the deployed recovered canvas presents real pixels', pixels >= 90, `${pixels}% of the mirror lit`)
  check('the deployed fallback left no uncaught debris', state.uncaught === 0, `uncaught=${state.uncaught} · ${state.note}`)
  await page.close()
}

await validationLeg('webgpu')
await validationLeg('webgl2')
await fallbackLeg()
await browser.close()
console.log('')
if (failures === 0) {
  console.log('[218-live] ALL PASS — the deployed site self-heals the WG death and carries the flicker cure')
  process.exit(0)
}
console.log(`[218-live] ${failures} FAILURES`)
process.exit(1)
