/**
 * scripts/task217-live.mjs — the LIVE gate: the deployed Pages site carries
 * Task 217 (THE FIELD REPORT ROUND — the fullscreen game stage, the visible
 * joystick, the daytime sky, the mount ladder + the ledge save + the
 * footprint oracle). Checks:
 *   (1) the served sources carry the ?v=217 cache-busts and the Task-217
 *       surface (the walker page's fullscreen mount + the sky + the
 *       joystick visuals; the occlusion tier's caller-owned clear + the
 *       fog plumb; the dist bundle's airStepUp; the gallery's 216–217 card);
 *   (2) THE VALIDATION LEGS (both backends): the page's own deterministic
 *       autopilot walks the course — 14 laws now (the Task-216 twelve +
 *       the diagonal-stairs law + the edge-forgiveness law) — plus the
 *       boot, the terrain passes, the scale hook, the loop, zero errors;
 *   (3) THE MOBILE LEGS (both backends, ?bare, portrait 390×780 @3x,
 *       emulated touch): the fullscreen canvas cover, the sky's and the
 *       terrain's decoded brightness (the old sky read ~15/255), the
 *       joystick trio (the visuals + the walk + the stop), the look drag,
 *       the JUMP button, zero errors. The frame-count discipline: the
 *       touch laws WAIT for their predicates — SwiftShader's wall time
 *       is not the sim's time.
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

/** Dispatches a synthetic touch PointerEvent on an element. */
async function touch(page, type, x, y, el = '#hiz-canvas') {
  await page.evaluate(([t, px, py, sel]) => {
    const el = document.querySelector(sel)
    el.dispatchEvent(new PointerEvent(t, {
      pointerId: 7, pointerType: 'touch', isPrimary: true,
      clientX: px, clientY: py, bubbles: true, cancelable: true,
    }))
  }, [type, x, y, el])
}

/** Decodes a screenshot's brightness IN-PAGE (img → 2d canvas → stats). */
async function brightness(page, shot) {
  return await page.evaluate(async b64 => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const w = img.width, h = img.height
    const stat = (x0, y0, x1, y1) => {
      const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data
      let sum = 0, dark = 0, n = 0
      for (let k = 0; k < d.length; k += 16) {
        const v = (d[k] + d[k + 1] + d[k + 2]) / 3
        sum += v; if (v < 32) dark++; n++
      }
      return { mean: sum / n, dark: dark / n }
    }
    return { top: stat(0, 0, w, Math.floor(h * 0.3)), bottom: stat(0, Math.floor(h * 0.5), w, h) }
  }, shot.toString('base64'))
}

async function validationLeg(mode) {
  console.log(`[live] walker validation leg ${mode}: goto…`)
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 160)}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`) })
  await page.goto(`${WALKER}?crowd=1500${mode === 'webgl2' ? '&mode=webgl2' : ''}`, { waitUntil: 'networkidle', timeout: 90_000 })
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
    live.includes('terrain-color') && live.includes('terrain-z-2'),
    `live: ${live.join(',')}`)

  const statsV = await page.waitForFunction(
    () => (window.__walker && window.__walker.validation !== null ? window.__walker : undefined),
    null, { timeout: 420_000 },
  ).then(h => h.jsonValue()).catch(() => null)
  check(`[${mode}] the autopilot walked the course — the validation verdict (14 laws)`,
    statsV?.validation?.pass === true, statsV !== null
      ? `${statsV.validation.pass ? 'PASS' : 'FAIL'} · ${statsV.validation.checks} laws`
      : 'timeout')
  if (statsV !== null) {
    const verdict = await page.evaluate(() => window.__walkerGate)
    if (verdict !== null && verdict !== undefined && Array.isArray(verdict.checks)) {
      for (const c of verdict.checks) check(`[${mode}] law: ${c.name}`, c.pass, c.detail)
    } else {
      check(`[${mode}] the gate promise resolved with the law list`, false, '')
    }
  }

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
    await page.evaluate(() => window.__walkerTier.setRenderScale(1))
  }
  const frameA = await page.evaluate(() => window.__walker.frame)
  await page.waitForTimeout(1200)
  const frameB = await page.evaluate(() => window.__walker.frame)
  check(`[${mode}] the loop alive after the gate's probes`, frameB > frameA, `${frameA}→${frameB}`)
  check(`[${mode}] zero errors across the whole visit`, errors.length === 0, errors.slice(0, 3).join(' | '))
  await page.close()
}

async function mobileLeg(mode) {
  console.log(`[live] walker mobile leg ${mode}: goto…`)
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 780 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 3,
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 160)}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`) })
  await page.goto(`${WALKER}?crowd=512&bare${mode === 'webgl2' ? '&mode=webgl2' : ''}`, { waitUntil: 'networkidle', timeout: 90_000 })
  await page.waitForFunction(() => window.__walker && window.__walker.frame > 80 && window.__walker.drawn > 0, null, { timeout: 420_000 })

  // (a) THE FULLSCREEN LAW
  const fs = await page.evaluate(() => {
    const c = document.getElementById('hiz-canvas')
    const r = c.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight, bodyFs: document.body.classList.contains('rd-fs') }
  })
  check(`[${mode}:mobile] the fullscreen law — the canvas covers the viewport`,
    fs.bodyFs && fs.w >= fs.vw * 0.97 && fs.h >= fs.vh * 0.97 && Math.abs(fs.x) < 8 && Math.abs(fs.y) < 8,
    `canvas ${Math.round(fs.w)}x${Math.round(fs.h)} of ${fs.vw}x${fs.vh} · rd-fs ${fs.bodyFs}`)

  // (b) THE SKY + TERRAIN LAWS (the screenshot decodes in-page)
  await page.waitForTimeout(400)
  const shot = await page.screenshot()
  const br = await brightness(page, shot)
  check(`[${mode}:mobile] the sky law — the top quarter is a SKY, not black`,
    br.top.mean >= 40 && br.top.dark < 0.25, `mean ${br.top.mean.toFixed(1)}/255 · dark ${(br.top.dark * 100).toFixed(0)}% (the old sky: ~15)`)
  check(`[${mode}:mobile] the terrain law — the bottom half visibly lit`,
    br.bottom.mean >= 40 && br.bottom.dark < 0.5, `mean ${br.bottom.mean.toFixed(1)}/255 · dark ${(br.bottom.dark * 100).toFixed(0)}%`)

  // (c) THE TOUCH TRIO — the joystick
  const cRect = await page.evaluate(() => {
    const r = document.getElementById('hiz-canvas').getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
  const jx = cRect.x + cRect.w * 0.25, jy = cRect.y + cRect.h * 0.72
  await touch(page, 'pointerdown', jx, jy)
  await page.waitForTimeout(150)
  const joy = await page.evaluate(() => {
    const base = document.querySelector('.walker-joy')
    return {
      exists: base !== null,
      opacity: base !== null ? parseFloat(getComputedStyle(base).opacity) : 0,
      active: window.__walker.joyActive,
      isTouch: window.__walker.isTouch,
    }
  })
  check(`[${mode}:mobile] the joystick law — the visuals appear at the anchor`,
    joy.exists && joy.opacity > 0.5 && joy.active && joy.isTouch, `opacity ${joy.opacity.toFixed(2)} · active ${joy.active}`)
  const startX = await page.evaluate(() => window.__walker.x)
  for (let k = 1; k <= 12; k++) {
    await touch(page, 'pointermove', jx + k * 8, jy)
    await page.waitForTimeout(40)
  }
  const moved = await page.waitForFunction(
    s => window.__walker.x - s > 2.0,
    startX,
    { timeout: 20_000, polling: 250 },
  ).then(() => true).catch(() => false)
  const afterMove = await page.evaluate(() => ({ x: window.__walker.x, speed: window.__walker.speed, knob: document.querySelector('.walker-joy-knob').style.transform }))
  check(`[${mode}:mobile] the joystick law — the drag walks the walker`,
    moved && afterMove.speed > 1 && afterMove.x > startX + 1.5,
    `speed ${afterMove.speed} m/s · x ${startX} → ${afterMove.x} · knob ${afterMove.knob || 'none'}`)
  await touch(page, 'pointerup', jx + 96, jy)
  const stopped = await page.waitForFunction(
    () => window.__walker.joyActive === false
      && window.__walker.speed < 1.5
      && parseFloat(getComputedStyle(document.querySelector('.walker-joy')).opacity) < 0.5,
    null, { timeout: 20_000, polling: 250 },
  ).then(() => true).catch(() => false)
  check(`[${mode}:mobile] the joystick law — the release stops the walk`, stopped, '')

  // the look drag
  const yaw0 = await page.evaluate(() => window.__walker.yaw)
  const lx = cRect.x + cRect.w * 0.75, ly = cRect.y + cRect.h * 0.4
  await touch(page, 'pointerdown', lx, ly)
  for (let k = 1; k <= 10; k++) {
    await touch(page, 'pointermove', lx + k * 12, ly)
    await page.waitForTimeout(30)
  }
  await touch(page, 'pointerup', lx + 120, ly)
  await page.waitForTimeout(200)
  const yaw1 = await page.evaluate(() => window.__walker.yaw)
  check(`[${mode}:mobile] the look law — the right-half drag turns the camera`,
    Math.abs(yaw1 - yaw0) > 0.15, `yaw ${yaw0.toFixed(2)} → ${yaw1.toFixed(2)}`)

  // the JUMP button
  const jumpShown = await page.evaluate(() => {
    const b = document.querySelector('.walker-jump')
    return b !== null && b.classList.contains('touch')
  })
  check(`[${mode}:mobile] the jump button law — revealed on touch`, jumpShown, '')
  const jbtn = await page.evaluate(() => {
    const r = document.querySelector('.walker-jump').getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  await touch(page, 'pointerdown', jbtn.x, jbtn.y, '.walker-jump')
  let leftGround = false
  for (let k = 0; k < 40; k++) {
    await page.waitForTimeout(50)
    const s = await page.evaluate(() => ({ g: window.__walker.grounded, jh: window.__walker.jumpHeld }))
    if (s.jh && !s.g) { leftGround = true; break }
  }
  await touch(page, 'pointerup', jbtn.x, jbtn.y, '.walker-jump')
  check(`[${mode}:mobile] the jump law — the button launches the body`, leftGround, '')
  check(`[${mode}:mobile] zero errors across the whole visit`, errors.length === 0, errors.slice(0, 3).join(' | '))
  await ctx.close()
}

try {
  // ── 1. the served sources carry the Task-217 surface ────────────────────
  const htmlSrc = await (await fetch(WALKER)).text()
  const mainSrc = await (await fetch(`${WALKER}main.js?v=217`)).text()
  const controlsSrc = await (await fetch(`${WALKER}controls.js?v=217`)).text()
  const tierSrc = await (await fetch('https://atolbat.github.io/rune/demo/occlusion/tier.js?v=217')).text()
  const bundleSrc = await (await fetch('https://atolbat.github.io/rune/dist/rune.esm.js?v=217')).text()
  const gallerySrc = await (await fetch(GALLERY)).text()
  check('served walker index.html — the ?v=217 marks + the fullscreen chrome',
    htmlSrc.includes('main.js?v=217') && htmlSrc.includes('demo-shell.js?v=217') && htmlSrc.includes('walker-joy') && htmlSrc.includes('walker-jump'))
  check('served walker main.js — the fullscreen mount + the sky + the new laws',
    mainSrc.includes("layout: 'fullscreen'") && mainSrc.includes('sky: [0.56, 0.66, 0.78, 1]') && mainSrc.includes('the diagonal stairs law') && mainSrc.includes('the edge law'))
  check('served walker controls.js — the visible joystick + the dead zone',
    controlsSrc.includes('walker-joy') && controlsSrc.includes('DEAD') && controlsSrc.includes('deadzone'))
  check('served occlusion tier.js — the caller-owned clear + the fog plumb',
    tierSrc.includes('deps.sky ?? SKY') && tierSrc.includes('fogNear: terrainSpec.fogNear') && tierSrc.includes('rune.esm.js?v=217'))
  check('served dist bundle — the ledge save brick (airStepUp)',
    bundleSrc.includes('airStepUp'))
  check('the gallery carries the Tasks 216–217 walker card',
    gallerySrc.includes('./walker/') && gallerySrc.includes('Task 217 — the field report round'))

  // ── 2. the validation legs ── 3. the mobile legs ───────────────────────
  for (const leg of LEG_ARG) await validationLeg(leg)
  for (const leg of LEG_ARG) await mobileLeg(leg)
} catch (e) {
  failures++
  console.error(`[live] CRASH: ${e instanceof Error ? e.message : String(e)}`)
} finally {
  await browser.close()
}

const verdictText = failures === 0
  ? 'VERDICT: PASS — the field report is answered live (the fullscreen game, the visible stick, the sky, the stairs — both backends, both viewports)'
  : `VERDICT: FAIL (${failures})`
console.log(`\n[live] ${verdictText}`)
process.exit(failures === 0 ? 0 : 1)
