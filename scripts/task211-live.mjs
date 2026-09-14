/**
 * scripts/task211-live.mjs — the LIVE gate: the deployed Pages site carries
 * Task 211 (THE UNIFIED DATA SURFACE: the store + the partial record
 * upload + the Scene edit mode). Checks:
 *   (1) the served sources carry the ?v=211 cache-busts and the Task-211
 *       surface (main.js's adoptStore import + the drone block; tier.js's
 *       applyEdits + readRecords channel; index.html's marks);
 *   (2) the boot validation PASSES on the live SwiftShader stack with the
 *       edits OFF — the static path is bit-for-bit the Task-210 shape (the
 *       209 order laws ride it);
 *   (3) THE EDIT MODE, LIVE, on BOTH backends (the local gate's rehearsal,
 *       now against production): the upload math (≈2.3 KB over 48 ranges
 *       vs the ~961 KB full write — the ~420× partial-upload law), the
 *       RECORD-MIRROR gate (the GPU's own copy ≡ the store's bytes, through
 *       the device's readRecords readback), THE TELEPORT PROBE (a visible
 *       record teleported behind the frustum through the store flips its
 *       verdict 1 → 2 — the cull provably reads the uploaded bytes), the
 *       pixel law (the still frame with the edits OFF, moving frames with
 *       them ON — WG hashes the rendered surface, GL screenshots the live
 *       canvas), the HUD counters, and zero page/GPU errors.
 *
 * THE PAUSE DISCIPLINE (the task-209 lesson + one layer of our own): every
 * GPU readback (records / verdicts / stats / surface) and every screenshot
 * happens under a PAUSED loop — a read racing the live submits kills the
 * SwiftShader renderer.
 */
import { chromium } from 'playwright'

const BASE = 'https://atolbat.github.io/rune/demo/occlusion/'
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})

const errors = []
let failures = 0
function check(name, ok, detail = '') {
  console.log(`[live] ${name}: ${ok ? 'PASS' : 'FAIL'}${detail ? ` · ${detail}` : ''}`)
  if (!ok) failures++
}

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
  check(`[${mode}] the boot validation PASS (the edits-OFF static path)`, stats?.validation?.pass === true,
    `drawn ${stats?.drawn}/${stats?.total} · mode ${stats?.mode}`)

  await page.evaluate(() => { window.__hizCam.auto = 0 })
  await page.waitForTimeout(3000) // the settle (the Task-208b lesson — the carry converges first)

  const paused = async (fn) => {
    await page.evaluate(() => { window.__hizCtl.pause() })
    await page.waitForTimeout(300)
    try {
      return await fn()
    } finally {
      await page.evaluate(() => { window.__hizCtl.resume() })
    }
  }
  // the per-backend pixel probe: WG (snapshot) → the rendered SURFACE (the
  // parity gates' own probe — the compositor's canvas stretch is raster-
  // nondeterministic, the surface is not); GL (live) → the CANVAS itself
  const pixelHash = () => paused(async () => {
    if (mode === 'webgpu') {
      return page.evaluate(async () => {
        const r = await window.__hizTier.surface.read()
        const d = await crypto.subtle.digest('SHA-256', new Uint8Array(r.data))
        return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('')
      })
    }
    const shot = await page.locator('#hiz-canvas').screenshot()
    const d = await crypto.subtle.digest('SHA-256', new Uint8Array(shot))
    return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('')
  })

  // (a) the still-frame law (edits OFF, frozen camera)
  const still1 = await pixelHash()
  await page.waitForTimeout(1000)
  const still2 = await pixelHash()
  check(`[${mode}] the still-frame law (frozen camera, edits OFF)`, still1 === still2)

  // (b) the drones ON — the upload math
  await page.evaluate(() => { window.__hizEdits.set(true) })
  const edit = await page.waitForFunction(
    () => (window.__hizEdits.last().bytes > 0 && window.__hizStats.uploadBytes > 0 ? window.__hizEdits.last() : undefined),
    null,
    { timeout: 60_000 },
  ).then(h => h.jsonValue())
  check(`[${mode}] the partial upload lands`, (edit?.bytes ?? 0) > 0 && (edit?.bytes ?? 0) < (edit?.full ?? 1) / 100,
    `${edit?.bytes} B over ${edit?.ranges} ranges vs full ${((edit?.full ?? 0) / 1024).toFixed(0)} KB — ${((edit?.full ?? 0) / Math.max(1, edit?.bytes ?? 1)).toFixed(0)}×`)
  check(`[${mode}] the range count ≈ the drone count`, (edit?.ranges ?? 0) >= 40 && (edit?.ranges ?? 0) <= 48, `${edit?.ranges} ranges`)

  // (c) THE RECORD-MIRROR GATE
  await page.waitForTimeout(900)
  const mirror = await paused(() => page.evaluate(async () => {
    const id = window.__hizEdits.droneId(7)
    const cpu = window.__hizEdits.record(id)
    const gpu = Array.from(await window.__hizDebug.records(id), v => +v.toFixed(4))
    return { id, cpu, gpu }
  }))
  const mirrorOk = Array.isArray(mirror.gpu) && mirror.cpu.length === mirror.gpu.length &&
    mirror.cpu.every((v, i) => Math.abs(v - mirror.gpu[i]) < 5e-4)
  check(`[${mode}] the record mirror ≡ the store (drone #${mirror.id})`, mirrorOk,
    `cpu ${mirror.cpu?.slice(0, 3).map(v => v.toFixed(2)).join(',')} · gpu ${Array.isArray(mirror.gpu) ? mirror.gpu.slice(0, 3).map(v => v.toFixed(2)).join(',') : '?'}`)

  // (d) THE TELEPORT PROBE — the cull provably reads the uploaded bytes
  const target = await paused(() => page.evaluate(async () => {
    const verdicts = Array.from(await window.__hizTier.readVerdicts())
    const droneIds = new Set(Array.from({ length: 48 }, (_, d) => window.__hizEdits.droneId(d)))
    for (let i = 23; i < verdicts.length; i++) {
      if (verdicts[i] === 1 && !droneIds.has(i)) return i
    }
    return -1
  }))
  const drawnBefore = await paused(() => page.evaluate(async () => (await window.__hizTier.readStats()).drawn))
  await page.evaluate(id => { window.__hizEdits.teleport(id, 0, 500, 0) }, target)
  await page.waitForTimeout(1500) // frames render: the upload lands, the cull reads it
  const flip = await paused(() => page.evaluate(async id => ({
    v: (await window.__hizTier.readVerdicts())[id],
    drawn: (await window.__hizTier.readStats()).drawn,
    gpu: Array.from(await window.__hizDebug.records(id), v => +v.toFixed(1)).slice(0, 3),
  }), target))
  check(`[${mode}] the teleport probe (record #${target}: the verdict flips — the cull reads the upload)`, flip.v === 2 && flip.gpu[1] === 500,
    `verdict ${flip.v} · mirror ${JSON.stringify(flip.gpu)} · drawn ${drawnBefore} → ${flip.drawn}`)

  // (e) the pixel law (edits ON → the frames move, wall-clock drones)
  await page.waitForTimeout(1100)
  const moved1 = await pixelHash()
  await page.waitForTimeout(1500)
  const moved2 = await pixelHash()
  check(`[${mode}] the pixels MOVE with the edits ON`, moved1 !== moved2)

  // (f) the HUD counters + cleanliness
  const hud = await paused(() => page.evaluate(() => ({ e: window.__hizStats.edits, b: window.__hizStats.uploadBytes, r: window.__hizStats.uploadRanges })))
  check(`[${mode}] the HUD counters carry the edit math`, hud.e === 1 && hud.b > 0 && hud.r > 0, `${hud.b} B · ${hud.r} ranges`)
  await page.waitForTimeout(1500)
  check(`[${mode}] zero errors across the whole visit`, legErrors.length === 0, legErrors.slice(0, 3).join(' | '))
  await page.close()
}

try {
  // ── 1. the served sources carry the Task-211 surface ────────────────────
  const mainSrc = await (await fetch(`${BASE}main.js`)).text()
  const tierSrc = await (await fetch(`${BASE}tier.js`)).text()
  const htmlSrc = await (await fetch(BASE)).text()
  check('served main.js carries the store adoption + the drones (?v=211)',
    mainSrc.includes('adoptStore') && mainSrc.includes('THE UNIFIED DATA SURFACE') && mainSrc.includes('tier.js?v=211'))
  check('served tier.js carries applyEdits + the records channel + the dist bump',
    tierSrc.includes('applyEdits') && tierSrc.includes('readRecords') && tierSrc.includes('rune.esm.js?v=211'))
  check('served index.html carries the ?v=211 marks', htmlSrc.includes('main.js?v=211'))

  // ── 2–6. both legs, end to end ──────────────────────────────────────────
  await runLeg('webgpu')
  await runLeg('webgl2')
} catch (e) {
  failures++
  console.error(`[live] CRASH: ${e instanceof Error ? e.message : String(e)}`)
} finally {
  await browser.close()
}

console.log(`\n[live] ${failures === 0 ? 'VERDICT: PASS — the unified data surface is live' : `VERDICT: FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
