/**
 * scripts/task215-live.mjs — the LIVE gate: the deployed Pages site carries
 * Task 215 (THE DEPTH-REUSE HARVEST — research A6 — + THE SCENE-MIRROR
 * DEMO). Checks:
 *   (1) the served sources carry the ?v=215 cache-busts and the Task-215
 *       surface (the occlusion tier's depth-harvest pass + the reuseParity
 *       channel; the new demo's page + worker + the dist scene bundle);
 *   (2) LEG 1 — the occlusion page, both backends: the boot validation
 *       PASSES (it now carries the depth-reuse still-camera law itself),
 *       THE PARITY GATE live (both spellings at a fixed camera: WG — every
 *       storage word; GL — the drawn/occluded/pixel laws + the honest
 *       frame shapes), the moving frame keeps the classic shape, the loop
 *       alive after the gate, zero errors;
 *   (3) LEG 2 — the scene-mirror page: Pages serves no COOP/COEP — the
 *       honest T0 lane boots (the same pipeline on the main thread), the
 *       boot validation PASSES (the aliasing law, the exact dirt, the
 *       pool ≡ snapshot, the watermark discipline, the upload math), the
 *       dirty-range counters live, the culls honest, zero errors.
 */
import { chromium } from 'playwright'

const BASE = 'https://atolbat.github.io/rune/demo/occlusion/'
const MIRROR = 'https://atolbat.github.io/rune/demo/scene-mirror/'
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

async function runOcclusionLeg(mode) {
  console.log(`[live] occlusion leg ${mode}: goto…`)
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 160)}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`) })
  await page.goto(`${BASE}${mode === 'webgl2' ? '?mode=webgl2' : ''}`, { waitUntil: 'networkidle', timeout: 60_000 })
  const stats = await page.waitForFunction(
    () => (window.__hizStats && window.__hizStats.validation !== null && window.__hizStats.drawn > 0 ? window.__hizStats : undefined),
    null,
    { timeout: 420_000 },
  ).then(h => h.jsonValue())
  check(`[${mode}] the boot validation PASS (the static path + the page's own SPD + depth-reuse gates)`,
    stats?.validation?.pass === true, `drawn ${stats?.drawn}/${stats?.total} · mode ${stats?.mode}`)

  // warm the pyramid (the fixed-point carry converges in one; two to be sure)
  await page.waitForTimeout(900)

  // THE GATE — pause, both spellings at a fixed camera, compared
  const parity = await page.evaluate(async () => {
    window.__hizCtl.pause()
    try {
      const eye = [0, 8, 40]
      const f = 1 / Math.tan(Math.PI / 6)
      const nf = 1 / (0.5 - 300)
      const proj = new Float32Array([f / (16 / 9), 0, 0, 0, 0, f, 0, 0, 0, 0, 300 * nf, -1, 0, 0, 300 * 0.5 * nf, 0])
      let fx = -eye[0], fy = -eye[1], fz = -eye[2]
      let l = Math.hypot(fx, fy, fz); fx /= l; fy /= l; fz /= l
      const rx = fy * 0 - fz * 1, ry = 0, rz = fx * 1 - fy * 0
      const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx
      const view = new Float32Array([
        rx, ux, -fx, 0, ry, uy, -fy, 0, rz, uz, -fz, 0,
        -(rx * eye[0] + ry * eye[1] + rz * eye[2]),
        -(ux * eye[0] + uy * eye[1] + uz * eye[2]),
        fx * eye[0] + fy * eye[1] + fz * eye[2], 1,
      ])
      const mvp = new Float32Array(16)
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        let s = 0
        for (let k = 0; k < 4; k++) s += proj[k * 4 + r] * view[c * 4 + k]
        mvp[c * 4 + r] = s
      }
      return await window.__hizTier.reuseParity(mvp, eye)
    } finally {
      window.__hizCtl.resume()
    }
  })
  if (parity === null) {
    check(`[${mode}] THE DEPTH-REUSE PARITY`, false, 'null parity (the harvest bricks missing?)')
  } else if (parity.error !== undefined) {
    check(`[${mode}] THE DEPTH-REUSE PARITY`, false, `crashed: ${parity.error}`)
  } else {
    check(`[${mode}] THE DEPTH-REUSE PARITY (the still-camera fixed-point law)`,
      parity.pass === true,
      parity.words !== null
        ? `${parity.diffs} diffs of ${parity.words} words · drawn ${parity.drawnOff} vs ${parity.drawnOn} · pixels ${parity.hashEqual ? 'identical' : 'DIFFER'}`
        : `drawn ${parity.drawnOff} vs ${parity.drawnOn} · occluded ${parity.occludedOff} vs ${parity.occludedOn} · pixels ${parity.hashEqual ? 'identical' : 'DIFFER'}`)
    check(`[${mode}] the frame shapes: the honest swap`,
      parity.harvestLive === true && parity.fillClassic === true,
      `on: ${parity.graphOn.join(',')} · off: ${parity.graphOff.join(',')}`)
  }

  // the loop continues cleanly after the gate's readbacks
  await page.evaluate(() => { window.__hizCam.auto = 1 })
  const before = await page.evaluate(() => window.__hizStats.drawn)
  await page.waitForFunction(before => window.__hizStats.drawn !== before, before, { timeout: 90_000 })
    .then(() => check(`[${mode}] the loop alive after the gate`, true))
    .catch(() => check(`[${mode}] the loop alive after the gate`, false))
  check(`[${mode}] zero errors across the whole visit`, errors.length === 0, errors.slice(0, 3).join(' | '))
  await page.close()
  return errors.length === 0
}

async function runMirrorLeg() {
  console.log('[live] scene-mirror leg: goto…')
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 160)}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`) })
  await page.goto(MIRROR, { waitUntil: 'networkidle', timeout: 60_000 })
  const stats = await page.waitForFunction(
    () => (window.__mirrorStats && window.__mirrorStats.validation !== null ? window.__mirrorStats : undefined),
    null,
    { timeout: 120_000 },
  ).then(h => h.jsonValue())
  check(`[mirror] the lane (Pages serves no COOP/COEP — the honest T0)`, stats?.lane === 't0', `lane ${stats?.lane}`)
  check(`[mirror] the boot validation PASS`, stats?.validation?.pass === true,
    `${stats?.validation?.checks?.filter(c => c.ok).length ?? '?'}/${stats?.validation?.checks?.length ?? '?'} checks`)
  await page.waitForTimeout(1200)
  const s = await page.evaluate(() => ({ ...window.__mirrorStats, publish: { ...window.__mirrorStats.publish }, visible: [...window.__mirrorStats.visible] }))
  check(`[mirror] the publish dirt is live`, s.publish.bytes > 0 && s.publish.ranges > 0,
    `${s.publish.bytes} B · ${s.publish.ranges} ranges (of ${Math.round(s.publish.full / 1024)} KB full)`)
  check(`[mirror] the visible counts honest`, s.visible[0] > 100 && s.visible[0] < s.nodes && s.visible[1] > 100 && s.visible[1] < s.nodes,
    `A ${s.visible[0]} / B ${s.visible[1]} of ${s.nodes}`)
  check(`[mirror] zero errors`, errors.length === 0, errors.slice(0, 3).join(' | '))
  await page.close()
  return errors.length === 0
}

try {
  // ── 1. the served sources carry the Task-215 surface ────────────────────
  const mainSrc = await (await fetch(`${BASE}main.js`)).text()
  const tierSrc = await (await fetch(`${BASE}tier.js`)).text()
  const htmlSrc = await (await fetch(BASE)).text()
  const mirrorHtml = await (await fetch(MIRROR)).text()
  const mirrorMain = await (await fetch(`${MIRROR}main.js`)).text()
  const mirrorWorker = await (await fetch(`${MIRROR}worker.js`)).text()
  const sceneBundle = await (await fetch('https://atolbat.github.io/rune/dist/rune-scene.esm.js?v=215')).text()
  check('served occlusion main.js carries the A6 gate + the ?v=215 marks',
    mainSrc.includes('THE DEPTH-REUSE gate') && mainSrc.includes('t.reuseParity') && mainSrc.includes('tier.js?v=215'))
  check('served occlusion tier.js carries the depth-harvest pass + the reuseParity channel',
    tierSrc.includes("name: 'depth-harvest'") && tierSrc.includes('reuseParity: (mvp, eye)') && tierSrc.includes('rune.esm.js?v=215'))
  check('served occlusion index.html carries the ?v=215 marks',
    htmlSrc.includes('main.js?v=215') && htmlSrc.includes('demo-shell.js?v=215'))
  check('served scene-mirror page + worker + the dist scene bundle live',
    mirrorHtml.includes('main.js?v=215') && mirrorMain.includes('createSceneStoreMirror') && mirrorWorker.includes('runSceneWorker') && sceneBundle.includes('runSceneWorker'))

  // ── 2. the occlusion legs, end to end ────────────────────────────────────
  for (const leg of LEG_ARG) await runOcclusionLeg(leg)
  // ── 3. the scene-mirror leg (the T0 lane — Pages serves no COI) ──────────
  await runMirrorLeg()
} catch (e) {
  failures++
  console.error(`[live] CRASH: ${e instanceof Error ? e.message : String(e)}`)
} finally {
  await browser.close()
}

console.log(`\n[live] ${failures === 0 ? 'VERDICT: PASS — the depth-reuse harvest is live (the presented frame\\'s own depth, bit-identical) and the scene store mirror has its first live consumer' : `VERDICT: FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
