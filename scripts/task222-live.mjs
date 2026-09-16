/**
 * scripts/task222-live.mjs — the LIVE gate for Task 222 (THE BLIND PROBE,
 * THE GAME PRESERVATION, THE TOUCH LOOK) on the deployed Pages site —
 * the round's own deployed-artifact evidence:
 *   · the source checks — the deployed walker carries THE BLIND-PROBE
 *     LAW (a lit surface + a blank mirror RETIRES with a WARN — the old
 *     takeover branch is gone), THE GAME PRESERVATION LAW (only the
 *     first boot spawns; a completed validation never re-arms), the
 *     probe's own evidence in the notes, the render-scale visibility,
 *     and THE TOUCH LOOK LAW in the deployed controls;
 *   · THE TOUCH LOOK LEG (both backends, the deployed page, emulated
 *     touch, portrait): dragging DOWN looks DOWN (pitch falls — the
 *     standard mobile convention) and dragging UP looks back UP (the
 *     axis is finger-glued in BOTH directions, not a one-way sign);
 *   · the walker's 14 autopilot laws + the fallback chain on the
 *     deployed page were just proven by the 219-live run against this
 *     same deploy — this gate does not repeat them.
 */
import { chromium } from 'playwright'

const LIVE = 'https://atolbat.github.io/rune/demo/walker/'
let failures = 0
function check(name, ok, detail = '') {
  console.log(`[222-live] ${name}: ${ok ? 'PASS' : 'FAIL'}${detail ? ` · ${detail}` : ''}`)
  if (!ok) failures++
}

// ── the source checks (the deployed bytes) ────────────────────────────────
const index = await (await fetch(LIVE)).text()
const main = await (await fetch(LIVE + 'main.js?v=223')).text()
const controls = await (await fetch(LIVE + 'controls.js?v=223')).text()
const gallery = await (await fetch('https://atolbat.github.io/rune/demo/')).text()
check('source: the walker page mounts the current cache-bust (v=223 — the Task-222 marks)',
  index.includes('main.js?v=223'), '')
check('source: THE BLIND-PROBE LAW ships — a lit surface + a blank mirror RETIRES (the takeover branch is gone)',
  main.includes('THE BLIND-PROBE LAW') && main.includes('a BLIND PROBE')
    && !main.includes('the present lane drops the frames — the WG snapshot path takes over'),
  '')
check('source: the blind-probe verdict is a WARN (a healthy phone validation must not fail over its own diagnostics)',
  /shell\.log\.warn\(`the mirror probe reads blank but the render is alive/.test(main),
  '')
check('source: THE GAME PRESERVATION LAW ships — only the first boot spawns the course',
  main.includes('THE GAME PRESERVATION LAW') && main.includes('if (bootCount === 0) {')
    && main.includes('priorValidationDone'),
  '')
check('source: the probe evidence rides the notes (the max channel + the canvas dims)',
  main.includes("the probe's own read: max channel") && main.includes('render scale → '),
  '')
check('source: THE TOUCH LOOK LAW ships — drag DOWN looks DOWN (the standard convention)',
  controls.includes('THE TOUCH LOOK LAW')
    && controls.includes('state.lookDY -= (e.clientY - lookLast.y) * lookSens * 1.6'),
  '')
check('source: the gallery card tells the walker tasks (216–222)',
  gallery.includes('Task 222') && gallery.includes('216–222'), '')

// ── THE TOUCH LOOK LEG (the deployed page, both backends) ─────────────────
async function touch(page, type, x, y) {
  await page.evaluate(([t, px, py]) => {
    const el = document.querySelector('#hiz-canvas')
    el.dispatchEvent(new PointerEvent(t, {
      pointerId: 7, pointerType: 'touch', isPrimary: true,
      clientX: px, clientY: py, bubbles: true, cancelable: true,
    }))
  }, [type, x, y])
}

async function lookLeg(mode) {
  console.log(`[222-live] touch look leg ${mode}: goto…`)
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
  })
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 780 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 3,
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 200)}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`) })
  await page.goto(`${LIVE}?crowd=512&bare${mode === 'webgl2' ? '&mode=webgl2' : ''}`, { waitUntil: 'networkidle', timeout: 120_000 })
  // the boot: frames landing, the crowd culled (frame-count discipline —
  // the deployed SwiftShader legs are slow, the law waits, never sleeps)
  await page.waitForFunction(
    () => window.__walker && window.__walker.frame > 60 && window.__walker.drawn > 0,
    null, { timeout: 240_000, polling: 250 },
  )
  const cRect = await page.evaluate(() => {
    const r = document.querySelector('#hiz-canvas').getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
  const lx = cRect.x + cRect.w * 0.75, ly = cRect.y + cRect.h * 0.4

  // (1) drag DOWN ⇒ the camera looks DOWN (pitch falls, the horizon
  //     glued to the finger — the report's own ask, both directions)
  const pitch0 = await page.evaluate(() => window.__walker.pitch)
  await touch(page, 'pointerdown', lx, ly)
  for (let k = 1; k <= 10; k++) {
    await touch(page, 'pointermove', lx, ly + k * 12)
    await page.waitForTimeout(30)
  }
  await touch(page, 'pointerup', lx, ly + 120)
  // the deltas are consumed by the FRAME loop — wait for the pitch to
  // actually land below the start (a frame-count law, not wall time)
  const fell = await page.waitForFunction(
    p0 => window.__walker.pitch < p0 - 0.1,
    pitch0,
    { timeout: 20_000, polling: 250 },
  ).then(() => true).catch(() => false)
  const pitch1 = await page.evaluate(() => window.__walker.pitch)
  check(`[${mode}] THE DEPLOYED TOUCH LOOK LAW — dragging DOWN looks DOWN`,
    fell && pitch1 < pitch0 - 0.1, `pitch ${pitch0.toFixed(2)} → ${pitch1.toFixed(2)}`)

  // (2) drag UP ⇒ the camera looks back UP (the axis is finger-glued in
  //     both directions — a one-way sign swap would pass (1) and fail here)
  await touch(page, 'pointerdown', lx, ly + 120)
  for (let k = 1; k <= 10; k++) {
    await touch(page, 'pointermove', lx, ly + 120 - k * 12)
    await page.waitForTimeout(30)
  }
  await touch(page, 'pointerup', lx, ly)
  const rose = await page.waitForFunction(
    p1 => window.__walker.pitch > p1 + 0.1,
    pitch1,
    { timeout: 20_000, polling: 250 },
  ).then(() => true).catch(() => false)
  const pitch2 = await page.evaluate(() => window.__walker.pitch)
  check(`[${mode}] the touch look axis is finger-glued both ways — dragging UP looks UP`,
    rose && pitch2 > pitch1 + 0.1, `pitch ${pitch1.toFixed(2)} → ${pitch2.toFixed(2)}`)

  check(`[${mode}] zero page errors on the deployed page`, errors.length === 0, errors.slice(0, 3).join(' | '))
  await ctx.close()
  await browser.close()
}

await lookLeg('webgpu')
await lookLeg('webgl2')
console.log(`[222-live] ${failures === 0 ? 'ALL PASS' : `FAILURES: ${failures}`} — the blind probe, the game preservation, the touch look hold on the deployed artifact`)
process.exit(failures === 0 ? 0 : 1)
